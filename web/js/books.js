// Books: the GM switches off books (the `source` a system's content names) for this world.
// Players then aren't offered anything from them; the server leaves them out of collections
// and refuses level-up picks from them. The GM still sees everything, marked.
import { el, openWindow } from './ui.js';
import { store, getPath } from './store.js';

/** The books switched off in this world (lower case, for comparing). */
export function offBooks() {
  return (getPath(store.world?.settings ?? {}, 'core.books.off') ?? []).map((b) => String(b).trim().toLowerCase()).filter(Boolean);
}

/** The book a document is from, if it's switched off in this world. */
export function offBookOf(doc) {
  const src = String(doc?.data?.source ?? '').trim();
  return src && offBooks().includes(src.toLowerCase()) ? src : null;
}

/** GM: the Books window. */
export async function openBooksSettings(api) {
  const win = openWindow({ id: 'books-settings', title: 'Books in this world', width: 480 });
  win.body.replaceChildren(el('p.muted', { text: 'Loading…' }));
  let books = [];
  try {
    const res = await fetch('/api/books', { headers: { 'x-hearth-session': api.session ?? '' } });
    if (!res.ok) throw new Error(await res.text());
    books = (await res.json()).books ?? [];
  } catch (e) {
    win.body.replaceChildren(el('p.error-text', { text: `Couldn't list the books: ${e.message}` }));
    return;
  }
  if (!books.length) {
    win.body.replaceChildren(el('p.muted', { text: "This world's system doesn't say which book its content comes from, so there's nothing to choose." }));
    return;
  }
  books.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const off = new Set(books.filter((b) => b.off).map((b) => b.name));
  const save = () => api.settings.set('core', 'books', { off: [...off].sort() });
  const draw = () => {
    const boxes = books.map((b) => el('label.check', {}, el('input', {
      type: 'checkbox', checked: !off.has(b.name),
      on: { change: (e) => { if (e.target.checked) off.delete(b.name); else off.add(b.name); save(); draw(); } },
    }), `${b.name} `, el('span.muted.small', { text: `(${b.count})` })));
    win.body.replaceChildren(
      el('p.muted.small', { text: "Untick a book to leave it out of this world. Players aren't offered anything from it: not when they level up, add things, browse the collections or look things up. You still see everything, marked as off, so you can hand something out anyway. Nothing already on a character is taken away. Content that doesn't name a book is always on." }),
      el('div.row', {},
        el('button', { type: 'button', text: 'All on', on: { click: () => { off.clear(); save(); draw(); } } }),
        el('span.grow'),
        el('span.muted.small', { text: `${books.length - off.size} of ${books.length} on` })),
      el('div.books-list', {}, ...boxes));
  };
  draw();
}

