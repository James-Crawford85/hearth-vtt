// Shared bits for sidebar directories of GM-shared documents (items, tables):
// folder grouping, access badges and the "who can see this" dialog.
// Access levels work as for journal entries (see journal.js).

import { store, isGM } from './store.js';
import { el, toast, formDialog } from './ui.js';
import { ACCESS_LABELS } from './journal.js';

const LEVELS = ['none', 'limited', 'observer', 'owner'];
const rank = (a) => Math.max(0, LEVELS.indexOf(a ?? 'none'));

/** This user's access to a document: 'none' | 'limited' | 'observer' | 'owner'. */
export function accessOf(doc) {
  if (!doc) return 'none';
  if (isGM()) return 'owner';
  return LEVELS[Math.max(rank(doc.access), rank(doc.players?.[store.user.id]))];
}

export function atLeast(doc, level) { return rank(accessOf(doc)) >= rank(level); }

/** GM badge: who can see it. */
export function accessBadge(doc) {
  if (!isGM()) return null;
  const seen = Math.max(rank(doc.access), ...Object.values(doc.players ?? {}).map(rank));
  return seen
    ? el('span.badge', { text: doc.access === 'none' ? 'some players' : doc.access, title: 'Players can see this' })
    : el('span.badge.muted', { text: 'hidden' });
}

/** Entries grouped into collapsible folders (no folder last), each made by `row(entry)`. */
export function folderList(entries, row) {
  const folders = new Map();
  for (const e of entries) {
    const f = e.folder?.trim() ?? '';
    if (!folders.has(f)) folders.set(f, []);
    folders.get(f).push(e);
  }
  const names = [...folders.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  return names.map((f) => {
    const ul = el('ul.entity-list', {}, folders.get(f).map(row));
    return f ? el('details.journal-folder', { open: true }, el('summary', { text: `📁 ${f}` }), ul) : ul;
  });
}

/** A directory panel: buttons on top, a search box, and a list rebuilt by `renderList(query)`. */
export function directoryPanel(panel, state, { buttons = [], placeholder, renderList }) {
  if (!state.list || !panel.contains(state.list)) {
    state.query ??= '';
    const search = el('input', {
      type: 'search', placeholder, value: state.query, 'aria-label': placeholder,
      on: { input: (e) => { state.query = e.target.value; state.list.replaceChildren(...renderList(state.query.trim().toLowerCase())); } },
    });
    state.list = el('div.journal-list');
    panel.replaceChildren(el('div.row', {}, ...buttons, search), state.list);
  }
  state.list.replaceChildren(...renderList(state.query.trim().toLowerCase()));
}

/** GM dialog: access for all players and per player. `send(patch)` applies it. */
export async function editAccess(title, doc, send) {
  const players = Object.values(store.world.users).filter((u) => u.role !== 'gm').sort((a, b) => a.name.localeCompare(b.name));
  const opts = Object.entries(ACCESS_LABELS);
  const v = await formDialog({
    title,
    fields: [
      { name: 'access', label: 'All players', type: 'select', options: opts, value: doc.access ?? 'none' },
      ...players.map((u) => ({
        name: `p_${u.id}`, label: u.name, type: 'select',
        options: [['', 'Same as all players'], ...opts], value: doc.players?.[u.id] ?? '',
      })),
    ],
  });
  if (!v) return;
  const patch = { access: v.access, players: {} };
  for (const u of players) patch.players[u.id] = v[`p_${u.id}`] || null;
  send(patch);
}

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const rejectToast = (why) => toast(why, 'error');
