// Actor sheets.
//
// A sheet is chosen in this order:
//   1. a renderer registered by a package:  Hearth.sheets.register(kind, fn)
//   2. the system's HTML template:          actor_types.<kind>.sheet in hearth.toml
//   3. an automatic form generated from the actor's data
//
// HTML templates (see docs/sheets.md):
//   {{path}} / {{path|signed}}      text, escaped. Context: actor, data, derived, items, system, isOwner, isGM
//   {{#if path}}…{{else}}…{{/if}}   conditional (not nested)
//   {{#each items:weapon}}…{{/each}} loop over items of a kind; inside, use {{this.name}}, {{this.data.x}}
//   <input name="data.hp.value">    two-way binding (name, img, data.*, items.<id>.*)
//   data-roll="1d20 + @abilities.str.mod" data-flavor="Strength"   roll button
//   data-action="create-item" data-type="weapon" (pick one to add) | data-action="delete-item" data-item-id="…"
//   data-use="attack" data-item-id="…"   use a system action (Shift: GM only, Alt: advantage, Ctrl: disadvantage)
//   data-rest="long"                     take a rest
//   data-toggle-condition="poisoned"     put a condition on or take it off
//   data-sheet-tab="x" / data-sheet-panel="x"   tabs (the open tab is kept across re-renders)

import { hooks } from './hooks.js';
import { store, getPath, pathPatch, isGM, ownsActor, systemInfo } from './store.js';
import { el, escape, openWindow } from './ui.js';
import { blueprintType, blueprintSheet, itemSheetsOnChange, sheetMode } from './blueprint-sheet.js';
import { layoutSheet, layoutFor } from './layout-sheet.js';
import { openItemPicker } from './advancement.js';
import { creationBar, creationResetButtons } from './creation.js';

const renderers = new Map();
const templateCache = new Map();
const open = new Map(); // actorId -> { win, render }
const sheetTabs = new Map(); // actorId -> the open tab of an HTML sheet

export function registerSheet(kind, fn) { renderers.set(kind, fn); }

// ------------------------------------------------------------ template engine

const FILTERS = {
  signed: (v) => (Number(v) >= 0 ? `+${Number(v)}` : `${Number(v)}`),
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  json: (v) => JSON.stringify(v),
};

function lookup(ctx, expr) {
  const [path, ...filters] = expr.trim().split('|').map((s) => s.trim());
  let v = getPath(ctx, path);
  for (const f of filters) v = FILTERS[f] ? FILTERS[f](v) : v;
  return v;
}

