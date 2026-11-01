// SessionMax on the phone: a small web server for the phone app (a PWA in src/phone).
//
//   Phone (Chrome PWA) ─https─> Tailscale ─> `tailscale serve --https=8443` ─http─> 127.0.0.1:47830
//
// It listens on 127.0.0.1 only. Tailscale decides which devices reach the PC; pairing (a one-time
// QR code from the tray) decides which phone may read and write: it gets a long random token in a
// cookie, and only the token's sha256 is kept in state.json.
//
// The phone's chats are Claude Code sessions. A chat leaves the list when it is marked done (a
// swipe on the phone, or × in the widget) and comes back on a new message, or from the + screen.
// Replies to a session that isn't running go through `claude -p --resume <id>`. A running one
// (desktop app, CLI or background) gets the message in its inbox (inbox.js). New chats start as
// background sessions with Remote Control on, in a folder the phone picks.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const QRCode = require('qrcode');
const webpush = require('web-push');
const { describeSession, listSessions, recentTranscripts } = require('./sessions');
const { readChat, chatRev } = require('./chat');
const { canWrite, sendToInbox, RC_REQUEST } = require('./inbox');
const { iconOptions, iconFor, logoFile } = require('./icons');

const PORT = 47830;
const COOKIE = 'smx';
const PAIR_TTL = 10 * 60 * 1000;
const PHONE_DIR = path.join(__dirname, 'phone');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const RESTORE_LIMIT = 60;
// Where the user is: whichever of PC and phone was used last. The PC counts as in use for this
// long after its last sign of life (keyboard/mouse, the widget, a message typed on the PC).
const PC_AWAY = 3 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

// The newest claude.exe: SESSIONMAX_CLAUDE, the one the Claude desktop app keeps, or PATH.
function findClaude() {
  if (process.env.SESSIONMAX_CLAUDE) return process.env.SESSIONMAX_CLAUDE;
  const base = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
  let best = null;
  try {
    for (const inst of fs.readdirSync(base)) {
      const cc = path.join(base, inst, 'claude-code');
      if (!fs.existsSync(cc)) continue;
      for (const ver of fs.readdirSync(cc)) {
        for (const build of fs.readdirSync(path.join(cc, ver))) {
          const exe = path.join(cc, ver, build, 'claude.exe');
          try {
            const m = fs.statSync(exe).mtimeMs;
            if (!best || m > best.m) best = { exe, m };
          } catch {}
        }
      }
    }
  } catch {}
  return best ? best.exe : 'claude';
}

// SessionMax has its own Tailscale node, "sessionmax" (https://sessionmax.<tailnet>.ts.net), so
// its address isn't shared with Broom's: an installed phone app claims every link to its host
// name, whatever the port. It's a second tailscaled in userspace mode, signed in once
// (`up --unattended --hostname=sessionmax`); its state and `serve` config live in TS_DIR.
const TS_BIN = 'C:\\Program Files\\Tailscale';
const TS_SOCKET = '\\\\.\\pipe\\sessionmax-tailscaled';
const TS_DIR = path.join(process.env.APPDATA || os.homedir(), 'sessionmax', 'tailscale');

