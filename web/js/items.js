// The Items directory: a library of items (weapons, spells, gear…) not owned
// by any actor. The GM makes and shares them; drag one onto an actor's sheet
// to give the actor a copy. Field editing is generated from the item's data,
// which starts from the system's item template.

import { hooks } from './hooks.js';
import { store, isGM, ownsActor, systemInfo } from './store.js';
import { el, toast, openWindow, formDialog } from './ui.js';
import { accessOf, atLeast, accessBadge, folderList, directoryPanel, editAccess, newId, rejectToast } from './directory.js';
import { grantTypes, levelsKey, advancementEditor, effectsEditor } from './advancement.js';
import { blueprintType } from './blueprint-sheet.js';

export const ITEM_MIME = 'application/x-hearth-item';

export class Items {
  constructor(api) {
    this.api = api;
    this.panelState = {};
    this.windows = new Map(); // id → window
    hooks.on('op', (op) => this.onOp(op));
  }

  get all() { return store.world?.items ?? {}; }
  typeLabel(kind) { return systemInfo().item_types?.[kind]?.label ?? kind; }

  // ------------------------------------------------------------------ panel

  renderPanel(panel) {
    const buttons = isGM() ? [el('button.primary', { text: '+ New item', on: { click: () => this.create() } })] : [];
    directoryPanel(panel, this.panelState, {
      buttons,
      placeholder: 'Search items',
      renderList: (q) => {
        const items = Object.values(this.all)
          .filter((x) => !q || x.name.toLowerCase().includes(q) || this.typeLabel(x.kind).toLowerCase().includes(q))
          .sort((a, b) => a.name.localeCompare(b.name));
        const out = folderList(items, (x) => this.row(x));
        if (!items.length) {
          out.push(el('p.muted', { text: q ? 'No items match.' : isGM() ? 'No items yet. Items here can be dragged onto actors.' : 'The GM hasn\'t shared any items with you yet.' }));
        } else {
          out.push(el('p.hint.muted', { text: 'Drag an item onto an actor\'s sheet to give them a copy.' }));
        }
        return out;
      },
    });
  }

  row(x) {
    return el('li.entity', {
      draggable: atLeast(x, 'observer'),
      on: {
        click: () => this.open(x.id),
        dragstart: (e) => {
          e.dataTransfer.setData(ITEM_MIME, x.id);
          e.dataTransfer.setData('text/plain', x.name);
        },
      },
    },
    x.img ? el('img.avatar', { src: x.img, alt: '' }) : el('span.avatar', { text: x.name.charAt(0).toUpperCase() }),
    el('span.grow', {}, el('span', { text: x.name }), el('small.muted', { text: ` ${this.typeLabel(x.kind)}` })),
    accessBadge(x));
  }

