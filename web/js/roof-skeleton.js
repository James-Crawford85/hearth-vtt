// Hearth — roof shapes. A building's roof rectangles that touch or overlap (same level, same
// material) make one roof: their union is traced as an outline, and the outline's straight
// skeleton gives the roof's planes — one per wall edge, sloping up from it — and the lines
// where planes meet (ridges, hips over outside corners, valleys from inside corners).
//
// Pure geometry, no drawing: coordinates are in grid squares.

const NEAR = 1e-6;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const near = (a, b) => dist(a, b) < NEAR;

/** Group roof rectangles into buildings: ones that overlap or share a stretch of edge. */
export function groupRects(rects) {
  const parent = rects.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox >= 0 && oy >= 0 && (ox > 0 || oy > 0)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  rects.forEach((r, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  return [...groups.values()];
}

/** The rectangles' union on a grid of their own edges: { xs, ys, filled(i, j) }. */
function cells(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r.y, r.y + r.h]))].sort((a, b) => a - b);
  const fill = [];
  for (let j = 0; j < ys.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      fill[j * xs.length + i] = rects.some((r) => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h);
    }
  }
  const filled = (i, j) => i >= 0 && j >= 0 && i < xs.length - 1 && j < ys.length - 1 && fill[j * xs.length + i];
  return { xs, ys, filled };
}

/**
 * The union's outline as loops of corners, each wound so the roof is on the side of the
 * inward normal (-dy, dx): outer outlines run clockwise on screen, holes the other way.
 */
export function outline(rects) {
  const { xs, ys, filled } = cells(rects);
  const key = (p) => `${p.x},${p.y}`;
  const out = new Map(); // start corner → directed edges from it
  const add = (a, b) => {
    const e = { a, b, used: false };
    if (!out.has(key(a))) out.set(key(a), []);
    out.get(key(a)).push(e);
  };
  for (let j = 0; j < ys.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      if (!filled(i, j)) continue;
      const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
      if (!filled(i, j - 1)) add({ x: x0, y: y0 }, { x: x1, y: y0 });
      if (!filled(i + 1, j)) add({ x: x1, y: y0 }, { x: x1, y: y1 });
      if (!filled(i, j + 1)) add({ x: x1, y: y1 }, { x: x0, y: y1 });
      if (!filled(i - 1, j)) add({ x: x0, y: y1 }, { x: x0, y: y0 });
    }
  }
  const dir = (e) => ({ x: Math.sign(e.b.x - e.a.x), y: Math.sign(e.b.y - e.a.y) });
  const loops = [];
  for (const list of out.values()) {
    for (const first of list) {
      if (first.used) continue;
      const pts = [];
      let e = first;
      while (e && !e.used) {
        e.used = true;
        pts.push(e.a);
        const d = dir(e), inward = { x: -d.y, y: d.x };
        const next = (out.get(key(e.b)) ?? []).filter((n) => !n.used);
        // Where two corners pinch together, turn in towards the roof: the loops stay apart.
        e = next.find((n) => { const nd = dir(n); return nd.x === inward.x && nd.y === inward.y; }) ?? next[0];
      }
      // Drop corners in the middle of a straight run.
      const m = pts.length;
      const corners = pts.filter((p, i) => {
        const a = pts[(i - 1 + m) % m], b = pts[(i + 1) % m];
        return (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x) !== 0;
      });
      if (corners.length >= 3) loops.push(corners);
    }
  }
  return loops;
}

