// The sheet designer: arrange a type's designed sheet by dragging.
//
//   palette (fields of the type, other blocks)  |  canvas (the real sheet, live)  |  settings of the selection
//
// The canvas is the sheet itself, rendered by layout-sheet.js in design mode
// with a sample actor, so what you see is what players get. Blocks snap to the
// 12-column grid; moving or growing one pushes the blocks it would cover down,
// and everything floats up to close gaps. The header's two rows (under the name,
// right-hand side) take blocks in order. Changes save through the system builder.

import { store, systemInfo } from './store.js';
import { el, openWindow, toast } from './ui.js';
import { icon, SHEET_ICONS } from './icons.js';
import { label } from './blueprint-sheet.js';
import { bindInputs } from './sheets.js';
import { layoutSheet, layoutItemSheet, layoutFromType, nodeAt, BLOCK_KINDS, COLUMNS } from './layout-sheet.js';

const MIN_ROW = 34;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isFlow = (container) => container === 'header' || container === 'side';
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Make room for `moved` (push what it covers down), then float everything up to close gaps. */
export function settle(list, moved = null) {
  const fixed = moved ? [moved] : [];
  for (const b of list.filter((x) => x !== moved).sort((a, c) => a.y - c.y || a.x - c.x)) {
    let hit;
    while ((hit = fixed.find((f) => overlaps(f, b)))) b.y = hit.y + hit.h;
    fixed.push(b);
  }
  for (const b of [...list].sort((a, c) => a.y - c.y || a.x - c.x)) {
    while (b.y > 1) {
      b.y -= 1;
      if (list.some((o) => o !== b && overlaps(o, b))) { b.y += 1; break; }
    }
  }
}

/** The pixel tracks of a CSS grid, from its computed style. */
function tracks(grid) {
  const cs = getComputedStyle(grid);
  const r = grid.getBoundingClientRect();
  const nums = (s) => (s === 'none' ? [] : s.split(/\s+/).map(parseFloat).filter((n) => !Number.isNaN(n)));
  return {
    left: r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
    top: r.top + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth),
    cols: nums(cs.gridTemplateColumns), rows: nums(cs.gridTemplateRows),
    cg: parseFloat(cs.columnGap) || 0, rg: parseFloat(cs.rowGap) || 0,
  };
}

/** The grid cell (1-based column and row) under a point; rows past the end continue at the minimum height. */
function cellAt(grid, cx, cy) {
  const t = tracks(grid);
  let x = t.cols.length || COLUMNS;
  let pos = t.left;
  for (let i = 0; i < t.cols.length; i++) {
    if (cx < pos + t.cols[i] + t.cg / 2) { x = i + 1; break; }
    pos += t.cols[i] + t.cg;
  }
  let y = 0;
  pos = t.top;
  for (let i = 0; i < t.rows.length; i++) {
    if (cy < pos + t.rows[i] + t.rg / 2) { y = i + 1; break; }
    pos += t.rows[i] + t.rg;
  }
  if (!y) y = t.rows.length + 1 + Math.max(0, Math.floor((cy - pos) / (MIN_ROW + t.rg)));
  return { x: Math.max(1, x), y: Math.max(1, y) };
}

/** Every @path a block can show, with a readable name: [[path, "Combat › Armor Class"]]. */
export function bindables(type) {
  const out = [];
  const walk = (nodes, prefix, trail, depth) => {
    for (const n of nodes ?? []) {
      if (['effect', 'type'].includes(n.kind)) continue;
      const path = prefix ? `${prefix}.${n.key}` : n.key;
      const name = [...trail, label(n)];
      // Layout-only groups add nothing to paths (and aren't listed), so they don't indent either.
      if (n.kind === 'group' && n.flat) { walk(n.children, prefix, name, depth); continue; }
      out.push({ path, name: name.join(' › '), node: n, depth });
      if (n.kind === 'group') walk(n.children, path, name, depth + 1);
    }
  };
  walk(type.children, '', [], 0);
  return out;
}

/** A sensible first size for a new block. */
function sizeFor(b, type) {
  if (b.kind === 'field') {
    const n = nodeAt(type.children, b.bind);
    if (!n) return { w: 3, h: 1 };
    if (['list', 'longtext', 'group'].includes(n.kind)) return { w: COLUMNS, h: n.kind === 'longtext' ? 3 : 2 };
    if (n.kind === 'resource') return { w: 4, h: 1 };
    return { w: 3, h: 1 };
  }
  return { items: { w: COLUMNS, h: 2 }, text: { w: COLUMNS, h: 2 }, group: { w: COLUMNS, h: 2 }, image: { w: 4, h: 4 }, advance: { w: 3, h: 1 } }[b.kind] ?? { w: COLUMNS, h: 1 };
}

let copiedStyle = null; // Copy style / Paste style, across designers

const designers = new Map(); // `${type id}/${layout id}` → Designer

/** Open (or bring forward) the designer for one of a type's layouts (default: the first). */
export function openDesigner(builder, type, isItem, layoutId = null) {
  if (!type.layouts?.length) type.layouts = [layoutFromType(type, isItem)];
  const layout = type.layouts.find((l) => l.id === layoutId) ?? type.layouts[0];
  const key = `${type.id}/${layout.id}`;
  const open = designers.get(key);
  if (open) { openWindow({ id: `sheet-designer-${key}` }); return open; }
  const d = new Designer(builder, type, isItem, layout, key);
  designers.set(key, d);
  return d;
}

/** Close a layout's designer (it was deleted). */
export function closeDesigner(type, layoutId) {
  designers.get(`${type.id}/${layoutId}`)?.win.close();
}

