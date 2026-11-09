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
//   data-action="create-item" data-type="weapon" | data-action="delete-item" data-item-id="…"

import { hooks } from './hooks.js';
import { store, getPath, pathPatch, isGM, ownsActor, systemInfo } from './store.js';
import { el, escape, openWindow } from './ui.js';

const renderers = new Map();
const templateCache = new Map();
const open = new Map(); // actorId -> { win, render }

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

async function loadTemplate(url) {
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
export function bindSheet(root, actor, api) {
  const editable = ownsActor(actor.id);
  for (const input of root.querySelectorAll('input[name], select[name], textarea[name]')) {
    const v = valueFor(actor, input.name);
    if (input.type === 'checkbox') input.checked = !!v;
    else if (v !== undefined && v !== null && typeof v !== 'object') input.value = v;
    input.disabled = !editable;
    input.addEventListener('change', () => commit(api, actor, input.name, coerce(input)));
  }
  root.addEventListener('click', (e) => {
    const roll = e.target.closest('[data-roll]');
    if (roll) {
      e.preventDefault();
      api.roll(roll.dataset.roll, { flavor: roll.dataset.flavor, actorId: actor.id, gmOnly: e.shiftKey });
      return;
    }
    const action = e.target.closest('[data-action]');
    if (!action || !editable) return;
    e.preventDefault();
    const { action: a, type, itemId } = action.dataset;
    if (a === 'create-item') {
      const label = systemInfo().item_types?.[type]?.label ?? type;
      api.create.item(actor.id, type, `New ${label}`);
    } else if (a === 'delete-item' && itemId) {
      api.op({ op: 'item_delete', actor_id: actor.id, id: itemId });
    }
  });
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
  if (!players.length) return el('div.owners.muted', { text: 'No players have joined yet.' });
  return el('div.owners', {}, el('span.muted', { text: 'Owners:' }),
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

// ------------------------------------------------------------ windows

export function openSheet(actorId, api) {
  const existing = open.get(actorId);
  if (existing) { existing.win.el.style.zIndex = 9999; return existing.win; }
  const actor = store.world.actors[actorId];
  if (!actor) return null;
  const win = openWindow({ id: `sheet-${actorId}`, title: actor.name, width: 560 });
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
    try {
      if (custom) {
        content = el('div.sheet');
        await custom(content, a, api);
      } else if (sheetUrl) {
        const tpl = await loadTemplate(sheetUrl);
        const ctx = { actor: a, data: a.data, derived: a.derived ?? {}, items: a.items, system: sys, isGM: isGM(), isOwner: ownsActor(a.id) };
        content = el('div.sheet', { html: renderTemplate(tpl, ctx) });
        bindSheet(content, a, api);
      } else {
        content = autoSheet(a);
        bindSheet(content, a, api);
      }
    } catch (e) {
      console.error(e);
      content = el('div.error', { text: `Sheet failed to render: ${e.message}` });
    }
    if (mine !== seq) return; // a newer render started
    win.body.replaceChildren(...(isGM() ? [ownersBar(a, api)] : []), content);
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
}
