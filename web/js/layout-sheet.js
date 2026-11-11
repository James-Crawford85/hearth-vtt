// Designed sheets: layouts made in the sheet designer, kept apart from the
// system's data tree. A layout places blocks on a 12-column grid; each block
// shows a field (by its @path), a list of items, a heading, text, conditions…
// Moving blocks around never changes the data, so formulas keep working.
//
// A layout (one entry of a type's `layouts`):
//   { id, name,
//     header: { portrait: true, blocks: [...], side: [...] } | false,   // under the name / on the right
//     top: [...],                                                        // above the tabs
//     tabs: [ { key, label, icon, blocks: [...] } ] }                   // one tab: no tab bar
// A block:
//   { id, kind, x, y, w, h, ... }      x 1–12, w columns, y row, h rows (a minimum: content can grow)
//   field:      bind ("abilities.str.mod"), label, hide_label, display (big | badge | inline | plain)
//   group:      title, hide_label, frame (box | card | plain), blocks (its own 12-column grid)
//   items:      item_type, title                    (actor sheets)
//   heading:    text;   text: text (markdown);   image: src;   divider
//   conditions, rests, problems, advance            (actor sheets)
// Any block: overflow "grow" (default) | "scroll" (stays h rows tall) | "limit" (first `limit` rows, then "Show all");
//   fit: true keeps it at its content's height (otherwise it fills its rows, matching its neighbours).

