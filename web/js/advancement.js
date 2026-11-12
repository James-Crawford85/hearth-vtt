// Advancement: levelling up classes, adding ancestries / backgrounds / classes,
// and the GM's editors for an item's grants and effects.
//
// The server does the real work (crates/hearth-core/src/advance.rs); this file
// shows what a level gives, collects the player's picks, and sends them.

import { store, isGM, systemInfo, getPath } from './store.js';
import { el, toast, openWindow } from './ui.js';
import { ITEM_MIME } from './items.js';
import { DOC_MIME } from './collections.js';
import { nodeAt } from './layout-sheet.js';
import { label } from './blueprint-sheet.js';
import { renderMarkdown } from './markdown.js';

const uid = () => Math.random().toString(36).slice(2, 10);
const KINDS = [['items', 'Gives items'], ['choice', 'Choose from items'], ['pick', 'Pick any of a type (e.g. a feat)'], ['points', 'Spend points'], ['roll', 'Roll (e.g. hit points)']];
const cleanDoc = (doc) => { const d = structuredClone(doc); for (const k of ['folder', 'access', 'players']) delete d[k]; return d; };
const MODES = [['set', 'Set to'], ['upgrade', 'At least'], ['downgrade', 'At most'], ['multiply', 'Multiply by'], ['add', 'Add']];

/** Item types that give features, and which of them level (from the system builder / hearth.toml). */
export function grantTypes() {
  const types = systemInfo().item_types ?? {};
  const rules = systemInfo().rules?.item_types ?? {};
  const bp = systemInfo().blueprint?.item_types ?? [];
  const out = [];
  for (const [key, t] of Object.entries(types)) {
    const node = bp.find((n) => n.key === key);
    const levels = rules[key]?.levels || node?.levels || null;
    if (levels || node?.grants) out.push({ key, label: t.label ?? key, levels });
  }
  return out;
}

/** Whether a class grant comes at a level: once at its level, or again every `every` levels until `until`. */
export function comesAt(g, level) {
  const first = Math.max(1, g.level ?? 0);
  if (level < first || (g.until > 0 && level > g.until)) return false;
  return g.every > 0 ? (level - first) % g.every === 0 : level === first;
}

/** How many points a grant can really spend on this list: its amount, limited by what's allowed and the caps. */
function pointsWanted(g, list) {
  const field = g.field || 'value';
  const amount = Math.max(0, g.amount ?? 0);
  let room = 0;
  for (const [k, entry] of Object.entries(list ?? {})) {
    if (g.only?.length && !g.only.includes(k)) continue;
    const cur = Number(entry?.[field] ?? 0);
    const byCap = g.cap != null ? Math.max(0, g.cap - cur) : Infinity;
    room += Math.min(byCap, g.max_each > 0 ? g.max_each : Infinity, amount);
  }
  return Math.min(amount, room);
}

export const levelsKey = (kind) => grantTypes().find((t) => t.key === kind)?.levels ?? null;
export const levelOf = (item) => Number(item.data?.[levelsKey(item.kind)] ?? 0);

// ------------------------------------------------------------------ the level-up / add dialog

