// SessionMax phone app: Claude Code sessions as chats.
//
// Screens (by URL hash): '' the chat list, '#chat/<id>' one chat, '#add' bring a chat back.
// The list comes live from /api/events; a chat refetches itself whenever its transcript moves.

const $app = document.getElementById('app');
const $snack = document.getElementById('snack');

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M3.4 20.4 20.85 12 3.4 3.6 3.39 10.13 15.85 12 3.39 13.87z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16a6.47 6.47 0 0 0 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
  forward: '<svg viewBox="0 0 24 24"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
};

const S = {
  me: null, // { phone, push, vapidKey } once paired
  chats: [],
  permissionMode: 'auto',
  chat: null, // the open chat: { id, data, rev }
  restorable: null,
  query: '',
  swiping: false,
  pendingRender: false,
};

// ---------- small helpers ----------

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
}

const lastRead = () => store('lastRead') || {};
function markRead(id, at) {
  const r = lastRead();
  r[id] = Math.max(r[id] || 0, at || Date.now());
  store('lastRead', r);
}
const isUnread = (c) => c.state === 'ready' && c.turnStartedAt && (lastRead()[c.id] || 0) < c.updatedAt;

function hue(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// Initials come from the chat's own name (two chats in one project still look different);
// the colour comes from the project, so a project's chats share a family look.
function initials(c) {
  const src = (c.name || c.project || '?').replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim();
  const words = src.split(/\s+/).filter(Boolean);
  const first = (w) => [...w][0] || '';
  return (words.length > 1 ? first(words[0]) + first(words[1]) : [...src].slice(0, 2).join('')).toUpperCase() || '?';
}

const projectColor = (c) => `hsl(${hue(c.project || c.name)} 75% 62%)`;

// A 5×5 mirrored pattern from a seed, in white, for projects without a logo.
function patternSvg(seed) {
  let x = seed * 9301 + 49297;
  const rnd = () => (x = (x * 9301 + 49297) % 233280) / 233280;
  let cells = '';
  for (let r = 0; r < 5; r++) {
    for (let col = 0; col < 3; col++) {
      if (rnd() < 0.5) continue;
      const o = (0.55 + rnd() * 0.45).toFixed(2);
      cells += `<rect x="${col}" y="${r}" width="1" height="1" rx=".22" opacity="${o}"/>`;
      if (col < 2) cells += `<rect x="${4 - col}" y="${r}" width="1" height="1" rx=".22" opacity="${o}"/>`;
    }
  }
  return `<svg class="pattern" viewBox="-.5 -.5 6 6" fill="#fff">${cells}</svg>`;
}

// The project's picture (logo, emoji or pattern), or its initials before the PC sends one.
function iconInner(icon, c) {
  if (!icon) return esc(initials(c));
  // App icons (png) are full-bleed squares and fill the circle; an svg logo sits inside it.
  if (icon.kind === 'file') return `<img class="${/\.svg(&|$)/i.test(decodeURIComponent(icon.url)) ? 'fit' : 'fill'}" src="${esc(icon.url)}" alt="" loading="lazy">`;
  if (icon.kind === 'emoji') return `<span class="emo">${icon.emoji}</span>`;
  return patternSvg(icon.seed);
}

function iconBg(icon, c) {
  if (icon?.kind === 'file') return '#ffffff';
  const h = hue(c.project || c.name);
  return `linear-gradient(135deg,hsl(${h} 70% 58%),hsl(${(h + 45) % 360} 65% 42%))`;
}

function avatar(c, small) {
  const st = c.live || c.state === 'working' ? c.state : c.state === 'ready' ? 'ready' : 'off';
  // Every redraw restarts the spinner; starting it at the clock's phase keeps it turning smoothly.
  return `<div class="avatar ${small ? 'small' : ''} ${st} ${c.icon ? `has-${c.icon.kind}` : ''}" style="background:${iconBg(c.icon, c)};--phase:-${Date.now() % 1000}ms"><span class="pic">${iconInner(c.icon, c)}</span><span class="dot"></span></div>`;
}

function timeLabel(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'numeric', year: '2-digit' });
}

function dayLabel(ms) {
  const t = timeLabel(ms);
  return /:/.test(t) ? 'Today' : t;
}

function statusLine(c) {
  if (c.state === 'working') return { cls: 'working', text: c.activity || 'working…' };
  if (c.state === 'needs') return { cls: 'needs', text: c.waitingFor ? `needs you: ${c.waitingFor}` : 'needs you' };
  if (c.state === 'ready') return { cls: 'ready', text: c.live ? 'ready' : 'ready · closed on PC' };
  return { cls: '', text: 'new' };
}

