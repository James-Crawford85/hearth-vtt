// How many cantrips and spells each caster class gains at each level (the 2024 rules' class tables),
// as level-up "pick" grants: the player picks from every spell in the collections whose `classes`
// include the class and whose level the class can cast yet. Used by gen-srd.mjs.
//
// Cleric, Druid, Paladin and Ranger prepare from their whole list each day; here they pick spells
// as their prepared count grows, and change them on the sheet (+ Add, or remove) after a Long Rest.

// Cantrips known at levels 1–20 (null: the class has none).
const CANTRIPS = {
  Bard: [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  Cleric: [3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
  Druid: [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  Sorcerer: [4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6],
  Warlock: [2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
  Wizard: [3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
};

// Prepared spells at levels 1–20 (for a Wizard: spells in the spellbook, 6 at level 1 and 2 a level).
const FULL = [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22];
const HALF = [2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15];
const SPELLS = {
  Bard: FULL,
  Cleric: FULL,
  Druid: FULL,
  Sorcerer: [2, 4, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22],
  Warlock: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15],
  Wizard: Array.from({ length: 20 }, (_, i) => 6 + 2 * i),
  Paladin: HALF,
  Ranger: HALF,
};

// The highest spell level the class can cast at levels 1–20.
const full = (l) => Math.min(9, Math.ceil(l / 2));
const MAX_LEVEL = {
  full, Bard: full, Cleric: full, Druid: full, Sorcerer: full, Wizard: full,
  Warlock: (l) => Math.min(5, Math.ceil(l / 2)), // Pact Magic; Mystic Arcanum (6th–9th) is its own feature
  Paladin: (l) => Math.min(5, Math.ceil(l / 4)),
  Ranger: (l) => Math.min(5, Math.ceil(l / 4)),
};

/** The class's spell picks for levels 1–20, or [] for a class without spells. */
export function spellGrants(className) {
  const key = className.toLowerCase();
  const out = [];
  const cantrips = CANTRIPS[className];
  const spells = SPELLS[className];
  if (!spells) return out;
  for (let level = 1; level <= 20; level++) {
    const c = cantrips ? cantrips[level - 1] - (cantrips[level - 2] ?? 0) : 0;
    if (c > 0) {
      out.push({ id: `${key}_cantrips_${level}`, level, kind: 'pick', count: c, from: 'spell', where: { classes: className, level: 0 },
        label: `${className} cantrip${c > 1 ? 's' : ''}: pick ${c}` });
    }
    const s = spells[level - 1] - (spells[level - 2] ?? 0);
    if (s > 0) {
      const max = MAX_LEVEL[className](level);
      const levels = Array.from({ length: max }, (_, i) => i + 1);
      const what = className === 'Wizard' ? 'for your spellbook' : 'to prepare';
      out.push({ id: `${key}_spells_${level}`, level, kind: 'pick', count: s, from: 'spell', where: { classes: className, level: levels },
        label: `${className} spells ${what}: pick ${s} (level ${max === 1 ? '1' : `1–${max}`})` });
    }
  }
  return out;
}

/** "Level 1 Evocation (Sorcerer, Wizard)" → ["Sorcerer", "Wizard"]: the classes in a spell's heading. */
export function classesOf(head) {
  const m = String(head).match(/\(([^)]*)\)/);
  return m ? m[1].split(/[,~]/).map((s) => s.trim()).filter((s) => /^[A-Z][a-z]+$/.test(s)) : [];
}
