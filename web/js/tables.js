// Rollable tables: a list of results with weights; rolling picks one with a
// die the size of the total weight. The server rolls, so nobody can fudge it,
// and posts the result to chat. Players can roll on tables the GM shares.

import { hooks } from './hooks.js';
import { store, isGM } from './store.js';
import { el, openWindow, formDialog } from './ui.js';
import { accessOf, atLeast, accessBadge, folderList, directoryPanel, editAccess, newId, rejectToast } from './directory.js';

export class Tables {
  constructor(api, conn) {
    this.api = api;
    this.conn = conn;
    this.panelState = {};
    this.windows = new Map(); // id → { win, editing }
    hooks.on('op', (op) => this.onOp(op));
  }

  get all() { return store.world?.tables ?? {}; }

  /** Roll on a table; the server posts the result to chat. */
  draw(id, { gmOnly = false } = {}) {
    this.conn.send({ type: 'draw_table', id, gm_only: gmOnly });
  }

  byName(name) {
    const n = name.trim().toLowerCase();
    return Object.values(this.all).find((t) => t.name.trim().toLowerCase() === n) ?? null;
  }

  // ------------------------------------------------------------------ panel

  renderPanel(panel) {
    const buttons = isGM() ? [el('button.primary', { text: '+ New table', on: { click: () => this.create() } })] : [];
    directoryPanel(panel, this.panelState, {
      buttons,
      placeholder: 'Search tables',
      renderList: (q) => {
        const tables = Object.values(this.all).filter((t) => !q || t.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
        const out = folderList(tables, (t) => this.row(t));
        if (!tables.length) out.push(el('p.muted', { text: q ? 'No tables match.' : isGM() ? 'No tables yet.' : 'The GM hasn\'t shared any tables with you yet.' }));
        return out;
      },
    });
  }

  row(t) {
    const canRoll = atLeast(t, 'observer');
    return el('li.entity', { on: { click: () => this.open(t.id) } },
      el('span.avatar', { text: '🎲' }),
      el('span.grow', {}, el('span', { text: t.name }), canRoll ? el('small.muted', { text: ` ${t.results.length} results` }) : null),
      accessBadge(t),
      canRoll ? el('button.icon', { title: `Roll on ${t.name}`, text: '🎲', on: { click: (e) => { e.stopPropagation(); this.draw(t.id); } } }) : null);
  }

  async create() {
    const v = await formDialog({
      title: 'New rollable table',
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'folder', label: 'Folder (optional)' }],
      submit: 'Create',
    });
    if (!v) return;
    const id = newId();
    this.api.op({ op: 'table_create', table: { id, name: v.name.trim(), folder: v.folder.trim(), description: '', results: [], access: 'none', players: {} } }, rejectToast);
    this.open(id, { edit: true });
  }

  // ------------------------------------------------------------------ table window

  open(id, { edit = false } = {}) {
    let o = this.windows.get(id);
    if (o) openWindow({ id: `table-${id}` });
    else {
      const win = openWindow({ id: `table-${id}`, title: this.all[id]?.name ?? 'Table', width: 480 });
      o = { win, editing: false };
      this.windows.set(id, o);
      win.onClose(() => this.windows.delete(id));
    }
    if (edit) o.editing = true;
    this.render(id);
    return o.win;
  }

  render(id) {
    const o = this.windows.get(id);
    if (!o) return;
    const t = this.all[id];
    o.loaded = !!t;
    if (!t) { o.win.body.replaceChildren(el('p.muted', { text: 'Loading…' })); return; }
    o.win.setTitle(t.name);
    if (o.editing && isGM()) { this.renderEditor(id, o); return; }
    o.editing = false;

    const parts = [];
    const actions = el('div.row.journal-actions');
    if (atLeast(t, 'observer')) actions.append(el('button.primary', { text: '🎲 Roll', on: { click: () => this.draw(id) } }));
    if (isGM()) {
      actions.append(
        el('button', { text: 'Roll to GM only', on: { click: () => this.draw(id, { gmOnly: true }) } }),
        el('button', { text: '✎ Edit', on: { click: () => { o.editing = true; this.render(id); } } }),
        el('button', { text: '🔒 Access', on: { click: () => editAccess(`Who can see "${t.name}"`, t, (patch) => this.api.op({ op: 'table_update', id, patch }, rejectToast)) } }),
        el('span.grow'),
        el('button.danger', { text: 'Delete', on: { click: () => { if (confirm(`Delete the table "${t.name}"?`)) this.api.op({ op: 'table_delete', id }, rejectToast); } } }));
    }
    if (actions.childElementCount) parts.push(actions);
    if (accessOf(t) === 'limited') {
      parts.push(el('p.muted', { text: 'You can see this table\'s name only.' }));
    } else {
      if (t.description) parts.push(el('p', { text: t.description }));
      const total = t.results.reduce((s, r) => s + (r.weight ?? 1), 0);
      if (!t.results.length) parts.push(el('p.muted', { text: isGM() ? 'No results yet. Press Edit to add some.' : 'This table is empty.' }));
      else {
        let lo = 1;
        const rows = t.results.map((r) => {
          const w = r.weight ?? 1;
          const range = w === 0 ? '—' : w === 1 ? `${lo}` : `${lo}–${lo + w - 1}`;
          lo += w;
          return el('tr', {}, el('td.range', { text: range }), el('td', { text: r.text }));
        });
        parts.push(el('p.muted.small', { text: `Rolls 1d${total}.` }), el('table.roll-table', {}, el('tbody', {}, ...rows)));
      }
    }
    o.win.body.replaceChildren(...parts);
  }

  renderEditor(id, o) {
    const t = this.all[id];
    const name = el('input', { value: t.name, required: true });
    const folder = el('input', { value: t.folder ?? '', placeholder: 'none' });
    const desc = el('input', { value: t.description ?? '', placeholder: 'optional' });
    const body = el('tbody');
    const addRow = (r = { text: '', weight: 1 }) => {
      const tr = el('tr', {},
        el('td', {}, el('input.weight', { type: 'number', min: 0, step: 1, value: r.weight ?? 1, 'aria-label': 'Weight' })),
        el('td', {}, el('input.result', { value: r.text, placeholder: 'Result', 'aria-label': 'Result' })),
        el('td', {}, el('button.icon', { type: 'button', title: 'Remove', text: '✕', on: { click: () => tr.remove() } })));
      body.append(tr);
      return tr;
    };
    t.results.forEach((r) => addRow(r));
    const bulk = el('textarea', { rows: 4, placeholder: 'Paste results here, one per line, then press Add lines' });
    const form = el('form.form', {
      on: {
        submit: (e) => {
          e.preventDefault();
          const results = [...body.querySelectorAll('tr')]
            .map((tr) => ({ text: tr.querySelector('.result').value.trim(), weight: Math.max(0, Math.round(Number(tr.querySelector('.weight').value) || 0)) }))
            .filter((r) => r.text);
          this.api.op({ op: 'table_update', id, patch: { name: name.value.trim() || t.name, folder: folder.value.trim(), description: desc.value.trim(), results } }, rejectToast);
          o.editing = false;
          this.render(id);
        },
      },
    },
    el('div.row', {}, el('label.grow', {}, 'Name', name), el('label', {}, 'Folder', folder)),
    el('label', {}, 'Description', desc),
    el('p.muted.small', { text: 'Weight = how many numbers on the die a result gets (0 = never).' }),
    el('table.roll-table.editing', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Weight' }), el('th', { text: 'Result' }), el('th'))), body),
    el('div.row', {}, el('button', { type: 'button', text: '+ Result', on: { click: () => addRow().querySelector('.result').focus() } })),
    bulk,
    el('div.row', {}, el('button', {
      type: 'button', text: 'Add lines',
      on: { click: () => { for (const line of bulk.value.split('\n')) if (line.trim()) addRow({ text: line.trim(), weight: 1 }); bulk.value = ''; } },
    })),
    el('div.row', {}, el('span.grow'),
      el('button', { type: 'button', text: 'Cancel', on: { click: () => { o.editing = false; this.render(id); } } }),
      el('button.primary', { type: 'submit', text: 'Save' })));
    o.win.body.replaceChildren(form);
  }

  onOp(op) {
    if (!op.op.startsWith('table_')) return;
    const id = op.table?.id ?? op.id;
    if (op.op === 'table_delete') this.windows.get(id)?.win.close();
    else {
      const o = this.windows.get(id);
      if (o && (!o.editing || !o.loaded)) this.render(id);
    }
    if (this.panelState.list) this.api.sidebar?.refresh('tables');
  }
}
