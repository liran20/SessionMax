// Reads live Claude Code sessions from ~/.claude.
//
// ~/.claude/sessions/<pid>.json is a registry each running Claude Code process keeps
// up to date: { sessionId, name, cwd, status: idle|busy|waiting, waitingFor, statusUpdatedAt, ... }.
// The transcript for each session lives at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl;
// we read only its tail to describe what the session is doing / last said.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
// Read just the end of each transcript; go further back only when the last prompt isn't there.
const TAIL_STEPS = [256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024];

const transcriptPaths = new Map(); // sessionId -> path
const summaryCache = new Map(); // path -> { key, info }
let lastProjectScan = 0;

// Sessions run through the Agent SDK (entrypoint sdk-ts, sdk-py, ...) are other apps' workers,
// e.g. Broom's renders, not chats; leave them out.
const isSdk = (entrypoint) => /^sdk/.test(entrypoint || '');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findTranscript(sessionId) {
  const cached = transcriptPaths.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  // Rescanning every project dir is cheap but not free; throttle it.
  if (Date.now() - lastProjectScan < 5000) return null;
  lastProjectScan = Date.now();
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(PROJECTS_DIR, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.jsonl')) transcriptPaths.set(f.slice(0, -6), path.join(PROJECTS_DIR, d, f));
    }
  }
  return transcriptPaths.get(sessionId) || null;
}

function readTail(file, size, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift(); // first line is probably cut in half
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function clean(text, max = 180) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

function describeTool(block) {
  const name = block.name || 'tool';
  const i = block.input || {};
  const short = (p) => (p ? path.basename(String(p)) : '');
  let what =
    i.description ||
    (i.file_path && `${name === 'Read' ? 'Reading' : 'Editing'} ${short(i.file_path)}`) ||
    (i.pattern && `Searching “${clean(i.pattern, 50)}”`) ||
    (i.url && `Fetching ${clean(i.url, 60)}`) ||
    (i.query && `Searching “${clean(i.query, 60)}”`) ||
    (i.command && clean(i.command, 90)) ||
    (i.prompt && clean(i.prompt, 90)) ||
    '';
  const label = name.startsWith('mcp__') ? name.split('__').pop() : name;
  return clean(what ? `${label}: ${what}` : label, 140);
}

// Pull a short description of the session's current/last activity from the transcript tail.
function summarize(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return {};
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return {};
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = summaryCache.get(file);
  if (hit && hit.key === key) return hit.info;

  let info;
  for (const bytes of TAIL_STEPS) {
    try {
      info = parseTail(readTail(file, stat.size, bytes));
    } catch {
      return {};
    }
    if (info.lastPrompt || bytes >= stat.size) break;
    // The file only grows, so a prompt found on an earlier read is still the latest one.
    if (hit?.info.lastPrompt) {
      info.lastPrompt = hit.info.lastPrompt;
      info.turnStartedAt = hit.info.turnStartedAt;
      break;
    }
  }
  summaryCache.set(file, { key, info });
  return info;
}

// What a session left running when its turn ended, from its transcript: sessions it started or
// handed work off to (the desktop app's local_… ids) and its background tasks (Bash with
// run_in_background, Monitor, background Agent, Workflow). The whole file is read once, then only
// what was appended.
const scanCache = new Map(); // path -> { offset, carry, ids, calls, tasks, promptAt }
const LINK_RE = /(?:Started session|Handed off) .{0,400}?\(session_id: (local_[0-9a-f-]{36})/g;
const SCAN_CHUNK = 4 * 1024 * 1024;
// Commands that run until killed (servers, watchers). The session isn't waiting for those.
const LONG_RUNNING_RE =
  /\b(http\.server|serve|server|dev|watch|preview|start|electron|vite|nodemon|ngrok|tunnel|tail -f|Wait-Event)\b/i;

function scanTranscript(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return null;
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  let c = scanCache.get(file);
  if (!c || size < c.offset)
    c = { offset: 0, carry: '', ids: new Set(), calls: new Map(), tasks: new Map(), promptAt: 0 };
  if (size > c.offset) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      while (c.offset < size) {
        const len = Math.min(SCAN_CHUNK, size - c.offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, c.offset);
        c.offset += len;
        const lines = (c.carry + buf.toString('utf8')).split('\n');
        c.carry = lines.pop(); // may be half a line; finish it on the next read
        for (const line of lines) scanLine(c, line);
      }
    } catch {
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    scanCache.set(file, c);
  }
  return c;
}

function scanLine(c, line) {
  if (line.includes('(session_id: local_')) for (const m of line.matchAll(LINK_RE)) c.ids.add(m[1]);
  // Cheap filter before parsing: only lines that can start, end or bound a background task.
  if (
    !line.includes('"tool_use"') &&
    !line.includes('"toolUseResult"') &&
    !line.includes('<task-notification>') &&
    !line.includes('"type":"user"')
  )
    return;
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return;
  }
  if (j.isSidechain) return;
  const at = Date.parse(j.timestamp) || 0;
  const content = j.message?.content;
  if (j.type === 'assistant' && Array.isArray(content)) {
    for (const b of content) {
      if (b.type !== 'tool_use') continue;
      const i = b.input || {};
      if (i.run_in_background || ['Monitor', 'Workflow', 'Agent', 'Task'].includes(b.name)) c.calls.set(b.id, b);
      // Stopping a task ends it even if no notice follows.
      if (b.name === 'TaskStop' || b.name === 'KillShell') c.tasks.delete(i.task_id || i.shell_id);
    }
  }
  if (j.type === 'user') {
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
          : '';
    if (text.trim() && !/^\s*</.test(text) && !/^\s*\[Request interrupted/.test(text)) c.promptAt = at;
    const r = j.toolUseResult;
    const useId = Array.isArray(content) && content.find((b) => b.type === 'tool_result')?.tool_use_id;
    const call = useId && c.calls.get(useId);
    if (call && r && typeof r === 'object') {
      c.calls.delete(useId);
      const id = r.backgroundTaskId || r.taskId || r.runId || (r.status === 'async_launched' && r.agentId);
      const i = call.input || {};
      if (id)
        c.tasks.set(id, {
          id,
          tool: call.name,
          description: clean(i.description || i.command || i.prompt || call.name, 80),
          command: `${i.command || ''} ${i.description || ''}`,
          startedAt: at,
          // A Monitor stops on its own at its timeout.
          expiresAt: call.name === 'Monitor' && r.timeoutMs && !r.persistent ? at + r.timeoutMs : 0,
          persistent: !!r.persistent,
          launchedInTurnOf: c.promptAt,
        });
    }
  }
  // Finished tasks announce it with a status; Monitor events without one are just progress.
  if (line.includes('<task-notification>')) {
    for (const m of line.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]{0,2000}?<status>(\w+)<\/status>/g))
      c.tasks.delete(m[1]);
  }
}

