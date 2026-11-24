// Broom app's notifications, on the board. Broom app writes every note it sends the phones to
// %LOCALAPPDATA%\Broom app\pc-notes.json ({ open: { exe, args, cwd }, notes: [{ id, at, tag, title, body }] }).
// Each stack's newest note shows as a card ("Your turn") until the user opens or closes it; opening
// runs Broom app again, which shows its window (it's single-instance) or starts it when it's closed.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Broom app', 'pc-notes.json');
const PREFIX = 'broom:';

const isBroomId = (id) => typeof id === 'string' && id.startsWith(PREFIX);

let cache = { mtime: -1, data: null };
function read() {
  let m;
  try {
    m = fs.statSync(FILE).mtimeMs;
  } catch {
    return null;
  }
  if (m !== cache.mtime) {
    try {
      cache = { mtime: m, data: JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    } catch {
      // Half written: keep what we had.
    }
  }
  return cache.data;
}

// The cards to show. closed: tag -> time the user closed it; since: notes before this are old news.
function broomCards(closed, since) {
  const data = read();
  const latest = new Map();
  for (const n of (data && data.notes) || []) latest.set(n.tag, n);
  const cards = [];
  for (const n of latest.values()) {
    const at = Date.parse(n.at) || 0;
    if (at <= since || at <= (closed[n.tag] || 0)) continue;
    const id = PREFIX + n.tag;
    cards.push({ sessionId: id, hostSessionId: id, broom: true, name: `🧹 ${n.title}`, project: 'Broom', state: 'done', lastText: n.body, statusUpdatedAt: at, turnStartedAt: at });
  }
  return cards;
}

const tagOf = (id) => id.slice(PREFIX.length);

function openBroom() {
  const open = (read() || {}).open;
  if (!open || !open.exe) return;
  try {
    spawn(open.exe, open.args || [], { cwd: open.cwd, detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

module.exports = { broomCards, isBroomId, tagOf, openBroom };
