// The new-character guide: one checklist on a new character's sheet for everything that sets them
// up (a species, a background, a class, ability scores…), done in any order. Bonuses that a species,
// background or class give to the scores are added on top of the scores set here, whichever comes
// first (the server keeps them; see creation::granted_raises). Gone once every row is done.
import { ownsActor, systemInfo } from './store.js';
import { el } from './ui.js';
import { hooks } from './hooks.js';
import { refreshSheets } from './sheets.js';
import { grantTypes, availableItems, openItemPicker, levelOf } from './advancement.js';
import { creationSteps, appliesTo, isCharacterType, worldMethods, openCreation, pendingSteps, scoresText } from './creation.js';

// Item types that other items pick (a class picks its subclass): those come with the class, not here.
let picked = null;
let loading = null;
hooks.on('packages', () => { picked = null; loading = null; });

function loadPicked(api) {
  loading ??= (async () => {
    const kinds = new Set();
    const docs = await availableItems(api, grantTypes().map((t) => t.key));
    const scan = (adv) => {
      for (const g of adv ?? []) {
        if (g.kind === 'pick' && g.from) kinds.add(g.from);
        if (g.kind === 'choice') for (const it of g.items ?? []) kinds.add(it.kind);
      }
    };
    for (const { doc } of docs) scan(doc.advancement);
    for (const t of systemInfo().blueprint?.actor_types ?? []) scan(t.advancement);
    picked = kinds;
  })().catch(() => { picked = new Set(); });
  return loading;
}

/** What setting up a character of this system takes: its starting item types, then its creation steps. */
function rowsFor(actor) {
  const types = grantTypes().filter((t) => !picked.has(t.key));
  // Only the first type with levels (the class): others, like a mythic path, come later in a game.
  const firstLeveled = types.find((t) => t.levels);
  // The class first (it shapes the rest), then origins like a background or species, then the scores.
  const starters = [firstLeveled, ...types.filter((t) => !t.levels)].filter(Boolean);
  const rows = starters.map((t) => {
    const have = actor.items.filter((i) => i.kind === t.key);
    return {
      label: t.label,
      done: have.length > 0,
      what: have.map((i) => (t.levels ? `${i.name} ${levelOf(i)}` : i.name)).join(', '),
      button: `Choose ${/^[aeiou]/i.test(t.label) ? 'an' : 'a'} ${t.label.toLowerCase()}…`,
      run: (api) => openItemPicker(api, actor.id, t.key),
    };
  });
  const pending = pendingSteps(actor);
  for (const s of creationSteps().filter((s) => appliesTo(s, actor.kind) && worldMethods(s).length)) {
    const state = actor.flags?.core?.creation?.[s.id] ?? {};
    if (!state.done && !pending.includes(s)) continue; // nothing to set on this actor
    const name = s.label || s.id;
    rows.push({ label: name, done: !!state.done, what: state.done ? scoresText(actor, s) : '', button: `Set ${name.toLowerCase()}…`, run: (api) => openCreation(api, actor.id, s.id), scores: true });
  }
  return rows;
}

/** The guide for a new character (to its owners), or null once they're set up. */
export function creationGuide(actor, api) {
  if (!ownsActor(actor.id) || !isCharacterType(actor.kind)) return null;
  if (!picked) {
    // Work out which types to list, then draw the sheet again.
    loadPicked(api).then(() => refreshSheets());
    return null;
  }
  const rows = rowsFor(actor);
  if (!rows.length || rows.every((r) => r.done)) return null;
  const hasScores = rows.some((r) => r.scores);
  const left = rows.filter((r) => !r.done).length;
  return el('section.creation-guide', { 'aria-label': 'New character' },
    el('div.creation-guide-head', {},
      el('strong', { text: `New character: ${left} step${left === 1 ? '' : 's'} left` }),
      hasScores && rows.some((r) => !r.scores)
        ? el('span.muted.small', { text: 'Any order works: bonuses from these are added on top of the scores you set.' }) : null),
    el('ol.creation-guide-steps', {}, ...rows.map((r) => el(`li${r.done ? '.done' : ''}`, {},
      el('span.creation-guide-mark', { text: r.done ? '✓' : '', 'aria-hidden': 'true' }),
      el('span.creation-guide-label', { text: r.label }),
      el('span.grow.creation-guide-what', { text: r.what }),
      r.done ? null : el('button.small.primary', { type: 'button', text: r.button, on: { click: () => r.run(api) } })))));
}
