// An open journal: a book on the desk, turned page by page, and written in
// right there. Two pages side by side (one on a narrow screen); each page is
// parchment with flowing text (Markdown underneath, but nobody has to see it),
// pictures set into the text or loose on the page, stamps and damage.
//
// Pages are saved one at a time ({ book: { pages: { id: … } } }), so people
// writing on different pages never overwrite each other.

import { hooks } from './hooks.js';
import { store, isGM } from './store.js';
import { el, toast, openWindow } from './ui.js';
import { renderMarkdown, safeUrl } from './markdown.js';
import { MARKS, MASKS, LOOKS, FONTS, markSvg, dressPicture, seeded } from './journal-art.js';
import { coverEl, coverOf, newId, localFont } from './journal.js';

const PAGE_W = 440;
const PAGE_H = 620;
const GUTTER = 8;
const TURN_MS = 700;
const AT_KEY = (id) => `hearth.journal.at.${id}`;
const PLACES = { left: 'In the text, on the left', right: 'In the text, on the right', full: 'Across the page', loose: 'Loose on the page (drag it anywhere)' };
const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'PRE', 'SECTION', 'ARTICLE']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fontOf = (key) => (FONTS[key] ?? FONTS.book)[1];

// ------------------------------------------------------------------ Markdown ↔ page

/** What an inline picture's alt text says: "left torn sepia" → { place, mask, look }. */
function pictureOpts(alt) {
  const out = { place: 'full', mask: 'none', look: 'none' };
  for (const w of String(alt ?? '').toLowerCase().split(/\s+/)) {
    if (w in PLACES && w !== 'loose') out.place = w;
    else if (w in MASKS) out.mask = w;
    else if (w in LOOKS) out.look = w;
  }
  return out;
}
const pictureAlt = ({ place, mask, look }) => [place, mask !== 'none' && mask, look !== 'none' && look].filter(Boolean).join(' ');

function dressInline(img) {
  const o = pictureOpts(img.getAttribute('alt'));
  img.classList.add('jb-pic', `jb-place-${o.place}`);
  dressPicture(img, { mask: o.mask, look: o.look, seed: img.getAttribute('src') });
}

function imgMarkdown(img) {
  const src = img.getAttribute('src') ?? '';
  return safeUrl(src) ? `![${img.getAttribute('alt') ?? ''}](${src.replace(/[ )]/g, encodeURIComponent)})` : '';
}

/** Move spaces outside a mark, so "** bold **" never happens. */
const marked = (inner, m) => {
  const a = inner.match(/^\s*/)[0], b = inner.match(/\s*$/)[0], core = inner.trim();
  return core ? `${a}${m}${core}${m}${b}` : inner;
};

function inline(nodes) {
  let s = '';
  for (const n of nodes) {
    if (n.nodeType === 3) { s += n.nodeValue.replace(/ /g, ' '); continue; }
    if (n.nodeType !== 1) continue;
    const t = n.tagName;
    if (n.dataset?.wiki) { s += `[[${n.dataset.wiki}]]`; continue; }
    if (t === 'BR') { s += '\n'; continue; }
    if (t === 'IMG') { s += imgMarkdown(n); continue; }
    const inner = inline(n.childNodes);
    if (t === 'B' || t === 'STRONG') s += marked(inner, '**');
    else if (t === 'I' || t === 'EM') s += marked(inner, '*');
    else if (t === 'CODE') s += inner ? `\`${inner}\`` : '';
    else if (t === 'A' && n.getAttribute('href') !== '#' && safeUrl(n.getAttribute('href'))) s += `[${inner}](${n.getAttribute('href')})`;
    else if (BLOCK.has(t)) s += (s && !s.endsWith('\n') ? '\n' : '') + inner + '\n';
    else s += inner;
  }
  return s;
}

/** The page as it's been written (contenteditable DOM) back to Markdown. */
export function toMarkdown(root) {
  const out = [];
  const tidy = (s) => s.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l || (i && a[i - 1])).join('\n').trim();
  const push = (s) => { s = tidy(s); if (s) out.push(s); };
  let loose = [];
  const flush = () => { if (loose.length) push(inline(loose)); loose = []; };
  for (const n of root.childNodes) {
    const t = n.nodeType === 1 ? n.tagName : null;
    if (!t || !BLOCK.has(t)) {
      if (t === 'BR' && loose.length) { flush(); continue; }
      loose.push(n);
      continue;
    }
    flush();
    if (t === 'HR') out.push('---');
    else if (/^H[1-6]$/.test(t)) { const s = tidy(inline(n.childNodes)).replace(/\n/g, ' '); if (s) out.push(`${'#'.repeat(clamp(Number(t[1]) - 1, 1, 4))} ${s}`); }
    else if (t === 'UL' || t === 'OL') {
      const items = [...n.children].filter((li) => li.tagName === 'LI').map((li, i) => `${t === 'UL' ? '-' : `${i + 1}.`} ${tidy(inline(li.childNodes)).replace(/\n/g, ' ')}`).filter((l) => !/^(-|\d+\.)\s*$/.test(l));
      if (items.length) out.push(items.join('\n'));
    } else if (t === 'BLOCKQUOTE') { const s = tidy(inline(n.childNodes)); if (s) out.push(s.split('\n').map((l) => `> ${l}`).join('\n')); }
    else if ([...n.children].some((c) => BLOCK.has(c.tagName))) out.push(...toMarkdown(n).split(/\n{2,}/).filter(Boolean));
    else push(inline(n.childNodes));
  }
  flush();
  return out.join('\n\n');
}

// ------------------------------------------------------------------ measuring and splitting