/** The union as rectangles shrunk by `inset` along its outside edges only (for clipping). */
export function insetRects(rects, inset) {
  const { xs, ys, filled } = cells(rects);
  const outRects = [];
  for (let j = 0; j < ys.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      if (!filled(i, j)) continue;
      const x0 = xs[i] + (filled(i - 1, j) ? 0 : inset), x1 = xs[i + 1] - (filled(i + 1, j) ? 0 : inset);
      const y0 = ys[j] + (filled(i, j - 1) ? 0 : inset), y1 = ys[j + 1] - (filled(i, j + 1) ? 0 : inset);
      if (x1 > x0 && y1 > y0) outRects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return outRects;
}

/** Is a point (grid squares) under any of the rectangles? */
export function insideRects(rects, x, y) {
  return rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
}

/**
 * The straight skeleton of an outline (loops as from `outline`): every edge moves inwards at
 * the same speed; corners trace the lines where roof planes meet. Returns
 * { edges: [{ a, b, n }], arcs: [{ a, b, f1, f2 }] } (n: the edge's inward normal; f1, f2: the
 * edges whose planes an arc divides), or null if the outline defeats it.
 */
export function straightSkeleton(loopPts) {
  const E = [];
  const loops = [];
  for (const pts of loopPts) {
    const base = E.length, m = pts.length;
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % m];
      const len = dist(a, b);
      if (len === 0) return null;
      const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      E.push({ a, b, d, n: { x: -d.y, y: d.x } });
    }
    loops.push(pts.map((p, i) => mk(p, base + ((i - 1 + m) % m), base + i)));
  }
  const arcs = [];
  function mk(p, ein, eout) { return { p: { x: p.x, y: p.y }, start: { x: p.x, y: p.y }, ein, eout }; }
  const arc = (a, b, f1, f2) => { if (dist(a, b) > NEAR && f1 !== f2) arcs.push({ a: { ...a }, b: { ...b }, f1, f2 }); };
  const die = (v) => arc(v.start, v.p, v.ein, v.eout);
  const velocity = (v) => {
    const n1 = E[v.ein].n, n2 = E[v.eout].n;
    const det = n1.x * n2.y - n1.y * n2.x;
    if (Math.abs(det) < 1e-9) return dot(n1, n2) > 0 ? { x: n1.x, y: n1.y } : null;
    return { x: (n2.y - n1.y) / det, y: (n1.x - n2.x) / det };
  };
  // Only corners that turn back on themselves (reflex) split the outline.
  const reflex = (v) => { const a = E[v.ein].d, b = E[v.eout].d; return a.x * b.y - a.y * b.x < -1e-9; };
  const onSeg = (p, a, b) => {
    const ab = sub(b, a), len = Math.hypot(ab.x, ab.y);
    if (len < NEAR) return near(p, a);
    const t = dot(sub(p, a), ab) / (len * len);
    if (t < -NEAR / len || t > 1 + NEAR / len) return false;
    return Math.abs((p.x - a.x) * ab.y - (p.y - a.y) * ab.x) / len < NEAR;
  };

  /** Settle everything that happens at the current moment: collapses, spikes, splits. */
  function settle() {
    for (let guard = 0; guard < 10000; guard++) {
      if (step()) continue;
      return true;
    }
    return false;
  }
  function step() {
    // Corners that have met along an edge become one.
    for (const L of loops) {
      for (let i = 0; i < L.length && L.length > 1; i++) {
        const j = (i + 1) % L.length, u = L[i], w = L[j];
        if (!near(u.p, w.p)) continue;
        die(u); die(w);
        const nv = mk(u.p, u.ein, w.eout);
        if (j > i) L.splice(i, 2, nv); else { L.splice(i, 1, nv); L.shift(); }
        return true;
      }
    }
    // A loop down to two corners is a ridge; down to one, a peak.
    for (let k = 0; k < loops.length; k++) {
      const L = loops[k];
      if (L.length >= 3) continue;
      for (const v of L) die(v);
      if (L.length === 2) arc(L[0].p, L[1].p, L[0].eout, L[1].eout);
      loops.splice(k, 1);
      return true;
    }
    // Two edges facing each other met head on: a spike, which folds away to its nearer end.
    for (const L of loops) {
      for (let i = 0; i < L.length; i++) {
        const x = L[i];
        if (velocity(x)) continue;
        const pi = (i - 1 + L.length) % L.length, ni = (i + 1) % L.length;
        const P = L[pi], N = L[ni], dP = dist(P.p, x.p), dN = dist(N.p, x.p);
        die(x);
        if (Math.abs(dP - dN) < NEAR) {
          arc(x.p, P.p, x.ein, x.eout);
          die(P); die(N);
          replace(L, [P, x, N], mk(P.p, P.ein, N.eout));
        } else if (dP < dN) {
          arc(x.p, P.p, x.ein, x.eout);
          die(P);
          const nv = mk(P.p, P.ein, x.eout);
          replace(L, [P, x], nv);
        } else {
          arc(x.p, N.p, x.ein, x.eout);
          die(N);
          const nv = mk(N.p, x.ein, N.eout);
          replace(L, [x, N], nv);
        }
        return true;
      }
    }
    // A corner reaching another edge splits the roof's outline there.
    for (let la = 0; la < loops.length; la++) {
      const A = loops[la];
      for (let iv = 0; iv < A.length; iv++) {
        const v = A[iv], vel = velocity(v);
        if (!reflex(v)) continue;
        for (let lb = 0; lb < loops.length; lb++) {
          const B = loops[lb];
          for (let ju = 0; ju < B.length; ju++) {
            const u = B[ju], w = B[(ju + 1) % B.length];
            if (u === v || w === v) continue;
            if (!onSeg(v.p, u.p, w.p)) continue;
            if (dot(E[u.eout].n, vel) - 1 > -1e-9) continue; // not heading through it
            die(v);
            const v1 = mk(v.p, v.ein, u.eout), v2 = mk(v.p, u.eout, v.eout);
            const cyc = (arr, from, to) => { const r = []; for (let k = from; ; k = (k + 1) % arr.length) { r.push(arr[k]); if (k === to) break; } return r; };
            if (A === B) {
              const n = A.length;
              const one = [v1, ...(((ju + 1) % n) === iv ? [] : cyc(A, (ju + 1) % n, (iv - 1 + n) % n))];
              const two = [v2, ...(((iv + 1) % n) === ((ju + 1) % n) ? [] : cyc(A, (iv + 1) % n, ju))];
              loops.splice(la, 1, one, two);
            } else {
              const nA = A.length;
              const restA = nA > 1 ? cyc(A, (iv + 1) % nA, (iv - 1 + nA) % nA) : [];
              const merged = [v1, ...cyc(B, (ju + 1) % B.length, ju), v2, ...restA];
              const hi = Math.max(la, lb), lo = Math.min(la, lb);
              loops.splice(hi, 1); loops.splice(lo, 1, merged);
            }
            return true;
          }
        }
      }
    }
    return false;
  }
  function replace(L, olds, nv) {
    const idx = L.indexOf(olds[0]);
    const out = L.filter((v) => !olds.includes(v));
    const at = Math.min(idx, out.length);
    out.splice(at, 0, nv);
    // The run may straddle the loop's end; only the cyclic order matters.
    L.splice(0, L.length, ...out);
  }

  if (!settle()) return null;
  for (let iter = 0; loops.length && iter < 2000; iter++) {
    let tmin = Infinity;
    const vels = new Map();
    for (const L of loops) for (const v of L) { const vel = velocity(v); if (!vel) return null; vels.set(v, vel); }
    for (const L of loops) {
      for (let i = 0; i < L.length; i++) {
        const u = L[i], w = L[(i + 1) % L.length];
        const d = E[u.eout].d;
        const len = dot(sub(w.p, u.p), d), rate = dot(sub(vels.get(w), vels.get(u)), d);
        if (rate < -1e-12) tmin = Math.min(tmin, Math.max(0, len / -rate));
      }
    }
    for (const A of loops) {
      for (const v of A) {
        if (!reflex(v)) continue;
        const vv = vels.get(v);
        for (const B of loops) {
          for (let j = 0; j < B.length; j++) {
            const u = B[j], w = B[(j + 1) % B.length];
            if (u === v || w === v) continue;
            const e = E[u.eout];
            const s0 = dot(e.n, sub(v.p, u.p)), rate = dot(e.n, vv) - 1;
            if (s0 < -NEAR || rate > -1e-12) continue;
            const t = Math.max(0, s0 / -rate);
            if (t >= tmin) continue;
            const at = (x) => ({ x: x.p.x + vels.get(x).x * t, y: x.p.y + vels.get(x).y * t });
            const pu = at(u), pw = at(w), pv = at(v);
            const len = dot(sub(pw, pu), e.d), along = dot(sub(pv, pu), e.d);
            if (along >= -NEAR && along <= len + NEAR) tmin = t;
          }
        }
      }
    }
    if (!Number.isFinite(tmin)) return null;
    for (const L of loops) for (const v of L) { const vel = vels.get(v); v.p.x += vel.x * tmin; v.p.y += vel.y * tmin; }
    if (!settle()) return null;
  }
  if (loops.length) return null;
  return { edges: E.map((e) => ({ a: e.a, b: e.b, n: e.n })), arcs };
}

