// Turns a session's transcript into chat messages for the phone.
//
// Only the end of the transcript is read (big sessions run to tens of MB); the phone shows the
// last MAX_MESSAGES of it.

const fs = require('fs');
const { findTranscript, describeTool } = require('./sessions');
const { phoneText } = require('./inbox');

const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES = 300;

const cache = new Map(); // file -> { key, messages }

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// Injected wrappers (<command-name>, <system-reminder>, ...) and interrupt markers aren't chat.
const isChat = (t) => !!t && !!t.trim() && !/^\s*</.test(t) && !/^\s*\[Request interrupted/.test(t);

function parse(lines) {
  const out = [];
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.isSidechain) continue;
    const at = Date.parse(j.timestamp) || 0;
    const content = j.message?.content;
    // Injected turns aren't chat, except what the phone sent into a running session.
    if (j.isMeta) {
      const text = j.type === 'user' ? phoneText(textOf(content), j.origin?.from) : null;
      if (text) out.push({ id: j.uuid, role: 'user', text, at });
      continue;
    }
    if (j.type === 'user') {
      const text = textOf(content);
      if (isChat(text)) out.push({ id: j.uuid, role: 'user', text, at });
    } else if (j.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && isChat(b.text)) out.push({ id: `${j.uuid}:${out.length}`, role: 'assistant', text: b.text, at });
        else if (b.type === 'tool_use') out.push({ id: b.id, role: 'tool', text: describeTool(b), at });
      }
    }
  }
  return out.slice(-MAX_MESSAGES);
}

function readChat(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return { messages: [], rev: '' };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { messages: [], rev: '' };
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return { messages: hit.messages, rev: key };

  const fd = fs.openSync(file, 'r');
  let lines;
  try {
    const len = Math.min(stat.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, stat.size - len);
    lines = buf.toString('utf8').split('\n');
    if (stat.size > len) lines.shift(); // cut in half
  } finally {
    fs.closeSync(fd);
  }
  const messages = parse(lines);
  cache.set(file, { key, messages });
  return { messages, rev: key };
}

// Changes whenever the transcript does; the phone refetches a chat when its rev moves.
function chatRev(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return '';
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '';
  }
}

module.exports = { readChat, chatRev };
