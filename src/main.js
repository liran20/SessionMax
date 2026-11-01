const { app, BrowserWindow, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { listSessions } = require('./sessions');
const { createRemote } = require('./remote');
const { broomCards, isBroomId, tagOf, openBroom } = require('./broom');

const POLL_MS = 1000;
// Window sizes include the 8px transparent margin the shadow lives in.
const PILL = { width: 330, height: 60 };
const PANEL = { width: 380, height: 520 };
// Claude desktop's own session ids, accepted by its claude://code/continue deep link.
const DESKTOP_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;

const statePath = () => path.join(app.getPath('userData'), 'state.json');
// pill: where the pill sits; panel: size of the opened list; closed: sessionId -> time the user closed that task.
// broomClosed: Broom stack -> time the user closed its card; broomSince: Broom's notes before it are old news.
let state = { pill: null, panel: { ...PANEL }, pinned: false, muted: false, closed: null, broomClosed: {}, broomSince: 0 };
let win;
let tray;
let trayKind = '';
let quitting = false;
let timer;
let lastPayload = '';
let lastSessions = [];
let remote; // the phone app's server (remote.js)
let phoneWin;

// 'pill' (small widget) or 'open' (full list).
let mode = 'pill';
let origin = { h: 'right', v: 'bottom' }; // where the panel unfolds from
let drag = null;
let programmaticUntil = 0;

const STARTUP_LINK = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'SessionMax.lnk');
const LAUNCHER = path.join(__dirname, '..', 'SessionMax.vbs');

// ---------- state ----------

function loadState() {
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) };
  } catch {}
  // Keys from earlier versions.
  delete state.acks;
  delete state.bounds;
  delete state.collapsed;
  if (!state.closed) {
    // Start with a clean board: everything already open counts as closed.
    state.closed = {};
    closeAll();
  }
  if (!state.broomSince) {
    state.broomSince = Date.now();
    saveState();
  }
}

let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
    } catch {}
  }, 300);
}

// ---------- sessions -> tasks ----------

// Closing means "I'm done with this task" — a session that is still running can't be done.
const isRunning = (s) => s.status === 'busy' || s.status === 'waiting';

function closeAll() {
  const now = Date.now();
  for (const s of listSessions()) if (!isRunning(s)) state.closed[s.sessionId] = now;
  for (const c of broomCards(state.broomClosed, state.broomSince)) state.broomClosed[tagOf(c.sessionId)] = now;
  saveState();
}

function closeBroomCard(id) {
  state.broomClosed[tagOf(id)] = Date.now();
  saveState();
}

// Every chat is a task: it stays on the board until the user closes it here.
// Running sessions always show; a closed one also comes back when the user sends it a new message.
// An old chat that was just reopened (its process started after its last message) counts as
// closed too: viewing it isn't working on it, so it only shows once it gets a new message.
function isOpen(s) {
  if (isRunning(s)) return true;
  const closedAt = state.closed[s.sessionId];
  if (closedAt && s.turnStartedAt <= closedAt) return false;
  const resumed = s.lastPrompt ? s.turnStartedAt < s.startedAt : !!s.lastText;
  return !resumed;
}

// idle|busy|waiting from Claude Code -> what the widget shows.
function classify(s) {
  if (s.status === 'waiting') return 'needs';
  if (s.status === 'busy') return 'working';
  return s.lastPrompt ? 'done' : 'new';
}

function tick() {
  const all = listSessions();
  const sessions = all.filter((s) => process.env.SESSIONMAX_DEMO || isOpen(s)).map((s) => ({ ...s, state: classify(s) }));
  sessions.push(...broomCards(state.broomClosed, state.broomSince));
  if (process.env.SESSIONMAX_DEMO && sessions.length > 2) {
    Object.assign(sessions[1], { state: 'needs', waitingFor: 'approve Bash' });
    Object.assign(sessions[2], { state: 'done', statusUpdatedAt: Date.now() - 42000 });
  }
  // Forget closed tasks whose Claude session has ended.
  const live = new Set(all.map((s) => s.sessionId));
  for (const id of Object.keys(state.closed)) {
    if (!live.has(id)) {
      delete state.closed[id];
      saveState();
    }
  }

  lastSessions = sessions;
  // Keyboard or mouse used since the last tick: the user is at the PC (the phone stays quiet).
  if (remote && powerMonitor.getSystemIdleTime() * 1000 < POLL_MS * 2) remote.pcActive();
  if (remote) remote.update(all);
  updateTray(sessions);
  wakeOnActivity(sessions);
  if (win && !win.isDestroyed()) {
    // Stay above the taskbar when the pill is parked on it.
    if (mode === 'pill' && win.isVisible()) win.moveTop();
    const payload = JSON.stringify({ sessions, muted: state.muted, pinned: state.pinned });
    if (payload !== lastPayload) {
      lastPayload = payload;
      win.webContents.send('sessions', JSON.parse(payload));
    }
  }
}