/** Level up an item the actor has (itemId), or add a new one (add = an item document). */
export async function openAdvance(api, actorId, { itemId = null, add = null } = {}) {
  const actor = store.world.actors[actorId];
  const target = itemId ? actor.items.find((i) => i.id === itemId) : add;
  if (!target) return;
  const lkey = levelsKey(target.kind);
  const level = lkey ? levelOf(target) + 1 : 1;
  const title = itemId ? `${target.name}: level ${level}` : lkey ? `Add ${target.name} (level 1)` : `Add ${target.name}`;
  const win = openWindow({ title, width: 480 });
  const picks = { choices: {}, points: {}, rolls: {}, picks: {} };
  const body = el('div.advance');
  const errorEl = el('p.error-text');
  win.body.replaceChildren(el('p.muted', { text: 'Loading…' }));

  // The server works out formula amounts (skill ranks = class + Int) and the
  // character's own grants at the total level this reaches (a feat every odd level).
  let plan = null;
  try {
    const res = await fetch('/api/advance/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hearth-session': api.session ?? '' },
      body: JSON.stringify({ actor_id: actorId, item_id: itemId, add: itemId ? null : add }),
    });
    if (res.ok) plan = await res.json();
    else { win.body.replaceChildren(el('p.error-text', { text: await res.text() })); return; }
  } catch { /* older server: work from the grants alone */ }
  const lim = (g) => (plan?.limits?.[g.id] ? { ...g, ...plan.limits[g.id] } : g);

  // Grants this step brings: the item's, plus those of items it gave that advance with it.
  const sources = [{ item: target, leveled: !!lkey, fresh: false }];
  if (itemId) {
    for (const it of actor.items) {
      if (it.flags?.core?.granted_by?.item === itemId && it.advancement?.length) sources.push({ item: it, leveled: true, fresh: false });
    }
  }
  if (plan?.extra?.length) {
    sources.push({ item: { name: plan.extra_label || `Level ${plan.total_level}`, advancement: plan.extra.map((g) => ({ ...g, level: 0, every: 0, until: 0 })) }, leveled: false, fresh: false });
  }
  const grantsOf = (src) => (src.item.advancement ?? []).filter((g) => {
    if (plan?.off?.includes(g.id)) return false; // its `when` doesn't hold at this step
    if (src.fresh) return Array.from({ length: level }, (_, i) => i + 1).some((l) => comesAt(g, l));
    if (!src.leveled) return (g.level ?? 0) <= 1;
    return comesAt(g, level);
  });

  const render = () => {
    const parts = [];
    const seen = new Set();
    const walk = (src) => {
      for (const g of grantsOf(src)) {
        if (seen.has(g.id)) continue;
        seen.add(g.id);
        // Keep the grant above anything it brings with it (e.g. a subclass's features).
        const at = parts.push(null) - 1;
        parts[at] = grantBlock(g, src, () => render(), walk);
      }
    };
    sources.forEach(walk);
    if (!parts.length) parts.push(el('p.muted', { text: `Nothing new at this level${lkey ? '' : ''}.` }));
    body.replaceChildren(...parts);
  };

  const grantBlock = (g, src, rerender, walk) => {
    const name = g.label || src.item.name;
    const box = el('fieldset.bfield', {}, el('legend', { text: name }));
    switch (g.kind) {
      case 'items':
        box.append(el('p', { text: `You gain: ${(g.items ?? []).map((i) => i.name).join(', ') || 'nothing'}` }));
        for (const it of g.items ?? []) if (it.advancement?.length) walk({ item: it, leveled: true, fresh: true });
        break;
      case 'choice': {
        const want = Math.max(1, g.count || 1);
        const chosen = picks.choices[g.id] ??= [];
        box.append(el('p.muted.small', { text: want === 1 ? 'Pick one.' : `Pick ${want}.` }));
        (g.items ?? []).forEach((it, i) => {
          const on = chosen.includes(i);
          box.append(el('label.check', {}, el('input', {
            type: want === 1 ? 'radio' : 'checkbox', name: `pick-${g.id}`, checked: on,
            on: {
              change: (e) => {
                if (want === 1) picks.choices[g.id] = [i];
                else if (e.target.checked) { if (chosen.length >= want) { e.target.checked = false; return; } chosen.push(i); } else chosen.splice(chosen.indexOf(i), 1);
                rerender();
              },
            },
          }), el('span', {}, el('strong', { text: it.name }), it.data?.description ? el('span.muted', { text: ` ${String(it.data.description).slice(0, 120)}` }) : null)));
        });
        // A picked item with grants of its own (a subclass) shows them too.
        for (const i of picks.choices[g.id] ?? []) {
          const it = g.items[i];
          if (it?.advancement?.length) walk({ item: it, leveled: true, fresh: true });
        }
        break;
      }
      case 'pick': {
        const want = Math.max(1, g.count || 1);
        const chosen = picks.picks[g.id] ??= [];
        const typeLabel = systemInfo().item_types?.[g.from]?.label ?? g.from ?? 'item';
        box.append(el('p.muted.small', { text: `Pick ${want === 1 ? `one ${typeLabel.toLowerCase()}` : `${want} (${typeLabel.toLowerCase()})`}.` }),
          el('div.grant-items', {}, ...chosen.map((d, i) => el('span.chip', {}, d.name,
            el('button.icon', { type: 'button', text: '✕', title: 'Remove', on: { click: () => { chosen.splice(i, 1); rerender(); } } })))));
        if (chosen.length < want) box.append(el('button.small', { type: 'button', text: `Choose ${typeLabel.toLowerCase()}…`, on: { click: () => choosePick(api, actor, g, chosen, rerender) } }));
        break;
      }
      case 'points': {
        g = lim(g);
        const spent = picks.points[g.id] ??= {};
        const field = g.field || 'value';
        const list = getPath(actor.data, g.path) ?? {};
        const allowed = (k) => !g.only?.length || g.only.includes(k);
        // As many points as can actually be spent here (the server works it out the same way).
        const want = pointsWanted(g, list);
        const left = () => want - Object.values(spent).reduce((s, n) => s + n, 0);
        const counter = el('p.muted.small');
        const update = () => { counter.textContent = `${left()} point${left() === 1 ? '' : 's'} left${g.max_each ? `, at most ${g.max_each} on one` : ''}${g.cap != null ? `, none above ${g.cap}` : ''}.`; };
        // Names and order from the system builder's list (e.g. Strength, Dexterity…), wherever it sits in the tree.
        const bpList = nodeAt((systemInfo().blueprint?.actor_types ?? []).find((t) => t.key === actor.kind)?.children ?? [], g.path);
        const names = Object.fromEntries((bpList?.entries ?? []).map((e) => [e.key, e.label || e.key]));
        const order = (bpList?.entries ?? []).map((e) => e.key);
        const keys = Object.keys(list).filter(allowed).sort((a, b) => ((order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)) || a.localeCompare(b));
        const rows = keys.map((key) => {
          const base = Number(list[key]?.[field] ?? 0);
          const val = el('strong', { text: String(base + (spent[key] ?? 0)) });
          const bump = (d) => {
            const n = (spent[key] ?? 0) + d;
            if (n < 0 || (d > 0 && left() <= 0) || (g.max_each && n > g.max_each) || (g.cap != null && base + n > g.cap)) return;
            spent[key] = n;
            val.textContent = String(base + n);
            update();
          };
          return el('div.row.points-row', {}, el('span.grow', { text: names[key] ?? key }), el('button.icon', { type: 'button', text: '−', on: { click: () => bump(-1) } }), val, el('button.icon', { type: 'button', text: '+', on: { click: () => bump(1) } }));
        });
        update();
        if (!want) {
          const kindLabel = systemInfo().actor_types?.[actor.kind]?.label ?? actor.kind;
          box.append(el('p.muted', { text: rows.length ? 'Nothing left to raise here: everything is already at its limit.' : `Nothing to choose here: a ${kindLabel} has no ${bpList ? label(bpList) : g.path} list, so this step is skipped.` }));
        } else box.append(counter, ...rows);
        break;
      }
      case 'roll': {
        // Show the item's own values (e.g. 1d{@item.hit_die} → 1d10); the server does the real filling in.
        const dice = (g.formula || '')
          .replace(/\{\s*@item\.(\w+)\s*\}/g, (m, k) => String(src.item.data?.[k] ?? m))
          .replace(/@item\.(\w+)/g, (m, k) => String(src.item.data?.[k] ?? m));
        const hasDice = /\d*d\d/.test(dice.replace(/@[\w.[\]@]+/g, '').replace(/\{[^}]*\}/g, '1'));
        if (!hasDice) {
          box.append(el('p', { text: `You gain ${dice}.` }));
        } else if (g.average) {
          picks.rolls[g.id] ??= 'roll';
          for (const [v, l] of [['roll', `Roll ${dice}`], ['average', 'Take the average']]) {
            box.append(el('label.check', {}, el('input', { type: 'radio', name: `roll-${g.id}`, checked: picks.rolls[g.id] === v, on: { change: () => { picks.rolls[g.id] = v; } } }), l));
          }
        } else {
          box.append(el('p', { text: `Rolled when you confirm: ${dice}.` }));
        }
        break;
      }
      default:
        break;
    }
    return box;
  };

  render();
  const confirm = el('button.primary', {
    type: 'button', text: itemId ? `Level up to ${level}` : 'Add',
    on: {
      click: () => {
        errorEl.textContent = '';
        // Check picks before sending (the server checks again).
        for (const src of sources) {
          for (const g of grantsOf(src)) {
            if (g.kind === 'choice' && (picks.choices[g.id]?.length ?? 0) < Math.min(Math.max(1, g.count || 1), g.items?.length ?? 0)) { errorEl.textContent = `${g.label || 'A choice'}: make your pick.`; return; }
            if (g.kind === 'pick' && (picks.picks[g.id]?.length ?? 0) < Math.max(1, g.count || 1)) { errorEl.textContent = `${g.label || 'A pick'}: make your pick.`; return; }
            if (g.kind === 'points') {
              const need = pointsWanted(lim(g), getPath(actor.data, g.path) ?? {});
              const s = Object.values(picks.points[g.id] ?? {}).reduce((a, b) => a + b, 0);
              if (s !== need) { errorEl.textContent = `${g.label || 'Points'}: spend all ${need}.`; return; }
            }
          }
        }
        const req = { type: 'advance', actor_id: actorId, item_id: itemId, add: itemId ? null : add, choices: picks.choices, points: picks.points, rolls: picks.rolls, picks: picks.picks };
        api._send(req);
        win.close();
      },
    },
  });
  win.body.replaceChildren(body, errorEl, el('div.row', {}, el('span.grow'), el('button', { type: 'button', text: 'Cancel', on: { click: () => win.close() } }), confirm));
}