/** Each edge's roof plane as a polygon, chained from its arcs; null if one won't close. */
export function roofFaces(sk) {
  const faces = [];
  const k = (p) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  for (let i = 0; i < sk.edges.length; i++) {
    const e = sk.edges[i];
    const segs = sk.arcs.filter((a) => a.f1 === i || a.f2 === i).map((a) => ({ a: a.a, b: a.b, used: false }));
    const poly = [e.a, e.b];
    let cur = e.b;
    for (let guard = 0; guard <= segs.length; guard++) {
      if (k(cur) === k(e.a)) break;
      const s = segs.find((x) => !x.used && (k(x.a) === k(cur) || k(x.b) === k(cur)));
      if (!s) return null;
      s.used = true;
      cur = k(s.a) === k(cur) ? s.b : s.a;
      if (k(cur) !== k(e.a)) poly.push(cur);
    }
    if (k(cur) !== k(e.a)) return null;
    faces.push({ edge: i, poly, n: e.n });
  }
  return faces;
}

/** A plain hipped rectangle with its ridge one way or the other ('h' or 'v'). */
function rectRoof(r, along) {
  const { x, y, w, h } = r;
  const c = { x: x + w / 2, y: y + h / 2 };
  const s = Math.min(w, h) / 2;
  const A = along === 'h' ? { x: x + s, y: c.y } : { x: c.x, y: y + s };
  const B = along === 'h' ? { x: x + w - s, y: c.y } : { x: c.x, y: y + h - s };
  const tl = { x, y }, tr = { x: x + w, y }, br = { x: x + w, y: y + h }, bl = { x, y: y + h };
  const faces = along === 'h'
    ? [{ poly: [tl, tr, B, A], n: { x: 0, y: 1 } }, { poly: [tr, br, B], n: { x: -1, y: 0 } }, { poly: [br, bl, A, B], n: { x: 0, y: -1 } }, { poly: [bl, tl, A], n: { x: 1, y: 0 } }]
    : [{ poly: [tl, tr, A], n: { x: 0, y: 1 } }, { poly: [tr, br, B, A], n: { x: -1, y: 0 } }, { poly: [br, bl, B], n: { x: 0, y: -1 } }, { poly: [bl, tl, A, B], n: { x: 1, y: 0 } }];
  const lines = [[tl, A], [bl, A], [tr, B], [br, B]];
  if (dist(A, B) > NEAR) lines.push([A, B]);
  return { loops: [[tl, tr, br, bl]], faces, lines };
}