  /**
   * A new item: blank (the type's defaults, plus the starting advancement the
   * system builder gives the type), or a copy of one in the world or a collection.
   */
  async create() {
    const types = Object.entries(systemInfo().item_types ?? {});
    if (!types.length) types.push(['item', { label: 'Item' }]);
    const win = openWindow({ title: 'New item', width: 420 });
    win.body.replaceChildren(el('p.muted', { text: 'Loading…' }));
    // What can be copied: the world's items, and the system's and modules' item collections.
    const sources = Object.values(this.all).map((x) => ({ doc: x, from: 'Items' }));
    for (const p of this.api.collections?.packs() ?? []) {
      if (p.kind !== 'item') continue;
      try { for (const d of await this.api.collections.loadPack(p.pkg, p.id)) sources.push({ doc: d, from: p.label }); } catch { /* not available */ }
    }
    const name = el('input', { required: true, placeholder: 'e.g. Warden' });
    const kind = el('select', {}, ...types.map(([k, d]) => el('option', { value: k, text: d.label ?? k })));
    const start = el('select');
    const folder = el('input', { placeholder: 'optional' });
    const note = el('p.muted.small');
    const fill = () => {
      const t = blueprintType(kind.value, true);
      const adv = t?.advancement?.length ?? 0;
      const copies = sources.filter((s) => s.doc.kind === kind.value).sort((a, b) => String(a.doc.name).localeCompare(String(b.doc.name)));
      start.replaceChildren(
        el('option', { value: '', text: `Blank${adv ? ` (with the ${adv} starting grant${adv === 1 ? '' : 's'} every ${(t.label || kind.value).toLowerCase()} gets)` : ''}` }),
        ...copies.map((s, i) => el('option', { value: String(sources.indexOf(s)), text: `Copy of ${s.doc.name} (${s.from})` })));
      note.textContent = adv ? `The starting grants are set in the system builder (${t.label || kind.value} → Starting advancement).` : '';
    };
    kind.addEventListener('change', fill);
    fill();
    const form = el('form.form', {
      on: {
        submit: (e) => {
          e.preventDefault();
          if (!name.value.trim()) { name.focus(); return; }
          const id = newId();
          let item;
          if (start.value !== '') {
            // A copy: everything it has (fields, effects, advancement), under the new name.
            item = structuredClone(sources[Number(start.value)].doc);
            for (const k of ['folder', 'access', 'players']) delete item[k];
            if (item.flags?.core) { delete item.flags.core.user_added; delete item.flags.core.granted_by; delete item.flags.core.advancement; }
          } else {
            item = { kind: kind.value, img: null, data: {}, flags: {}, effects: [] };
            // Every new item of the type starts with the type's starting advancement (fresh grant ids).
            const adv = blueprintType(kind.value, true)?.advancement ?? [];
            if (adv.length) item.advancement = adv.map((g) => ({ ...structuredClone(g), id: newId() }));
          }
          Object.assign(item, { id, name: name.value.trim(), folder: folder.value.trim(), access: 'none', players: {} });
          item.data ??= {};
          item.flags ??= {};
          this.api.op({ op: 'library_item_create', item }, rejectToast);
          win.close();
          this.open(id);
        },
      },
    },
    el('label', {}, 'Name', name),
    el('label', {}, 'Type', kind),
    el('label', {}, 'Start from', start),
    note,
    el('label', {}, 'Folder', folder),
    el('div.row', {}, el('span.grow'), el('button', { type: 'button', text: 'Cancel', on: { click: () => win.close() } }), el('button.primary', { type: 'submit', text: 'Create' })));
    win.body.replaceChildren(form);
    name.focus();
  }

  // ------------------------------------------------------------------ item window

  open(id) {
    let win = this.windows.get(id);
    if (win) { openWindow({ id: `item-${id}` }); return win; }
    win = openWindow({ id: `item-${id}`, title: this.all[id]?.name ?? 'Item', width: isGM() ? 580 : 420 });
    this.windows.set(id, win);
    win.onClose(() => this.windows.delete(id));
    this.render(id);
    return win;
  }

