// Sheets laid out from the system builder's tree (blueprint): fields become
// inputs, formulas show the server's calculated values, lists become tables,
// resources show current / max, actions become roll buttons.
//
// Layout comes from the tree too: each node can hide its label, take a number
// of columns, and show as normal / big / badge / inline / plain; groups set
// their columns and frame, and top-level groups are tabs, sit above the tabs,
// or form a side column. The system's Sheet style (colours, fonts, CSS)
// applies to every sheet.
//
// Markup (the same in exported HTML sheets, so CSS works on both):
//   .bp-sheet[data-type]            the sheet
//   .bp-group[data-key]             a group;  .bp-group-title, .bp-grid
//   .bp-field.bp-<kind>[data-key]   a field;  .bp-label, .bp-val, .bp-show-<display>
//   table.bp-list[data-key]         a list
// Inputs use the normal sheet binding (`name="data.x"` or `name="items.<id>.data.x"`).

import { store, getPath, isGM, ownsActor, systemInfo } from './store.js';
import { el, openWindow, toast } from './ui.js';
import { sheetIcon } from './icons.js';
import { bindSheet, bindInputs, conditionsBar, restsBar, errorsBox, loadTemplate, renderTemplate } from './sheets.js';
import { layoutItemSheet, layoutFor } from './layout-sheet.js';
import { grantTypes, levelsKey, levelOf, openAdd, openAdvance, regress, removeItem, advancementEditor, effectsEditor, partsView } from './advancement.js';
import { isCharacterType } from './creation.js';
import { canForge, openForge } from './forge.js';

const lastTab = new Map(); // actor id → tab key

/** Which sheet a type uses: 'generated', 'designed', 'html' or 'none' (item types only). */
export function sheetMode(type) {
  if (!type) return 'generated';
  if (type.sheet_mode) return type.sheet_mode === 'designed' && !type.layouts?.length ? 'generated' : type.sheet_mode;
  return type.sheet ? 'html' : 'generated';
}

export function blueprintType(kind, items = false) {
  const bp = systemInfo().blueprint;
  return (items ? bp?.item_types : bp?.actor_types)?.find((t) => t.key === kind) ?? null;
}

export const label = (n) => n.label || n.key;
export const fmt = (v) => (v == null || v === '' ? '—' : typeof v === 'number' ? String(Math.round(v * 100) / 100) : typeof v === 'object' ? JSON.stringify(v) : String(v));

// ------------------------------------------------------------------ the system's sheet style

/** CSS for the system's Sheet style (colours, fonts, rounding, extra CSS). Shared with the builder. */
export function styleCss(style) {
  const s = style ?? {};
  const vars = [
    ['--accent', s.accent], ['--text', s.text], ['--muted', s.muted], ['--border', s.border],
    ['--panel-2', s.box], ['--panel-3', s.raised],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v};`);
  const rules = [];
  const sheet = [...vars];
  if (s.background) sheet.push(`background: ${s.background};`, 'padding: 10px;', 'border-radius: 8px;');
  if (s.text) sheet.push(`color: ${s.text};`);
  if (s.body_font) sheet.push(`font-family: ${s.body_font};`);
  if (sheet.length) rules.push(`.bp-sheet { ${sheet.join(' ')} }`);
  if (s.header) sheet.push(`--sheet-header: ${s.header};`);
  if (s.box) rules.push(`.bp-sheet .bp-group, .bp-sheet .bp-show-big, .bp-sheet .bp-show-badge, .bp-sheet .bp-formula { background: ${s.box}; }`);
  if (s.input) rules.push(`.bp-sheet :where(input:not([type=checkbox]):not([type=file]), select, textarea) { background: ${s.input}; }`);
  if (s.button) {
    rules.push(`.bp-sheet .bp-action, .bp-sheet .bp-btn, .bp-sheet .roll-btn, .bp-sheet button[data-rest], .bp-sheet button[data-action="create-item"] { background: ${s.button}; border-color: ${s.button}; color: #fff; }`,
      `.bp-sheet .bp-action:hover, .bp-sheet .bp-btn:hover, .bp-sheet .roll-btn:hover { filter: brightness(1.15); border-color: ${s.button}; }`);
  }
  if (s.heading_font) rules.push(`.bp-sheet .bp-group-title, .bp-sheet .title-input, .bp-sheet .bp-list-title, .bp-sheet .bp-tabs button { font-family: ${s.heading_font}; }`);
  if (s.radius != null && s.radius !== '') rules.push(`.bp-sheet .bp-group, .bp-sheet input, .bp-sheet select, .bp-sheet textarea, .bp-sheet button, .bp-sheet .bp-formula { border-radius: ${Number(s.radius)}px; }`);
  if (s.css) rules.push(String(s.css));
  return rules.join('\n');
}

