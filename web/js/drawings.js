// Scene drawings: rectangles, ellipses, polygons, freehand lines and text.
//
// A drawing is { id, kind, author, x, y, w, h, points, stroke, stroke_width,
// fill, fill_alpha, text, font_size }, in scene pixels. Rectangles and
// ellipses use x/y/w/h; polygons and freehand lines use `points`, relative
// to x/y; text sits with its top-left corner at x/y.

import { pointInPolygon } from './vision.js';

const FONT = (size) => `${size}px system-ui, sans-serif`;
const measure = document.createElement('canvas').getContext('2d');

function lines(d) { return String(d.text ?? '').split('\n'); }

/** Width and height of a text drawing. */
function textSize(d) {
  measure.font = FONT(d.font_size || 32);
  const ls = lines(d);
  const w = Math.max(1, ...ls.map((l) => measure.measureText(l).width));
  return { w, h: ls.length * (d.font_size || 32) * 1.2 };
}

/** The drawing's bounding box in scene pixels. */
export function bounds(d) {
  if (d.kind === 'text') {
    const s = textSize(d);
    return { x: d.x, y: d.y, w: s.w, h: s.h };
  }
  if (d.kind === 'polygon' || d.kind === 'freehand') {
    const xs = d.points.map((p) => p[0]), ys = d.points.map((p) => p[1]);
    const x0 = Math.min(0, ...xs), y0 = Math.min(0, ...ys);
    return { x: d.x + x0, y: d.y + y0, w: Math.max(0, ...xs) - x0, h: Math.max(0, ...ys) - y0 };
  }
  return { x: d.x, y: d.y, w: d.w, h: d.h };
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function path(ctx, d) {
  ctx.beginPath();
  if (d.kind === 'rect') {
    ctx.rect(d.x, d.y, d.w, d.h);
  } else if (d.kind === 'ellipse') {
    ctx.ellipse(d.x + d.w / 2, d.y + d.h / 2, Math.abs(d.w / 2), Math.abs(d.h / 2), 0, 0, Math.PI * 2);
  } else {
    d.points.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, d.x + p[0], d.y + p[1]));
    if (d.kind === 'polygon') ctx.closePath();
  }
}

/** Draw one drawing. `dx`/`dy` shift it (while being dragged). */
export function drawDrawing(ctx, d, dx = 0, dy = 0) {
  ctx.save();
  ctx.translate(dx, dy);
  if (d.kind === 'text') {
    const size = d.font_size || 32;
    ctx.font = FONT(size);
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size / 8);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillStyle = d.stroke || '#ffffff';
    lines(d).forEach((l, i) => {
      ctx.strokeText(l, d.x, d.y + i * size * 1.2);
      ctx.fillText(l, d.x, d.y + i * size * 1.2);
    });
    ctx.restore();
    return;
  }
  path(ctx, d);
  if (d.fill && d.kind !== 'freehand') {
    ctx.fillStyle = hexToRgba(d.fill, d.fill_alpha ?? 0.2);
    ctx.fill();
  }
  if (d.stroke_width > 0) {
    ctx.strokeStyle = d.stroke || '#e0a040';
    ctx.lineWidth = d.stroke_width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

/** Dashed outline around a selected drawing. */
export function drawSelection(ctx, d, zoom, dx = 0, dy = 0) {
  const b = bounds(d);
  const pad = 6 / zoom;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5 / zoom;
  ctx.setLineDash([6 / zoom, 4 / zoom]);
  ctx.strokeRect(b.x + dx - pad, b.y + dy - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.restore();
}

function nearSegment(p, a, b, tol) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= tol;
}

/** Is scene point `p` on this drawing? `tol` is the click tolerance in scene pixels. */
export function hitDrawing(d, p, tol) {
  const t = tol + (d.stroke_width || 0) / 2;
  if (d.kind === 'polygon' || d.kind === 'freehand') {
    const pts = d.points.map((q) => ({ x: d.x + q[0], y: d.y + q[1] }));
    if (d.kind === 'polygon' && pts.length > 2 && pointInPolygon(p, pts)) return true;
    for (let i = 1; i < pts.length; i++) if (nearSegment(p, pts[i - 1], pts[i], t)) return true;
    if (d.kind === 'polygon' && pts.length > 2) return nearSegment(p, pts.at(-1), pts[0], t);
    return pts.length === 1 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= t;
  }
  if (d.kind === 'ellipse') {
    const rx = d.w / 2 + t, ry = d.h / 2 + t;
    const nx = (p.x - d.x - d.w / 2) / rx, ny = (p.y - d.y - d.h / 2) / ry;
    return nx * nx + ny * ny <= 1;
  }
  const b = bounds(d);
  return p.x >= b.x - t && p.x <= b.x + b.w + t && p.y >= b.y - t && p.y <= b.y + b.h + t;
}

/** Drop points closer than `min` to the previous one (for freehand lines). */
export function simplify(points, min) {
  const out = [];
  for (const p of points) {
    const q = out.at(-1);
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p);
  }
  return out;
}
