// A searchable, filterable list for choosing from many documents (feats, spells, classes,
// a collection's entries). The search looks through names and everything written in the
// documents (descriptions, prerequisites, benefits…), every word has to match somewhere, and
// names that match come first. Filters are worked out from the documents themselves: their type,
// their book, the system's choice and checkbox fields, and short fields that share a handful of
// values ("Feat type", "School", "Class"). Each filter only offers values that are actually there,
// with how many there are among the rest of what's shown.
import { el } from './ui.js';
import { systemInfo } from './store.js';

const MAX_SHOWN = 300;
const INLINE_FILTERS = 4;

/** Field nodes of a blueprint type (its groups' children, all the way down). */
function fieldsOf(type) {
  const out = new Map();
  const walk = (n) => {
    for (const c of n?.children ?? []) {
      if (c.children?.length) walk(c);
      if (c.key && c.kind) out.set(c.key, c);
    }
  };
  walk(type);
  return out;
}

const human = (k) => String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const plain = (s) => String(s).replace(/[*_#`>|[\]]/g, ' ');

/** All the words in a document, lower case, for the search. */
function haystack(doc) {
  const parts = [];
  const add = (v, depth) => {
    if (v == null || depth > 4) return;
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number') return;
    else if (Array.isArray(v)) v.forEach((x) => add(x, depth + 1));
    else if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (typeof x !== 'object') parts.push(k); add(x, depth + 1); });
  };
  // Not the requirement formula: that's for the engine, not for reading.
  const { requires, ...data } = doc.data ?? {};
  add(data, 0);
  if (doc.content) parts.push(doc.content);
  if (doc.folder) parts.push(doc.folder);
  for (const it of doc.items ?? []) parts.push(it.name ?? '');
  return plain(parts.join(' \n ')).toLowerCase();
}

/** A field's values on a document, as strings: a list's members, a map's keys ({wizard: 2} → wizard). */
function valuesOf(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.filter((x) => x != null && typeof x !== 'object' && x !== '').map(String);
  if (typeof v === 'object') return Object.entries(v).filter(([, x]) => x != null && typeof x !== 'object').map(([k]) => k);
  return [String(v)];
}

/**
 * The filters that make sense for these entries. Each is { key, label, get(entry) → [values],
 * values: [{ value, label }] }, best first. `withFields`: also the documents' own fields (only
 * for one type at a time: a class's "Good Fortitude save" means nothing for a race).
 */
