// Line of sight. `segmentsCross` mirrors crates/hearth-core/src/geometry.rs
// (the server uses it to block movement through walls) — keep them in sync.

const EPS = 1e-9;
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Does the move p→q pass through the wall a–b? (Ending on a wall's line doesn't count.) */
export function segmentsCross(p, q, a, b) {
  const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS))
    && ((d3 >= -EPS && d4 <= EPS) || (d3 <= EPS && d4 >= -EPS));
}

/** Distance along ray o + t·d to segment a–b, or Infinity. */
function rayHit(o, d, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y;
  const denom = d.x * ey - d.y * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const t = ((a.x - o.x) * ey - (a.y - o.y) * ex) / denom;
  const u = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / denom;
  return t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 ? t : Infinity;
}

/**
 * What a wall does (mirrors `Wall` in crates/hearth-core/src/model.rs):
 * movement true/false, sight and sound 'block' | 'limited' | 'pass'.
 * 'limited' (terrain walls) only stops sight at the second such wall.
 */
export function wallRules(w) {
  const door = w.kind === 'door' || w.kind === 'secret_door';
  if (door && w.open) return { move: false, sight: 'pass', sound: 'pass' };
  switch (w.kind) {
    case 'terrain': return { move: true, sight: 'limited', sound: 'limited' };
    case 'invisible': return { move: true, sight: 'pass', sound: 'pass' };
    case 'ethereal': return { move: false, sight: 'block', sound: 'block' };
    case 'window': return { move: true, sight: 'pass', sound: 'block' };
    default: return { move: true, sight: 'block', sound: 'block' };
  }
}

/**
 * Everything visible from `origin`, as a polygon, given sight-affecting
 * segments (`{a, b, limited}`) and the scene's size. Casts a ray at every wall
 * end (and just either side of it). A ray stops at the first blocking wall or
 * the second limited (terrain) wall, whichever is nearer.
 */
export function visibilityPolygon(origin, segments, width, height) {
  const o = { x: Math.min(Math.max(origin.x, 0.5), width - 0.5), y: Math.min(Math.max(origin.y, 0.5), height - 0.5) };
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const segs = [
    ...segments,
    { a: corners[0], b: corners[1] }, { a: corners[1], b: corners[2] },
    { a: corners[2], b: corners[3] }, { a: corners[3], b: corners[0] },
  ];
  const angles = [];
  for (const s of segs) {
    for (const p of [s.a, s.b]) {
      const ang = Math.atan2(p.y - o.y, p.x - o.x);
      angles.push(ang - 1e-4, ang, ang + 1e-4);
    }
  }
  const hits = [];
  for (const ang of angles) {
    const d = { x: Math.cos(ang), y: Math.sin(ang) };
    let best = Infinity;
    let lim1 = Infinity, lim2 = Infinity; // two nearest terrain-wall hits
    for (const s of segs) {
      const t = rayHit(o, d, s.a, s.b);
      if (t === Infinity) continue;
      if (s.limited) {
        if (t < lim1) { lim2 = lim1; lim1 = t; } else if (t < lim2) lim2 = t;
      } else if (t < best) best = t;
    }
    best = Math.min(best, lim2);
    if (best < Infinity) hits.push({ ang, x: o.x + d.x * best, y: o.y + d.y * best });
  }
  hits.sort((p, q) => p.ang - q.ang);
  return hits;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Can a vision source (origin, polygon, radius) see this point? */
export function sees(src, pt) {
  const dx = pt.x - src.origin.x, dy = pt.y - src.origin.y;
  return dx * dx + dy * dy <= src.radius * src.radius && pointInPolygon(pt, src.poly);
}

// ------------------------------------------------------------------ fog bitmaps

export function bitsToBase64(bits) {
  let s = '';
  for (let i = 0; i < bits.length; i += 0x8000) s += String.fromCharCode(...bits.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBits(b64, length) {
  const out = new Uint8Array(length);
  try {
    const s = atob(b64);
    for (let i = 0; i < Math.min(s.length, length); i++) out[i] = s.charCodeAt(i);
  } catch { /* corrupt: start empty */ }
  return out;
}
