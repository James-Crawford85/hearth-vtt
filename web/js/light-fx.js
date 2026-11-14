// Light looks: the editor for a light (radii, colour, animation) with a live preview, and the
// animations themselves, drawn by the board every frame while an animated light is in view.
//
// A light's look: { bright, dim, color, tint?, anim?: { kind, speed, strength } }, radii in the
// scene's distance units. `tint` (0–1, default 0.5) is how strongly its colour shows.

import { el, openWindow } from './ui.js';

/** The animations, in the order offered. `color`: what it glows when the light has no colour. */
export const ANIMATIONS = [
  { id: 'candle', label: 'Candle flicker', color: '#ffc46b' },
  { id: 'torch', label: 'Torch', color: '#ff9a3c' },
  { id: 'campfire', label: 'Campfire (with embers)', color: '#ff8a3a' },
  { id: 'pulse', label: 'Pulsing light', color: '#ffe6b0' },
  { id: 'swirl', label: 'Swirling energy', color: '#9fc4ff' },
  { id: 'smoke', label: 'Glowing smoke', color: '#b9f0c8' },
  { id: 'vortex', label: 'Vortex', color: '#c79bff' },
  { id: 'rays', label: 'Radiant rays', color: '#fff0b0' },
  { id: 'fairy', label: 'Fairy lights', color: '#fff6c8' },
  { id: 'chroma', label: 'Shifting colours', color: '#ff6b6b' },
  { id: 'storm', label: 'Lightning flashes', color: '#dfe8ff' },
  { id: 'ghost', label: 'Ghostly waver', color: '#cfe3ff' },
];
const ANIM = Object.fromEntries(ANIMATIONS.map((a) => [a.id, a]));
export const isAnimated = (l) => !!ANIM[l?.anim?.kind];

export const DEFAULT_TINT = 0.5;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ motion

/** Smooth wobble in −1…1 (a few sines, different for each seed). */
function wob(t, s) {
  return (Math.sin(t * 1.7 + s) + 0.6 * Math.sin(t * 2.9 + s * 1.3) + 0.3 * Math.sin(t * 5.3 + s * 2.1)) / 1.9;
}
/** A number in 0…1 that is the same for the same inputs. */
function rnd(a, b = 0) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
export function seedOf(id) {
  let h = 0;
  for (const c of String(id ?? '')) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (Math.abs(h) % 1000) / 10;
}

/**
 * How an animated light looks at time `t` (seconds): its radius (`r`) and brightness (`a`) as
 * multipliers, how far its centre moves (`dx`, `dy`, as a share of its radius), and a colour it
 * takes on (`rgb`), if any.
 */
export function animState(l, t) {
  const a = ANIM[l.anim?.kind];
  if (!a) return null;
  const speed = clamp(Number(l.anim.speed) || 1, 0.1, 5);
  const k = 2 * clamp(l.anim.strength ?? 0.5, 0, 1);
  const s = l.seed ?? 0;
  const T = t * speed;
  const out = { r: 1, a: 1, dx: 0, dy: 0, rgb: null };
  const dip = (v) => (v + 1) / 2; // −1…1 → 0…1
  switch (a.id) {
    case 'candle': out.r = 1 + 0.035 * k * wob(T * 9, s); out.a = 1 - 0.1 * k * dip(wob(T * 11, s + 4)); break;
    case 'torch': out.r = 1 + 0.06 * k * wob(T * 7, s); out.a = 1 - 0.16 * k * dip(wob(T * 8, s + 4)); break;
    case 'campfire':
      out.r = 1 + 0.08 * k * wob(T * 5, s); out.a = 1 - 0.2 * k * dip(wob(T * 6.5, s + 4));
      out.dx = 0.02 * k * wob(T * 4, s + 9); out.dy = 0.02 * k * wob(T * 4.4, s + 13);
      break;
    case 'pulse': { const p = Math.sin(T * Math.PI); out.r = 1 + 0.1 * k * p; out.a = 1 - 0.22 * k * dip(-p); break; }
    case 'smoke': out.r = 1 + 0.04 * k * wob(T * 1.2, s); out.a = 1 - 0.1 * k * dip(wob(T, s + 3)); break;
    case 'ghost': out.r = 1 + 0.08 * k * wob(T * 0.8, s); out.a = 1 - 0.3 * k * dip(wob(T * 0.9, s + 5)); break;
    case 'vortex': out.r = 1 + 0.03 * k * Math.sin(T * 2.5); break;
    case 'chroma': out.rgb = hslRgb(((T * 40 + s * 3.6) % 360 + 360) % 360, 0.85, 0.62); break;
    case 'storm': {
      // Dim, with a flash now and then.
      const slot = Math.floor(T * 1.5), f = T * 1.5 - slot;
      const flash = rnd(slot, s) < 0.3 ? Math.exp(-f * 7) * (0.6 + 0.4 * rnd(slot + 0.5, s)) : 0;
      out.a = clamp(1 - 0.45 * k + flash * 1.2, 0.15, 1);
      out.r = 1 + 0.06 * flash;
      break;
    }
    default: break;
  }
  return out;
}