/** Whether a pick grant takes this item: its type, and the grant's `where` fields (mirrors the server). */
export function pickAllows(g, doc) {
  if (g.from && doc.kind !== g.from) return false;
  return Object.entries(g.where ?? {}).every(([k, want]) => {
    const have = k === 'name' ? doc.name : (doc.data?.[k] ?? null);
    return Array.isArray(want) ? want.includes(have) : want === have;
  });
}

/** A searchable list for a "pick any of a type" grant (any feat…); picked documents go into `chosen`. */
async function choosePick(api, actor, g, chosen, done) {
  const typeLabel = systemInfo().item_types?.[g.from]?.label ?? g.from;
  const win = openWindow({ title: `Choose ${typeLabel.toLowerCase()}`, width: 440 });
  win.body.replaceChildren(el('p.muted', { text: 'Loading…' }));
  const all = (await availableItems(api, [g.from])).filter((c) => pickAllows(g, c.doc)).sort((a, b) => String(a.doc.name).localeCompare(String(b.doc.name)));
  const search = el('input', { type: 'search', placeholder: `Find ${typeLabel.toLowerCase()}…`, 'aria-label': 'Search' });
  const list = el('ul.entity-list.picker-list');
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = all.filter((c) => !q || String(c.doc.name).toLowerCase().includes(q) || String(c.doc.data?.description ?? '').toLowerCase().includes(q)).slice(0, 300);
    list.replaceChildren(...shown.map((c) => {
      const has = actor.items.some((i) => i.kind === c.doc.kind && i.name === c.doc.name) || chosen.some((d) => d.name === c.doc.name);
      const about = String(c.doc.data?.prerequisites ?? c.doc.data?.prerequisite ?? '') || String(c.doc.data?.description ?? '').slice(0, 110);
      return el(`li.entity${has ? '.muted' : ''}`, { on: { click: () => { if (has) return; chosen.push(cleanDoc(c.doc)); win.close(); done(); } } },
        el('span.grow', {}, el('span', { text: c.doc.name }), el('small.muted', { text: ` ${c.from}` }), about ? el('div.small.muted', { text: about }) : null),
        has ? el('span.badge', { text: 'has it' }) : null);
    }));
    if (!shown.length) list.append(el('li.muted', { text: all.length ? 'Nothing matches.' : `There are no ${typeLabel.toLowerCase()} items to pick from yet.` }));
  };
  search.addEventListener('input', draw);
  draw();
  win.body.replaceChildren(search, list);
  search.focus();
}