/** Put the system's sheet style on the page (once per change). */
export function applyStyle() {
  const css = styleCss(systemInfo().blueprint?.style);
  let tag = document.getElementById('bp-system-style');
  if (!tag) { tag = el('style#bp-system-style'); document.head.append(tag); }
  if (tag.textContent !== css) tag.textContent = css;
}

// ------------------------------------------------------------------ fields

/** Grid placement for a node: span N columns, or the whole row. */
function spanStyle(n, fallbackFull = false) {
  if (n.span === 99 || (!n.span && fallbackFull)) return 'grid-column: 1 / -1';
  return n.span ? `grid-column: span ${n.span}` : null;
}

function fieldClass(n) {
  return ['bp-field', `bp-${n.kind}`, n.display ? `bp-show-${n.display}` : '', n.hide_label ? 'bp-nolabel' : ''].filter(Boolean).join(' ');
}

const labelEl = (n) => (n.hide_label ? null : el('span.bp-label', { text: label(n) }));
export function hintOf(n) { return n.hint ? el('small.muted.field-hint', { text: n.hint }) : null; }

/**
 * Render nodes. ctx: { actor, prefix ('data' or 'items.<id>.data'), derived (object), itemId, editable }
 */
export function renderNodes(nodes, path, ctx) {
  const out = [];
  for (const n of nodes ?? []) {
    if (n.hidden) continue;
    const node = renderNode(n, [...path, n.key], ctx);
    if (node) out.push(node);
  }
  return out;
}

function choiceOptions(n, ctx) {
  if (n.source) {
    // Options from a list's entries (e.g. the abilities). The list may be on
    // this type, or (for an item) on its owner's type.
    const list = findNode(ctx.type?.children ?? [], n.source) ?? findNode(blueprintType(ctx.actor.kind)?.children ?? [], n.source);
    const keys = Object.keys(getPath(ctx.actor.data, n.source) ?? {});
    const labels = Object.fromEntries((list?.entries ?? []).map((e) => [e.key, e.label || e.key]));
    // A blank first option, so an unpicked value shows as unpicked.
    return [['', '—'], ...keys.map((k) => [k, labels[k] ?? k])];
  }
  return (n.options ?? []).map((o) => [o.value, o.label || o.value]);
}

export function findNode(nodes, key) {
  for (const n of nodes) {
    if (n.key === key) return n;
    const inner = n.children && findNode(n.children, key);
    if (inner) return inner;
  }
  return null;
}

/** A group's grid: a set number of columns, or as many as fit. */
export function gridFor(n, children) {
  const grid = el('div.bp-grid', {}, ...children);
  if (n?.columns) grid.style.gridTemplateColumns = `repeat(${n.columns}, minmax(0, 1fr))`;
  return grid;
}

function renderGroup(n, path, ctx) {
  const inner = renderNodes(n.children, n.flat ? path.slice(0, -1) : path, ctx);
  return el('section', {
    class: ['bp-group', `bp-frame-${n.frame || 'box'}`].join(' '), 'data-key': path.join('.'), style: spanStyle(n, true),
  }, n.hide_label ? null : el('h4.bp-group-title', { text: label(n) }), hintOf(n), gridFor(n, inner));
}

