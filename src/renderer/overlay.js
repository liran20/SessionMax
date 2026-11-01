// Drag guide: a faint, living mist that wants to pull the pill in.
// main calls update({ target, pill }) on every drag move and fadeOut() on drop.
// Rects are the visible pill shape, relative to this display.
//
// - At the snap target, mist gathers along the pill's outline: a glowing slot waiting for it.
//   When the target changes, the old slot dissolves and a new one condenses (ease-in-out);
//   the mist never travels between spots.
// - From the dragged pill's edges, particles peel off and stream along curving paths into
//   the slot, accelerating as they're drawn in. The closer the pill, the stronger the pull.

const canvas = document.getElementById('mist');
const ctx = canvas.getContext('2d');
const SCALE = 0.5; // render resolution; the mist is soft anyway
const INTENSITY = 0.6; // kept low on purpose: felt more than seen
const APPEAR_MS = 260;
const VANISH_MS = 220;

let W = 0;
let H = 0;
function resize() {
  W = Math.ceil(innerWidth * SCALE);
  H = Math.ceil(innerHeight * SCALE);
  canvas.width = W;
  canvas.height = H;
}
resize();
addEventListener('resize', resize);

// Pre-rendered soft sprites (gaussian-like falloff), one per tint.
function sprite([r, g, b]) {
  const s = 128;
  const c = Object.assign(document.createElement('canvas'), { width: s, height: s });
  const x = c.getContext('2d');
  const grad = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [stop, a] of [[0, 1], [0.2, 0.72], [0.42, 0.36], [0.65, 0.12], [0.85, 0.03], [1, 0]]) {
    grad.addColorStop(stop, `rgba(${r},${g},${b},${a})`);
  }
  x.fillStyle = grad;
  x.fillRect(0, 0, s, s);
  return c;
}
const SPRITES = [sprite([255, 255, 255]), sprite([214, 204, 255]), sprite([196, 230, 255])];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const tintOf = () => (Math.random() < 0.7 ? 0 : Math.random() < 0.5 ? 1 : 2);

// Smooth pseudo-noise from layered sines: cheap, continuous, never visibly repeating.
function flow(x, y, t) {
  return [
    Math.sin(x * 1.7 + t * 0.31) + Math.sin(y * 2.3 - t * 0.23) * 0.6 + Math.sin((x + y) * 3.1 + t * 0.41) * 0.3,
    Math.cos(y * 1.9 - t * 0.27) + Math.cos(x * 2.1 + t * 0.19) * 0.6 + Math.cos((x - y) * 2.9 - t * 0.37) * 0.3,
  ];
}

// A point on the outline of a pill shape (stadium), s in [0,1), with its outward normal.
function edgePoint(r, s) {
  const rad = r.height / 2;
  const straight = Math.max(0, r.width - 2 * rad);
  const arc = Math.PI * rad;
  const total = 2 * straight + 2 * arc;
  let d = (((s % 1) + 1) % 1) * total;
  const cxL = r.x + rad;
  const cxR = r.x + r.width - rad;
  const cy = r.y + rad;
  if (d < straight) return { x: cxL + d, y: r.y, nx: 0, ny: -1 };
  d -= straight;
  if (d < arc) {
    const a = -Math.PI / 2 + d / rad;
    return { x: cxR + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, nx: Math.cos(a), ny: Math.sin(a) };
  }
  d -= arc;
  if (d < straight) return { x: cxR - d, y: r.y + r.height, nx: 0, ny: 1 };
  d -= straight;
  const a = Math.PI / 2 + d / rad;
  return { x: cxL + Math.cos(a) * rad, y: cy + Math.sin(a) * rad, nx: Math.cos(a), ny: Math.sin(a) };
}

// ---------- the slot: mist hugging the target's outline ----------

function makeSlot(rect) {
  return {
    rect,
    born: performance.now(),
    leaving: 0,
    leaveFrom: 1,
    leaveTo: 1.25,
    motes: Array.from({ length: 52 }, (_, i) => ({
      s: i / 52 + rand(-0.01, 0.01),
      drift: rand(-0.012, 0.012), // slow crawl around the outline
      off: rand(-10, 14), // across the edge: a little inside, a little outside
      size: rand(22, 54),
      alpha: rand(0.02, 0.045),
      ph: rand(0, 100),
      tint: tintOf(),
    })),
    dust: Array.from({ length: 18 }, () => ({
      s: Math.random(),
      drift: rand(-0.03, 0.03),
      off: rand(-6, 22),
      size: rand(0.5, 1.1),
      ph: rand(0, 100),
      tw: rand(1.2, 2.6),
    })),
  };
}

function slotPhase(c, now) {
  if (c.leaving) {
    const k = easeInOut(clamp01((now - c.leaving) / VANISH_MS));
    return { alpha: c.leaveFrom * (1 - k), spread: 1 + (c.leaveTo - 1) * k, done: k >= 1 };
  }
  const k = easeInOut(clamp01((now - c.born) / APPEAR_MS));
  return { alpha: k, spread: 1.4 - 0.4 * k, done: false }; // condenses onto the outline
}