import { isGM, ownsActor, systemInfo } from './store.js';
import { el } from './ui.js';
import { sheetIcon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { bindSheet, bindInputs, conditionsBar, restsBar, errorsBox } from './sheets.js';
import { applyStyle, renderNode, portrait, itemSection, label, styleCss } from './blueprint-sheet.js';
import { grantTypes, openAdd } from './advancement.js';

export const COLUMNS = 12;
const lastTab = new Map();   // `${actorId}/${itemId}` → tab key
const showAll = new Set();   // `${owner}/${blockId}`: "limit" blocks opened in full

/** The node at a data path, looking through layout-only groups (which add nothing to paths). */
export function nodeAt(nodes, path) {
  const segs = Array.isArray(path) ? path : String(path).split('.');
  for (const n of nodes ?? []) {
    if (n.kind === 'group' && n.flat) {
      const inner = nodeAt(n.children, segs);
      if (inner) return inner;
      continue;
    }
    if (n.key !== segs[0]) continue;
    if (segs.length === 1) return n;
    return n.kind === 'group' ? nodeAt(n.children, segs.slice(1)) : null;
  }
  return null;
}

// ------------------------------------------------------------------ rendering

function placement(b) {
  const w = Math.max(1, Math.min(COLUMNS, Number(b.w) || COLUMNS));
  const h = Math.max(1, Number(b.h) || 1);
  const x = Number(b.x) || 0;
  const y = Number(b.y) || 0;
  return [x ? `grid-column: ${x} / span ${w}` : `grid-column: span ${w}`, y ? `grid-row: ${y} / span ${h}` : `grid-row: span ${h}`, `--lt-h: ${h}`].join('; ');
}

/** A block grid. `container` names it for the designer: "top", "tab:<key>" or "group:<block id>". */
function grid(blocks, ctx, container) {
  return el('div.lt-grid', { 'data-container': ctx.design ? container : null }, ...(blocks ?? []).map((b) => block(b, ctx)).filter(Boolean));
}

/** What each block kind is called (the designer's palette and placeholders). */
export const BLOCK_KINDS = {
  field: 'Field', group: 'Box', items: 'Item list', heading: 'Heading', text: 'Text', image: 'Picture', divider: 'Line',
  conditions: 'Conditions', rests: 'Rest buttons', problems: 'Formula problems (GM)', advance: 'Advance button',
};

/** One block, in its grid cell. */
function block(b, ctx) {
  let content = blockContent(b, ctx);
  // In the designer, blocks that show nothing right now still get a place you can select.
  if (!content && ctx.design) {
    const node = b.kind === 'field' ? nodeAt(ctx.type.children, b.bind ?? '') : null;
    const what = node ? label(node) : BLOCK_KINDS[b.kind] ?? b.kind;
    content = el('div.lt-placeholder', { text: b.kind === 'image' ? 'Picture (none chosen)' : `${what} (hidden in this preview)`, title: node?.kind === 'action' ? 'An action whose "Only when" is false for this preview' : null });
  }
  if (!content) return null;
  const overflow = b.overflow || 'grow';
  const cell = el('div', { class: `lt-block lt-${b.kind} lt-overflow-${overflow}${b.fit ? ' lt-fit' : ''}`, 'data-block': b.id ?? null, style: ctx.compact ? null : placement(b) }, content);
  if (overflow === 'limit' && b.limit > 0) limitRows(cell, b, ctx);
  if (b.style) styleBlock(cell, b.style);
  return cell;
}

const COLOR = /^#[0-9a-f]{3,8}$/i;
const px = (v, lo, hi) => (Number.isFinite(Number(v)) && v !== '' && v != null ? `${Math.max(lo, Math.min(hi, Number(v)))}px` : null);

/**
 * A block's own look (from the designer's Style settings): text size and colour,
 * bold, italic, alignment; the label's size and colour; background, border,
 * corners and inner spacing. CSS in core.css reads the variables set here.
 */
export function styleBlock(cell, st) {
  const set = (name, v) => { if (v) cell.style.setProperty(name, v); };
  const flag = (name, on) => { if (on) cell.dataset[name] = ''; };
  const color = (v) => (COLOR.test(String(v ?? '')) ? v : null);
  set('--lt-fs', px(st.size, 8, 96)); flag('fs', px(st.size, 8, 96));
  set('--lt-fc', color(st.color)); flag('fc', color(st.color));
  set('--lt-ls', px(st.label_size, 8, 48)); flag('ls', px(st.label_size, 8, 48));
  set('--lt-lc', color(st.label_color)); flag('lc', color(st.label_color));
  flag('bold', st.bold);
  flag('italic', st.italic);
  if (['left', 'center', 'right'].includes(st.align)) cell.dataset.align = st.align;
  if (color(st.background)) { cell.style.background = st.background; cell.dataset.bg = ''; }
  const width = { thin: 1, thick: 3 }[st.border];
  if (width) cell.style.border = `${width}px solid ${color(st.border_color) ?? 'var(--border)'}`;
  if (px(st.radius, 0, 60)) cell.style.borderRadius = px(st.radius, 0, 60);
  if (px(st.padding, 0, 60)) cell.style.padding = px(st.padding, 0, 60);
}

/** "limit": the first N rows (table rows or item cards), then a "Show all" button. */
function limitRows(cell, b, ctx) {
  const key = `${ctx.owner}/${b.id}`;
  const rows = [...cell.querySelectorAll('tbody > tr, .bp-item-card')];
  if (rows.length <= b.limit || showAll.has(key)) return;
  rows.slice(b.limit).forEach((r) => { r.hidden = true; });
  cell.append(el('button.small.lt-more', {
    type: 'button', text: `Show all (${rows.length})`,
    on: { click: (e) => { showAll.add(key); rows.forEach((r) => { r.hidden = false; }); e.currentTarget.remove(); } },
  }));
}

function blockContent(b, ctx) {
  switch (b.kind) {
    case 'field': {
      const node = nodeAt(ctx.type.children, b.bind ?? '');
      if (!node) return isGM() ? el('div.lt-missing', { text: `@${b.bind} isn't a field any more`, title: 'Fix or remove this block in the sheet designer' }) : null;
      // The block can relabel or restyle the field; it keeps its own place.
      const shown = { ...node, span: 0, label: b.label ?? node.label, hide_label: b.hide_label ?? node.hide_label, display: b.display ?? node.display, hint: b.hint ?? (b.show_hint === false ? '' : node.hint) };
      return renderNode(shown, String(b.bind).split('.'), ctx);
    }
    case 'group':
      return el('section', { class: `bp-group bp-frame-${b.frame || 'box'}` },
        b.hide_label || !b.title ? null : el('h4.bp-group-title', { text: b.title }),
        grid(b.blocks, ctx, `group:${b.id}`));
    case 'items': {
      if (!ctx.actor || ctx.itemId) return null;
      const t = (systemInfo().blueprint?.item_types ?? []).find((x) => x.key === b.item_type);
      if (!t) return isGM() ? el('div.lt-missing', { text: `No item type "${b.item_type}"` }) : null;
      return itemSection(ctx.actor, t, ctx.api, ctx.editable, { title: b.title });
    }
    case 'heading':
      return el('h3.lt-heading', { text: b.text ?? '' });
    case 'text':
      return el('div.journal-text.lt-text', {}, renderMarkdown(b.text ?? '', { onLink: (name) => ctx.api.lookup?.follow(name) || ctx.api.journal?.follow(name) }));
    case 'image':
      return b.src ? el('img.lt-image', { src: b.src, alt: b.alt ?? '' }) : null;
    case 'divider':
      return el('hr.lt-divider');
    case 'conditions':
      return ctx.itemId ? null : conditionsBar(ctx.actor);
    case 'rests':
      return ctx.itemId ? null : restsBar();
    case 'problems':
      return errorsBox(ctx.actor);
    case 'advance':
      return ctx.editable && !ctx.itemId && grantTypes().length ? el('button.bp-btn', { type: 'button', text: b.text || '⬆ Advance', on: { click: () => openAdd(ctx.api, ctx.actor.id) } }) : null;
    default:
      return null;
  }
}

/** Header, top, then tabs (a single tab shows without a tab bar). */
function renderLayout(layout, ctx, { nameInput, picture }) {
  applyStyle();
  const scope = `${ctx.type.key}--${layout.id ?? 'main'}`.replace(/[^\w-]/g, '_');
  const root = el('div.sheet.bp-sheet.lt-sheet', { 'data-type': ctx.type.key, 'data-layout': layout.id ?? null, 'data-scope': scope });
  // A layout can have its own colours and fonts, over the system's Sheet style.
  const own = layout.style && typeof layout.style === 'object' ? styleCss(layout.style) : '';
  if (own) root.append(el('style', { text: own.replace(/\.bp-sheet/g, `.bp-sheet[data-scope="${scope}"]`) }));
  const head = layout.header === false ? null : (layout.header ?? {});
  const compact = { ...ctx, compact: true };
  if (head) {
    root.append(el('header.bp-header', {},
      head.portrait === false ? null : picture,
      el('div.bp-ident', {}, nameInput, (head.blocks ?? []).length || ctx.design
        ? el('div.bp-header-stats', { 'data-container': ctx.design ? 'header' : null }, ...(head.blocks ?? []).map((b) => block(b, compact)).filter(Boolean)) : null),
      (head.side ?? []).length || ctx.design
        ? el('div.bp-vitals', {}, el('div.bp-vitals-group', { 'data-container': ctx.design ? 'side' : null }, ...(head.side ?? []).map((b) => block(b, compact)).filter(Boolean))) : null));
  } else {
    root.append(el('div.sheet-head', {}, nameInput));
  }
  if (layout.top?.length || ctx.design) root.append(el('div.bp-top', {}, grid(layout.top, ctx, 'top')));
  const tabs = ctx.design ? (layout.tabs ?? []) : (layout.tabs ?? []).filter((t) => t.blocks?.length || layout.tabs.length === 1);
  const body = el('div.bp-tab-body');
  if (tabs.length > 1 || (ctx.design && tabs.length)) {
    const bar = el('nav.bp-tabs', { role: 'tablist' });
    const icons = tabs.some((t) => t.icon);
    if (icons) bar.classList.add('bp-tabs-icons');
    let current = ctx.design ? ctx.design.tab : lastTab.get(ctx.owner);
    if (!tabs.some((t) => t.key === current)) current = tabs[0].key;
    const show = (key) => {
      lastTab.set(ctx.owner, key);
      for (const b of bar.children) { b.classList.toggle('active', b.dataset.tab === key); b.setAttribute('aria-selected', String(b.dataset.tab === key)); }
      const tab = tabs.find((t) => t.key === key);
      body.replaceChildren(grid(tab.blocks, ctx, `tab:${key}`));
      styleTab(body, tab.style);
      bindInputs(body, ctx.actor, ctx.api);
    };
    for (const t of tabs) {
      bar.append(el('button', { type: 'button', role: 'tab', 'data-tab': t.key, on: { click: () => (ctx.design ? ctx.design.onTab(t.key) : show(t.key)) } },
        icons ? sheetIcon(t.icon || 'star') : null, el('span', { text: t.label || t.key })));
    }
    root.append(el('div.bp-main', {}, bar, body));
    root._show = () => show(current);
  } else {
    body.append(grid(tabs[0]?.blocks, ctx, `tab:${tabs[0]?.key}`));
    styleTab(body, tabs[0]?.style);
    root.append(el('div.bp-main', {}, body));
  }
  return root;
}

/** A tab's own background and text colour. */
function styleTab(body, st) {
  body.style.background = COLOR.test(String(st?.background ?? '')) ? st.background : '';
  const fg = COLOR.test(String(st?.color ?? '')) ? st.color : '';
  body.style.color = fg;
  if (fg) body.style.setProperty('--lt-tab-fg', fg); else body.style.removeProperty('--lt-tab-fg');
  body.classList.toggle('lt-tab-styled', !!(st?.background || st?.color));
}

/** An actor's designed sheet. */
export function layoutSheet(actor, type, layout, api, design = null) {
  const editable = isGM() || ownsActor(actor.id);
  const ctx = { actor, type, prefix: 'data', derived: actor.derived ?? {}, editable, api, owner: design ? 'designer' : actor.id, design };
  const root = renderLayout(layout, ctx, {
    nameInput: el('input.title-input', { name: 'name', 'aria-label': 'Name' }),
    picture: portrait(actor, api, editable),
  });
  bindSheet(root, actor, api);
  root._show?.();
  return root;
}

/** An owned item's designed sheet. */
export function layoutItemSheet(actor, item, type, layout, api, design = null) {
  const ctx = { actor, item, itemId: item.id, type, prefix: `items.${item.id}.data`, derived: actor.derived?.items?.[item.id] ?? {}, editable: isGM() || ownsActor(actor.id), api, owner: design ? 'designer' : `${actor.id}/${item.id}`, design };
  const root = renderLayout(layout, ctx, {
    nameInput: el('input.title-input', { name: `items.${item.id}.name`, 'aria-label': 'Name' }),
    picture: item.img ? el('div.bp-portrait', {}, el('img', { src: item.img, alt: '' })) : null,
  });
  root._show?.();
  return root;
}

// ------------------------------------------------------------------ a layout from the generated sheet

/**
 * A layout matching the sheet generated from a type's tree, as a starting point
 * for the designer. Blocks point at fields; the fields' own labels and styles
 * show unless a block overrides them.
 */
export function layoutFromType(type, isItem = false) {
  let seq = 0;
  const id = () => `b${(++seq).toString(36)}`;
  const itemTypes = systemInfo().blueprint?.item_types ?? [];

  // Lay blocks out left to right, wrapping at 12 columns.
  const place = (blocks) => {
    let x = 1, y = 1, rowH = 1;
    for (const b of blocks) {
      if (x + b.w - 1 > COLUMNS) { x = 1; y += rowH; rowH = 1; }
      b.x = x; b.y = y;
      x += b.w;
      rowH = Math.max(rowH, b.h);
    }
    return blocks;
  };
  const widthOf = (n, cols) => {
    const per = cols ? Math.max(1, Math.floor(COLUMNS / cols)) : 3;
    if (n.span === 99) return COLUMNS;
    if (!n.span && ['group', 'list', 'longtext'].includes(n.kind)) return COLUMNS;
    return Math.min(COLUMNS, per * (n.span || 1));
  };
  const blocksFor = (nodes, prefix, cols) => place((nodes ?? []).filter((n) => !n.hidden && n.kind !== 'effect').map((n) => {
    const path = prefix ? `${prefix}.${n.key}` : n.key;
    if (n.kind === 'group') {
      return { id: id(), kind: 'group', title: label(n), hide_label: n.hide_label || undefined, frame: n.frame || undefined, w: widthOf(n, cols), h: 1,
        blocks: blocksFor(n.children, n.flat ? prefix : path, n.columns) };
    }
    return { id: id(), kind: 'field', bind: path, w: widthOf(n, cols), h: n.kind === 'longtext' ? 3 : 1 };
  }));
  const fieldsOf = (groups) => groups.flatMap((g) => blocksFor(g.children, g.flat ? '' : g.key, 0)).map((b) => { delete b.x; delete b.y; return b; });

  if (isItem) {
    return { id: 'main', name: 'Sheet', header: { portrait: false }, tabs: [{ key: 'main', label: label(type), blocks: blocksFor(type.children, '', type.columns) }] };
  }
  const visible = (type.children ?? []).filter((n) => !n.hidden);
  const isGroup = (n) => n.kind === 'group';
  const placed = (p) => visible.filter((n) => isGroup(n) && n.place === p);
  const tabGroups = visible.filter((n) => isGroup(n) && !n.place);
  const tabKeys = new Set(tabGroups.map((g) => g.key));
  const itemsOn = (where) => itemTypes.filter((t) => (where === '' ? !t.tab || (t.tab !== 'own' && !tabKeys.has(t.tab)) : t.tab === where));
  const itemBlocks = (types) => place(types.map((t) => ({ id: id(), kind: 'items', item_type: t.key, w: types.length > 1 ? 6 : COLUMNS, h: 2 })));
  const tabs = tabGroups.map((g) => {
    const fields = blocksFor(g.children, g.flat ? '' : g.key, g.columns);
    const rows = fields.reduce((m, b) => Math.max(m, b.y + b.h - 1), 0);
    const items = itemBlocks(itemsOn(g.key)).map((b) => ({ ...b, y: b.y + rows }));
    return { key: g.key, label: label(g), icon: g.icon || undefined, blocks: [...fields, ...items] };
  });
  for (const t of itemsOn('own')) tabs.push({ key: `items_${t.key}`, label: label(t), icon: t.icon || 'items', blocks: itemBlocks([t]) });
  if (itemsOn('').length) tabs.push({ key: 'items', label: 'Items', icon: 'backpack', blocks: itemBlocks(itemsOn('')) });
  tabs.push({ key: 'status', label: 'Status', icon: 'heart', blocks: place([
    { id: id(), kind: 'conditions', w: COLUMNS, h: 1 }, { id: id(), kind: 'rests', w: COLUMNS, h: 1 }, { id: id(), kind: 'problems', w: COLUMNS, h: 1 }]) });
  return {
    id: 'main',
    name: 'Sheet',
    header: { portrait: true, blocks: fieldsOf(placed('header')), side: [...fieldsOf(placed('vitals')), { id: id(), kind: 'advance', w: 3, h: 1 }] },
    top: blocksFor([...visible.filter((n) => !isGroup(n) || n.place === 'top'), ...placed('side')], '', 0),
    tabs,
  };
}

/** A short description of a layout, for the builder. */
export function describeLayout(layout) {
  let blocks = 0;
  const count = (bs) => { for (const b of bs ?? []) { blocks++; count(b.blocks); } };
  count(layout.header?.blocks); count(layout.header?.side); count(layout.top);
  for (const t of layout.tabs ?? []) count(t.blocks);
  const tabs = layout.tabs?.length ?? 0;
  return `${blocks} block${blocks === 1 ? '' : 's'}${tabs > 1 ? ` on ${tabs} tabs` : ''}`;
}

/**
 * The layout a sheet uses: the one an actor picked (flags.core.layout), else the
 * type's default, else the first.
 */
export function layoutFor(type, actor = null) {
  const all = type?.layouts ?? [];
  const pick = actor?.flags?.core?.layout;
  return all.find((l) => l.id === pick) ?? all.find((l) => l.id === type.default_layout) ?? all[0] ?? null;
}

/** An id for a new layout of a type. */
export function newLayoutId(type) {
  const ids = new Set((type.layouts ?? []).map((l) => l.id));
  let n = ids.size + 1;
  while (ids.has(`layout_${n}`)) n++;
  return `layout_${n}`;
}
