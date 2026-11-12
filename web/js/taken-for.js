// Items taken for a choice: "Weapon Focus" is always for one weapon, "Skill Focus" for one skill.
// An item asks by saying, in its data:
//   choose       what to ask for ("Weapon", "Skill", "School")
//   choose_from  where suggestions come from (optional): an item type ("weapon": the character's
//                and the collections'), a list on the character ("skills": its entries), or a
//                comma list ("abjuration, conjuration, …"). Anything can still be typed.
// When it's added, the player is asked; the copy is named "Weapon Focus (Longsword)" and keeps
// the answer in data.choice (and data.choice_key, the list entry's key, for a list). Formulas can
// then ask has_item('feat', 'Weapon Focus', @item.name). Items without `choose` are untouched.
import { el, formDialog } from './ui.js';
import { store, systemInfo } from './store.js';
import { nodeAt } from './layout-sheet.js';

/** Suggestions for a choice: [{ label, key }]. */
async function suggestions(api, actor, from) {
  const src = String(from ?? '').trim();
  if (!src) return [];
  if (src.includes(',')) return src.split(',').map((s) => s.trim()).filter(Boolean).map((label) => ({ label, key: '' }));
  const sys = systemInfo();
  // A list on the character (skills): its entries, by the system's labels.
  const actorType = (sys.blueprint?.actor_types ?? []).find((t) => t.key === actor.kind);
  const list = nodeAt(actorType?.children ?? [], src);
  if (list?.kind === 'list') {
    const keys = new Set([...(list.entries ?? []).map((e) => e.key), ...Object.keys(actor.data?.[src] ?? {})]);
    const label = (k) => (list.entries ?? []).find((e) => e.key === k)?.label || actor.data?.[src]?.[k]?.label || k;
    return [...keys].map((key) => ({ label: label(key), key }));
  }
  // An item type: the character's own first, then the world's and the collections'.
  if (sys.item_types?.[src]) {
    const names = new Set(actor.items.filter((i) => i.kind === src).map((i) => i.name));
    for (const x of Object.values(store.world.items ?? {})) if (x.kind === src && x.data !== null) names.add(x.name);
    for (const p of api.collections?.packs() ?? []) {
      if (p.kind !== 'item') continue;
      try { for (const d of await api.collections.loadPack(p.pkg, p.id)) if (d.kind === src) names.add(d.name); } catch { /* not available */ }
    }
    return [...names].map((label) => ({ label, key: '' }));
  }
  return [];
}

/** An item's choices so far ("Dagger, Rapier" → ["Dagger", "Rapier"]). */
export const choicesOf = (it) => String(it?.data?.choice ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * For an item already on a sheet that asks (a granted class feature, which nobody picked from a
 * list): a button to choose what it's for, up to `data.choose_max` (default 1) choices, kept
 * comma-separated in data.choice and data.choice_key. The item's name doesn't change, so what
 * it's matched by (archetypes, levels) stays the same. Null for items that don't ask.
 */
export function choiceButton(api, actor, it, editable) {
  const ask = String(it?.data?.choose ?? '').trim();
  if (!ask) return null;
  const have = choicesOf(it);
  // How many it can be taken for: what the system works out by now (a `choose_limit` resource,
  // whose max can grow with level), else data.choose_max (default 1).
  const limit = actor.derived?.items?.[it.id]?.choose_limit?.max;
  const hasLimit = it.data.choose_limit != null && typeof limit === 'number';
  const max = hasLimit ? Math.max(0, limit) : Math.max(1, Number(it.data.choose_max) || 1);
  // The choices so far; click to correct or clear them.
  const save = async (list) => {
    const options = await suggestions(api, actor, it.data.choose_from);
    const keyOf = (c) => options.find((o) => o.label.toLowerCase() === c.toLowerCase())?.key ?? '';
    api.op({ op: 'item_update', actor_id: actor.id, id: it.id, patch: { data: { choice: list.join(', '), choice_key: list.map(keyOf).filter(Boolean).join(', ') } } });
  };
  const shown = !have.length ? null : editable
    ? el('button.bp-chip.bp-chip-edit', {
      type: 'button', text: `${ask}: ${have.join(', ')}`, title: `What ${it.name} is taken for: click to change`,
      on: {
        click: async () => {
          const v = await formDialog({ title: `${it.name}: ${ask.toLowerCase()}`, submit: 'Save', fields: [{ name: 'list', label: `${ask}${max > 1 ? ` (up to ${max}, separated by commas)` : ''}; empty to clear`, value: have.join(', ') }] });
          if (v) save(v.list.split(',').map((s) => s.trim()).filter(Boolean).slice(0, max));
        },
      },
    })
    : el('span.bp-chip', { text: `${ask}: ${have.join(', ')}`, title: `What ${it.name} is taken for` });
  if (!editable || have.length >= max) {
    // Not yet (Finesse Training before 3rd level): say so rather than show nothing.
    if (!have.length && hasLimit && max === 0) return el('span.bp-chip.muted', { text: `${ask}: chosen later`, title: `${it.name} can't be taken for a ${ask.toLowerCase()} yet` });
    return shown;
  }
  const btn = el('button.small.bp-btn', {
    type: 'button', text: have.length ? `+ ${ask.toLowerCase()}` : `Choose ${ask.toLowerCase()}…`,
    title: `Choose a ${ask.toLowerCase()} for ${it.name}${max > 1 ? ` (${have.length} of ${max})` : ''}`,
    on: {
      click: async () => {
        const options = await suggestions(api, actor, it.data.choose_from);
        const v = await formDialog({ title: `${it.name}: which ${ask.toLowerCase()}?`, submit: 'Choose', fields: [{ name: 'choice', label: ask, required: true, suggestions: options.map((o) => o.label).filter((l) => !have.includes(l)) }] });
        const choice = v?.choice?.trim();
        if (!choice) return;
        const hit = options.find((o) => o.label.toLowerCase() === choice.toLowerCase());
        const keys = String(it.data.choice_key ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        api.op({ op: 'item_update', actor_id: actor.id, id: it.id, patch: { data: { choice: [...have, hit?.label ?? choice].join(', '), choice_key: [...keys, hit?.key ?? ''].filter(Boolean).join(', ') } } });
      },
    },
  });
  return el('span.bp-choice', {}, shown, btn);
}

/**
 * The copy of `doc` to give `actor`: asked what it's taken for when it says `choose`. Null when
 * the player cancels. Anything already named "… (something)", or not asking, comes back as is.
 */
export async function takenFor(api, actor, doc) {
  const ask = String(doc?.data?.choose ?? '').trim();
  if (!ask || !actor || /\([^)]*\)\s*$/.test(doc.name ?? '')) return doc;
  const options = await suggestions(api, actor, doc.data.choose_from);
  const v = await formDialog({
    title: `${doc.name}: which ${ask.toLowerCase()}?`,
    submit: 'Take it',
    fields: [{ name: 'choice', label: ask, required: true, suggestions: options.map((o) => o.label) }],
  });
  const choice = v?.choice?.trim();
  if (!choice) return null;
  const hit = options.find((o) => o.label.toLowerCase() === choice.toLowerCase());
  const out = structuredClone(doc);
  out.name = `${doc.name} (${hit?.label ?? choice})`;
  out.data = { ...out.data, choice: hit?.label ?? choice, choice_key: hit?.key ?? '' };
  return out;
}