// Background tasks the session is plausibly waiting on. Agents, Workflows and Monitors always
// finish; a background Bash command counts only when it was started in the session's latest turn
// and doesn't look like a server or watcher, which would otherwise keep it "working" forever.
function pendingTasks(scan, sinceStartedAt) {
  const now = Date.now();
  const out = [];
  for (const t of scan.tasks.values()) {
    if (t.startedAt && sinceStartedAt && t.startedAt < sinceStartedAt) continue; // from a previous process
    if (t.expiresAt && t.expiresAt < now) continue;
    if (t.tool === 'Bash' || t.tool === 'PowerShell' || t.persistent) {
      if (t.launchedInTurnOf !== scan.promptAt) continue;
      if (LONG_RUNNING_RE.test(t.command)) continue;
    }
    out.push(t);
  }
  return out;
}

function parseTail(lines) {
  const info = { lastText: '', activity: '', lastPrompt: '', turnStartedAt: 0, title: '', cwd: '', entrypoint: '' };
  for (let n = lines.length - 1; n >= 0; n--) {
    const line = lines[n];
    if (!line || line[0] !== '{') continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    // The session's name is re-recorded now and then, so the tail usually has it.
    if (j.type === 'custom-title' && !info.title) info.title = j.customTitle || '';
    if (j.cwd && !info.cwd) info.cwd = j.cwd;
    if (j.entrypoint && !info.entrypoint) info.entrypoint = j.entrypoint;
    if (j.isSidechain) continue;
    const content = j.message?.content;
    const usable = (t) => !!t && !!t.trim() && !/^\s*\[Request interrupted/.test(t);
    if (j.type === 'assistant' && Array.isArray(content)) {
      for (let b = content.length - 1; b >= 0; b--) {
        const block = content[b];
        if (!info.activity) {
          if (block.type === 'tool_use') info.activity = describeTool(block);
          else if (block.type === 'thinking') info.activity = 'Thinking…';
          else if (block.type === 'text' && usable(block.text)) info.activity = clean(block.text, 140);
        }
        if (!info.lastText && block.type === 'text' && usable(block.text)) info.lastText = clean(block.text);
      }
    } else if (j.type === 'user' && !info.lastPrompt) {
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
            : '';
      // Skip tool results and injected system/command wrappers.
      if (usable(text) && !/^\s*</.test(text)) {
        info.lastPrompt = clean(text, 140);
        info.turnStartedAt = Date.parse(j.timestamp) || 0;
      }
    }
    if (info.activity && info.lastText && info.lastPrompt) break;
  }
  return info;
}

function listSessions() {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const s = readJson(path.join(SESSIONS_DIR, f));
    if (!s || !s.sessionId || s.spare || isSdk(s.entrypoint)) continue;
    if (!isAlive(s.pid)) continue;
    const t = summarize(s.sessionId);
    out.push({
      pid: s.pid,
      sessionId: s.sessionId,
      hostSessionId: s.hostSessionId || '',
      name: s.name || path.basename(s.cwd || '') || 'Untitled session',
      project: path.basename(s.cwd || ''),
      cwd: s.cwd,
      status: s.status || 'idle', // idle | busy | waiting
      waitingFor: s.waitingFor || '',
      statusUpdatedAt: s.statusUpdatedAt || s.updatedAt || s.startedAt || 0,
      startedAt: s.startedAt || 0,
      entrypoint: s.entrypoint || '',
      kind: s.kind || '', // interactive | bg | ...
      bridgeSessionId: s.bridgeSessionId || '', // set while Remote Control is on
      jobId: s.jobId || '',
      inbox: !!s.messagingSocketPath, // other processes can write into it (see inbox.js)
      lastText: t.lastText || '',
      activity: t.activity || '',
      lastPrompt: t.lastPrompt || '',
      turnStartedAt: t.turnStartedAt || 0,
    });
  }
  // A session that ended its turn to wait for sessions it started isn't done: the app wakes it
  // when they finish. Show it as working while any of them is still running.
  // Repeat so a session waiting on one that is itself waiting on others is caught too.
  const byHost = new Map(out.filter((s) => s.hostSessionId).map((s) => [s.hostSessionId, s]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of out) {
      if (s.status !== 'idle') continue;
      const running = [...(scanTranscript(s.sessionId)?.ids || [])]
        .map((id) => byHost.get(id))
        .filter((c) => c && c !== s && (c.status === 'busy' || c.status === 'waiting'));
      if (!running.length) continue;
      changed = true;
      s.status = 'busy';
      s.waitingOn = running.map((c) => c.sessionId);
      s.activity = clean(
        running.length === 1
          ? `Waiting for “${running[0].name}”`
          : `Waiting for ${running.length} sessions: ${running.map((c) => c.name).join(', ')}`,
        140
      );
    }
  }
  // Same for a session that ended its turn while a background task it started is still going:
  // it gets woken when the task finishes.
  for (const s of out) {
    if (s.status !== 'idle') continue;
    const scan = scanTranscript(s.sessionId);
    const tasks = scan ? pendingTasks(scan, s.startedAt) : [];
    if (!tasks.length) continue;
    s.status = 'busy';
    s.waitingOnTasks = tasks.map((t) => t.id);
    s.activity = clean(
      tasks.length === 1
        ? `Waiting for background task: ${tasks[0].description}`
        : `Waiting for ${tasks.length} background tasks: ${tasks.map((t) => t.description).join(', ')}`,
      140
    );
  }
  return out;
}