/**
 * Every item of these kinds this user can take: the world's Items directory (what
 * they can see), the system's and modules' collections, and the world's collections.
 */
export async function availableItems(api, kinds) {
  const ok = (k) => kinds.includes(k);
  const out = [];
  for (const x of Object.values(store.world.items ?? {})) if (ok(x.kind) && x.data !== null) out.push({ doc: x, from: 'Items' });
  for (const p of api.collections?.packs() ?? []) {
    if (p.kind !== 'item') continue;
    try {
      for (const d of await api.collections.loadPack(p.pkg, p.id)) if (ok(d.kind)) out.push({ doc: d, from: p.label, pack: true });
    } catch { /* not available to this user */ }
  }
  for (const c of Object.values(store.world.collections ?? {})) {
    if (c.kind !== 'item') continue;
    for (const d of Object.values(c.entries ?? {})) if (ok(d.kind)) out.push({ doc: d, from: c.name });
  }
  // The same thing in several places (an imported Fighter and the collection's): list it once.
  // The Items directory's copy wins (the GM may have changed it), then world collections, then packages.
  const rank = (x) => (x.from === 'Items' ? 0 : x.pack ? 2 : 1);
  const best = new Map();
  for (const x of out) {
    const key = `${x.doc.kind}/${String(x.doc.name ?? '').trim().toLowerCase()}`;
    const had = best.get(key);
    if (!had) { best.set(key, { ...x, also: [] }); continue; }
    if (rank(x) < rank(had)) best.set(key, { ...x, also: [...had.also, had.from] });
    else had.also.push(x.from);
  }
  return [...best.values()];
}

/** What happens when a feature-giving item (class, species…) is picked: add it, or level it up if they have it. */
function pickGrantDoc(api, actorId, t, source) {
  const actor = store.world.actors[actorId];
  const mine = actor.items.find((i) => i.kind === source.kind && i.name === source.name);
  if (mine && !t.levels) { toast(`${actor.name} already has ${source.name}.`); return false; }
  if (mine && t.levels) { openAdvance(api, actorId, { itemId: mine.id }); return true; }
  const doc = structuredClone(source);
  for (const k of ['folder', 'access', 'players']) delete doc[k];
  doc.data ??= {};
  if (t.levels) doc.data[t.levels] = 0;
  openAdvance(api, actorId, { add: doc });
  return true;
}