class Designer {
  constructor(builder, type, isItem, layout, key) {
    this.b = builder;
    this.type = type;
    this.isItem = isItem;
    this.layout = layout;
    this.key = key;
    this.normalize();
    this.sel = null;          // { kind: 'block', id } | { kind: 'tab', key } | null (the sheet)
    this.tab = this.layout.tabs?.[0]?.key ?? null;
    this.history = [];
    this.future = [];
    this.before = null;
    this.query = '';
    this.previewKey = null;

    this.win = openWindow({ id: `sheet-designer-${key}`, title: `Sheet designer: ${label(type)} › ${layout.name || 'Sheet'}`, width: Math.min(1440, innerWidth - 24), height: innerHeight - 40 });
    this.win.el.classList.add('designer-window');
    this.win.onClose(() => {
      designers.delete(key);
      window.removeEventListener('keydown', this.onKey);
      this.b.flush();
      this.b.renderEdit?.();
    });
    this.toolbar = el('div.dz-toolbar');
    this.palette = el('aside.dz-palette');
    this.canvas = el('div.dz-canvas');
    this.inspector = el('aside.dz-inspector');
    this.win.body.classList.add('dz-body');
    this.win.body.replaceChildren(this.toolbar, el('div.dz-panes', {}, this.palette, this.canvas, this.inspector));
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.onKey = (e) => this.key(e);
    window.addEventListener('keydown', this.onKey);
    this.renderAll();
  }

  // ------------------------------------------------------------------ the model

  /** Containers by name: "header", "side", "top", "tab:<key>", "group:<id>" → their block arrays. */
  containers() {
    const L = this.layout;
    const out = new Map();
    if (L.header !== false) {
      L.header ??= {};
      L.header.blocks ??= [];
      L.header.side ??= [];
      out.set('header', L.header.blocks);
      out.set('side', L.header.side);
    }
    L.top ??= [];
    out.set('top', L.top);
    L.tabs ??= [];
    for (const t of L.tabs) { t.blocks ??= []; out.set(`tab:${t.key}`, t.blocks); }
    const walk = (list) => { for (const b of list) if (b.kind === 'group') { b.blocks ??= []; out.set(`group:${b.id}`, b.blocks); walk(b.blocks); } };
    for (const list of [...out.values()]) walk(list);
    return out;
  }

  find(id) {
    for (const [container, list] of this.containers()) {
      const block = list.find((b) => b.id === id);
      if (block) return { block, list, container };
    }
    return null;
  }

  /** Ids on every block, sizes in range, and grid positions for blocks that have none. */
  normalize() {
    for (const [container, list] of this.containers()) {
      for (const b of list) b.id ||= newId();
      if (isFlow(container)) continue;
      let bottom = list.reduce((m, b) => (b.y ? Math.max(m, b.y + (b.h || 1) - 1) : m), 0);
      let x = 1;
      for (const b of list) {
        b.w = clamp(Math.round(Number(b.w) || COLUMNS), 1, COLUMNS);
        b.h = Math.max(1, Math.round(Number(b.h) || 1));
        if (!b.x || !b.y) {
          if (x + b.w - 1 > COLUMNS) { x = 1; bottom += 1; }
          b.x = x;
          b.y = bottom + 1;
          x += b.w;
        }
        b.x = clamp(b.x, 1, COLUMNS - b.w + 1);
      }
      settle(list);
    }
  }

  begin() { this.before = JSON.stringify(this.layout); }

  /** After a change: remember the previous state for undo, save, redraw. */
  commit() {
    const now = JSON.stringify(this.layout);
    if (this.before && this.before !== now) {
      this.history.push(this.before);
      if (this.history.length > 100) this.history.shift();
      this.future = [];
      this.b.changed({ tree: false });
    }
    this.before = null;
    this.renderAll();
  }

  /** Change something from the settings panel: one undo step each. */
  edit(fn) {
    this.begin();
    fn();
    this.commit();
  }

  restore(json) {
    const i = this.type.layouts.indexOf(this.layout);
    this.layout = JSON.parse(json);
    if (i >= 0) this.type.layouts[i] = this.layout;
    if (this.sel?.kind === 'block' && !this.find(this.sel.id)) this.sel = null;
    if (!this.layout.tabs?.some((t) => t.key === this.tab)) this.tab = this.layout.tabs?.[0]?.key ?? null;
    this.b.changed({ tree: false });
    this.renderAll();
  }

  undo() { if (this.history.length) { this.future.push(JSON.stringify(this.layout)); this.restore(this.history.pop()); } }
  redo() { if (this.future.length) { this.history.push(JSON.stringify(this.layout)); this.restore(this.future.pop()); } }

  /** Move a block to a container and place: { container, x, y } on a grid, { container, index } in the header. */
  place(b, target) {
    const all = this.containers();
    const dest = all.get(target.container);
    if (!dest) return;
    const from = this.find(b.id);
    if (from && from.list !== dest) {
      from.list.splice(from.list.indexOf(b), 1);
      if (!isFlow(from.container)) settle(from.list);
    }
    if (isFlow(target.container)) {
      const at = dest.indexOf(b);
      if (at >= 0) dest.splice(at, 1);
      dest.splice(clamp(target.index, 0, dest.length), 0, b);
      delete b.x;
      delete b.y;
      return;
    }
    if (!dest.includes(b)) dest.push(b);
    const size = sizeFor(b, this.type);
    b.w = clamp(Number(b.w) || size.w, 1, COLUMNS);
    b.h = Math.max(1, Number(b.h) || size.h);
    b.x = clamp(target.x, 1, COLUMNS - b.w + 1);
    b.y = Math.max(1, target.y);
    settle(dest, b);
  }

