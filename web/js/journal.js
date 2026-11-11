// Journal: notes, handouts and lore. Entries are Markdown (see markdown.js)
// with an optional image. The GM decides who sees each entry:
//   none      – hidden
//   limited   – name and image only
//   observer  – can read it
//   owner     – can read and edit it
// The server only sends players what they may see, so this file just
// mirrors the rules for showing the right buttons.

import { hooks } from './hooks.js';
import { store, isGM } from './store.js';
import { el, toast, openWindow, formDialog } from './ui.js';
import { renderMarkdown } from './markdown.js';

const LEVELS = ['none', 'limited', 'observer', 'owner'];
export const ACCESS_LABELS = {
  none: 'Hidden',
  limited: 'Limited: name and image only',
  observer: 'Observer: can read',
  owner: 'Owner: can read and edit',
};

const rank = (a) => Math.max(0, LEVELS.indexOf(a ?? 'none'));

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export class Journal {
  constructor(api) {
    this.api = api;
    this.open_ = new Map(); // id → { win, editing }
    this.filter = '';
    hooks.on('op', (op) => this.onOp(op));
    api.socket.on('core.journal.show', (p) => this.receiveShow(p));
  }

  get entries() { return store.world?.journal ?? {}; }
  entry(id) { return this.entries[id] ?? null; }

  /** This user's access to an entry: 'none' | 'limited' | 'observer' | 'owner'. */
  access(e) {
    if (!e) return 'none';
    if (isGM()) return 'owner';
    return LEVELS[Math.max(rank(e.access), rank(e.players?.[store.user.id]))];
  }

  /** Find a visible entry by name (case-insensitive). */
  byName(name) {
    const n = name.trim().toLowerCase();
    return Object.values(this.entries).find((e) => e.name.trim().toLowerCase() === n) ?? null;
  }

  // ------------------------------------------------------------------ sidebar panel

  renderPanel(panel) {
    if (!this.list || !panel.contains(this.list)) {
      const search = el('input', {
        type: 'search', placeholder: 'Search entries', value: this.filter, 'aria-label': 'Search journal entries',
        on: { input: (e) => { this.filter = e.target.value; this.renderList(); } },
      });
      this.list = el('div.journal-list');
      const top = el('div.row');
      if (isGM()) top.append(el('button.primary', { text: '+ New entry', on: { click: () => this.createEntry() } }));
      top.append(search);
      panel.replaceChildren(top, this.list);
    }
    this.renderList();
  }

  renderList() {
    if (!this.list) return;
    const q = this.filter.trim().toLowerCase();
    const entries = Object.values(this.entries)
      .filter((e) => !q || e.name.toLowerCase().includes(q) || (this.access(e) !== 'limited' && e.content?.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const folders = new Map();
    for (const e of entries) {
      const f = e.folder?.trim() ?? '';
      if (!folders.has(f)) folders.set(f, []);
      folders.get(f).push(e);
    }
    const names = [...folders.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
    const out = [];
    for (const f of names) {
      const ul = el('ul.entity-list', {}, folders.get(f).map((e) => this.row(e)));
      out.push(f ? el('details.journal-folder', { open: true }, el('summary', { text: `📁 ${f}` }), ul) : ul);
    }
    if (!entries.length) {
      out.push(el('p.muted', { text: q ? 'No entries match.' : isGM() ? 'No journal entries yet.' : 'The GM hasn\'t shared any journal entries with you yet.' }));
    }
    this.list.replaceChildren(...out);
  }

  row(e) {
    let badge = null;
    if (isGM()) {
      const seen = Math.max(rank(e.access), ...Object.values(e.players ?? {}).map(rank));
      badge = seen ? el('span.badge', { text: e.access === 'none' ? 'some players' : e.access, title: 'Players can see this entry' }) : el('span.badge.muted', { text: 'hidden' });
    } else if (this.access(e) === 'owner') badge = el('span.badge', { text: 'yours' });
    return el('li.entity', {
      draggable: true,
      on: {
        click: () => this.open(e.id),
        dragstart: (ev) => ev.dataTransfer.setData('text/plain', `[[${e.name}]]`),
      },
    },
    e.img ? el('img.avatar', { src: e.img, alt: '' }) : el('span.avatar', { text: '📜' }),
    el('span.grow', { text: e.name }),
    badge);
  }

  async createEntry() {
    const folders = [...new Set(Object.values(this.entries).map((e) => e.folder).filter(Boolean))];
    const v = await formDialog({
      title: 'New journal entry',
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'folder', label: folders.length ? `Folder (e.g. ${folders.slice(0, 3).join(', ')})` : 'Folder (optional)' },
      ],
      submit: 'Create',
    });
    if (!v) return;
    const id = newId();
    this.api.op({ op: 'journal_create', entry: { id, name: v.name.trim(), folder: v.folder.trim(), content: '', img: null, access: 'none', players: {} } },
      (why) => toast(why, 'error'));
    this.open(id, { edit: true });
  }

  // ------------------------------------------------------------------ entry window

  open(id, { edit = false } = {}) {
    let o = this.open_.get(id);
    if (!o) {
      const win = openWindow({ id: `journal-${id}`, title: this.entry(id)?.name ?? 'Journal', width: 560 });
      win.el.classList.add('journal-window');
      o = { win, editing: false };
      this.open_.set(id, o);
      win.onClose(() => this.open_.delete(id));
    } else {
      openWindow({ id: `journal-${id}` }); // brings it to the front
    }
    if (edit) o.editing = true;
    this.renderWindow(id);
    return o.win;
  }

  renderWindow(id) {
    const o = this.open_.get(id);
    if (!o) return;
    const e = this.entry(id);
    const { win } = o;
    o.loaded = !!e;
    if (!e) { win.body.replaceChildren(el('p.muted', { text: 'Loading…' })); return; }
    win.setTitle(e.name);
    if (o.editing && this.access(e) === 'owner') { this.renderEditor(id, o); return; }
    o.editing = false;

    const level = this.access(e);
    const actions = el('div.row.journal-actions');
    if (level === 'owner') actions.append(el('button', { text: '✎ Edit', on: { click: () => { o.editing = true; this.renderWindow(id); } } }));
    if (isGM()) {
      actions.append(
        el('button', { text: '👁 Show to players', on: { click: () => this.show(id) } }),
        el('button', { text: '🔒 Access', on: { click: () => this.editAccess(id) } }),
        this.api.collections?.addButton('journal', () => this.entry(id)) ?? '',
        el('span.grow'),
        el('button.danger', { text: 'Delete', on: { click: () => this.remove(id) } }),
      );
    }
    const root = el('article.journal-text');
    root.append(el('h1', { text: e.name }));
    if (e.img) root.append(el('img.journal-img', { src: e.img, alt: '' }));
    if (level === 'limited') {
      root.append(el('p.muted', { text: 'You can see this entry\'s name and image, but not its text.' }));
    } else if (e.content?.trim()) {
      root.append(renderMarkdown(e.content, {
        onLink: (name) => this.follow(name),
        onRoll: (formula) => this.api.roll(formula, { flavor: e.name }),
        resolves: (name) => !!(this.byName(name) || this.actorByName(name)),
      }));
    } else {
      root.append(el('p.muted', { text: level === 'owner' ? 'This entry is empty. Press Edit to write it.' : 'This entry is empty.' }));
    }
    win.body.replaceChildren(...(actions.childElementCount ? [actions] : []), root);
    hooks.emit('journal:render', root, e, this.api);
  }

  renderEditor(id, o) {
    const e = this.entry(id);
    const name = el('input', { value: e.name, required: true });
    const folder = el('input', { value: e.folder ?? '', placeholder: 'none' });
    const img = el('input', { value: e.img ?? '', placeholder: 'https://… or upload' });
    const text = el('textarea.journal-source', { rows: 18, spellcheck: true });
    text.value = e.content ?? '';
    const preview = el('div.journal-text.journal-preview', { hidden: true });
    const previewBtn = el('button', {
      type: 'button', text: 'Preview',
      on: {
        click: () => {
          const showing = !preview.hidden;
          preview.hidden = showing;
          text.hidden = !showing;
          previewBtn.textContent = showing ? 'Preview' : 'Write';
          if (!showing) preview.replaceChildren(renderMarkdown(text.value, { resolves: (n) => !!(this.byName(n) || this.actorByName(n)) }));
        },
      },
    });
    const imgRow = el('div.row', {}, el('label.grow', {}, 'Image', img));
    if (isGM()) {
      const file = el('input', { type: 'file', accept: 'image/*', hidden: true, on: { change: async () => {
        if (!file.files[0]) return;
        try { img.value = await this.api.upload(file.files[0]); } catch (err) { toast(`Upload failed: ${err.message ?? err}`, 'error'); }
      } } });
      imgRow.append(file, el('button', { type: 'button', text: 'Upload…', on: { click: () => file.click() } }));
    }
    const form = el('form.form', {
      on: {
        submit: (ev) => {
          ev.preventDefault();
          const patch = {
            name: name.value.trim() || e.name,
            folder: folder.value.trim(),
            img: img.value.trim() || null,
            content: text.value,
          };
          this.api.op({ op: 'journal_update', id, patch }, (why) => toast(why, 'error'));
          o.editing = false;
          this.renderWindow(id);
        },
        keydown: (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); form.requestSubmit(); } },
      },
    },
    el('div.row', {}, el('label.grow', {}, 'Name', name), el('label', {}, 'Folder', folder)),
    imgRow,
    el('div.row', {}, el('span.grow.muted.small', { text: 'Markdown: # heading, **bold**, *italic*, - list, > quote, [[Entry name]] links, [[/r 1d20]] rolls' }), previewBtn),
    text, preview,
    el('div.row', {},
      el('span.grow'),
      el('button', { type: 'button', text: 'Cancel', on: { click: () => { o.editing = false; this.renderWindow(id); } } }),
      el('button.primary', { type: 'submit', text: 'Save' })));
    o.win.body.replaceChildren(form);
    text.focus();
  }

  actorByName(name) {
    const n = name.trim().toLowerCase();
    return Object.values(store.world?.actors ?? {}).find((a) => a.name.trim().toLowerCase() === n) ?? null;
  }

  /** Follow a [[Name]] link: a journal entry, else an actor. */
  follow(name) {
    const e = this.byName(name);
    if (e) { this.open(e.id); return; }
    const a = this.actorByName(name);
    if (a) { this.api.sheets.open(a.id); return; }
    toast(`Nothing called "${name}" that you can see.`);
  }

  // ------------------------------------------------------------------ GM actions

  /** Pop the entry up for every player who can see it (offering to share it first). */
  show(id) {
    const e = this.entry(id);
    if (!e) return;
    const anyone = rank(e.access) > 0 || Object.values(e.players ?? {}).some((a) => rank(a) > 0);
    if (!anyone) {
      if (!confirm(`Players can't see "${e.name}" yet. Let every player read it, and show it to them?`)) return;
      this.api.op({ op: 'journal_update', id, patch: { access: 'observer' } });
    }
    this.api.socket.emit('core.journal.show', { id });
    toast(`Showing "${e.name}" to players.`);
  }

  receiveShow({ id } = {}) {
    const e = this.entry(id);
    if (!e) return; // not shared with this player
    this.open(id);
    toast(`The GM shows you "${e.name}".`);
  }

  async editAccess(id) {
    const e = this.entry(id);
    if (!e) return;
    const players = Object.values(store.world.users).filter((u) => u.role !== 'gm').sort((a, b) => a.name.localeCompare(b.name));
    const opts = Object.entries(ACCESS_LABELS);
    const v = await formDialog({
      title: `Who can see "${e.name}"`,
      fields: [
        { name: 'access', label: 'All players', type: 'select', options: opts, value: e.access ?? 'none' },
        ...players.map((u) => ({
          name: `p_${u.id}`, label: u.name, type: 'select',
          options: [['', 'Same as all players'], ...opts], value: e.players?.[u.id] ?? '',
        })),
      ],
    });
    if (!v || !this.entry(id)) return;
    const patch = { access: v.access, players: {} };
    for (const u of players) patch.players[u.id] = v[`p_${u.id}`] || null;
    this.api.op({ op: 'journal_update', id, patch }, (why) => toast(why, 'error'));
  }

  remove(id) {
    const e = this.entry(id);
    if (!e || !confirm(`Delete the journal entry "${e.name}"? This can't be undone.`)) return;
    this.api.op({ op: 'journal_delete', id }, (why) => toast(why, 'error'));
  }

  // ------------------------------------------------------------------ sync

  onOp(op) {
    if (!op.op.startsWith('journal_') && op.op !== 'user_upsert' && op.op !== 'actor_create' && op.op !== 'actor_delete') return;
    const id = op.entry?.id ?? op.id;
    if (op.op === 'journal_delete') {
      this.open_.get(id)?.win.close();
    }
    // Re-render open entries: this one changed, or a name that links point at did.
    for (const [wid, o] of this.open_) if (!o.editing || !o.loaded) this.renderWindow(wid);
    this.renderList();
  }
}