function snack(text, action, onAction, ms = 4500) {
  clearTimeout(snack.t);
  snack.n = (snack.n || 0) + 1; // a swipe-away still flying off leaves a newer message alone
  $snack.style.transition = 'none';
  $snack.style.transform = '';
  $snack.style.opacity = '';
  $snack.innerHTML = `<span>${esc(text)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  $snack.hidden = false;
  if (action) $snack.querySelector('button').onclick = () => {
    $snack.hidden = true;
    onAction();
  };
  snack.t = setTimeout(() => ($snack.hidden = true), ms);
}

// A snackbar swiped left or right far enough flies off and is dismissed; a short drag springs back.
(() => {
  let start = null;
  let dx = 0;
  const reset = () => {
    $snack.style.transition = 'transform 0.18s ease-out, opacity 0.18s ease-out';
    $snack.style.transform = '';
    $snack.style.opacity = '';
  };
  $snack.style.touchAction = 'pan-y';
  $snack.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return; // the Undo button stays a plain tap
    start = e.clientX;
    dx = 0;
    $snack.style.transition = 'none';
    $snack.setPointerCapture(e.pointerId);
  });
  $snack.addEventListener('pointermove', (e) => {
    if (start === null) return;
    dx = e.clientX - start;
    $snack.style.transform = `translateX(${dx}px)`;
    $snack.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / $snack.offsetWidth));
  });
  const end = () => {
    if (start === null) return;
    start = null;
    if (Math.abs(dx) < $snack.offsetWidth * 0.25) return reset();
    clearTimeout(snack.t);
    $snack.style.transition = 'transform 0.18s ease-in, opacity 0.18s ease-in';
    $snack.style.transform = `translateX(${Math.sign(dx) * window.innerWidth}px)`;
    $snack.style.opacity = '0';
    const n = snack.n;
    setTimeout(() => {
      if (snack.n !== n) return;
      $snack.hidden = true;
      $snack.style.transition = 'none';
      $snack.style.transform = '';
      $snack.style.opacity = '';
    }, 190);
  };
  $snack.addEventListener('pointerup', end);
  $snack.addEventListener('pointercancel', () => {
    start = null;
    reset();
  });
})();

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    S.me = null;
    render();
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Bare-bones markdown: code blocks, inline code, bold, headings, links.
function md(text) {
  const parts = String(text).split(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g);
  return parts
    .map((p, i) => {
      if (i % 2) return `<pre>${esc(p.replace(/\n$/, ''))}</pre>`;
      return esc(p)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,6} (.*)$/gm, '<span class="h">$1</span>')
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    })
    .join('');
}

// ---------- routing ----------

function route() {
  const h = location.hash;
  if (h.startsWith('#chat/')) return { name: 'chat', id: h.slice(6) };
  if (h === '#add') return { name: 'add' };
  if (h === '#new' || h.startsWith('#new/')) return { name: 'new', cwd: h.length > 5 ? decodeURIComponent(h.slice(5)) : '' };
  return { name: 'list' };
}

function go(hash) {
  if (location.hash === hash) return render();
  location.hash = hash;
}

window.addEventListener('hashchange', () => {
  S.chat = null;
  S.restorable = null;
  S.projects = undefined;
  S.browse = null;
  $app.dataset.view = '';
  $app.dataset.chat = '';
  S.query = '';
  render();
});

// ---------- rendering ----------

function render() {
  if (S.swiping) {
    S.pendingRender = true;
    return;
  }
  if (!S.me) return renderUnpaired();
  if (window.scrollY) window.scrollTo(0, 0); // a page scrolled while opening comes back to the top
  const r = route();
  if (r.name === 'chat') return renderChat(r.id);
  // These two screens don't change with live updates; redrawing them would cost the text being typed.
  if ((r.name === 'add' || r.name === 'new') && $app.dataset.view === r.name) return;
  $app.dataset.view = r.name;
  if (r.name === 'add') return renderAdd();
  if (r.name === 'new') return renderNew(r.cwd);
  renderList();
}

function renderUnpaired() {
  $app.innerHTML = `
    <div class="center"><div>
      <div class="avatar">SM</div>
      <b style="color:var(--text);font-size:19px">Pair this phone</b>
      <p>On your PC, right-click the SessionMax tray icon and choose <b>Phone…</b>, then scan the QR code with this phone's camera.</p>
    </div></div>`;
}

function rowHtml(c, opts = {}) {
  const st = statusLine(c);
  const unread = opts.swipe && isUnread(c); // unread marks belong on the chat list only
  let preview;
  if (c.state === 'working') preview = `<div class="row-preview working"><span class="typing"><i></i><i></i><i></i></span><span class="act">${esc(c.activity || 'working…')}</span></div>`;
  else if (c.state === 'needs') preview = `<div class="row-preview needs">${esc(st.text[0].toUpperCase() + st.text.slice(1))}</div>`;
  else preview = `<div class="row-preview" dir="auto">${esc(c.lastText || c.lastPrompt)}</div>`;
  const badge = c.state === 'needs' ? '<span class="row-badge needs">!</span>' : unread ? '<span class="row-badge">1</span>' : '';
  const tags = [
    c.project && !opts.grouped && `<span class="tag"><i style="background:${projectColor(c)}"></i>${esc(c.project)}</span>`,
    c.rcUrl && '<span class="tag rc">RC on</span>',
    opts.done && '<span class="tag">Marked done</span>',
    opts.swipe && !c.live && c.state !== 'working' && '<span class="tag">Closed on PC</span>',
  ].filter(Boolean);
  return `
    <div class="row-wrap" data-id="${esc(c.id)}">
      ${opts.swipe ? `<div class="row-action">${ICON.check}<span>Done</span></div>` : ''}
      <div class="row ${c.state === 'needs' ? 'needs' : ''}">
        ${avatar(c)}
        <div class="row-body">
          <div class="row-line"><div class="row-name" dir="auto">${esc(c.name)}</div><div class="row-time ${unread ? 'unread' : ''}">${esc(timeLabel(c.updatedAt))}</div></div>
          <div class="row-line">${preview}${badge}</div>
          ${tags.length ? `<div class="row-tags">${tags.join('')}</div>` : ''}
        </div>
      </div>
    </div>`;
}

// Installing: Chrome hands over its install prompt (beforeinstallprompt) when the app qualifies;
// we keep it for our own button instead of waiting for Chrome's one-time bar.
let installPrompt = null;
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (route().name === 'list') render();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  snack('SessionMax is on your home screen');
  render();
});

async function install() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === 'accepted') installPrompt = null;
  render();
}

function installBanner() {
  if (isInstalled() || store('hideInstall')) return '';
  if (installPrompt) return `<div class="banner"><div><b>Install SessionMax</b>Opens from your home screen, like an app.</div><button class="btn" id="install">Install</button></div>`;
  return `<div class="banner"><div><b>Install SessionMax</b>In Chrome, tap the ⋮ menu, then <b style="display:inline">Add to home screen</b>.</div><button class="btn ghost" id="install-hide">Got it</button></div>`;
}

function notifyBanner() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;
  if (!supported || S.me.push || store('hideNotifyBanner')) return '';
  return `<div class="banner"><div><b>Get notified</b>When a session is ready or needs you.</div><button class="btn" id="notify">Turn on</button></div>`;
}

const FILTERS = [
  ['all', 'All', ''],
  ['needs', 'Needs you', 'var(--needs)'],
  ['working', 'Working', 'var(--working)'],
  ['ready', 'Ready', 'var(--ready)'],
];

function renderList() {
  // Needs-you first, then the rest by latest activity.
  const all = [...S.chats].sort((a, b) => (b.state === 'needs') - (a.state === 'needs') || b.updatedAt - a.updatedAt);
  const count = (k) => all.filter((c) => c.state === k).length;
  const filter = store('filter') || 'all';
  const chats = filter === 'all' ? all : all.filter((c) => c.state === filter);
  const summary = [
    count('needs') && `<span style="color:var(--needs)"><i style="background:var(--needs)"></i>${count('needs')} need you</span>`,
    count('working') && `<span style="color:var(--working)"><i style="background:var(--working)"></i>${count('working')} working</span>`,
    count('ready') && `<span style="color:var(--ready)"><i style="background:var(--ready)"></i>${count('ready')} ready</span>`,
  ].filter(Boolean);
  // Until the PC answers, say so: an empty list would claim everything is done.
  const empty = !S.loaded
    ? `<div class="empty"><b>Connecting to your PC…</b>SessionMax must be running there.</div>`
    : filter === 'all'
      ? `<div class="empty"><div class="glyph">${ICON.check}</div><b>All caught up</b>Every session is done. Tap Reopen to bring one back.</div>`
      : `<div class="empty"><b>Nothing here</b>No chats are ${esc(FILTERS.find((f) => f[0] === filter)[1].toLowerCase())} right now.</div>`;
  const scroll = $app.querySelector('#list')?.scrollTop || 0;
  $app.innerHTML = `
    <div class="hero">
      <div class="grow">
        <h1>Chats</h1>
        <div class="sub">${summary.length ? summary.join('') : `<span>${S.loaded ? 'All quiet' : 'Connecting…'}</span>`}</div>
      </div>
      <button class="pill-btn" id="add">Reopen</button>
      <button class="icon-btn" id="settings" aria-label="Settings">${ICON.more}</button>
    </div>
    <div class="filters">${FILTERS.map(
      ([k, label, color]) =>
        `<button class="filter ${k === filter ? 'on' : ''}" data-f="${k}">${color ? `<span class="dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>` : ''}${label}${k !== 'all' && count(k) ? ` <b>${count(k)}</b>` : ''}</button>`,
    ).join('')}</div>
    <div class="list" id="list">
      ${installBanner() || notifyBanner()}
      ${chats.length ? groupsHtml(chats) : empty}
    </div>
    <button class="fab" id="new">${ICON.plus}New chat</button>`;
  $app.querySelector('#list').scrollTop = scroll;
  for (const b of $app.querySelectorAll('.filter')) {
    b.onclick = () => {
      store('filter', b.dataset.f);
      render();
    };
  }
  $app.querySelector('#add').onclick = () => go('#add');
  $app.querySelector('#new').onclick = () => go('#new');
  for (const b of $app.querySelectorAll('.group-new')) {
    b.onclick = (e) => {
      e.stopPropagation();
      go(`#new/${encodeURIComponent(b.dataset.cwd)}`);
    };
  }
  $app.querySelector('#settings').onclick = settingsSheet;
  const n = $app.querySelector('#notify');
  if (n) n.onclick = enableNotifications;
  const inst = $app.querySelector('#install');
  if (inst) inst.onclick = install;
  const hide = $app.querySelector('#install-hide');
  if (hide) {
    hide.onclick = () => {
      store('hideInstall', true);
      render();
    };
  }
  for (const h of $app.querySelectorAll('.group-head')) {
    h.onclick = () => {
      const shut = new Set(store('collapsed') || []);
      if (shut.has(h.dataset.p)) shut.delete(h.dataset.p);
      else shut.add(h.dataset.p);
      store('collapsed', [...shut]);
      render();
    };
  }
  for (const wrap of $app.querySelectorAll('.row-wrap')) bindSwipe(wrap);
}

