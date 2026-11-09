// Macros and the hotbar.
//
// A chat macro sends each line as chat (so `/r 1d20 + 5` rolls). A script
// macro is JavaScript run in the clicking user's browser with the client API
// as `hearth` (and `token` / `actor` for the first selected token). Only the
// GM can write script macros or share macros with players; players make
// chat macros of their own.
//
// The hotbar along the bottom holds ten macros per user: drag a macro onto a
// slot, click or press 1–0 to run it, right-click a slot to clear it.

import { hooks } from './hooks.js';
import { store, isGM } from './store.js';
import { el, toast, openWindow } from './ui.js';
import { folderList, directoryPanel, newId, rejectToast } from './directory.js';

export const MACRO_MIME = 'application/x-hearth-macro';
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

export class Macros {
  constructor(api) {
    this.api = api;
    this.panelState = {};
    this.windows = new Map();
    this.bar = el('nav.hotbar', { 'aria-label': 'Macro hotbar' });
    document.getElementById('app').append(this.bar);
    hooks.on('op', (op) => this.onOp(op));
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  get all() { return store.world?.macros ?? {}; }
  canEdit(m) { return isGM() || (m.author === store.user?.id && m.kind === 'chat'); }

  // ------------------------------------------------------------------ running

  async run(id) {
    const m = this.all[id];
    if (!m) return;
    if (m.kind === 'script') {
      const token = [...(this.api.board?.selected ?? [])].map((t) => this.api.board.scene?.tokens[t]).find(Boolean) ?? null;
      const actor = token?.actor_id ? store.world.actors[token.actor_id] ?? null : null;
      try {
        await new AsyncFunction('hearth', 'token', 'actor', m.command)(this.api, token, actor);
      } catch (err) {
        console.error(`Macro "${m.name}" failed`, err);
        toast(`Macro "${m.name}" failed: ${err.message ?? err}`, 'error');
      }
      return;
    }
    for (const line of m.command.split('\n')) if (line.trim()) this.api.chat(line.trim());
  }

  // ------------------------------------------------------------------ panel

  renderPanel(panel) {
    directoryPanel(panel, this.panelState, {
      buttons: [el('button.primary', { text: '+ New macro', on: { click: () => this.create() } })],
      placeholder: 'Search macros',
      renderList: (q) => {
        const ms = Object.values(this.all).filter((m) => !q || m.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
        // Group: mine, shared by the GM, and (for the GM) each player's.
        const groupOf = (m) => (m.author === store.user.id ? '' : m.shared ? 'Shared' : `${store.world.users[m.author]?.name ?? 'Someone'}'s macros`);
        const out = folderList(ms.map((m) => ({ ...m, folder: groupOf(m) })), (m) => this.row(this.all[m.id]));
        if (!ms.length) out.push(el('p.muted', { text: q ? 'No macros match.' : 'No macros yet. A chat macro can be as simple as /r 1d20 + 5.' }));
        else out.push(el('p.hint.muted', { text: 'Drag a macro onto the hotbar at the bottom of the screen.' }));
        return out;
      },
    });
  }

  row(m) {
    return el('li.entity', {
      draggable: true,
      on: {
        click: () => (this.canEdit(m) ? this.open(m.id) : this.run(m.id)),
        dragstart: (e) => e.dataTransfer.setData(MACRO_MIME, m.id),
      },
    },
    m.img ? el('img.avatar', { src: m.img, alt: '' }) : el('span.avatar', { text: m.kind === 'script' ? '⚙' : '💬' }),
    el('span.grow', {}, el('span', { text: m.name }), el('small.muted', { text: m.kind === 'script' ? ' script' : ' chat' })),
    isGM() && m.shared ? el('span.badge', { text: 'shared' }) : null,
    el('button.icon', { title: `Run ${m.name}`, text: '▶', on: { click: (e) => { e.stopPropagation(); this.run(m.id); } } }));
  }

  create() {
    const id = newId();
    this.api.op({ op: 'macro_create', macro: { id, name: 'New macro', kind: 'chat', command: '', img: null, author: '', shared: false } }, rejectToast);
    this.open(id);
  }

  // ------------------------------------------------------------------ editor

  open(id) {
    let o = this.windows.get(id);
    if (o) { openWindow({ id: `macro-${id}` }); return; }
    const win = openWindow({ id: `macro-${id}`, title: 'Macro', width: 460 });
    o = { win, loaded: false };
    this.windows.set(id, o);
    win.onClose(() => this.windows.delete(id));
    this.render(id);
  }

  render(id) {
    const o = this.windows.get(id);
    if (!o) return;
    const m = this.all[id];
    if (!m) { o.win.body.replaceChildren(el('p.muted', { text: 'Loading…' })); return; }
    if (o.loaded) return; // the form is up; don't overwrite what's being typed
    o.loaded = true;
    o.win.setTitle(m.name);
    const gm = isGM();
    const name = el('input', { value: m.name, required: true });
    const kind = el('select', {}, el('option', { value: 'chat', text: 'Chat: each line is sent as chat (/r rolls)', selected: m.kind === 'chat' }),
      el('option', { value: 'script', text: 'Script: JavaScript with the hearth API', selected: m.kind === 'script' }));
    const command = el('textarea.journal-source', { rows: 10, spellcheck: false });
    command.value = m.command;
    const img = el('input', { value: m.img ?? '', placeholder: 'optional image URL' });
    const shared = el('input', { type: 'checkbox', checked: m.shared });
    const hint = el('p.muted.small');
    const setHint = () => {
      hint.textContent = kind.value === 'script'
        ? 'Runs in the browser of whoever clicks it. Available: hearth (the client API), token and actor (the first selected token).'
        : 'Example: /r 1d20 + 5 # Perception — or plain text, /w Name message, /gmr 1d6.';
    };
    kind.addEventListener('change', setHint);
    setHint();
    const form = el('form.form', {
      on: {
        submit: (e) => {
          e.preventDefault();
          const patch = { name: name.value.trim() || m.name, command: command.value, img: img.value.trim() || null };
          if (gm) Object.assign(patch, { kind: kind.value, shared: shared.checked });
          this.api.op({ op: 'macro_update', id, patch }, rejectToast);
          toast('Macro saved.');
        },
      },
    },
    el('label', {}, 'Name', name),
    gm ? el('label', {}, 'Type', kind) : null,
    command, hint,
    el('label', {}, 'Image', img),
    gm ? el('label.check', {}, shared, 'Share with all players') : null,
    el('div.row', {},
      el('button', { type: 'button', text: '▶ Run', on: { click: () => this.run(id) } }),
      el('button.danger', { type: 'button', text: 'Delete', on: { click: () => { if (confirm(`Delete the macro "${m.name}"?`)) this.api.op({ op: 'macro_delete', id }, rejectToast); } } }),
      el('span.grow'),
      el('button.primary', { type: 'submit', text: 'Save' })));
    o.win.body.replaceChildren(form);
    name.select();
  }

  // ------------------------------------------------------------------ hotbar

  slots() { return store.world?.hotbars?.[store.user?.id] ?? {}; }

  renderBar() {
    const slots = this.slots();
    const buttons = [];
    for (let n = 1; n <= 10; n++) {
      const m = this.all[slots[n]];
      const key = n === 10 ? '0' : String(n);
      const b = el('button.hotbar-slot', {
        title: m ? `${m.name} (${key})` : `Empty slot ${key}: drag a macro here`,
        class: m ? 'hotbar-slot' : 'hotbar-slot empty',
        on: {
          click: () => m && this.run(m.id),
          contextmenu: (e) => { e.preventDefault(); if (m) this.setSlot(n, null); },
          dragover: (e) => { if (e.dataTransfer.types.includes(MACRO_MIME)) { e.preventDefault(); b.classList.add('drop'); } },
          dragleave: () => b.classList.remove('drop'),
          drop: (e) => {
            b.classList.remove('drop');
            const id = e.dataTransfer.getData(MACRO_MIME);
            if (!id) return;
            e.preventDefault();
            // Moving from another slot empties that one.
            for (const [s, mid] of Object.entries(slots)) if (mid === id && Number(s) !== n) this.setSlot(Number(s), null);
            this.setSlot(n, id);
          },
          dragstart: (e) => { if (m) e.dataTransfer.setData(MACRO_MIME, m.id); },
        },
        draggable: !!m,
      },
      el('span.hotbar-key', { text: key }),
      m ? (m.img ? el('img', { src: m.img, alt: '' }) : el('span.hotbar-name', { text: m.name })) : null);
      buttons.push(b);
    }
    this.bar.replaceChildren(...buttons);
  }

  setSlot(slot, macroId) {
    this.api.op({ op: 'hotbar_set', user_id: store.user.id, slot, macro_id: macroId }, rejectToast);
  }

  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !/^[0-9]$/.test(e.key)) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (!store.world || document.getElementById('app')?.hidden) return;
    const n = e.key === '0' ? 10 : Number(e.key);
    const id = this.slots()[n];
    if (id && this.all[id]) { e.preventDefault(); this.run(id); }
  }

  onOp(op) {
    if (op.op.startsWith('macro_')) {
      const id = op.macro?.id ?? op.id;
      if (op.op === 'macro_delete') this.windows.get(id)?.win.close();
      else if (op.op === 'macro_create' || !this.windows.get(id)?.loaded) this.render(id);
      else if (this.windows.get(id)) this.windows.get(id).win.setTitle(this.all[id]?.name ?? 'Macro');
      if (this.panelState.list) this.api.sidebar?.refresh('macros');
    }
    if (op.op.startsWith('macro_') || op.op === 'hotbar_set') this.renderBar();
  }
}