  remove(id) {
    const f = this.find(id);
    if (!f) return;
    f.list.splice(f.list.indexOf(f.block), 1);
    if (!isFlow(f.container)) settle(f.list);
    if (this.sel?.id === id) this.sel = null;
  }

  // ------------------------------------------------------------------ preview data

  /** A real actor (or item) of this type to show, or a blank sample. */
  preview() {
    const sys = systemInfo();
    const actors = Object.values(store.world?.actors ?? {});
    if (!this.isItem) {
      const mine = actors.filter((a) => a.kind === this.type.key);
      const actor = mine.find((a) => a.id === this.previewKey) ?? mine[0];
      if (actor) return { actor, choices: mine.map((a) => [a.id, a.name]) };
      return { actor: { id: '__preview', name: `Sample ${label(this.type)}`, kind: this.type.key, data: structuredClone(sys.actor_types?.[this.type.key]?.template ?? {}), derived: {}, items: [], owners: [], effects: [] }, choices: [] };
    }
    const pairs = actors.flatMap((a) => a.items.filter((i) => i.kind === this.type.key).map((i) => [a, i]));
    const pair = pairs.find(([a, i]) => `${a.id}/${i.id}` === this.previewKey) ?? pairs[0];
    if (pair) return { actor: pair[0], item: pair[1], choices: pairs.map(([a, i]) => [`${a.id}/${i.id}`, `${i.name} (${a.name})`]) };
    const item = { id: '__item', name: `Sample ${label(this.type)}`, kind: this.type.key, data: structuredClone(sys.item_types?.[this.type.key]?.template ?? {}), flags: {}, effects: [] };
    return { actor: { id: '__preview', name: 'Sample', kind: '', data: {}, derived: {}, items: [item], owners: [], effects: [] }, item, choices: [] };
  }

  // ------------------------------------------------------------------ drawing

  renderAll() {
    this.renderToolbar();
    this.renderPalette();
    this.renderCanvas();
    this.renderInspector();
  }

  renderToolbar() {
    const { choices } = this.preview();
    const pick = choices.length > 1 ? el('label.dz-preview', {}, 'Preview with ', el('select', {
      on: { change: (e) => { this.previewKey = e.target.value; this.renderCanvas(); } },
    }, ...choices.map(([v, l]) => el('option', { value: v, text: l, selected: v === (this.previewKey ?? choices[0][0]) })))) : null;
    this.toolbar.replaceChildren(...[
      el('button.small', { type: 'button', text: '↶ Undo', title: 'Undo (Ctrl+Z)', disabled: !this.history.length, on: { click: () => this.undo() } }),
      el('button.small', { type: 'button', text: '↷ Redo', title: 'Redo (Ctrl+Y)', disabled: !this.future.length, on: { click: () => this.redo() } }),
      el('button.small', { type: 'button', text: '+ Tab', on: { click: () => this.addTab() } }),
      el('span.grow'),
      pick ?? (choices.length ? null : el('small.muted', { text: this.isItem ? 'Preview: a blank sample. Give someone this kind of item to preview real values.' : 'Preview: a blank sample. Make a character of this type to preview real values.' })),
      el('small.muted.dz-status', { text: this.b.status || '' })].filter(Boolean));
  }

