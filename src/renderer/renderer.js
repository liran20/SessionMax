const api = window.sessionmax;
const $ = (id) => document.getElementById(id);

const ORDER = { needs: 0, done: 1, working: 2, new: 3 };
const LABEL = { needs: 'Needs you', done: 'Your turn', working: 'Working', new: 'New' };
const ICONS = {
  soundOn:
    '<svg viewBox="0 0 16 16"><path d="M3 6h2l3-3v10l-3-3H3z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/></svg>',
  soundOff: '<svg viewBox="0 0 16 16"><path d="M3 6h2l3-3v10l-3-3H3z"/><path d="M11 6l4 4M15 6l-4 4"/></svg>',
  pin: '<svg viewBox="0 0 16 16"><path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/></svg>',
  pinned: '<svg viewBox="0 0 16 16"><path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" fill="currentColor"/></svg>',
};

let data = { sessions: [], muted: false, pinned: false };
let prevStates = null; // sessionId -> state, null until first render
const fresh = new Map(); // sessionId -> time it entered needs/done

// ---------- sound ----------
let audio;
function chime(kind) {
  if (data.muted) return;
  audio = audio || new AudioContext();
  const notes = kind === 'needs' ? [880, 660, 880] : [660, 990];
  const t0 = audio.currentTime;
  notes.forEach((f, i) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t = t0 + i * 0.13;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.4);
  });
}

// ---------- helpers ----------
function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function timeText(s) {
  if (s.state === 'working') return `working ${ago(s.turnStartedAt || s.statusUpdatedAt)}`;
  if (s.state === 'needs') return `waiting ${ago(s.statusUpdatedAt)}`;
  if (s.state === 'done') return `finished ${ago(s.statusUpdatedAt)} ago`;
  return `opened ${ago(s.startedAt || s.statusUpdatedAt)} ago`;
}