/**
 * The parts of an animation drawn over what the light reaches (swirls, smoke, rays, embers…), on
 * a context already clipped to where the light reaches and set to blend as light. `l` has the
 * board's light fields: origin, dim (px), seed, anim; `alpha` how strongly to draw.
 */
export function drawAnimOverlay(ctx, l, t, rgb, alpha) {
  const a = ANIM[l.anim?.kind];
  if (!a || !(l.dim > 0) || alpha <= 0) return;
  const speed = clamp(Number(l.anim.speed) || 1, 0.1, 5);
  const k = clamp(l.anim.strength ?? 0.5, 0, 1);
  const s = l.seed ?? 0;
  const T = t * speed;
  const { x, y } = l.origin;
  const R = l.dim;
  const col = (al) => `rgba(${rgb}, ${clamp(al, 0, 1)})`;
  const glow = (cx, cy, r, al) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, col(al));
    g.addColorStop(1, col(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // A soft trail of light along a spiral from near the middle out towards the edge.
  const trail = (turn, twist, width, al) => {
    const n = 26;
    for (let i = 0; i < n; i++) {
      const f = i / n, r = R * (0.08 + 0.85 * f);
      const ang = turn + twist * f;
      glow(x + Math.cos(ang) * r, y + Math.sin(ang) * r, R * width * (0.35 + f), al * Math.pow(1 - f, 0.8));
    }
  };
  const fade = (al) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, R);
    g.addColorStop(0, col(al));
    g.addColorStop(0.6, col(al * 0.6));
    g.addColorStop(1, col(0));
    return g;
  };
  ctx.save();
  switch (a.id) {
    case 'campfire': {
      // Embers drifting out from the fire and fading.
      const n = Math.round(6 + 10 * k);
      for (let i = 0; i < n; i++) {
        const life = 1.6 + rnd(i, s) * 1.4;
        const age = ((T + rnd(i + 7, s) * life) % life) / life;
        const ang = rnd(i + 3, s) * Math.PI * 2 + wob(T * 0.7 + i, s) * 0.4;
        const r = R * (0.05 + 0.45 * age);
        glow(x + Math.cos(ang) * r, y + Math.sin(ang) * r, R * 0.035, alpha * 1.6 * (1 - age) * (0.5 + 0.5 * rnd(i + 11, s)));
      }
      break;
    }
    case 'swirl': {
      for (let i = 0; i < 3; i++) trail(T * 0.9 + (i * Math.PI * 2) / 3 + s, 2.4, 0.12 + 0.06 * k, alpha * (0.12 + 0.18 * k));
      glow(x, y, R * 0.3, alpha * 0.5);
      break;
    }
    case 'vortex': {
      // Arms wound tight, turning fast, and a bright eye.
      for (let i = 0; i < 5; i++) trail(-T * 1.8 + (i * Math.PI * 2) / 5 + s, -5, 0.07 + 0.04 * k, alpha * (0.12 + 0.18 * k));
      glow(x, y, R * (0.16 + 0.03 * Math.sin(T * 4)), alpha * 0.9);
      break;
    }
    case 'smoke':
    case 'ghost': {
      // Soft clouds of light drifting round and about.
      const n = a.id === 'smoke' ? 7 : 4;
      for (let i = 0; i < n; i++) {
        const dir = i % 2 ? 1 : -1;
        const ang = rnd(i, s) * Math.PI * 2 + dir * T * (0.12 + 0.1 * rnd(i + 1, s));
        const r = R * (0.2 + 0.45 * (wob(T * 0.25 + i * 2, s) + 1) / 2);
        const size = R * (0.3 + 0.25 * rnd(i + 2, s)) * (1 + 0.15 * wob(T * 0.4 + i, s + 1));
        glow(x + Math.cos(ang) * r, y + Math.sin(ang) * r, size, alpha * (a.id === 'smoke' ? 0.35 : 0.25) * (0.5 + k));
      }
      break;
    }
    case 'rays': {
      ctx.fillStyle = fade(alpha * (0.15 + 0.25 * k));
      const n = 12, w = 0.05 + 0.04 * k;
      for (let i = 0; i < n; i++) {
        const ang = T * 0.25 + (i * Math.PI * 2) / n + s;
        const len = R * (0.75 + 0.25 * (wob(T * 0.8 + i, s) + 1) / 2);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang - w) * len, y + Math.sin(ang - w) * len);
        ctx.lineTo(x + Math.cos(ang + w) * len, y + Math.sin(ang + w) * len);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'fairy': {
      // Little lights wandering slowly about, each twinkling in its own time.
      const n = Math.round(8 + 14 * k);
      for (let i = 0; i < n; i++) {
        const ang = rnd(i, s) * Math.PI * 2 + T * 0.15 * (rnd(i + 5, s) - 0.5);
        const r = R * (0.15 + 0.75 * Math.sqrt(rnd(i + 1, s))) + R * 0.04 * wob(T * 0.6 + i, s);
        const tw = Math.pow((Math.sin(T * (1.5 + 2 * rnd(i + 2, s)) + rnd(i + 3, s) * 6.28) + 1) / 2, 2);
        const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
        glow(px, py, R * 0.07, alpha * 0.9 * tw);
        glow(px, py, R * 0.018, alpha * 2 * tw);
      }
      break;
    }
    case 'pulse': {
      // A ring of light going out from the middle with each beat.
      const f = (T / 2) % 1;
      ctx.strokeStyle = col(alpha * (1 - f) * (0.4 + 0.6 * k));
      ctx.lineWidth = R * 0.06;
      ctx.beginPath();
      ctx.arc(x, y, R * f, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    default: break;
  }
  ctx.restore();
}

// ------------------------------------------------------------------ colours

export function hexRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
}
function hslRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `${f(0)}, ${f(8)}, ${f(4)}`;
}
/** The colour an animation glows in, for a light with or without a colour of its own. */
export const animColor = (l) => l.color || ANIM[l.anim?.kind]?.color || '#ffe6b0';

