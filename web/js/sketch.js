// Sketched maps (GM): rooms and floors painted onto the grid, round rooms, walls, doors, windows
// and light sources. Drawn over the scene's map, under the grid.
//
// scene.sketch (positions in grid squares, so the sketch follows the grid):
//   cells   { "col,row": material }   room squares: walls along the rooms' edges
//   floor   { "col,row": material }   floor without walls (porches, paths, water)
//   edges   { "h:col,row" | "v:col,row": "wall" | "open" | "door" | "secret_door" | "window" }
//           a square's top (h) or left (v) edge, as the GM set it; "open" takes a room's wall away
//   shapes  { id: { kind: "circle", x, y, r, material, walled, openings } }   round rooms and floors;
//           openings { id: { at (degrees round, 0 = east, clockwise), width (squares), kind } }
//           are doors and windows set in a round room's curved wall
//   roofs   { id: { x, y, w, h, material, ridge, shape } }   roofs; touching ones join up, and
//           `shape` ("cone", "facets", "dome") makes one round
//   lines   { id: { a: [x, y], b: [x, y], kind } }                walls off the grid lines
//   props   { id: { kind, x, y } }                                  light sources (torch, …)
//   outside material | null,  walls: bool (rooms get walls),  size: grid px the walls are for
// A material is a built-in texture id (sketch-textures.js) or an uploaded image's URL.
//
// The walls and lights are ordinary walls and lights with ids starting `sk-`, worked out here
// (sketchWalls, sketchLights) and sent with each change; the server only stores them:
//   sk-w-<n>  walls along rooms and round rooms   sk-e-<n>  edges set to wall   sk-x-<id>  a line
//   sk-d-<edge>  a door    sk-n-<edge>  a window    sk-p-<id>  a light source's light
//   (a door or window in a round wall has o:<shape>:<opening> for its edge)

import { texture, TILE_SQUARES, TILE_SIZE } from './sketch-textures.js';
import { isGM } from './store.js';
import { hooks } from './hooks.js';
import { macroOf, macroPattern } from './texture-recipes.js';
import { propDef, isLight, propOutline, drawPropAt, propLightColor } from './sketch-props.js';
import { skId, onLevel, sketchOf } from './levels.js';
import { groupRects, roofShape, ROUND_ROOFS } from './roof-skeleton.js';

/** "col,row" → [col, row]. */
export const cellOf = (k) => k.split(',').map(Number);
export const cellKey = (c, r) => `${c},${r}`;

const MAPS = ['cells', 'floor', 'edges', 'shapes', 'lines', 'props', 'styles', 'roofs'];

/** A sketch with a change applied (null erases an entry; a whole map set to null empties it). */
export function withPatch(sk, patch) {
  const out = { outside: null, walls: true, size: 0, ...(sk ?? {}) };
  for (const k of MAPS) out[k] = { ...(sk?.[k] ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!MAPS.includes(k)) { out[k] = v; continue; }
    if (v === null) { out[k] = {}; continue; }
    for (const [id, x] of Object.entries(v)) { if (x == null) delete out[k][id]; else out[k][id] = x; }
  }
  return out;
}

// ------------------------------------------------------------------ edges

/** An edge key's segment in scene pixels: "h:c,r" is square (c, r)'s top, "v:c,r" its left. */
export function edgeSegment(edge, g) {
  const [dir, rest] = edge.split(':');
  const [c, r] = cellOf(rest);
  return dir === 'h' ? { a: [c * g, r * g], b: [(c + 1) * g, r * g] } : { a: [c * g, r * g], b: [c * g, (r + 1) * g] };
}

/** The grid edge nearest a point (scene px), if it's within `tol` squares of it. */
export function edgeNear(w, g, tol = 0.25) {
  const fx = w.x / g, fy = w.y / g;
  const dx = Math.abs(fx - Math.round(fx)), dy = Math.abs(fy - Math.round(fy));
  if (Math.min(dx, dy) > tol) return null;
  return dy < dx ? `h:${Math.floor(fx)},${Math.round(fy)}` : `v:${Math.round(fx)},${Math.floor(fy)}`;
}

/** The unit edges along a grid line from corner a to corner b ([col, row]), or null if it isn't along one. */
export function edgesAlong(a, b) {
  const out = [];
  if (a[1] === b[1]) for (let c = Math.min(a[0], b[0]); c < Math.max(a[0], b[0]); c++) out.push(`h:${c},${a[1]}`);
  else if (a[0] === b[0]) for (let r = Math.min(a[1], b[1]); r < Math.max(a[1], b[1]); r++) out.push(`v:${a[0]},${r}`);
  else return null;
  return out;
}

/** Collinear unit edges merged into runs: [[dir, line, from, to], …]. */
function runs(edges) {
  const lines = new Map();
  for (const e of edges) {
    const [dir, rest] = e.split(':');
    const [c, r] = cellOf(rest);
    const key = dir === 'h' ? `h${r}` : `v${c}`;
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { dir, line: dir === 'h' ? r : c, at: [] }));
    l.at.push(dir === 'h' ? c : r);
  }
  const out = [];
  for (const { dir, line, at } of lines.values()) {
    at.sort((x, y) => x - y);
    let start = at[0], prev = at[0];
    for (const p of at.slice(1)) {
      if (p === prev) continue;
      if (p !== prev + 1) { out.push([dir, line, start, prev + 1]); start = p; }
      prev = p;
    }
    out.push([dir, line, start, prev + 1]);
  }
  return out;
}