export function renderNode(n, path, ctx) {
  const name = `${ctx.prefix}.${path.join('.')}`;
  const key = path.join('.');
  const derivedAt = (p) => getPath(ctx.derived, p.join('.'));
  const aria = n.hide_label ? label(n) : null;
  const wrap = (tag, ...kids) => el(tag, { class: fieldClass(n), 'data-key': key, style: spanStyle(n, n.kind === 'longtext'), title: n.hide_label ? label(n) : null }, ...kids);
  switch (n.kind) {
    case 'group':
      return renderGroup(n, path, ctx);
    case 'number':
      return wrap('label', labelEl(n), el('input', { type: 'number', name, step: 'any', min: n.min ?? null, max: n.max ?? null, 'aria-label': aria }), hintOf(n));
    case 'text':
      return wrap('label', labelEl(n), el('input', { type: 'text', name, 'aria-label': aria }), hintOf(n));
    case 'longtext':
      return wrap('label', labelEl(n), el('textarea', { name, rows: 4, 'aria-label': aria }), hintOf(n));
    case 'checkbox':
      return wrap('label', el('input', { type: 'checkbox', name, 'aria-label': aria }), labelEl(n));
    case 'choice':
      return wrap('label', labelEl(n), el('select', { name, 'aria-label': aria }, ...choiceOptions(n, ctx).map(([v, l]) => el('option', { value: v, text: l }))), hintOf(n));
    case 'formula':
      return wrap('div', labelEl(n), el('strong.bp-val', { text: fmt(derivedAt(path)), title: n.formula }));
    case 'resource': {
      const max = derivedAt([...path, 'max']);
      const own = ctx.itemId ? String(getPath(ctx.item?.data ?? {}, `${path.join('.')}.formula`) ?? '').trim() : '';
      return wrap('div', labelEl(n),
        el('span.bp-res', {},
          el('input', { type: 'number', name: `${name}.value`, 'aria-label': `${label(n)} (current)` }),
          el('span.muted', { text: '/' }),
          n.formula || own ? el('span.bp-max', { text: fmt(max), title: own ? `Max: ${own}` : n.formula }) : el('input', { type: 'number', name: `${name}.max`, 'aria-label': `${label(n)} (max)` })),
        // On an item (a feature's uses), the max can be a formula of its own: @abilities.cha.mod, @level…
        ctx.itemId && !n.formula && ctx.editable ? el('input.bp-max-formula', { type: 'text', name: `${name}.formula`, placeholder: 'or a formula for the max, e.g. @abilities.cha.mod', 'aria-label': `${label(n)}: max formula` }) : null,
        hintOf(n));
    }
    case 'list':
      return renderList(n, path, ctx);
    case 'action':
      // Hidden while its condition is false (the server works that out).
      if ((ctx.derived?._off ?? []).includes(n.key)) return null;
      return el('button', {
        type: 'button', class: ['bp-action', n.display ? `bp-show-${n.display}` : ''].filter(Boolean).join(' '), 'data-key': key, style: spanStyle(n),
        'data-use': n.key, 'data-item-id': ctx.itemId ?? null, title: n.hide_label ? `${label(n)}: ${n.roll}` : n.roll, text: n.hide_label ? '🎲' : label(n),
      });
    default:
      return null;
  }
}

