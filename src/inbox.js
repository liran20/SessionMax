// Writing into a running Claude Code session (desktop app, CLI or background) through its inbox.
//
// Every running session listens on a local pipe (messagingSocketPath in ~/.claude/sessions/<pid>.json)
// so sessions can message each other. A sender proves itself with the peerToken the session
// publishes next to its registry file (<pid>.<hash>.key), then sends one JSON line per message.
// The session runs a turn on it like a message from another session: it acts on it within its own
// permission settings, and can't be talked into approving a prompt or changing its settings.
// This is Claude Code's internal protocol (peerProtocol 1), so a failure says so plainly.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// What the phone sends goes in exactly as typed; the transcript tags it with origin.from = PHONE_FROM.
const PHONE_FROM = 'sessionmax-phone';
// Older messages carried this first line instead.
const PHONE_MARK = 'Sent by the user from their phone through SessionMax (typed by them, not by another session):';

function inboxOf(pid) {
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `${pid}.json`), 'utf8'));
  } catch {
    return null;
  }
  if (!reg.messagingSocketPath || (reg.peerProtocol || 0) < 1) return null;
  const keyFile = fs.readdirSync(SESSIONS_DIR).find((f) => f.startsWith(`${pid}.`) && f.endsWith('.key'));
  if (!keyFile) return null;
  try {
    const { peerToken } = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, keyFile), 'utf8'));
    return peerToken ? { sock: reg.messagingSocketPath, token: peerToken } : null;
  } catch {
    return null;
  }
}

const canWrite = (pid) => !!pid && !!inboxOf(pid);

// Said plainly as what it is: SessionMax asking, after the user's tap on the phone.
const RC_REQUEST =
  'Sent by SessionMax because the user tapped "Turn on Remote Control" for this session on their phone. ' +
  'Please turn on Remote Control for this session (set_remote_control with session_id "self", enabled true), ' +
  'then reply in one short line. Nothing else needs doing.';

function sendToInbox(pid, text) {
  const inbox = inboxOf(pid);
  if (!inbox) return Promise.reject(new Error('This session has no inbox to write to'));
  return new Promise((resolve, reject) => {
    const c = net.connect({ path: inbox.sock }, () => {
      c.write(`${JSON.stringify({ type: 'auth', token: inbox.token })}\n`);
      c.write(
        `${JSON.stringify({
          type: 'user',
          message: { content: text },
          from: PHONE_FROM,
          uuid: crypto.randomUUID(),
          msg_id: crypto.randomUUID(),
          priority: 'next',
        })}\n`,
      );
      // The session doesn't answer on the pipe; a short wait lets it read before we hang up.
      setTimeout(() => c.end(), 300);
    });
    c.setTimeout(5000, () => c.destroy(new Error('The session did not answer')));
    c.on('error', (e) => reject(new Error(`Could not reach the session: ${e.message}`)));
    c.on('close', (hadError) => !hadError && resolve());
  });
}

// "Another Claude session sent a message:\n[<mark>\n\n]<text>\n\nThis came from…" -> <text>
// Claude Code adds the first and last lines itself; null when the turn isn't from the phone.
function phoneText(content, from) {
  let text;
  const i = content.indexOf(PHONE_MARK);
  if (i >= 0) text = content.slice(i + PHONE_MARK.length);
  else if (from === PHONE_FROM) text = content.replace(/^Another Claude session sent a message:\n/, '');
  else return null;
  const end = text.indexOf('\n\nThis came from another Claude session');
  if (end >= 0) text = text.slice(0, end);
  text = text.trim();
  return text === RC_REQUEST ? null : text;
}

module.exports = { canWrite, sendToInbox, phoneText, RC_REQUEST, PHONE_FROM };