/** Choose what to add (an ancestry, background or new class) from the Items directory and package collections. */
export async function openAdd(api, actorId) {
  const types = grantTypes();
  if (!types.length) { toast('This system has no item types that give features. Mark one in the system builder.'); return; }
  const win = openWindow({ title: 'Add an ancestry, background or class', width: 460 });
  win.body.replaceChildren(el('p.muted', { text: 'Loading…' }));
  const choices = await availableItems(api, types.map((t) => t.key));
  const actor = store.world.actors[actorId];
  const parts = [];
  for (const t of types) {
    const mine = choices.filter((c) => c.doc.kind === t.key);
    parts.push(el('h3', { text: t.label }));
    if (!mine.length) { parts.push(el('p.muted.small', { text: isGM() ? `None yet. Make one in the Items directory (type ${t.label}) and give it advancement.` : 'None shared with you.' })); continue; }
    parts.push(el('ul.entity-list', {}, mine.map((c) => {
      const has = actor.items.some((i) => i.kind === c.doc.kind && i.name === c.doc.name);
      return el('li.entity', { on: { click: () => { if (pickGrantDoc(api, actorId, t, c.doc)) win.close(); } } },
        el('span.grow', {}, el('span', { text: c.doc.name }), el('small.muted', { text: ` ${c.from}`, title: c.also?.length ? `Also in ${c.also.join(', ')}` : null })), has ? el('span.badge', { text: t.levels ? 'level up' : 'has it' }) : null);
    })));
  }
  win.body.replaceChildren(...parts);
}

/**
 * "+ Add" on a sheet: pick an item of one type from what exists (collections and
 * the Items directory). Classes, species and the like go through the Add steps;
 * other items are copied onto the actor. Only the GM can make a blank one, and
 * never for types that give features.
 */
export async function openItemPicker(api, actorId, kind) {
  const actor = store.world.actors[actorId];
  if (!actor) return;
  const typeLabel = systemInfo().item_types?.[kind]?.label ?? kind;
  const grant = grantTypes().find((t) => t.key === kind);
  const win = openWindow({ title: `Add ${/^[aeiou]/i.test(typeLabel) ? 'an' : 'a'} ${typeLabel.toLowerCase()} to ${actor.name}`, width: 440 });
  win.body.replaceChildren(el('p.muted', { text: 'Loading…' }));
  const all = (await availableItems(api, [kind])).sort((a, b) => String(a.doc.name).localeCompare(String(b.doc.name)) || a.from.localeCompare(b.from));
  const search = el('input', { type: 'search', placeholder: `Find ${typeLabel.toLowerCase()}…`, 'aria-label': 'Search' });
  const list = el('ul.entity-list.picker-list');
  const pick = (c) => {
    if (grant) { if (pickGrantDoc(api, actorId, grant, c.doc)) win.close(); return; }
    api.collections?.giveItem(actorId, c.doc);
    win.close();
  };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = all.filter((c) => !q || String(c.doc.name).toLowerCase().includes(q));
    list.replaceChildren(...shown.map((c) => {
      const has = grant && actor.items.some((i) => i.kind === c.doc.kind && i.name === c.doc.name);
      const about = c.doc.data?.description ? String(c.doc.data.description).slice(0, 110) : '';
      return el('li.entity', { on: { click: () => pick(c) } },
        el('span.grow', {}, el('span', { text: c.doc.name }), el('small.muted', { text: ` ${c.from}`, title: c.also?.length ? `Also in ${c.also.join(', ')}` : null }), about ? el('div.small.muted', { text: about }) : null),
        has ? el('span.badge', { text: grant.levels ? 'level up' : 'has it' }) : null);
    }));
    if (!shown.length) {
      list.append(el('li.muted', { text: all.length ? 'Nothing matches.' : isGM()
        ? `There are no ${typeLabel.toLowerCase()} items yet. Make one in the Items directory, or add some to a collection.`
        : `The GM hasn't shared any ${typeLabel.toLowerCase()} items yet.` }));
    }
  };
  search.addEventListener('input', draw);
  draw();
  const blank = isGM() && !grant
    ? el('button.small', { type: 'button', text: `+ A blank ${typeLabel.toLowerCase()}`, title: 'Make a new, empty one on this character', on: { click: () => { api.create.item(actorId, kind, `New ${typeLabel}`); win.close(); } } })
    : null;
  win.body.replaceChildren(search, list, el('div.row', {}, el('span.grow'), blank));
  search.focus();
}