function tailscaleStatus() {
  return new Promise((resolve) => {
    execFile(path.join(TS_BIN, 'tailscale.exe'), [`--socket=${TS_SOCKET}`, 'status', '--json'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
  });
}

// Started with SessionMax when it isn't already running; it outlives SessionMax on purpose.
async function startTailscale() {
  if (!fs.existsSync(path.join(TS_DIR, 'tailscaled.state'))) return; // never signed in
  if (await tailscaleStatus()) return;
  const log = fs.openSync(path.join(TS_DIR, 'log.txt'), 'a');
  const child = spawn(
    path.join(TS_BIN, 'tailscaled.exe'),
    ['--windows-mode=dev', '--tun=userspace-networking', `--statedir=${TS_DIR}`, `--socket=${TS_SOCKET}`, '--port=0'],
    { detached: true, windowsHide: true, stdio: ['ignore', log, log] },
  );
  child.on('error', () => {});
  child.unref();
}

async function tailscaleName() {
  const s = await tailscaleStatus();
  if (!s || s.BackendState !== 'Running') return null;
  return (s.Self?.DNSName || '').replace(/\.$/, '') || null;
}

function createRemote({ state, saveState, iconPng }) {
  state.phone = { phones: [], vapid: null, done: {}, kept: {}, bg: {}, icons: {}, permissionMode: 'auto', ...(state.phone || {}) };
  const P = state.phone;
  if (!P.vapid) {
    P.vapid = webpush.generateVAPIDKeys();
    saveState();
  }

  const claude = findClaude();
  const pairCodes = new Map(); // code -> expires
  const replies = new Map(); // sessionId -> { child, startedAt } for replies sent from the phone
  const notes = new Map(); // sessionId -> [{ id, role: 'error', text, at }] shown in the chat
  const clients = new Set(); // open event streams
  let live = new Map(); // sessionId -> session, from the last tick
  let lastChats = [];
  let lastStates = null;
  let lastPayload = '';
  const icons = { 192: iconPng(192), 512: iconPng(512) };
  const presence = { pcAt: 0, phoneAt: 0 };
  const phoneSent = new Map(); // sessionId -> when the phone last sent it a message
  let lastPhoneNew = 0; // when the phone last started a new chat
  let lastTurns = null; // sessionId -> turnStartedAt, to spot messages typed on the PC
  const held = new Map(); // chatId -> note not pushed because the user was at the PC

  // ---------- chats ----------

  const isRunning = (s) => s.status === 'busy' || s.status === 'waiting';

  function chatState(s) {
    if (replies.has(s.sessionId)) return 'working';
    if (s.status === 'waiting') return 'needs';
    if (s.status === 'busy') return 'working';
    return s.lastPrompt ? 'ready' : 'new';
  }

  // Marked done (phone or widget) after its last message, and not brought back since.
  function isHidden(s) {
    const doneAt = Math.max(P.done[s.sessionId] || 0, state.closed?.[s.sessionId] || 0);
    if (!doneAt) return false;
    if (replies.has(s.sessionId)) return false;
    return Math.max(s.turnStartedAt || 0, P.kept[s.sessionId] || 0) <= doneAt;
  }

  function toChat(s) {
    const st = chatState(s);
    const ours = P.bg[s.sessionId];
    return {
      id: s.sessionId,
      name: s.name,
      project: s.project,
      cwd: s.cwd || '',
      icon: iconFor(s.cwd, s.project, P.icons[(s.cwd || '').toLowerCase()]),
      state: st,
      live: !!s.pid,
      kind: s.kind || '',
      desktop: s.entrypoint === 'claude-desktop',
      waitingFor: s.waitingFor || '',
      lastText: s.lastText || '',
      activity: s.activity || '',
      lastPrompt: s.lastPrompt || '',
      updatedAt: s.statusUpdatedAt || s.turnStartedAt || 0,
      turnStartedAt: s.turnStartedAt || 0,
      rev: chatRev(s.sessionId),
      rcUrl: s.bridgeSessionId ? `https://claude.ai/code/${s.bridgeSessionId}` : '',
      // A background session (ours or not) can be stopped from here; a desktop one can't.
      rcOurs: !!s.pid && (!!ours || s.kind === 'bg'),
      canSend: s.pid ? !!s.inbox : !replies.has(s.sessionId),
    };
  }

  function sessionById(id) {
    return live.get(id) || describeSession(id);
  }

  function computeChats() {
    const ids = new Set([...live.keys(), ...Object.keys(P.kept), ...replies.keys()]);
    const out = [];
    for (const id of ids) {
      const s = sessionById(id);
      if (!s || isHidden(s)) continue;
      // An empty session someone just opened isn't a chat yet.
      if (!s.lastPrompt && !replies.has(id)) continue;
      out.push(toChat(s));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---------- ticks from main.js ----------

  function update(all) {
    live = new Map(all.map((s) => [s.sessionId, s]));
    // Remote Control sessions we started that have since stopped (a new one takes a few
    // seconds to show up in the registry).
    for (const [id, b] of Object.entries(P.bg)) {
      if (!live.has(id) && Date.now() - (b.at || 0) > 30000) {
        delete P.bg[id];
        saveState();
      }
    }
    noticePcMessages(all);
    const chats = computeChats();
    notifyChanges(chats);
    lastChats = chats;
    broadcast();
  }

  // The phone app's files change when SessionMax is updated; open phones reload when this does.
  function appVersion() {
    let v = 0;
    for (const f of ['index.html', 'app.js', 'app.css']) {
      try {
        v = Math.max(v, fs.statSync(path.join(PHONE_DIR, f)).mtimeMs);
      } catch {}
    }
    return String(Math.round(v));
  }

  function payload() {
    return JSON.stringify({ chats: lastChats, permissionMode: P.permissionMode, version: appVersion() });
  }

  function broadcast(force) {
    const p = payload();
    if (!force && p === lastPayload) return;
    lastPayload = p;
    for (const res of clients) res.write(`data: ${p}\n\n`);
  }

  // ---------- presence: at the PC or on the phone ----------

  const onPc = () => presence.pcAt > presence.phoneAt && Date.now() - presence.pcAt < PC_AWAY;

  // Signs of life on the PC: input, the widget, a message typed there (from main.js and below).
  function pcActive() {
    presence.pcAt = Date.now();
  }

  // The screen locked or the PC went to sleep: whatever was held goes to the phone now.
  function pcAway() {
    presence.pcAt = 0;
    flushHeld();
  }

  function phoneActive() {
    const wasOnPc = onPc();
    presence.phoneAt = Date.now();
    if (wasOnPc) held.clear(); // they're looking at the phone app: it shows them anyway
  }

  // A new turn in a session the phone didn't just write to was typed on the PC.
  function noticePcMessages(all) {
    const now = Date.now();
    const turns = new Map(all.map((s) => [s.sessionId, s.turnStartedAt || 0]));
    if (lastTurns) {
      for (const [id, at] of turns) {
        const was = lastTurns.get(id);
        if (!at || at === was || now - at > 30000) continue;
        if (was === undefined && at - lastPhoneNew < 90000) continue; // a chat the phone started
        if (Math.abs(at - (phoneSent.get(id) || 0)) < 90000) continue; // the phone's own message
        pcActive();
      }
    }
    lastTurns = turns;
  }

  // ---------- notifications ----------

  function notifyChanges(chats) {
    const now = new Map(chats.map((c) => [c.id, c.state]));
    if (lastStates) {
      for (const c of chats) {
        const was = lastStates.get(c.id);
        if (was === c.state) continue;
        if (c.state === 'needs') {
          notify(c, { tag: c.id, chat: c.id, title: `${c.name} needs you`, body: c.waitingFor ? `Waiting for: ${c.waitingFor}` : 'Waiting for your answer' });
        } else if (c.state === 'ready' && was === 'working') {
          notify(c, { tag: c.id, chat: c.id, title: `${c.name} is ready`, body: c.lastText || 'Finished' });
        }
      }
    }
    lastStates = now;
    // A held note whose chat has moved on (answered on the PC, done) is no news any more.
    for (const [id, note] of held) if (now.get(id) !== note.state) held.delete(id);
    if (!onPc()) flushHeld();
  }

  // While the user is at the PC the widget tells them; the phone stays quiet. What's still
  // waiting when they leave the PC is sent then.
  function notify(chat, note) {
    if (onPc()) held.set(chat.id, { ...note, state: chat.state });
    else push(note);
  }

  function flushHeld() {
    for (const [id, { state: _s, ...note }] of held) {
      held.delete(id);
      push(note);
    }
  }

  function push(note) {
    for (const phone of P.phones) {
      if (!phone.push) continue;
      webpush
        .sendNotification(phone.push, JSON.stringify(note), {
          TTL: 3600,
          vapidDetails: { subject: 'mailto:sessionmax@example.com', publicKey: P.vapid.publicKey, privateKey: P.vapid.privateKey },
        })
        .catch((e) => {
          // The phone dropped this subscription (uninstalled, cleared data).
          if (e.statusCode === 404 || e.statusCode === 410) {
            phone.push = null;
            saveState();
          }
        });
    }
  }

  // ---------- actions ----------

  function addNote(id, text) {
    const list = notes.get(id) || [];
    list.push({ id: `note-${Date.now()}`, role: 'error', text, at: Date.now() });
    notes.set(id, list.slice(-5));
  }

  async function send(id, text) {
    const s = sessionById(id);
    if (!s) return { error: 'No such session' };
    phoneSent.set(id, Date.now());
    if (s.pid) {
      if (!canWrite(s.pid)) return { error: "This session can't take messages from SessionMax. Reply through Remote Control." };
      try {
        await sendToInbox(s.pid, text);
      } catch (e) {
        return { error: e.message };
      }
      P.kept[id] = Date.now();
      delete P.done[id];
      saveState();
      update([...live.values()]);
      return { ok: true };
    }
    if (replies.has(id)) return { error: 'Still answering your last message' };
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
    const child = spawn(claude, ['-p', '--resume', id, '--permission-mode', P.permissionMode], { cwd, windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', () => {});
    child.on('error', (e) => (err += e.message));
    child.on('close', (code) => {
      replies.delete(id);
      if (code) addNote(id, err.trim().split('\n').slice(-3).join('\n') || `Claude exited with code ${code}`);
      update([...live.values()]);
      broadcast(true);
    });
    child.stdin.end(text);
    replies.set(id, { child, startedAt: Date.now() });
    P.kept[id] = Date.now();
    delete P.done[id];
    saveState();
    update([...live.values()]);
    return { ok: true };
  }

  function markDone(id) {
    const s = sessionById(id);
    if (s && isRunning(s)) return { error: 'Still working: it can be done once it stops' };
    P.done[id] = Date.now();
    delete P.kept[id];
    // The widget on the PC closes it too.
    if (state.closed && s?.pid) state.closed[id] = P.done[id];
    saveState();
    update([...live.values()]);
    return { ok: true };
  }

  function restore(id) {
    P.kept[id] = Date.now();
    delete P.done[id];
    if (state.closed) delete state.closed[id];
    saveState();
    update([...live.values()]);
    return { ok: true };
  }

  // Sessions that aren't on the chat list: done ones and older ones, newest first.
  function restorable() {
    const shown = new Set(lastChats.map((c) => c.id));
    const out = [];
    for (const t of recentTranscripts(RESTORE_LIMIT * 2)) {
      if (shown.has(t.sessionId)) continue;
      const s = sessionById(t.sessionId);
      if (!s || !s.lastPrompt) continue;
      out.push({ ...toChat(s), updatedAt: s.pid ? s.statusUpdatedAt : t.mtimeMs, done: !!P.done[t.sessionId] });
      if (out.length >= RESTORE_LIMIT) break;
    }
    return out;
  }

  // The folder a session started in (the first cwd in its transcript); later lines follow any cd.
  function startCwd(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
      return m ? JSON.parse(`"${m[1]}"`) : null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  // Folders sessions ran in lately, for "New chat": the newest use of each, most recent first.
  let projectsCache = null;
  function projects() {
    if (projectsCache && Date.now() - projectsCache.at < 60000) return projectsCache.list;
    const seen = new Map();
    const add = (cwd, at) => {
      if (!cwd || seen.has(cwd.toLowerCase()) || !fs.existsSync(cwd)) return;
      if (/[\\/](\.claude|AppData)[\\/]/i.test(cwd)) return; // worktrees and scratch folders tools make
      seen.set(cwd.toLowerCase(), { name: path.basename(cwd) || cwd, cwd, at });
    };
    for (const s of [...live.values()].sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt)) add(s.cwd, s.statusUpdatedAt);
    for (const t of recentTranscripts(120)) add(startCwd(t.file), t.mtimeMs);
    const list = [...seen.values()].sort((a, b) => b.at - a.at).slice(0, 30);
    projectsCache = { at: Date.now(), list };
    return list;
  }

  // A new chat is a background session in that folder, with Remote Control on so it can also be
  // continued in the Claude app; the phone keeps writing to it through its inbox.
  // Browsing for a folder no session has used yet: folders under the user's home only.
  const HOME = os.homedir();
  const underHome = (p) => {
    const rel = path.relative(HOME, path.resolve(p));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  function folders(dir) {
    const at = dir && underHome(dir) ? path.resolve(dir) : HOME;
    let list = [];
    try {
      list = fs
        .readdirSync(at, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !/^(AppData|node_modules|\$Recycle\.Bin)$/i.test(d.name))
        .map((d) => ({ name: d.name, path: path.join(at, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {}
    return { path: at, name: path.basename(at) || at, parent: at === HOME ? null : path.dirname(at), folders: list };
  }

  async function newChat(cwd, text) {
    let proj = projects().find((p) => p.cwd.toLowerCase() === String(cwd).toLowerCase());
    if (!proj && cwd && underHome(cwd) && fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      proj = { name: path.basename(cwd), cwd: path.resolve(cwd) };
      projectsCache = null; // it's a project now
    }
    if (!proj) return { error: 'Pick a project or a folder in your user folder' };
    const name = text.replace(/\s+/g, ' ').slice(0, 50);
    lastPhoneNew = Date.now();
    const r = await runClaude(['--bg', '--name', name, '--remote-control', name, '--permission-mode', P.permissionMode, text], proj.cwd);
    const m = /backgrounded\s*·\s*([0-9a-f]+)/.exec(r.out);
    if (!m) return { error: r.out.trim().split('\n').slice(-2).join(' ') || 'Could not start the session' };
    // Its id shows up in the session registry a moment later.
    for (let i = 0; i < 40; i++) {
      const s = listSessions().find((x) => x.jobId === m[1]);
      if (s) {
        P.bg[s.sessionId] = { job: m[1], at: Date.now() };
        restore(s.sessionId);
        return { ok: true, id: s.sessionId };
      }
      await new Promise((res) => setTimeout(res, 250));
    }
    return { ok: true, id: null };
  }

  function runClaude(args, cwd) {
    return new Promise((resolve) => {
      execFile(claude, args, { cwd, windowsHide: true, timeout: 60000 }, (err, stdout, stderr) =>
        resolve({ err, out: `${stdout}\n${stderr}` }),
      );
    });
  }

  // Remote Control: a session that isn't running starts again in the background with RC on, and
  // the phone opens it in the Claude app. A session running in the desktop app gets RC there.
  async function setRemoteControl(id, on) {
    const s = sessionById(id);
    if (!s) return { error: 'No such session' };
    if (on) {
      if (s.bridgeSessionId) return { ok: true, url: `https://claude.ai/code/${s.bridgeSessionId}` };
      if (s.pid) {
        // Only the desktop app can switch it on, from inside the session: ask the session to.
        if (s.entrypoint !== 'claude-desktop' || !canWrite(s.pid)) return { error: 'desktop' };
        try {
          await sendToInbox(s.pid, RC_REQUEST);
        } catch (e) {
          return { error: e.message };
        }
        return { ok: true, asked: true };
      }
      const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
      const name = s.name.slice(0, 60);
      const r = await runClaude(['--bg', '--resume', id, '--name', name, '--remote-control', name], cwd);
      const m = /backgrounded\s*·\s*([0-9a-f]+)/.exec(r.out);
      if (!m) return { error: r.out.trim().split('\n').slice(-2).join(' ') || 'Could not start Remote Control' };
      P.bg[id] = { job: m[1], at: Date.now() };
      restore(id);
      return { ok: true, starting: true };
    }
    const job = P.bg[id]?.job || (s.kind === 'bg' && s.jobId);
    if (!job) return { error: 'Remote Control for this session is switched off in the Claude desktop app' };
    await runClaude(['stop', job], os.homedir());
    delete P.bg[id];
    saveState();
    return { ok: true };
  }

  // ---------- pairing ----------

  async function pairInfo() {
    const code = crypto.randomBytes(12).toString('base64url');
    pairCodes.set(code, Date.now() + PAIR_TTL);
    const host = await tailscaleName();
    const base = host ? `https://${host}` : `http://127.0.0.1:${PORT}`;
    const url = `${base}/pair?code=${code}`;
    return {
      url,
      host,
      qr: await QRCode.toDataURL(url, { margin: 1, width: 300 }),
      phones: P.phones.map((p) => ({ id: p.id, name: p.name, pairedAt: p.pairedAt, lastSeen: p.lastSeen, push: !!p.push })),
    };
  }

  function forgetPhone(id) {
    P.phones = P.phones.filter((p) => p.id !== id);
    saveState();
  }

  // ---------- http ----------

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function phoneOf(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const hash = sha256(token);
    const phone = P.phones.find((p) => p.tokenHash === hash);
    if (phone && Date.now() - (phone.lastSeen || 0) > 60000) {
      phone.lastSeen = Date.now();
      saveState();
    }
    return phone || null;
  }

  function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (d) => {
        b += d;
        if (b.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(b || '{}'));
        } catch {
          resolve({});
        }
      });
    });
  }

  // Only the app's own pages may post (Tailscale serve keeps the phone's Host header).
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function pair(req, res, url) {
    const code = url.searchParams.get('code') || '';
    const exp = pairCodes.get(code);
    pairCodes.delete(code);
    if (!exp || exp < Date.now()) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<meta name="viewport" content="width=device-width"><p style="font:18px system-ui;padding:24px">This pairing code has expired. Open a new one from the SessionMax tray icon: Phone…</p>');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const ua = req.headers['user-agent'] || '';
    const name = /Android/.test(ua) ? 'Android phone' : /iPhone|iPad/.test(ua) ? 'iPhone' : 'Phone';
    P.phones.push({ id: crypto.randomBytes(6).toString('hex'), name, tokenHash: sha256(token), pairedAt: Date.now(), lastSeen: Date.now(), push: null });
    saveState();
    const secure = req.headers.host?.includes('.ts.net') ? '; Secure' : '';
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${365 * 24 * 3600}; HttpOnly; SameSite=Strict${secure}`,
      Location: '/',
    });
    res.end();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(PHONE_DIR, file)).pipe(res);
    }
    if (req.method === 'GET' && (p === '/icon-192.png' || p === '/icon-512.png')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return res.end(icons[p === '/icon-192.png' ? 192 : 512]);
    }
    if (p === '/pair') return pair(req, res, url);
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

    const phone = phoneOf(req);
    if (!phone) return json(res, 401, { error: 'unpaired' });
    if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'Wrong origin' });
    // The event stream stays open in the background, so it's no sign the phone is in use;
    // the app says so itself while it's on screen.
    if (p === '/api/presence' && req.method === 'POST') {
      phoneActive();
      return json(res, 200, { ok: true });
    }
    if (p !== '/api/events') phoneActive();

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${payload()}\n\n`);
      clients.add(res);
      // A comment now and then keeps mobile networks and proxies from dropping the stream.
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (p === '/api/me') return json(res, 200, { phone: phone.name, push: !!phone.push, vapidKey: P.vapid.publicKey });
    if (p === '/api/restorable') return json(res, 200, { chats: restorable() });
    if (p === '/api/projects') return json(res, 200, { projects: projects() });
    if (p === '/api/folders') return json(res, 200, folders(url.searchParams.get('path')));
    if (p === '/api/project-file') {
      const f = logoFile(url.searchParams.get('cwd'), url.searchParams.get('f'));
      if (!f) return json(res, 404, { error: 'Not found' });
      // An svg opened on its own must not run scripts on this origin.
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'max-age=3600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      return fs.createReadStream(f.full).pipe(res);
    }
    if (p === '/api/icons') {
      const cwd = url.searchParams.get('cwd') || '';
      const name = path.basename(cwd);
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!iconOptions(cwd, name).some((o) => o.key === body.key)) return json(res, 400, { error: 'Not one of the options' });
        P.icons[cwd.toLowerCase()] = body.key;
        saveState();
        update([...live.values()]);
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { options: iconOptions(cwd, name), chosen: iconFor(cwd, name, P.icons[cwd.toLowerCase()]).key });
    }
    if (p === '/api/new' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const r = text ? await newChat(body.cwd, text) : { error: 'Write the first message' };
      return json(res, r.error ? 400 : 200, r);
    }
    if (p === '/api/push' && req.method === 'POST') {
      const body = await readBody(req);
      phone.push = body.subscription && body.subscription.endpoint ? body.subscription : null;
      saveState();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (['auto', 'acceptEdits', 'manual', 'plan'].includes(body.permissionMode)) P.permissionMode = body.permissionMode;
      saveState();
      broadcast(true);
      return json(res, 200, { ok: true });
    }

    const m = /^\/api\/chat\/([0-9a-f-]{36})(?:\/(send|done|restore|rc))?$/.exec(p);
    if (!m) return json(res, 404, { error: 'Not found' });
    const [, id, action] = m;
    if (!action && req.method === 'GET') {
      const s = sessionById(id);
      if (!s) return json(res, 404, { error: 'No such session' });
      const { messages, rev } = readChat(id);
      return json(res, 200, { chat: toChat(s), messages: [...messages, ...(notes.get(id) || [])], rev });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const body = await readBody(req);
    let r;
    if (action === 'send') {
      const text = String(body.text || '').trim();
      r = text ? await send(id, text) : { error: 'Empty message' };
    } else if (action === 'done') r = markDone(id);
    else if (action === 'restore') r = restore(id);
    else r = await setRemoteControl(id, !!body.on);
    return json(res, r.error ? 400 : 200, r);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        json(res, 500, { error: e.message });
      } catch {}
    });
  });
  server.on('error', () => {}); // port taken: the phone side just stays off
  server.listen(PORT, '127.0.0.1');
  startTailscale();

  return { update, pairInfo, forgetPhone, pcActive, pcAway, port: PORT };
}

module.exports = { createRemote, tailscaleName };