function filtersFor(entries, withFields = true) {
  const sys = systemInfo();
  const n = entries.length;
  const out = [];
  const distinct = (get) => {
    const m = new Map();
    for (const e of entries) for (const v of get(e)) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const kindLabel = (e, k) => (e.doc.kind && (e.actor ? sys.actor_types : sys.item_types)?.[k]?.label) || human(k);

  // Its type (classes, races…), where the list mixes them.
  const kinds = distinct((e) => (e.doc.kind ? [e.doc.kind] : []));
  if (kinds.size > 1) {
    const sample = new Map(entries.map((e) => [e.doc.kind, e]));
    out.push({ key: '@kind', label: 'Type', rank: 0, get: (e) => (e.doc.kind ? [e.doc.kind] : []), values: [...kinds.keys()].map((k) => ({ value: k, label: kindLabel(sample.get(k), k) })) });
  }
  // Its book.
  const books = distinct((e) => valuesOf(e.doc.data?.source));
  if (books.size > 1) out.push({ key: 'source', label: 'Book', rank: 2, get: (e) => valuesOf(e.doc.data?.source), values: [...books.keys()].sort().map((v) => ({ value: v, label: v })) });
  // A journal's folder.
  const folders = distinct((e) => (e.doc.folder ? [String(e.doc.folder)] : []));
  if (folders.size > 1 && folders.size < n) out.push({ key: '@folder', label: 'Folder', rank: 1, get: (e) => (e.doc.folder ? [String(e.doc.folder)] : []), values: [...folders.keys()].sort().map((v) => ({ value: v, label: v })) });

  // The documents' own fields: what the system says about them (choices, checkboxes), else what they hold.
  const fieldDefs = new Map();
  const bp = sys.blueprint ?? {};
  for (const k of kinds.keys()) {
    const t = (bp.item_types ?? []).find((x) => x.key === k) ?? (bp.actor_types ?? []).find((x) => x.key === k);
    for (const [key, f] of fieldsOf(t)) if (!fieldDefs.has(key)) fieldDefs.set(key, f);
  }
  const keys = new Set();
  if (withFields) for (const e of entries) for (const k of Object.keys(e.doc.data ?? {})) keys.add(k);
  for (const key of keys) {
    // Not the engine's own fields (requirements, "taken for" choices): they aren't things to sort by.
    if (['source', 'description', 'img', 'requires', 'requires_note', 'choose', 'choose_from', 'choice', 'choice_key'].includes(key)) continue;
    const def = fieldDefs.get(key);
    if (def && /formula|resource|longtext|richtext|roll|items|effects/.test(def.kind)) continue;
    let get = (e) => valuesOf(e.doc.data?.[key]);
    let m = distinct(get);
    // "combat, critical": a list written out, when splitting it gives fewer values.
    if (def?.kind !== 'choice' && [...m.keys()].some((v) => v.includes(','))) {
      const split = (e) => [...new Set(valuesOf(e.doc.data?.[key]).flatMap((v) => v.split(/\s*,\s*/)).filter(Boolean))];
      const ms = distinct(split);
      if (ms.size < m.size) { get = split; m = ms; }
    }
    if (m.size < 2) continue;
    const vals = [...m.keys()];
    if (vals.some((v) => v.length > 40)) continue;
    const numeric = vals.every((v) => /^-?\d+(\.\d+)?$/.test(v));
    const isMap = entries.some((e) => { const v = e.doc.data?.[key]; return v && typeof v === 'object' && !Array.isArray(v); });
    let rank;
    if (def?.kind === 'choice' || def?.kind === 'checkbox' || vals.every((v) => v === 'true' || v === 'false')) rank = 1;
    else if (isMap) { if (m.size > 60) continue; rank = 2; }
    else if (numeric) { if (m.size > 12) continue; rank = 3; }
    else if (m.size > (vals.filter((v) => v.length > 24).length <= vals.length / 10 ? 80 : 40) || m.size > Math.max(2, n / 3)) continue;
    else rank = 3;
    const opts = def?.kind === 'choice' ? (def.options ?? []) : [];
    const order = opts.map((o) => String(o.value));
    const labelOf = (v) => (v === 'true' ? 'Yes' : v === 'false' ? 'No' : opts.find((o) => String(o.value) === v)?.label || v);
    vals.sort((a, b) => ((order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)) || (numeric ? Number(a) - Number(b) : a.localeCompare(b)));
    out.push({ key, label: def?.label || human(key), rank, size: m.size, cover: entries.filter((e) => get(e).length).length / n, get, values: vals.map((v) => ({ value: v, label: labelOf(v) })) });
  }
  // Where it comes from (a collection, the Items directory), where the list mixes them.
  const froms = distinct((e) => (e.from ? [e.from] : []));
  if (froms.size > 1) out.push({ key: '@from', label: 'From', rank: 5, get: (e) => (e.from ? [e.from] : []), values: [...froms.keys()].sort().map((v) => ({ value: v, label: v })) });
  return out.sort(byUse);
}

/** Best filters first: by kind of filter, then those most of the list has a value for, then fewest values. */
const byUse = (a, b) => a.rank - b.rank || Math.round(((b.cover ?? 1) - (a.cover ?? 1)) * 4) || (a.size ?? 0) - (b.size ?? 0);

/** A short piece of the text around the first search word, when the name doesn't say it. */
function snippetOf(text, words) {
  const low = text.toLowerCase();
  let at = -1;
  for (const w of words) { at = low.indexOf(w); if (at >= 0) break; }
  if (at < 0) return '';
  const start = Math.max(0, at - 40);
  return `${start ? '…' : ''}${text.slice(start, at + 80).replace(/\s+/g, ' ').trim()}…`;
}

/**
 * A search box, filters and the list.
 *   entries   [{ doc, from?, … }]
 *   render    (entry, { snippet, select, selected }) → <li>; with `detail`, a click should select()
 *             (show it in the pane) and a double click choose it
 *   state     { q, filters } kept by the caller, so the choice survives a redraw
 *   placeholder, empty (text when there's nothing at all), onEnter (entry) for Enter in the box,
 *   onChange (entries that match, all of them) after each redraw
 *   detail    (entry) → nodes: shows the selected entry in a pane beside the list
 *   choose    { label(entry), why(entry) → reason it can't be chosen or null, run(entry) }: the pane's button
 *   qualify   'Tara': entries can carry `met` ("yes", "no", "check"); offers "Only what Tara qualifies
 *             for" (on to start with), which leaves out the "no"s
 * Returns { el, focus(), redraw(), matches() }.
 */
export function finder({ entries, render, state = {}, placeholder = 'Search…', empty = 'Nothing here yet.', onEnter = null, onChange = null, listClass = 'picker-list', detail = null, choose = null, qualify = null }) {
  state.q ??= '';
  state.filters ??= {};
  state.more ??= false;
  state.qualified ??= true;
  const rows = entries.map((e) => ({ e, name: String(e.doc.name ?? '').toLowerCase(), hay: null, text: null }));
  // Where the list mixes types, a type's own filters show once that type is chosen.
  const kinds = new Set(entries.map((e) => e.doc.kind).filter(Boolean));
  const base = filtersFor(entries, kinds.size <= 1);
  const byKind = new Map();
  const filtersNow = () => {
    const k = state.filters['@kind'];
    if (kinds.size <= 1 || k == null) return base;
    if (!byKind.has(k)) {
      const own = filtersFor(entries.filter((e) => e.doc.kind === k)).filter((f) => !base.some((b) => b.key === f.key));
      byKind.set(k, [...base, ...own].sort(byUse));
    }
    return byKind.get(k);
  };
  let filters = base;
  const prune = () => {
    filters = filtersNow();
    for (const key of Object.keys(state.filters)) if (!filters.some((x) => x.key === key)) delete state.filters[key];
  };
  prune();

  const search = el('input', { type: 'search', placeholder, value: state.q, 'aria-label': 'Search names and descriptions' });
  const bar = el('div.finder-filters');
  const list = el(`ul.entity-list.${listClass}`);
  const count = el('span.muted.small.finder-count');

  const matchesQuery = (r, words) => {
    if (!words.length) return true;
    r.hay ??= `${r.name} \n ${haystack(r.e.doc)}`;
    return words.every((w) => r.hay.includes(w));
  };
  const passes = (r, skip) => (!qualify || !state.qualified || skip === '@met' || r.e.met !== 'no') && filters.every((f) => {
    if (f.key === skip) return true;
    const want = state.filters[f.key];
    return want == null || f.get(r.e).includes(want);
  });

  const drawFilters = (words) => {
    const parts = [];
    const active = filters.filter((f) => state.filters[f.key] != null);
    const shownFilters = state.more ? filters : filters.filter((f, i) => i < INLINE_FILTERS || state.filters[f.key] != null);
    for (const f of shownFilters) {
      // How many each value would leave, given the search and the other filters.
      const counts = new Map();
      for (const r of rows) if (matchesQuery(r, words) && passes(r, f.key)) for (const v of f.get(r.e)) counts.set(v, (counts.get(v) ?? 0) + 1);
      const cur = state.filters[f.key];
      const set = (v) => { if (v == null || v === '') delete state.filters[f.key]; else state.filters[f.key] = v; redraw(); };
      if (f.key === '@kind' && f.values.length <= 6) {
        parts.push(el('div.finder-chips', { role: 'group', 'aria-label': f.label },
          el(`button.chip${cur == null ? '.on' : ''}`, { type: 'button', text: 'All', on: { click: () => set(null) } }),
          ...f.values.map((o) => el(`button.chip${cur === o.value ? '.on' : ''}`, { type: 'button', text: `${o.label} (${counts.get(o.value) ?? 0})`, on: { click: () => set(o.value) } }))));
        continue;
      }
      const sel = el('select', { 'aria-label': f.label, class: cur != null ? 'on' : null, on: { change: (e) => set(e.target.value) } },
        el('option', { value: '', text: `${f.label}: any` }),
        ...f.values.filter((o) => counts.get(o.value) || o.value === cur).map((o) => el('option', { value: o.value, selected: o.value === cur, text: `${o.label} (${counts.get(o.value) ?? 0})` })));
      parts.push(sel);
    }
    // "Only what Tara qualifies for", once there's something it would leave out.
    if (qualify && rows.some((r) => r.e.met)) {
      const out = rows.filter((r) => r.e.met === 'no' && matchesQuery(r, words) && passes(r, '@met')).length;
      parts.push(el('label.check.finder-qualify', { title: 'Leaves out what the requirements rule out. "Check" ones stay: the rules can\'t tell for those.' },
        el('input', { type: 'checkbox', checked: state.qualified, on: { change: (e) => { state.qualified = e.target.checked; redraw(); } } }),
        ` Only what ${qualify} qualifies for${out ? ` (${out} left out)` : ''}`));
    }
    const hidden = filters.length - shownFilters.length;
    if (hidden > 0 || (state.more && filters.length > INLINE_FILTERS)) {
      parts.push(el('button.small.link', { type: 'button', text: state.more ? 'Fewer filters' : `More filters (${hidden})`, on: { click: () => { state.more = !state.more; redraw(); } } }));
    }
    if (active.length || state.q) parts.push(el('button.small.link', { type: 'button', text: 'Clear', on: { click: () => { state.filters = {}; state.q = ''; search.value = ''; redraw(); } } }));
    bar.replaceChildren(...parts);
    bar.hidden = !parts.length;
  };

  let first = null;
  let matched = [];
  let shownNow = [];
  // The pane: what the selected entry is, and the button that chooses it.
  const pane = detail ? el('div.finder-pane') : null;
  let selected = null;
  const drawPane = () => {
    if (!pane) return;
    if (!selected) { pane.replaceChildren(el('p.muted', { text: 'Click one to see what it is. Double-click to choose it.' })); return; }
    const why = choose?.why?.(selected) ?? null;
    const btn = choose ? el('button.primary', { type: 'button', text: choose.label?.(selected) ?? 'Choose', disabled: !!why, title: why, on: { click: () => choose.run(selected) } }) : null;
    pane.replaceChildren(el('div.finder-pane-body', {}, ...detail(selected)), btn ? el('div.finder-pane-foot', {}, why ? el('span.muted.small.grow', { text: why }) : el('span.grow'), btn) : null);
    pane.scrollTop = 0;
  };
  const select = (entry) => {
    selected = entry;
    for (const li of list.children) li.classList.toggle('selected', li.__entry === entry);
    drawPane();
  };
  const redraw = () => {
    prune();
    const q = state.q.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    drawFilters(words);
    const hits = rows.filter((r) => passes(r) && matchesQuery(r, words));
    // Names that match first (the whole search, then every word), then what only the text mentions.
    const score = (r) => (!words.length ? 0 : r.name.includes(q) ? (r.name.startsWith(q) ? 0 : 1) : words.every((w) => r.name.includes(w)) ? 2 : 3);
    hits.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    matched = hits.map((r) => r.e);
    const shown = hits.slice(0, MAX_SHOWN);
    first = shown[0]?.e ?? null;
    shownNow = shown.map((r) => r.e);
    list.replaceChildren(...shown.map((r) => {
      let snippet = '';
      if (words.length && score(r) === 3) {
        // The document's writing (description, benefit…), not its short fields.
        r.text ??= plain(Object.entries(r.e.doc.data ?? {}).filter(([k]) => k !== 'requires').map(([, v]) => v).filter((v) => typeof v === 'string' && v.length > 40).join(' … ') || r.e.doc.content || '');
        snippet = snippetOf(r.text, words);
      }
      const li = render(r.e, { snippet, select: () => select(r.e), selected: r.e === selected });
      li.__entry = r.e;
      if (r.e === selected) li.classList.add('selected');
      return li;
    }));
    if (!shown.length) list.append(el('li.muted', { text: entries.length ? 'Nothing matches.' : empty }));
    count.textContent = hits.length > shown.length ? `Showing ${shown.length} of ${hits.length}. Search or filter to narrow it down.`
      : entries.length > 8 ? `${hits.length} of ${entries.length}` : '';
    onChange?.(matched);
  };

  let t = null;
  search.addEventListener('input', () => { state.q = search.value; clearTimeout(t); t = setTimeout(redraw, entries.length > 600 ? 120 : 0); });
  search.addEventListener('keydown', (e) => {
    // Up and down move through the list (showing each in the pane); Enter chooses.
    if (pane && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && shownNow.length) {
      e.preventDefault();
      const i = shownNow.indexOf(selected);
      const next = shownNow[Math.max(0, Math.min(shownNow.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
      select(next);
      [...list.children].find((li) => li.__entry === next)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key !== 'Enter') return;
    const target = pane ? selected ?? first : first;
    if (!target) return;
    e.preventDefault();
    if (pane && !selected) { select(target); return; }
    if (choose && !choose.why?.(target)) choose.run(target);
    else if (!choose && onEnter) onEnter(target);
  });
  redraw();
  drawPane();
  const listSide = el('div.finder', {}, search, bar, count, list);
  return { el: pane ? el('div.finder-split', {}, listSide, pane) : listSide, focus: () => search.focus(), redraw, matches: () => matched, select };
}
