// Lookup: Ctrl+Space (or the 🔍 button) opens a search over everything you can
// see: the system's conditions, its packs (spells, items, rules…), the
// world's journal, items, tables, actors and collections, and the items on
// your characters. Pick a result to open it.

import { store, isGM, systemInfo } from './store.js';
import { el, openWindow } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { accessOf } from './directory.js';
import { openItemSheet } from './blueprint-sheet.js';
import { postCard } from './collections.js';

const MAX = 60;

export class Lookup {
  constructor(api) {
    this.api = api;
    this.overlay = null;
    this.packDocs = null; // [{ doc, kind, pack }] once loaded
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.code === 'Space' || e.key === ' ')) {
        e.preventDefault();
        if (this.overlay) this.close(); else this.open();
      }
    });
  }

  // ------------------------------------------------------------------ what can be found

  /** Everything searchable right now: { name, type, from, open(), text? }. */
  sources() {
    const out = [];
    const w = store.world ?? {};
    const sys = systemInfo();
    for (const c of sys.rules?.conditions ?? []) {
      out.push({ name: c.name || c.id, type: 'Condition', from: sys.name, text: c.description, open: () => this.showCondition(c) });
    }
    const journal = this.api.journal;
    for (const e of Object.values(w.journal ?? {})) {
      if (journal?.access(e) === 'none') continue;
      out.push({ name: e.name, type: 'Journal', from: e.folder || 'Journal', text: e.content, open: () => journal.open(e.id) });
    }
    for (const x of Object.values(w.items ?? {})) {
      if (!isGM() && accessOf(x) === 'none') continue;
      out.push({ name: x.name, type: sys.item_types?.[x.kind]?.label ?? 'Item', from: 'Items', open: () => this.api.items.open(x.id) });
    }
    for (const t of Object.values(w.tables ?? {})) {
      if (!isGM() && accessOf(t) === 'none') continue;
      out.push({ name: t.name, type: 'Table', from: 'Rollable tables', open: () => this.api.tables.open(t.id) });
    }
    for (const a of Object.values(w.actors ?? {})) {
      const mine = isGM() || a.owners?.includes(store.user?.id);
      if (mine) out.push({ name: a.name, type: sys.actor_types?.[a.kind]?.label ?? 'Actor', from: 'Actors', open: () => this.api.sheets.open(a.id) });
      // Items your characters carry (their Magic Missile, with its numbers).
      if (!mine) continue;
      for (const it of a.items ?? []) {
        out.push({ name: it.name, type: sys.item_types?.[it.kind]?.label ?? it.kind, from: a.name, open: () => openItemSheet(a.id, it.id, this.api) });
      }
    }
    for (const c of Object.values(w.collections ?? {})) {
      if (!isGM() && ['none', 'limited'].includes(accessOf(c))) continue;
      for (const doc of Object.values(c.entries ?? {})) {
        out.push({ name: doc.name, type: this.typeLabel(c.kind, doc), from: c.name, text: doc.content, open: () => this.showDoc(c.kind, doc, c.name) });
      }
    }
    for (const { doc, kind, pack } of this.packDocs ?? []) {
      out.push({ name: doc.name, type: this.typeLabel(kind, doc), from: pack.label, text: doc.content ?? doc.data?.description, open: () => this.showDoc(kind, doc, pack.label) });
    }
    return out.filter((r) => r.name);
  }

  typeLabel(kind, doc) {
    const sys = systemInfo();
    if (kind === 'item') return sys.item_types?.[doc.kind]?.label ?? 'Item';
    if (kind === 'actor') return sys.actor_types?.[doc.kind]?.label ?? 'Actor';
    return { journal: 'Rules', table: 'Table', macro: 'Macro' }[kind] ?? kind;
  }

  /** Load every pack this user may open (once; packs don't change while a world runs). */
  async loadPacks() {
    if (this.packDocs) return;
    const packs = this.api.collections?.packs() ?? [];
    const all = await Promise.all(packs.map((p) => this.api.collections.loadPack(p.pkg, p.id)
      .then((docs) => docs.map((doc) => ({ doc, kind: p.kind, pack: p })))
      .catch(() => [])));
    this.packDocs = all.flat();
  }

  /** Name matches first (whole name, then start, then a word), then matches in the text. */
  search(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored = [];
    for (const r of this.sources()) {
      const name = r.name.toLowerCase();
      let score = 0;
      if (words.every((w) => name.includes(w))) {
        const joined = words.join(' ');
        score = name === joined ? 100 : name.startsWith(joined) ? 80 : words.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) ? 60 : 40;
      } else if (r.text && words.every((w) => String(r.text).toLowerCase().includes(w))) {
        score = 10;
      }
      if (score) scored.push({ ...r, score });
    }
    // The same thing from several places (a spell in the pack and on Jim): keep them all, best first.
    return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.from.localeCompare(b.from)).slice(0, MAX);
  }

  // ------------------------------------------------------------------ the search box

  open() {
    if (!store.world) return;
    const input = el('input.lookup-input', { type: 'search', placeholder: 'Look up a rule, condition, spell, item…', 'aria-label': 'Look up', autocomplete: 'off', spellcheck: false });
    const list = el('ul.lookup-results', { role: 'listbox' });
    const hint = el('div.lookup-hint', { text: 'Loading the system\'s collections…' });
    const box = el('div.lookup-box', { role: 'dialog', 'aria-label': 'Look up' }, input, list, hint);
    this.overlay = el('div.lookup-overlay', { on: { pointerdown: (e) => { if (e.target === this.overlay) this.close(); } } }, box);
    document.body.append(this.overlay);
    let results = [];
    let sel = 0;
    const draw = () => {
      const q = input.value.trim();
      results = this.search(q);
      sel = Math.min(sel, Math.max(0, results.length - 1));
      list.replaceChildren(...results.map((r, i) => el('li', {
        class: i === sel ? 'lookup-row on' : 'lookup-row', role: 'option', 'aria-selected': String(i === sel),
        on: { pointerdown: (e) => { e.preventDefault(); this.pick(r); }, pointermove: () => { if (sel !== i) { sel = i; mark(); } } },
      }, el('span.lookup-name', { text: r.name }), el('span.lookup-type', { text: r.type }), el('span.lookup-from', { text: r.from }))));
      if (!q) hint.textContent = 'Type a name: conditions, spells, items, rules, journal entries, characters. ↑↓ to move, Enter to open, Esc to close.';
      else if (!results.length) hint.textContent = `Nothing called "${q}".`;
      else hint.textContent = `${results.length}${results.length === MAX ? '+' : ''} found. Enter opens the highlighted one.`;
    };
    const mark = () => {
      [...list.children].forEach((li, i) => { li.classList.toggle('on', i === sel); li.setAttribute('aria-selected', String(i === sel)); });
      list.children[sel]?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
      else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); this.pick(results[sel]); }
    });
    draw();
    input.focus();
    this.loadPacks().then(() => { if (this.overlay) draw(); });
  }

  close() {
    this.overlay?.remove();
    this.overlay = null;
  }

  pick(r) {
    this.close();
    r.open();
  }

  // ------------------------------------------------------------------ showing things

  showCondition(c) {
    const win = openWindow({ id: `lookup-condition-${c.id}`, title: c.name || c.id, width: 380 });
    const parts = [];
    if (c.description) parts.push(el('div.journal-text', {}, renderMarkdown(c.description, { onLink: (name) => this.follow(name) })));
    else parts.push(el('p.muted', { text: 'This condition has no description yet. The GM can add one in the system builder (Rules → Conditions).' }));
    if (c.changes?.length) {
      parts.push(el('details.lookup-mechanics', {}, el('summary', { text: 'What it changes on a sheet' }),
        el('ul', {}, c.changes.map((ch) => el('li', {}, el('code', { text: ch.path }), ` ${ch.mode ?? 'add'} `, el('code', { text: ch.value }))))));
    }
    if (c.description) {
      parts.push(el('div.row', {}, el('button.primary', { text: '💬 Post to chat', title: 'Show this to everyone in chat', on: { click: () => postCard(this.api, c.name || c.id, c.description) } })));
    }
    win.body.replaceChildren(...parts);
  }

  /** A pack or collection document, read-only (with Import / Give to… for items). */
  showDoc(kind, doc, from) {
    const win = openWindow({ id: `lookup-doc-${from}/${doc.id ?? doc.name}`, title: doc.name ?? '', width: kind === 'journal' ? 520 : 440 });
    win.body.replaceChildren(...this.api.collections.preview(kind, doc, from, (name) => this.follow(name), { lookup: true }));
  }

  /** A [[link]] inside looked-up text: open the best match by exact name. */
  follow(name) {
    const hit = this.search(name).find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
    if (hit) { hit.open(); return true; }
    return false;
  }
}