// Every transcript on disk, newest first: { sessionId, file, mtimeMs }. Subagent transcripts
// live in subfolders and are left out.
function recentTranscripts(limit) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(PROJECTS_DIR, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(PROJECTS_DIR, d, f);
      try {
        const sessionId = f.slice(0, -6);
        transcriptPaths.set(sessionId, file);
        out.push({ sessionId, file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// A session that may no longer be running, described from its transcript alone.
function describeSession(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return null;
  const t = summarize(sessionId);
  if (isSdk(t.entrypoint)) return null;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {}
  const cwd = t.cwd || '';
  return {
    pid: 0,
    sessionId,
    hostSessionId: '',
    name: t.title || t.lastPrompt || path.basename(cwd) || 'Untitled session',
    project: path.basename(cwd),
    cwd,
    status: 'idle',
    waitingFor: '',
    statusUpdatedAt: mtimeMs,
    startedAt: 0,
    entrypoint: '',
    kind: '',
    bridgeSessionId: '',
    jobId: '',
    lastText: t.lastText || '',
    activity: t.activity || '',
    lastPrompt: t.lastPrompt || '',
    turnStartedAt: t.turnStartedAt || 0,
  };
}

module.exports = { listSessions, describeSession, recentTranscripts, findTranscript, describeTool, clean };