/** Take back an item's last level (or remove it and what it gave). */
export function regress(api, actorId, item) {
  const lkey = levelsKey(item.kind);
  const lvl = lkey ? levelOf(item) : 0;
  const msg = lkey && lvl > 1
    ? `Take back ${item.name} level ${lvl}? What it gave at that level (features, points, hit points) is removed.`
    : `Remove ${item.name} and everything it gave?`;
  if (!confirm(msg)) return;
  api._send({ type: 'regress', actor_id: actorId, item_id: item.id });
}

/**
 * Remove an item from an actor, whatever it is: a class with all its levels and
 * everything they gave, an ancestry or subclass with what it gave, or a plain item.
 */
export function removeItem(api, actorId, item) {
  const gives = grantTypes().some((g) => g.key === item.kind) || item.advancement?.length;
  const lkey = levelsKey(item.kind);
  const lvl = lkey ? levelOf(item) : 0;
  const msg = gives
    ? `Remove ${item.name}${lvl > 1 ? ` (all ${lvl} levels)` : ''} and everything it gave (features, choices, points, hit points)?`
    : `Remove ${item.name}?`;
  if (!confirm(msg)) return false;
  if (gives) api._send({ type: 'regress', actor_id: actorId, item_id: item.id, all: true });
  else api.op({ op: 'item_delete', actor_id: actorId, id: item.id });
  return true;
}

// ------------------------------------------------------------------ GM: an item's grants

/**
 * Editor for an item's advancement. `save(advancement)` stores it.
 * `leveled`: the item's type has levels (grants are grouped by level).
 */