export function renderTemplate(tpl, ctx) {
  let out = tpl.replace(/\{\{#each\s+([\w.]+)(?::([\w-]+))?\s*\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, path, kind, inner) => {
    const list = getPath(ctx, path) ?? [];
    return (Array.isArray(list) ? list : Object.values(list))
      .filter((it) => !kind || it.kind === kind)
      .map((it, index) => renderTemplate(inner, { ...ctx, this: it, index }))
      .join('');
  });
  out = out.replace(/\{\{#if\s+([^}]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_, expr, yes, no = '') => (lookup(ctx, expr) ? yes : no));
  return out.replace(/\{\{\s*([^#/}][^}]*)\}\}/g, (_, expr) => escape(lookup(ctx, expr)));
}

export async function loadTemplate(url) {
  if (!templateCache.has(url)) {
    templateCache.set(url, fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${url}: ${r.status}`)))));
  }
  return templateCache.get(url);
}

// ------------------------------------------------------------ binding

function coerce(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number' || input.dataset.type === 'number') {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : 0;
  }
  return input.value;
}

function commit(api, actor, name, value) {
  if (name.startsWith('items.')) {
    const [, itemId, ...rest] = name.split('.');
    if (rest.length) api.update.item(actor.id, itemId, pathPatch(rest.join('.'), value));
  } else if (name === 'name' || name === 'img' || name.startsWith('data.') || name.startsWith('flags.')) {
    api.update.actor(actor.id, pathPatch(name, value));
  }
}

function valueFor(actor, name) {
  if (name.startsWith('items.')) {
    const [, itemId, ...rest] = name.split('.');
    return getPath(actor.items.find((i) => i.id === itemId), rest.join('.'));
  }
  return getPath(actor, name);
}

/** Wire inputs, roll buttons and actions inside a rendered sheet. */
/** Fill and wire up a sheet's inputs (no click handling; see bindSheet). */
export function bindInputs(root, actor, api) {
  const editable = ownsActor(actor.id);
  for (const input of root.querySelectorAll('input[name], select[name], textarea[name]')) {
    const v = valueFor(actor, input.name);
    if (input.type === 'checkbox') input.checked = !!v;
    else if (v !== undefined && v !== null && typeof v !== 'object') input.value = v;
    input.disabled = !editable;
    input.addEventListener('change', () => commit(api, actor, input.name, coerce(input)));
  }
}

export function bindSheet(root, actor, api) {
  const editable = ownsActor(actor.id);
  bindInputs(root, actor, api);
  // Condition buttons show whether the condition is on.
  const statuses = new Set((actor.effects ?? []).filter((x) => !x.disabled).map((x) => x.status).filter(Boolean));
  for (const b of root.querySelectorAll('[data-toggle-condition]')) {
    const on = statuses.has(b.dataset.toggleCondition);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  // Action buttons hide while their `when` is false (the server lists those under `_off`).
  for (const b of root.querySelectorAll('[data-use]')) {
    const off = b.dataset.itemId ? actor.derived?.items?.[b.dataset.itemId]?._off : actor.derived?._off;
    if (off?.includes(b.dataset.use)) b.hidden = true;
  }
  // Tabs in HTML sheets: <button data-sheet-tab="spells"> shows <div data-sheet-panel="spells">.
  const panels = [...root.querySelectorAll('[data-sheet-panel]')];
  const showTab = (key) => {
    sheetTabs.set(actor.id, key);
    for (const p of panels) p.hidden = p.dataset.sheetPanel !== key;
    for (const b of root.querySelectorAll('[data-sheet-tab]')) {
      b.classList.toggle('active', b.dataset.sheetTab === key);
      b.setAttribute('aria-selected', String(b.dataset.sheetTab === key));
    }
  };
  if (panels.length) {
    const want = sheetTabs.get(actor.id);
    showTab(panels.some((p) => p.dataset.sheetPanel === want) ? want : panels[0].dataset.sheetPanel);
  }
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-sheet-tab]');
    if (tab && panels.length) { e.preventDefault(); showTab(tab.dataset.sheetTab); return; }
    const use = e.target.closest('[data-use]');
    if (use) {
      e.preventDefault();
      if (!editable) return;
      const mode = e.altKey ? 'advantage' : e.ctrlKey || e.metaKey ? 'disadvantage' : undefined;
      const level = use.dataset.level ? Number(use.dataset.level) : undefined;
      api.actions.use(actor.id, use.dataset.itemId || null, use.dataset.use, { mode, level }, e.shiftKey);
      return;
    }
    const rest = e.target.closest('[data-rest]');
    if (rest) {
      e.preventDefault();
      if (editable && confirm(`${actor.name}: take a ${rest.dataset.rest} rest?`)) api.rest(actor.id, rest.dataset.rest);
      return;
    }
    const cond = e.target.closest('[data-toggle-condition]');
    if (cond) {
      e.preventDefault();
      if (editable) toggleCondition(api, actor, cond.dataset.toggleCondition);
      return;
    }
    const roll = e.target.closest('[data-roll]');
    if (roll) {
      e.preventDefault();
      // Alt-click: advantage, Ctrl-click: disadvantage (on a single d20).
      let formula = roll.dataset.roll;
      let flavor = roll.dataset.flavor;
      if (e.altKey || e.ctrlKey || e.metaKey) {
        const adv = e.altKey;
        const swapped = formula.replace(/(^|[^\d])1?d20(?!\d)/, (m, pre) => `${pre}${adv ? '2d20kh1' : '2d20kl1'}`);
        if (swapped !== formula) { formula = swapped; flavor = `${flavor ?? ''} (${adv ? 'advantage' : 'disadvantage'})`.trim(); }
      }
      api.roll(formula, { flavor, actorId: actor.id, gmOnly: e.shiftKey });
      return;
    }
    const action = e.target.closest('[data-action]');
    if (!action || !editable) return;
    e.preventDefault();
    const { action: a, type, itemId } = action.dataset;
    if (a === 'create-item') {
      // Pick from what exists (collections, the Items directory); the GM can also make a blank one.
      openItemPicker(api, actor.id, type);
    } else if (a === 'delete-item' && itemId) {
      api.op({ op: 'item_delete', actor_id: actor.id, id: itemId });
    }
  });
}

/** Put a system condition on an actor, or take it off. */
export function toggleCondition(api, actor, id) {
  const effects = actor.effects ?? [];
  const on = effects.some((x) => x.status === id);
  const def = (systemInfo().rules?.conditions ?? []).find((c) => c.id === id);
  const next = on ? effects.filter((x) => x.status !== id) : [...effects, { id, name: def?.name ?? id, status: id, changes: [] }];
  api.update.actor(actor.id, { effects: next });
}

/** Actions, resources, conditions and rests the system declares, for the automatic sheet. */
function rulesSection(actor) {
  const rules = systemInfo().rules ?? {};
  const tr = rules.actor_types?.[actor.kind] ?? {};
  const parts = [];
  const resources = Object.entries(tr.resources ?? {});
  if (resources.length) {
    parts.push(el('h3', { text: 'Resources' }), el('div.auto-grid', {}, ...resources.map(([path, def]) => {
      const max = getPath(actor.derived, `${path}.max`) ?? getPath(actor.data, `${path}.max`);
      return el('label', {}, def.label ?? path.replace(/[._]/g, ' '),
        el('span.row', {}, el('input', { type: 'number', name: `data.${path}.value` }), el('span.muted', { text: max != null ? `/ ${max}` : '' })));
    })));
  }
  const actorActions = tr.actions ?? [];
  const rests = rules.rests ?? [];
  if (actorActions.length || rests.length) {
    parts.push(el('div.row.sheet-actions', {},
      ...actorActions.map((a) => el('button', { 'data-use': a.id, text: a.label, title: `${a.label}: ${a.roll}` })),
      ...rests.map((r) => el('button', { 'data-rest': r, text: `${r[0].toUpperCase()}${r.slice(1)} rest` }))));
  }
  parts.push(conditionsBar(actor), errorsBox(actor));
  return parts.filter(Boolean);
}

/** The system's conditions as toggle chips (or null if it has none). */
export function conditionsBar(actor) {
  const conditions = systemInfo().rules?.conditions ?? [];
  if (!conditions.length) return null;
  const on = new Set((actor.effects ?? []).filter((x) => !x.disabled).map((x) => x.status).filter(Boolean));
  return el('div', {}, el('h3', { text: 'Conditions' }), el('div.row.conditions', {}, ...conditions.map((c) =>
    el('button', { type: 'button', class: on.has(c.id) ? 'chip on' : 'chip', 'data-toggle-condition': c.id, text: c.name || c.id, 'aria-pressed': String(on.has(c.id)), title: c.description || null }))));
}

/** Rest buttons (or null if the system has no rests). */
export function restsBar() {
  const rests = systemInfo().rules?.rests ?? [];
  if (!rests.length) return null;
  return el('div.row.sheet-actions', {}, ...rests.map((r) => el('button', { type: 'button', 'data-rest': r, text: `${r[0].toUpperCase()}${r.slice(1)} rest` })));
}

/** The GM's list of formula problems for this actor (or null). */
export function errorsBox(actor) {
  const errors = actor.derived?._errors;
  if (!isGM() || !errors?.length) return null;
  return el('details.rule-errors', {}, el('summary', { text: `⚠ ${errors.length} formula problem${errors.length > 1 ? 's' : ''}` }),
    el('ul', {}, errors.map((e) => el('li', { text: e }))));
}

/** Buttons for an item's actions. */
function itemActions(actor, item) {
  const t = systemInfo().rules?.item_types?.[item.kind];
  return (t?.actions ?? []).map((a) => el('button.small', { 'data-use': a.id, 'data-item-id': item.id, text: a.label, title: a.roll }));
}

// ------------------------------------------------------------ automatic form

function autoFields(obj, prefix) {
  const rows = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const name = `${prefix}.${k}`;
    const label = k.replace(/_/g, ' ');
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      rows.push(el('fieldset.auto', {}, el('legend', { text: label }), ...autoFields(v, name)));
    } else if (typeof v === 'boolean') {
      rows.push(el('label.check', {}, el('input', { type: 'checkbox', name }), label));
    } else if (typeof v === 'number') {
      rows.push(el('label', {}, label, el('input', { type: 'number', name, step: 'any' })));
    } else if (!Array.isArray(v)) {
      rows.push(el('label', {}, label, el('input', { type: 'text', name })));
    }
  }
  return rows;
}

function autoSheet(actor) {
  const sys = systemInfo();
  const itemTypes = Object.entries(sys.item_types ?? {});
  const root = el('div.sheet.auto-sheet', {},
    el('div.sheet-head', {}, el('input.title-input', { name: 'name' })),
    el('div.auto-grid', {}, ...autoFields(actor.data, 'data')));
  root.append(...rulesSection(actor));
  if (Object.keys(actor.derived ?? {}).length) {
    root.append(el('details.derived', {}, el('summary', { text: 'Derived values' }),
      el('pre', { text: JSON.stringify(actor.derived, null, 2) })));
  }
  root.append(el('h3', { text: 'Items' }));
  const list = el('ul.item-list');
  for (const it of actor.items) {
    list.append(el('li', {},
      el('input', { name: `items.${it.id}.name` }),
      el('span.muted', { text: it.kind }),
      ...itemActions(actor, it),
      el('button.icon', { 'data-action': 'delete-item', 'data-item-id': it.id, title: 'Delete', text: '🗑' })));
  }
  root.append(list);
  if (itemTypes.length) {
    root.append(el('div.row', {}, ...itemTypes.map(([k, d]) =>
      el('button', { 'data-action': 'create-item', 'data-type': k, text: `+ ${d.label}` }))));
  }
  return root;
}

// ------------------------------------------------------------ owners (GM)

function ownersBar(actor, api) {
  const players = Object.values(store.world.users).filter((u) => u.role !== 'gm');
  // The GM can copy an actor (a homebrew monster) into the system's own collections.
  const add = api.collections?.addButton('actor', () => store.world.actors[actor.id]);
  if (add) add.classList.add('small');
  const redo = creationResetButtons(actor, api);
  if (!players.length) return el('div.owners.muted', {}, el('span.grow', { text: 'No players have joined yet.' }), ...redo, add);
  return el('div.owners', {}, ...redo, add, el('span.muted', { text: 'Owners:' }),
    ...players.map((u) => el('label.check', {},
      el('input', {
        type: 'checkbox', checked: actor.owners.includes(u.id),
        on: {
          change: (e) => {
            const owners = e.target.checked ? [...new Set([...actor.owners, u.id])] : actor.owners.filter((id) => id !== u.id);
            api.update.actor(actor.id, { owners });
          },
        },
      }), u.name)));
}

/** With several designed layouts, owners pick which one this actor's sheet uses. */
function layoutPicker(actor, type, api) {
  if (sheetMode(type) !== 'designed' || (type.layouts?.length ?? 0) < 2 || !ownsActor(actor.id)) return null;
  const current = layoutFor(type, actor);
  return el('label.sheet-layout-pick', {}, 'Sheet ', el('select', {
    on: { change: (e) => api.update.actor(actor.id, pathPatch('flags.core.layout', e.target.value === type.default_layout ? null : e.target.value)) },
  }, ...type.layouts.map((l) => el('option', { value: l.id, text: `${l.name || l.id}${l.id === (type.default_layout || type.layouts[0].id) ? ' (default)' : ''}`, selected: l.id === current?.id }))));
}

// ------------------------------------------------------------ windows

export function openSheet(actorId, api) {
  const existing = open.get(actorId);
  if (existing) { existing.win.el.style.zIndex = 9999; return existing.win; }
  const actor = store.world.actors[actorId];
  if (!actor) return null;
  // Generated sheets are roomier; a type can set its own width in the system builder.
  const bpType = blueprintType(actor.kind);
  const width = Math.min(innerWidth - 40, bpType?.width || (bpType ? 760 : 560));
  const win = openWindow({ id: `sheet-${actorId}`, title: actor.name, width });
  win.el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-hearth-item') || e.dataTransfer.types.includes('application/x-hearth-doc')) e.preventDefault();
  });
  win.el.addEventListener('drop', (e) => {
    const fromCollection = e.dataTransfer.getData('application/x-hearth-doc');
    if (fromCollection) {
      e.preventDefault();
      try {
        const { kind, doc } = JSON.parse(fromCollection);
        if (kind === 'item') api.collections?.giveItem(actorId, doc);
      } catch { /* not ours */ }
      return;
    }
    const itemId = e.dataTransfer.getData('application/x-hearth-item');
    if (!itemId) return;
    e.preventDefault();
    api.items?.giveTo(actorId, itemId);
  });

  let seq = 0;
  const render = async () => {
    const mine = ++seq;
    const a = store.world.actors[actorId];
    if (!a) { win.close(); return; }
    win.setTitle(a.name);
    const focused = document.activeElement?.closest('.window') === win.el ? document.activeElement?.name : null;
    const scroll = win.body.scrollTop;

    let content;
    const sys = systemInfo();
    const custom = renderers.get(a.kind);
    const sheetUrl = sys.actor_types?.[a.kind]?.sheet;
    const bpType = blueprintType(a.kind);
    try {
      if (custom) {
        content = el('div.sheet');
        await custom(content, a, api);
      } else if (sheetUrl) {
        const tpl = await loadTemplate(sheetUrl);
        const ctx = { actor: a, data: a.data, derived: a.derived ?? {}, items: a.items, system: sys, isGM: isGM(), isOwner: ownsActor(a.id) };
        content = el('div.sheet', { html: renderTemplate(tpl, ctx) });
        bindSheet(content, a, api);
      } else if (bpType && sheetMode(bpType) === 'designed') {
        // Made in the sheet designer (binds itself).
        content = layoutSheet(a, bpType, layoutFor(bpType, a), api);
      } else if (bpType) {
        // Laid out from the system builder's tree (binds itself).
        content = blueprintSheet(a, bpType, api);
      } else {
        content = autoSheet(a);
        bindSheet(content, a, api);
      }
    } catch (e) {
      console.error(e);
      content = el('div.error', { text: `Sheet failed to render: ${e.message}` });
    }
    if (mine !== seq) return; // a newer render started
    win.body.replaceChildren(...[isGM() ? ownersBar(a, api) : null, layoutPicker(a, bpType, api), creationBar(a, api), content].filter(Boolean));
    hooks.emit('sheet:render', content, a, api);
    win.body.scrollTop = scroll;
    if (focused) win.body.querySelector(`[name="${CSS.escape(focused)}"]`)?.focus();
  };

  win.onClose(() => open.delete(actorId));
  open.set(actorId, { win, render });
  render();
  return win;
}

/** Re-render sheets touched by an op. */
export function sheetsOnOp(op) {
  const id = op.actor_id ?? (op.op?.startsWith('actor_') ? op.id ?? op.actor?.id : null);
  if (op.op === 'user_upsert') { for (const s of open.values()) s.render(); return; }
  if (id && open.has(id)) open.get(id).render();
  if (id) itemSheetsOnChange();
}

/** Re-render every open sheet (e.g. after the system changed). */
export function refreshSheets() {
  // A system change may have rewritten a hand-made sheet's template too.
  templateCache.clear();
  for (const s of open.values()) s.render();
  itemSheetsOnChange();
}
