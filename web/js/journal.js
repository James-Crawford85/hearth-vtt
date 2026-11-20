// Journals: books that the GM and players keep of their travels. Each one has a
// leather cover (a colour and a gold emblem) and parchment pages that are
// written, illustrated and turned right there in the book (see journal-book.js).
//
// A journal entry is { id, name, author, content, img, access, players, book }.
//   author    who made it: they decide who may read it and write in it (the GM always can)
//   access    every other player: none (hidden) | limited (cover only) | observer (read) | owner (write)
//   players   per player, the same levels; a player gets the higher of the two
//   book      { cover: {color, emblem}, age, pages: {id: {sort, author, font, text, items}} }
//   content   all the pages' text (Markdown), kept in step so search and [[links]] work
// Entries from before books (no `book`) show as a book of their text.
// The server only sends players what they may see, so this file just mirrors
// the rules to show the right buttons.

import { hooks } from './hooks.js';
import { store, isGM } from './store.js';
import { el, toast, openWindow, formDialog } from './ui.js';
import { COVER_COLORS, DEFAULT_COVER, EMBLEMS, emblemSvg } from './journal-art.js';
import { BookView } from './journal-book.js';

const LEVELS = ['none', 'limited', 'observer', 'owner'];
export const ACCESS_LABELS = {
  none: 'Hidden',
  limited: 'Limited: name and image only',
  observer: 'Observer: can read',
  owner: 'Owner: can read and edit',
};
/** The same levels, as journals put them. */
export const BOOK_ACCESS = {
  none: 'Can\'t see it',
  limited: 'Sees the cover only',
  observer: 'Can read it',
  owner: 'Can read and write in it',
};

const rank = (a) => Math.max(0, LEVELS.indexOf(a ?? 'none'));

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** A book's cover, with defaults for entries made before books. */
export const coverOf = (e) => ({ ...DEFAULT_COVER, ...(e?.book?.cover ?? {}) });

/** A cover as an element: leather, gold border, emblem and title. `size`: 'shelf' | 'big'. */
export function coverEl(e, { size = 'shelf', title = e?.name ?? '' } = {}) {
  const c = coverOf(e);
  return el(`div.jb-cover.${size}`, { style: `--leather:${c.color}` },
    el('div.jb-cover-frame', { 'aria-hidden': 'true' }),
    el('div.jb-cover-emblem', { html: emblemSvg(c.emblem) }),
    el('div.jb-cover-title', { text: title }));
}

export class Journal {
  constructor(api) {
    this.api = api;
    this.books = new Map(); // id → BookView (open windows)
    this.filter = '';
    hooks.on('op', (op) => this.onOp(op));
    api.socket.on('core.journal.show', (p) => this.receiveShow(p));
  }

  get entries() { return store.world?.journal ?? {}; }
  entry(id) { return this.entries[id] ?? null; }

  /** This user's access to an entry: 'none' | 'limited' | 'observer' | 'owner'. */
  access(e) {
    if (!e) return 'none';
    if (isGM() || e.author === store.user?.id) return 'owner';
    return LEVELS[Math.max(rank(e.access), rank(e.players?.[store.user.id]))];
  }
  canWrite(e) { return this.access(e) === 'owner'; }
  /** May this user change who sees the book, its cover, or throw it away? */
  canManage(e) { return !!e && (isGM() || (!!e.author && e.author === store.user?.id)); }

  /** Find a visible entry by name (case-insensitive). */
  byName(name) {
    const n = name.trim().toLowerCase();
    return Object.values(this.entries).find((e) => e.name.trim().toLowerCase() === n) ?? null;
  }

  userName(id) { return store.world?.users?.[id]?.name ?? 'Someone'; }

  // ------------------------------------------------------------------ the shelf (sidebar panel)

  renderPanel(panel) {
    if (!this.shelf || !panel.contains(this.shelf)) {
      const search = el('input', {
        type: 'search', placeholder: 'Search journals', value: this.filter, 'aria-label': 'Search journals',
        on: { input: (e) => { this.filter = e.target.value; this.renderList(); } },
      });
      this.shelf = el('div.jb-shelves');
      panel.replaceChildren(el('div.row', {}, el('button.primary', { text: '+ New journal', on: { click: () => this.createBook() } }), search), this.shelf);
    }
    this.renderList();
  }

