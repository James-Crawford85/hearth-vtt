// Collections: libraries of ready-made content (monsters, weapons, rules,
// handouts…). Two sources:
//   - packages: packs shipped by the system and modules (read-only; GM only
//     unless the pack is marked public);
//   - the world: collections the GM builds by copying documents into them,
//     shared with players like journal entries.
// Entries are copies; "Import" makes a fresh copy in the world. Item entries
// can be dragged onto an actor's sheet.

import { hooks } from './hooks.js';
import { store, isGM, systemInfo } from './store.js';
import { el, toast, openWindow, formDialog } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { accessOf, accessBadge, editAccess, newId, rejectToast } from './directory.js';
import { blueprintType } from './blueprint-sheet.js';

export const DOC_MIME = 'application/x-hearth-doc';

const KINDS = {
  actor: { label: 'Actors', one: 'actor', icon: '👤' },
  item: { label: 'Items', one: 'item', icon: '🗡' },
  journal: { label: 'Journal entries', one: 'journal entry', icon: '📜' },
  table: { label: 'Rollable tables', one: 'table', icon: '🎲' },
  macro: { label: 'Macros', one: 'macro', icon: '⚙' },
};

export class Collections {
  constructor(api) {
    this.api = api;
    this.cache = new Map();   // 'pkg/pack' → entries array
    this.windows = new Map(); // key → { win, query, selected }
    hooks.on('op', (op) => this.onOp(op));
    // The system changed (the builder saved, or something was added to a collection): read packs again.
    hooks.on('packages', () => { this.cache.clear(); if (api.lookup) api.lookup.packDocs = null; for (const [key, o] of this.windows) if (o.source.type === 'pack') this.loadPack(o.source.pack.pkg, o.source.pack.id).then(() => this.render(key)).catch(() => {}); });
  }

  get world() { return store.world?.collections ?? {}; }

  /** Packs from the active system and modules that this user may open. */
  packs() {
    return (store.packages?.active ?? []).flatMap((p) => (p.packs ?? [])
      .filter((x) => isGM() || x.public)
      .map((x) => ({ ...x, pkg: p.id, pkgName: p.name, key: `pkg:${p.id}/${x.id}` })));
  }

  async loadPack(pkg, id) {
    const key = `${pkg}/${id}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const res = await fetch(`/api/collections/${encodeURIComponent(pkg)}/${encodeURIComponent(id)}`, { headers: { 'x-hearth-session': this.api.session ?? '' } });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const docs = await res.json();
    this.cache.set(key, docs);
    return docs;
  }

  // ------------------------------------------------------------------ panel

  renderPanel(panel) {
    const parts = [];
    if (isGM()) parts.push(el('div.row', {}, el('button.primary', { text: '+ New collection', on: { click: () => this.create() } })));
    const world = Object.values(this.world).sort((a, b) => a.name.localeCompare(b.name));
    parts.push(el('h3', { text: 'This world' }));
    parts.push(world.length
      ? el('ul.entity-list', {}, world.map((c) => el('li.entity', { on: { click: () => this.openWorld(c.id) } },
        el('span.avatar', { text: KINDS[c.kind]?.icon ?? '📦' }),
        el('span.grow', {}, el('span', { text: c.name }), el('small.muted', { text: ` ${KINDS[c.kind]?.label ?? c.kind}${accessOf(c) === 'limited' ? '' : ` · ${Object.keys(c.entries ?? {}).length}`}` })),
        accessBadge(c))))
      : el('p.muted', { text: isGM() ? 'None yet. Make one and copy actors, items or entries into it to reuse them later.' : 'The GM hasn\'t shared any collections.' }));
    const packs = this.packs();
    if (packs.length) {
      parts.push(el('h3', { text: 'From packages' }));
      parts.push(el('ul.entity-list', {}, packs.map((p) => el('li.entity', { on: { click: () => this.openPack(p) } },
        el('span.avatar', { text: KINDS[p.kind]?.icon ?? '📦' }),
        el('span.grow', {}, el('span', { text: p.label }), el('small.muted', { text: ` ${KINDS[p.kind]?.label ?? p.kind} · ${p.pkgName}` })),
        isGM() ? el('span.badge.muted', { text: p.public ? 'players can see' : 'GM only' }) : null,
        el('span.badge', { text: '🔒', title: 'Read-only: import a copy to change it' })))));
    }
    panel.replaceChildren(...parts);
  }

  async create() {
    const v = await formDialog({
      title: 'New collection',
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'kind', label: 'Holds', type: 'select', options: Object.entries(KINDS).map(([k, d]) => [k, d.label]), value: 'item' },
      ],
      submit: 'Create',
    });
    if (!v) return;
    const id = newId();
    this.api.op({ op: 'collection_create', collection: { id, name: v.name.trim(), kind: v.kind, entries: {}, access: 'none', players: {} } }, rejectToast);
    this.openWorld(id);
  }

  // ------------------------------------------------------------------ windows

  openPack(p) {
    const key = p.key;
    if (this.windows.has(key)) { openWindow({ id: `coll-${key}` }); return; }
    const win = openWindow({ id: `coll-${key}`, title: p.label, width: 640 });
    const o = { win, query: '', selected: null, source: { type: 'pack', pack: p } };
    this.windows.set(key, o);
    win.onClose(() => this.windows.delete(key));
    win.body.replaceChildren(el('p.muted', { text: 'Loading…' }));
    this.loadPack(p.pkg, p.id)
      .then(() => this.render(key))
      .catch((err) => win.body.replaceChildren(el('p.muted', { text: `Couldn't open this collection: ${err.message}` })));
  }