function renderList(n, path, ctx) {
  const value = ctx.itemId ? getPath(ctx.item.data, path.join('.')) : getPath(ctx.actor.data, path.join('.'));
  // The builder's entries, in its order. Lists players can add to ("open") also
  // show what they added; others ignore stray keys left in the data by older
  // versions of the system.
  const order = (n.entries ?? []).map((e) => e.key);
  const present = n.open ? Object.keys(value ?? {}) : [];
  const entries = [...new Set([...order, ...present])].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b);
  });
  const fields = (n.children ?? []).filter((c) => !c.hidden);
  const known = Object.fromEntries((n.entries ?? []).map((e) => [e.key, e.label || e.key]));
  // A list can roll for each entry (a skill check, a save): @this is the entry.
  const rollFor = (key) => n.roll.replace(/@this\b/g, `@${path.join('.')}.${key}`).replace(/@key\b/g, key);
  const rows = entries.map((key) => el('tr', { 'data-key': `${path.join('.')}.${key}` },
    n.roll ? el('td.bp-roll', {}, el('button.icon.roll-btn', { type: 'button', 'data-roll': rollFor(key), 'data-flavor': `${known[key] ?? key}${n.label ? ` (${n.label})` : ''}`, title: 'Roll (Alt: advantage, Ctrl: disadvantage, Shift: GM only)', text: '🎲' })) : null,
    el('th', { text: known[key] ?? key }),
    ...fields.map((f) => el('td', { class: `bp-${f.kind}`, 'data-col': f.key }, cell(f, [...path, key, f.key], ctx))),
    n.open && ctx.editable ? el('td', {}, el('button.icon', {
      type: 'button', title: 'Remove', text: '✕',
      on: { click: () => ctx.api.update.actor(ctx.actor.id, { data: nestPatch([...path, key], null) }) },
    })) : null));
  const table = el('table.bp-list', { 'data-key': path.join('.') },
    el('thead', {}, el('tr', {}, n.roll ? el('th') : null, el('th'), ...fields.map((f) => el('th', { text: f.hide_label ? '' : label(f), title: label(f) })), n.open ? el('th') : null)),
    el('tbody', {}, ...rows));
  const parts = [n.hide_label ? null : el('div.bp-list-title', { text: label(n) }), hintOf(n), table];
  if (n.open && ctx.editable && !ctx.itemId) {
    parts.push(el('button.small', {
      type: 'button', text: `+ ${label(n)}`,
      on: {
        click: () => {
          const name = prompt(`New ${label(n)} entry name`);
          if (!name?.trim()) return;
          const key = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || `entry_${Date.now()}`;
          const entry = {};
          for (const f of fields) if (f.kind !== 'formula') entry[f.key] = defaultFor(f);
          ctx.api.update.actor(ctx.actor.id, { data: nestPatch([...path, key], entry) });
        },
      },
    }));
  }
  return el('div.bp-list-wrap', { style: spanStyle(n, true) }, ...parts.filter(Boolean));
}

function cell(f, path, ctx) {
  const name = `${ctx.prefix}.${path.join('.')}`;
  const aria = label(f);
  switch (f.kind) {
    case 'number': return el('input', { type: 'number', name, step: 'any', 'aria-label': aria });
    case 'checkbox': return el('input', { type: 'checkbox', name, 'aria-label': aria });
    case 'choice': return el('select', { name, 'aria-label': aria }, ...choiceOptions(f, ctx).map(([v, l]) => el('option', { value: v, text: l })));
    case 'formula': return el('strong.bp-val', { text: fmt(getPath(ctx.derived, path.join('.'))), title: f.formula });
    default: return el('input', { type: 'text', name, 'aria-label': aria });
  }
}

function defaultFor(n) {
  if (n.default != null && n.default !== '') return n.default;
  switch (n.kind) {
    case 'number': return 0;
    case 'checkbox': return false;
    case 'choice': return n.options?.[0]?.value ?? '';
    default: return '';
  }
}

function nestPatch(path, value) {
  const out = {};
  let cur = out;
  path.forEach((k, i) => { cur[k] = i === path.length - 1 ? value : {}; cur = cur[k]; });
  return out;
}

// ------------------------------------------------------------------ the sheet

/** The portrait in the sheet's header; owners click it to upload a new picture. */
export function portrait(actor, api, editable) {
  const pic = actor.img ? el('img', { src: actor.img, alt: '' }) : el('span', { text: (actor.name || '?').charAt(0).toUpperCase() });
  if (!editable) return el('div.bp-portrait', {}, pic);
  const file = el('input', {
    type: 'file', accept: 'image/*', hidden: true,
    on: {
      change: async () => {
        const f = file.files[0];
        if (!f) return;
        try { api.update.actor(actor.id, { img: await api.upload(f) }); } catch (e) { toast(`Upload failed: ${e.message ?? e}`, 'error'); }
      },
    },
  });
  return el('button.bp-portrait', { type: 'button', title: 'Change the picture', on: { click: () => file.click() } }, pic, file);
}

/** Header groups ("header": small values under the name; "vitals": the right-hand side). */
function headerGroups(groups, ctx, cls) {
  return groups.map((g) => el(`div.${cls}`, { 'data-key': g.key }, ...renderNodes(g.children, g.flat ? [] : [g.key], ctx)));
}