  renderList() {
    if (!this.shelf) return;
    const q = this.filter.trim().toLowerCase();
    const me = store.user?.id;
    const entries = Object.values(this.entries)
      .filter((e) => !q || e.name.toLowerCase().includes(q) || (this.access(e) !== 'limited' && e.content?.toLowerCase().includes(q)));
    // Shelves: yours first, then each other author's, then old entries without an author.
    const shelves = new Map();
    const shelfOf = (e) => (e.author === me ? 'me' : e.author && store.world?.users?.[e.author] ? e.author : '');
    for (const e of entries) {
      const k = shelfOf(e);
      if (!shelves.has(k)) shelves.set(k, []);
      shelves.get(k).push(e);
    }
    const order = [...shelves.keys()].sort((a, b) => (b === 'me') - (a === 'me') || (a === '') - (b === '') || this.userName(a).localeCompare(this.userName(b)));
    const out = [];
    for (const k of order) {
      const books = shelves.get(k).sort((a, b) => a.name.localeCompare(b.name));
      const title = k === 'me' ? 'Your journals' : k ? `${this.userName(k)}'s journals` : isGM() ? 'Handouts and lore' : 'From the GM';
      out.push(el('section.jb-shelf', {}, el('h4.jb-shelf-title', { text: title }),
        el('div.jb-shelf-row', {}, books.map((e) => this.shelfBook(e)),
          k === 'me' && !q ? el('button.jb-shelf-new', { title: 'Start a new journal', on: { click: () => this.createBook() } }, el('span', { text: '+' }), el('small', { text: 'New journal' })) : null)));
    }
    if (!entries.length) {
      out.push(q
        ? el('p.muted', { text: 'No journals match.' })
        : el('div.jb-empty', {},
          el('p', { text: 'Keep a journal of your travels: give it a title, pick a cover, and write in it like a real book.' }),
          el('button.jb-shelf-new', { on: { click: () => this.createBook() } }, el('span', { text: '+' }), el('small', { text: 'New journal' }))));
    }
    this.shelf.replaceChildren(...out);
  }

  shelfBook(e) {
    const level = this.access(e);
    let badge = null;
    if (e.author === store.user?.id || isGM()) {
      const shared = Math.max(rank(e.access), ...Object.entries(e.players ?? {}).filter(([u]) => u !== e.author).map(([, a]) => rank(a)));
      badge = shared >= 3 ? '✎ shared' : shared ? '👁 shared' : null;
    } else if (level === 'owner') badge = '✎ you can write';
    else if (level === 'limited') badge = 'cover only';
    return el('button.jb-shelf-book', {
      title: `${e.name}${e.author && e.author !== store.user?.id ? ` (${this.userName(e.author)})` : ''}`,
      draggable: true,
      on: {
        click: () => this.open(e.id),
        dragstart: (ev) => ev.dataTransfer.setData('text/plain', `[[${e.name}]]`),
      },
    }, coverEl(e), badge ? el('span.jb-ribbon', { text: badge }) : null);
  }

  // ------------------------------------------------------------------ cover maker