let measurer = null;
/** Split Markdown into page-sized pieces (at paragraph breaks), as it would lay out in `font`. */
export function paginate(text, font = 'book') {
  const blocks = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return [''];
  if (!measurer) {
    measurer = el('div.jb-page.jb-measure', { 'aria-hidden': 'true' }, el('div.jb-text'));
    document.body.append(measurer);
  }
  measurer.style.setProperty('--jb-font', fontOf(font));
  const box = measurer.firstChild;
  const fits = (md) => {
    box.replaceChildren(renderMarkdown(md));
    box.querySelectorAll('img').forEach((img) => { dressInline(img); img.style.height = '160px'; });
    return box.scrollHeight <= box.clientHeight + 1;
  };
  const pages = [];
  let cur = [];
  for (const b of blocks) {
    if (fits([...cur, b].join('\n\n'))) { cur.push(b); continue; }
    if (cur.length) pages.push(cur.join('\n\n'));
    cur = [b]; // a block too big for any page stays whole (that page scrolls)
  }
  if (cur.length) pages.push(cur.join('\n\n'));
  return pages;
}

// ------------------------------------------------------------------ the book window

export class BookView {
  constructor(journal, id) {
    this.j = journal;
    this.api = journal.api;
    this.id = id;
    this.spread = 0;
    this.editing = null;      // id of the page being written
    this.selected = null;     // { kind: 'item', pid, iid } | { kind: 'inline', img }
    this.turning = false;
    this.dirty = false;       // something changed while we were busy
    this.pendingEdit = null;
    this.closeFns = [];
    const e = this.entry;
    const w = Math.min(1180, innerWidth - 32);
    this.win = openWindow({ id: `journal-${id}`, title: e?.name ?? 'Journal', width: w, height: Math.min(820, innerHeight - 70) });
    this.win.el.classList.add('jb-window');
    this.win.onClose(() => {
      this.finishEdit();
      this.ro?.disconnect();
      if (this.trackRange) document.removeEventListener('selectionchange', this.trackRange);
      document.querySelector('.jb-stamp-menu')?.remove();
      this.closeFns.forEach((f) => f());
    });

    this.toolbar = el('div.jb-toolbar');
    this.itembar = el('div.jb-itembar', { hidden: true });
    this.book = el('div.jb-book');
    this.scaler = el('div.jb-scaler', {}, this.book);
    this.stage = el('div.jb-stage', { on: { pointerdown: (ev) => { if (ev.target === this.stage || ev.target === this.scaler) this.select(null); } } }, this.scaler);
    this.win.body.replaceChildren(el('div.jb-desk', {}, this.toolbar, this.itembar, this.stage));
    this.win.el.addEventListener('keydown', (ev) => this.key(ev));
    this.win.el.tabIndex = -1;
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.stage);