// Chats under a header per project (environment), the group needing you or most recently active first.
function groupsHtml(chats) {
  const groups = new Map();
  for (const c of chats) {
    const key = c.project || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c); // chats arrive sorted, so each group stays sorted
  }
  const shut = new Set(store('collapsed') || []);
  return [...groups]
    .map(([name, list]) => {
      const closed = shut.has(name);
      const needs = list.filter((c) => c.state === 'needs').length;
      const working = list.filter((c) => c.state === 'working').length;
      const dots = [
        needs && `<span class="g-stat" style="--c:var(--needs)">${needs}</span>`,
        working && `<span class="g-stat" style="--c:var(--working)">${working}</span>`,
      ].filter(Boolean).join('');
      return `
        <section class="group">
          <button class="group-head" data-p="${esc(name)}" aria-expanded="${!closed}">
            <span class="g-icon ${list[0].icon ? `has-${list[0].icon.kind}` : ''}" style="background:${iconBg(list[0].icon, list[0])}">${iconInner(list[0].icon, list[0])}</span>
            <span class="g-name" dir="auto">${esc(name)}</span>
            ${closed ? dots : ''}
            <span class="g-count">${list.length}</span>
            ${list[0].cwd ? `<span class="group-new" role="button" tabindex="0" data-cwd="${esc(list[0].cwd)}" aria-label="New chat in ${esc(name)}">${ICON.plus}</span>` : ''}
            <svg class="g-chev ${closed ? 'shut' : ''}" viewBox="0 0 24 24"><path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
          </button>
          ${closed ? '' : list.map((c) => rowHtml(c, { swipe: true, grouped: true })).join('')}
        </section>`;
    })
    .join('');
}

// Swipe a row either way to mark the session done; a tap opens it.
function bindSwipe(wrap) {
  const row = wrap.querySelector('.row');
  const action = wrap.querySelector('.row-action');
  const id = wrap.dataset.id;
  let start = null;
  let dx = 0;
  let horizontal = null;

  // Live updates wait while a finger is on a row, or they'd swap the row out mid-tap.
  row.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY };
    dx = 0;
    horizontal = null;
    S.swiping = true;
    row.classList.remove('snapping');
  });
  row.addEventListener('pointermove', (e) => {
    if (!start) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (horizontal === null && Math.abs(mx) + Math.abs(my) > 8) {
      horizontal = Math.abs(mx) > Math.abs(my);
      if (horizontal) row.setPointerCapture(e.pointerId);
      else {
        start = null;
        finishSwipe(); // scrolling the list
      }
    }
    if (!horizontal) return;
    // A chat that's still running can't be done: the card only gives a little, then springs back.
    const busy = ['working', 'needs'].includes(S.chats.find((x) => x.id === id)?.state);
    dx = busy ? mx * 0.15 : mx;
    wrap.classList.toggle('locked', busy);
    row.style.transform = `translateX(${dx}px)`;
    action.classList.toggle('from-left', dx > 0); // "Done" sits on the side the card uncovers
    action.classList.toggle('armed', Math.abs(dx) > wrap.offsetWidth * 0.35);
  });
  const end = () => {
    if (!start) return;
    const wasSwipe = horizontal;
    start = null;
    if (!wasSwipe) {
      S.swiping = false;
      S.pendingRender = false;
      return go(`#chat/${id}`);
    }
    if (wrap.classList.contains('locked')) {
      wrap.classList.remove('locked');
      row.classList.add('snapping');
      row.style.transform = '';
      setTimeout(finishSwipe, 200);
      return snack("It's still working. You can mark it done once it stops.");
    }
    if (Math.abs(dx) > wrap.offsetWidth * 0.35) {
      row.classList.add('leaving');
      row.style.transform = `translateX(${Math.sign(dx) * wrap.offsetWidth}px)`;
      setTimeout(() => {
        wrap.style.height = `${wrap.offsetHeight}px`;
        wrap.classList.add('collapse');
        requestAnimationFrame(() => (wrap.style.height = '0px'));
        setTimeout(() => finishSwipe(), 230);
      }, 200);
      markDone(id);
    } else {
      row.classList.add('snapping');
      row.style.transform = '';
      setTimeout(finishSwipe, 200);
    }
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', () => {
    if (!start) return;
    start = null;
    row.classList.add('snapping');
    row.style.transform = '';
    setTimeout(finishSwipe, 200);
  });
}