  openWorld(id) {
    const key = `world:${id}`;
    if (this.windows.has(key)) { openWindow({ id: `coll-${key}` }); return; }
    const win = openWindow({ id: `coll-${key}`, title: this.world[id]?.name ?? 'Collection', width: 640 });
    this.windows.set(key, { win, query: '', selected: null, source: { type: 'world', id } });
    win.onClose(() => this.windows.delete(key));
    this.render(key);
  }

  /** { kind, name, entries: [{ id, doc }], editable } for a window. */
  contents(o) {
    if (o.source.type === 'pack') {
      const p = o.source.pack;
      const docs = this.cache.get(`${p.pkg}/${p.id}`) ?? [];
      return { kind: p.kind, name: p.label, entries: docs.map((doc, i) => ({ id: doc.id ?? String(i), doc })), editable: false, from: p.pkgName };
    }
    const c = this.world[o.source.id];
    if (!c) return null;
    return { kind: c.kind, name: c.name, entries: Object.entries(c.entries ?? {}).map(([id, doc]) => ({ id, doc })), editable: isGM(), limited: accessOf(c) === 'limited', collection: c };
  }

  render(key) {
    const o = this.windows.get(key);
    if (!o) return;
    const c = this.contents(o);
    if (!c) { o.win.body.replaceChildren(el('p.muted', { text: 'Loading…' })); return; }
    o.win.setTitle(c.name);
    const kind = KINDS[c.kind] ?? { one: c.kind, label: c.kind };
    const head = el('div.row.journal-actions');
    const q = o.query.trim().toLowerCase();
    const shown = c.entries.filter(({ doc }) => !q || String(doc.name ?? '').toLowerCase().includes(q)).sort((a, b) => String(a.doc.name).localeCompare(String(b.doc.name)));
    head.append(el('input', {
      type: 'search', placeholder: `Search ${kind.label.toLowerCase()}`, value: o.query, 'aria-label': 'Search this collection',
      on: { input: (e) => { o.query = e.target.value; this.render(key); const s = o.win.body.querySelector('input[type=search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } },
    }));
    if (isGM() && shown.length) head.append(el('button', { text: `Import all (${shown.length})`, on: { click: () => this.importMany(c.kind, shown.map((x) => x.doc), c.name) } }));
    if (c.editable) {
      head.append(
        el('button', { text: '+ Add from world', on: { click: () => this.addFromWorld(c.collection) } }),
        el('button', { text: '🔒 Access', on: { click: () => editAccess(`Who can see "${c.name}"`, c.collection, (patch) => this.api.op({ op: 'collection_update', id: c.collection.id, patch }, rejectToast)) } }),
        el('button.danger', { text: 'Delete', on: { click: () => { if (confirm(`Delete the collection "${c.name}"? (Things imported from it stay in the world.)`)) this.api.op({ op: 'collection_delete', id: c.collection.id }, rejectToast); } } }));
    }
    if (c.limited) {
      o.win.body.replaceChildren(el('p.muted', { text: 'You can see this collection\'s name only.' }));
      return;
    }
    const list = el('ul.entity-list.coll-list');
    for (const { id, doc } of shown) {
      const sel = o.selected === id;
      list.append(el('li.entity', {
        class: sel ? 'entity selected' : 'entity',
        draggable: c.kind === 'item',
        on: {
          click: () => { o.selected = id; this.render(key); },
          dragstart: (e) => {
            e.dataTransfer.setData(DOC_MIME, JSON.stringify({ kind: c.kind, doc }));
            e.dataTransfer.setData('text/plain', doc.name ?? '');
          },
        },
      },
      doc.img ? el('img.avatar', { src: doc.img, alt: '' }) : el('span.avatar', { text: String(doc.name ?? '?').charAt(0).toUpperCase() }),
      el('span.grow', {}, el('span', { text: doc.name ?? '(unnamed)' }), this.subtitle(c.kind, doc)),
      c.editable ? el('button.icon', { title: 'Remove from collection', text: '✕', on: { click: (e) => { e.stopPropagation(); this.api.op({ op: 'collection_update', id: c.collection.id, patch: { entries: { [id]: null } } }, rejectToast); } } }) : null));
    }
    if (!shown.length) list.append(el('li.muted', { text: c.entries.length ? 'Nothing matches.' : c.editable ? 'Empty. Use "Add from world" to copy things in.' : 'Empty.' }));
    const picked = c.entries.find((x) => x.id === o.selected);
    const preview = el('div.coll-preview', {}, picked ? this.preview(c.kind, picked.doc, c.name, (name) => {
      const hit = c.entries.find((x) => String(x.doc.name ?? '').trim().toLowerCase() === name.trim().toLowerCase());
      if (!hit) return false;
      o.selected = hit.id;
      this.render(key);
      return true;
    }) : el('p.muted', { text: `Pick ${/^[aeiou]/.test(kind.one) ? 'an' : 'a'} ${kind.one} to see it.${c.kind === 'item' ? ' Drag items onto an actor\'s sheet to give them a copy.' : ''}` }));
    const foot = c.from ? el('p.muted.small', { text: `From ${c.from}. Read-only: import a copy to change it.` }) : null;
    o.win.body.replaceChildren(head, el('div.coll-split', {}, list, preview), foot);
  }

  subtitle(kind, doc) {
    const sys = systemInfo();
    const t = kind === 'actor' ? sys.actor_types?.[doc.kind]?.label ?? doc.kind
      : kind === 'item' ? sys.item_types?.[doc.kind]?.label ?? doc.kind
        : kind === 'journal' ? doc.folder
          : kind === 'table' ? `${doc.results?.length ?? 0} results`
            : kind === 'macro' ? doc.kind : '';
    return t ? el('small.muted', { text: ` ${t}` }) : null;
  }

  /**
   * `openSibling(name)` shows another entry of the same collection, returning false if there's none.
   * `lookup`: shown from the Ctrl+Space lookup, where importing makes no sense (posting to chat does).
   */
  preview(kind, doc, from, openSibling = () => false, { lookup = false } = {}) {
    // Journal text usually starts with its own heading; don't repeat the name above it.
    const ownHeading = kind === 'journal' && /^\s*#/.test(doc.content ?? '');
    const parts = ownHeading ? [] : [el('h3', { text: doc.name ?? '' })];
    if (doc.img) parts.push(el('img.journal-img', { src: doc.img, alt: '' }));
    if (kind === 'journal') {
      parts.push(el('div.journal-text', {}, renderMarkdown(doc.content ?? '', {
        onLink: (name) => { if (!openSibling(name)) this.api.journal?.follow(name); },
        onRoll: (formula) => this.api.roll(formula, { flavor: doc.name }),
      })));
    } else if (kind === 'table') {
      if (doc.description) parts.push(el('p', { text: doc.description }));
      parts.push(el('ol', {}, (doc.results ?? []).map((r) => el('li', { text: `${r.text}${(r.weight ?? 1) !== 1 ? ` (×${r.weight})` : ''}` }))));
    } else if (kind === 'macro') {
      parts.push(el('pre.macro-src', { text: doc.command ?? '' }));
    } else if (kind === 'item' && blueprintType(doc.kind, true)) {
      parts.push(...this.itemDetails(doc, blueprintType(doc.kind, true), openSibling));
    } else {
      parts.push(el('dl.coll-data', {}, ...flatten(doc.data ?? {}).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })])));
      if (kind === 'actor' && doc.items?.length) parts.push(el('p.small', {}, el('strong', { text: 'Items: ' }), doc.items.map((i) => i.name).join(', ')));
    }
    const actions = el('div.row');
    if (['journal', 'item', 'table'].includes(kind)) {
      actions.append(el(lookup ? 'button.primary' : 'button', { text: '💬 Post to chat', title: 'Show this to everyone in chat', on: { click: () => this.postToChat(kind, doc) } }));
    }
    if (isGM() && !lookup) actions.append(el('button.primary', { text: 'Import into world', on: { click: () => this.importMany(kind, [doc], from) } }));
    if (kind === 'item') {
      const mine = Object.values(store.world.actors).filter((a) => isGM() || a.owners.includes(store.user.id));
      if (mine.length) actions.append(el('button', { text: 'Give to…', on: { click: () => this.giveTo(doc, mine) } }));
    }
    if (actions.childElementCount) parts.push(actions);
    return parts;
  }

  /** Post a rule, item or table to chat as a card (markdown; links in it stay clickable). */
  postToChat(kind, doc) {
    let body = '';
    if (kind === 'journal') {
      body = String(doc.content ?? '').replace(/^\s*#{1,6}\s+.*\n+/, ''); // the card has its own heading
    } else if (kind === 'item') {
      const type = blueprintType(doc.kind, true);
      if (type) {
        const { rows: all, texts } = this.itemFields(doc, type);
        // The fields the type shows beside names on sheets, if it picked some; otherwise all of them.
        const rows = type.summary?.length ? all.filter(([, , k]) => type.summary.includes(k)) : all;
        body = [rows.map(([l, v]) => `**${l}:** ${v}`).join(' · '), ...texts].filter(Boolean).join('\n\n');
      }
      body ||= String(doc.data?.description ?? '');
    } else if (kind === 'table') {
      body = [doc.description, ...(doc.results ?? []).map((r, i) => `${i + 1}. ${r.text}`)].filter(Boolean).join('\n');
    }
    postCard(this.api, doc.name ?? '', body);
  }

  /** An item's fields by its builder type: [[label, shown value]] and its long texts. */
  itemFields(doc, type) {
    const data = doc.data ?? {};
    const rows = [];
    const texts = [];
    const shown = (f, v) => {
      if (f.kind === 'checkbox') return v ? 'Yes' : null;
      if (f.kind === 'choice') return (f.options ?? []).find((o) => o.value === v)?.label ?? v;
      if (f.kind === 'resource') return v && typeof v === 'object' ? (v.max ? `${v.value ?? 0} / ${v.max}` : null) : v;
      return v;
    };
    const walk = (nodes, obj) => {
      for (const f of nodes ?? []) {
        if (f.hidden || ['action', 'effect', 'formula', 'list'].includes(f.kind)) continue;
        if (f.kind === 'group') { walk(f.children, f.flat ? obj : obj?.[f.key]); continue; }
        const v = shown(f, obj?.[f.key]);
        if (v == null || v === '' || (typeof v === 'number' && v === 0 && f.default == null)) continue;
        if (f.kind === 'longtext') texts.push(String(v));
        else rows.push([f.label || f.key, String(v), f.key]);
      }
    };
    walk(type.children, data);
    return { rows, texts };
  }

  /** An item, laid out by its type in the system builder: named fields, then its text. */
  itemDetails(doc, type, openSibling) {
    const fields = this.itemFields(doc, type);
    const rows = fields.rows.flatMap(([l, v]) => [el('dt', { text: l }), el('dd', { text: v })]);
    const texts = fields.texts.map((t) => el('div.journal-text', {}, renderMarkdown(t, { onLink: (name) => { if (!openSibling(name)) this.api.journal?.follow(name); }, onRoll: (formula) => this.api.roll(formula, { flavor: doc.name }) })));
    const actions = (type.children ?? []).filter((c) => c.kind === 'action').map((a) => a.label || a.key);
    return [
      el('div.muted.small', { text: type.label || type.key }),
      rows.length ? el('dl.coll-fields', {}, ...rows) : null,
      ...texts,
      actions.length ? el('p.muted.small', { text: `On a character: ${actions.join(', ')}.` }) : null,
    ].filter(Boolean);
  }

  // ------------------------------------------------------------------ into the system's collections

  /**
   * GM: copy a document (an item, actor or journal entry) into one of the world
   * system's own collections (e.g. a homebrew class into Classes and subclasses),
   * so it ships with the system for every world. Same name and type: replaces it.
   */
  async addToSystemPack(kind, doc) {
    const system = store.world?.system;
    const packs = this.packs().filter((p) => p.pkg === system && p.kind === kind);
    if (!packs.length) { toast(`This system has no ${KINDS[kind]?.label.toLowerCase() ?? kind} collections to add to.`); return; }
    const v = await formDialog({
      title: `Add "${doc.name}" to the system's collection`,
      fields: [{ name: 'pack', label: `Collection in ${systemInfo().name ?? system}`, type: 'select', options: packs.map((p) => [p.id, p.label]) }],
      submit: 'Add',
    });
    if (!v) return;
    const pack = packs.find((p) => p.id === v.pack);
    let existing = [];
    try { existing = await this.loadPack(pack.pkg, pack.id); } catch { /* new file */ }
    const clash = existing.find((d) => String(d.name ?? '').trim().toLowerCase() === doc.name.trim().toLowerCase() && (!doc.kind || d.kind === doc.kind));
    if (clash && !confirm(`${pack.label} already has "${clash.name}". Replace it with this version?`)) return;
    const copy = structuredClone(doc);
    for (const k of ['folder', 'access', 'players', 'owners', 'derived', 'author', 'shared']) delete copy[k];
    // Owned items in an actor copy keep their own ids; the document gets the collection's id.
    delete copy.id;
    try {
      const res = await fetch(`/api/collections/${encodeURIComponent(pack.pkg)}/${encodeURIComponent(pack.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-hearth-session': this.api.session ?? '' },
        body: JSON.stringify({ doc: copy }),
      });
      if (!res.ok) throw new Error(await res.text());
      this.cache.delete(`${pack.pkg}/${pack.id}`);
      toast(clash ? `Replaced ${doc.name} in ${pack.label}.` : `Added ${doc.name} to ${pack.label}. It's part of the system now, in every world that uses it.`);
    } catch (e) {
      toast(`Couldn't add it: ${e.message}`, 'error');
    }
  }

  /** A GM button that offers addToSystemPack (or nothing for players). */
  addButton(kind, doc) {
    if (!isGM()) return null;
    return el('button', { type: 'button', text: '📚 Add to the system’s collection…', title: 'Copy this into one of the system’s own collections, so every world using the system has it', on: { click: () => this.addToSystemPack(kind, typeof doc === 'function' ? doc() : doc) } });
  }

  // ------------------------------------------------------------------ import / copy

  /** A fresh world copy of a collection document. */
  createOp(kind, doc, folder) {
    const base = structuredClone(doc);
    delete base.id;
    switch (kind) {
      case 'actor':
        return { op: 'actor_create', actor: { owners: [], items: [], data: {}, ...base, id: '', items: (base.items ?? []).map((i) => ({ ...i, id: i.id || newId() })) } };
      case 'item':
        return { op: 'library_item_create', item: { img: null, data: {}, flags: {}, ...base, id: '', folder: base.folder || folder || '', access: 'none', players: {} } };
      case 'journal':
        return { op: 'journal_create', entry: { content: '', img: null, ...base, id: '', folder: base.folder || folder || '', access: 'none', players: {} } };
      case 'table':
        return { op: 'table_create', table: { description: '', results: [], ...base, id: '', folder: base.folder || folder || '', access: 'none', players: {} } };
      case 'macro':
        return { op: 'macro_create', macro: { kind: 'chat', command: '', img: null, ...base, id: '', author: '', shared: false } };
      default:
        return null;
    }
  }

  importMany(kind, docs, folder) {
    if (docs.length > 1 && !confirm(`Import ${docs.length} ${KINDS[kind]?.label.toLowerCase() ?? 'documents'} into the world?`)) return;
    let n = 0;
    for (const doc of docs) {
      const op = this.createOp(kind, doc, folder);
      if (op) { this.api.op(op, rejectToast); n++; }
    }
    toast(n === 1 ? `Imported ${docs[0].name}.` : `Imported ${n} ${KINDS[kind]?.label.toLowerCase()}.`);
  }

  async giveTo(doc, actors) {
    const v = await formDialog({
      title: `Give ${doc.name} to…`,
      fields: [{ name: 'actor', label: 'Actor', type: 'select', options: actors.sort((a, b) => a.name.localeCompare(b.name)).map((a) => [a.id, a.name]) }],
      submit: 'Give',
    });
    if (v) this.giveItem(v.actor, doc);
  }

  /** Copy an item document onto an actor (also used for drops on a sheet). */
  giveItem(actorId, doc) {
    const actor = store.world.actors[actorId];
    if (!actor) return;
    this.api.op({ op: 'item_create', actor_id: actorId, item: { id: '', name: doc.name, kind: doc.kind, img: doc.img ?? null, data: structuredClone(doc.data ?? {}), flags: structuredClone(doc.flags ?? {}) } }, rejectToast);
    toast(`Gave ${doc.name} to ${actor.name}.`);
  }

  /** GM: copy a world document into a world collection. */
  async addFromWorld(c) {
    const w = store.world;
    const sources = {
      actor: Object.values(w.actors),
      item: Object.values(w.items ?? {}).map((x) => x),
      journal: Object.values(w.journal ?? {}),
      table: Object.values(w.tables ?? {}),
      macro: Object.values(w.macros ?? {}),
    }[c.kind] ?? [];
    if (!sources.length) { toast(`There are no ${KINDS[c.kind]?.label.toLowerCase()} in this world to add.`); return; }
    const v = await formDialog({
      title: `Add to ${c.name}`,
      fields: [{ name: 'id', label: KINDS[c.kind].label, type: 'select', options: sources.sort((a, b) => a.name.localeCompare(b.name)).map((d) => [d.id, d.name]) }],
      submit: 'Add',
    });
    if (!v) return;
    const doc = structuredClone(sources.find((d) => d.id === v.id));
    // Keep what describes it; drop world-specific state (ownership, sharing, derived values).
    for (const k of ['owners', 'derived', 'access', 'players', 'author', 'shared']) delete doc[k];
    const id = newId();
    doc.id = id;
    this.api.op({ op: 'collection_update', id: c.id, patch: { entries: { [id]: doc } } }, rejectToast);
    toast(`Added ${doc.name}.`);
  }

  onOp(op) {
    if (!op.op.startsWith('collection_')) return;
    const id = op.collection?.id ?? op.id;
    const key = `world:${id}`;
    if (op.op === 'collection_delete') this.windows.get(key)?.win.close();
    else this.render(key);
    this.api.sidebar?.refresh('collections');
  }
}

/** Post a titled card to chat (markdown body), within the chat's length limit. */
export function postCard(api, title, body) {
  let text = `### ${title}\n\n${String(body ?? '').trim()}`.trim();
  if (text.length > 3900) text = `${text.slice(0, 3890).replace(/\s+\S*$/, '')} …`;
  api.chat(text);
}

/** { a: { b: 1 } } → [['a.b', 1]] */
function flatten(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, key));
    else if (!Array.isArray(v)) out.push([key.replace(/_/g, ' '), v]);
  }
  return out;
}
