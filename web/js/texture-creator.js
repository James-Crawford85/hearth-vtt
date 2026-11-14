// The texture creator (GM): a node editor, like a blueprint. Nodes make or change a picture
// (a texture, a colour, cloudy noise, levels, colour changes, blends); drag from a node's
// output (right) to another's input (left) to wire them; the Output node is the texture.
// Every node shows what it makes. Saved as a recipe in the world (texture_set);
// texture-recipes.js draws it. Opened from the texture pickers in the sketch tools' bar.
//
//   Right-click the grid, or Add node: add a node there.     Drag a node's title: move it.
//   Drag from an output to an input (or back): wire them.     Drag a wired input away: unwire.
//   Drag the grid: pan.  Wheel: zoom.  ✕ or Delete (selected node): remove it.
import { el, toast, openWindow } from './ui.js';
import { hooks } from './hooks.js';
import { MATERIALS, WALL_STYLES, ROOF_MATERIALS, texture } from './sketch-textures.js';
import { NODE_TYPES, LOADING, evalGraph, graphOf, newNode, outputOf, param, recipes, spanOf, setDraft } from './texture-recipes.js';
import { store } from './store.js';

const newId = () => Math.random().toString(36).slice(2, 10);
const EVAL = 256;  // pixels across when working out the previews