function drawSlot(c, now, dt, glow) {
  const { alpha, spread, done } = slotPhase(c, now);
  if (done) return false;
  const r = c.rect;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  // A small slot (the tray vortex) packs the same mist into less room; keep it as faint.
  const density = 0.3 + 0.7 * clamp01(r.width / 200);
  const a = alpha * INTENSITY * density * (1 + glow * 0.6);
  for (const p of c.motes) {
    p.s += p.drift * dt;
    const e = edgePoint(r, p.s);
    const [fx, fy] = flow(p.s * 6, p.ph, t);
    const off = p.off + 5 * Math.sin(t * 0.9 + p.ph);
    // Spread scales the whole outline about its centre while forming/dissolving.
    const x = cx + (e.x + e.nx * off - cx) * spread + fx * 4;
    const y = cy + (e.y + e.ny * off - cy) * spread + fy * 3;
    const rad = p.size * (1 + 0.2 * Math.sin(t * 0.7 + p.ph)) * SCALE;
    ctx.globalAlpha = p.alpha * a;
    ctx.drawImage(SPRITES[p.tint], x * SCALE - rad, y * SCALE - rad, rad * 2, rad * 2);
  }
  for (const d of c.dust) {
    d.s += d.drift * dt;
    const e = edgePoint(r, d.s);
    const x = cx + (e.x + e.nx * d.off - cx) * spread;
    const y = cy + (e.y + e.ny * d.off - cy) * spread;
    const tw = 0.5 + 0.5 * Math.sin(t * d.tw + d.ph);
    ctx.globalAlpha = (0.1 + 0.4 * tw * tw) * a;
    ctx.beginPath();
    ctx.arc(x * SCALE, y * SCALE, d.size * SCALE * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  return true;
}

// ---------- the stream: particles drawn off the pill into the slot ----------

let streamers = [];
let spawnDebt = 0;

function spawnStreamer(pill, target, pull) {
  const s = Math.random();
  const from = edgePoint(pill, s);
  // Land on the matching side of the slot, give or take, so the flow reads as one current.
  const to = edgePoint(target, s + rand(-0.08, 0.08));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Curl: bend each path sideways so the stream swirls like it's being sucked through a vortex.
  const bend = rand(-0.35, 0.35) * Math.min(dist, 500);
  const start = { x: from.x + from.nx * rand(0, 6), y: from.y + from.ny * rand(0, 6) };
  return {
    sx: start.x,
    sy: start.y,
    cx: (start.x + to.x) / 2 + (-dy / dist) * bend + from.nx * 30,
    cy: (start.y + to.y) / 2 + (dx / dist) * bend + from.ny * 30,
    tx: to.x,
    ty: to.y,
    age: 0,
    life: rand(0.45, 0.8) * (0.7 + 0.5 * (1 - pull)), // faster when the pull is strong
    size: rand(6, 16),
    alpha: rand(0.08, 0.16),
    tint: tintOf(),
    spark: Math.random() < 0.25,
  };
}

function drawStreamers(dt) {
  streamers = streamers.filter((p) => {
    p.age += dt;
    const u = p.age / p.life;
    if (u >= 1) return false;
    // Accelerating pull: lingers at the pill, then whips into the slot.
    const k = u * u * u;
    const i = 1 - k;
    const x = i * i * p.sx + 2 * i * k * p.cx + k * k * p.tx;
    const y = i * i * p.sy + 2 * i * k * p.cy + k * k * p.ty;
    const fade = Math.min(1, u / 0.15) * Math.min(1, (1 - u) / 0.2);
    const rad = p.size * (1 - 0.55 * k) * SCALE; // stretched thin as it's drawn in
    ctx.globalAlpha = p.alpha * fade * INTENSITY;
    if (p.spark) {
      ctx.beginPath();
      ctx.arc(x * SCALE, y * SCALE, 0.9, 0, Math.PI * 2);
      ctx.globalAlpha = 0.5 * fade * INTENSITY;
      ctx.fill();
    } else {
      ctx.drawImage(SPRITES[p.tint], x * SCALE - rad, y * SCALE - rad, rad * 2, rad * 2);
    }
    return true;
  });
}

// ---------- loop ----------

let slots = [];
let current = null;
let pill = null;
let streaming = false;
let running = false;
let last = 0;
let t = 0;

function pullStrength() {
  if (!pill || !current) return 0;
  const d = Math.hypot(
    pill.x + pill.width / 2 - (current.rect.x + current.rect.width / 2),
    pill.y + pill.height / 2 - (current.rect.y + current.rect.height / 2)
  );
  return clamp01(1 - d / 700) ** 0.7;
}

function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000 || 0.016);
  last = now;
  t += dt;

  const pull = pullStrength();
  if (streaming && pill && current && !current.leaving) {
    // 14/s when far, up to ~90/s when it's about to snap in.
    spawnDebt += dt * (14 + 76 * pull);
    while (spawnDebt >= 1) {
      streamers.push(spawnStreamer(pill, current.rect, pull));
      spawnDebt -= 1;
    }
  }

  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = '#fff';
  slots = slots.filter((c) => drawSlot(c, now, dt, c === current ? pull : 0));
  drawStreamers(dt);
  ctx.globalAlpha = 1;

  if (!slots.length && !streamers.length) {
    running = false;
    ctx.clearRect(0, 0, W, H);
    return;
  }
  requestAnimationFrame(frame);
}

function start() {
  if (running) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}

function dissolve(c, now, leaveTo) {
  if (!c || c.leaving) return;
  c.leaveFrom = slotPhase(c, now).alpha; // fade from wherever it had got to
  c.leaving = now;
  c.leaveTo = leaveTo;
}

const same = (a, b) => a && b && a.x === b.x && a.y === b.y;

window.update = ({ target, pill: p }) => {
  pill = p;
  streaming = true;
  if (!current || current.leaving || !same(current.rect, target)) {
    const now = performance.now();
    dissolve(current, now, 1.25);
    // Particles already in flight finish toward the old slot and fade with it.
    current = makeSlot(target);
    slots.push(current);
  }
  start();
};

// On drop: one last gulp of particles, then the slot closes around the pill and fades.
window.fadeOut = () => {
  streaming = false;
  if (pill && current) for (let i = 0; i < 24; i++) streamers.push(spawnStreamer(pill, current.rect, 1));
  const c = current;
  current = null;
  setTimeout(() => dissolve(c, performance.now(), 0.85), 200);
};
