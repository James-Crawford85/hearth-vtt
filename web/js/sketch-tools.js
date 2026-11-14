// The GM's sketch-map tools (board tools; sketch.js has the data and the drawing):
//   sketch-room    drag a rectangle of room: floor with walls round it (Shift erases)
//   sketch-round   drag a round room from its centre (Alt: a round floor without walls, a pond;
//                  Shift-click one to remove it)
//   sketch-floor   drag a rectangle of floor without walls: porches, paths, yards (Shift erases)
//   sketch-brush   paint floor square by square (Shift erases; [ and ] change the size); on a
//                  room it changes the floor and keeps the walls
//   sketch-erase   erase squares, round rooms and light sources with the brush
//   sketch-wall    drag along grid lines to add walls, corner to corner at an angle for a
//                  diagonal; Shift-drag along grid lines takes walls away (rooms' walls too),
//                  Shift-click a diagonal removes it
//   sketch-door    click a grid edge: a door (Shift: secret door); again to remove
//   sketch-window  click a grid edge: a window; again to remove
//   sketch-place   click to place the chosen prop: a light source (next to a wall it's mounted on
//                  the wall) or furniture and nature
//   sketch-select  click a prop, door, window, wall or round room: drag to move it, handles to
//                  resize and turn it, Delete removes it; a bar shows its options
// Hold Ctrl (Cmd on a Mac) to stop snapping: round rooms, walls, props and moving, turning and
// resizing in Select go exactly where the pointer is (a wall off the grid lines is free-standing).
// Ctrl+Z undoes, Esc goes back to Select. Each change is one op carrying the sketch's walls and
// lights, worked out again.
import { toast, formDialog, openWindow, el } from './ui.js';
import { isGM, store } from './store.js';
import { hooks } from './hooks.js';
import { MATERIALS, WALL_STYLES, ROOF_MATERIALS, texture } from './sketch-textures.js';
import { cellKey, cellOf, withPatch, sketchWalls, plainWalls, sketchLights, sketchLinks, edgeSegment, edgeNear, edgesAlong } from './sketch.js';
import { sketchOf, skId, levelsOf, levelName } from './levels.js';
import { LIGHTS, FURNITURE, propDef, isLight, drawPropAt, propThumb, propHit, propOutline } from './sketch-props.js';
import { drawRoof } from './sketch.js';