/** The actor sheet for a blueprint type. */
export function blueprintSheet(actor, type, api) {
  applyStyle();
  const editable = isGM() || ownsActor(actor.id);
  const ctx = { actor, type, prefix: 'data', derived: actor.derived ?? {}, editable, api };
  const visible = (type.children ?? []).filter((n) => !n.hidden);
  const isGroup = (n) => n.kind === 'group';
  const placed = (p) => visible.filter((n) => isGroup(n) && n.place === p);
  const top = visible.filter((n) => !isGroup(n) || n.place === 'top');
  const tabGroups = visible.filter((n) => isGroup(n) && !n.place);
  const itemTypes = systemInfo().blueprint?.item_types ?? [];
  const tabKeys = new Set(tabGroups.map((g) => g.key));
  const itemsOn = (where) => itemTypes.filter((t) => (where === '' ? !t.tab || (t.tab !== 'own' && !tabKeys.has(t.tab)) : t.tab === where));

  const canAdvance = editable && grantTypes().length > 0;
  const header = el('header.bp-header', {},
    portrait(actor, api, editable),
    el('div.bp-ident', {},
      el('input.title-input', { name: 'name', 'aria-label': 'Name' }),
      ...headerGroups(placed('header'), ctx, 'bp-header-stats')),
    el('div.bp-vitals', {},
      ...headerGroups(placed('vitals'), ctx, 'bp-vitals-group'),
      canAdvance ? el('button.small.bp-btn', { type: 'button', text: '⬆ Advance', title: 'Level up a class, or add an ancestry, background or class', on: { click: () => openAdd(api, actor.id) } }) : null,
      editable && canForge() && isCharacterType(actor.kind) ? el('button.small.bp-btn', { type: 'button', text: '⚒ Forge', title: 'Make or craft a magic item for this character', on: { click: () => openForge(api, { actorId: actor.id }) } }) : null));
  const root = el('div.sheet.bp-sheet', { 'data-type': type.key }, header);
  if (top.length) {
    const grid = gridFor(null, renderNodes(top, [], ctx));
    grid.classList.add('bp-top');
    root.append(grid);
  }

  // A brand-new character: offer to set them up.
  const starters = grantTypes();
  if (canAdvance && starters.length && isCharacterType(actor.kind) && !actor.items.some((i) => starters.some((t) => t.key === i.kind))) {
    root.append(el('div.new-character', {},
      el('span.grow', { text: `New character? Add their ${starters.map((t) => t.label.toLowerCase()).join(', ')} to fill in their features.` }),
      el('button.primary', { type: 'button', text: 'Start', on: { click: () => openAdd(api, actor.id) } })));
  }

  const itemCards = (types) => (types.length ? [el('div.bp-item-sections', {}, ...types.map((t) => itemSection(actor, t, api, editable)))] : []);
  const tabs = tabGroups.map((g) => ({
    key: g.key, label: label(g), icon: g.icon,
    render: () => [hintOf(g), gridFor(g, renderNodes(g.children, g.flat ? [] : [g.key], ctx)), ...itemCards(itemsOn(g.key))],
  }));
  for (const t of itemsOn('own')) tabs.push({ key: `__items_${t.key}`, label: label(t), icon: t.icon || 'items', render: () => itemCards([t]) });
  const general = itemsOn('');
  if (general.length) tabs.push({ key: '__items', label: 'Items', icon: 'backpack', render: () => itemCards(general) });
  tabs.push({ key: '__status', label: 'Status', icon: 'heart', render: () => [conditionsBar(actor), restsBar(), errorsBox(actor)].filter(Boolean) });
  let current = lastTab.get(actor.id);
  if (!tabs.some((t) => t.key === current)) current = tabs[0].key;
  const body = el('div.bp-tab-body');
  const bar = el('nav.bp-tabs', { role: 'tablist' });
  const iconsOn = tabs.some((t) => t.icon && t.key !== '__status' && t.key !== '__items');
  if (iconsOn) bar.classList.add('bp-tabs-icons');
  const show = (key) => {
    current = key;
    lastTab.set(actor.id, key);
    for (const b of bar.children) {
      b.classList.toggle('active', b.dataset.tab === key);
      b.setAttribute('aria-selected', String(b.dataset.tab === key));
    }
    const t = tabs.find((x) => x.key === key);
    body.replaceChildren(...t.render().flat().filter(Boolean));
    bindInputs(body, actor, api);
  };
  for (const t of tabs) {
    bar.append(el('button', { type: 'button', role: 'tab', 'data-tab': t.key, on: { click: () => show(t.key) } },
      iconsOn ? sheetIcon(t.icon || 'star') : null, el('span', { text: t.label })));
  }
  const side = placed('side');
  const main = el('div.bp-main', {}, bar, body);
  root.append(side.length
    ? el('div.bp-body', {}, el('aside.bp-side', {}, ...renderNodes(side, [], ctx)), main)
    : main);
  // The header, top and side (and clicks anywhere, by delegation) bind once; each tab binds its own inputs.
  bindSheet(root, actor, api);
  show(current);
  return root;
}