function finishSwipe() {
  S.swiping = false;
  if (S.pendingRender) {
    S.pendingRender = false;
    render();
  }
}

async function markDone(id) {
  const c = S.chats.find((x) => x.id === id);
  S.chats = S.chats.filter((x) => x.id !== id);
  try {
    await api(`/api/chat/${id}/done`, {});
    snack(`“${c ? c.name : 'Chat'}” is done`, 'Undo', () => restore(id, false), 8000);
  } catch (e) {
    if (c) S.chats.push(c);
    S.swiping = false;
    render();
    snack(e.message);
  }
}

async function restore(id, open = true) {
  try {
    await api(`/api/chat/${id}/restore`, {});
    // Replace the + screen, so back from the chat lands on the list.
    if (open) location.replace(`#chat/${id}`);
  } catch (e) {
    snack(e.message);
  }
}

// ---------- bring a chat back ----------

async function renderAdd() {
  const draw = () => {
    const q = S.query.toLowerCase();
    const list = (S.restorable || []).filter((c) => !q || `${c.name} ${c.project} ${c.lastPrompt}`.toLowerCase().includes(q));
    // One section per project, the most recently used first (the list arrives newest first).
    const groups = new Map();
    for (const c of list) {
      const key = c.project || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const html = [...groups]
      .map(
        ([name, items]) => `<section class="group">
          <div class="group-head static"><i style="background:${projectColor(items[0])}"></i><span class="g-name" dir="auto">${esc(name)}</span><span class="g-count">${items.length}</span></div>
          ${items.map((c) => rowHtml(c, { grouped: true, done: c.done })).join('')}
        </section>`,
      )
      .join('');
    $app.querySelector('#items').innerHTML =
      S.restorable === null ? '<div class="empty">Loading…</div>' : html || '<div class="empty"><b>Nothing here</b>No other sessions found.</div>';
    for (const wrap of $app.querySelectorAll('.row-wrap')) wrap.onclick = () => restore(wrap.dataset.id);
  };
  $app.innerHTML = `
    <div class="top">
      <button class="back" id="back">${ICON.back}Chats</button>
      <div class="title"><b>Reopen a chat</b><small>Tap one to put it back on your list</small></div>
    </div>
    <label class="search">${ICON.search}<input id="q" placeholder="Search sessions" value="${esc(S.query)}" autocomplete="off"></label>
    <div class="list" id="items"></div>`;
  $app.querySelector('#back').onclick = () => history.back();
  $app.querySelector('#q').oninput = (e) => {
    S.query = e.target.value;
    draw();
  };
  draw();
  if (S.restorable === null) {
    try {
      S.restorable = (await api('/api/restorable')).chats;
    } catch (e) {
      S.restorable = [];
      snack(e.message);
    }
    if (route().name === 'add') draw();
  }
}

// ---------- new chat ----------

// Start a session in one of the folders sessions ran in lately; it opens as a chat.
async function renderNew(cwd) {
  const fetchProjects = S.projects === undefined;
  if (fetchProjects) S.projects = null;
  const pick = () => S.newCwd || cwd || S.projects?.[0]?.cwd || '';
  const draw = () => {
    if (S.browse) return drawBrowse();
    // A folder picked by browsing sits first, selected, until another is picked.
    const list = S.projects && S.picked && !S.projects.some((p) => p.cwd === S.picked.cwd) ? [S.picked, ...S.projects] : S.projects;
    $app.querySelector('#projects').innerHTML =
      list === null
        ? '<div class="empty">Loading projects…</div>'
        : (list.length
          ? list
              .map(
                (p) => `<button class="proj ${p.cwd === pick() ? 'on' : ''}" data-cwd="${esc(p.cwd)}">
                  <i style="background:${projectColor({ project: p.name })}"></i>
                  <span><b dir="auto">${esc(p.name)}</b><small dir="ltr">${esc(p.cwd)}</small></span>
                </button>`,
              )
              .join('')
          : '') + `<button class="proj other" id="browse">${ICON.search}<span><b>Another folder…</b><small>Any folder in your user folder</small></span></button>`;
    const browse = $app.querySelector('#browse');
    if (browse) browse.onclick = () => openFolder('');
    for (const b of $app.querySelectorAll('.proj:not(.other)')) {
      b.onclick = () => {
        S.newCwd = b.dataset.cwd;
        draw();
      };
    }
    const p = [...(S.projects || []), S.picked].find((x) => x && x.cwd === pick());
    $app.querySelector('#start').textContent = p ? `Start in ${p.name}` : 'Start chat';
  };
  async function openFolder(dir) {
    S.browse = { loading: true, path: dir };
    draw();
    try {
      S.browse = await api(`/api/folders?path=${encodeURIComponent(dir)}`);
    } catch (e) {
      S.browse = null;
      snack(e.message);
    }
    if (route().name === 'new') draw();
  }
  function drawBrowse() {
    const b = S.browse;
    const box = $app.querySelector('#projects');
    if (b.loading) {
      box.innerHTML = '<div class="empty">Loading folders…</div>';
      return;
    }
    box.innerHTML = `
      <div class="browse-head">
        <button class="pill-btn" id="up">${ICON.back}${b.parent ? 'Up' : 'Projects'}</button>
        <small dir="ltr">${esc(b.path)}</small>
      </div>
      <button class="btn ghost wide use" id="use">Use “${esc(b.name)}”</button>
      ${b.folders.map((f) => `<button class="proj folder" data-path="${esc(f.path)}"><span><b dir="auto">${esc(f.name)}</b></span></button>`).join('') || '<div class="empty">No folders inside.</div>'}`;
    box.querySelector('#up').onclick = () => {
      if (b.parent) openFolder(b.parent);
      else {
        S.browse = null;
        draw();
      }
    };
    box.querySelector('#use').onclick = () => {
      S.picked = { name: b.name, cwd: b.path };
      S.newCwd = b.path;
      S.browse = null;
      draw();
    };
    for (const f of box.querySelectorAll('.folder')) f.onclick = () => openFolder(f.dataset.path);
    $app.querySelector('#start').textContent = 'Start chat';
  }
  $app.innerHTML = `
    <div class="top">
      <button class="back" id="back">${ICON.back}Chats</button>
      <div class="title"><b>New chat</b><small>Runs on your PC, in the folder you pick</small></div>
    </div>
    <div class="list new-chat">
      <div class="section">Project</div>
      <div id="projects"></div>
      <div class="section">First message</div>
      <div class="field big"><textarea id="first" rows="4" placeholder="What should Claude do?" dir="auto">${esc(store('newDraft') || '')}</textarea></div>
      <button class="btn wide" id="start">Start chat</button>
    </div>`;
  $app.querySelector('#back').onclick = () => (history.length > 1 ? history.back() : go(''));
  const ta = $app.querySelector('#first');
  ta.oninput = () => store('newDraft', ta.value);
  const start = $app.querySelector('#start');
  start.onclick = async () => {
    const text = ta.value.trim();
    if (!pick()) return snack('Pick a project first');
    if (!text) return snack('Write the first message');
    start.disabled = true;
    start.textContent = 'Starting…';
    try {
      const r = await api('/api/new', { cwd: pick(), text });
      store('newDraft', '');
      S.newCwd = '';
      if (r.id) location.replace(`#chat/${r.id}`);
      else {
        snack('Started. It shows up on your list in a moment.');
        location.replace('#');
      }
    } catch (e) {
      snack(e.message);
      start.disabled = false;
      draw();
    }
  };
  draw();
  if (fetchProjects) {
    try {
      S.projects = (await api('/api/projects')).projects;
    } catch (e) {
      S.projects = [];
      snack(e.message);
    }
    if (route().name === 'new') draw();
  }
}

// ---------- one chat ----------

function groupMessages(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.role === 'tool' && last && last.role === 'steps') last.items.push(m);
    else if (m.role === 'tool') out.push({ role: 'steps', items: [m], at: m.at, id: m.id });
    else out.push(m);
  }
  return out;
}