const runSeg = ([dir, line, a, b], g) => (dir === 'h' ? { a: [a * g, line * g], b: [b * g, line * g] } : { a: [line * g, a * g], b: [line * g, b * g] });
const SIDES = (c, r) => [[`h:${c},${r}`, cellKey(c, r - 1)], [`h:${c},${r + 1}`, cellKey(c, r + 1)], [`v:${c},${r}`, cellKey(c - 1, r)], [`v:${c + 1},${r}`, cellKey(c + 1, r)]];

// ------------------------------------------------------------------ walls

/**
 * The walls for a sketch at grid size `g`, { id: wall }: along the edges of the rooms (squares
 * and round rooms, merged where they meet) except where the GM set an edge; the edges set to
 * walls, doors and windows; the lines; and round props that stand in the way.
 *
 * Each wall also says where it came from, for drawing and picking (strip these before sending):
 * `style` (how it's drawn) and `src`: { edges: [edge keys] } | { shape: id } | { line: id } |
 * { prop: id } | { opening: edge }.
 */
export function sketchWalls(sk, g, level = '') {
  sk = withPatch(sk, null);
  const W = sk.cells, edges = sk.edges;
  const base = sk.wall_style || 'ink';
  const styleOf = (e) => sk.styles[e] || base;
  const circles = Object.entries(sk.shapes).filter(([, s]) => s.walled !== false && s.r > 0);
  const inside = (x, y) => cellKey(Math.floor(x / g), Math.floor(y / g)) in W
    || circles.some(([, c]) => (x / g - c.x) ** 2 + (y / g - c.y) ** 2 < c.r * c.r);
  // A piece of wall belongs where one side is room and the other isn't. Sampled at a few points,
  // so where two shapes meet a wall runs a touch long rather than leaving a gap.
  const boundary = (p, q) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    return [0.08, 0.5, 0.92].some((t) => {
      const x = p[0] + dx * t, y = p[1] + dy * t;
      return inside(x + nx * 0.5, y + ny * 0.5) !== inside(x - nx * 0.5, y - ny * 0.5);
    });
  };
  // The parts of a segment that are boundary, joined back up.
  const pieces = (a, b, out) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g / 8)));
    const at = (i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
    let start = null;
    for (let i = 0; i < n; i++) {
      const keep = boundary(at(i), at(i + 1));
      if (keep && !start) start = at(i);
      if (!keep && start) { out.push({ a: start, b: at(i) }); start = null; }
    }
    if (start) out.push({ a: start, b });
  };

  const out = {};
  let n = 0;
  const round = (p) => p.map((v) => Math.round(v * 100) / 100);
  const add = (id, seg, kind, style, src) => { id = skId(id, level); out[id] = { id, a: round(seg.a), b: round(seg.b), kind, open: false, locked: false, style, src, ...(level ? { level } : {}) }; };
  // Unit edges merged into runs, one style at a time.
  const addRuns = (prefix, list, kind = 'wall', fixed = null) => {
    const byStyle = new Map();
    for (const e of list) { const s = fixed ?? styleOf(e); if (!byStyle.has(s)) byStyle.set(s, []); byStyle.get(s).push(e); }
    for (const [style, es] of byStyle) for (const run of runs(es)) add(`${prefix}${n++}`, runSeg(run, g), kind, style, { edges: runEdges(run) });
  };

  if (sk.walls !== false) {
    const whole = [];
    const nearCircle = (seg) => circles.some(([, c]) => {
      const cx = c.x * g, cy = c.y * g, rr = c.r * g + g;
      return Math.max(seg.a[0], seg.b[0]) > cx - rr && Math.min(seg.a[0], seg.b[0]) < cx + rr
        && Math.max(seg.a[1], seg.b[1]) > cy - rr && Math.min(seg.a[1], seg.b[1]) < cy + rr;
    });
    for (const k of Object.keys(W)) {
      for (const [e, next] of SIDES(...cellOf(k))) {
        if (next in W || e in edges) continue;
        const seg = edgeSegment(e, g);
        if (!nearCircle(seg)) { whole.push(e); continue; }
        const cut = [];
        pieces(seg.a, seg.b, cut);
        for (const s of cut) add(`sk-w-${n++}`, s, 'wall', styleOf(e), { edges: [e] });
      }
    }
    addRuns('sk-w-', whole);
    for (const [id, c] of circles) {
      const sides = Math.max(16, Math.ceil(2 * Math.PI * c.r * 4));
      const pt = (a) => [(c.x + c.r * Math.cos(a)) * g, (c.y + c.r * Math.sin(a)) * g];
      // The wall runs round, broken where doors and windows are set in it.
      const ops = roundOpeningsOf(c);
      const angles = Array.from({ length: sides + 1 }, (_, i) => (i / sides) * 2 * Math.PI);
      for (const op of ops) angles.push(turn(op.a0), turn(op.a1));
      angles.sort((a, b) => a - b);
      const cut = [];
      for (let i = 0; i + 1 < angles.length; i++) {
        const a = angles[i], b = angles[i + 1];
        if (b - a < 1e-9 || ops.some((op) => within((a + b) / 2, op))) continue;
        pieces(pt(a), pt(b), cut);
      }
      for (const s of cut) add(`sk-w-${n++}`, s, 'wall', c.wall_style || base, { shape: id });
      for (const op of ops) {
        const key = `o:${id}:${op.id}`, seg = { a: pt(op.a0), b: pt(op.a1) };
        if (op.kind === 'window') add(`sk-n-${key}`, seg, 'window', null, { opening: key, shape: id });
        else add(`sk-d-${key}`, seg, op.kind, null, { opening: key, shape: id });
      }
    }
  }
  n = 0;
  addRuns('sk-e-', Object.keys(edges).filter((e) => edges[e] === 'wall'));
  // Railings: in the way, but you see (and shoot) over them.
  addRuns('sk-r-', Object.keys(edges).filter((e) => edges[e] === 'railing'), 'window', 'railing');
  for (const [e, kind] of Object.entries(edges)) {
    if (kind === 'door' || kind === 'secret_door') add(`sk-d-${e}`, edgeSegment(e, g), kind, null, { opening: e });
    else if (kind === 'window') add(`sk-n-${e}`, edgeSegment(e, g), 'window', null, { opening: e });
  }
  for (const [id, l] of Object.entries(sk.lines)) {
    if (l.a[0] !== l.b[0] || l.a[1] !== l.b[1]) add(`sk-x-${id}`, { a: [l.a[0] * g, l.a[1] * g], b: [l.b[0] * g, l.b[1] * g] }, l.style === 'railing' ? 'window' : l.kind || 'wall', l.style || base, { line: id });
  }
  // Props that stand in the way: walls round them (not drawn; the prop is).
  for (const [id, p] of Object.entries(sk.props)) {
    const def = propDef(p.kind);
    if (!p.blocks || !def.block) continue;
    const pts = propOutline(p, g);
    pts.forEach((a, i) => add(`sk-o-${id}-${i}`, { a, b: pts[(i + 1) % pts.length] }, def.block, null, { prop: id }));
  }
  return out;
}