  render(id) {
    const win = this.windows.get(id);
    if (!win) return;
    const x = this.all[id];
    if (!x) { win.body.replaceChildren(el('p.muted', { text: 'Loading…' })); return; }
    // Don't rebuild under someone typing in this window.
    if (win.el.contains(document.activeElement) && document.activeElement.matches('input, textarea, select, button')) return;
    win.setTitle(x.name);
    const gm = isGM();
    const send = (patch) => this.api.op({ op: 'library_item_update', id, patch }, rejectToast);
    const head = el('div.row.item-head', {},
      x.img ? el('img.item-img', { src: x.img, alt: '' }) : el('span.avatar.item-img', { text: x.name.charAt(0).toUpperCase() }),
      el('div.grow', {},
        gm ? el('input.title-input', { value: x.name, on: { change: (e) => send({ name: e.target.value.trim() || x.name }) } }) : el('h2', { text: x.name }),
        el('div.muted', { text: this.typeLabel(x.kind) })));
    const parts = [head];
    if (accessOf(x) === 'limited') {
      parts.push(el('p.muted', { text: 'You can see this item\'s name and image only.' }));
    } else {
      parts.push(el('div.auto-grid', {}, ...dataFields(x.data, 'data', gm, (path, value) => send(pathPatch(path, value)))));
    }
    if (gm) {
      parts.push(effectsEditor(x, (effects) => send({ effects })));
      if (grantTypes().some((g) => g.key === x.kind)) parts.push(advancementEditor(this.api, x, (advancement) => send({ advancement }), !!levelsKey(x.kind)));
      parts.push(
        el('div.row', {},
          el('label.grow', {}, 'Image URL', el('input', { value: x.img ?? '', on: { change: (e) => send({ img: e.target.value.trim() || null }) } })),
          el('label', {}, 'Folder', el('input', { value: x.folder ?? '', on: { change: (e) => send({ folder: e.target.value.trim() }) } }))),
        el('div.row', {},
          el('button', { text: '🔒 Access', on: { click: () => editAccess(`Who can see "${x.name}"`, x, send) } }),
          this.api.collections?.addButton('item', () => this.all[id]),
          el('span.grow'),
          el('button.danger', { text: 'Delete', on: { click: () => { if (confirm(`Delete the item "${x.name}"?`)) this.api.op({ op: 'library_item_delete', id }, rejectToast); } } })));
    }
    win.body.replaceChildren(...parts);
  }

  /** Give an actor a copy of a library item (from a drop on their sheet). */
  giveTo(actorId, itemId) {
    const x = this.all[itemId];
    if (!x) return;
    if (!ownsActor(actorId)) { toast('You can only add items to actors you own.'); return; }
    if (!atLeast(x, 'observer')) { toast('You can\'t take that item.'); return; }
    this.api.op({
      op: 'item_create', actor_id: actorId,
      item: { id: '', name: x.name, kind: x.kind, img: x.img ?? null, data: structuredClone(x.data ?? {}), flags: structuredClone(x.flags ?? {}) },
    }, rejectToast);
    toast(`Added ${x.name} to ${store.world.actors[actorId]?.name ?? 'the actor'}.`);
  }

  onOp(op) {
    if (!op.op.startsWith('library_item_')) return;
    const id = op.item?.id ?? op.id;
    if (op.op === 'library_item_delete') this.windows.get(id)?.close();
    else this.render(id);
    if (this.panelState.list) this.api.sidebar?.refresh('items');
  }
}

/** Editable (or read-only) fields for an item's data, like the automatic actor sheet. */
function dataFields(obj, prefix, editable, onChange) {
  const rows = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = `${prefix}.${k}`;
    const label = k.replace(/_/g, ' ');
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      rows.push(el('fieldset.auto', {}, el('legend', { text: label }), ...dataFields(v, path, editable, onChange)));
    } else if (typeof v === 'boolean') {
      rows.push(el('label.check', {}, el('input', { type: 'checkbox', checked: v, disabled: !editable, on: { change: (e) => onChange(path, e.target.checked) } }), label));
    } else if (typeof v === 'number') {
      rows.push(el('label', {}, label, el('input', { type: 'number', step: 'any', value: v, disabled: !editable, on: { change: (e) => onChange(path, Number(e.target.value)) } })));
    } else if (!Array.isArray(v)) {
      const long = typeof v === 'string' && (v.length > 60 || /description|notes|text/i.test(k));
      const input = long
        ? el('textarea', { rows: 4, disabled: !editable, on: { change: (e) => onChange(path, e.target.value) } })
        : el('input', { type: 'text', value: v ?? '', disabled: !editable, on: { change: (e) => onChange(path, e.target.value) } });
      if (long) input.value = v ?? '';
      rows.push(el(long ? 'label.wide' : 'label', {}, label, input));
    }
  }
  return rows;
}

/** 'data.hp.max', 5 → { data: { hp: { max: 5 } } } */
function pathPatch(path, value) {
  const keys = path.split('.');
  const out = {};
  let cur = out;
  keys.forEach((k, i) => { cur[k] = i === keys.length - 1 ? value : {}; cur = cur[k]; });
  return out;
}