function messagesHtml(data) {
  const c = data.chat;
  let html = '';
  let lastDay = '';
  let prevRole = '';
  for (const m of groupMessages(data.messages)) {
    const day = dayLabel(m.at);
    if (m.at && day !== lastDay) {
      html += `<div class="day">${esc(day)}</div>`;
      lastDay = day;
      prevRole = '';
    }
    if (m.role === 'steps') {
      const last = m.items[m.items.length - 1].text;
      html += `<details class="steps"><summary>⚙ ${m.items.length > 1 ? `${m.items.length} steps · ` : ''}${esc(last)}</summary>${
        m.items.length > 1 ? `<ol>${m.items.map((i) => `<li>${esc(i.text)}</li>`).join('')}</ol>` : ''
      }</details>`;
      prevRole = 'steps';
      continue;
    }
    const time = m.at ? new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const long = m.role === 'assistant' && m.text.length > 900;
    const pickable = m.id && (m.role === 'user' || m.role === 'assistant');
    html += `<div class="bubble ${m.role} ${prevRole === m.role ? 'cont' : ''} ${long ? 'clamped' : ''} ${pickable && S.chat?.sel?.has(m.id) ? 'selected' : ''}" ${
      pickable ? `data-id="${esc(m.id)}"` : ''
    } dir="auto"><div class="body">${
      m.role === 'user' ? esc(m.text) : md(m.text)
    }</div>${long ? '<button class="more">Read more</button>' : ''}<span class="meta">${esc(time)}</span></div>`;
    prevRole = m.role;
  }
  if (c.state === 'working') html += `<div class="bubble assistant live"><span class="typing"><i></i><i></i><i></i></span>${esc(c.activity || 'working…')}</div>`;
  if (c.state === 'needs') html += `<div class="bubble assistant live needs">Waiting for you on the PC${c.waitingFor ? `: ${esc(c.waitingFor)}` : ''}</div>`;
  return html;
}

function composerHtml(c) {
  if (c.canSend) {
    const draft = (store('drafts') || {})[c.id] || '';
    // Like WhatsApp's emoji button: the Claude app, live, for this session (or how to get there).
    const claudeBtn = c.rcUrl
      ? `<a class="claude-btn on" href="${esc(c.rcUrl)}" target="_blank" rel="noopener" aria-label="Open in the Claude app">${ICON.open}</a>`
      : `<button class="claude-btn" id="rc3" aria-label="Open in the Claude app">${ICON.open}</button>`;
    return `<div class="composer"><div class="field">${claudeBtn}<textarea id="text" rows="1" aria-label="Message" dir="auto">${esc(draft)}</textarea></div><button class="send" id="send" aria-label="Send">${ICON.send}</button></div>`;
  }
  if (c.state === 'working' && !c.live) return `<div class="lockbar"><span>Claude is answering your message…</span></div>`;
  if (c.rcUrl) return `<div class="lockbar"><span>Running on the PC. Reply live in the Claude app.</span><a class="btn" href="${esc(c.rcUrl)}" target="_blank" rel="noopener" style="display:grid;place-items:center;text-decoration:none">Open in Claude</a></div>`;
  return `<div class="lockbar"><span>Open in the Claude app on your PC, without Remote Control. Only the Claude app can turn it on.</span><button class="btn ghost" id="rc2">How</button></div>`;
}