/** A run's unit edges. */
function runEdges([dir, line, a, b]) {
  const out = [];
  for (let i = a; i < b; i++) out.push(dir === 'h' ? `h:${i},${line}` : `v:${line},${i}`);
  return out;
}

/** Walls ready to send: without the drawing details. */
export const plainWalls = (walls) => Object.fromEntries(Object.entries(walls).map(([id, w]) => [id, { id, a: w.a, b: w.b, kind: w.kind, open: w.open, locked: w.locked }]));

/** The light from each light source, { id: light }, with radii in the scene's distance units. */
export function sketchLights(sk, g, distance = 5, level = '') {
  const out = {};
  for (const [id, p] of Object.entries(sk?.props ?? {})) {
    if (!isLight(p.kind)) continue;
    const def = propDef(p.kind);
    const lid = skId(`sk-p-${id}`, level);
    // Its own light if it has one (set in its light's settings), else its kind's.
    const own = p.light;
    const bright = own ? Math.max(0, Number(own.bright) || 0) : def.bright * distance;
    const dim = own ? Math.max(bright, Number(own.dim) || 0) : def.dim * distance;
    out[lid] = {
      id: lid, x: Math.round(p.x * g), y: Math.round(p.y * g), bright, dim, color: propLightColor(p), off: false,
      ...(own?.tint != null ? { tint: own.tint } : {}), ...(own?.anim ? { anim: own.anim } : {}), ...(level ? { level } : {}),
    };
  }
  return out;
}

/** The ways to other levels: each prop that leads somewhere (stairs, a ladder…), its outline. */
export function sketchLinks(sk, g, level = '') {
  const out = {};
  for (const [id, p] of Object.entries(sk?.props ?? {})) {
    if (p.to == null) continue;
    const lid = skId(`sk-l-${id}`, level);
    out[lid] = { id: lid, poly: propOutline(p, g).map((q) => q.map((v) => Math.round(v * 100) / 100)), to: p.to, ...(level ? { level } : {}) };
  }
  return out;
}

// ------------------------------------------------------------------ drawing

let rev = 0;
/** Call when a scene's sketch changed (the store merges changes into the same object). */
export function sketchChanged() { rev++; }

const caches = new Map(); // level → what to draw