function summaryFor(s) {
  if (s.state === 'needs') return { lead: s.waitingFor ? cap(s.waitingFor) : 'Waiting for you', text: s.activity };
  if (s.state === 'working') return { lead: '', text: s.activity || s.lastPrompt || 'Starting…' };
  if (s.state === 'new') return { lead: '', text: 'No messages yet' };
  return { lead: '', text: s.lastText || s.lastPrompt };
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

const cards = new Map(); // sessionId -> { card, name, pill, meta, summary, session, ...last values }

function setText(c, key, value, apply) {
  if (c[`_${key}`] === value) return;
  c[`_${key}`] = value;
  apply(value);
}

function makeCard(id) {
  const c = { card: el('div', 'card') };
  c.name = el('span', 'name');
  c.name.dir = 'auto';
  c.pill = el('span', 'pill');
  const x = el('button', 'x');
  x.title = 'Close task';
  x.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
  x.onclick = (e) => {
    e.stopPropagation();
    c.card.classList.add('leaving');
    setTimeout(() => api.closeTask(id), 180);
  };
  const head = el('div', 'head');
  head.append(c.name, c.pill, x);
  c.meta = el('div', 'meta');
  c.summary = el('div', 'summary');
  c.summary.dir = 'auto';
  c.card.append(el('span', 'dot'), head, c.meta, c.summary);
  c.card.onclick = () => api.openSession(c.session?.hostSessionId);
  cards.set(id, c);
  return c;
}

// ---------- render ----------
function render() {
  const sessions = [...data.sessions].sort(
    (a, b) => ORDER[a.state] - ORDER[b.state] || b.statusUpdatedAt - a.statusUpdatedAt
  );

  // Detect transitions into needs/done for sound + pop animation.
  if (prevStates) {
    let sound = null;
    for (const s of sessions) {
      const was = prevStates.get(s.sessionId);
      if ((s.state === 'needs' || s.state === 'done') && was !== s.state) {
        fresh.set(s.sessionId, Date.now());
        if (s.state === 'needs' || !sound) sound = s.state;
      }
    }
    if (sound) chime(sound);
  }
  prevStates = new Map(sessions.map((s) => [s.sessionId, s.state]));

  // Header counts
  const counts = { needs: 0, done: 0, working: 0, new: 0 };
  sessions.forEach((s) => counts[s.state]++);
  const countsEl = $('counts');
  countsEl.replaceChildren();
  for (const k of ['needs', 'done', 'working']) {
    if (!counts[k]) continue;
    const chip = el('span', `chip ${k}`);
    chip.append(el('i'), document.createTextNode(String(counts[k])));
    chip.title = `${counts[k]} ${LABEL[k].toLowerCase()}`;
    countsEl.append(chip);
  }
  if (!counts.needs && !counts.done && !counts.working && sessions.length) {
    countsEl.append(el('span', 'chip', 'All clear'));
  }

  $('shell').classList.toggle('attention', counts.needs > 0);
  $('mute').innerHTML = data.muted ? ICONS.soundOff : ICONS.soundOn;
  $('mute').title = data.muted ? 'Unmute' : 'Mute sound';
  $('pin').innerHTML = data.pinned ? ICONS.pinned : ICONS.pin;
  $('pin').title = data.pinned ? 'Unpin (fold back on mouse leave)' : 'Keep open';
  $('pin').classList.toggle('on', data.pinned);

  renderPill(sessions, counts);

  // List — cards are reused by sessionId so running animations don't restart every tick.
  const list = $('list');
  $('empty').hidden = sessions.length > 0;
  const live = new Set(sessions.map((s) => s.sessionId));
  for (const [id, c] of cards) {
    if (!live.has(id)) {
      c.card.remove();
      cards.delete(id);
    }
  }
  let prev = $('empty');
  for (const s of sessions) {
    const c = cards.get(s.sessionId) || makeCard(s.sessionId);
    c.session = s;
    const isFresh = fresh.has(s.sessionId) && Date.now() - fresh.get(s.sessionId) < 600;
    setText(c, 'cls', `card ${s.state}${isFresh ? ' fresh' : ''}`, (v) => (c.card.className = v));
    setText(c, 'title', s.broom ? 'Open in Broom' : `Open in Claude — ${s.cwd || ''}`, (v) => (c.card.title = v));
    setText(c, 'name', s.name, (v) => (c.name.textContent = v));
    setText(c, 'pill', LABEL[s.state], (v) => (c.pill.textContent = v));
    setText(c, 'meta', [s.project, timeText(s)].filter(Boolean).join(' · '), (v) => (c.meta.textContent = v));
    const sum = summaryFor(s);
    setText(c, 'sum', JSON.stringify(sum), () => {
      c.summary.replaceChildren();
      if (sum.lead) {
        c.summary.append(el('span', 'lead', sum.lead));
        if (sum.text) c.summary.append(document.createTextNode(' — '));
      }
      if (sum.text) c.summary.append(document.createTextNode(sum.text));
    });
    // Only move nodes whose position changed; re-inserting would restart their animations.
    if (prev.nextSibling !== c.card) prev.after(c.card);
    prev = c.card;
  }

  // Footer
  $('summaryLine').textContent = `${sessions.length} open task${sessions.length === 1 ? '' : 's'}`;
  $('closeAll').hidden = !sessions.some((s) => s.state === 'done' || s.state === 'new');
}

api.onSessions((d) => {
  data = d;
  render();
});

// Keep the relative times ticking between updates.
setInterval(() => render(), 1000);

$('hide').onclick = () => api.hide();
$('pin').onclick = () => api.setPinned(!data.pinned);
$('minimize').onclick = () => api.minimize();
// The pill's list button opens every session; it must not start a drag.
$('plist').addEventListener('pointerdown', (e) => e.stopPropagation());
$('plist').onclick = (e) => {
  e.stopPropagation();
  api.expand();
};

// Drag feedback: the pill lifts while dragged and gives a small bounce when it snaps into place.
api.onDrag(({ dragging, settled, pull, toTray }) => {
  document.body.classList.toggle('dragging', !!dragging);
  document.body.classList.toggle('to-tray', !!toTray);
  const p = $('pillbar');
  p.style.setProperty('--px', `${pull ? pull.x.toFixed(2) : 0}px`);
  p.style.setProperty('--py', `${pull ? pull.y.toFixed(2) : 0}px`);
  if (settled) {
    const p = $('pillbar');
    p.classList.remove('settle');
    void p.offsetWidth;
    p.classList.add('settle');
  }
});
$('mute').onclick = () => api.setMuted(!data.muted);
// Two-step so one stray click can't wipe the board.
let confirmTimer;
$('closeAll').onclick = () => {
  const b = $('closeAll');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.textContent = 'Click again to close all';
    confirmTimer = setTimeout(() => {
      b.classList.remove('confirm');
      b.textContent = 'Close all';
    }, 3000);
    return;
  }
  clearTimeout(confirmTimer);
  b.classList.remove('confirm');
  b.textContent = 'Close all';
  api.closeAll();
};
// ---------- pill ----------
function renderPill(sessions, counts) {
  const top = sessions[0];
  const kind = counts.needs ? 'needs' : counts.done ? 'done' : counts.working ? 'working' : 'clear';
  const pill = $('pillbar');
  if (pill.dataset.kind !== kind) {
    pill.dataset.kind = kind;
    pill.className = `pillbar ${kind}`;
  }
  let text = 'All clear';
  if (kind === 'needs') text = `Needs you · ${top.name}`;
  else if (kind === 'done') text = counts.done > 1 ? `${counts.done} waiting for you` : `Your turn · ${top.name}`;
  else if (kind === 'working') text = counts.working > 1 ? `${counts.working} working` : `Working · ${top.name}`;
  if ($('ptext').textContent !== text) $('ptext').textContent = text;
  pill.title =
    kind === 'needs' || kind === 'done'
      ? `Click to open “${top.name}” in ${top.broom ? 'Broom' : 'Claude'} · drag to move`
      : 'Click to see all sessions · drag to move';
  const pc = $('pcounts');
  pc.replaceChildren();
  for (const k of ['needs', 'done', 'working']) {
    if (!counts[k]) continue;
    const chip = el('span', `chip ${k}`);
    chip.append(el('i'), document.createTextNode(String(counts[k])));
    pc.append(chip);
  }
}

api.onMode(({ mode, origin, pinned }) => {
  const keep = ['dragging', 'to-tray'].filter((c) => document.body.classList.contains(c));
  document.body.className = `m-${mode} oh-${origin.h} ov-${origin.v} ${keep.join(' ')}`;
  data.pinned = pinned;
  if (mode === 'open') {
    // Replay the unfold animation each time it opens.
    const sh = $('shell');
    sh.classList.remove('unfold');
    void sh.offsetWidth;
    sh.classList.add('unfold');
  }
  render();
});

// The pill is dragged by hand: a click opens, a drag moves and snaps.
for (const handle of [$('pillbar')]) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    api.dragStart();
  });
  handle.addEventListener('pointermove', (e) => {
    if (handle.hasPointerCapture(e.pointerId)) api.dragMove();
  });
  handle.addEventListener('pointerup', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    handle.releasePointerCapture(e.pointerId);
    api.dragEnd();
  });
}

// Esc folds the open list back into the pill.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !data.pinned) api.hidePanel();
});
