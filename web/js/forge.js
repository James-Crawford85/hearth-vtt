// The item forge: make an item from a base (a longsword, a chain shirt) plus parts
// (abilities, materials), priced and checked by the system's rules, then create it
// or craft it as a character. The server does the sums (crates/hearth-core/src/forge.rs).

import { store, isGM, systemInfo } from './store.js';
import { el, openWindow, toast } from './ui.js';
import { availableItems } from './advancement.js';

/** Item types the system's forge can make, with their forge rules. */
export function forgeTypes() {
  const rules = systemInfo().rules?.item_types ?? {};
  return Object.entries(rules).filter(([, t]) => t.forge).map(([key, t]) => ({ key, label: systemInfo().item_types?.[key]?.label ?? key, forge: t.forge }));
}

/** Who besides the GM may use the forge here: off, craft or free. */
export const forgePlayers = () => store.world?.settings?.core?.forge?.players ?? 'off';
export const canForge = () => forgeTypes().length > 0 && (isGM() || forgePlayers() !== 'off');

const post = async (api, url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hearth-session': api.session ?? '' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
};
const clean = (doc) => { const d = structuredClone(doc); for (const k of ['folder', 'access', 'players']) delete d[k]; d.parts ??= []; d.effects ??= []; return d; };
// What the server needs of a candidate part to check it fits (not its long text).
const slim = (doc) => ({ id: doc.id ?? '', name: doc.name, kind: doc.kind, data: Object.fromEntries(Object.entries(doc.data ?? {}).filter(([, v]) => typeof v !== 'string' || v.length < 200)) });
const gp = (n) => `${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** The fields a forge shows for a type: its numbers, checkboxes and choices (enhancement, masterwork…). */
function editableFields(kind) {
  const node = (systemInfo().blueprint?.item_types ?? []).find((t) => t.key === kind);
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.hidden) continue;
      if (n.kind === 'group' && n.flat) walk(n.children);
      else if (['number', 'checkbox', 'choice'].includes(n.kind)) out.push(n);
    }
  };
  walk(node?.children);
  return out;
}

/** Open the forge, for a character (they get the item, or craft it) or, for the GM, the Items directory. */
export function openForge(api, { actorId = null } = {}) {
  const types = forgeTypes();
  if (!types.length) { toast('This system has nothing to forge. A system sets forge rules on its item types.'); return; }
  const actor = actorId ? store.world.actors[actorId] : null;
  const win = openWindow({ id: `forge-${actorId ?? 'gm'}`, title: actor ? `Item forge: ${actor.name}` : 'Item forge', width: 620 });
  const st = { item: null, candidates: [], preview: null, error: '' };
  const body = el('div.forge');
  win.body.append(body);

  const refresh = async () => {
    if (!st.item) return draw();
    try {
      st.preview = await post(api, '/api/forge/preview', { actor_id: actorId, item: st.item, candidates: st.candidates.map((c) => slim(c.doc)) });
      st.error = '';
      // The system's suggested name, until the maker types their own.
      if (!st.named && st.preview.name) st.item.name = st.preview.name;
    } catch (e) { st.error = e.message; }
    draw();
  };
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };

  const chooseBase = async () => {
    const all = (await availableItems(api, types.map((t) => t.key))).sort((a, b) => String(a.doc.name).localeCompare(String(b.doc.name)));
    const pick = openWindow({ title: 'Start from', width: 420 });
    const search = el('input', { type: 'search', placeholder: 'Find a weapon, armor…', 'aria-label': 'Search' });
    const list = el('ul.entity-list.picker-list');
    const drawList = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...all.filter((c) => !q || String(c.doc.name).toLowerCase().includes(q)).slice(0, 300).map((c) => el('li.entity', {
        on: { click: async () => { st.item = clean(c.doc); st.named = false; pick.close(); await loadCandidates(); refresh(); } },
      }, el('span.grow', {}, el('span', { text: c.doc.name }), el('small.muted', { text: ` ${types.find((t) => t.key === c.doc.kind)?.label ?? c.doc.kind} · ${c.from}` })))));
    };
    search.addEventListener('input', drawList);
    drawList();
    pick.body.replaceChildren(search, list);
    search.focus();
  };

  const loadCandidates = async () => {
    const f = types.find((t) => t.key === st.item?.kind)?.forge;
    st.candidates = f?.parts?.length ? (await availableItems(api, f.parts)).sort((a, b) => String(a.doc.name).localeCompare(String(b.doc.name))) : [];
  };

  const make = async (mode) => {
    try {
      const r = await post(api, '/api/forge/make', { actor_id: actorId, item: st.item, mode });
      toast(r.made ? `${st.item.name} is made.` : `${st.item.name} wasn't made: the check failed.`, r.made ? 'info' : 'error');
      if (r.made) win.close();
    } catch (e) { st.error = e.message; draw(); }
  };

  const draw = () => {
    const parts = [];
    if (!st.item) {
      parts.push(el('p.muted', { text: `Start from a base item: ${types.map((t) => t.label.toLowerCase()).join(', ')}.` }), el('button.primary', { type: 'button', text: 'Choose a base item…', on: { click: chooseBase } }));
      body.replaceChildren(...parts);
      return;
    }
    const it = st.item;
    const p = st.preview;
    // The item: its name and the fields that matter for making it (enhancement…).
    parts.push(el('div.row', {},
      el('label.grow', {}, 'Name', el('input', { value: it.name, on: { input: (e) => { it.name = e.target.value; st.named = true; } } })),
      el('button.small', { type: 'button', text: 'Change base…', on: { click: chooseBase } })));
    const fields = editableFields(it.kind);
    if (fields.length) {
      parts.push(el('div.forge-fields', {}, ...fields.map((n) => {
        const v = it.data?.[n.key];
        const set = (x) => { it.data[n.key] = x; later(); };
        if (n.kind === 'checkbox') return el('label.check', {}, el('input', { type: 'checkbox', checked: !!v, on: { change: (e) => set(e.target.checked) } }), n.label || n.key);
        if (n.kind === 'choice') return el('label', {}, n.label || n.key, el('select', { on: { change: (e) => set(e.target.value) } }, ...(n.options ?? []).map((o) => el('option', { value: o.value, text: o.label || o.value, selected: o.value === v }))));
        return el('label', {}, n.label || n.key, el('input', { type: 'number', value: v ?? 0, style: 'width: 80px', on: { input: (e) => set(Number(e.target.value)) } }));
      })));
    }
    // Parts: what's attached, and what could be.
    const fits = p?.fits ?? [];
    const offer = st.candidates.map((c, i) => ({ c, ok: fits[i] !== false })).filter((x) => x.ok && !it.parts.some((q) => q.name === x.c.doc.name));
    const note = (d) => (d.data?.bonus ? `+${d.data.bonus}` : d.data?.price ? String(d.data.price) : d.data?.level != null && d.kind === 'spell' ? `level ${d.data.level}` : '');
    const partSel = el('button.small', {
      type: 'button', text: offer.length ? `Add… (${offer.length} fit)` : 'Nothing more fits', disabled: !offer.length,
      on: { click: () => {
        const pick = openWindow({ title: 'Add to the item', width: 420 });
        const search = el('input', { type: 'search', placeholder: 'Find…', 'aria-label': 'Search' });
        const list = el('ul.entity-list.picker-list');
        const drawList = () => {
          const q = search.value.trim().toLowerCase();
          list.replaceChildren(...offer.filter((x) => !q || String(x.c.doc.name).toLowerCase().includes(q)).slice(0, 300).map((x) => el('li.entity', {
            on: { click: () => { it.parts.push(clean(x.c.doc)); pick.close(); refresh(); } },
          }, el('span.grow', {}, el('span', { text: x.c.doc.name }), el('small.muted', { text: ` ${note(x.c.doc)}` })))));
        };
        search.addEventListener('input', drawList);
        drawList();
        pick.body.replaceChildren(search, list);
        search.focus();
      } },
    });
    parts.push(el('fieldset.bfield', {}, el('legend', { text: 'Abilities and materials' }),
      el('div.grant-items', {}, ...it.parts.map((q, i) => el('span.chip', {}, q.name, el('button.icon', { type: 'button', text: '✕', title: 'Remove', on: { click: () => { it.parts.splice(i, 1); refresh(); } } })))),
      st.candidates.length ? partSel : el('p.muted.small', { text: 'This system has no abilities or materials for this kind of item.' })));
    // The sums.
    if (p) {
      // The money's name is the last part of its path (currency.gp → gp).
      const c = p.craft ? { ...p.craft, currency: String(p.craft.currency ?? '').split('.').pop() } : null;
      parts.push(el('div.forge-sum', {},
        el('div', {}, el('span.muted', { text: 'Price ' }), el('strong', { text: `${gp(p.price)}${c?.currency ? ` ${c.currency}` : ''}` })),
        c ? el('div', {}, el('span.muted', { text: 'To craft ' }), `${gp(c.cost)} ${c.currency}, ${gp(c.days)} day${c.days === 1 ? '' : 's'}, check +${gp(c.bonus)} vs DC ${gp(c.dc)}`,
          c.feat ? el('span', { class: c.has_feat ? 'muted' : 'error-text', text: ` · needs ${c.feat}${c.has_feat ? '' : ' (missing)'}` }) : null,
          actor ? el('span.muted', { text: ` · ${actor.name} has ${gp(c.money)} ${c.currency}` }) : null) : null,
        p.values?.damage ? el('div.muted.small', { text: `Damage ${p.values.damage}${p.values.critical ? `, critical ${p.values.critical}` : ''}` }) : null));
      if (p.problems.length) parts.push(el('ul.forge-problems', {}, ...p.problems.map((m) => el('li.error-text', { text: m }))));
    }
    if (st.error) parts.push(el('p.error-text', { text: st.error }));
    // Making it.
    const gm = isGM();
    const free = gm || forgePlayers() === 'free';
    const ok = p && !p.problems.length;
    parts.push(el('div.row', {}, el('span.grow'),
      free ? el('button', { type: 'button', text: actor ? `Give to ${actor.name}` : 'Create in the Items directory', disabled: !ok, title: 'Make it now, without the crafting rules', on: { click: () => make('create') } }) : null,
      actor && p?.craft ? el('button.primary', { type: 'button', text: 'Craft it', disabled: !ok || !p.craft.has_feat || p.craft.money < p.craft.cost, title: 'Spend the cost and roll the check; it is made on a success', on: { click: () => make('craft') } }) : null));
    body.replaceChildren(...parts);
  };
  draw();
}

/** GM: who may use the forge in this world. */
export function openForgeSettings(api) {
  const win = openWindow({ id: 'forge-settings', title: 'Item forge in this world', width: 420 });
  const cur = forgePlayers();
  const opts = [['off', 'GM only'], ['craft', 'Players craft by the rules (feat, check, cost)'], ['free', 'Players make anything (no rules)']];
  win.body.replaceChildren(
    el('p.muted.small', { text: 'The GM can always use the forge. Choose what players may do.' }),
    ...opts.map(([v, l]) => el('label.check', {}, el('input', { type: 'radio', name: 'forge-players', checked: cur === v, on: { change: () => api.settings.set('core', 'forge', { players: v }) } }), l)));
}