/** Everything to draw for a level, worked out once per change. */
function geometry(base, draft, g, level = '') {
  const key = `${rev}|${g}|${draft ? draft.rev : '-'}`;
  const cache = caches.get(level);
  if (cache && cache.key === key && cache.base === base) return cache;
  const sk = withPatch(base, draft?.patch ?? null);
  const all = { ...sk.floor, ...sk.cells };
  // Fills by material: same-material runs along each row make few rectangles.
  const byMat = new Map(), roomRegion = new Path2D(), floorEdge = new Path2D(), seams = new Path2D();
  const mat = (m) => { let p = byMat.get(m); if (!p) byMat.set(m, (p = new Path2D())); return p; };
  const rows = new Map();
  for (const [k, m] of Object.entries(all)) {
    const [c, r] = cellOf(k);
    let row = rows.get(r);
    if (!row) rows.set(r, (row = []));
    row.push([c, m]);
    if (k in sk.cells) roomRegion.rect(c * g, r * g, g, g);
    // The soft edge of all floor, and seams where materials meet.
    for (const [e, next] of SIDES(c, r)) {
      const s = edgeSegment(e, g);
      if (!(next in all)) { floorEdge.moveTo(...s.a); floorEdge.lineTo(...s.b); } else if (all[next] !== m && next > k) { seams.moveTo(...s.a); seams.lineTo(...s.b); }
    }
  }
  for (const [r, row] of rows) {
    row.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < row.length;) {
      let j = i;
      while (j + 1 < row.length && row[j + 1][0] === row[j][0] + 1 && row[j + 1][1] === row[i][1]) j++;
      mat(row[i][1]).rect(row[i][0] * g, r * g, (row[j][0] - row[i][0] + 1) * g, g);
      i = j + 1;
    }
  }
  // Round rooms and floors: walled ones first, so a round pond can sit in a room.
  const shapes = Object.values(sk.shapes).filter((s) => s.r > 0)
    .sort((a, b) => (b.walled !== false) - (a.walled !== false))
    .map((shape) => {
      const path = new Path2D();
      path.arc(shape.x * g, shape.y * g, shape.r * g, 0, Math.PI * 2);
      if (shape.walled !== false) roomRegion.addPath(path); else floorEdge.addPath(path);
      return { shape, path };
    });
  // Walls to draw: all together (for shadows), and by style. Props draw their own.
  const walls = sketchWalls(sk, g, level);
  const wallPath = new Path2D(), byStyle = new Map(), railings = new Path2D();
  for (const w of Object.values(walls)) {
    if (w.style === 'railing') { railings.moveTo(w.a[0], w.a[1]); railings.lineTo(w.b[0], w.b[1]); continue; }
    if (w.kind !== 'wall' || w.src?.prop) continue;
    wallPath.moveTo(w.a[0], w.a[1]);
    wallPath.lineTo(w.b[0], w.b[1]);
    let p = byStyle.get(w.style);
    if (!p) byStyle.set(w.style, (p = new Path2D()));
    p.moveTo(w.a[0], w.a[1]);
    p.lineTo(w.b[0], w.b[1]);
  }
  // Props by layer: on the floor, standing, then above the walls (tree tops, and light sources
  // so their glow isn't shaded).
  const props = [[], [], []];
  for (const [id, pr] of Object.entries(sk.props)) {
    const def = propDef(pr.kind);
    props[def.light && def.layer ? 2 : def.layer].push([id, pr]);
  }
  const out = { key, base, sk, byMat, roomRegion, floorEdge, seams, shapes, wallPath, byStyle, props, walls, railings };
  caches.set(level, out);
  return out;
}

let patterns = new WeakMap(); // ctx → Map(material → { pat, span })
// A texture made in the texture creator changed (or its picture arrived): make its pattern again.
hooks.on('textures:changed', () => { patterns = new WeakMap(); });

/** A fill for a material: a repeating pattern scaled to the grid, or a flat colour while it loads. */
/** A made texture's map-wide light and dark, over what `fill` just painted with it. */
function vary(ctx, m, g, fill) {
  const mv = macroOf(m);
  if (!mv) return;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = mv.amount * 0.75;
  ctx.fillStyle = macroPattern(ctx, g, mv.size, m);
  fill();
  ctx.restore();
}

function fillFor(ctx, m, g, board, turn = null) {
  let pats = patterns.get(ctx);
  if (!pats) patterns.set(ctx, (pats = new Map()));
  let entry = pats.get(m);
  if (!entry) {
    const tex = texture(m);
    // The texture creator's: drawn once its sources have loaded.
    if (!tex && m?.startsWith?.('tex:')) return '#6b6359';
    const src = tex ?? board.image(m);
    if (!src) return '#6b6359';
    // Built-ins cover 2 × 2 squares; an uploaded texture covers 4 squares across.
    entry = { pat: ctx.createPattern(src, 'repeat'), span: tex ? TILE_SIZE / TILE_SQUARES : (src.naturalWidth || 256) / 4 };
    pats.set(m, entry);
  }
  // `turn`: { x, y, deg } — the pattern turned about a point (a roof plane's rows along its eave).
  const mat = turn ? new DOMMatrix().translate(turn.x, turn.y).rotate(turn.deg) : new DOMMatrix();
  entry.pat.setTransform(mat.scale(g / entry.span));
  return entry.pat;
}

const INK = '#17120e';
let layer = null; // offscreen: the walls' shadow, cut out of the rooms

/**
 * Draw the scene's sketch (scene coordinates). `draft`: a change being made right now,
 * { patch, rev }, shown before it's sent.
 */