async function renderChat(id) {
  const first = !S.chat || S.chat.id !== id;
  if (first) {
    clearNotifications(id);
    S.chat = { id, data: null, rev: null };
    const c = S.chats.find((x) => x.id === id);
    drawChat(c ? { chat: c, messages: [] } : null);
  }
  await loadChat(id);
}

async function loadChat(id) {
  try {
    const data = await api(`/api/chat/${id}`);
    if (!S.chat || S.chat.id !== id) return;
    const changed = data.rev !== S.chat.rev || JSON.stringify(data.chat) !== JSON.stringify(S.chat.data?.chat);
    S.chat.data = data;
    S.chat.rev = data.rev;
    markRead(id, data.chat.updatedAt);
    if (changed) drawChat(data);
  } catch (e) {
    snack(e.message);
  }
}

// Live updates redraw only what changed: the top bar, the messages, and the message box only
// when its kind changes, so typing (focus, cursor, keyboard) is never interrupted.
function drawChat(data) {
  const id = S.chat.id;
  const c = data?.chat || { id, name: '…', state: 'new', project: '' };
  const st = statusLine(c);
  if ($app.dataset.chat !== id || !$app.querySelector('#chat')) {
    $app.dataset.chat = id;
    $app.innerHTML = `
      <div class="top" id="top"></div>
      <div class="chat-wrap">
        <div class="chat" id="chat"></div>
        <button class="to-bottom" id="to-bottom" aria-label="Jump to latest message" hidden>${ICON.down}</button>
      </div>
      <div id="composer-slot" class="composer-slot"></div>`;
    const chat = $app.querySelector('#chat');
    const toBottom = $app.querySelector('#to-bottom');
    // A jump-to-latest button shows once you've scrolled up from the bottom.
    chat.syncToBottom = () => (toBottom.hidden = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200);
    chat.addEventListener('scroll', chat.syncToBottom, { passive: true });
    toBottom.onclick = () => chat.scrollTo({ top: chat.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    bindSelect(chat);
  }

  const top = $app.querySelector('#top');
  // While messages are picked, the top bar becomes their actions (like WhatsApp).
  if (S.chat.sel?.size) drawSelectBar(top);
  else {
    top.classList.remove('picking');
    top.innerHTML = `
      <button class="back" id="back" aria-label="Back to chats">${ICON.back}</button>
      <button class="avatar-btn" id="pic" aria-label="Change the project picture">${avatar(c, true)}</button>
      <div class="title"><b dir="auto">${esc(c.name)}</b><small class="${st.cls}">${esc(st.text)}${c.project ? ` · ${esc(c.project)}` : ''}</small></div>
      <button class="rc-chip ${c.rcUrl ? 'on' : ''}" id="rc"><i></i>RC</button>`;
    top.querySelector('#back').onclick = () => (history.length > 1 ? history.back() : go(''));
    top.querySelector('#rc').onclick = () => rcSheet(c);
    top.querySelector('#pic').onclick = () => c.cwd && iconSheet(c);
  }

  const chat = $app.querySelector('#chat');
  const html = data ? messagesHtml(data) : '<div class="day">Loading…</div>';
  if (chat.dataset.html !== html) {
    const first = chat.dataset.html === undefined || !data;
    const atBottom = first || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    const scroll = chat.scrollTop;
    chat.innerHTML = html;
    chat.dataset.html = html;
    for (const b of chat.querySelectorAll('.more')) {
      b.onclick = () => {
        b.parentElement.classList.remove('clamped');
        b.remove();
      };
    }
    chat.scrollTop = atBottom ? chat.scrollHeight : scroll;
  }
  chat.syncToBottom();

  // The message box is rebuilt only when what it offers changes, never while you type.
  const slot = $app.querySelector('#composer-slot');
  const kind = data ? [c.canSend, c.rcUrl, c.live, c.state === 'working' && !c.live].join('|') : 'none';
  if (slot.dataset.kind !== kind) {
    const keepText = slot.querySelector('#text')?.value;
    const hadFocus = document.activeElement?.id === 'text';
    slot.innerHTML = data ? composerHtml(c) : '';
    slot.dataset.kind = kind;
    for (const b of slot.querySelectorAll('#rc2, #rc3')) b.onclick = () => rcSheet(c);
    bindComposer(c, keepText, hadFocus);
  }
}

function bindComposer(c, keepText, hadFocus) {
  const ta = $app.querySelector('#text');
  if (!ta) return;
  if (keepText !== undefined) ta.value = keepText;
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`;
  };
  grow();
  if (hadFocus) ta.focus();
  const sendBtn = $app.querySelector('#send');
  ta.oninput = () => {
    grow();
    const drafts = store('drafts') || {};
    drafts[c.id] = ta.value;
    store('drafts', drafts);
  };
  sendBtn.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      await api(`/api/chat/${c.id}/send`, { text });
      ta.value = '';
      grow(); // setting value doesn't fire input, so shrink back to one row by hand
      const drafts = store('drafts') || {};
      delete drafts[c.id];
      store('drafts', drafts);
      // Show it right away; the transcript catches up in a moment.
      const data = S.chat.data;
      data.messages.push({ id: `local-${Date.now()}`, role: 'user', text, at: Date.now() });
      // A running session takes more messages while it works; a closed one answers one at a time.
      data.chat = { ...data.chat, state: 'working', canSend: !!data.chat.live, activity: data.chat.live ? 'Got your message…' : 'Starting…' };
      drawChat(data);
    } catch (e) {
      snack(e.message);
    } finally {
      sendBtn.disabled = false;
    }
  };
}

// ---------- picking messages: copy and forward ----------

// Long-press a message to pick it, then tap others to add or drop them. The phone's back
// gesture drops the selection before it leaves the chat.
function bindSelect(chat) {
  let timer = null;
  let start = null;
  let longPressed = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  chat.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.bubble[data-id]');
    longPressed = false;
    if (!b || S.chat.sel?.size || (e.pointerType === 'mouse' && e.button !== 0)) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      longPressed = true;
      navigator.vibrate?.(15);
      toggleSelected(b.dataset.id);
    }, 450);
  });
  chat.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  chat.addEventListener('pointerup', cancel);
  chat.addEventListener('pointercancel', cancel);
  chat.addEventListener('contextmenu', (e) => e.target.closest('.bubble[data-id]') && e.preventDefault());
  // Capture, so a tap while picking doesn't also open a link or "Read more".
  chat.addEventListener(
    'click',
    (e) => {
      const b = e.target.closest('.bubble[data-id]');
      if (longPressed) {
        longPressed = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!S.chat.sel?.size || !b) return;
      e.preventDefault();
      e.stopPropagation();
      toggleSelected(b.dataset.id);
    },
    true,
  );
}

function toggleSelected(id) {
  const sel = (S.chat.sel ||= new Set());
  const was = sel.size;
  sel.has(id) ? sel.delete(id) : sel.add(id);
  if (!was && sel.size) history.pushState({ picking: true }, '');
  if (was && !sel.size) return clearSelected();
  drawChat(S.chat.data);
}

function clearSelected() {
  if (!S.chat) return;
  S.chat.sel = null;
  if (history.state?.picking) history.back(); // its popstate redraws
  else drawChat(S.chat.data);
}

window.addEventListener('popstate', () => {
  if (!S.chat || location.hash !== `#chat/${S.chat.id}`) return;
  S.chat.sel = null;
  drawChat(S.chat.data);
});

// The picked messages in the order they were said; several get a "You:" / "Claude:" label each.
function selectedText() {
  const picked = S.chat.data.messages.filter((m) => S.chat.sel.has(m.id));
  if (picked.length === 1) return picked[0].text;
  return picked.map((m) => `${m.role === 'user' ? 'You' : 'Claude'}: ${m.text}`).join('\n\n');
}

function drawSelectBar(top) {
  const n = S.chat.sel.size;
  top.classList.add('picking');
  top.innerHTML = `
    <button class="icon-btn" id="sel-x" aria-label="Cancel selection">${ICON.close}</button>
    <div class="title"><b>${n}</b></div>
    <button class="icon-btn" id="sel-copy" aria-label="Copy ${n > 1 ? `${n} messages` : 'message'}">${ICON.copy}</button>
    <button class="icon-btn" id="sel-fwd" aria-label="Forward ${n > 1 ? `${n} messages` : 'message'}">${ICON.forward}</button>`;
  top.querySelector('#sel-x').onclick = clearSelected;
  top.querySelector('#sel-copy').onclick = async () => {
    try {
      await copyText(selectedText());
      snack(n > 1 ? `${n} messages copied` : 'Message copied');
      clearSelected();
    } catch {
      snack("Couldn't copy");
    }
  };
  top.querySelector('#sel-fwd').onclick = () => forwardSheet(selectedText(), n);
}

async function copyText(text) {
  try {
    return await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers, or the clipboard permission was refused: the old way.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy');
  }
}

// Forward to another chat: it lands in that chat's message box, so you can add a line and
// send it yourself (a session starts working the moment it gets a message).
function forwardSheet(text, n) {
  const from = S.chat.data.chat;
  const others = S.chats.filter((c) => c.id !== from.id);
  const body = `Forwarded from "${from.name}":\n\n${text}`;
  sheet(
    `<h2>Forward ${n > 1 ? `${n} messages` : 'message'}</h2><p>It goes into the chat's message box, ready to send.</p>
     <div class="fwd-list">${
       others.length
         ? others.map((c) => `<button class="fwd-row" data-id="${esc(c.id)}" ${c.canSend ? '' : 'disabled'}>${avatar(c, true)}<span class="fwd-name"><b dir="auto">${esc(c.name)}</b><small>${
             c.canSend ? esc(c.project || '') : 'Busy, can’t take a message now'
           }</small></span></button>`).join('')
         : '<p>No other chats.</p>'
     }</div>
     <div class="actions"><button class="btn ghost" id="close">Cancel</button></div>`,
    (el, close) => {
      el.querySelector('#close').onclick = close;
      for (const b of el.querySelectorAll('.fwd-row')) {
        b.onclick = () => {
          const drafts = store('drafts') || {};
          drafts[b.dataset.id] = drafts[b.dataset.id] ? `${drafts[b.dataset.id]}\n\n${body}` : body;
          store('drafts', drafts);
          close();
          S.chat.sel = null;
          go(`#chat/${b.dataset.id}`);
          snack('Forwarded into the message box. Tap send.');
        };
      }
    },
  );
}

// ---------- sheets ----------

function sheet(html, bind) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `<div class="sheet"><div class="grip"></div>${html}</div>`;
  scrim.onclick = (e) => e.target === scrim && scrim.remove();
  document.body.appendChild(scrim);
  bind(scrim, () => scrim.remove());
}