/** The kinds of round roof. */
export const ROUND_ROOFS = ['cone', 'facets', 'dome'];

/**
 * A round roof filling a rectangle: a cone as many thin planes (no lines between them), a
 * faceted cone as 8 or 12 planes with hips between them, or a dome (drawn on its own:
 * `dome` gives its middle and radii).
 */
function roundRoof(r, kind) {
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 }, rx = r.w / 2, ry = r.h / 2;
  const n = kind === 'facets' ? (Math.min(rx, ry) < 1.5 ? 8 : 12) : 64;
  // Start half a facet round, so a faceted roof has a flat side to the north.
  const pts = Array.from({ length: n }, (_, i) => {
    const a = ((i + 0.5) / n - 0.25) * Math.PI * 2;
    return { x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) };
  });
  if (kind === 'dome') return { loops: [pts], faces: null, lines: [], dome: { c, rx, ry }, peak: c };
  const faces = pts.map((a, i) => {
    const b = pts[(i + 1) % n], len = dist(a, b) || 1;
    return { poly: [a, b, c], n: { x: -(b.y - a.y) / len, y: (b.x - a.x) / len } };
  });
  return { loops: [pts], faces, lines: kind === 'facets' ? pts.map((p) => [p, c]) : [], peak: c };
}

/** Is a point (grid squares) under a roof group (see sketch.js roofGroupsOf)? */
export function insideRoof(group, x, y) {
  if (group.round) {
    const r = group.rects[0], rx = r.w / 2, ry = r.h / 2;
    return ((x - r.x - rx) / rx) ** 2 + ((y - r.y - ry) / ry) ** 2 <= 1;
  }
  return insideRects(group.rects, x, y);
}

const cache = new Map();

/**
 * A building's roof from its rectangles: { loops (outline), faces: [{ poly, n }] or null,
 * lines: [[a, b]] } in grid squares. `ridge` turns a lone rectangle's ridge; `round` (a kind
 * from ROUND_ROOFS) makes a lone rectangle a round roof.
 */
export function roofShape(rects, ridge, round = null) {
  const key = JSON.stringify([rects.map((r) => [r.x, r.y, r.w, r.h]), rects.length === 1 ? ridge ?? null : null, round]);
  if (cache.has(key)) return cache.get(key);
  let shape;
  if (round && rects.length === 1) {
    shape = roundRoof(rects[0], round);
  } else if (rects.length === 1 && ridge && ridge !== (rects[0].w >= rects[0].h ? 'h' : 'v')) {
    shape = rectRoof(rects[0], ridge);
  } else {
    const loops = outline(rects);
    const sk = loops.length ? straightSkeleton(loops) : null;
    const faces = sk && roofFaces(sk);
    shape = faces
      ? { loops, faces, lines: sk.arcs.map((a) => [a.a, a.b]) }
      : { loops, faces: null, lines: [] };
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, shape);
  return shape;
}