export function drawSketch(ctx, s, board, { level = '', draft = null } = {}) {
  const base = sketchOf(s, level);
  if (!base && !draft) return;
  const g = s.grid?.size ?? 70;
  const geo = geometry(base, draft, g, level);
  const sk = geo.sk;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, s.width, s.height);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (sk.outside) {
    ctx.fillStyle = fillFor(ctx, sk.outside, g, board);
    ctx.fillRect(0, 0, s.width, s.height);
    vary(ctx, sk.outside, g, () => ctx.fillRect(0, 0, s.width, s.height));
  }
  // A soft edge round every floor, then the floors.
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = g * 0.12;
  ctx.stroke(geo.floorEdge);
  for (const [m, path] of geo.byMat) { ctx.fillStyle = fillFor(ctx, m, g, board); ctx.fill(path); vary(ctx, m, g, () => ctx.fill(path)); }
  for (const { shape, path } of geo.shapes) { ctx.fillStyle = fillFor(ctx, shape.material, g, board); ctx.fill(path); vary(ctx, shape.material, g, () => ctx.fill(path)); }
  ctx.strokeStyle = 'rgba(20, 15, 10, 0.55)';
  ctx.lineWidth = Math.max(1, g * 0.03);
  ctx.stroke(geo.seams);
  for (const { shape, path } of geo.shapes) if (shape.walled === false) ctx.stroke(path);
  const texFill = (c, m, u) => fillFor(c, m, u, board);
  const drawProps = (list) => { for (const [id, p] of list) drawPropAt(ctx, p, g, { seed: id, lit: !s.lights?.[skId(`sk-p-${id}`, level)]?.off, texFill }); };
  drawProps(geo.props[0]);
  drawProps(geo.props[1]);

  // The walls' shadow on whatever is outside the rooms: drawn apart, cut out of the rooms.
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  if (!layer) layer = document.createElement('canvas');
  if (layer.width !== cw || layer.height !== ch) { layer.width = cw; layer.height = ch; }
  const lc = layer.getContext('2d');
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.clearRect(0, 0, cw, ch);
  lc.setTransform(ctx.getTransform());
  lc.lineCap = 'round';
  lc.lineJoin = 'round';
  lc.strokeStyle = 'rgba(0,0,0,0.3)';
  lc.lineWidth = g * 0.6;
  lc.stroke(geo.wallPath);
  lc.strokeStyle = 'rgba(0,0,0,0.35)';
  lc.lineWidth = g * 0.3;
  lc.stroke(geo.wallPath);
  lc.globalCompositeOperation = 'destination-out';
  lc.fill(geo.roomRegion);
  lc.globalCompositeOperation = 'source-over';
  const t = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  ctx.setTransform(t);
  // Shade just inside the walls, then the ink.
  ctx.save();
  ctx.clip(geo.roomRegion);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = g * 0.22;
  ctx.stroke(geo.wallPath);
  ctx.restore();
  // Ink lines; textured walls as a band of texture edged in ink (all the edges first, so where
  // two styles meet neither's edge crosses the other's band).
  const band = g * 0.24, edge = Math.max(1.5, g * 0.03);
  for (const [style, path] of geo.byStyle) {
    ctx.strokeStyle = INK;
    if (style === 'ink' || !style) { ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, g * 0.08); } else { ctx.lineCap = 'square'; ctx.lineWidth = band + edge * 2; }
    ctx.stroke(path);
  }
  ctx.lineCap = 'square';
  for (const [style, path] of geo.byStyle) {
    if (style === 'ink' || !style) continue;
    ctx.strokeStyle = fillFor(ctx, style, g * 0.6, board);
    ctx.lineWidth = band;
    ctx.stroke(path);
  }
  ctx.lineCap = 'round';
  drawRailings(ctx, geo.railings, g);

  drawOpenings(ctx, s, g, level, board ? board.gmView : isGM(), sk);
  drawProps(geo.props[2]);
  ctx.restore();
}

/** Railings: a light wooden rail between dark edges, with posts. */
function drawRailings(ctx, path, g) {
  ctx.save();
  ctx.lineCap = 'square';
  ctx.strokeStyle = INK;
  ctx.lineWidth = g * 0.11;
  ctx.stroke(path);
  ctx.strokeStyle = '#a7743f';
  ctx.lineWidth = g * 0.06;
  ctx.stroke(path);
  ctx.strokeStyle = INK;
  ctx.lineWidth = g * 0.12;
  ctx.setLineDash([g * 0.04, g * 0.46]);
  ctx.lineDashOffset = g * 0.02;
  ctx.stroke(path);
  ctx.restore();
}

/**
 * The floor of the level above that overhangs this one (walkways and balconies: its floor
 * without walls), seen from below. `holes`: points (scene px) to leave clear, so a token
 * standing under it is still seen; `alpha`: how solid it looks.
 */