/** Built-in textures a node can use (each once). */
function builtIns() {
  const seen = new Set(), out = [];
  for (const m of [...MATERIALS, ...WALL_STYLES, ...ROOF_MATERIALS]) {
    if (seen.has(m.id) || !texture(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** Pictures uploaded for textures in this world: used on maps, or in other recipes. */
function uploads(extra = []) {
  const urls = new Set(extra);
  for (const sc of Object.values(store.world?.scenes ?? {})) {
    for (const sk of [sc.sketch, ...Object.values(sc.level_sketches ?? {})]) {
      if (!sk) continue;
      for (const m of [...Object.values(sk.cells ?? {}), ...Object.values(sk.floor ?? {}), ...Object.values(sk.shapes ?? {}).map((x) => x.material), sk.outside]) {
        if (m && !texture(m) && !m.startsWith('tex:')) urls.add(m);
      }
    }
  }
  for (const t of recipes()) {
    for (const n of Object.values(t.recipe?.nodes ?? {})) if (n.type === 'texture' && n.p?.src && !texture(n.p.src)) urls.add(n.p.src);
    for (const l of [t.recipe?.base, t.recipe?.overlay]) if (l?.src && !texture(l.src)) urls.add(l.src);
  }
  return [...urls];
}

/** How wide the Output node is drawn (its preview grows with it). */
const outSize = (node) => Math.max(190, Math.min(640, Number(node.p?.view) || 190));

/** Is `from` fed (directly or not) by `to`? Wiring from → to would then make a loop. */
function feeds(g, to, from) {
  const seen = new Set();
  const walk = (id) => {
    if (id === to) return true;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return Object.values(g.nodes[id]?.in ?? {}).some(walk);
  };
  return walk(from);
}

let active = null; // the open creator: { win, switchTo(id, onSaved) }

/**
 * Open the creator: a new texture, or (`id`) one of the world's to change; with the creator
 * already open, it switches to that one. `onSaved(id)` runs after its first save. Changes show
 * on the map as you make them (on your screen only); Save sends them to everyone.
 */
export function openTextureCreator(api, { id = null, onSaved } = {}) {
  if (active) {
    // Already open: go to the texture asked for (if any), and to the front.
    if (id || onSaved) active.switchTo(id ?? null, onSaved);
    active.win.el.dispatchEvent(new PointerEvent('pointerdown'));
    return active.win;
  }
  const win = openWindow({ id: 'texture-creator', title: 'Textures', width: Math.min(1100, innerWidth - 40), height: Math.min(680, innerHeight - 80) });
  win.el.classList.add('tex-window');
  let cur = null;        // the world texture being edited (null: a new one)
  let name = '';
  let saved = '';        // what was last loaded or saved, to tell unsaved changes
  let onSavedFn = onSaved;
  const g = { v: 2, nodes: {} };
  const snap = () => JSON.stringify({ name, nodes: g.nodes });
  const mine = [];       // pictures uploaded in this window
  const view = { x: 0, y: 0, z: 0.8 };
  let selected = null;
  let wiring = null;     // { from: node id } or { to: [node id, port] }, with the pointer
  let results = new Map();

  // ---- layout
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('ng-wires');
  const world = el('div.ng-world', {}, svg);
  const area = el('div.ng', { tabindex: '0' }, world, el('div.ng-hint.small.muted', { text: 'Right-click to add a node · drag from an output (right) to an input (left) to wire them · drag the grid to pan, wheel to zoom' }));
  const preview = el('canvas.tex-preview', { width: 300, height: 300 });
  const status = el('div.small.muted');
  const nameInput = el('input', { type: 'text', value: name, placeholder: 'Mossy flagstones', maxlength: 80, on: { input: (e) => { name = e.target.value; } } });
  const picker = el('select', { title: 'The texture you\'re working on', on: { change: (e) => switchTo(e.target.value || null) } });
  const actions = el('div.tex-actions');
  const addSelect = el('select', { title: 'Add a node in the middle of the view', on: { change: (e) => { if (e.target.value) addNode(e.target.value); e.target.value = ''; } } },
    el('option', { value: '', text: '+ Add node…' }), ...addOptions());
  const side = el('div.ng-side', {},
    el('label.tex-row', {}, el('span', { text: 'Texture' }), picker),
    el('label.tex-row', {}, el('span', { text: 'Name' }), nameInput),
    preview, status, addSelect, actions,
    el('div.small.muted', { text: 'Changes show on the map as you make them, on your screen only. Save sends them to everyone.' }));

  function renderPicker() {
    picker.replaceChildren(el('option', { value: '', text: '✦ New texture', selected: !cur }),
      ...recipes().map((t) => el('option', { value: t.id, text: t.name, selected: t.id === cur })));
  }
  function renderActions() {
    actions.replaceChildren(
      cur ? el('button.danger', { type: 'button', text: 'Delete', on: { click: remove } }) : null,
      el('span', { style: 'flex: 1' }),
      cur ? el('button', { type: 'button', text: 'Save as new', on: { click: () => save(true) } }) : null,
      el('button.primary', { type: 'button', text: 'Save', on: { click: () => save(false) } }));
  }

  /** Start editing a texture of the world's (or, with none, a new one). */
  function load(tid) {
    const t = tid ? store.world?.textures?.[tid] : null;
    cur = t ? tid : null;
    name = t?.name ?? '';
    g.nodes = graphOf(t?.recipe ?? null).nodes;
    nameInput.value = name;
    saved = snap();
    lastDraft = JSON.stringify(g.nodes);
    selected = null;
    win.setTitle(t ? `Texture: ${t.name}` : 'New texture');
    renderPicker();
    renderActions();
    build();
    requestAnimationFrame(() => { fitView(); drawWires(); });
    evaluate();
  }
  /** Go to another texture, after asking about unsaved changes. */
  function switchTo(tid, cb) {
    if (cb) onSavedFn = cb;
    if (tid === cur && (cur || snap() === saved)) { renderPicker(); return; }
    if (snap() !== saved && !confirm(`Leave ${name.trim() || 'this texture'} without saving? Your changes to it will be lost.`)) { renderPicker(); return; }
    if (cur) setDraft(cur, null);
    load(tid);
  }
  const offSaved = hooks.on('op:texture_set', () => renderPicker());
  const offDeleted = hooks.on('op:texture_delete', (op) => { if (op.id === cur) { cur = null; saved = ''; } renderPicker(); renderActions(); });
  win.body.replaceChildren(el('div.ng-layout', {}, area, side));

  function addOptions() {
    const groups = new Map();
    for (const [type, t] of Object.entries(NODE_TYPES)) if (t.group) { if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push([type, t.label]); }
    return [...groups].map(([group, list]) => el('optgroup', { label: group }, ...list.map(([v, t]) => el('option', { value: v, text: t }))));
  }

  // ---- the view
  const applyView = () => { world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`; };
  const toWorld = (cx, cy) => { const r = area.getBoundingClientRect(); return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z }; };
  function fitView() {
    const list = Object.values(g.nodes);
    const r = area.getBoundingClientRect();
    if (!list.length || !r.width) return;
    const x0 = Math.min(...list.map((n) => n.x)), y0 = Math.min(...list.map((n) => n.y));
    const x1 = Math.max(...list.map((n) => n.x)) + 220, y1 = Math.max(...list.map((n) => n.y)) + 300;
    view.z = Math.max(0.35, Math.min(1, Math.min(r.width / (x1 - x0 + 60), r.height / (y1 - y0 + 60))));
    view.x = (r.width - (x1 - x0) * view.z) / 2 - x0 * view.z;
    view.y = (r.height - (y1 - y0) * view.z) / 2 - y0 * view.z;
    applyView();
  }

  // ---- nodes
  const nodeEls = new Map();   // id → { box, ports: { in: { port: el }, out: el }, thumb }

  function paramControl(id, node, q) {
    const set = (v, structural = false) => { node.p[q.k] = v; if (structural) build(); evaluate(); };
    const v = param(node, q.k);
    if (q.kind === 'range') {
      const out = el('span.ng-val', { text: `${v}${q.unit ?? ''}` });
      return [el('input', { type: 'range', min: q.min, max: q.max, step: q.step ?? 1, value: v, on: { input: (e) => { out.textContent = `${e.target.value}${q.unit ?? ''}`; set(Number(e.target.value)); } } }), out];
    }
    if (q.kind === 'select') {
      return [el('select', { on: { change: (e) => set(typeof q.def === 'number' ? Number(e.target.value) : e.target.value) } },
        ...q.options.map(([ov, t]) => el('option', { value: ov, text: t, selected: String(ov) === String(v) })))];
    }
    if (q.kind === 'color') return [el('input', { type: 'color', value: v, on: { input: (e) => set(e.target.value) } })];
    if (q.kind === 'seed') {
      return [el('button', { type: 'button', text: `New pattern (${v})`, on: { click: (e) => { const nv = (Number(v) % 9999) + 1; e.target.textContent = `New pattern (${nv})`; set(nv, true); } } })];
    }
    if (q.kind === 'source') {
      const pics = uploads(mine);
      const opts = [...builtIns().map((m) => [m.id, m.label]), ...pics.map((u, i) => [u, `Picture ${i + 1}: ${decodeURIComponent(u.split('/').pop()).slice(0, 28)}`])];
      if (!opts.some(([ov]) => ov === v)) opts.push([v, String(v)]);
      return [
        el('select', { on: { change: (e) => { node.p.squares = 2; set(e.target.value, true); } } },
          ...opts.map(([ov, t]) => el('option', { value: ov, text: t, selected: ov === v }))),
        el('button', { type: 'button', text: 'Upload…', title: 'A picture of your own: a texture that repeats (photo-scanned ones work well)', on: { click: () => upload(node) } }),
      ];
    }
    return [];
  }

  function nodeBox(id, node) {
    const t = NODE_TYPES[node.type];
    const ports = { in: {}, out: null };
    const head = el('div.ng-head', {}, el('span', { text: t?.label ?? node.type }),
      node.type !== 'output' ? el('button.ng-x', { type: 'button', title: 'Remove this node', text: '✕', on: { click: (e) => { e.stopPropagation(); removeNode(id); } } }) : null);
    if (node.type !== 'output') {
      ports.out = el('span.ng-port.out', { title: 'Output: drag to another node\'s input' });
      head.append(ports.out);
    }
    const inputs = (t?.inputs ?? []).map(([port, label]) => {
      const dot = el('span.ng-port.in', { title: `${label}: drag here from an output`, class: node.in?.[port] ? 'ng-port in wired' : 'ng-port in' });
      dot.dataset.node = id;
      dot.dataset.port = port;
      ports.in[port] = dot;
      return el('div.ng-in', {}, dot, el('span', { text: label }));
    });
    if (ports.out) ports.out.dataset.node = id;
    const params = (t?.params ?? []).map((q) => el('label.ng-param', {}, el('span', { text: q.label }), ...paramControl(id, node, q)));
    const big = node.type === 'output' ? outSize(node) : 0;
    const side = big ? big - 20 : 120;
    const thumb = el('canvas.ng-thumb', { width: side, height: side, style: `width: ${side}px; height: ${side}px` });
    const box = el('div.ng-node', { class: `ng-node${selected === id ? ' selected' : ''}${node.type === 'output' ? ' output' : ''}` }, head, ...inputs, ...params, thumb);
    if (big) {
      // Drag the corner to see the texture bigger (only the editor keeps this).
      box.style.width = `${big}px`;
      const grip = el('div.ng-grip', { title: 'Drag to make the preview bigger or smaller' });
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX, start = big;
        grip.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const w = Math.round(Math.max(190, Math.min(640, start + (ev.clientX - sx) / view.z)));
          node.p.view = w;
          box.style.width = `${w}px`;
          thumb.style.width = thumb.style.height = `${w - 20}px`;
          drawWires();
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          build();
          evaluate();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
      });
      box.append(grip);
    }
    box.style.left = `${node.x}px`;
    box.style.top = `${node.y}px`;
    box.addEventListener('pointerdown', () => select(id));
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || e.target.closest('.ng-port')) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, nx: node.x, ny: node.y };
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        node.x = Math.round(start.nx + (ev.clientX - start.x) / view.z);
        node.y = Math.round(start.ny + (ev.clientY - start.y) / view.z);
        box.style.left = `${node.x}px`;
        box.style.top = `${node.y}px`;
        drawWires();
      };
      const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
    });
    nodeEls.set(id, { box, ports, thumb });
    return box;
  }

  function build() {
    for (const { box } of nodeEls.values()) box.remove();
    nodeEls.clear();
    for (const [id, node] of Object.entries(g.nodes)) world.append(nodeBox(id, node));
    requestAnimationFrame(() => drawWires());
  }

  function select(id) {
    if (selected === id) return;
    selected = id;
    for (const [nid, { box }] of nodeEls) box.classList.toggle('selected', nid === id);
  }

  function addNode(type, at = null) {
    const r = area.getBoundingClientRect();
    const p = at ?? toWorld(r.left + r.width / 2 - 100, r.top + r.height / 2 - 80);
    const nid = newId();
    g.nodes[nid] = newNode(type, p.x, p.y);
    selected = nid;
    build();
    evaluate();
  }

  function removeNode(id) {
    if (!g.nodes[id] || g.nodes[id].type === 'output') return;
    delete g.nodes[id];
    for (const n of Object.values(g.nodes)) for (const [port, from] of Object.entries(n.in ?? {})) if (from === id) delete n.in[port];
    if (selected === id) selected = null;
    build();
    evaluate();
  }

  // ---- wires
  const portPoint = (dot) => {
    const r = dot.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2);
  };
  const curve = (a, b) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  };
  function drawWires(pointer = null) {
    const paths = [];
    for (const [id, node] of Object.entries(g.nodes)) {
      for (const [port, from] of Object.entries(node.in ?? {})) {
        const a = nodeEls.get(from)?.ports.out, b = nodeEls.get(id)?.ports.in[port];
        if (a && b) paths.push(`<path class="ng-wire" d="${curve(portPoint(a), portPoint(b))}"/>`);
      }
    }
    if (wiring && pointer) {
      const fromDot = wiring.from ? nodeEls.get(wiring.from)?.ports.out : nodeEls.get(wiring.to[0])?.ports.in[wiring.to[1]];
      if (fromDot) {
        const a = portPoint(fromDot);
        paths.push(`<path class="ng-wire live" d="${wiring.from ? curve(a, pointer) : curve(pointer, a)}"/>`);
      }
    }
    svg.innerHTML = paths.join('');
  }

  function connect(from, to, port) {
    if (!g.nodes[from] || !g.nodes[to] || from === to) return;
    if (feeds(g, to, from)) { toast('That would make a loop.'); return; }
    (g.nodes[to].in ??= {})[port] = from;
  }

  area.addEventListener('pointerdown', (e) => {
    area.focus();
    const dot = e.target.closest('.ng-port');
    if (dot) {
      e.preventDefault();
      e.stopPropagation();
      const nid = dot.dataset.node;
      if (dot.classList.contains('out')) wiring = { from: nid };
      else {
        const port = dot.dataset.port;
        const was = g.nodes[nid].in?.[port];
        if (was) { delete g.nodes[nid].in[port]; wiring = { from: was }; build(); evaluate(); }
        else wiring = { to: [nid, port] };
      }
      area.setPointerCapture(e.pointerId);
      return;
    }
    if (e.target.closest('.ng-node') || e.target.closest('.ng-menu') || e.button !== 0) return;
    // Pan.
    select(null);
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    area.setPointerCapture(e.pointerId);
    wiring = null;
    area._pan = start;
  });
  area.addEventListener('pointermove', (e) => {
    if (wiring) { drawWires(toWorld(e.clientX, e.clientY)); return; }
    const p = area._pan;
    if (p) { view.x = p.vx + e.clientX - p.x; view.y = p.vy + e.clientY - p.y; applyView(); }
  });
  area.addEventListener('pointerup', (e) => {
    area._pan = null;
    if (!wiring) return;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.ng-port');
    if (target && wiring.from && target.classList.contains('in')) connect(wiring.from, target.dataset.node, target.dataset.port);
    else if (target && wiring.to && target.classList.contains('out')) connect(target.dataset.node, wiring.to[0], wiring.to[1]);
    wiring = null;
    build();
    evaluate();
  });
  area.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = area.getBoundingClientRect();
    const before = toWorld(e.clientX, e.clientY);
    view.z = Math.max(0.3, Math.min(1.6, view.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    view.x = e.clientX - r.left - before.x * view.z;
    view.y = e.clientY - r.top - before.y * view.z;
    applyView();
  }, { passive: false });
  // Right-click: add a node there.
  area.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.target.closest('.ng-node')) return;
    area.querySelector('.ng-menu')?.remove();
    const at = toWorld(e.clientX, e.clientY);
    const r = area.getBoundingClientRect();
    const menu = el('div.ng-menu', {}, ...Object.entries(NODE_TYPES).filter(([, t]) => t.group).map(([type, t]) =>
      el('button', { type: 'button', text: t.label, title: t.group, on: { click: () => { menu.remove(); addNode(type, at); } } })));
    area.append(menu);
    // Kept inside the grid: opens upward or leftward near an edge.
    menu.style.left = `${Math.max(4, Math.min(e.clientX - r.left, r.width - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(e.clientY - r.top, r.height - menu.offsetHeight - 4))}px`;
  });
  area.addEventListener('pointerdown', (e) => { if (!e.target.closest('.ng-menu')) area.querySelector('.ng-menu')?.remove(); }, true);
  area.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !e.target.closest('input, select')) { e.preventDefault(); removeNode(selected); }
  });

  // ---- results
  let queued = false;
  function evaluate() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      // A big Output preview is worked out at a higher resolution, so it stays sharp.
      const out0 = g.nodes[outputOf(g)];
      results = evalGraph(g, out0 && outSize(out0) > 260 ? 512 : EVAL);
      let loading = false;
      for (const [nid, { thumb }] of nodeEls) {
        const c = results.get(nid);
        const ctx = thumb.getContext('2d');
        ctx.fillStyle = '#2a2622';
        ctx.fillRect(0, 0, thumb.width, thumb.height);
        if (c === LOADING) { loading = true; continue; }
        if (c) ctx.drawImage(c, 0, 0, thumb.width, thumb.height);
      }
      const out = results.get(outputOf(g));
      const ctx = preview.getContext('2d');
      ctx.fillStyle = '#2a2622';
      ctx.fillRect(0, 0, 300, 300);
      if (out && out !== LOADING) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) ctx.drawImage(out, x * 150, y * 150, 150, 150);
      pushDraft();
      status.textContent = loading ? 'Loading pictures…' : !out ? 'Wire something into Output to make the texture.' : `Four copies side by side: one covers ${spanOf(g)} × ${spanOf(g)} squares on the map${Number(g.nodes[outputOf(g)]?.p?.macro) > 0 ? ' (map-wide light and dark shows on the map, not here)' : ''}.`;
    });
  }
  // The map shows the texture as it is now, a moment after each change.
  let draftTimer = null, lastDraft = '';
  function pushDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (!cur) return;
      const j = JSON.stringify(g.nodes);
      if (j === lastDraft) return;
      lastDraft = j;
      setDraft(cur, { v: 2, nodes: g.nodes });
    }, 250);
  }
  const offChanged = hooks.on('textures:changed', evaluate);
  win.onClose(() => {
    offChanged();
    offSaved();
    offDeleted();
    clearTimeout(draftTimer);
    if (cur) setDraft(cur, null); // unsaved changes leave the map
    if (snap() !== saved) toast('Closed without saving: the texture is as it was.');
    active = null;
  });

  async function upload(node) {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        status.textContent = `Uploading ${f.name}…`;
        const url = await api.upload(f);
        mine.push(url);
        node.p.src = url;
        node.p.squares = 2;
        build();
        evaluate();
      } catch (err) { toast(`Upload failed: ${err.message ?? err}`, 'error'); }
    };
    input.click();
  }

  /** Save (for everyone) and keep editing; Save as new makes a copy and goes on with that. */
  function save(asNew) {
    const tid = cur && !asNew ? cur : newId();
    if (asNew && cur) setDraft(cur, null);
    const texture_ = { id: tid, name: name.trim() || 'New texture', recipe: { v: 2, nodes: JSON.parse(JSON.stringify(g.nodes)) } };
    if (asNew && cur && !name.trim().endsWith('copy')) texture_.name = `${texture_.name} copy`;
    api.op({ op: 'texture_set', texture: texture_ }, (why) => toast(why, 'error'));
    toast(`${texture_.name} saved.`);
    cur = tid;
    name = texture_.name;
    nameInput.value = name;
    saved = snap();
    lastDraft = JSON.stringify(g.nodes);
    win.setTitle(`Texture: ${name}`);
    renderActions();
    renderPicker();
    const cb = onSavedFn;
    onSavedFn = null;
    cb?.(tid);
  }
  function remove() {
    const t = cur && store.world?.textures?.[cur];
    if (!t || !confirm(`Delete the texture ${t.name}? Floors and walls painted with it show plain until you paint them again.`)) return;
    setDraft(cur, null);
    api.op({ op: 'texture_delete', id: cur }, (why) => toast(why, 'error'));
    cur = null;
    saved = '';
    load(recipes().find((x) => x.id !== t.id)?.id ?? null);
  }

  applyView();
  active = { win, switchTo };
  load(id);
  return win;
}