    // Open where this person left off.
    let at = null;
    try { at = localStorage.getItem(AT_KEY(id)); } catch { /* storage blocked */ }
    this.single = this.stage.clientWidth > 0 && this.stage.clientWidth < 720;
    if (at) this.goTo(at, { quiet: true });
    this.render({ opening: true });
  }

  get entry() { return this.j.entry(this.id); }
  onClose(fn) { this.closeFns.push(fn); }
  focus() { openWindow({ id: `journal-${this.id}` }); }
  close() { this.win.close(); }

  // ------------------------------------------------------------------ pages

  /** The pages in order. Old entries without a book become pages of their text. */
  pages() {
    const e = this.entry;
    if (!e) return [];
    const pages = e.book?.pages;
    if (pages && Object.keys(pages).length) {
      return Object.entries(pages).filter(([, p]) => p).map(([pid, p]) => ({ ...p, id: pid })).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id.localeCompare(b.id));
    }
    const text = `${e.img ? `![full](${e.img})\n\n` : ''}${e.content ?? ''}`;
    if (this.legacy?.text !== text) {
      this.legacy = { text, pages: paginate(text, 'book').map((t, i) => ({ id: `v${i + 1}`, sort: i + 1, author: e.author ?? null, font: 'book', text: t, items: {}, virtual: true })) };
    }
    return this.legacy.pages;
  }

  /** Turn an old entry into a real book (its pages saved), before anyone writes in it. */
  materialize() {
    const e = this.entry;
    if (!e || (e.book?.pages && Object.keys(e.book.pages).length)) return;
    const pages = {};
    for (const p of this.pages()) pages[p.id] = { sort: p.sort, author: p.author, font: p.font, text: p.text, items: {} };
    const book = { pages };
    if (!e.book?.cover) book.cover = coverOf(e);
    // Store it at once, so later page patches build on it.
    e.book = { ...(e.book ?? {}), ...book, pages };
    if (e.img) e.img = null;
    this.j.update(this.id, { book, img: null });
  }

  /** Save page changes ({ pid: patch | null }), keeping `content` in step with the pages. */
  savePages(changes) {
    this.materialize();
    const e = this.entry;
    if (!e) return;
    const book = e.book ??= {};
    const pages = book.pages ??= {};
    for (const [pid, patch] of Object.entries(changes)) {
      if (patch === null) delete pages[pid];
      else pages[pid] = mergeInto(pages[pid] ?? {}, patch);
    }
    const content = Object.values(pages).filter(Boolean).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map((p) => (p.text ?? '').trim()).filter(Boolean).join('\n\n---\n\n');
    e.content = content;
    this.j.update(this.id, { book: { pages: changes }, content });
  }

  pageIndex(pid) { return this.pages().findIndex((p) => p.id === pid); }

  /** Which spread a page is on. Two pages: the inside cover and page 1 first, then 2–3, 4–5… */
  spreadOf(i) { return this.single ? i : Math.floor((i + 1) / 2); }
  lastSpread() { const n = this.pages().length; return Math.max(0, this.spreadOf(n - 1)); }
  slots(s = this.spread) {
    const pages = this.pages();
    if (this.single) return [pages[s] ?? (this.j.canWrite(this.entry) ? 'add' : 'blank')];
    const left = s === 0 ? 'endpaper' : pages[2 * s - 1] ?? 'blank';
    const right = pages[2 * s] ?? (this.j.canWrite(this.entry) ? 'add' : 'blank');
    return [left, right];
  }
  currentPageId() {
    const s = this.slots().filter((x) => typeof x === 'object');
    return s[0]?.id ?? null;
  }

  goTo(pid, { quiet = false } = {}) {
    const i = this.pageIndex(pid);
    if (i < 0) return;
    this.spread = this.spreadOf(i);
    if (!quiet) this.render();
  }

  remember() {
    const pid = this.currentPageId();
    try { if (pid) localStorage.setItem(AT_KEY(this.id), pid); } catch { /* storage blocked */ }
  }

  // ------------------------------------------------------------------ drawing

  fit() {
    const single = this.stage.clientWidth < 720;
    if (single !== this.single) {
      const pid = this.currentPageId();
      this.single = single;
      if (pid) this.goTo(pid, { quiet: true });
      this.render();
      return;
    }
    const w = this.single ? PAGE_W : PAGE_W * 2 + GUTTER;
    const scale = Math.max(0.3, Math.min((this.stage.clientWidth - 24) / w, (this.stage.clientHeight - 24) / PAGE_H));
    this.book.style.transform = `scale(${scale})`;
    this.scaler.style.width = `${w * scale}px`;
    this.scaler.style.height = `${PAGE_H * scale}px`;
  }

  render({ opening = false } = {}) {
    const e = this.entry;
    if (!e) { this.book.replaceChildren(el('p.muted', { text: 'Loading…' })); return; }
    if (this.turning) { this.dirty = true; return; }
    this.win.setTitle(e.name);
    this.spread = clamp(this.spread, 0, this.lastSpread());
    this.drawToolbar();
    this.book.classList.toggle('single', this.single);
    this.book.style.width = `${this.single ? PAGE_W : PAGE_W * 2 + GUTTER}px`;
    this.book.style.setProperty('--leather', coverOf(e).color);
    if (this.j.access(e) === 'limited') {
      this.book.replaceChildren(el('div.jb-closed', {}, coverEl(e, { size: 'big' }), el('p.jb-closed-note', { text: 'You can see this journal\'s cover, but not what\'s inside.' })));
      this.fit();
      return;
    }
    const slots = this.slots();
    this.slotEls = slots.map((s, i) => el(`div.jb-slot.${this.single ? 'only' : i ? 'right' : 'left'}`, {}, this.slotEl(s, i)));
    this.book.replaceChildren(...this.slotEls, ...(this.single ? [] : [el('div.jb-spine', { 'aria-hidden': 'true' })]));
    this.fit();
    if (opening && this.spread === 0 && !this.single) this.openCover();
    this.drawItembar();
    this.remember();
  }

  /** One page slot: a page, the inside cover, an "add a page" page, or blank paper. */
  slotEl(s, side) {
    const e = this.entry;
    if (s === 'endpaper') {
      // The bookplate: its lines can be changed (or it can be left off) from the Cover dialog.
      const plate = e.book?.plate ?? {};
      if (plate.hidden) return el('div.jb-page.jb-endpaper');
      const top = plate.top ?? 'Ex libris';
      const bottom = plate.bottom ?? (e.author ? `kept by ${this.j.userName(e.author)}` : '');
      return el('div.jb-page.jb-endpaper', {},
        el('div.jb-bookplate', {},
          top ? el('small', { text: top }) : null,
          el('strong', { text: e.name }),
          bottom ? el('em', { text: bottom }) : null));
    }
    if (s === 'add') {
      return el('div.jb-page.jb-blank', {}, el('div.jb-paper'), el('button.jb-add-page', { on: { click: () => this.addPage() } }, el('span', { text: '+' }), el('span', { text: 'Add a page' })));
    }
    if (s === 'blank') return el('div.jb-page.jb-blank', {}, el('div.jb-paper'));
    return this.pageEl(s, side);
  }

  pageEl(p, side) {
    const e = this.entry;
    const pages = this.pages();
    const index = pages.findIndex((x) => x.id === p.id);
    const editing = this.editing === p.id;
    const canWrite = this.j.canWrite(e);
    const r = seeded(p.id);
    const page = el(`div.jb-page${editing ? '.editing' : ''}`, {
      'data-page': p.id,
      style: `--jb-font:${fontOf(p.font)};--jb-age:${clamp(Number(e.book?.age) || 0, 0, 1)};--px:${Math.floor(r() * 400)}px;--py:${Math.floor(r() * 400)}px;--tint:${(r() * 0.5).toFixed(2)}`,
      on: {
        dblclick: (ev) => { if (canWrite && !editing && !ev.target.closest('a,button')) this.startEdit(p.id); },
      },
    });
    page.append(el('div.jb-paper'));
    const opts = editing ? {} : {
      onLink: (name) => this.j.follow(name),
      onRoll: (formula) => this.api.roll(formula, { flavor: e.name }),
      resolves: (name) => !!(this.j.byName(name) || this.j.actorByName(name)),
    };
    const text = el('div.jb-text', { 'data-placeholder': editing ? 'Write here…' : '' }, renderMarkdown(p.text ?? '', opts));
    text.querySelectorAll('img').forEach((img) => dressInline(img));
    if (editing) this.makeEditable(text, p);
    page.append(text, this.itemsEl(p, editing));
    const signed = p.author && p.author !== e.author ? this.j.userName(p.author) : null;
    page.append(el('div.jb-foot', {}, signed ? el('span.jb-signed', { text: `— ${signed}` }) : el('span'), el('span.jb-num', { text: String(index + 1) })));
    page.append(el('div.jb-wear', { 'aria-hidden': 'true' }));
    if (canWrite && !editing) {
      page.append(el('button.jb-write', { title: 'Write on this page (or double-click it)', text: '✎ Write', on: { click: () => this.startEdit(p.id) } }));
    }
    hooks.emit('journal:render', text, e, this.api);
    return page;
  }

  itemsEl(p, editing) {
    const layer = el('div.jb-items');
    const items = Object.entries(p.items ?? {}).filter(([, it]) => it).sort((a, b) => (a[1].z ?? 0) - (b[1].z ?? 0));
    for (const [iid, it] of items) layer.append(this.itemEl(p, iid, it, editing));
    return layer;
  }

  itemEl(p, iid, it, editing) {
    const sel = this.selected?.kind === 'item' && this.selected.iid === iid;
    const node = el(`div.jb-item${editing ? '.editable' : ''}${sel ? '.selected' : ''}`, { 'data-item': iid });
    this.placeItem(node, it);
    if (it.kind === 'image') {
      const src = safeUrl(it.src);
      if (src) {
        const img = el('img.jb-pic', { src, alt: '', draggable: false });
        dressPicture(img, { mask: it.mask, look: it.look, seed: iid });
        node.append(img);
      }
    } else if (MARKS[it.kind]) {
      node.classList.add('jb-mark', `jb-mark-${it.kind}`, MARKS[it.kind].group === 'damage' ? 'jb-damage' : 'jb-decor');
      node.innerHTML = markSvg(it.kind, iid);
    }
    if (editing) {
      node.addEventListener('pointerdown', (ev) => this.dragItem(ev, p.id, iid, node, 'move'));
      if (it.kind !== 'tear') {
        const grip = el('span.jb-grip', { title: 'Drag to resize' });
        grip.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); this.dragItem(ev, p.id, iid, node, 'size'); });
        node.append(grip);
      }
    }
    return node;
  }

  placeItem(node, it) {
    if (it.kind === 'tear') {
      // A torn corner sits in its corner (c: 0 top right, 1 bottom right, 2 bottom left, 3 top left).
      const c = (it.corner ?? 0) % 4;
      const w = clamp(Number(it.w) || MARKS.tear.w, 0.08, 0.5);
      node.style.cssText = `width:${w * 100}%;aspect-ratio:1;${c === 0 || c === 3 ? 'top:0' : 'bottom:0'};${c < 2 ? 'right:0' : 'left:0'};transform:rotate(${c * 90}deg)`;
      return;
    }
    node.style.left = `${(Number(it.x) || 0) * 100}%`;
    node.style.top = `${(Number(it.y) || 0) * 100}%`;
    node.style.width = `${clamp(Number(it.w) || 0.3, 0.04, 1.2) * 100}%`;
    node.style.transform = `translate(-50%, -50%) rotate(${Number(it.rot) || 0}deg)`;
  }

  drawToolbar() {
    const e = this.entry;
    const pages = this.pages();
    const canWrite = this.j.canWrite(e);
    const btn = (text, title, fn, extra = {}) => el('button', { type: 'button', text, title, on: { click: fn, mousedown: (ev) => { if (this.editing) ev.preventDefault(); } }, ...extra });
    if (this.editing) { this.drawEditTools(); return; }
    if (this.j.access(e) === 'limited') {
      this.toolbar.replaceChildren(el('span.jb-where', { text: 'Only the cover' }));
      return;
    }
    const slots = this.slots().filter((s) => typeof s === 'object');
    const where = !pages.length ? 'No pages yet'
      : slots.length ? (slots.length === 2 ? `Pages ${this.pageIndex(slots[0].id) + 1}–${this.pageIndex(slots[1].id) + 1}` : `Page ${this.pageIndex(slots[0].id) + 1}`) + ` of ${pages.length}`
        : `${pages.length} page${pages.length === 1 ? '' : 's'}`;
    const items = [
      btn('◀', 'Previous page (←)', () => this.turn(-1), { disabled: this.spread <= 0 }),
      el('span.jb-where', { text: where }),
      btn('▶', 'Next page (→)', () => this.turn(1), { disabled: this.spread >= this.lastSpread() }),
    ];
    if (canWrite && this.j.access(e) !== 'limited') {
      items.push(el('span.jb-sep'),
        btn('✎ Write', 'Write on the page you\'re looking at', () => { const pid = this.writablePage(); if (pid) this.startEdit(pid); else this.addPage(); }),
        btn('+ Page', 'Add a page after these', () => this.addPage()));
    }
    items.push(el('span.grow'));
    if (this.j.canManage(e)) {
      items.push(btn('🎨 Cover', 'Change the title, cover and wear', () => this.j.editCover(this.id)),
        btn('👥 Sharing', 'Who can read it, and who can write in it', () => this.j.editAccess(this.id)));
    }
    if (isGM()) {
      items.push(btn('👁 Show', 'Pop this page up for players who can see the journal', () => this.j.show(this.id)));
      const add = this.api.collections?.addButton?.('journal', () => this.entry);
      if (add) items.push(add);
    }
    if (this.j.canManage(e)) items.push(btn('🗑', 'Throw this journal away', () => this.j.remove(this.id), { class: 'danger' }));
    this.toolbar.replaceChildren(...items);
  }

  writablePage() {
    const s = this.slots().filter((x) => typeof x === 'object');
    return s[s.length - 1]?.id ?? null;
  }

  // ------------------------------------------------------------------ turning pages

  key(ev) {
    if (this.editing || ev.target.closest('input,select,textarea,[contenteditable="true"]')) return;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown') { ev.preventDefault(); this.turn(1); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); this.turn(-1); }
  }

  turn(dir) {
    if (this.turning) return;
    this.finishEdit();
    const to = this.spread + dir;
    if (to < 0 || to > this.lastSpread()) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.single || reduce) {
      this.spread = to;
      this.render();
      if (!reduce) this.slotEls?.[0]?.firstChild?.classList.add(dir > 0 ? 'jb-in-next' : 'jb-in-prev');
      return;
    }
    const next = this.slots(to);
    const [oldLeft, oldRight] = this.slotEls;
    // The leaf: the page being turned, with the page behind it on its back.
    const front = dir > 0 ? oldRight.firstChild : oldLeft.firstChild;
    const back = this.slotEl(dir > 0 ? next[0] : next[1], dir > 0 ? 0 : 1);
    const leaf = el(`div.jb-leaf.${dir > 0 ? 'right' : 'left'}`, {}, el('div.jb-leaf-front', {}, front), el('div.jb-leaf-back', {}, back));
    // Underneath, the page that's revealed.
    if (dir > 0) oldRight.replaceChildren(this.slotEl(next[1], 1));
    else oldLeft.replaceChildren(this.slotEl(next[0], 0));
    this.book.append(leaf);
    this.turning = true;
    void leaf.offsetWidth;
    leaf.classList.add('turn');
    setTimeout(() => {
      this.turning = false;
      this.spread = to;
      this.render();
    }, TURN_MS + 30);
  }

  /** The first look: the cover swings open onto the inside cover and page one. */
  openCover() {
    const [left] = this.slotEls;
    const endpaper = left.firstChild;
    left.replaceChildren();
    const leaf = el('div.jb-leaf.right.opening', {}, el('div.jb-leaf-front', {}, coverEl(this.entry, { size: 'big' })), el('div.jb-leaf-back', {}, endpaper));
    this.book.append(leaf);
    this.turning = true;
    setTimeout(() => leaf.classList.add('turn'), 250);
    setTimeout(() => {
      this.turning = false;
      left.replaceChildren(endpaper);
      leaf.remove();
      if (this.dirty) { this.dirty = false; this.render(); }
      if (this.pendingEdit) this.editWhenReady(this.pendingEdit);
    }, 250 + TURN_MS + 60);
  }

  // ------------------------------------------------------------------ adding and removing pages

  addPage() {
    this.finishEdit();
    const pages = this.pages();
    const at = this.currentPageId() ? this.pageIndex(this.writablePage()) : pages.length - 1;
    const before = pages[at]?.sort ?? 0;
    const after = pages[at + 1]?.sort;
    const sort = after == null ? before + 1 : (before + after) / 2;
    const pid = newId();
    this.savePages({ [pid]: { sort, author: store.user?.id ?? null, font: localFont(), text: '', items: {} } });
    this.goTo(pid, { quiet: true });
    this.startEdit(pid);
  }

  removePage(pid) {
    const p = this.pages().find((x) => x.id === pid);
    if (!p) return;
    if ((p.text?.trim() || Object.keys(p.items ?? {}).length) && !confirm('Tear this page out? What\'s on it goes too.')) return;
    if (this.editing === pid) { this.editing = null; this.selected = null; }
    this.savePages({ [pid]: null });
    this.render();
  }

  // ------------------------------------------------------------------ writing

  /** Start writing on a page as soon as it's here (a new book arrives a moment later). */
  editWhenReady(pid) {
    if (this.turning || this.pageIndex(pid) < 0) { this.pendingEdit = pid; return; }
    this.pendingEdit = null;
    this.goTo(pid, { quiet: true });
    this.startEdit(pid);
  }

  startEdit(pid) {
    if (!this.j.canWrite(this.entry)) return;
    if (this.editing && this.editing !== pid) this.finishEdit();
    if (this.pageIndex(pid) < 0) return;
    this.editing = pid;
    this.selected = null;
    this.render();
    const text = this.book.querySelector(`.jb-page[data-page="${pid}"] .jb-text`);
    if (text) {
      text.focus();
      // Caret at the end.
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  makeEditable(text, p) {
    text.contentEditable = 'true';
    text.spellcheck = true;
    text.querySelectorAll('[data-wiki]').forEach((n) => { n.contentEditable = 'false'; });
    text.addEventListener('focus', () => { try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* old browser */ } });
    text.addEventListener('input', () => this.saveSoon(p.id));
    text.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const t = ev.clipboardData?.getData('text/plain') ?? '';
      document.execCommand('insertText', false, t);
    });
    text.addEventListener('drop', (ev) => {
      const f = [...(ev.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (!f) return;
      ev.preventDefault();
      this.uploadPicture(f).then((src) => { if (src) this.insertInline(src, { place: 'full', mask: 'none', look: 'none' }); });
    });
    text.addEventListener('click', (ev) => {
      const img = ev.target.closest('img');
      this.select(img ? { kind: 'inline', img } : null);
    });
    document.addEventListener('selectionchange', this.trackRange ??= () => {
      const sel = getSelection();
      const t = this.editText();
      if (t && sel.rangeCount && t.contains(sel.getRangeAt(0).commonAncestorContainer)) this.lastRange = sel.getRangeAt(0).cloneRange();
    });
  }

  editText() { return this.editing ? this.book.querySelector(`.jb-page[data-page="${this.editing}"] .jb-text`) : null; }

  saveSoon(pid) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveText(pid), 1200);
  }

  saveText(pid = this.editing) {
    clearTimeout(this.saveTimer);
    const text = pid === this.editing ? this.editText() : null;
    if (!text) return;
    const md = toMarkdown(text);
    const p = this.pages().find((x) => x.id === pid);
    if (!p || (p.text ?? '') === md) return;
    this.savePages({ [pid]: { text: md } });
  }

  /** Stop writing: save, and carry anything that runs off the page onto new pages. */
  finishEdit() {
    const pid = this.editing;
    if (!pid) return;
    this.saveText(pid);
    this.editing = null;
    this.selected = null;
    const p = this.pages().find((x) => x.id === pid);
    if (p) {
      const parts = paginate(p.text ?? '', p.font);
      if (parts.length > 1) {
        const pages = this.pages();
        const i = pages.findIndex((x) => x.id === pid);
        const lo = p.sort ?? 0;
        const hi = pages[i + 1]?.sort ?? lo + parts.length;
        const changes = { [pid]: { text: parts[0] } };
        parts.slice(1).forEach((t, k) => {
          changes[newId()] = { sort: lo + ((hi - lo) * (k + 1)) / parts.length, author: p.author ?? store.user?.id ?? null, font: p.font, text: t, items: {} };
        });
        this.savePages(changes);
        toast(`That ran over the page, so it carries on over ${parts.length - 1} more page${parts.length > 2 ? 's' : ''}.`);
      }
    }
    this.render();
  }

  drawEditTools() {
    const p = this.pages().find((x) => x.id === this.editing);
    const keep = (ev) => ev.preventDefault(); // keep the caret in the page
    const cmd = (c, v = null) => () => { this.editText()?.focus(); document.execCommand(c, false, v); this.saveSoon(this.editing); };
    const b = (text, title, fn, cls = '') => el(`button${cls}`, { type: 'button', text, title, on: { mousedown: keep, click: fn } });
    const style = el('select', { title: 'Style', 'aria-label': 'Paragraph style', on: { change: (ev) => { cmd('formatBlock', `<${ev.target.value}>`)(); ev.target.value = 'p'; } } },
      el('option', { value: 'p', text: 'Text' }), el('option', { value: 'h2', text: 'Heading' }), el('option', { value: 'h3', text: 'Subheading' }), el('option', { value: 'blockquote', text: 'Quote' }));
    const font = el('select', { title: 'Handwriting', 'aria-label': 'Handwriting', on: { change: (ev) => {
      localFont(ev.target.value);
      this.saveText();
      this.savePages({ [this.editing]: { font: ev.target.value } });
      const page = this.book.querySelector(`.jb-page[data-page="${this.editing}"]`);
      page?.style.setProperty('--jb-font', fontOf(ev.target.value));
    } } }, Object.entries(FONTS).map(([k, [label]]) => el('option', { value: k, text: label, selected: k === (p?.font ?? 'book'), style: `font-family:${fontOf(k)}` })));
    this.toolbar.replaceChildren(
      style,
      b('B', 'Bold (Ctrl+B)', cmd('bold'), '.jb-b'),
      b('I', 'Italic (Ctrl+I)', cmd('italic'), '.jb-i'),
      b('•', 'Bulleted list', cmd('insertUnorderedList')),
      b('1.', 'Numbered list', cmd('insertOrderedList')),
      b('―', 'A line across the page', cmd('insertHorizontalRule')),
      el('span.jb-sep'),
      b('🖼 Picture', 'Add a picture', () => this.pictureDialog()),
      b('✶ Stamp', 'Add a stamp, a seal or some damage', (ev) => this.stampMenu(ev.currentTarget)),
      el('span.jb-sep'),
      font,
      el('span.grow'),
      b('🗑 Page', 'Tear this page out', () => this.removePage(this.editing), '.danger'),
      b('✓ Done', 'Finish writing (the page is saved as you write)', () => this.finishEdit(), '.primary'));
  }

  // ------------------------------------------------------------------ pictures

  async uploadPicture(file) {
    try {
      toast('Adding the picture…');
      return await this.api.upload(file);
    } catch (err) {
      toast(String(err.message ?? err), 'error');
      return null;
    }
  }

  /** Choose a picture, where it goes and how it looks. */
  pictureDialog() {
    const range = this.lastRange;
    const win = openWindow({ id: `journal-picture-${this.id}`, title: 'Add a picture', width: 520 });
    const state = { src: '', place: 'right', mask: 'none', look: 'none' };
    const preview = el('div.jb-pic-preview');
    const draw = () => {
      if (!state.src) { preview.replaceChildren(el('p.muted', { text: 'Choose a picture to see it here.' })); return; }
      const img = el('img.jb-pic', { src: state.src, alt: '' });
      dressPicture(img, { mask: state.mask, look: state.look, seed: state.src });
      preview.replaceChildren(el('div.jb-page.jb-pic-paper', {}, el('div.jb-paper'), img));
    };
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, on: { change: async () => {
      const f = file.files?.[0];
      if (!f) return;
      const src = await this.uploadPicture(f);
      if (src) { state.src = src; link.value = ''; draw(); }
    } } });
    const link = el('input', { type: 'url', placeholder: 'or paste a link: https://…', on: { change: () => { const u = safeUrl(link.value); if (u) { state.src = u; draw(); } else if (link.value) toast('That isn\'t a web link (https://…).', 'error'); } } });
    const pick = (name, label, options) => el('label', {}, label, el('select', { on: { change: (ev) => { state[name] = ev.target.value; draw(); } } },
      Object.entries(options).map(([k, v]) => el('option', { value: k, text: v, selected: state[name] === k }))));
    win.body.replaceChildren(el('div.jb-pic-dialog', {},
      el('div.row', {}, el('button', { type: 'button', text: '⬆ Upload a picture…', on: { click: () => file.click() } }), link, file),
      preview,
      el('div.jb-pic-opts', {}, pick('place', 'Where', PLACES), pick('mask', 'Edge', MASKS), pick('look', 'Look', LOOKS)),
      el('div.row', {}, el('span.grow'),
        el('button', { type: 'button', text: 'Cancel', on: { click: () => win.close() } }),
        el('button.primary', { type: 'button', text: 'Add it', on: { click: () => {
          if (!state.src) { toast('Choose a picture first.'); return; }
          win.close();
          if (state.place === 'loose') this.addItem({ kind: 'image', src: state.src, mask: state.mask, look: state.look, w: 0.45 });
          else this.insertInline(state.src, state, range);
        } } }))));
    draw();
  }

  insertInline(src, opts, range = this.lastRange) {
    const text = this.editText();
    if (!text) return;
    const img = el('img', { src, alt: pictureAlt(opts) });
    dressInline(img);
    text.focus();
    const sel = getSelection();
    if (range && text.contains(range.commonAncestorContainer)) { sel.removeAllRanges(); sel.addRange(range); }
    if (opts.place === 'full' || !sel.rangeCount || !text.contains(sel.anchorNode)) {
      // A picture across the page gets a paragraph of its own.
      let block = sel.rangeCount && text.contains(sel.anchorNode) ? sel.anchorNode : null;
      while (block && block.parentNode !== text) block = block.parentNode;
      const para = el('p', {}, img);
      if (block) block.after(para); else text.append(para);
    } else {
      const r = sel.getRangeAt(0);
      r.collapse(true);
      r.insertNode(img);
    }
    this.saveText();
  }

  // ------------------------------------------------------------------ loose items (pictures, stamps, damage)

  stampMenu(anchor) {
    document.querySelector('.jb-stamp-menu')?.remove();
    const groups = { damage: 'Damage', decor: 'Stamps and seals' };
    const menu = el('div.jb-stamp-menu', { role: 'menu' }, Object.entries(groups).map(([g, label]) => el('div', {},
      el('div.jb-stamp-group', { text: label }),
      el('div.jb-stamp-grid', {}, Object.entries(MARKS).filter(([, m]) => m.group === g).map(([k, m]) => el('button.jb-stamp', {
        type: 'button', title: m.label, role: 'menuitem',
        on: { mousedown: (ev) => ev.preventDefault(), click: () => { menu.remove(); this.addItem({ kind: k, w: m.w }); } },
      }, el('span.jb-stamp-art', { html: markSvg(k, `menu${k}`) }), el('small', { text: m.label })))))));
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(r.left, innerWidth - 340)}px`;
    menu.style.top = `${r.bottom + 4}px`;
    document.body.append(menu);
    const away = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); removeEventListener('pointerdown', away, true); } };
    setTimeout(() => addEventListener('pointerdown', away, true), 0);
  }

  addItem(it) {
    const pid = this.editing;
    const p = this.pages().find((x) => x.id === pid);
    if (!p) return;
    this.saveText();
    const iid = newId();
    const z = Math.max(0, ...Object.values(p.items ?? {}).filter(Boolean).map((x) => x.z ?? 0)) + 1;
    const r = seeded(iid);
    const item = { x: 0.5, y: 0.45, rot: it.kind === 'image' ? Math.round((r() - 0.5) * 6) : Math.round((r() - 0.5) * 30), z, ...it };
    if (it.kind === 'tear') { item.corner = 0; delete item.rot; }
    this.savePages({ [pid]: { items: { [iid]: item } } });
    this.selected = { kind: 'item', pid, iid };
    this.redrawEditingItems();
  }

  setItem(pid, iid, patch) {
    this.savePages({ [pid]: { items: { [iid]: patch } } });
    this.redrawEditingItems();
  }

  /** Redraw the loose items of the page being written, without touching its text. */
  redrawEditingItems() {
    const page = this.book.querySelector(`.jb-page[data-page="${this.editing}"]`);
    const p = this.pages().find((x) => x.id === this.editing);
    if (page && p) page.querySelector('.jb-items')?.replaceWith(this.itemsEl(p, true));
    this.drawItembar();
  }

  dragItem(ev, pid, iid, node, mode) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    this.select({ kind: 'item', pid, iid }, { redraw: false });
    this.book.querySelectorAll('.jb-item.selected').forEach((n) => n.classList.toggle('selected', n === node));
    const page = node.closest('.jb-page');
    const rect = page.getBoundingClientRect();
    const it = { ...(this.pages().find((x) => x.id === pid)?.items?.[iid] ?? {}) };
    const start = { x: ev.clientX, y: ev.clientY, it: { ...it } };
    let moved = false;
    node.setPointerCapture(ev.pointerId);
    const move = (e2) => {
      const dx = (e2.clientX - start.x) / rect.width, dy = (e2.clientY - start.y) / rect.height;
      if (Math.abs(dx) + Math.abs(dy) > 0.003) moved = true;
      if (it.kind === 'tear') {
        // Snap to the nearest corner.
        const fx = (e2.clientX - rect.left) / rect.width, fy = (e2.clientY - rect.top) / rect.height;
        it.corner = fy < 0.5 ? (fx >= 0.5 ? 0 : 3) : (fx >= 0.5 ? 1 : 2);
      } else if (mode === 'move') {
        it.x = clamp((Number(start.it.x) || 0) + dx, 0, 1);
        it.y = clamp((Number(start.it.y) || 0) + dy, 0, 1);
      } else {
        it.w = clamp((Number(start.it.w) || 0.3) + dx * 2, 0.05, 1.1);
      }
      this.placeItem(node, it);
    };
    const up = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      if (!moved) { this.drawItembar(); return; }
      const patch = it.kind === 'tear' ? { corner: it.corner } : mode === 'move' ? { x: round(it.x), y: round(it.y) } : { w: round(it.w) };
      this.setItem(pid, iid, patch);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  select(s, { redraw = true } = {}) {
    this.selected = s;
    this.book.querySelectorAll('.jb-pic.inline-selected').forEach((n) => n.classList.remove('inline-selected'));
    if (s?.kind === 'inline') s.img.classList.add('inline-selected');
    if (redraw) this.book.querySelectorAll('.jb-item').forEach((n) => n.classList.toggle('selected', s?.kind === 'item' && n.dataset.item === s.iid));
    this.drawItembar();
  }

  /** Under the toolbar: what you can do to the selected picture or stamp. */
  drawItembar() {
    const s = this.selected;
    if (!s || !this.editing) { this.itembar.hidden = true; this.itembar.replaceChildren(); return; }
    const pick = (label, options, value, fn) => el('label', {}, label, el('select', { on: { change: (ev) => fn(ev.target.value) } },
      Object.entries(options).map(([k, v]) => el('option', { value: k, text: v, selected: k === value }))));
    const parts = [];
    if (s.kind === 'inline') {
      const img = s.img;
      const o = pictureOpts(img.getAttribute('alt'));
      const set = (k, v) => {
        o[k] = v;
        img.setAttribute('alt', pictureAlt(o));
        img.className = img.className.replace(/\bjb-place-\w+/g, '');
        dressInline(img);
        img.classList.add('inline-selected');
        this.saveText();
      };
      const inlinePlaces = Object.fromEntries(Object.entries(PLACES).filter(([k]) => k !== 'loose'));
      parts.push(el('strong', { text: 'Picture' }),
        pick('Where', inlinePlaces, o.place, (v) => set('place', v)),
        pick('Edge', MASKS, o.mask, (v) => set('mask', v)),
        pick('Look', LOOKS, o.look, (v) => set('look', v)),
        el('span.grow'),
        el('button.danger', { type: 'button', text: 'Remove picture', on: { click: () => { img.remove(); this.select(null); this.saveText(); } } }));
    } else {
      const p = this.pages().find((x) => x.id === s.pid);
      const it = p?.items?.[s.iid];
      if (!it) { this.itembar.hidden = true; return; }
      const zs = Object.values(p.items).filter(Boolean).map((x) => x.z ?? 0);
      parts.push(el('strong', { text: it.kind === 'image' ? 'Picture' : MARKS[it.kind]?.label ?? 'Stamp' }));
      if (it.kind === 'image') {
        parts.push(pick('Edge', MASKS, it.mask ?? 'none', (v) => this.setItem(s.pid, s.iid, { mask: v })),
          pick('Look', LOOKS, it.look ?? 'none', (v) => this.setItem(s.pid, s.iid, { look: v })));
      }
      if (it.kind !== 'tear') {
        parts.push(el('label.jb-rot', {}, 'Turn', el('input', { type: 'range', min: -180, max: 180, step: 1, value: Number(it.rot) || 0,
          on: {
            input: (ev) => { const n = this.book.querySelector(`.jb-item[data-item="${s.iid}"]`); if (n) this.placeItem(n, { ...it, rot: Number(ev.target.value) }); },
            change: (ev) => this.setItem(s.pid, s.iid, { rot: Number(ev.target.value) }),
          } })));
      }
      parts.push(
        el('button', { type: 'button', text: '⬆ Front', title: 'In front of the others', on: { click: () => this.setItem(s.pid, s.iid, { z: Math.max(...zs) + 1 }) } }),
        el('button', { type: 'button', text: '⬇ Back', title: 'Behind the others', on: { click: () => this.setItem(s.pid, s.iid, { z: Math.min(...zs) - 1 }) } }),
        el('span.grow'),
        el('button.danger', { type: 'button', text: 'Remove', on: { click: () => { this.selected = null; this.setItem(s.pid, s.iid, null); } } }));
    }
    this.itembar.replaceChildren(...parts);
    this.itembar.hidden = false;
  }

  // ------------------------------------------------------------------ sync

  /** Something changed in the world: redraw (`id` null: users or actors changed). */
  changed(id) {
    if (id && id !== this.id) return;
    if (!this.entry) return;
    if (this.turning) { this.dirty = true; return; }
    if (this.pendingEdit && this.pageIndex(this.pendingEdit) >= 0) { this.editWhenReady(this.pendingEdit); return; }
    if (this.editing) {
      if (this.pageIndex(this.editing) < 0) { this.editing = null; this.render(); return; }
      // Keep the page being written as it is; redraw the one beside it.
      this.slotEls?.forEach((slot, i) => {
        if (slot.querySelector(`.jb-page[data-page="${this.editing}"]`)) return;
        slot.replaceChildren(this.slotEl(this.slots()[i], i));
      });
      return;
    }
    this.render();
  }
}

const round = (v) => Math.round(v * 1000) / 1000;

/** Merge a patch into a plain object (null deletes), like the server's merge patch. */
function mergeInto(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeInto(out[k] && typeof out[k] === 'object' ? out[k] : {}, v);
    else out[k] = v;
  }
  return out;
}
