// A picture for each project (the folder a session runs in), like a WhatsApp group's photo.
//
// The options: the project's own logo files when it has any (favicon, logo, app icon), then an
// emoji that fits its name, another emoji, and a pattern drawn from its name. Every project gets at
// least three. The phone picks one; the choice is kept per folder in state.json.

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = /^(node_modules|\.git|\.claude|\.next|dist|out|out-[\w-]+|release|coverage|fixtures|tests?|qa|screenshots|renders|tmp|temp|cache|vendor)$/i;
const LOGO_FILE = /^(favicon|logo|icon|app-icon|apple-touch-icon)([-_.][\w-]*)?\.(svg|png|ico|jpe?g|webp)$/i;
const MAX_DEPTH = 4;
const MAX_BYTES = 2 * 1024 * 1024;

const TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Words in a project's name (English or Hebrew) and the emoji that fits them.
const EMOJI = [
  [/broom|clean|מטאטא/i, '🧹'],
  [/session|claude|chat|agent|צ'?אט/i, '💬'],
  [/carpent|aharon|lynden|wood|cabinet|kitchen|ארון|נגר|מטבח/i, '🪚'],
  [/render|video|frame|motion|reel|film|clip|סרט|וידאו/i, '🎬'],
  [/drive|cloud|sync|backup|ענן/i, '☁️'],
  [/zoom|premiere|plugin|after.?effects/i, '🎞️'],
  [/kis|money|budget|finance|wallet|expense|כיס|כסף|תקציב/i, '💰'],
  [/landing|site|web|page|דף|אתר|נחיתה/i, '🌐'],
  [/design|ui|ux|brand|עיצוב/i, '🎨'],
  [/phone|mobile|android|ios|טלפון/i, '📱'],
  [/bot|ai|gpt|gemini/i, '🤖'],
  [/test|qa|bench/i, '🧪'],
  [/data|db|sql|supabase/i, '🗄️'],
  [/shop|store|cart|חנות/i, '🛍️'],
  [/music|audio|sound|voice|מוזיקה/i, '🎵'],
  [/photo|image|camera|תמונ/i, '📷'],
  [/game|play|משחק/i, '🎮'],
  [/mail|inbox|מייל/i, '✉️'],
  [/learn|course|school|study|לימוד/i, '📚'],
  [/fix|tool|util|כלי/i, '🛠️'],
  [/doc|note|text|מסמך/i, '📄'],
  [/3d|model|cad|blender/i, '🧊'],
  [/map|travel|trip|מפה/i, '🗺️'],
  [/health|fit|sport|כושר/i, '💪'],
  [/home|house|בית/i, '🏠'],
];
const SPARE = ['🚀', '✨', '🧩', '⚡', '🌀', '🔮', '🪐', '🌿', '🔥', '💎', '🎯', '🌊'];

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

// Logo files in the folder, the likeliest first: svg, a "logo" name, bigger icons, shallower.
const logoCache = new Map(); // cwd -> { at, files: [relative paths] }
function findLogos(cwd) {
  const hit = logoCache.get(cwd);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.files;
  const found = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.test(e.name) && !e.name.startsWith('.')) walk(full, depth + 1);
      } else if (LOGO_FILE.test(e.name) || /^icon-\d+\.png$/i.test(e.name)) {
        try {
          const size = fs.statSync(full).size;
          if (size > 0 && size <= MAX_BYTES) found.push({ rel: path.relative(cwd, full), name: e.name.toLowerCase(), depth, size });
        } catch {}
      }
    }
  };
  walk(cwd, 0);
  const score = (f) =>
    (f.name.endsWith('.svg') ? 30 : 0) +
    (f.name.includes('logo') ? 20 : 0) +
    (/512|192|180|apple-touch|maskable/.test(f.name) ? 8 : 0) +
    (f.name.endsWith('.ico') ? -15 : 0) +
    Math.min(f.size / 4096, 10) -
    f.depth * 4;
  found.sort((a, b) => score(b) - score(a));
  // Two different looks at most: skip a second size of the same picture.
  const files = [];
  for (const f of found) {
    const stem = f.name.replace(/[-_.]?(\d+|maskable|any)?\.\w+$/, '');
    if (files.some((x) => x.stem === stem && x.ext !== '.svg' && !f.name.endsWith('.svg'))) continue;
    files.push({ rel: f.rel, stem, ext: path.extname(f.name) });
    if (files.length === 2) break;
  }
  const list = files.map((f) => f.rel);
  logoCache.set(cwd, { at: Date.now(), files: list });
  return list;
}

function iconOptions(cwd, name) {
  const out = [];
  if (cwd) {
    for (const rel of findLogos(cwd)) {
      out.push({ key: `file:${rel}`, kind: 'file', url: `/api/project-file?cwd=${encodeURIComponent(cwd)}&f=${encodeURIComponent(rel)}` });
    }
  }
  const label = `${name || ''} ${cwd || ''}`;
  const fits = [...new Set(EMOJI.filter(([re]) => re.test(name || '')).map(([, e]) => e))];
  if (!fits.length) fits.push(...EMOJI.filter(([re]) => re.test(label)).map(([, e]) => e));
  const h = hash(name || cwd || '?');
  const spare = SPARE.filter((e) => !fits.includes(e));
  const emojis = [...new Set([...fits, spare[h % spare.length], spare[(h >> 4) % spare.length]])].slice(0, 2);
  for (const e of emojis) out.push({ key: `emoji:${e}`, kind: 'emoji', emoji: e });
  out.push({ key: `pattern:${h % 997}`, kind: 'pattern', seed: h % 997 });
  return out;
}

function iconFor(cwd, name, chosen) {
  const options = iconOptions(cwd, name);
  return options.find((o) => o.key === chosen) || options[0];
}

// A logo file is served only when it's one of the project's own options.
function logoFile(cwd, rel) {
  if (!cwd || !rel || !findLogos(cwd).includes(rel)) return null;
  const full = path.join(cwd, rel);
  return { full, type: TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream' };
}

module.exports = { iconOptions, iconFor, logoFile };