// ------------------------------------------------------------------ the editor

const MAX_RADIUS = 50;

/**
 * Edit a light's look in a window, showing each change on the map as it is made (`preview(look)`,
 * and `preview(null)` when it closes). Resolves to the new look, or null if closed without saving.
 * `coloured`: it always has a colour (a light source's colour is its glow); `on`: also offer
 * switching it on and off (the look gets `on`).
 */
export function lightDialog({ title = 'Light', look, units = 'ft', preview, coloured = false, on }) {
  return new Promise((resolve) => {
    const w = openWindow({ title, width: 380 });
    let done = false;
    const finish = (v) => { if (done) return; done = true; preview?.(null); resolve(v); w.close(); };
    w.onClose(() => { if (!done) { done = true; preview?.(null); resolve(null); } });

    const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const changed = () => preview?.(read());

    // A slider with a box beside it for numbers the slider doesn't reach.
    const slider = (label, value, { min = 0, max = MAX_RADIUS, step = 1, fmt } = {}) => {
      const range = el('input', { type: 'range', min, max, step, value: clamp(value, min, max) });
      const box = el('input', { type: 'number', min, step: 'any', value: round(value) });
      const out = fmt ? el('span.light-val', { text: fmt(value) }) : null;
      range.addEventListener('input', () => { box.value = range.value; if (out) out.textContent = fmt(Number(range.value)); changed(); });
      box.addEventListener('input', () => { const v = num(box.value); range.value = clamp(v, min, max); if (out) out.textContent = fmt(v); changed(); });
      const row = el('div.light-row', {}, el('span', { text: label }), range, out ?? box);
      return { row, get: () => Math.max(min, num(box.value)), set: (v) => { box.value = round(v); range.value = clamp(v, min, max); } };
    };
    const round = (v) => Math.round(num(v) * 100) / 100;
    const pct = (v) => `${Math.round(v * 100)}%`;

    const bright = slider(`Bright (${units})`, num(look.bright));
    const dim = slider(`Dim (${units})`, num(look.dim));
    const tinted = el('input', { type: 'checkbox', checked: coloured || !!look.color });
    const color = el('input', { type: 'color', value: look.color || '#ffb347' });
    color.addEventListener('input', () => { tinted.checked = true; changed(); });
    tinted.addEventListener('change', changed);
    const tint = slider('Colour strength', num(look.tint, DEFAULT_TINT), { max: 1, step: 0.05, fmt: pct });

    const kind = el('select', {},
      el('option', { value: '', text: 'None (steady light)' }),
      ...ANIMATIONS.map((a) => el('option', { value: a.id, text: a.label, selected: look.anim?.kind === a.id })));
    const speed = slider('Speed', num(look.anim?.speed, 1), { min: 0.1, max: 3, step: 0.1, fmt: (v) => `×${num(v).toFixed(1)}` });
    const strength = slider('Strength', num(look.anim?.strength, 0.5), { max: 1, step: 0.05, fmt: pct });
    const animRows = el('div.light-anim', {}, speed.row, strength.row);
    const showAnim = () => { animRows.hidden = !kind.value; };
    kind.addEventListener('change', () => { showAnim(); changed(); });
    showAnim();
    const onBox = on !== undefined ? el('input', { type: 'checkbox', checked: !!on }) : null;
    onBox?.addEventListener('change', changed);

    // Bright never goes past dim: moving one past the other takes it along.
    const keepOrder = (moved) => () => {
      const b = bright.get(), d = dim.get();
      if (b > d) (moved === 'bright' ? dim : bright).set(moved === 'bright' ? b : d);
    };
    bright.row.addEventListener('input', keepOrder('bright'));
    dim.row.addEventListener('input', keepOrder('dim'));

    function read() {
      const b = bright.get();
      const out = { bright: b, dim: Math.max(b, dim.get()), color: tinted.checked ? color.value : null };
      const t = clamp(tint.get(), 0, 1);
      if (t !== DEFAULT_TINT) out.tint = t;
      if (kind.value) out.anim = { kind: kind.value, speed: clamp(speed.get(), 0.1, 5), strength: clamp(strength.get(), 0, 1) };
      if (onBox) out.on = onBox.checked;
      return out;
    }

    w.body.append(el('div.form.light-form', {},
      bright.row, dim.row,
      el('div.light-row', {},
        coloured ? el('span', { text: 'Colour' }) : el('label.check', {}, tinted, ' Coloured'),
        color, el('span')),
      tint.row,
      el('label', {}, 'Animation', kind),
      animRows,
      onBox ? el('label.check', {}, onBox, ' On') : null,
      el('div.light-buttons', {},
        el('button.primary', { type: 'button', text: 'Save', on: { click: () => finish(read()) } }),
        el('button', { type: 'button', text: 'Cancel', on: { click: () => finish(null) } }))));
    changed();
  });
}