export function drawOverhang(ctx, s, board, level, { holes = [], alpha = 0.9, darkness = 0 } = {}) {
  const sk = withPatch(sketchOf(s, level), null);
  const g = s.grid?.size ?? 70;
  const floors = new Map(), outline = new Path2D();
  const all = sk.floor;
  for (const [k, m] of Object.entries(all)) {
    const [c, r] = cellOf(k);
    if (!floors.has(m)) floors.set(m, new Path2D());
    floors.get(m).rect(c * g, r * g, g, g);
    for (const [e, next] of SIDES(c, r)) {
      if (next in all) continue;
      const seg = edgeSegment(e, g);
      outline.moveTo(...seg.a); outline.lineTo(...seg.b);
    }
  }
  const round = Object.values(sk.shapes).filter((x) => x.walled === false && x.r > 0);
  if (!floors.size && !round.length) return false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, s.width, s.height);
  for (const h of holes) { ctx.moveTo(h.x + h.r, h.y); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); }
  ctx.clip('evenodd');
  ctx.globalAlpha = alpha;
  // Its shadow on the floor below, then the floor and its edge.
  ctx.save();
  ctx.translate(g * 0.12, g * 0.12);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (const path of floors.values()) ctx.fill(path);
  for (const x of round) { ctx.beginPath(); ctx.arc(x.x * g, x.y * g, x.r * g, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  for (const [m, path] of floors) { ctx.fillStyle = fillFor(ctx, m, g, board); ctx.fill(path); vary(ctx, m, g, () => ctx.fill(path)); }
  for (const x of round) { ctx.fillStyle = fillFor(ctx, x.material, g, board); ctx.beginPath(); ctx.arc(x.x * g, x.y * g, x.r * g, 0, Math.PI * 2); ctx.fill(); }
  // Drawn over the level's lighting, so it takes the night's darkness itself.
  if (darkness > 0.01) {
    ctx.fillStyle = `rgba(4, 6, 18, ${darkness * (board.gmView ? 0.7 : 0.85)})`;
    for (const path of floors.values()) ctx.fill(path);
    for (const x of round) { ctx.beginPath(); ctx.arc(x.x * g, x.y * g, x.r * g, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.5, g * 0.05);
  ctx.stroke(outline);
  const geo = geometry(sketchOf(s, level), null, g, level);
  drawRailings(ctx, geo.railings, g);
  ctx.restore();
  return true;
}

/** Is a point (scene px) on the overhanging floor of a level (its floor without walls)? */
export function onOverhang(s, level, pt) {
  const sk = sketchOf(s, level);
  if (!sk) return false;
  const g = s.grid?.size ?? 70;
  if (cellKey(Math.floor(pt.x / g), Math.floor(pt.y / g)) in (sk.floor ?? {})) return true;
  return Object.values(sk.shapes ?? {}).some((x) => x.walled === false && (pt.x / g - x.x) ** 2 + (pt.y / g - x.y) ** 2 <= x.r * x.r);
}

/** What can be set in a round room's wall. */
export const ROUND_OPENINGS = ['door', 'secret_door', 'window'];
const TAU = Math.PI * 2;
/** An angle (radians) brought into 0 … 2π. */
const turn = (a) => ((a % TAU) + TAU) % TAU;
/** Is an angle inside an opening's arc? */
const within = (a, op) => turn(a - op.a0) < op.a1 - op.a0;

/**
 * Where a door or window sits in a round room's wall: the arc it fills, from `a0` to `a1`
 * (radians, clockwise on the map), centred on `mid`.
 */
export function roundOpening(shape, op) {
  const mid = ((op.at ?? 0) * Math.PI) / 180;
  const half = Math.asin(Math.min(1, (op.width ?? 1) / 2 / Math.max(shape.r, 0.01)));
  return { a0: mid - half, a1: mid + half, mid };
}

/** A round room's doors and windows: [{ id, kind, at, width, a0, a1, mid }]. */
export function roundOpeningsOf(shape) {
  if (shape.walled === false) return [];
  return Object.entries(shape.openings ?? {})
    .filter(([, o]) => o && ROUND_OPENINGS.includes(o.kind))
    .map(([id, o]) => ({ id, ...o, ...roundOpening(shape, o) }));
}

/** Is an angle (radians) inside one of a round room's openings? Its id if so. */
export function roundOpeningAt(shape, a) {
  return roundOpeningsOf(shape).find((op) => within(a, op))?.id ?? null;
}

/** Every roof on the scene: [{ id, level, roof }] (roofs live in the levels' sketches). */
export function roofsOf(s, levels) {
  const out = [];
  for (const l of levels) for (const [id, roof] of Object.entries(sketchOf(s, l.id)?.roofs ?? {})) out.push({ id, level: l.id, roof });
  return out;
}

/**
 * The scene's roofs as buildings: roof rectangles on one level, of one material, that overlap
 * or share an edge make one roof; round roofs come after them, each on its own.
 * [{ level, ids, rects, material, ridge, round }]
 */
export function roofGroupsOf(s, levels) {
  const out = [];
  for (const l of levels) {
    const byMat = new Map(), round = [];
    for (const [id, roof] of Object.entries(sketchOf(s, l.id)?.roofs ?? {})) {
      if (!(roof?.w > 0 && roof?.h > 0)) continue;
      // A round roof stands on its own (a tower's, above the roofs round it).
      if (ROUND_ROOFS.includes(roof.shape)) { round.push({ level: l.id, ids: [id], rects: [{ ...roof, id }], material: roof.material, round: roof.shape }); continue; }
      if (!byMat.has(roof.material)) byMat.set(roof.material, []);
      byMat.get(roof.material).push({ ...roof, id });
    }
    for (const [material, rects] of byMat) {
      for (const group of groupRects(rects)) {
        out.push({ level: l.id, ids: group.map((r) => r.id), rects: group, material, ridge: group.length === 1 ? group[0].ridge : undefined });
      }
    }
    out.push(...round);
  }
  return out;
}

// Light falls from the top left: planes facing it are lit, planes facing away shaded.
const LIGHT = (() => { const x = -0.45, y = -1, l = Math.hypot(x, y); return { x: x / l, y: y / l }; })();

/** Draw a roof rectangle on its own (as while dragging one out). */
export function drawRoof(ctx, roof, g, board, alpha = 1) {
  drawRoofGroup(ctx, { rects: [roof], material: roof.material, ridge: roof.ridge, round: ROUND_ROOFS.includes(roof.shape) ? roof.shape : null }, g, board, alpha);
}

/**
 * Draw a building's roof (from `roofGroupsOf`): one roof over the whole footprint, each plane
 * in the material with its rows along its eave and shaded by which way it slopes; ridges,
 * hips and valleys inked where planes meet, and an ink edge round the eaves.
 */
export function drawRoofGroup(ctx, group, g, board, alpha = 1) {
  const shape = roofShape(group.rects, group.ridge, group.round);
  const path = (pts, dx = 0, dy = 0, p = new Path2D()) => {
    pts.forEach((q, i) => (i ? p.lineTo(q.x * g + dx, q.y * g + dy) : p.moveTo(q.x * g + dx, q.y * g + dy)));
    p.closePath();
    return p;
  };
  const whole = (dx = 0, dy = 0) => { const p = new Path2D(); for (const l of shape.loops) path(l, dx, dy, p); return p; };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill(whole(g * 0.15, g * 0.15), 'evenodd');
  if (shape.dome) {
    drawDome(ctx, shape.dome, whole(), group.material, g, board);
  } else if (!shape.faces) {
    // An outline the roof can't be worked out for: covered flat.
    ctx.fillStyle = fillFor(ctx, group.material, g * 0.8, board);
    ctx.fill(whole(), 'evenodd');
  } else {
    // Whole first, so the planes' clipped edges leave no hairline gaps.
    ctx.fillStyle = fillFor(ctx, group.material, g * 0.8, board);
    ctx.fill(whole(), 'evenodd');
    for (const f of shape.faces) {
      const p = path(f.poly);
      const down = { x: -f.n.x, y: -f.n.y }; // which way the plane slopes
      const a = f.poly[0];
      ctx.save();
      ctx.clip(p);
      ctx.fillStyle = fillFor(ctx, group.material, g * 0.8, board, { x: a.x * g, y: a.y * g, deg: (Math.atan2(-down.x, down.y) * 180) / Math.PI });
      ctx.fill(p);
      const lit = down.x * LIGHT.x + down.y * LIGHT.y;
      ctx.fillStyle = lit >= 0 ? `rgba(255,255,255,${(0.1 * lit).toFixed(3)})` : `rgba(0,0,0,${(0.26 * -lit).toFixed(3)})`;
      ctx.fill(p);
      // A little shade along the eave and light up at the ridge, so each plane reads as a slope.
      const depth = Math.max(...f.poly.map((q) => (q.x - a.x) * f.n.x + (q.y - a.y) * f.n.y)) * g;
      if (depth > 0) {
        const grad = ctx.createLinearGradient(a.x * g, a.y * g, a.x * g + f.n.x * depth, a.y * g + f.n.y * depth);
        grad.addColorStop(0, 'rgba(0,0,0,0.12)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fill(p);
      }
      ctx.restore();
    }
  }
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, g * 0.05);
  ctx.beginPath();
  for (const [a, b] of shape.lines) { ctx.moveTo(a.x * g, a.y * g); ctx.lineTo(b.x * g, b.y * g); }
  ctx.stroke();
  ctx.lineWidth = Math.max(2, g * 0.08);
  ctx.lineJoin = 'round';
  ctx.stroke(whole());
  if (shape.peak) {
    // A finial at the top of a round roof.
    const px = shape.peak.x * g, py = shape.peak.y * g, pr = Math.max(3, g * 0.12);
    const shine = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, 0, px, py, pr);
    shine.addColorStop(0, '#9a8f80');
    shine.addColorStop(1, '#2e2925');
    ctx.fillStyle = shine;
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(1, g * 0.03);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A dome seen from above: courses of the material in rings (closer together towards the rim,
 * where the dome is steep), ribs up to the top, and lit like a ball from the top left.
 */
function drawDome(ctx, { c, rx, ry }, outline, material, g, board) {
  const cx = c.x * g, cy = c.y * g, RX = rx * g, RY = ry * g, R = Math.max(RX, RY);
  ctx.save();
  ctx.clip(outline);
  ctx.fillStyle = fillFor(ctx, material, g * 0.6, board);
  ctx.fill(outline);
  ctx.strokeStyle = 'rgba(20, 15, 10, 0.45)';
  ctx.lineWidth = Math.max(1, g * 0.025);
  const courses = Math.max(3, Math.round(Math.min(rx, ry) * 2.5));
  ctx.beginPath();
  for (let k = 1; k < courses; k++) {
    const f = Math.cos(((k / courses) * Math.PI) / 2);
    ctx.moveTo(cx + RX * f, cy);
    ctx.ellipse(cx, cy, RX * f, RY * f, 0, 0, Math.PI * 2);
  }
  const ribs = Math.min(rx, ry) < 1.5 ? 8 : 12;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + RX * Math.cos(a), cy + RY * Math.sin(a));
  }
  ctx.stroke();
  const ball = ctx.createRadialGradient(cx + LIGHT.x * R * 0.4, cy + LIGHT.y * R * 0.4, 0, cx + LIGHT.x * R * 0.15, cy + LIGHT.y * R * 0.15, R * 1.15);
  ball.addColorStop(0, 'rgba(255,255,255,0.22)');
  ball.addColorStop(0.45, 'rgba(255,255,255,0)');
  ball.addColorStop(0.75, 'rgba(0,0,0,0.12)');
  ball.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = ball;
  ctx.fill(outline);
  ctx.restore();
}

/**
 * Doors (in their frames, swung open when open) and windows, from the scene's walls; those
 * in round rooms' walls from the sketch (`sk`), following the curve.
 */
function drawOpenings(ctx, s, g, level, gm, sk) {
  for (const [sid, shape] of Object.entries(sk?.shapes ?? {})) {
    if (!(shape.r > 0)) continue;
    for (const op of roundOpeningsOf(shape)) {
      const key = `o:${sid}:${op.id}`;
      const win = op.kind === 'window';
      const w = s.walls?.[skId(`${win ? 'sk-n-' : 'sk-d-'}${key}`, level)];
      drawRoundOpening(ctx, shape, op, g, gm, !win && !!w?.open);
    }
  }
  for (const [id, w] of Object.entries(s.walls ?? {})) {
    const win = id.startsWith('sk-n-');
    if ((!win && !id.startsWith('sk-d-')) || !onLevel(w, level)) continue;
    if (id.startsWith('o:', 5)) continue; // in a round wall: drawn above
    const ax = w.a[0], ay = w.a[1], bx = w.b[0], by = w.b[1];
    const len = Math.hypot(bx - ax, by - ay);
    ctx.strokeStyle = INK;
    if (w.kind === 'secret_door' && !gm && !w.open) {
      // A plain wall to players.
      ctx.lineWidth = Math.max(2, g * 0.08);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      continue;
    }
    const t = g * 0.16, post = g * 0.12, span = len - post * 2;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(Math.atan2(by - ay, bx - ax));
    ctx.fillStyle = INK;
    ctx.fillRect(-1, -t * 0.75, post, t * 1.5);
    ctx.fillRect(len - post + 1, -t * 0.75, post, t * 1.5);
    ctx.lineWidth = Math.max(1, g * 0.03);
    if (win) {
      // Glass in a thin frame, with a mullion.
      ctx.fillStyle = 'rgba(170, 215, 235, 0.9)';
      ctx.fillRect(post, -t * 0.3, span, t * 0.6);
      ctx.strokeRect(post, -t * 0.3, span, t * 0.6);
      ctx.beginPath(); ctx.moveTo(post + span / 2, -t * 0.3); ctx.lineTo(post + span / 2, t * 0.3); ctx.stroke();
    } else {
      ctx.translate(post, 0);
      if (w.open) ctx.rotate(-Math.PI * 0.45);
      ctx.fillStyle = w.kind === 'secret_door' ? '#5a4a6e' : '#8a5a2e';
      ctx.fillRect(0, -t / 2, span, t);
      ctx.strokeRect(0, -t / 2, span, t);
    }
    ctx.restore();
  }
}

/**
 * A door or window in a round room's wall, bent to the wall's curve between posts. An open
 * door swings in, straight, from its first post.
 */
function drawRoundOpening(ctx, shape, op, g, gm, open) {
  const cx = shape.x * g, cy = shape.y * g, R = shape.r * g;
  const t = g * 0.16, post = g * 0.12;
  const dp = Math.min(post / R, (op.a1 - op.a0) / 4); // a post's share of the arc
  const b0 = op.a0 + dp, b1 = op.a1 - dp;
  const at = (a, r = R) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const band = (w) => {
    ctx.beginPath();
    ctx.arc(cx, cy, R + w / 2, b0, b1);
    ctx.arc(cx, cy, Math.max(0, R - w / 2), b1, b0, true);
    ctx.closePath();
  };
  ctx.save();
  ctx.strokeStyle = INK;
  if (op.kind === 'secret_door' && !gm && !open) {
    // A plain wall to players.
    ctx.lineWidth = Math.max(2, g * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, R, op.a0, op.a1); ctx.stroke();
    ctx.restore();
    return;
  }
  // Posts, square to the wall.
  ctx.fillStyle = INK;
  for (const [a, back] of [[op.a0, false], [op.a1, true]]) {
    ctx.save();
    ctx.translate(...at(a));
    ctx.rotate(a + Math.PI / 2);
    ctx.fillRect(back ? -post + 1 : -1, -t * 0.75, post, t * 1.5);
    ctx.restore();
  }
  ctx.lineWidth = Math.max(1, g * 0.03);
  if (op.kind === 'window') {
    // Curved glass in a thin frame, with a mullion.
    band(t * 0.6);
    ctx.fillStyle = 'rgba(170, 215, 235, 0.9)';
    ctx.fill();
    ctx.stroke();
    const mid = (b0 + b1) / 2;
    ctx.beginPath(); ctx.moveTo(...at(mid, R - t * 0.3)); ctx.lineTo(...at(mid, R + t * 0.3)); ctx.stroke();
  } else if (!open) {
    band(t);
    ctx.fillStyle = op.kind === 'secret_door' ? '#5a4a6e' : '#8a5a2e';
    ctx.fill();
    ctx.stroke();
  } else {
    // Swung into the room: a straight leaf as long as the gap, from the first post.
    const [hx, hy] = at(b0), [ex, ey] = at(b1);
    const span = Math.hypot(ex - hx, ey - hy);
    ctx.translate(hx, hy);
    ctx.rotate(Math.atan2(ey - hy, ex - hx) + Math.PI * 0.45);
    ctx.fillStyle = op.kind === 'secret_door' ? '#5a4a6e' : '#8a5a2e';
    ctx.fillRect(0, -t / 2, span, t);
    ctx.strokeRect(0, -t / 2, span, t);
  }
  ctx.restore();
}