const HOVER = 'rgba(255, 190, 40, 0.95)';
const ERASE = 'rgba(255, 90, 70, 0.95)';
const MAPS = ['cells', 'floor', 'edges', 'shapes', 'lines', 'props', 'styles', 'roofs'];
const PAINT_TOOLS = ['sketch-room', 'sketch-floor', 'sketch-brush', 'sketch-round'];
const newId = () => Math.random().toString(36).slice(2, 10);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function registerSketch(api) {
  const board = api.board;
  const st = {
    material: 'stone',
    prop: 'torch',
    brush: 1,
    undo: [],     // [{ sceneId, patch }]: the change that puts things back
    hover: null,  // the world point under the mouse
    drag: null,
    mods: {},     // shiftKey, altKey, free (Ctrl or Cmd: no snapping) as last seen
  };
  api.sketch = st;

  const scene = () => board.scene;
  const g = () => board.grid;
  // The sketch of the level the board shows.
  const current = () => withPatch(sketchOf(scene(), board.level), null);
  const cellAt = (w) => [Math.floor(w.x / g()), Math.floor(w.y / g())];
  const cornerAt = (w) => [Math.round(w.x / g()), Math.round(w.y / g())];
  const inScene = (c, r) => { const s = scene(); return c >= 0 && r >= 0 && c * g() < s.width && r * g() < s.height; };

  // ---------------------------------------------------------------- changes

  /** Send a change to the sketch (maps of entries, null erasing one), with its walls and lights. */
  function commit(patch, { record = true } = {}) {
    const s = scene();
    if (!s) return false;
    const before = current();
    const clean = {}, inverse = {};
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (!MAPS.includes(k)) {
        if (!same(before[k], v)) { clean[k] = v; inverse[k] = before[k]; changed = true; }
        continue;
      }
      for (const [id, x] of Object.entries(v ?? {})) {
        const was = before[k][id] ?? null;
        if (same(was, x)) continue;
        (clean[k] ??= {})[id] = x ?? null;
        // A copy: the store updates entries in place, which would change the undo too.
        (inverse[k] ??= {})[id] = was === null ? null : structuredClone(was);
        changed = true;
      }
    }
    if (!changed) return false;
    if (record) {
      st.undo.push({ sceneId: s.id, level: board.level, patch: inverse });
      if (st.undo.length > 100) st.undo.shift();
    }
    // A first sketch on an empty scene gets rock around it; on a map, the map shows around it.
    // Other levels have nothing round them (what's below shows).
    if (!sketchOf(s, board.level)) { clean.outside ??= board.level || s.background ? null : 'rock'; clean.walls ??= true; }
    clean.size = g();
    send(s, clean);
    return true;
  }

  function send(s, patch) {
    const level = board.level;
    const next = withPatch(sketchOf(s, level), patch);
    api.op({
      op: 'sketch_update', scene_id: s.id, ...(level ? { level } : {}), patch,
      walls: plainWalls(sketchWalls(next, g(), level)), lights: sketchLights(next, g(), s.grid?.distance ?? 5, level), links: sketchLinks(next, g(), level),
    });
  }

  function undo() {
    const last = st.undo.at(-1);
    if (!last || last.sceneId !== scene()?.id) { toast('Nothing to undo on this scene.'); return; }
    st.undo.pop();
    // Undo on the level where the change was made.
    if ((last.level ?? '') !== board.level) { board.setLevel(last.level ?? ''); toast(`Undone on ${levelName(scene(), last.level)}.`); }
    commit(last.patch, { record: false });
  }

  // What painting does to squares, against the sketch as it is.
  const paint = {
    room(keys, m, out = {}) { for (const k of keys) { (out.cells ??= {})[k] = m; (out.floor ??= {})[k] = null; } return out; },
    floor(keys, m, out = {}) {
      const sk = current();
      for (const k of keys) { if (k in sk.cells) (out.cells ??= {})[k] = m; else (out.floor ??= {})[k] = m; }
      return out;
    },
    erase(keys, out = {}) {
      const sk = current();
      const set = new Set(keys);
      for (const k of keys) { (out.cells ??= {})[k] = null; (out.floor ??= {})[k] = null; }
      for (const [id, sh] of Object.entries(sk.shapes)) if (set.has(cellKey(Math.floor(sh.x), Math.floor(sh.y)))) (out.shapes ??= {})[id] = null;
      for (const [id, p] of Object.entries(sk.props)) if (set.has(cellKey(Math.floor(p.x), Math.floor(p.y)))) (out.props ??= {})[id] = null;
      return out;
    },
  };

  // The draft shown while dragging.
  function setDraft(patch) {
    board.sketchDraft = patch ? { patch, rev: (board.sketchDraft?.rev ?? 0) + 1 } : null;
    board.invalidate();
  }

  /** The squares under a brush centred on a world point. */
  function brushCells(w) {
    const [c0, r0] = cellAt(w);
    const n = st.brush, lo = -Math.floor((n - 1) / 2);
    const out = [];
    for (let dc = lo; dc < lo + n; dc++) for (let dr = lo; dr < lo + n; dr++) if (inScene(c0 + dc, r0 + dr)) out.push(cellKey(c0 + dc, r0 + dr));
    return out;
  }

  function rectCells(a, b) {
    const out = [];
    for (let c = Math.min(a[0], b[0]); c <= Math.max(a[0], b[0]); c++) {
      for (let r = Math.min(a[1], b[1]); r <= Math.max(a[1], b[1]); r++) if (inScene(c, r)) out.push(cellKey(c, r));
    }
    return out;
  }

  const outline = (ctx, color, draw) => { ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2 / board.cam.z; draw(); ctx.restore(); };
  const label = (ctx, text, x, y) => {
    ctx.save();
    ctx.font = `${14 / board.cam.z}px system-ui, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3 / board.cam.z;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
  };
  /** Ctrl (Cmd on a Mac) held: don't snap. */
  const free = (e) => !!(e?.ctrlKey || e?.metaKey);
  const mods = (e) => ({ shiftKey: !!e.shiftKey, altKey: !!e.altKey, free: free(e) });
  const track = (w, e) => { st.hover = w; st.mods = mods(e); };
  const fine = (v) => Math.round(v * 100) / 100; // squares, to a hundredth
  // Show the change as soon as a key goes down or up, without waiting for the mouse to move.
  for (const type of ['keydown', 'keyup']) {
    addEventListener(type, (e) => {
      if (!board.tool.startsWith('sketch-') || !['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return;
      st.mods = mods(e);
      if (st.drag && st.hover) board.toolHandlers[board.tool]?.move?.(st.hover, e); else board.invalidate();
    });
  }
  const base = (extra) => ({
    key: keys,
    leave() { st.hover = null; st.drag = null; setDraft(null); },
    ...extra,
  });

  // ---------------------------------------------------------------- rectangles: room and floor

  const rectTool = (kind) => base({
    cursor: 'crosshair',
    down(w, e) { const c = cellAt(w); st.drag = { a: c, b: c, erase: e.shiftKey }; this.move(w, e); },
    move(w, e) {
      track(w, e);
      if (!st.drag) { board.invalidate(); return; }
      st.drag.b = cellAt(w);
      const keys_ = rectCells(st.drag.a, st.drag.b);
      setDraft(st.drag.erase ? paint.erase(keys_) : paint[kind](keys_, st.material));
    },
    up() {
      if (!st.drag) return;
      const patch = board.sketchDraft?.patch;
      st.drag = null;
      setDraft(null);
      if (patch) commit(patch);
    },
    draw(ctx) {
      if (st.drag) {
        const { a, b, erase } = st.drag;
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]) + 1, h = Math.abs(a[1] - b[1]) + 1;
        outline(ctx, erase ? ERASE : HOVER, () => ctx.strokeRect(x * g(), y * g(), w * g(), h * g()));
        label(ctx, `${w} × ${h}`, x * g() + 4 / board.cam.z, y * g() - 6 / board.cam.z);
      } else if (st.hover) {
        const [c, r] = cellAt(st.hover);
        outline(ctx, st.mods.shiftKey ? ERASE : HOVER, () => ctx.strokeRect(c * g(), r * g(), g(), g()));
      }
    },
  });
  board.registerTool('sketch-room', rectTool('room'));
  board.registerTool('sketch-floor', rectTool('floor'));

  // ---------------------------------------------------------------- brushes

  const brushTool = (eraser) => base({
    cursor: 'crosshair',
    down(w, e) { st.drag = { erase: eraser || e.shiftKey, keys: new Set(), last: null }; this.move(w, e); },
    move(w, e) {
      track(w, e);
      if (!st.drag) { board.invalidate(); return; }
      // Fill in between pointer events, so a quick stroke leaves no gaps.
      const from = st.drag.last ?? w;
      const steps = Math.max(1, Math.ceil(Math.hypot(w.x - from.x, w.y - from.y) / (g() / 3)));
      for (let i = 1; i <= steps; i++) {
        for (const k of brushCells({ x: from.x + ((w.x - from.x) * i) / steps, y: from.y + ((w.y - from.y) * i) / steps })) st.drag.keys.add(k);
      }
      st.drag.last = w;
      setDraft(st.drag.erase ? paint.erase([...st.drag.keys]) : paint.floor([...st.drag.keys], st.material));
    },
    up() {
      if (!st.drag) return;
      const patch = board.sketchDraft?.patch;
      st.drag = null;
      setDraft(null);
      if (patch) commit(patch);
    },
    draw(ctx) {
      if (!st.hover || st.drag) return;
      outline(ctx, eraser || st.mods.shiftKey ? ERASE : HOVER, () => {
        for (const k of brushCells(st.hover)) { const [c, r] = cellOf(k); ctx.strokeRect(c * g(), r * g(), g(), g()); }
      });
    },
  });
  board.registerTool('sketch-brush', brushTool(false));
  board.registerTool('sketch-erase', brushTool(true));

  // ---------------------------------------------------------------- round rooms

  const half = (v) => Math.round(v * 2) / 2; // to the nearest half square
  board.registerTool('sketch-round', base({
    cursor: 'crosshair',
    down(w, e) {
      if (e.shiftKey) {
        // Remove the smallest round room or floor under the pointer.
        const p = { x: w.x / g(), y: w.y / g() };
        const hit = Object.entries(current().shapes).filter(([, s]) => (p.x - s.x) ** 2 + (p.y - s.y) ** 2 <= s.r * s.r).sort((a, b) => a[1].r - b[1].r)[0];
        if (hit) commit({ shapes: { [hit[0]]: null } }); else toast('Shift-click a round room to remove it.');
        return;
      }
      const snap = free(e) ? fine : half;
      st.drag = { c: { x: snap(w.x / g()), y: snap(w.y / g()) }, r: 0, walled: !e.altKey, id: newId() };
      this.move(w, e);
    },
    move(w, e) {
      track(w, e);
      const d = st.drag;
      if (!d) { board.invalidate(); return; }
      const r = Math.hypot(w.x / g() - d.c.x, w.y / g() - d.c.y);
      d.r = free(e) ? Math.max(0.1, fine(r)) : Math.max(0.5, half(r));
      d.walled = !e.altKey;
      setDraft({ shapes: { [d.id]: { kind: 'circle', x: d.c.x, y: d.c.y, r: d.r, material: st.material, walled: d.walled } } });
    },
    up() {
      const d = st.drag;
      if (!d) return;
      const patch = board.sketchDraft?.patch;
      st.drag = null;
      setDraft(null);
      if (patch && d.r > 0) commit(patch);
    },
    draw(ctx) {
      const d = st.drag;
      if (d) {
        outline(ctx, HOVER, () => { ctx.beginPath(); ctx.arc(d.c.x * g(), d.c.y * g(), 3 / board.cam.z, 0, Math.PI * 2); ctx.fill(); });
        label(ctx, `${d.r * 2} across${d.walled ? '' : ', no walls'}`, (d.c.x + d.r) * g() + 6 / board.cam.z, d.c.y * g());
      } else if (st.hover) {
        const snap = st.mods.free ? fine : half;
        const x = snap(st.hover.x / g()) * g(), y = snap(st.hover.y / g()) * g();
        outline(ctx, st.mods.shiftKey ? ERASE : HOVER, () => { ctx.beginPath(); ctx.arc(x, y, 4 / board.cam.z, 0, Math.PI * 2); ctx.fill(); });
      }
    },
  }));

  // ---------------------------------------------------------------- walls

  /** Is this edge one of a room square's own (room on one side only)? */
  const roomEdge = (e, sk) => {
    const [dir, rest] = e.split(':');
    const [c, r] = cellOf(rest);
    const other = dir === 'h' ? cellKey(c, r - 1) : cellKey(c - 1, r);
    return (cellKey(c, r) in sk.cells) !== (other in sk.cells);
  };

  const wallTool = (railing) => base({
    cursor: 'crosshair',
    down(w, e) { const a = endAt(w, e); st.drag = { a, b: a, remove: e.shiftKey }; this.move(w, e); },
    move(w, e) {
      track(w, e);
      if (st.drag) st.drag.b = endAt(w, e);
      board.invalidate();
    },
    up(w) {
      const d = st.drag;
      st.drag = null;
      if (!d) return;
      const sk = current();
      if (d.a[0] === d.b[0] && d.a[1] === d.b[1]) {
        if (!d.remove) return;
        // Shift-click: remove the diagonal wall under the pointer.
        const hit = lineAt(w, sk);
        if (hit) commit({ lines: { [hit]: null } });
        return;
      }
      const onGrid = d.a.concat(d.b).every(Number.isInteger);
      const along = onGrid ? edgesAlong(d.a, d.b) : null;
      if (along && railing) {
        // A railing on an edge (taking the place of a room's wall there); Shift takes it away.
        const edges = {};
        for (const e of along) edges[e] = d.remove ? (sk.edges[e] === 'railing' ? null : sk.edges[e] ?? null) : 'railing';
        commit({ edges });
      } else if (!along && railing && !d.remove) {
        commit({ lines: { [newId()]: { a: d.a, b: d.b, kind: 'window', style: 'railing' } } });
      } else if (along) {
        // A room's own wall needs nothing set (clearing "open" or a door brings it back); taking
        // it away sets "open". Elsewhere an edge is a wall or nothing.
        const own = (e) => sk.walls !== false && roomEdge(e, sk);
        const edges = {};
        for (const e of along) edges[e] = d.remove ? (own(e) ? 'open' : null) : (own(e) ? null : 'wall');
        commit({ edges });
      } else if (!d.remove) {
        commit({ lines: { [newId()]: { a: d.a, b: d.b, kind: 'wall' } } });
      }
    },
    draw(ctx) {
      const d = st.drag;
      const z = board.cam.z;
      if (d) {
        outline(ctx, d.remove ? ERASE : HOVER, () => {
          ctx.lineWidth = 5 / z;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(d.a[0] * g(), d.a[1] * g()); ctx.lineTo(d.b[0] * g(), d.b[1] * g()); ctx.stroke();
        });
        const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
        if (len) label(ctx, `${Math.round(len * 10) / 10} squares`, d.b[0] * g() + 8 / z, d.b[1] * g());
      } else if (st.hover) {
        const [c, r] = endAt(st.hover, st.mods);
        outline(ctx, st.mods.shiftKey ? ERASE : HOVER, () => { ctx.beginPath(); ctx.arc(c * g(), r * g(), 4 / z, 0, Math.PI * 2); ctx.fill(); });
        if (st.mods.shiftKey) {
          const hit = lineAt(st.hover, current());
          const l = hit && current().lines[hit];
          if (l) outline(ctx, ERASE, () => { ctx.lineWidth = 6 / z; ctx.beginPath(); ctx.moveTo(l.a[0] * g(), l.a[1] * g()); ctx.lineTo(l.b[0] * g(), l.b[1] * g()); ctx.stroke(); });
        }
      }
    },
  });

  /** A wall's end: the nearest grid corner, or (Ctrl) right where the pointer is. In squares. */
  function endAt(w, e) {
    return free(e) || e?.free ? [fine(w.x / g()), fine(w.y / g())] : cornerAt(w);
  }

  board.registerTool('sketch-wall', wallTool(false));
  board.registerTool('sketch-railing', wallTool(true));

  // ---------------------------------------------------------------- roofs

  const roofAt = (w, sk) => Object.entries(sk.roofs).filter(([, r]) => w.x >= r.x * g() && w.x <= (r.x + r.w) * g() && w.y >= r.y * g() && w.y <= (r.y + r.h) * g()).sort((a, b) => a[1].w * a[1].h - b[1].w * b[1].h)[0]?.[0] ?? null;
  board.registerTool('sketch-roof', base({
    cursor: 'crosshair',
    enter() { api.sketchRefit(); api.controls?.render(); },
    down(w, e) {
      if (e.shiftKey) {
        const hit = roofAt(w, current());
        if (hit) commit({ roofs: { [hit]: null } }); else toast('Shift-click a roof to remove it.');
        return;
      }
      const c = cellAt(w);
      st.drag = { a: c, b: c };
      this.move(w, e);
    },
    move(w, e) {
      track(w, e);
      const d = st.drag;
      if (!d) { board.invalidate(); return; }
      d.b = cellAt(w);
      const x = Math.min(d.a[0], d.b[0]), y = Math.min(d.a[1], d.b[1]);
      d.roof = { x, y, w: Math.abs(d.a[0] - d.b[0]) + 1, h: Math.abs(d.a[1] - d.b[1]) + 1, material: st.roof };
      board.invalidate();
    },
    up() {
      const d = st.drag;
      st.drag = null;
      if (d?.roof) commit({ roofs: { [newId()]: d.roof } });
    },
    draw(ctx) {
      const d = st.drag;
      if (d?.roof) {
        drawRoof(ctx, d.roof, g(), board, 0.8);
        label(ctx, `${d.roof.w} × ${d.roof.h}`, d.roof.x * g() + 4 / board.cam.z, d.roof.y * g() - 6 / board.cam.z);
      } else if (st.hover) {
        const hit = st.mods.shiftKey && roofAt(st.hover, current());
        if (hit) { const r = current().roofs[hit]; outline(ctx, ERASE, () => ctx.strokeRect(r.x * g(), r.y * g(), r.w * g(), r.h * g())); return; }
        const [c, r] = cellAt(st.hover);
        outline(ctx, HOVER, () => ctx.strokeRect(c * g(), r * g(), g(), g()));
      }
    },
  }));

  /** The diagonal wall within a few pixels of a point, if any. */
  function lineAt(w, sk) {
    const tol = 8 / board.cam.z;
    let best = null, bestD = tol;
    for (const [id, l] of Object.entries(sk.lines)) {
      const ax = l.a[0] * g(), ay = l.a[1] * g(), dx = l.b[0] * g() - ax, dy = l.b[1] * g() - ay;
      const t = Math.max(0, Math.min(1, ((w.x - ax) * dx + (w.y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const dist = Math.hypot(w.x - (ax + t * dx), w.y - (ay + t * dy));
      if (dist < bestD) { best = id; bestD = dist; }
    }
    return best;
  }

  // ---------------------------------------------------------------- doors and windows

  const openingTool = (kind) => base({
    cursor: 'pointer',
    down(w, e) {
      const edge = edgeNear(w, g());
      if (!edge) return;
      const k = kind === 'door' && e.shiftKey ? 'secret_door' : kind;
      commit({ edges: { [edge]: current().edges[edge] === k ? null : k } });
    },
    move(w, e) { track(w, e); board.invalidate(); },
    draw(ctx) {
      const edge = st.hover && edgeNear(st.hover, g());
      if (!edge) return;
      const { a, b } = edgeSegment(edge, g());
      const set = ['door', 'secret_door', 'window'].includes(current().edges[edge]);
      outline(ctx, set ? ERASE : HOVER, () => {
        ctx.lineWidth = 6 / board.cam.z;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
    },
  });
  board.registerTool('sketch-door', openingTool('door'));
  board.registerTool('sketch-window', openingTool('window'));

  // ---------------------------------------------------------------- props: place

  /**
   * Where a new prop goes (squares). A light source next to a wall is mounted on it; other props
   * snap to half squares. With Ctrl (or Cmd): exactly where the pointer is.
   */
  function propSpot(w, exact) {
    const x = w.x / g(), y = w.y / g();
    if (exact) return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    if (isLight(st.prop)) {
      const edge = edgeNear(w, g(), 0.22);
      if (edge) {
        const [dir, rest] = edge.split(':');
        const [c, r] = cellOf(rest);
        // On the edge's middle, nudged off the wall to the pointer's side.
        return dir === 'h' ? { x: c + 0.5, y: r + (y < r ? -0.2 : 0.2) } : { x: c + (x < c ? -0.2 : 0.2), y: r + 0.5 };
      }
      return { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 };
    }
    // Snap the prop's corner to the grid when its size is whole squares, else its middle.
    const def = propDef(st.prop);
    const snap = (v, size) => (Number.isInteger(size) && size % 2 === 0 ? Math.round(v) : Math.floor(v) + 0.5);
    return { x: snap(x, def.w), y: snap(y, def.h) };
  }

  board.registerTool('sketch-place', base({
    cursor: 'crosshair',
    enter() { api.sketchRefit(); openPropPalette(); },
    down(w, e) {
      const def = propDef(st.prop);
      const id = newId();
      commit({ props: { [id]: { kind: st.prop, ...propSpot(w, free(e)), rot: 0, scale: 1, blocks: !!def.blocks } } });
      const s = scene();
      if (def.light && (s.darkness ?? 0) < 0.5 && !st.toldDark) {
        st.toldDark = true;
        toast('Light sources light the map once it\'s dark: Lighting → Day / night, or raise the darkness in the scene settings.');
      }
    },
    move(w, e) { track(w, e); board.invalidate(); },
    draw(ctx) {
      if (!st.hover) return;
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawPropAt(ctx, { kind: st.prop, ...propSpot(st.hover, st.mods.free) }, g(), { seed: 'preview' });
      ctx.restore();
    },
  }));

  /** The props palette: light sources, then furniture and nature. */
  function openPropPalette() {
    const win = openWindow({ id: 'sketch-props', title: 'Props', width: 330 });
    const section = (title, list) => [
      el('div.small.muted', { text: title, style: 'margin: 6px 0 4px' }),
      el('div.prop-grid', {}, ...list.map((p) => el('button', {
        class: st.prop === p.id ? 'prop-pick active' : 'prop-pick', title: p.label, type: 'button',
        on: { click: () => { st.chooseProp(p.id); openPropPalette(); } },
      }, el('img', { src: propThumb(p.id), alt: '' }), el('span', { text: p.label })))),
    ];
    win.body.replaceChildren(
      el('p.small.muted', { text: 'Click the map to place; light sources next to a wall go on the wall. Hold Ctrl (Cmd on a Mac) to place it exactly, without snapping. Move, turn and resize props with the Select tool.' }),
      ...section('Light sources (each brings its light)', LIGHTS),
      ...section('Furniture and nature', FURNITURE),
    );
  }
  st.openPropPalette = openPropPalette;

  // ---------------------------------------------------------------- select: move, resize, turn, remove

  const PAD = () => 6 / board.cam.z;
  const HANDLE = () => 7 / board.cam.z;
  const segDist = (w, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((w.x - a[0]) * dx + (w.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(w.x - (a[0] + t * dx), w.y - (a[1] + t * dy));
  };
  const OPENINGS = ['door', 'secret_door', 'window'];

  /** What's under a point, topmost first: a prop, a door or window, a wall, a round room. */
  function pick(w, sk) {
    const area = (p) => { const d = propDef(p.kind); return d.w * d.h * (p.scale ?? 1) ** 2; };
    const props = Object.entries(sk.props).filter(([, p]) => propHit(p, g(), w, PAD())).sort((a, b) => area(a[1]) - area(b[1]));
    if (props.length) return { type: 'prop', id: props[0][0] };
    const edge = edgeNear(w, g(), 0.2);
    if (edge && OPENINGS.includes(sk.edges[edge])) return { type: 'opening', id: edge };
    let best = null, bestD = PAD() + 2;
    for (const wall of Object.values(sketchWalls(sk, g()))) {
      if (wall.src?.prop || wall.src?.opening) continue;
      const d = segDist(w, wall.a, wall.b);
      if (d < bestD) { best = wall; bestD = d; }
    }
    if (best?.src?.line) return { type: 'line', id: best.src.line };
    if (best?.src?.shape) return { type: 'shape', id: best.src.shape };
    if (best?.src?.edges) return { type: 'wall', edges: best.src.edges };
    const shapes = Object.entries(sk.shapes).filter(([, s]) => (w.x / g() - s.x) ** 2 + (w.y / g() - s.y) ** 2 <= s.r * s.r).sort((a, b) => a[1].r - b[1].r);
    if (shapes.length) return { type: 'shape', id: shapes[0][0] };
    const roof = roofAt(w, sk);
    if (roof) return { type: 'roof', id: roof };
    return null;
  }

  const itemOf = (sel, sk) => {
    if (!sel) return null;
    if (sel.type === 'prop') return sk.props[sel.id];
    if (sel.type === 'shape') return sk.shapes[sel.id];
    if (sel.type === 'line') return sk.lines[sel.id];
    if (sel.type === 'roof') return sk.roofs[sel.id];
    if (sel.type === 'opening') return OPENINGS.includes(sk.edges[sel.id]) ? { kind: sk.edges[sel.id] } : null;
    if (sel.type === 'wall') return sel.edges?.length ? {} : null;
    return null;
  };

  /** The selection's handles (scene px): resize, turn, or a line's ends. */
  function handlesOf(sel, sk) {
    const it = itemOf(sel, sk);
    if (!it) return [];
    if (sel.type === 'prop') {
      const def = propDef(it.kind), sc = it.scale ?? 1, a = ((it.rot ?? 0) * Math.PI) / 180;
      const hw = (def.w * sc * g()) / 2, hh = (def.h * sc * g()) / 2;
      const at = (lx, ly) => ({ x: it.x * g() + lx * Math.cos(a) - ly * Math.sin(a), y: it.y * g() + lx * Math.sin(a) + ly * Math.cos(a) });
      return [{ kind: 'resize', ...at(hw, hh) }, { kind: 'rotate', ...at(0, -hh - 0.35 * g()) }];
    }
    if (sel.type === 'shape') return [{ kind: 'resize', x: (it.x + it.r) * g(), y: it.y * g() }];
    if (sel.type === 'roof') return [{ kind: 'resize', x: (it.x + it.w) * g(), y: (it.y + it.h) * g() }];
    if (sel.type === 'line') return [{ kind: 'a', x: it.a[0] * g(), y: it.a[1] * g() }, { kind: 'b', x: it.b[0] * g(), y: it.b[1] * g() }];
    return [];
  }

  /** Take the selection away. */
  function removeSelected() {
    const sel = st.sel, sk = current();
    if (!itemOf(sel, sk)) return;
    if (sel.type === 'prop') commit({ props: { [sel.id]: null } });
    else if (sel.type === 'shape') commit({ shapes: { [sel.id]: null } });
    else if (sel.type === 'line') commit({ lines: { [sel.id]: null } });
    else if (sel.type === 'roof') commit({ roofs: { [sel.id]: null } });
    else if (sel.type === 'opening') commit({ edges: { [sel.id]: null } });
    else if (sel.type === 'wall') {
      const edges = {};
      for (const e of sel.edges) edges[e] = sk.edges[e] === 'wall' ? null : 'open';
      commit({ edges });
    }
    select(null);
  }

  /** Change the selected item: `fn(copy)` edits a copy, which is sent. */
  function editSelected(fn) {
    const sel = st.sel, sk = current();
    const it = itemOf(sel, sk);
    if (!it) return;
    const copy = structuredClone(it);
    fn(copy);
    const map = { prop: 'props', shape: 'shapes', line: 'lines', roof: 'roofs' }[sel.type];
    if (map) commit({ [map]: { [sel.id]: copy } });
  }

  function select(sel) {
    st.sel = sel;
    renderBar();
    board.invalidate();
  }

  const snapTo = (v, step) => Math.round(Math.round(v / step) * step * 10000) / 10000;

  board.registerTool('sketch-select', base({
    cursor: 'default',
    enter() { api.sketchRefit(); renderBar(); },
    leave() { st.hover = null; st.drag = null; setDraft(null); renderBar(); },
    down(w) {
      const sk = current();
      const h = handlesOf(st.sel, sk).find((x) => Math.hypot(x.x - w.x, x.y - w.y) <= HANDLE() * 1.6);
      if (h) { st.drag = { mode: h.kind, start: w, orig: structuredClone(itemOf(st.sel, sk)), moved: false }; return; }
      const hit = pick(w, sk);
      select(hit);
      if (hit && hit.type !== 'wall') st.drag = { mode: 'move', start: w, orig: structuredClone(itemOf(hit, sk)), moved: false };
    },
    move(w, e) {
      track(w, e);
      const d = st.drag;
      if (!d) { board.invalidate(); return; }
      if (!d.moved && Math.hypot(w.x - d.start.x, w.y - d.start.y) < 4 / board.cam.z) return;
      d.moved = true;
      const sel = st.sel, o = d.orig, G = g();
      const dx = (w.x - d.start.x) / G, dy = (w.y - d.start.y) / G;
      let patch = null;
      if (sel.type === 'prop') {
        const p = { ...o };
        if (d.mode === 'move') {
          const step = free(e) ? 0.01 : 0.25;
          p.x = snapTo(o.x + dx, step); p.y = snapTo(o.y + dy, step);
        } else if (d.mode === 'rotate') {
          const ang = (Math.atan2(w.y - o.y * G, w.x - o.x * G) * 180) / Math.PI + 90;
          p.rot = ((free(e) ? Math.round(ang) : snapTo(ang, 15)) + 360) % 360;
        } else if (d.mode === 'resize') {
          const d0 = Math.hypot(d.start.x - o.x * G, d.start.y - o.y * G) || 1;
          const d1 = Math.hypot(w.x - o.x * G, w.y - o.y * G);
          const sc = (o.scale ?? 1) * (d1 / d0);
          p.scale = Math.max(0.1, Math.min(8, free(e) ? Math.round(sc * 100) / 100 : snapTo(sc, 0.25)));
        }
        patch = { props: { [sel.id]: p } };
      } else if (sel.type === 'shape') {
        const s = { ...o };
        const step = free(e) ? 0.01 : 0.5;
        if (d.mode === 'move') { s.x = snapTo(o.x + dx, step); s.y = snapTo(o.y + dy, step); } else { s.r = Math.max(free(e) ? 0.1 : 0.5, snapTo(Math.hypot(w.x / G - o.x, w.y / G - o.y), step)); }
        patch = { shapes: { [sel.id]: s } };
      } else if (sel.type === 'line') {
        const l = { ...o };
        if (d.mode === 'move') { const mx = free(e) ? fine(dx) : Math.round(dx), my = free(e) ? fine(dy) : Math.round(dy); l.a = [fine(o.a[0] + mx), fine(o.a[1] + my)]; l.b = [fine(o.b[0] + mx), fine(o.b[1] + my)]; } else l[d.mode] = endAt(w, e);
        patch = { lines: { [sel.id]: l } };
      } else if (sel.type === 'roof') {
        const r = { ...o };
        if (d.mode === 'move') { r.x = o.x + Math.round(dx); r.y = o.y + Math.round(dy); } else { r.w = Math.max(1, Math.round(w.x / G - o.x)); r.h = Math.max(1, Math.round(w.y / G - o.y)); }
        patch = { roofs: { [sel.id]: r } };
      } else if (sel.type === 'opening') {
        const target = edgeNear(w, G, 0.5);
        d.target = target && target !== sel.id && !OPENINGS.includes(current().edges[target]) ? target : null;
        patch = d.target ? { edges: { [sel.id]: null, [d.target]: o.kind } } : null;
      }
      setDraft(patch);
    },
    up() {
      const d = st.drag;
      st.drag = null;
      const patch = board.sketchDraft?.patch;
      setDraft(null);
      if (!d?.moved || !patch) return;
      if (commit(patch) && st.sel.type === 'opening' && d.target) st.sel = { type: 'opening', id: d.target };
      renderBar();
    },
    key(e) {
      const sel = st.sel;
      if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { removeSelected(); return true; }
      if (sel && e.key === 'Escape') { select(null); return true; }
      if (sel?.type === 'prop' && e.key.toLowerCase() === 'r') { editSelected((p) => { p.rot = (((p.rot ?? 0) + (e.shiftKey ? -45 : 45)) % 360 + 360) % 360; }); return true; }
      if (sel && (e.key === '+' || e.key === '=' || e.key === '-')) {
        const up = e.key !== '-';
        if (sel.type === 'prop') editSelected((p) => { p.scale = Math.max(0.25, Math.min(8, (p.scale ?? 1) + (up ? 0.25 : -0.25))); });
        if (sel.type === 'shape') editSelected((s) => { s.r = Math.max(0.5, s.r + (up ? 0.5 : -0.5)); });
        return true;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (sel && arrows[e.key] && ['prop', 'shape', 'line'].includes(sel.type)) {
        const [ax, ay] = arrows[e.key];
        const step = free(e) ? 0.05 : sel.type === 'line' ? 1 : 0.5;
        editSelected((it) => {
          if (sel.type === 'line') { it.a = [fine(it.a[0] + ax * step), fine(it.a[1] + ay * step)]; it.b = [fine(it.b[0] + ax * step), fine(it.b[1] + ay * step)]; } else { it.x = Math.round((it.x + ax * step) * 100) / 100; it.y = Math.round((it.y + ay * step) * 100) / 100; }
        });
        return true;
      }
      return keys(e);
    },
    draw(ctx) {
      const sk = withPatch(scene()?.sketch, board.sketchDraft?.patch);
      const z = board.cam.z;
      const mark = (sel, color, dashed) => {
        const it = itemOf(sel, sk);
        if (!it) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 / z;
        if (dashed) ctx.setLineDash([6 / z, 4 / z]);
        ctx.beginPath();
        if (sel.type === 'roof') {
          ctx.rect(it.x * g(), it.y * g(), it.w * g(), it.h * g());
        } else if (sel.type === 'prop') {
          const pts = propOutline(it, g());
          pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
          ctx.closePath();
        } else if (sel.type === 'shape') {
          ctx.arc(it.x * g(), it.y * g(), it.r * g(), 0, Math.PI * 2);
        } else if (sel.type === 'line') {
          ctx.lineWidth = 6 / z;
          ctx.moveTo(it.a[0] * g(), it.a[1] * g()); ctx.lineTo(it.b[0] * g(), it.b[1] * g());
        } else {
          ctx.lineWidth = 6 / z;
          for (const e of sel.type === 'wall' ? sel.edges : [st.drag?.target ?? sel.id]) { const s = edgeSegment(e, g()); ctx.moveTo(...s.a); ctx.lineTo(...s.b); }
        }
        ctx.stroke();
        ctx.restore();
      };
      if (st.hover && !st.drag) {
        const h = pick(st.hover, sk);
        if (h && JSON.stringify(h) !== JSON.stringify(st.sel)) mark(h, 'rgba(255, 190, 40, 0.5)', true);
      }
      if (st.sel) {
        mark(st.sel, HOVER, false);
        for (const h of handlesOf(st.sel, sk)) {
          ctx.save();
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5 / z;
          ctx.beginPath();
          if (h.kind === 'rotate') ctx.arc(h.x, h.y, HANDLE() * 0.8, 0, Math.PI * 2); else ctx.rect(h.x - HANDLE() / 2, h.y - HANDLE() / 2, HANDLE(), HANDLE());
          ctx.fill(); ctx.stroke();
          ctx.restore();
        }
      }
    },
  }));

  // ---------------------------------------------------------------- the selection bar

  const bar = el('div.sketch-bar', { hidden: true });
  document.getElementById('app')?.append(bar);
  hooks.on('op:sketch_update', () => renderBar());
  hooks.on('op:light_update', () => renderBar());
  hooks.on('board:tool', () => renderBar());

  function renderBar() {
    const sk = current();
    const show = board.tool === 'sketch-select' && isGM() && !!scene();
    bar.hidden = !show;
    if (!show) return;
    if (st.sel && !itemOf(st.sel, sk)) st.sel = null;
    const sel = st.sel;
    const btn = (text, title, fn, cls = '') => el('button', { type: 'button', class: cls, title, text, on: { click: fn } });
    const styleSelect = (value, set) => el('select', { title: 'How the wall is drawn', on: { change: (e) => set(e.target.value || null) } },
      el('option', { value: '', text: `Style: default (${WALL_STYLES.find((x) => x.id === (sk.wall_style || 'ink'))?.label})`, selected: !value }),
      ...WALL_STYLES.map((x) => el('option', { value: x.id, text: x.label, selected: value === x.id })));
    const del = btn('Delete', 'Remove it (Delete)', removeSelected, 'danger');
    let items;
    if (!sel) {
      items = [el('span.muted', { text: 'Click a prop, door, window, wall, round room or roof to select it. Drag to move; handles resize and turn.' })];
    } else if (sel.type === 'prop') {
      const p = sk.props[sel.id], def = propDef(p.kind);
      items = [
        el('b', { text: def.label }),
        btn('⟲', 'Turn left (Shift+R)', () => editSelected((x) => { x.rot = (((x.rot ?? 0) - 45) % 360 + 360) % 360; })),
        btn('⟳', 'Turn right (R)', () => editSelected((x) => { x.rot = ((x.rot ?? 0) + 45) % 360; })),
        btn('−', 'Smaller (-)', () => editSelected((x) => { x.scale = Math.max(0.25, (x.scale ?? 1) - 0.25); })),
        el('span.muted', { text: `${Math.round((p.scale ?? 1) * 100)}%` }),
        btn('+', 'Bigger (+)', () => editSelected((x) => { x.scale = Math.min(8, (x.scale ?? 1) + 0.25); })),
      ];
      if (def.block) {
        items.push(el('label.check', {}, el('input', { type: 'checkbox', checked: !!p.blocks, on: { change: (e) => editSelected((x) => { x.blocks = e.target.checked; }) } }),
          def.block === 'wall' ? ' Blocks movement and sight' : ' Blocks movement'));
      }
      if (def.light) {
        const lid = skId(`sk-p-${sel.id}`, board.level);
        const light = scene().lights?.[lid];
        items.push(el('label.check', {}, el('input', { type: 'checkbox', checked: !light?.off, on: { change: (e) => api.op({ op: 'light_update', scene_id: scene().id, id: lid, patch: { off: !e.target.checked } }) } }), ' Lit'));
      }
      if (def.link) {
        // Stairs, ladders: the level they lead to.
        const others = levelsOf(scene()).filter((l) => l.id !== board.level);
        items.push(el('select', { title: 'Where it leads: a token that steps onto it goes to that level', on: { change: (e) => editSelected((x) => { x.to = e.target.value === '-' ? null : e.target.value; }) } },
          el('option', { value: '-', text: others.length ? 'Leads nowhere' : 'Leads nowhere (add levels first)', selected: p.to == null }),
          ...[...others].reverse().map((l) => el('option', { value: l.id, text: `Leads to ${l.name}`, selected: p.to === l.id }))));
      }
      items.push(del);
    } else if (sel.type === 'shape') {
      const s = sk.shapes[sel.id];
      items = [
        el('b', { text: s.walled !== false ? 'Round room' : 'Round floor' }),
        btn('−', 'Smaller (-)', () => editSelected((x) => { x.r = Math.max(0.5, x.r - 0.5); })),
        el('span.muted', { text: `${s.r * 2} across` }),
        btn('+', 'Bigger (+)', () => editSelected((x) => { x.r += 0.5; })),
        el('label.check', {}, el('input', { type: 'checkbox', checked: s.walled !== false, on: { change: (e) => editSelected((x) => { x.walled = e.target.checked; }) } }), ' Walls'),
      ];
      if (s.walled !== false) items.push(styleSelect(s.wall_style, (v) => editSelected((x) => { x.wall_style = v; })));
      items.push(del);
    } else if (sel.type === 'line') {
      const l = sk.lines[sel.id];
      items = [el('b', { text: 'Diagonal wall' }), styleSelect(l.style, (v) => editSelected((x) => { x.style = v; })), del];
    } else if (sel.type === 'wall') {
      const style = sk.styles[sel.edges[0]] ?? null;
      items = [
        el('b', { text: `Wall, ${sel.edges.length} square${sel.edges.length > 1 ? 's' : ''}` }),
        styleSelect(style, (v) => commit({ styles: Object.fromEntries(sel.edges.map((e) => [e, v])) })),
        btn('Remove', 'Take this stretch of wall away (Delete)', removeSelected, 'danger'),
      ];
    } else if (sel.type === 'roof') {
      const r = sk.roofs[sel.id];
      items = [
        el('b', { text: `Roof, ${r.w} × ${r.h}` }),
        el('select', { title: 'What it\'s made of', on: { change: (e) => editSelected((x) => { x.material = e.target.value; }) } },
          ...ROOF_MATERIALS.map((m) => el('option', { value: m.id, text: m.label, selected: r.material === m.id }))),
        btn('Turn the ridge', 'The ridge runs the other way', () => editSelected((x) => { x.ridge = (x.ridge ?? (x.w >= x.h ? 'h' : 'v')) === 'h' ? 'v' : 'h'; })),
        del,
      ];
    } else if (sel.type === 'opening') {
      const kind = sk.edges[sel.id];
      items = [
        el('select', { title: 'What it is', on: { change: (e) => commit({ edges: { [sel.id]: e.target.value } }) } },
          ...[['door', 'Door'], ['secret_door', 'Secret door'], ['window', 'Window'], ['railing', 'Railing']].map(([v, t]) => el('option', { value: v, text: t, selected: kind === v }))),
        el('span.muted', { text: 'Drag it to another edge.' }),
        del,
      ];
    }
    bar.replaceChildren(...items);
  }
  st.renderBar = renderBar;

  // ---------------------------------------------------------------- keys, refit

  function keys(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undo(); return true; }
    if (e.key === '[' || e.key === ']') {
      st.brush = Math.max(1, Math.min(9, st.brush + (e.key === ']' ? 1 : -1)));
      toast(`Brush: ${st.brush} × ${st.brush} squares`);
      board.invalidate();
      return true;
    }
    if (e.key === 'Escape') { board.setTool('select'); return true; }
    return false;
  }

  // When the grid's size changed since the walls were worked out, work them out again.
  api.sketchRefit = () => {
    const s = scene();
    const sk = sketchOf(s, board.level);
    if (!sk || !isGM() || sk.size === g()) return;
    send(s, { size: g() });
  };
  for (const id of ['sketch-room', 'sketch-round', 'sketch-floor', 'sketch-brush', 'sketch-erase', 'sketch-wall', 'sketch-railing', 'sketch-door', 'sketch-window']) {
    const t = board.toolHandlers[id];
    t.enter = () => api.sketchRefit();
  }

  // ---------------------------------------------------------------- palette and settings

  /** Materials for the palette: the built-ins, then uploaded textures used on any scene. */
  st.materials = () => {
    if (board.tool === 'sketch-roof') return ROOF_MATERIALS;
    const uploaded = new Set();
    for (const s of Object.values(store.world?.scenes ?? {})) {
      const sk = s.sketch;
      if (!sk) continue;
      for (const m of [...Object.values(sk.cells ?? {}), ...Object.values(sk.floor ?? {}), ...Object.values(sk.shapes ?? {}).map((x) => x.material), sk.outside]) {
        if (m && !texture(m)) uploaded.add(m);
      }
    }
    for (const m of st.extra ?? []) uploaded.add(m.id);
    return [...MATERIALS, ...[...uploaded].map((url) => ({ id: url, label: st.extra?.find((m) => m.id === url)?.label ?? url.split('/').pop() }))];
  };
  st.props = () => [...LIGHTS, ...FURNITURE];

  st.roof = 'shingles';
  st.choose = (id) => {
    if (board.tool === 'sketch-roof') { st.roof = id; return; }
    st.material = id;
    if (!PAINT_TOOLS.includes(board.tool)) board.setTool('sketch-room');
  };
  /** Which swatch is chosen: the roof's while roofing, else the floor's. */
  st.chosen = () => (board.tool === 'sketch-roof' ? st.roof : st.material);
  st.chooseProp = (id) => {
    st.prop = id;
    if (board.tool !== 'sketch-place') board.setTool('sketch-place');
    api.controls?.render();
  };

  st.uploadTexture = () => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const url = await api.upload(f);
        st.extra = [...(st.extra ?? []), { id: url, label: f.name }];
        st.choose(url);
        api.controls?.render();
        toast(`${f.name} is ready: paint with it (it repeats every four squares).`);
      } catch (err) { toast(`Upload failed: ${err.message ?? err}`, 'error'); }
    };
    input.click();
  };

  st.settings = async () => {
    const s = scene();
    if (!s) return;
    const sk = sketchOf(s, board.level) ?? { outside: board.level || s.background ? null : 'rock', walls: true };
    const out = await formDialog({
      title: 'Sketch settings',
      fields: [
        { name: 'outside', label: 'Around the floor', type: 'select', value: sk.outside ?? '', options: [['', 'Nothing: show the map underneath'], ...st.materials().map((m) => [m.id, m.label])] },
        { name: 'wall_style', label: 'Walls look like', type: 'select', value: sk.wall_style ?? 'ink', options: WALL_STYLES.map((x) => [x.id, x.label]) },
        { name: 'walls', label: 'Walls round the rooms (they block sight and movement)', type: 'checkbox', value: sk.walls ?? true },
      ],
    });
    if (out) commit({ outside: out.outside || null, walls: !!out.walls, wall_style: out.wall_style === 'ink' ? null : out.wall_style });
  };

  /**
   * Copy the level below's walls up to this level (a hall two storeys tall, a tower): its rooms'
   * walls, doors and windows become plain walls here, and its diagonals come too. Round rooms'
   * walls aren't copied.
   */
  st.copyWallsBelow = () => {
    const s = scene();
    const below = s && levelsOf(s).filter((l) => l.elevation < (levelsOf(s).find((x) => x.id === board.level)?.elevation ?? 0)).at(-1);
    if (!below) { toast('There is no level below this one.'); return; }
    const sk = current();
    const edges = {}, lines = {};
    let round = 0;
    for (const w of Object.values(sketchWalls(sketchOf(s, below.id), g(), below.id))) {
      if (w.src?.edges && w.kind === 'wall') for (const e of w.src.edges) { if (!(e in sk.edges)) edges[e] = 'wall'; }
      else if (w.src?.opening && !(w.src.opening in sk.edges)) edges[w.src.opening] = 'wall';
      else if (w.src?.line) { const l = sketchOf(s, below.id).lines[w.src.line]; lines[newId()] = { a: l.a, b: l.b, kind: 'wall', ...(l.style ? { style: l.style } : {}) }; }
      else if (w.src?.shape) round++;
    }
    const n = Object.keys(edges).length + Object.keys(lines).length;
    if (!n) { toast(`${below.name} has no walls to copy.`); return; }
    commit({ edges, lines });
    toast(`Copied ${below.name}'s walls up${round ? ' (round rooms\' walls aren\'t copied)' : ''}.`);
  };

  st.clear = () => {
    const s = scene();
    const sk = sketchOf(s, board.level);
    if (!sk || !MAPS.some((k) => Object.keys(sk[k] ?? {}).length)) { toast('There is no sketch here.'); return; }
    if (!confirm(`Erase the sketched map on ${levelsOf(s).length > 1 ? levelName(s, board.level) : 'this scene'}, with its walls, doors, windows, props and roofs?`)) return;
    st.undo = st.undo.filter((u) => u.sceneId !== s.id || (u.level ?? '') !== board.level);
    api.op({ op: 'sketch_update', scene_id: s.id, ...(board.level ? { level: board.level } : {}), patch: Object.fromEntries(MAPS.map((k) => [k, null])), walls: {}, lights: {}, links: {} });
  };
}