// ---------- coming back when hidden ----------

// If the widget was hidden with ×, any new activity (a new session, or a session changing
// state) brings the pill back.
let lastStates = null;
function wakeOnActivity(sessions) {
  const now = new Map(sessions.map((s) => [s.sessionId, s.state]));
  const changed = lastStates && sessions.some((s) => lastStates.get(s.sessionId) !== s.state);
  lastStates = now;
  if (changed && win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
}

// ---------- pill <-> panel <-> mini tab ----------

const SNAP_MARGIN = 12;

function workAreaAt(point) {
  return screen.getDisplayNearestPoint(point).workArea;
}

// The eight places the pill can rest: corners and edge middles (no dead centre).
function snapPoints(wa) {
  const xs = {
    left: wa.x + SNAP_MARGIN,
    center: wa.x + Math.round((wa.width - PILL.width) / 2),
    right: wa.x + wa.width - PILL.width - SNAP_MARGIN,
  };
  const ys = {
    top: wa.y + SNAP_MARGIN,
    middle: wa.y + Math.round((wa.height - PILL.height) / 2),
    bottom: wa.y + wa.height - PILL.height - SNAP_MARGIN,
  };
  const out = [];
  for (const [h, x] of Object.entries(xs)) {
    for (const [v, y] of Object.entries(ys)) {
      if (h !== 'center' || v !== 'middle') out.push({ x, y, h, v });
    }
  }
  return out;
}

function nearestSnap(p) {
  const c = { x: p.x + PILL.width / 2, y: p.y + PILL.height / 2 };
  let best;
  for (const s of snapPoints(workAreaAt(c))) {
    const d = (s.x + PILL.width / 2 - c.x) ** 2 + (s.y + PILL.height / 2 - c.y) ** 2;
    if (!best || d < best.d) best = { x: s.x, y: s.y, h: s.h, v: s.v, d };
  }
  delete best.d;
  return best;
}

function defaultPill() {
  return snapPoints(screen.getPrimaryDisplay().workArea).find((p) => p.h === 'right' && p.v === 'bottom');
}

function pillOnScreen(p) {
  return (
    p &&
    p.h &&
    screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return p.x >= b.x - 20 && p.y >= b.y - 20 && p.x + PILL.width <= b.x + b.width + 20 && p.y + PILL.height <= b.y + b.height + 20;
    })
  );
}