/** One value of an item, for summaries and grouping: calculated, or as stored. */
function itemValue(actor, item, f) {
  if (!f) return undefined;
  if (f.kind === 'formula') return actor.derived?.items?.[item.id]?.[f.key];
  // A resource's max may be worked out (its own formula): show that, not the stored number.
  if (f.kind === 'resource') { const max = actor.derived?.items?.[item.id]?.[f.key]?.max; return max != null ? { ...(item.data?.[f.key] ?? {}), max } : item.data?.[f.key]; }
  return item.data?.[f.key];
}

function shownValue(f, v) {
  if (v == null || v === '') return '';
  if (f.kind === 'checkbox') return v ? label(f) : '';
  if (f.kind === 'choice') return (f.options ?? []).find((o) => o.value === v)?.label || String(v);
  if (f.kind === 'resource') return v && typeof v === 'object' ? `${label(f)} ${v.value ?? 0}/${v.max ?? 0}` : String(v);
  // A bare number says little: name it ("Weight 5").
  if (typeof v === 'number') return `${label(f)} ${fmt(v)}`;
  return fmt(v);
}

/** A card listing an actor's items of one type, grouped and summarised as the type says. */
export function itemSection(actor, t, api, editable, { title } = {}) {
  const items = actor.items.filter((i) => i.kind === t.key).sort((a, b) => a.name.localeCompare(b.name));
  const fields = t.children ?? [];
  const field = (k) => fields.find((f) => f.key === k);
  const actions = fields.filter((c) => c.kind === 'action');
  const summary = (t.summary ?? []).map(field).filter(Boolean);
  const lkey = levelsKey(t.key);
  const gives = grantTypes().some((g) => g.key === t.key);

  const inline = sheetMode(t) === 'none';
  // The type's switch (Rage, Power Attack, a buff): an On/Off button on items whose effects depend on it.
  const toggle = t.toggle;
  const switchable = (it) => toggle && [...(it.effects ?? []), ...(t.children ?? []).filter((c) => c.kind === 'effect').map((c) => ({ requires: c.when }))]
    .some((fx) => String(fx.requires ?? '').includes(`@item.${toggle}`));
  const toggleButton = (it) => {
    if (!switchable(it)) return null;
    const on = !!it.data?.[toggle];
    return el(`button.small.bp-btn.bp-toggle${on ? '.on' : ''}`, {
      type: 'button', text: on ? 'On' : 'Off', 'aria-pressed': String(on), title: on ? `${it.name} is on: click to switch it off` : `Switch ${it.name} on`, disabled: !editable,
      on: { click: () => api.op({ op: 'item_update', actor_id: actor.id, id: it.id, patch: { data: { [toggle]: !on } } }) },
    });
  };
  const itemCtx = (it) => ({ actor, item: it, itemId: it.id, type: t, prefix: `items.${it.id}.data`, derived: actor.derived?.items?.[it.id] ?? {}, editable, api });
  const details = (it) => el('div.bp-item-inline', {},
    gridFor(t, renderNodes(fields.filter((c) => !['effect', 'action'].includes(c.kind)), [], itemCtx(it))));
  const card = (it) => {
    const by = it.flags?.core?.granted_by;
    const from = by ? actor.items.find((x) => x.id === by.item) : null;
    const chips = summary.map((f) => shownValue(f, itemValue(actor, it, f))).filter(Boolean);
    const open = inline && expanded.has(it.id);
    const li = el('li.bp-item-card', { 'data-item-id': it.id, class: open ? 'bp-item-card open' : 'bp-item-card' },
      it.img ? el('img.bp-item-img', { src: it.img, alt: '' }) : null,
      el('div.bp-item-main', {},
        el('button.bp-item-name', {
          type: 'button', text: inline ? `${open ? '▾' : '▸'} ${it.name}` : it.name, title: inline ? 'Show or hide its details' : 'Open', 'aria-expanded': inline ? String(open) : null,
          on: {
            click: () => {
              if (!inline) { openItemSheet(actor.id, it.id, api); return; }
              // Open in place: the details go under the row (and stay open across refreshes).
              if (expanded.has(it.id)) { expanded.delete(it.id); li.querySelector(':scope > .bp-item-inline')?.remove(); } else {
                expanded.add(it.id);
                const d = details(it);
                li.append(d);
                bindInputs(d, actor, api);
              }
              li.classList.toggle('open', expanded.has(it.id));
              const b = li.querySelector('.bp-item-name');
              b.textContent = `${expanded.has(it.id) ? '▾' : '▸'} ${it.name}`;
              b.setAttribute('aria-expanded', String(expanded.has(it.id)));
            },
          },
        }),
        chips.length || from ? el('div.bp-item-meta', {}, ...chips.map((c) => el('span.bp-chip', { text: c })),
          from ? el('span.muted', { text: `from ${from.name}${by.level ? ` ${by.level}` : ''}` }) : null) : null),
      lkey ? el('span.bp-count', { text: levelOf(it), title: 'Level' }) : null,
      el('div.bp-item-buttons', {},
        toggleButton(it),
        ...actions.filter((a) => !(actor.derived?.items?.[it.id]?._off ?? []).includes(a.key)).map((a) => el('button.small.bp-btn', { type: 'button', 'data-use': a.key, 'data-item-id': it.id, text: label(a), title: a.roll })),
        editable && lkey ? el('button.small.bp-btn', { type: 'button', text: 'Level up', on: { click: () => openAdvance(api, actor.id, { itemId: it.id }) } }) : null,
        editable && lkey && levelOf(it) > 1 ? el('button.small.bp-btn', { type: 'button', text: 'Level down', title: `Take back level ${levelOf(it)} and what it gave`, on: { click: () => regress(api, actor.id, it) } }) : null,
        editable ? el('button.icon.bp-btn', { type: 'button', title: gives || it.advancement?.length ? `Remove ${it.name} and everything it gave` : `Remove ${it.name}`, 'aria-label': `Remove ${it.name}`, text: '🗑', on: { click: () => removeItem(api, actor.id, it) } }) : null));
    if (open) li.append(details(it));
    return li;
  };

  const list = (xs) => (xs.length ? el('ul.bp-item-cards', {}, ...xs.map(card)) : el('p.bp-empty', { text: `No ${label(t).toLowerCase()} yet.` }));
  const body = [];
  const gf = field(t.group_by);
  if (gf && items.length) {
    const groups = new Map();
    for (const it of items) {
      const v = itemValue(actor, it, gf);
      const k = v == null || v === '' ? '' : v;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const keys = [...groups.keys()].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b
      : gf.kind === 'choice' ? (gf.options ?? []).findIndex((o) => o.value === a) - (gf.options ?? []).findIndex((o) => o.value === b)
        : String(a).localeCompare(String(b))));
    for (const k of keys) {
      const head = k === '' ? 'Other' : gf.kind === 'choice' || gf.kind === 'checkbox' ? shownValue(gf, k) || 'Other' : `${label(gf)} ${fmt(k)}`;
      body.push(el('div.bp-subhead', {}, el('span', { text: head }), el('span.bp-subcount', { text: groups.get(k).length })), list(groups.get(k)));
    }
  } else {
    body.push(list(items));
  }
  return el('section.bp-group.bp-frame-card.bp-items', { 'data-key': `items:${t.key}` },
    el('h4.bp-group-title', {},
      el('span', { text: title || t.list_title || label(t) }),
      el('span.bp-subcount', { text: items.length }),
      editable ? el('button.small.bp-btn.bp-add', { type: 'button', 'data-action': 'create-item', 'data-type': t.key, text: `+ Add` , title: `Add a ${label(t).toLowerCase()}` }) : null),
    ...body);
}