// Like a WhatsApp group photo: pick the project's picture from its options.
async function iconSheet(c) {
  let data;
  try {
    data = await api(`/api/icons?cwd=${encodeURIComponent(c.cwd)}`);
  } catch (e) {
    return snack(e.message);
  }
  const tile = (o) => `<button class="icon-opt ${o.key === data.chosen ? 'on' : ''}" data-key="${esc(o.key)}" aria-label="${o.kind === 'file' ? 'Project logo' : o.kind === 'emoji' ? `Emoji ${o.emoji}` : 'Pattern'}">
      <span class="pic has-${o.kind}" style="background:${iconBg(o, c)}">${iconInner(o, c)}</span></button>`;
  sheet(
    `<h2>${esc(c.project || 'Project')} picture</h2><p>Shown on every chat in this project.</p>
     <div class="icon-grid">${data.options.map(tile).join('')}</div>
     <div class="actions"><button class="btn ghost" id="close">Close</button></div>`,
    (el, close) => {
      el.querySelector('#close').onclick = close;
      for (const b of el.querySelectorAll('.icon-opt')) {
        b.onclick = async () => {
          try {
            await api(`/api/icons?cwd=${encodeURIComponent(c.cwd)}`, { key: b.dataset.key });
            close();
            snack('Picture changed');
            if (S.chat?.data) loadChat(S.chat.id);
          } catch (e) {
            snack(e.message);
          }
        };
      }
    },
  );
}