  renderPalette() {
    const q = this.query.trim().toLowerCase();
    const search = el('input', { type: 'search', placeholder: 'Find a field…', value: this.query, 'aria-label': 'Find a field' });
    search.addEventListener('input', () => { this.query = search.value; this.renderPalette(); const s = this.palette.querySelector('input[type=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); });
    const fields = bindables(this.type).filter((f) => !q || f.name.toLowerCase().includes(q) || f.path.includes(q));
    const item = (text, sub, template, depth = 0) => el('div.dz-item', {
      title: 'Drag onto the sheet, or click to add it to this tab', style: depth ? `padding-left: ${8 + depth * 12}px` : null,
      on: { pointerdown: (e) => this.startNew(template, e) },
    }, el('span', { text }), sub ? el('small.muted', { text: sub }) : null);
    const blocks = [
      ['heading', 'Heading', { kind: 'heading', text: 'Heading' }],
      ['text', 'Text', { kind: 'text', text: 'Some text. **Bold**, lists, [[links]].' }],
      ['group', 'Box', { kind: 'group', title: 'New box', frame: 'card', blocks: [] }],
      ...(this.isItem ? [] : (systemInfo().blueprint?.item_types ?? []).map((t) => ['items', `List of ${t.list_title || label(t)}`, { kind: 'items', item_type: t.key }])),
      ['image', 'Picture', { kind: 'image', src: '' }],
      ['divider', 'Line', { kind: 'divider' }],
      ...(this.isItem ? [] : [['conditions', 'Conditions', { kind: 'conditions' }], ['rests', 'Rest buttons', { kind: 'rests' }], ['advance', 'Advance button', { kind: 'advance' }], ['problems', 'Formula problems (GM)', { kind: 'problems' }]]),
    ];
    this.palette.replaceChildren(
      el('h4', { text: 'Fields' }), search,
      el('div.dz-list', {}, ...fields.map((f) => item(label(f.node), `@${f.path}`, { kind: 'field', bind: f.path }, q ? 0 : f.depth)),
        fields.length ? null : el('p.muted.small', { text: 'Nothing matches.' })),
      el('h4', { text: 'Blocks' }),
      el('div.dz-list', {}, ...blocks.map(([, l, t]) => item(l, null, t))));
  }

  renderCanvas() {
    const { actor, item } = this.preview();
    const design = { tab: this.tab, onTab: (key) => this.select({ kind: 'tab', key }) };
    let sheet;
    try {
      sheet = this.isItem ? layoutItemSheet(actor, item, this.type, this.layout, this.b.api, design) : layoutSheet(actor, this.type, this.layout, this.b.api, design);
      // Item sheets get their values from the item window; fill them in here.
      if (this.isItem) bindInputs(sheet, actor, this.b.api);
    } catch (e) {
      console.error(e);
      sheet = el('p.error', { text: `This layout couldn't be drawn: ${e.message}` });
    }
    const frame = el('div.dz-frame', { style: `width: ${this.type.width || (this.isItem ? 440 : 760)}px` }, sheet);
    const scroll = this.canvas.scrollTop;
    this.canvas.replaceChildren(frame);
    this.canvas.scrollTop = scroll;
    this.decorate();
  }

  /** Outlines, the selection, resize handles, and names on empty drop areas. */
  decorate() {
    const names = { header: 'Under the name', side: 'Right of the header', top: 'Above the tabs (every tab)' };
    for (const c of this.canvas.querySelectorAll('[data-container]')) {
      c.classList.add('dz-container');
      c.classList.toggle('dz-empty', !c.querySelector(':scope > .lt-block'));
      const n = c.dataset.container;
      c.dataset.hint = names[n] ?? (n.startsWith('group:') ? 'Drop blocks into this box' : 'Drop fields and blocks here');
    }
    for (const cell of this.canvas.querySelectorAll('.lt-block[data-block]')) {
      cell.classList.add('dz-block');
      if (this.sel?.kind === 'block' && this.sel.id === cell.dataset.block) {
        cell.classList.add('dz-selected');
        const f = this.find(cell.dataset.block);
        if (f && !isFlow(f.container)) {
          for (const edge of ['e', 's', 'se']) cell.append(el(`div.dz-handle.dz-${edge}`, { 'data-edge': edge, title: 'Drag to resize' }));
        }
      }
    }
    if (this.sel?.kind === 'tab') this.canvas.querySelector(`.bp-tabs [data-tab="${CSS.escape(this.sel.key)}"]`)?.classList.add('dz-tab-selected');
  }

  select(sel) {
    this.sel = sel;
    if (sel?.kind === 'tab') this.tab = sel.key;
    this.renderCanvas();
    this.renderInspector();
  }

  // ------------------------------------------------------------------ pointer: select, move, resize

  onDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.bp-tabs [data-tab]')) return; // tabs select themselves
    const handle = e.target.closest('.dz-handle');
    const cell = e.target.closest('.lt-block[data-block]');
    e.preventDefault();
    if (handle && cell) { this.startResize(cell.dataset.block, handle.dataset.edge, e); return; }
    if (cell) {
      const id = cell.dataset.block;
      if (this.sel?.id !== id) this.select({ kind: 'block', id });
      this.startMove(id, e);
      return;
    }
    if (this.sel) this.select(null);
  }

  /** The drop area under a point (never inside the block being dragged). */
  containerAt(cx, cy, draggedId) {
    for (const hit of document.elementsFromPoint(cx, cy)) {
      if (!this.canvas.contains(hit)) continue;
      const c = hit.closest('[data-container]');
      if (!c) continue;
      if (draggedId && c.closest(`.lt-block[data-block="${CSS.escape(draggedId)}"]`)) continue;
      return c;
    }
    return null;
  }

  /** Where in a drop area a point lands. */
  targetIn(c, cx, cy, off, id) {
    const container = c.dataset.container;
    if (isFlow(container)) {
      const cells = [...c.querySelectorAll(':scope > .lt-block')].filter((x) => x.dataset.block !== id);
      let index = cells.length;
      for (let i = 0; i < cells.length; i++) {
        const r = cells[i].getBoundingClientRect();
        const before = container === 'side' ? cy < r.top + r.height / 2 : cy < r.top || (cy <= r.bottom && cx < r.left + r.width / 2);
        if (before) { index = i; break; }
      }
      return { container, index };
    }
    const cell = cellAt(c, cx, cy);
    return { container, x: cell.x - off.dx, y: cell.y - off.dy };
  }

  /** Drag a block: it moves live, pushing others aside; any drop area works, boxes included. */
  startMove(id, e) {
    const sx = e.clientX, sy = e.clientY;
    let active = false;
    let last = '';
    let off = { dx: 0, dy: 0 };
    const f0 = this.find(id);
    const cell0 = this.canvas.querySelector(`.lt-block[data-block="${CSS.escape(id)}"]`);
    if (f0 && cell0 && !isFlow(f0.container)) {
      const c = cellAt(cell0.parentElement, sx, sy);
      off = { dx: clamp(c.x - f0.block.x, 0, f0.block.w - 1), dy: clamp(c.y - f0.block.y, 0, f0.block.h - 1) };
    }
    const move = (ev) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        active = true;
        this.begin();
        this.canvas.classList.add('dz-dragging');
      }
      const c = this.containerAt(ev.clientX, ev.clientY, id);
      if (!c) return;
      const f = this.find(id);
      if (!f) return;
      const target = this.targetIn(c, ev.clientX, ev.clientY, isFlow(c.dataset.container) ? { dx: 0, dy: 0 } : off, id);
      const sig = JSON.stringify(target);
      if (sig === last) return;
      last = sig;
      this.place(f.block, target);
      this.renderCanvas();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.canvas.classList.remove('dz-dragging');
      if (active) this.commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Drag an edge: wider (right), taller (bottom), or both (corner). */
  startResize(id, edge, e) {
    this.begin();
    let last = '';
    const move = (ev) => {
      const f = this.find(id);
      const cell = this.canvas.querySelector(`.lt-block[data-block="${CSS.escape(id)}"]`);
      if (!f || !cell) return;
      const c = cellAt(cell.parentElement, ev.clientX, ev.clientY);
      const b = f.block;
      if (edge.includes('e')) b.w = clamp(c.x - b.x + 1, 1, COLUMNS - b.x + 1);
      if (edge.includes('s')) b.h = Math.max(1, c.y - b.y + 1);
      const sig = `${b.w}x${b.h}`;
      if (sig === last) return;
      last = sig;
      settle(f.list, b);
      this.renderCanvas();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    move(e);
  }

  /** Drag from the palette onto the sheet (or click to add to the open tab). */
  startNew(template, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const b = { ...structuredClone(template), id: newId() };
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    let inside = false;
    let last = '';
    this.begin();
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      moved = true;
      this.canvas.classList.add('dz-dragging');
      const c = this.containerAt(ev.clientX, ev.clientY, b.id);
      if (!c) {
        if (inside) { this.remove(b.id); inside = false; last = ''; this.renderCanvas(); }
        return;
      }
      const target = this.targetIn(c, ev.clientX, ev.clientY, { dx: 0, dy: 0 }, b.id);
      const sig = JSON.stringify(target);
      if (sig === last) return;
      last = sig;
      this.place(b, target);
      inside = true;
      this.renderCanvas();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.canvas.classList.remove('dz-dragging');
      if (!moved) {
        // A click: add it at the bottom of the open tab.
        const list = this.containers().get(`tab:${this.tab}`);
        if (!list) { toast('Add a tab first.'); return; }
        this.place(b, { container: `tab:${this.tab}`, x: 1, y: list.reduce((m, x) => Math.max(m, x.y + x.h), 1) });
        inside = true;
      }
      if (inside) this.sel = { kind: 'block', id: b.id };
      this.commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  key(e) {
    if (!this.win.el.isConnected) return;
    // Only while the designer is the front window, and not while typing.
    const front = [...document.querySelectorAll('.window')].sort((a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0))[0];
    if (front !== this.win.el) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); this.redo(); return; }
    if (typing || this.sel?.kind !== 'block') return;
    const f = this.find(this.sel.id);
    if (!f) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.edit(() => this.remove(f.block.id)); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && !isFlow(f.container)) {
      e.preventDefault();
      const [dx, dy] = arrows[e.key];
      this.edit(() => {
        const b = f.block;
        if (e.shiftKey) { b.w = clamp(b.w + dx, 1, COLUMNS - b.x + 1); b.h = Math.max(1, b.h + dy); settle(f.list, b); } else this.place(b, { container: f.container, x: b.x + dx, y: b.y + dy });
      });
    }
  }

  // ------------------------------------------------------------------ tabs

  addTab() {
    this.edit(() => {
      const keys = new Set((this.layout.tabs ?? []).map((t) => t.key));
      let n = (this.layout.tabs?.length ?? 0) + 1;
      while (keys.has(`tab_${n}`)) n++;
      const tab = { key: `tab_${n}`, label: 'New tab', icon: 'star', blocks: [] };
      const at = (this.layout.tabs ?? []).findIndex((t) => t.key === this.tab);
      (this.layout.tabs ??= []).splice(at < 0 ? this.layout.tabs.length : at + 1, 0, tab);
      this.tab = tab.key;
      this.sel = { kind: 'tab', key: tab.key };
    });
  }

  // ------------------------------------------------------------------ settings panel

  renderInspector() {
    const parts = [];
    if (this.sel?.kind === 'block') parts.push(...this.blockSettings());
    else if (this.sel?.kind === 'tab') parts.push(...this.tabSettings());
    else parts.push(...this.sheetSettings());
    this.inspector.replaceChildren(...parts.filter(Boolean));
  }

  /** Small form helpers that edit the model as one undo step. */
  text(obj, key, labelText, { placeholder = '', area = false, after } = {}) {
    const input = el(area ? 'textarea' : 'input', { placeholder, rows: area ? 5 : null, [area ? 'text' : 'value']: obj[key] ?? '' });
    input.addEventListener('change', () => this.edit(() => { const v = input.value; if (v === '') delete obj[key]; else obj[key] = v; after?.(); }));
    return el('label', {}, labelText, input);
  }

  check(obj, key, labelText, { invert = false } = {}) {
    // invert: on unless the value is false (for settings that default to on).
    const on = invert ? obj[key] !== false : !!obj[key];
    return el('label.check', {}, el('input', { type: 'checkbox', checked: on, on: { change: (e) => this.edit(() => {
      const v = e.target.checked;
      if (invert) { if (v) delete obj[key]; else obj[key] = false; } else if (v) obj[key] = true; else delete obj[key];
    }) } }), labelText);
  }

  choose(obj, key, labelText, options, { number = false } = {}) {
    return el('label', {}, labelText, el('select', {
      on: { change: (e) => this.edit(() => { const v = number ? Number(e.target.value) : e.target.value; if (v === '' || v === 0) delete obj[key]; else obj[key] = v; }) },
    }, ...options.map(([v, l]) => el('option', { value: v, text: l, selected: String(obj[key] ?? '') === String(v) }))));
  }

  blockSettings() {
    const f = this.find(this.sel.id);
    if (!f) return [el('p.muted', { text: 'Nothing selected.' })];
    const b = f.block;
    const node = b.kind === 'field' ? nodeAt(this.type.children, b.bind) : null;
    const title = b.kind === 'field' ? (node ? label(node) : `@${b.bind}`) : BLOCK_KINDS[b.kind] ?? b.kind;
    const out = [
      el('div.dz-head', {}, el('strong', { text: title }), el('span.grow'),
        el('button.icon', { type: 'button', title: 'Duplicate', text: '⧉', on: { click: () => this.edit(() => {
          const copy = structuredClone(b);
          const reid = (x) => { x.id = newId(); (x.blocks ?? []).forEach(reid); };
          reid(copy);
          if (isFlow(f.container)) f.list.splice(f.list.indexOf(b) + 1, 0, copy);
          else this.place(copy, { container: f.container, x: b.x, y: b.y + b.h });
          this.sel = { kind: 'block', id: copy.id };
        }) } }),
        el('button.icon', { type: 'button', title: 'Remove from the sheet (Delete)', text: '🗑', on: { click: () => this.edit(() => this.remove(b.id)) } })),
    ];
    if (b.kind === 'field') {
      const opts = bindables(this.type);
      out.push(el('label', {}, 'Shows', el('select', {
        on: { change: (e) => this.edit(() => { b.bind = e.target.value; }) },
      }, ...(node ? [] : [el('option', { value: b.bind, text: `@${b.bind} (missing)`, selected: true })]),
      ...opts.map((o) => el('option', { value: o.path, text: `${'  '.repeat(o.depth)}${label(o.node)}  (@${o.path})`, selected: o.path === b.bind })))));
      if (node) {
        out.push(this.text(b, 'label', 'Label', { placeholder: label(node) }),
          this.check(b, 'hide_label', 'Hide the label'));
        if (['number', 'text', 'choice', 'formula', 'resource', 'action'].includes(node.kind)) {
          out.push(this.choose(b, 'display', 'Display', [['', `As the field says${node.display ? ` (${node.display})` : ''}`], ['normal', 'Normal'], ['big', 'Big number box'], ['badge', 'Round badge'], ['inline', 'Label beside value'], ['plain', 'Plain (no box)']]));
        }
        if (node.hint) out.push(this.check(b, 'show_hint', 'Show its help text', { invert: true }));
      }
    } else if (b.kind === 'group') {
      out.push(this.text(b, 'title', 'Title'), this.check(b, 'hide_label', 'Hide the title'),
        this.choose(b, 'frame', 'Frame', [['', 'Box'], ['card', 'Card (filled, title strip)'], ['plain', 'None']]),
        el('p.muted.small', { text: 'Drag fields and blocks into the box; it has its own 12-column grid.' }));
    } else if (b.kind === 'items') {
      const types = systemInfo().blueprint?.item_types ?? [];
      out.push(this.choose(b, 'item_type', 'Lists', types.map((t) => [t.key, label(t)])),
        this.text(b, 'title', 'Title', { placeholder: types.find((t) => t.key === b.item_type)?.list_title || '' }),
        el('p.muted.small', { text: 'Grouping and the details shown on each row are set on the item type (On the character sheet).' }));
    } else if (b.kind === 'heading' || b.kind === 'advance') {
      out.push(this.text(b, 'text', b.kind === 'advance' ? 'Button text' : 'Text', { placeholder: b.kind === 'advance' ? '⬆ Advance' : '' }));
    } else if (b.kind === 'text') {
      out.push(this.text(b, 'text', 'Text (markdown: **bold**, lists, [[links]])', { area: true }));
    } else if (b.kind === 'image') {
      const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
      file.addEventListener('change', async () => {
        const fl = file.files[0];
        if (!fl) return;
        try { const url = await this.b.api.upload(fl); this.edit(() => { b.src = url; }); } catch (err) { toast(`Upload failed: ${err.message ?? err}`, 'error'); }
      });
      out.push(this.text(b, 'src', 'Picture address', { placeholder: 'https://… or upload' }), el('div.row', {}, el('button.small', { type: 'button', text: 'Upload…', on: { click: () => file.click() } }), file));
    }
    if (!isFlow(f.container)) {
      const num = (key, lbl, lo, hi) => {
        const input = el('input', { type: 'number', min: lo, max: hi, value: b[key] });
        input.addEventListener('change', () => this.edit(() => {
          b[key] = clamp(Math.round(Number(input.value) || lo), lo, hi);
          if (key === 'w' || key === 'x') b.x = clamp(b.x, 1, COLUMNS - b.w + 1);
          settle(f.list, b);
        }));
        return el('label', {}, lbl, input);
      };
      out.push(el('fieldset.bfield', {}, el('legend', { text: 'Place' }),
        el('div.dz-place', {}, num('x', 'Column', 1, COLUMNS), num('w', 'Width', 1, COLUMNS), num('y', 'Row', 1, 999), num('h', 'Height', 1, 99)),
        this.check(b, 'fit', 'Shrink to fit its content'),
        el('p.muted.small', { text: b.fit ? 'It stays as tall as its content, even if its neighbours are taller.' : 'It fills its rows, so blocks side by side match heights (tables spread their rows). Drag its bottom edge to make it taller.' }),
        el('p.muted.small', { text: 'Or drag it, and drag its right or bottom edge. Arrow keys move it; Shift+arrows resize.' })));
      const ov = b.overflow || 'grow';
      const limit = el('input', { type: 'number', min: 1, value: b.limit || 10, disabled: ov !== 'limit', style: 'width: 70px' });
      limit.addEventListener('change', () => this.edit(() => { b.limit = Math.max(1, Number(limit.value) || 10); }));
      out.push(el('fieldset.bfield', {}, el('legend', { text: 'When it\'s full' }),
        ...[['grow', 'Grow (push what\'s below down)'], ['scroll', `Scroll (stay ${b.h} row${b.h === 1 ? '' : 's'} tall)`], ['limit', 'Show the first']].map(([v, l]) => el('label.check', {},
          el('input', { type: 'radio', name: `ov-${b.id}`, checked: ov === v, on: { change: () => this.edit(() => { if (v === 'grow') delete b.overflow; else b.overflow = v; if (v === 'limit') b.limit ||= 10; }) } }),
          l, v === 'limit' ? el('span', {}, ' ', limit, ' rows') : null))));
    } else {
      out.push(el('p.muted.small', { text: 'In the header, blocks sit in a row in the order you drop them.' }));
    }
    out.push(this.styleSettings(b));
    return out;
  }

  // ------------------------------------------------------------------ styles

  /** Edit a key of holder.style (made when needed, removed when empty). */
  styleEdit(holder, key, value) {
    this.edit(() => {
      const st = (holder.style ??= {});
      if (value === '' || value == null || value === false) delete st[key]; else st[key] = value;
      if (!Object.keys(st).length) delete holder.style;
    });
  }

  /** A colour: tick to use it (otherwise the theme decides), pick it. */
  colorField(holder, key, labelText, fallback = '#888888') {
    const cur = holder.style?.[key];
    const on = el('input', { type: 'checkbox', checked: !!cur, title: 'Use this colour' });
    const pick = el('input', { type: 'color', value: cur || fallback });
    on.addEventListener('change', () => this.styleEdit(holder, key, on.checked ? pick.value : null));
    pick.addEventListener('change', () => this.styleEdit(holder, key, pick.value));
    return el('label.check.dz-color', {}, on, pick, labelText);
  }

  /** A size in pixels with a few named steps, or a number of your own. */
  sizeField(holder, key, labelText, steps) {
    const cur = holder.style?.[key];
    const named = steps.find(([, v]) => v === cur);
    const custom = el('input', { type: 'number', min: 8, max: 96, value: cur ?? '', placeholder: 'px', style: 'width: 64px' });
    custom.addEventListener('change', () => this.styleEdit(holder, key, custom.value === '' ? null : Number(custom.value)));
    return el('label', {}, labelText, el('div.row', {},
      el('select', { on: { change: (e) => this.styleEdit(holder, key, e.target.value === '' ? null : Number(e.target.value)) } },
        el('option', { value: '', text: 'Default', selected: cur == null }),
        ...steps.map(([l, v]) => el('option', { value: v, text: `${l} (${v}px)`, selected: named?.[1] === v })),
        cur != null && !named ? el('option', { value: cur, text: `${cur}px`, selected: true }) : null),
      custom));
  }

  styleSettings(b) {
    const st = b.style ?? {};
    const toggle = (key, text) => el('label.check', {}, el('input', { type: 'checkbox', checked: !!st[key], on: { change: (e) => this.styleEdit(b, key, e.target.checked) } }), text);
    const choose = (key, text, options) => el('label', {}, text, el('select', {
      on: { change: (e) => this.styleEdit(b, key, e.target.value) },
    }, ...options.map(([v, l]) => el('option', { value: v, text: l, selected: (st[key] ?? '') === v }))));
    const num = (key, text, max) => {
      const input = el('input', { type: 'number', min: 0, max, value: st[key] ?? '', placeholder: 'default' });
      input.addEventListener('change', () => this.styleEdit(b, key, input.value === '' ? null : Number(input.value)));
      return el('label', {}, text, input);
    };
    const box = el('details.dz-style', { open: !!b.style },
      el('summary', { text: b.style ? 'Style (changed)' : 'Style' }),
      el('div.dz-style-group', {}, el('strong', { text: 'Text' }),
        this.sizeField(b, 'size', 'Size', [['Small', 12], ['Normal', 14], ['Large', 20], ['Huge', 30], ['Giant', 44]]),
        this.colorField(b, 'color', 'Colour', '#ffffff'),
        el('div.row', {}, toggle('bold', 'Bold'), toggle('italic', 'Italic')),
        choose('align', 'Alignment', [['', 'Default'], ['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])),
      el('div.dz-style-group', {}, el('strong', { text: 'Label and headings' }),
        this.sizeField(b, 'label_size', 'Size', [['Tiny', 10], ['Small', 12], ['Normal', 14], ['Large', 18]]),
        this.colorField(b, 'label_color', 'Colour', '#aaaaaa')),
      el('div.dz-style-group', {}, el('strong', { text: 'Box' }),
        this.colorField(b, 'background', 'Background', '#333333'),
        choose('border', 'Border', [['', 'Default'], ['thin', 'Thin line'], ['thick', 'Thick line']]),
        st.border ? this.colorField(b, 'border_color', 'Border colour', '#d9a52b') : null,
        el('div.dz-place', {}, num('radius', 'Corners (px)', 60), num('padding', 'Inner space (px)', 60))),
      el('div.row', {},
        el('button.small', { type: 'button', text: 'Copy style', disabled: !b.style, on: { click: () => { copiedStyle = structuredClone(b.style); toast('Style copied. Select another block and Paste style.'); this.renderInspector(); } } }),
        el('button.small', { type: 'button', text: 'Paste style', disabled: !copiedStyle, on: { click: () => this.edit(() => { b.style = structuredClone(copiedStyle); }) } }),
        el('button.small', { type: 'button', text: 'Clear', disabled: !b.style, on: { click: () => this.edit(() => { delete b.style; }) } })));
    return box;
  }

  tabSettings() {
    const tabs = this.layout.tabs ?? [];
    const i = tabs.findIndex((t) => t.key === this.sel.key);
    const t = tabs[i];
    if (!t) return [el('p.muted', { text: 'Nothing selected.' })];
    const move = (d) => this.edit(() => { tabs.splice(i, 1); tabs.splice(clamp(i + d, 0, tabs.length), 0, t); });
    const icons = el('div.icon-picker', {},
      el('button', { type: 'button', class: t.icon ? 'icon-choice' : 'icon-choice on', text: '∅', title: 'No icon', on: { click: () => this.edit(() => { delete t.icon; }) } }),
      ...SHEET_ICONS.map((name) => el('button', { type: 'button', title: name, class: t.icon === name ? 'icon-choice on' : 'icon-choice', on: { click: () => this.edit(() => { t.icon = name; }) } }, icon(name))));
    return [
      el('div.dz-head', {}, el('strong', { text: `Tab: ${t.label || t.key}` })),
      this.text(t, 'label', 'Name'),
      el('div.small.muted', { text: 'Icon' }), icons,
      (() => {
        const input = el('input', { value: t.icon && !SHEET_ICONS.includes(t.icon) ? t.icon : '', placeholder: '🗡', maxlength: 4 });
        input.addEventListener('change', () => this.edit(() => { const v = input.value.trim(); if (v) t.icon = v; else delete t.icon; }));
        return el('label', {}, 'Or an emoji', input);
      })(),
      el('div.row', {},
        el('button.small', { type: 'button', text: '← Move left', disabled: i === 0, on: { click: () => move(-1) } }),
        el('button.small', { type: 'button', text: 'Move right →', disabled: i === tabs.length - 1, on: { click: () => move(1) } })),
      el('button.small.danger', {
        type: 'button', text: 'Delete this tab', disabled: tabs.length <= 1,
        on: { click: () => { if (t.blocks?.length && !confirm(`Delete the "${t.label || t.key}" tab and the ${t.blocks.length} blocks on it?`)) return; this.edit(() => { tabs.splice(i, 1); this.tab = tabs[0]?.key; this.sel = null; }); } },
      }),
      el('fieldset.bfield', {}, el('legend', { text: 'Style' }),
        this.colorField(t, 'background', 'Background of this tab', '#2a2420'),
        this.colorField(t, 'color', 'Text colour', '#ffffff')),
      el('p.muted.small', { text: 'With only one tab, the sheet shows no tab bar (good for item sheets).' }),
    ];
  }

  sheetSettings() {
    const L = this.layout;
    const header = L.header !== false;
    return [
      el('div.dz-head', {}, el('strong', { text: 'Sheet' })),
      this.text(L, 'name', 'Name of this layout', { placeholder: 'Sheet', after: () => this.win.setTitle(`Sheet designer: ${label(this.type)} › ${L.name || 'Sheet'}`) }),
      el('label.check', {}, el('input', { type: 'checkbox', checked: header, on: { change: (e) => this.edit(() => { if (e.target.checked) L.header = { portrait: !this.isItem, blocks: [], side: [] }; else L.header = false; }) } }), 'Header (name, picture, header values)'),
      header ? this.check(L.header, 'portrait', 'Picture in the header', { invert: true }) : null,
      el('details.dz-style', { open: !!L.style },
        el('summary', { text: L.style ? 'Colours for this layout (changed)' : 'Colours for this layout' }),
        el('p.muted.small', { text: 'Override the system\'s Sheet style for this layout only; unticked colours follow it.' }),
        ...[['accent', 'Accent (names, titles)', '#d9a52b'], ['background', 'Sheet background', '#1b1b1d'], ['header', 'Header and tab bar', '#141416'],
          ['box', 'Boxes and cards', '#252527'], ['raised', 'Rows inside cards', '#313134'], ['input', 'Input boxes', '#1e1e20'], ['text', 'Text', '#ebe8e3'],
          ['muted', 'Labels', '#9c978f'], ['border', 'Borders', '#3b3b3f'], ['button', 'Buttons', '#8e1d1d']].map(([k, l, d]) => this.colorField(L, k, l, d)),
        el('button.small', { type: 'button', text: 'Use the system\'s colours', disabled: !L.style, on: { click: () => this.edit(() => { delete L.style; }) } })),
      el('div.dz-help', {},
        el('p', { text: 'Drag fields and blocks from the left onto the sheet. Click one to change it here.' }),
        el('ul', {},
          el('li', { text: 'Drag a block to move it; drag its right or bottom edge to resize it. Others move out of the way.' }),
          el('li', { text: 'Drop on the header for small values under the name, or on its right for HP, AC…' }),
          el('li', { text: 'Click a tab to rename it, give it an icon or move it; "+ Tab" adds one.' }),
          el('li', { text: 'Delete removes the selected block; Ctrl+Z undoes.' }))),
      el('button.small', {
        type: 'button', text: 'Start again from the generated sheet',
        on: { click: () => { if (confirm('Replace this layout with the one generated from the tree? (Ctrl+Z undoes.)')) this.edit(() => { const fresh = layoutFromType(this.type, this.isItem); const keep = { id: L.id, name: L.name }; Object.keys(L).forEach((k) => delete L[k]); Object.assign(L, fresh, keep); this.normalize(); this.tab = L.tabs?.[0]?.key; }); } },
      }),
    ].filter(Boolean);
  }
}