const itemWindows = new Map(); // `${actorId}/${itemId}` → render()
const expanded = new Set(); // item ids opened in place (types with no sheet of their own)

/** An owned item's sheet, from its type's tree. */
export function openItemSheet(actorId, itemId, api) {
  const key = `${actorId}/${itemId}`;
  if (itemWindows.has(key)) { openWindow({ id: `item-sheet-${key}` }); return; }
  const kind = store.world.actors[actorId]?.items.find((i) => i.id === itemId)?.kind;
  const win = openWindow({ id: `item-sheet-${key}`, title: 'Item', width: Math.min(innerWidth - 40, blueprintType(kind, true)?.width || 440) });
  let seq = 0;
  const render = async () => {
    const mine = ++seq;
    applyStyle();
    const actor = store.world.actors[actorId];
    const item = actor?.items.find((i) => i.id === itemId);
    if (!item) { win.close(); return; }
    // Refresh, then put the cursor back where it was (so calculated values update as you edit).
    const active = win.el.contains(document.activeElement) ? document.activeElement : null;
    const focus = active?.name ? { name: active.name, start: active.selectionStart, end: active.selectionEnd } : null;
    win.setTitle(item.name);
    const type = blueprintType(item.kind, true);
    const ctx = { actor, item, itemId, type, prefix: `items.${itemId}.data`, derived: actor.derived?.items?.[itemId] ?? {}, editable: isGM() || ownsActor(actorId), api };
    const mode = sheetMode(type);
    const url = systemInfo().item_types?.[item.kind]?.sheet;
    let root;
    if (mode === 'html' && url) {
      const tpl = await loadTemplate(url).catch((e) => `<p class="error">Couldn't load ${url}: ${e.message}</p>`);
      if (mine !== seq) return; // a newer render started
      root = el('div.sheet.bp-sheet', { 'data-type': item.kind, html: renderTemplate(tpl, {
        actor, item, data: item.data ?? {}, derived: ctx.derived, items: actor.items, system: systemInfo(), isGM: isGM(), isOwner: ownsActor(actorId),
      }) });
    } else if (mode === 'designed') {
      root = layoutItemSheet(actor, item, type, layoutFor(type), api);
    } else {
      root = el('div.sheet.bp-sheet', { 'data-type': item.kind },
        el('div.sheet-head', {}, el('input.title-input', { name: `items.${itemId}.name`, 'aria-label': 'Name' })),
        type ? gridFor(type, renderNodes(type.children.filter((c) => c.kind !== 'effect'), [], ctx)) : el('p.muted', { text: 'This item type has no fields in the builder.' }));
    }
    bindSheet(root, actor, api);
    // Effects this particular item gives, and (GM) what it grants.
    const save = (patch) => api.op({ op: 'item_update', actor_id: actorId, id: itemId, patch });
    if (item.parts?.length) root.append(partsView(item, (parts) => save({ parts }), ctx.editable));
    if (ctx.editable || item.effects?.length) root.append(effectsEditor(item, (effects) => save({ effects }), ctx.editable));
    if (isGM() && grantTypes().some((g) => g.key === item.kind)) root.append(advancementEditor(api, item, (advancement) => save({ advancement }), !!levelsKey(item.kind)));
    if (ctx.editable) {
      root.append(el('div.row.item-sheet-foot', {}, el('span.grow'),
        el('button.danger', { type: 'button', text: `🗑 Remove from ${actor.name}`, on: { click: () => { if (removeItem(api, actorId, item)) win.close(); } } })));
    }
    win.body.replaceChildren(root);
    if (focus) {
      const again = root.querySelector(`[name="${CSS.escape(focus.name)}"]`);
      again?.focus();
      try { if (focus.start != null) again.setSelectionRange(focus.start, focus.end); } catch { /* not a text input */ }
    }
  };
  itemWindows.set(key, render);
  win.onClose(() => itemWindows.delete(key));
  render();
}

/** Keep item sheets current. */
export function itemSheetsOnChange() {
  for (const render of itemWindows.values()) render();
}

export function toastNoType(kind) { toast(`No builder type "${kind}".`); }
