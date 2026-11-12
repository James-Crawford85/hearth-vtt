// Items taken for a choice: "Weapon Focus" is always for one weapon, "Skill Focus" for one skill.
// An item asks by saying, in its data:
//   choose       what to ask for ("Weapon", "Skill", "School")
//   choose_from  where suggestions come from (optional): an item type ("weapon": the character's
//                and the collections'), a list on the character ("skills": its entries), or a
//                comma list ("abjuration, conjuration, …"). Anything can still be typed.
// When it's added, the player is asked; the copy is named "Weapon Focus (Longsword)" and keeps
// the answer in data.choice (and data.choice_key, the list entry's key, for a list). Formulas can
// then ask has_item('feat', 'Weapon Focus', @item.name). Items without `choose` are untouched.
import { formDialog } from './ui.js';
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
