// Align a scene's map image to its grid (GM). Drag from one grid corner drawn on the map to the
// corner a few squares across and down (3 × 3 to start); the box measures the map's squares.
// Then either:
//   - fit the grid to the map: the grid's squares become the measured size (to the pixel), or
//   - fit the map to the grid: the grid keeps its size,
// and in both cases the image is scaled and moved so its squares land exactly on the grid's
// (scene.background_fit). The grid itself always starts at the scene's top-left, so tokens,
// walls, snapping and measuring work as before.
import { el, openWindow } from './ui.js';
import { isGM } from './store.js';
import { sizeOf } from './media.js';

const LINE = 'rgba(255, 190, 40, 0.95)';
const FAINT = 'rgba(255, 190, 40, 0.45)';
const CONTENT = ['tokens', 'walls', 'drawings', 'lights', 'sounds'];


/** The scene size, in whole squares, that covers a map placed with `fit` ({ x, y, sx, sy }). */
export function coverScene(fit, img, size) {
  const squares = (end) => Math.max(1, Math.ceil(end / size - 1e-6));
  return { width: squares(fit.x + img.w * fit.sx) * size, height: squares(fit.y + img.h * fit.sy) * size };
}

export function registerGridAlign(api) {
  const board = api.board;
  let st = null; // { a, b, n, mode, dragging, win, undo, info }

  const scene = () => board.scene;
  const hasContent = (s) => CONTENT.some((k) => Object.keys(s?.[k] ?? {}).length);

  /** The box and the size of one square inside it. */
  function measure() {
    if (!st?.a || !st?.b) return null;
    const n = Math.max(1, Math.min(100, Math.round(st.n) || 1));
    const w = Math.abs(st.b.x - st.a.x), h = Math.abs(st.b.y - st.a.y);
    if (w < 8 || h < 8) return null;
    return { n, w, h, cw: w / n, ch: h / n, x0: Math.min(st.a.x, st.b.x), y0: Math.min(st.a.y, st.b.y) };
  }

  /** What applying would set: the grid size, the image's place and the scene's size. */
  function plan() {
    const s = scene();
    const m = measure();
    const img = board.background(s?.background);
    if (!s || !m || !img) return null;
    // Where the image is now: placed, or stretched over the scene.
    const { w: iw, h: ih } = sizeOf(img);
    const now = s.background_fit ?? { x: 0, y: 0, sx: s.width / iw, sy: s.height / ih };
    const size = st.mode === 'grid' ? Math.max(10, Math.round((m.cw + m.ch) / 2)) : (s.grid?.size ?? 70);
    const sx = now.sx * size / m.cw;
    const sy = now.sy * size / m.ch;
    // The box's corner, in image pixels, goes onto the grid line nearest where it was.
    const ix = (m.x0 - now.x) / now.sx;
    const iy = (m.y0 - now.y) / now.sy;
    let x = Math.round(m.x0 / m.cw) * size - ix * sx;
    let y = Math.round(m.y0 / m.ch) * size - iy * sy;
    // On an empty scene, start the map in the top-left square (cropping less than a square).
    if (!hasContent(s)) { x -= Math.ceil(x / size) * size; y -= Math.ceil(y / size) * size; }
    const width = Math.max(size, Math.ceil((x + iw * sx) / size) * size);
    const height = Math.max(size, Math.ceil((y + ih * sy) / size) * size);
    return { size, fit: { x, y, sx, sy }, width, height, m };
  }

  function apply() {
    const s = scene();
    const p = plan();
    if (!s || !p) return;
    st.undo = { background_fit: s.background_fit ? { ...s.background_fit } : null, width: s.width, height: s.height, grid: { size: s.grid?.size ?? 70 } };
    api.update.scene(s.id, { background_fit: p.fit, width: p.width, height: p.height, grid: { size: p.size } });
    st.a = st.b = null;
    st.applied = `Done: squares are ${p.size} px and the map is lined up with them. Check a few squares across the map; drag again to refine.`;
    render();
    board.invalidate();
  }

  function undo() {
    const s = scene();
    if (!s || !st?.undo) return;
    api.update.scene(s.id, st.undo);
    st.undo = null;
    st.applied = 'Undone: the grid and map are back as they were.';
    render();
  }

  /** The map at its own size and shape again (1:1 at the top-left), the scene around it. */
  function reset() {
    const s = scene();
    const img = board.background(s?.background);
    if (!s || !img) return;
    st.undo = { background_fit: s.background_fit ? { ...s.background_fit } : null, width: s.width, height: s.height, grid: { size: s.grid?.size ?? 70 } };
    const fit = { x: 0, y: 0, sx: 1, sy: 1 };
    const size = s.grid?.size ?? 70;
    const own = sizeOf(img);
    api.update.scene(s.id, { background_fit: fit, ...coverScene(fit, own, size) });
    st.applied = `The map is back to its own size (${own.w} × ${own.h} px). Drag across its squares to line it up.`;
    render();
  }

  // ---- the panel
  function render() {
    if (!st?.win) return;
    const s = scene();
    const body = st.win.body;
    if (!s?.background) {
      body.replaceChildren(el('p', { text: 'This scene has no map image. Add one in its settings (Scenes → ⚙), then align it here.' }));
      return;
    }
    const m = measure();
    const p = plan();
    const n = el('input', { type: 'number', min: 1, max: 100, value: st.n, style: 'width: 5em', on: { input: (e) => { st.n = Number(e.target.value) || 1; render(); board.invalidate(); } } });
    const lines = [];
    if (m) {
      lines.push(el('p', { text: `Box ${Math.round(m.w)} × ${Math.round(m.h)} px: one square is ${m.cw.toFixed(1)} × ${m.ch.toFixed(1)} px.` }));
      const skew = Math.abs(m.cw - m.ch) / ((m.cw + m.ch) / 2);
      if (skew > 0.02) lines.push(el('p.small.error-text', { text: `The squares come out ${Math.round(skew * 100)}% ${m.cw > m.ch ? 'wider than tall' : 'taller than wide'}: the map will be stretched a little to make them square. Check the box's corners, or measure a bigger block.` }));
    } else lines.push(el('p.muted', { text: 'Not measured yet.' }));
    const mode = (value, text) => el('label.check', {}, el('input', { type: 'radio', name: 'ga-mode', value, checked: st.mode === value, on: { change: () => { st.mode = value; render(); } } }), ` ${text}`);
    const fitGrid = m ? Math.max(10, Math.round((m.cw + m.ch) / 2)) : null;
    body.replaceChildren(...[
      el('p.small.muted', { text: `Drag on the map from a grid corner drawn on it to the corner ${st.n} squares across and ${st.n} down. Zoom in (mouse wheel) to be exact; right-drag pans. Arrow keys nudge the far corner (Shift: 10 px). Enter applies, Esc closes.` }),
      el('label', {}, 'Squares across the box ', n),
      ...lines,
      el('div.ga-modes', {},
        mode('grid', `Fit the grid to the map${fitGrid ? `: squares become ${fitGrid} px` : ''}`),
        mode('map', `Fit the map to the grid: squares stay ${s.grid?.size ?? 70} px`)),
      st.mode === 'grid' && hasContent(s) && fitGrid && fitGrid !== s.grid?.size
        ? el('p.small.error-text', { text: 'This scene already has tokens, walls or drawings. They stay where they are in pixels, so with a new square size they won\'t sit on the grid. "Fit the map to the grid" keeps them right.' }) : null,
      st.applied ? el('p.small', { text: st.applied }) : null,
      el('div.row', {},
        el('button.primary', { type: 'button', text: 'Apply', disabled: !p, on: { click: apply } }),
        st.undo ? el('button', { type: 'button', text: 'Undo', on: { click: undo } }) : null,
        el('span.grow'),
        el('button', { type: 'button', text: 'Original size', title: 'Put the map back at its own size and shape (1:1, top-left), the scene around it', on: { click: reset } }),
        el('button', { type: 'button', text: 'Close', on: { click: () => board.setTool('select') } }))].filter(Boolean));
  }

  board.registerTool('grid-align', {
    cursor: 'crosshair',
    enter() {
      if (!isGM()) { board.setTool('select'); return; }
      st = { a: null, b: null, n: 3, mode: hasContent(scene()) ? 'map' : 'grid', dragging: false, undo: null, applied: '' };
      st.win = openWindow({ id: 'grid-align', title: 'Align the map to the grid', width: 380 });
      st.win.onClose(() => { if (st) { st.win = null; if (board.tool === 'grid-align') board.setTool('select'); } });
      render();
    },
    leave() {
      const w = st?.win;
      st = null;
      w?.close();
      board.invalidate();
    },
    down(w) {
      if (!st) return;
      st.a = { x: w.x, y: w.y };
      st.b = { x: w.x, y: w.y };
      st.dragging = true;
      st.applied = '';
      board.invalidate();
    },
    move(w) {
      if (!st?.dragging) return;
      st.b = { x: w.x, y: w.y };
      board.invalidate();
    },
    up(w) {
      if (!st?.dragging) return;
      st.b = { x: w.x, y: w.y };
      st.dragging = false;
      render();
      board.invalidate();
    },
    key(e) {
      if (!st) return false;
      if (e.key === 'Escape') { board.setTool('select'); return true; }
      if (e.key === 'Enter') { apply(); return true; }
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d || !st.b) return false;
      const step = e.shiftKey ? 10 : 1;
      st.b = { x: st.b.x + d[0] * step, y: st.b.y + d[1] * step };
      render();
      board.invalidate();
      return true;
    },
    draw(ctx) {
      const s = scene();
      const m = measure();
      if (!s || !st?.a) return;
      const px = 1 / board.cam.z;
      ctx.save();
      if (m) {
        // The measured squares carried across the whole scene: they should sit on the map's.
        ctx.strokeStyle = FAINT;
        ctx.lineWidth = px;
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.beginPath();
        for (let x = m.x0 % m.cw; x <= s.width; x += m.cw) { ctx.moveTo(x, 0); ctx.lineTo(x, s.height); }
        for (let y = m.y0 % m.ch; y <= s.height; y += m.ch) { ctx.moveTo(0, y); ctx.lineTo(s.width, y); }
        ctx.stroke();
        // The box and its squares.
        ctx.setLineDash([]);
        ctx.strokeStyle = LINE;
        ctx.lineWidth = 2 * px;
        ctx.strokeRect(m.x0, m.y0, m.w, m.h);
        ctx.lineWidth = px;
        ctx.beginPath();
        for (let i = 1; i < m.n; i++) {
          ctx.moveTo(m.x0 + i * m.cw, m.y0); ctx.lineTo(m.x0 + i * m.cw, m.y0 + m.h);
          ctx.moveTo(m.x0, m.y0 + i * m.ch); ctx.lineTo(m.x0 + m.w, m.y0 + i * m.ch);
        }
        ctx.stroke();
      }
      // The two corners.
      ctx.fillStyle = LINE;
      for (const p of [st.a, st.b].filter(Boolean)) { ctx.beginPath(); ctx.arc(p.x, p.y, 4 * px, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    },
  });
}