function pillBounds() {
  return { x: state.pill.x, y: state.pill.y, ...PILL };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

// The panel unfolds from the pill: from its corner, or centred on it at an edge middle.
function panelBounds() {
  const p = pillBounds();
  const wa = workAreaAt({ x: p.x + p.width / 2, y: p.y + p.height / 2 });
  origin = { h: state.pill.h, v: state.pill.v };
  const width = Math.min(state.panel.width, wa.width);
  const height = Math.min(state.panel.height, wa.height);
  const x = origin.h === 'right' ? p.x + p.width - width : origin.h === 'center' ? p.x + (p.width - width) / 2 : p.x;
  const y = origin.v === 'bottom' ? p.y + p.height - height : origin.v === 'middle' ? p.y + (p.height - height) / 2 : p.y;
  return {
    x: Math.round(clamp(x, wa.x, wa.x + wa.width - width)),
    y: Math.round(clamp(y, wa.y, wa.y + wa.height - height)),
    width,
    height,
  };
}

let anim;
function setBounds(b, animate = false) {
  clearInterval(anim);
  programmaticUntil = Date.now() + 500;
  if (!animate) return win.setBounds(b);
  // Short glide used for snapping; 'suck' accelerates into place like it's being pulled.
  const from = win.getBounds();
  const t0 = Date.now();
  const DUR = animate === 'suck' ? 230 : 170;
  anim = setInterval(() => {
    const t = Math.min(1, (Date.now() - t0) / DUR);
    const e = animate === 'suck' ? t * t * t : 1 - (1 - t) ** 3;
    win.setBounds({
      x: Math.round(from.x + (b.x - from.x) * e),
      y: Math.round(from.y + (b.y - from.y) * e),
      width: Math.round(from.width + (b.width - from.width) * e),
      height: Math.round(from.height + (b.height - from.height) * e),
    });
    if (t === 1) clearInterval(anim);
  }, 12);
}

function sendMode() {
  win.webContents.send('mode', { mode, origin, pinned: state.pinned });
}

function expand() {
  if (mode === 'open') return;
  mode = 'open';
  win.setResizable(true);
  setBounds(panelBounds());
  sendMode();
  win.focus(); // so a click anywhere else folds it back (blur)
}

function collapse() {
  if (mode !== 'open') return;
  mode = 'pill';
  win.setResizable(false);
  setBounds(pillBounds());
  sendMode();
}

function showWidget() {
  if (!win.isVisible()) win.showInactive();
}

function createWindow() {
  if (!pillOnScreen(state.pill)) state.pill = defaultPill();
  delete state.minimized; // from the removed minimized tab
  mode = 'pill';
  win = new BrowserWindow({
    ...pillBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'SessionMax',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMinimumSize(PILL.width, PILL.height);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Resizing the open panel remembers its size.
  win.on('resized', () => {
    if (mode !== 'open' || Date.now() < programmaticUntil) return;
    const b = win.getBounds();
    state.panel = { width: b.width, height: b.height };
    saveState();
  });
  // Click anywhere else and the list folds back into the pill (unless pinned).
  win.on('blur', () => {
    if (mode === 'open' && !state.pinned) collapse();
  });
  // Closing hides to the tray; Quit lives in the tray menu.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('did-finish-load', () => {
    lastPayload = '';
    tick();
    sendMode();
    if (process.env.SESSIONMAX_SNAPSHOT) {
      // Dev aid: SESSIONMAX_SNAPSHOT=<file.png> [SESSIONMAX_OPEN=1] captures the window, then quits.
      if (process.env.SESSIONMAX_OPEN) expand();
      win.showInactive();
      // SESSIONMAX_OVERLAY=snap|pull|tray|move captures the drag guide (and the pill) mid-drag instead.
      const fake = process.env.SESSIONMAX_OVERLAY;
      if (fake) {
        setTimeout(() => {
          const wa = screen.getPrimaryDisplay().workArea;
          const b = { x: wa.x + wa.width / 2 - 230, y: fake === 'tray' ? wa.y + wa.height - 6 : wa.y + (fake === 'pull' ? 230 : 90), ...PILL };
          const t = dragTarget(b);
          showOverlay(t, b);
          sendDrag({ dragging: true, pull: pullOf(t, b) });
        }, 800);
        // 'move' retargets just before the capture to show the mist in motion.
        if (fake === 'move') {
          setTimeout(() => {
            const wa = screen.getPrimaryDisplay().workArea;
            const b = { x: wa.x + wa.width - 320, y: wa.y + wa.height / 2, ...PILL };
            showOverlay(dragTarget(b), b);
          }, 2150);
        }
      }
      setTimeout(async () => {
        if (fake) {
          fs.writeFileSync(process.env.SESSIONMAX_SNAPSHOT.replace('.png', '-overlay.png'), (await overlay.webContents.capturePage()).toPNG());
        }
        fs.writeFileSync(process.env.SESSIONMAX_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, 2500);
      return;
    }
    win.showInactive();
  });
}

// ---------- dragging: snap to the nearest spot ----------

// A click-through, full-screen overlay that shows where the pill can land while dragging.
let overlay;
let overlayKey = '';

function createOverlay() {
  overlay = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
}

// Where the tray icon is (or the bottom-right corner if Windows tucked it into the overflow).
function trayPoint(display) {
  const d = display.bounds;
  const tb = tray && tray.getBounds();
  if (tb && tb.width && tb.x >= d.x && tb.x < d.x + d.width && tb.y >= d.y && tb.y < d.y + d.height) {
    return { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
  }
  return { x: d.x + d.width - 90, y: d.y + d.height - 20 };
}

// Dropping the pill with its middle on the taskbar (or the very bottom strip) sends it to the tray.
function dragTarget(b) {
  const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const display = screen.getDisplayNearestPoint(center);
  const wa = display.workArea;
  const zoneTop = Math.min(wa.y + wa.height, display.bounds.y + display.bounds.height - 48);
  const toTray = center.y > zoneTop;
  return { display, snap: nearestSnap(b), toTray, trayAt: toTray ? trayPoint(display) : null };
}

// Sent on every drag move: where the pill is now and the spot that's pulling it in.
// Rects are the visible pill (inside its 8px shadow margin), relative to the display.
function showOverlay(t, b) {
  if (!overlay || overlay.isDestroyed()) return;
  const d = t.display.bounds;
  const key = JSON.stringify(d);
  if (key !== overlayKey) {
    overlayKey = key;
    overlay.setBounds(d);
    overlay.showInactive();
    win.moveTop(); // keep the pill above its own overlay
  }
  const visible = (r) => ({ x: r.x + 8 - d.x, y: r.y + 8 - d.y, width: PILL.width - 16, height: PILL.height - 16 });
  // Heading for the tray: the "slot" is a tiny vortex at the tray icon.
  const target = t.toTray ? { x: t.trayAt.x - 18 - d.x, y: t.trayAt.y - 9 - d.y, width: 36, height: 18 } : visible(t.snap);
  const data = { target, pill: visible(b) };
  overlay.webContents.executeJavaScript(`window.update && window.update(${JSON.stringify(data)})`).catch(() => {});
}

// The pill leans a few pixels toward the spot pulling it — harder the closer it gets.
function pullOf(t, b) {
  const goal = t.toTray ? { x: t.trayAt.x - PILL.width / 2, y: t.trayAt.y - PILL.height / 2 } : t.snap;
  const dx = goal.x - b.x;
  const dy = goal.y - b.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x: 0, y: 0 };
  const strength = 5 * Math.max(0, 1 - dist / 700) ** 0.6;
  return { x: (dx / dist) * strength, y: (dy / dist) * strength };
}

function hideOverlay() {
  if (!overlayKey || !overlay || overlay.isDestroyed()) return;
  overlayKey = '';
  overlay.webContents
    .executeJavaScript('window.fadeOut && window.fadeOut()')
    .catch(() => {})
    .finally(() => setTimeout(() => !overlayKey && overlay.hide(), 900));
}

function sendDrag(info) {
  win.webContents.send('drag', info);
}

ipcMain.on('pill-drag-start', () => {
  if (mode === 'open') return;
  clearInterval(anim);
  const b = win.getBounds();
  drag = { cursor: screen.getCursorScreenPoint(), start: { x: b.x, y: b.y }, moved: false };
});

ipcMain.on('pill-drag-move', () => {
  if (!drag) return;
  const c = screen.getCursorScreenPoint();
  if (!drag.moved && Math.abs(c.x - drag.cursor.x) + Math.abs(c.y - drag.cursor.y) < 5) return;
  if (!drag.moved) sendDrag({ dragging: true });
  drag.moved = true;
  const d = screen.getDisplayNearestPoint(c).bounds;
  const b = {
    x: clamp(drag.start.x + c.x - drag.cursor.x, d.x - 8, d.x + d.width - PILL.width + 8),
    y: clamp(drag.start.y + c.y - drag.cursor.y, d.y - 8, d.y + d.height - PILL.height + 8),
    ...PILL,
  };
  setBounds(b);
  const t = dragTarget(b);
  showOverlay(t, b);
  sendDrag({ dragging: true, pull: pullOf(t, b), toTray: t.toTray });
});

ipcMain.on('pill-drag-end', () => {
  if (!drag) return;
  const { moved } = drag;
  drag = null;
  if (!moved) return pillClick();
  hideOverlay();
  sendDrag({ dragging: false });
  const t = dragTarget(win.getBounds());
  if (t.toTray) return suckIntoTray(t.trayAt);
  state.pill = t.snap;
  saveState();
  // Pulled in: starts slow and accelerates into the slot.
  setBounds(pillBounds(), 'suck');
  setTimeout(() => sendDrag({ dragging: false, settled: true }), 230);
});

// Clicking the pill opens the session that's waiting on you; with nothing waiting, it opens the list.
function pillClick() {
  const rank = { needs: 0, done: 1 };
  const top = lastSessions
    .filter((s) => s.state in rank)
    .sort((a, b) => rank[a.state] - rank[b.state] || b.statusUpdatedAt - a.statusUpdatedAt)[0];
  if (top) openSession(top.hostSessionId);
  else expand();
}

ipcMain.on('expand', () => expand());

// Pulled into the tray: accelerate toward the icon while fading, then hide. The pill keeps its
// spot, so the tray icon brings it back where it was.
function suckIntoTray(at) {
  clearInterval(anim);
  const from = win.getBounds();
  const to = { x: Math.round(at.x - PILL.width / 2), y: Math.round(at.y - PILL.height / 2) };
  const t0 = Date.now();
  const DUR = 260;
  programmaticUntil = Date.now() + DUR + 200;
  anim = setInterval(() => {
    const t = Math.min(1, (Date.now() - t0) / DUR);
    const e = t * t * t;
    win.setBounds({ x: Math.round(from.x + (to.x - from.x) * e), y: Math.round(from.y + (to.y - from.y) * e), ...PILL });
    win.setOpacity(1 - e);
    if (t === 1) {
      clearInterval(anim);
      win.hide();
      win.setBounds(pillBounds());
      win.setOpacity(1);
      sendDrag({ dragging: false });
    }
  }, 12);
}

// The minimize button folds the list back into the pill.
ipcMain.on('minimize', () => collapse());

// ---------- tray ----------

// Tray icon drawn in code: Claude-orange rounded square, with a status dot when something needs you.
const DOT = { needs: [32, 176, 255], done: [132, 220, 61], working: [255, 168, 106] }; // BGR
function trayIcon(kind) {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const inRounded = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      let c = null;
      if (inRounded(px, py, 3, 3, 29, 29, 7)) c = [87, 119, 217]; // #d97757 as BGR
      const dot = DOT[kind];
      if (dot) {
        const d = (px - 24) ** 2 + (py - 24) ** 2;
        if (d <= 9 * 9) c = d <= 6.5 * 6.5 ? dot : [24, 20, 18];
      }
      if (c) {
        buf[i] = c[0];
        buf[i + 1] = c[1];
        buf[i + 2] = c[2];
        buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// The phone app's icon (logo "A, Aurora bubble"): the app's violet→pink gradient, a white chat
// bubble, and dots in the three status colors (working, ready, needs you). Full bleed, with the
// bubble inside the middle 80% so Android's round mask never cuts it. 4×4 samples per pixel.
function appIconPng(size) {
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const stops = [[0, [124, 58, 237]], [0.55, [192, 38, 211]], [1, [236, 72, 153]]];
  const bg = (t) => {
    const k = t < stops[1][0] ? 0 : 1;
    return lerp(stops[k][1], stops[k + 1][1], (t - stops[k][0]) / (stops[k + 1][0] - stops[k][0]));
  };
  const inRounded = (x, y, x0, y0, x1, y1, r) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const dots = [[36, [34, 211, 238]], [50, [52, 211, 153]], [64, [245, 158, 11]]];
  // Colour at a point of the 100×100 design.
  const at = (u, v) => {
    let c = bg(Math.min(1, Math.max(0, (u + v) / 200)));
    if ((u - 18) ** 2 + (v - 12) ** 2 <= 1600) c = lerp(c, [255, 255, 255], 0.1);
    const x = 50 + (u - 50) / 0.88; // the bubble a little smaller than the design, for the mask
    const y = 50 + (v - 50) / 0.88;
    const bubble = inRounded(x, y, 16, 26, 84, 70, 10) || (x >= 32 && x <= 46 && y >= 69 && y <= 81 && y - 70 <= (46 - x) * (11 / 14));
    if (!bubble) return c;
    for (const [dx, col] of dots) if ((x - dx) ** 2 + (y - 48) ** 2 <= 36) return col;
    return [255, 255, 255];
  };
  const buf = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = [0, 0, 0];
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = at(((x + (sx + 0.5) / N) / size) * 100, ((y + (sy + 0.5) / N) / size) * 100);
          sum = sum.map((v, i) => v + c[i]);
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(sum[2] / (N * N)); // BGRA
      buf[i + 1] = Math.round(sum[1] / (N * N));
      buf[i + 2] = Math.round(sum[0] / (N * N));
      buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG();
}

// Tray → Phone…: a QR code that pairs a phone, and the phones already paired.
async function showPhoneWindow() {
  const info = await remote.pairInfo();
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const phones = info.phones.length
    ? info.phones.map((p) => `<li>${esc(p.name)} · paired ${new Date(p.pairedAt).toLocaleDateString()}${p.push ? ' · notifications on' : ''}</li>`).join('')
    : '<li>None yet</li>';
  const html = `<!doctype html><meta charset="utf-8"><title>SessionMax on your phone</title>
<style>body{margin:0;padding:24px;font:14px 'Segoe UI',system-ui;background:#111216;color:#f2f3f5}h1{font-size:18px;margin:0 0 6px}
p{color:#9a9ca5;margin:6px 0 14px;line-height:1.45}img{display:block;background:#fff;border-radius:12px;padding:8px;margin:0 auto 14px}
code{display:block;background:#1d1f25;padding:8px 10px;border-radius:8px;user-select:all;font-size:12px;word-break:break-all;color:#f0a46e}
ul{padding-left:18px;color:#d4d5da}small{color:#6b6d76}</style>
<h1>Open SessionMax on your phone</h1>
${info.host
    ? `<p>Scan with the phone's camera (Tailscale must be on there too, same account). The code works once, for 10 minutes.</p><img src="${info.qr}" width="260" height="260"><small>${esc(info.url.split('/pair')[0])}</small>`
    : '<p>SessionMax\'s Tailscale connection ("sessionmax") isn\'t running yet. Wait a few seconds and open this window again.</p>'}
<p style="margin-top:16px">Paired phones:</p><ul>${phones}</ul>`;
  if (phoneWin && !phoneWin.isDestroyed()) phoneWin.close();
  phoneWin = new BrowserWindow({ width: 420, height: 640, title: 'SessionMax on your phone', backgroundColor: '#111216', autoHideMenuBar: true });
  phoneWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function startsWithWindows() {
  return fs.existsSync(STARTUP_LINK);
}

function setStartWithWindows(on) {
  if (on) {
    shell.writeShortcutLink(STARTUP_LINK, 'create', {
      target: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe'),
      args: `"${LAUNCHER}"`,
      cwd: path.dirname(LAUNCHER),
      description: 'SessionMax - Claude Code session board',
    });
  } else if (startsWithWindows()) {
    fs.unlinkSync(STARTUP_LINK);
  }
}

// Tray click works like the volume flyout: opens the list, a click elsewhere folds it.
function toggleFromTray() {
  if (!win.isVisible()) return win.showInactive();
  if (mode === 'open') return collapse();
  expand();
}

function createTray() {
  tray = new Tray(trayIcon(''));
  tray.setToolTip('SessionMax');
  tray.on('click', toggleFromTray);
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open list', click: () => (win.isVisible() && mode === 'open' ? win.focus() : toggleFromTray()) },
      win.isVisible()
        ? { label: 'Hide widget', click: () => win.hide() }
        : { label: 'Show widget', click: () => win.showInactive() },
      {
        label: 'Reset widget position',
        click: () => {
          collapse();
          state.pill = defaultPill();
          setBounds(pillBounds(), true);
          saveState();
          showWidget();
        },
      },
      { type: 'separator' },
      { label: 'Phone…', click: () => showPhoneWindow() },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: startsWithWindows(),
        click: (item) => setStartWithWindows(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

function updateTray(sessions) {
  if (!tray) return;
  const count = (k) => sessions.filter((s) => s.state === k).length;
  const kind = count('needs') ? 'needs' : count('done') ? 'done' : count('working') ? 'working' : '';
  if (kind !== trayKind) {
    trayKind = kind;
    tray.setImage(trayIcon(kind));
  }
  const parts = [
    count('needs') && `${count('needs')} need you`,
    count('done') && `${count('done')} your turn`,
    count('working') && `${count('working')} working`,
  ].filter(Boolean);
  tray.setToolTip(`SessionMax — ${parts.length ? parts.join(', ') : 'all clear'}`);
}

// ---------- actions from the window ----------

ipcMain.on('close-task', (_e, sessionId) => {
  if (isBroomId(sessionId)) {
    closeBroomCard(sessionId);
    return tick();
  }
  const s = listSessions().find((x) => x.sessionId === sessionId);
  if (!s || isRunning(s)) return tick();
  state.closed[sessionId] = Date.now();
  saveState();
  tick();
});

ipcMain.on('close-all', () => {
  closeAll();
  tick();
});

// Open that exact session in the Claude desktop app.
function openSession(hostSessionId) {
  // A Broom card: open Broom app; the card has done its job.
  if (isBroomId(hostSessionId)) {
    openBroom();
    closeBroomCard(hostSessionId);
    tick();
    if (!state.pinned) collapse();
    return;
  }
  if (DESKTOP_SESSION_ID.test(hostSessionId || '')) {
    shell.openExternal(`claude://code/continue?session=${hostSessionId}`);
  }
  focusClaude();
  if (!state.pinned) collapse();
}

ipcMain.on('open-session', (_e, hostSessionId) => openSession(hostSessionId));

ipcMain.on('set-muted', (_e, muted) => {
  state.muted = !!muted;
  saveState();
  tick();
});

ipcMain.on('set-pinned', (_e, pinned) => {
  state.pinned = !!pinned;
  saveState();
  sendMode();
  tick();
});

// Bring the Claude desktop app to the front so the user can answer.
function focusClaude() {
  const ps =
    "$p = Get-Process -Name 'Claude' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;" +
    "if ($p) { Add-Type -Namespace W -Name U -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);';" +
    ' if ([W.U]::IsIconic($p.MainWindowHandle)) { [W.U]::ShowWindow($p.MainWindowHandle, 9) | Out-Null }; [W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }';
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, () => {});
}

ipcMain.on('hide-panel', () => collapse());

ipcMain.on('hide', () => {
  collapse();
  win.hide();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win.isVisible()) win.showInactive();
  });
  app.on('before-quit', () => (quitting = true));
  app.whenReady().then(() => {
    // Lets scripts/ensure-running.js (run from Claude Code hooks) see that we're already up.
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'sessionmax.pid'), String(process.pid));
    } catch {}
    loadState();
    remote = createRemote({ state, saveState, iconPng: appIconPng });
    // Anything done in the widget means the user is at the PC; a locked or sleeping PC means not.
    for (const ch of ['expand', 'minimize', 'close-task', 'close-all', 'open-session', 'set-muted', 'set-pinned', 'pill-drag-start', 'hide', 'hide-panel']) {
      ipcMain.on(ch, () => remote.pcActive());
    }
    powerMonitor.on('lock-screen', () => remote.pcAway());
    powerMonitor.on('suspend', () => remote.pcAway());
    // Dev aid: SESSIONMAX_PAIR=1 prints a pairing link, for testing the phone app in a browser.
    if (process.env.SESSIONMAX_PAIR) remote.pairInfo().then((i) => console.log('PAIR ' + i.url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${remote.port}`)));
    createWindow();
    createOverlay();
    createTray();
    timer = setInterval(tick, POLL_MS);
    // A monitor unplugged (or rescaled) can leave the pill off-screen or mis-sized: bring it home.
    const rehome = () => {
      if (!pillOnScreen(state.pill)) {
        state.pill = defaultPill();
        saveState();
      }
      setBounds(mode === 'open' ? panelBounds() : pillBounds());
    };
    screen.on('display-removed', rehome);
    screen.on('display-added', rehome);
    screen.on('display-metrics-changed', rehome);
  });
  app.on('window-all-closed', () => {
    clearInterval(timer);
    app.quit();
  });
}