export function advancementEditor(api, item, save, leveled) {
  const list = structuredClone(item.advancement ?? []);
  const root = el('fieldset.bfield.advancement-editor', {}, el('legend', { text: leveled ? 'Advancement: what each level gives' : 'What this gives when added' }));
  const body = el('div');
  let timer = null;
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => save(list), 600); };
  const pickItems = (g) => {
    // Add items from the Items directory (or drop them here).
    const lib = Object.values(store.world.items ?? {}).filter((x) => x.data !== null);
    const sel = el('select', {}, el('option', { value: '', text: lib.length ? 'Add from the Items directory…' : 'Drag items here from Items or Collections' }), ...lib.map((x) => el('option', { value: x.id, text: `${x.name} (${x.kind})` })));
    sel.addEventListener('change', () => {
      const x = store.world.items[sel.value];
      if (!x) return;
      const doc = structuredClone(x);
      for (const k of ['folder', 'access', 'players']) delete doc[k];
      (g.items ??= []).push(doc);
      draw();
      changed();
    });
    return sel;
  };
  const draw = () => {
    const sorted = [...list].sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    body.replaceChildren(...sorted.map((g) => {
      const row = el('div.grant', {
        on: {
          dragover: (e) => { if (e.dataTransfer.types.includes(ITEM_MIME) || e.dataTransfer.types.includes(DOC_MIME)) e.preventDefault(); },
          drop: (e) => {
            let doc = null;
            const lid = e.dataTransfer.getData(ITEM_MIME);
            if (lid && store.world.items?.[lid]) doc = structuredClone(store.world.items[lid]);
            const d = e.dataTransfer.getData(DOC_MIME);
            if (d) { try { const x = JSON.parse(d); if (x.kind === 'item') doc = x.doc; } catch { /* not ours */ } }
            if (!doc || !['items', 'choice'].includes(g.kind)) return;
            e.preventDefault();
            for (const k of ['folder', 'access', 'players']) delete doc[k];
            (g.items ??= []).push(doc);
            draw();
            changed();
          },
        },
      });
      const set = (k, v) => { g[k] = v; changed(); };
      const num = (k, label, size = 4) => el('label', {}, label, el('input', { type: 'number', size, value: g[k] ?? '', on: { input: (e) => set(k, e.target.value === '' ? null : Number(e.target.value)) } }));
      const txt = (k, label, ph = '') => el('label.grow', {}, label, el('input', { value: g[k] ?? '', placeholder: ph, on: { input: (e) => set(k, e.target.value) } }));
      const head = el('div.row', {},
        leveled ? num('level', 'Level', 3) : null,
        txt('label', 'Label', 'e.g. Fighting style'),
        el('label', {}, 'Kind', el('select', { on: { change: (e) => { set('kind', e.target.value); draw(); } } }, ...KINDS.map(([v, l]) => el('option', { value: v, text: l, selected: (g.kind ?? 'items') === v })))),
        el('button.icon', { type: 'button', title: 'Remove', text: '✕', on: { click: () => { list.splice(list.indexOf(g), 1); draw(); changed(); } } }));
      row.append(head);
      if (leveled) {
        // Repeat: hit points every level, ability points every 4 levels…
        row.append(el('div.row.grant-repeat', {}, num('every', 'Then again every … levels', 3), num('until', 'Until level (blank: no end)', 3),
          el('small.muted', { text: g.every > 0 ? `Comes at level ${Math.max(1, g.level ?? 1)}, then every ${g.every} level${g.every === 1 ? '' : 's'}${g.until ? ` up to ${g.until}` : ''}.` : 'Comes once.' })));
      }
      row.append(el('label', {}, 'Only when (a formula; blank: always)', el('input', {
        value: g.when ?? '', placeholder: 'e.g. @favored_class == @item.name',
        on: { input: (e) => { const v = e.target.value.trim(); if (v) g.when = v; else delete g.when; changed(); } },
      })));
      const kind = g.kind ?? 'items';
      if (kind === 'items' || kind === 'choice') {
        if (kind === 'choice') row.append(num('count', 'How many to pick'));
        row.append(el('div.grant-items', {}, ...(g.items ?? []).map((it, i) => el('span.chip', {}, it.name, it.advancement?.length ? ' ✦' : '',
          el('button.icon', { type: 'button', text: '✕', title: 'Remove', on: { click: () => { g.items.splice(i, 1); draw(); changed(); } } }))), pickItems(g)));
      } else if (kind === 'pick') {
        const types = Object.entries(systemInfo().item_types ?? {});
        row.append(el('div.row', {},
          el('label', {}, 'Of the type', el('select', { on: { change: (e) => set('from', e.target.value) } }, el('option', { value: '', text: 'Choose…' }),
            ...types.map(([k, t]) => el('option', { value: k, text: t.label ?? k, selected: g.from === k })))),
          num('count', 'How many to pick')),
        // Only some of them: "feat_type = combat" (several values: "feat_type = combat, critical").
        el('label', {}, 'Only where (field = value; several values separated by commas)', el('input', {
          value: Object.entries(g.where ?? {}).map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(', ') : v}`).join('; '), placeholder: 'e.g. feat_type = combat',
          on: {
            input: (e) => {
              const where = {};
              for (const part of e.target.value.split(';')) {
                const [k, v] = part.split('=').map((x) => x?.trim());
                if (!k || !v) continue;
                const vals = v.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === 'true' ? true : x === 'false' ? false : /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x));
                where[k] = vals.length === 1 ? vals[0] : vals;
              }
              if (Object.keys(where).length) g.where = where; else delete g.where;
              changed();
            },
          },
        })),
        el('p.muted.small', { text: 'The player picks from every item of that type they can take: the system\'s and world\'s collections and the Items directory.' }));
      } else if (kind === 'points') {
        // A number, or a formula worked out at that level (skill ranks: @item.skill_ranks + @abilities.int.mod; cap: @level).
        const numOr = (k, fk, label, ph) => el('label', {}, label, el('input', {
          size: 10, value: g[fk] || (g[k] ?? ''), placeholder: ph, title: 'A number, or a formula worked out at that level',
          on: { input: (e) => { const v = e.target.value.trim(); if (v === '' || /^-?\d+$/.test(v)) { g[k] = v === '' ? (k === 'cap' ? null : 0) : Number(v); delete g[fk]; } else { g[fk] = v; if (k !== 'cap') g[k] = 0; else delete g[k]; } changed(); } },
        }));
        row.append(el('div.row', {}, txt('path', 'On the list', 'abilities'), txt('field', 'Field', 'value'), numOr('amount', 'amount_formula', 'Points', '2 or a formula'), num('max_each', 'Most on one'), numOr('cap', 'cap_formula', 'Cap', '20 or @level')),
          el('label', {}, 'Only these entries (keys, separated by commas; blank: any)', el('input', {
            value: (g.only ?? []).join(', '), placeholder: 'e.g. athletics, intimidation, perception',
            on: { input: (e) => { const keys = e.target.value.split(',').map((k) => k.trim()).filter(Boolean); if (keys.length) g.only = keys; else delete g.only; changed(); } },
          })));
      } else if (kind === 'roll') {
        row.append(el('div.row', {}, txt('formula', 'Dice', '1d{@item.hit_die}'), txt('path', 'Record in (a list on this item)', 'hp_rolls')),
          el('label.check', {}, el('input', { type: 'checkbox', checked: !!g.average, on: { change: (e) => set('average', e.target.checked) } }), 'Players may take the average'));
      }
      return row;
    }));
  };
  draw();
  root.append(body, el('button.small', { type: 'button', text: '+ Grant', on: { click: () => { list.push({ id: uid(), level: leveled ? Math.max(1, ...list.map((g) => g.level ?? 1)) : 1, kind: 'items', label: '', items: [] }); draw(); changed(); } } }),
    el('p.muted.small', { text: 'Drag items from the Items directory or a collection onto a grant. Items with advancement of their own (✦, e.g. a subclass) bring their grants at the same class levels.' }));
  return root;
}

// ------------------------------------------------------------------ an item's parts

/**
 * The parts attached to an item (a weapon's abilities, armor's material), each with its
 * text to read; `save(parts)` stores the list after one is removed.
 */
export function partsView(item, save, editable = true) {
  const parts = structuredClone(item.parts ?? []);
  const root = el('fieldset.bfield.item-parts', {}, el('legend', { text: 'Abilities and materials' }));
  parts.forEach((p, i) => {
    const d = p.data ?? {};
    const note = [d.bonus ? `+${d.bonus} bonus` : '', d.price && !d.bonus ? d.price : '', d.aura ? `${d.aura}${d.cl ? `, CL ${d.cl}` : ''}` : ''].filter(Boolean).join(' · ');
    root.append(el('details.item-part', {},
      el('summary', {}, el('strong', { text: p.name }), note ? el('span.muted.small', { text: ` ${note}` }) : null,
        editable ? el('button.icon', { type: 'button', text: '✕', title: `Remove ${p.name}`, on: { click: (e) => { e.preventDefault(); if (confirm(`Remove ${p.name} from ${item.name}?`)) { parts.splice(i, 1); save(parts); } } } }) : null),
      d.description ? el('div.small', {}, renderMarkdown(String(d.description))) : el('p.muted.small', { text: 'No description.' })));
  });
  return root;
}

// ------------------------------------------------------------------ an item's own effects

/** Editor for the effects an individual item gives its owner. `save(effects)` stores them. */
export function effectsEditor(item, save, editable = true) {
  const list = structuredClone(item.effects ?? []);
  const root = el('fieldset.bfield', {}, el('legend', { text: 'Effects on whoever has it' }));
  const body = el('div');
  let timer = null;
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => save(list), 600); };
  const draw = () => {
    body.replaceChildren(...list.map((fx, i) => {
      fx.changes ??= [];
      const changesEl = el('div', {}, ...fx.changes.map((c, j) => el('div.row.change-row', {},
        el('input', { value: c.path, placeholder: 'value it changes, e.g. abilities.str.value', disabled: !editable, on: { input: (e) => { c.path = e.target.value.replace(/^@/, ''); changed(); } } }),
        el('select', { disabled: !editable, on: { change: (e) => { c.mode = e.target.value; changed(); } } }, ...MODES.map(([v, l]) => el('option', { value: v, text: l, selected: (c.mode ?? 'add') === v }))),
        el('input.grow', { value: c.value, placeholder: 'formula', disabled: !editable, on: { input: (e) => { c.value = e.target.value; changed(); } } }),
        el('input', { size: 9, value: c.type ?? '', placeholder: 'bonus type', title: 'Bonuses of the same type don\'t stack: only the biggest counts (e.g. enhancement, morale). Blank: always stacks.', disabled: !editable, on: { input: (e) => { const t = e.target.value.trim(); if (t) c.type = t; else delete c.type; changed(); } } }),
        editable ? el('button.icon', { type: 'button', text: '✕', on: { click: () => { fx.changes.splice(j, 1); draw(); changed(); } } }) : null)));
      return el('div.grant', {},
        el('div.row', {},
          el('label.grow', {}, 'Name', el('input', { value: fx.name ?? '', disabled: !editable, on: { input: (e) => { fx.name = e.target.value; changed(); } } })),
          el('label', {}, 'Only while', el('input', { value: fx.requires ?? '', placeholder: '@item.equipped', disabled: !editable, on: { input: (e) => { fx.requires = e.target.value || null; changed(); } } })),
          el('label.check', {}, el('input', { type: 'checkbox', checked: !fx.disabled, disabled: !editable, on: { change: (e) => { fx.disabled = !e.target.checked; changed(); } } }), 'On'),
          editable ? el('button.icon', { type: 'button', text: '✕', title: 'Remove', on: { click: () => { list.splice(i, 1); draw(); changed(); } } }) : null),
        changesEl,
        editable ? el('button.small', { type: 'button', text: '+ Change', on: { click: () => { fx.changes.push({ path: '', mode: 'add', value: '1' }); draw(); changed(); } } }) : null);
    }));
  };
  draw();
  root.append(body);
  if (editable) root.append(el('button.small', { type: 'button', text: '+ Effect', on: { click: () => { list.push({ id: uid(), name: item.name, changes: [{ path: '', mode: 'add', value: '1' }] }); draw(); changed(); } } }));
  return root;
}