  /** The cover maker: title, leather, emblem (and, for a new one, who can see it). */
  coverDialog({ title = 'New journal', name = '', cover = DEFAULT_COVER, age = 0, plate = {}, author = '', submit = 'Create', isNew = true } = {}) {
    return new Promise((resolve) => {
      const win = openWindow({ id: 'journal-cover', title, width: 600 });
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); win.close(); };
      win.onClose(() => { if (!done) { done = true; resolve(null); } });
      const state = { name, color: cover.color, emblem: cover.emblem, age, share: 'none', plate: { ...plate } };
      const preview = el('div.jb-maker-preview');
      const draw = () => preview.replaceChildren(coverEl({ name: state.name || 'Untitled', book: { cover: state } }, { size: 'big' }));
      const nameInput = el('input', { value: name, placeholder: 'e.g. The Road to Thornwall', maxlength: 80, required: true, on: { input: (e) => { state.name = e.target.value; draw(); } } });
      const swatches = el('div.jb-swatches', {}, COVER_COLORS.map(([c, label]) => el('button.jb-swatch', {
        type: 'button', title: label, 'aria-label': label, style: `--leather:${c}`, 'aria-pressed': String(c === state.color),
        on: { click: (ev) => { state.color = c; swatches.querySelectorAll('.jb-swatch').forEach((b) => b.setAttribute('aria-pressed', String(b === ev.currentTarget))); draw(); } },
      })));
      const emblems = el('div.jb-emblems', {}, Object.entries(EMBLEMS).map(([k, [label]]) => el('button.jb-emblem-pick', {
        type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(k === state.emblem), html: emblemSvg(k),
        on: { click: (ev) => { state.emblem = k; emblems.querySelectorAll('.jb-emblem-pick').forEach((b) => b.setAttribute('aria-pressed', String(b === ev.currentTarget))); draw(); } },
      })));
      const extra = [];
      if (isNew) {
        extra.push(el('label', {}, 'Who else can see it',
          el('select', { on: { change: (e) => { state.share = e.target.value; } } },
            el('option', { value: 'none', text: 'Only me (and the GM)' }),
            el('option', { value: 'observer', text: 'Everyone can read it' }),
            el('option', { value: 'owner', text: 'Everyone can read and write in it' }))),
          el('small.muted', { text: 'You can choose people one by one later, from the book.' }));
      } else {
        extra.push(el('label', {}, 'Wear and age',
          el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: age, on: { input: (e) => { state.age = Number(e.target.value); } } }),
          el('span.jb-age-ends', {}, el('small', { text: 'New' }), el('small', { text: 'Found in a crypt' }))));
        // The bookplate inside the cover: two lines around the title, or none at all.
        const lines = el('div.jb-plate-lines', { hidden: !!state.plate.hidden },
          el('label', {}, 'Above the title', el('input', { value: state.plate.top ?? 'Ex libris', maxlength: 60, placeholder: 'Ex libris',
            on: { input: (e) => { state.plate.top = e.target.value; } } })),
          el('label', {}, 'Below the title', el('input', { value: state.plate.bottom ?? (author ? `kept by ${author}` : ''), maxlength: 80, placeholder: 'e.g. kept by Sir Aldric of Thornwall (or leave it empty)',
            on: { input: (e) => { state.plate.bottom = e.target.value; } } })));
        extra.push(el('div.jb-maker-label', { text: 'Bookplate inside the cover' }),
          el('label.check', {}, el('input', { type: 'checkbox', checked: !state.plate.hidden,
            on: { change: (e) => { state.plate.hidden = !e.target.checked; lines.hidden = !e.target.checked; } } }), 'Show a bookplate'),
          lines);
      }
      const form = el('form.jb-maker-form', {
        on: { submit: (ev) => { ev.preventDefault(); if (!state.name.trim()) { nameInput.focus(); return; } finish({ ...state, name: state.name.trim() }); } },
      },
      el('label', {}, 'Title', nameInput),
      el('div.jb-maker-label', { text: 'Cover' }), swatches,
      el('div.jb-maker-label', { text: 'Emblem' }), emblems,
      ...extra,
      el('div.row', {}, el('span.grow'), el('button', { type: 'button', text: 'Cancel', on: { click: () => finish(null) } }), el('button.primary', { type: 'submit', text: submit })));
      win.body.replaceChildren(el('div.jb-maker', {}, preview, form));
      draw();
      nameInput.focus();
    });
  }

  async createBook() {
    const v = await this.coverDialog();
    if (!v) return;
    const id = newId();
    const page = newId();
    const me = store.user?.id;
    const entry = {
      id, name: v.name, folder: '', content: '', img: null, access: v.share, players: {},
      book: { cover: { color: v.color, emblem: v.emblem }, age: 0, pages: { [page]: { sort: 1, author: me, font: localFont(), text: '', items: {} } } },
    };
    this.api.op({ op: 'journal_create', entry }, (why) => toast(why, 'error'));
    this.open(id, { edit: page });
  }

  async editCover(id) {
    const e = this.entry(id);
    if (!e) return;
    const v = await this.coverDialog({
      title: `Cover: ${e.name}`, name: e.name, cover: coverOf(e), age: e.book?.age ?? 0,
      plate: e.book?.plate ?? {}, author: e.author ? this.userName(e.author) : '', submit: 'Save', isNew: false,
    });
    if (!v) return;
    const plate = { hidden: !!v.plate.hidden };
    if (v.plate.top != null) plate.top = v.plate.top.trim();
    if (v.plate.bottom != null) plate.bottom = v.plate.bottom.trim();
    this.update(id, { name: v.name, book: { cover: { color: v.color, emblem: v.emblem }, age: v.age, plate } });
  }

  // ------------------------------------------------------------------ sharing

  async editAccess(id) {
    const e = this.entry(id);
    if (!e) return;
    const players = Object.values(store.world.users).filter((u) => u.role !== 'gm' && u.id !== e.author).sort((a, b) => a.name.localeCompare(b.name));
    const opts = Object.entries(BOOK_ACCESS);
    const v = await formDialog({
      title: `Who can see "${e.name}"`,
      fields: [
        { name: 'access', label: 'Everyone', type: 'select', options: opts, value: e.access ?? 'none' },
        ...players.map((u) => ({
          name: `p_${u.id}`, label: u.name, type: 'select',
          options: [['', 'Same as everyone'], ...opts], value: e.players?.[u.id] ?? '',
        })),
      ],
    });
    if (!v || !this.entry(id)) return;
    const patch = { access: v.access, players: {} };
    for (const u of players) patch.players[u.id] = v[`p_${u.id}`] || null;
    this.update(id, patch);
    toast(`Saved who can see "${e.name}". The GM always can.`);
  }

  // ------------------------------------------------------------------ changes

  update(id, patch) { this.api.op({ op: 'journal_update', id, patch }, (why) => toast(why, 'error')); }

  remove(id) {
    const e = this.entry(id);
    if (!e || !confirm(`Throw away "${e.name}"? Every page goes with it, and this can't be undone.`)) return;
    this.api.op({ op: 'journal_delete', id }, (why) => toast(why, 'error'));
  }

  // ------------------------------------------------------------------ the open book

  /** Open a book. `edit`: a page id to start writing on. `page`: a page id to open at. */
  open(id, { edit = null, page = null } = {}) {
    let b = this.books.get(id);
    if (!b) {
      b = new BookView(this, id);
      this.books.set(id, b);
      b.onClose(() => this.books.delete(id));
    } else b.focus();
    if (page || edit) b.goTo(page ?? edit);
    if (edit) b.editWhenReady(edit);
    return b;
  }

  actorByName(name) {
    const n = name.trim().toLowerCase();
    return Object.values(store.world?.actors ?? {}).find((a) => a.name.trim().toLowerCase() === n) ?? null;
  }

  /** Follow a [[Name]] link: a journal, else an actor. */
  follow(name) {
    const e = this.byName(name);
    if (e) { this.open(e.id); return; }
    const a = this.actorByName(name);
    if (a) { this.api.sheets.open(a.id); return; }
    toast(`Nothing called "${name}" that you can see.`);
  }

  // ------------------------------------------------------------------ GM: show to players

  /** Pop the book up for every player who can see it (offering to share it first). */
  show(id) {
    const e = this.entry(id);
    if (!e) return;
    const anyone = rank(e.access) > 0 || Object.entries(e.players ?? {}).some(([u, a]) => u !== e.author && rank(a) > 0);
    if (!anyone) {
      if (!confirm(`Players can't see "${e.name}" yet. Let every player read it, and show it to them?`)) return;
      this.update(id, { access: 'observer' });
    }
    this.api.socket.emit('core.journal.show', { id, page: this.books.get(id)?.currentPageId() ?? null });
    toast(`Showing "${e.name}" to players.`);
  }

  receiveShow({ id, page } = {}, from) {
    if (from && store.world?.users?.[from]?.role !== 'gm') return;
    const e = this.entry(id);
    if (!e) return; // not shared with this player
    this.open(id, { page });
    toast(`The GM shows you "${e.name}".`);
  }

  // ------------------------------------------------------------------ sync

  onOp(op) {
    if (!op.op.startsWith('journal_') && op.op !== 'user_upsert' && op.op !== 'actor_create' && op.op !== 'actor_delete') return;
    const id = op.entry?.id ?? op.id;
    if (op.op === 'journal_delete') this.books.get(id)?.close();
    for (const b of this.books.values()) b.changed(op.op.startsWith('journal_') ? id : null);
    this.renderList();
  }
}

const FONT_KEY = 'hearth.journal.font';
/** The font this person last wrote in (new pages start in it). */
export function localFont(set) {
  try {
    if (set) localStorage.setItem(FONT_KEY, set);
    return localStorage.getItem(FONT_KEY) || 'hand';
  } catch { return set || 'hand'; }
}