function rcSheet(c) {
  let body;
  if (c.rcUrl) {
    body = `<h2>Remote Control is on</h2><p>Continue this session live in the Claude app: you'll see everything as it happens and can answer its questions.</p>
      <div class="actions"><a class="btn" href="${esc(c.rcUrl)}" target="_blank" rel="noopener" style="display:grid;place-items:center;text-decoration:none">Open in Claude app</a>
      ${c.rcOurs ? '<button class="btn ghost" id="off">Turn off Remote Control</button>' : ''}</div>`;
  } else if (c.live) {
    body = `<h2>Turn on Remote Control</h2><p>Asks the session on your PC to switch it on. It may take a moment, or ask on the PC first.</p>
      <div class="actions"><button class="btn" id="on">Turn on</button><button class="btn ghost" id="close">Cancel</button></div>`;
  } else {
    body = `<h2>Turn on Remote Control</h2><p>Starts this session again on your PC, in the background, connected to Remote Control. Then you can continue it live in the Claude app.</p>
      <div class="actions"><button class="btn" id="on">Turn on</button><button class="btn ghost" id="close">Cancel</button></div>`;
  }
  sheet(body, (el, close) => {
    const on = el.querySelector('#on');
    const off = el.querySelector('#off');
    const cl = el.querySelector('#close');
    if (cl) cl.onclick = close;
    if (on) {
      on.onclick = async () => {
        on.disabled = true;
        on.textContent = 'Starting…';
        try {
          const r = await api(`/api/chat/${c.id}/rc`, { on: true });
          close();
          if (r.url) window.open(r.url, '_blank');
          else if (r.asked) snack("Asked the session. The button turns green once it's on.");
          else snack('Remote Control is starting. Open in Claude appears in a few seconds.');
        } catch (e) {
          on.disabled = false;
          on.textContent = 'Turn on';
          snack(e.message === 'desktop' ? "This session can't turn it on from here. Use /remote-control on the PC." : e.message);
        }
      };
    }
    if (off) {
      off.onclick = async () => {
        off.disabled = true;
        try {
          await api(`/api/chat/${c.id}/rc`, { on: false });
          close();
          snack('Remote Control is off');
        } catch (e) {
          snack(e.message);
        }
      };
    }
  });
}

function settingsSheet() {
  const modes = [
    ['auto', 'Auto: Claude decides what is safe'],
    ['acceptEdits', 'Accept edits: file edits only'],
    ['manual', 'Ask: anything risky is refused'],
    ['plan', 'Plan only: no changes'],
  ];
  sheet(
    `<h2>Settings</h2>
     <p>Replies you send from here run on your PC with this permission mode:</p>
     <select id="mode">${modes.map(([v, l]) => `<option value="${v}" ${v === S.permissionMode ? 'selected' : ''}>${l}</option>`).join('')}</select>
     <div class="actions">
       ${!isInstalled() && installPrompt ? '<button class="btn" id="inst2">Install app</button>' : ''}
       <button class="btn ${S.me.push ? 'ghost' : ''}" id="push">${S.me.push ? 'Notifications are on · test' : 'Turn on notifications'}</button>
       <button class="btn ghost" id="close">Close</button>
     </div>
     <p style="margin:14px 0 0;font-size:12.5px">Paired as ${esc(S.me.phone)}.</p>`,
    (el, close) => {
      el.querySelector('#mode').onchange = (e) => api('/api/settings', { permissionMode: e.target.value }).catch((err) => snack(err.message));
      el.querySelector('#close').onclick = close;
      const inst2 = el.querySelector('#inst2');
      if (inst2) {
        inst2.onclick = () => {
          close();
          install();
        };
      }
      el.querySelector('#push').onclick = async () => {
        close();
        if (S.me.push && Notification.permission === 'granted') {
          const reg = await navigator.serviceWorker.ready;
          reg.showNotification('SessionMax', { body: 'Notifications work.', icon: '/icon-192.png' });
        } else enableNotifications();
      };
    },
  );
}

// ---------- notifications ----------

// The notifications about a chat go away once it's opened.
async function clearNotifications(id) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    for (const n of (await reg?.getNotifications({ tag: id })) || []) n.close();
  } catch {}
}

function keyBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

async function enableNotifications() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      store('hideNotifyBanner', true);
      render();
      return snack('Notifications are blocked. Allow them in Chrome’s site settings.');
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.me.vapidKey) }));
    await api('/api/push', { subscription: sub.toJSON() });
    S.me.push = true;
    render();
    snack('Notifications are on');
  } catch (e) {
    snack(`Couldn't turn on notifications: ${e.message}`);
  }
}

// ---------- live updates ----------

let events;
function connect() {
  if (events) events.close();
  events = new EventSource('/api/events');
  events.onmessage = (e) => {
    const data = JSON.parse(e.data);
    // SessionMax was updated on the PC: load the new app (drafts are kept in localStorage).
    if (S.version && data.version && data.version !== S.version) return location.reload();
    S.version = data.version;
    // Answered or picked up somewhere else (on the PC): its notification is old news.
    for (const c of data.chats) if (c.state === 'working') clearNotifications(c.id);
    S.chats = data.chats;
    S.loaded = true;
    S.permissionMode = data.permissionMode;
    const r = route();
    if (r.name === 'list') render();
    else if (r.name === 'chat' && S.chat) {
      const c = S.chats.find((x) => x.id === r.id);
      if (!c || c.rev !== S.chat.rev || JSON.stringify(c) !== JSON.stringify(S.chat.data?.chat)) loadChat(r.id);
    }
  };
  // EventSource reconnects by itself; a dropped pairing shows up as 401 on /api/me.
  events.onerror = () => {
    if (events.readyState === EventSource.CLOSED) setTimeout(start, 3000);
  };
}

// A chat that isn't on the list (just restored, or a reply finishing) has no live row to watch.
setInterval(() => {
  const r = route();
  if (r.name === 'chat' && S.chat && !S.chats.some((c) => c.id === r.id) && !document.hidden) loadChat(r.id);
}, 3000);

// While the app is on screen the phone is where the user is: the PC holds back nothing.
function here() {
  if (!document.hidden && S.me) api('/api/presence', {}).catch(() => {});
}
setInterval(here, 30000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.me) {
    here();
    connect();
    const r = route();
    if (r.name === 'chat') loadChat(r.id);
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => e.data?.open && go(`#chat/${e.data.open}`));
}

// Opened straight into a chat (a notification starts the app on /#chat/<id>): put the chat
// list under it, so the phone's back goes to the list instead of out of the app.
if (route().name === 'chat' && history.length === 1) {
  const chat = location.hash;
  history.replaceState(null, '', location.pathname);
  history.pushState(null, '', chat);
}

async function start() {
  try {
    const res = await fetch('/api/me');
    S.me = res.ok ? await res.json() : null;
  } catch {
    S.me = null;
  }
  render();
  if (S.me) connect();
}

start();
