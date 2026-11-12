// Generates the 5e SRD (5.2) reference system: builder.json, hearth.toml,
// content packs and the CC-BY attribution notice.
// Usage: node gen-srd.mjs <system folder>
import fs from 'fs';
import path from 'path';

const out = process.argv[2];
let seq = 0;
const id = () => `n${(++seq).toString(36)}`;
const N = (key, label, kind, extra = {}) => ({ id: id(), key, label, kind, ...extra });
const G = (key, label, children, extra = {}) => N(key, label, 'group', { children, ...extra });
const TAB = (key, label, children, extra = {}) => G(key, label, children, { flat: true, ...extra });
const PLACE = (key, label, place, children) => G(key, label, children, { flat: true, place });

const ABILITIES = [['str', 'Strength'], ['dex', 'Dexterity'], ['con', 'Constitution'], ['int', 'Intelligence'], ['wis', 'Wisdom'], ['cha', 'Charisma']];
const SKILLS = [
  ['acrobatics', 'Acrobatics', 'dex'], ['animal_handling', 'Animal Handling', 'wis'], ['arcana', 'Arcana', 'int'], ['athletics', 'Athletics', 'str'],
  ['deception', 'Deception', 'cha'], ['history', 'History', 'int'], ['insight', 'Insight', 'wis'], ['intimidation', 'Intimidation', 'cha'],
  ['investigation', 'Investigation', 'int'], ['medicine', 'Medicine', 'wis'], ['nature', 'Nature', 'int'], ['perception', 'Perception', 'wis'],
  ['performance', 'Performance', 'cha'], ['persuasion', 'Persuasion', 'cha'], ['religion', 'Religion', 'int'], ['sleight_of_hand', 'Sleight of Hand', 'dex'],
  ['stealth', 'Stealth', 'dex'], ['survival', 'Survival', 'wis'],
];
const opts = (...xs) => xs.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x[0].toUpperCase() + x.slice(1).replace(/_/g, ' ') }));
const EXH = ' - 2 * @exhaustion';

// ---------------------------------------------------------------- shared pieces of the actor types

const abilitiesList = () => N('abilities', 'Abilities', 'list', {
  hint: 'Click 🎲 for an ability check. Alt-click: advantage, Ctrl-click: disadvantage.',
  roll: '1d20 + @this.check',
  entries: ABILITIES.map(([k, l]) => ({ key: k, label: l })),
  children: [
    N('value', 'Score', 'number', { default: 10, min: 1, max: 30 }),
    N('mod', 'Modifier', 'formula', { formula: 'floor((@this.value - 10) / 2)' }),
    N('check', 'Check', 'formula', { formula: `@this.mod${EXH}` }),
  ],
});
const savesList = () => N('saves', 'Saving throws', 'list', {
  roll: '1d20 + @this.bonus',
  entries: ABILITIES.map(([k, l]) => ({ key: k, label: l })),
  children: [
    N('prof', 'Proficient', 'checkbox'),
    N('bonus', 'Bonus', 'formula', { formula: `@abilities[@key].mod + (@this.prof ? @prof : 0)${EXH}` }),
  ],
});
const skillsList = () => N('skills', 'Skills', 'list', {
  hint: 'Proficiency: 0 none, 1 proficient, 2 expertise.',
  roll: '1d20 + @this.bonus',
  entries: SKILLS.map(([k, l, a]) => ({ key: k, label: l, values: { ability: a } })),
  children: [
    N('ability', 'Ability', 'choice', { source: 'abilities' }),
    N('prof', 'Proficiency', 'number', { default: 0, min: 0, max: 2 }),
    N('bonus', 'Bonus', 'formula', { formula: `@abilities[@this.ability].mod + @this.prof * @prof${EXH}` }),
  ],
});
const initiative = () => [
  N('initiative', 'Initiative', 'formula', { formula: `@abilities.dex.mod${EXH}` }),
  N('roll_initiative', 'Roll initiative', 'action', { roll_kind: 'check', roll: '1d20 + @initiative' }),
];

// ---------------------------------------------------------------- the character

const character = N('player', 'Character', 'type', {
  width: 820,
  children: [
    PLACE('identity', 'Identity', 'header', [
      N('level', 'Level', 'formula', { formula: "sum_items('class', 'levels')" }),
      N('prof', 'Proficiency', 'formula', { formula: "table('proficiency', max(1, @level))" }),
      N('xp', 'Experience', 'number', { default: 0 }),
      N('alignment', 'Alignment', 'text'),
      N('size', 'Size', 'text', { default: 'Medium' }),
      N('inspiration', 'Inspiration', 'checkbox'),
    ]),
    PLACE('vitals', 'Vitals', 'vitals', [
      N('hp', 'HP', 'resource', { formula: "sum_items('class', 'hp_total') + @abilities.con.mod * @level", reset: { long: 'max' }, bar: true }),
      N('ac', 'AC', 'formula', { formula: '10 + @abilities.dex.mod' }),
    ]),
    TAB('main', 'Abilities', [
      { ...abilitiesList(), span: 99 },
      savesList(),
      skillsList(),
      N('passive_perception', 'Passive Perception', 'formula', { formula: '10 + @skills.perception.bonus', display: 'inline' }),
    ], { icon: 'strength', columns: 2 }),
    TAB('combat', 'Combat', [
      G('defense', 'In the fight', [
        N('initiative', 'Initiative', 'formula', { formula: `@abilities.dex.mod${EXH}`, display: 'big' }),
        N('speed', 'Speed', 'formula', { formula: 'max(0, @speed_base - 5 * @exhaustion)', display: 'big' }),
        N('temp_hp', 'Temp HP', 'number', { default: 0, display: 'big' }),
        N('roll_initiative', 'Roll initiative', 'action', { roll_kind: 'check', roll: '1d20 + @initiative' }),
      ], { flat: true, frame: 'card', columns: 4 }),
      G('recovery', 'Recovery', [
        N('hit_dice', 'Hit Point Dice', 'resource', { formula: '@level', reset: { long: 'max' } }),
        N('spend_hit_die', 'Spend a Hit Point Die', 'action', { roll_kind: 'heal', roll: "1d{max_items('class', 'hit_die')} + @abilities.con.mod", cost: { path: 'hit_dice', amount: '1' } }),
        N('exhaustion', 'Exhaustion', 'number', { default: 0, min: 0, max: 6, hint: 'Each level: −2 to d20 tests, −5 ft speed. 6 is death.' }),
        N('speed_base', 'Base speed', 'number', { default: 30, hint: 'Set by your species.' }),
      ], { flat: true, frame: 'card', columns: 2 }),
      G('death', 'Death saves', [
        N('successes', 'Successes', 'number', { default: 0, min: 0, max: 3 }),
        N('failures', 'Failures', 'number', { default: 0, min: 0, max: 3 }),
        N('death_save', 'Death save', 'action', { roll_kind: 'other', roll: '1d20' }),
      ], { frame: 'card', columns: 3 }),
    ], { icon: 'combat', columns: 1 }),
    G('spellcasting', 'Spells', [
      N('ability', 'Spellcasting ability', 'choice', { source: 'abilities', hint: 'Your class sets this.' }),
      N('caster_level', 'Spellcaster level', 'formula', { formula: "sum_items('class', 'caster_levels')", display: 'big' }),
      N('dc', 'Spell save DC', 'formula', { formula: '8 + @prof + @abilities[@spellcasting.ability].mod', display: 'big' }),
      N('attack', 'Spell attack bonus', 'formula', { formula: '@prof + @abilities[@spellcasting.ability].mod', display: 'big' }),
      G('slots', 'Spell slots', Array.from({ length: 9 }, (_, i) =>
        N(`l${i + 1}`, `Level ${i + 1}`, 'resource', { formula: `table('spell_slots', @spellcasting.caster_level)[${i}]`, reset: { long: 'max' } })), { frame: 'card', columns: 3 }),
    ], { icon: 'wand', columns: 4 }),
    TAB('classes', 'Classes', [], { icon: 'tower' }),
    TAB('features', 'Features', [
      N('languages', 'Languages', 'text', { default: 'Common', span: 2 }),
      N('training', 'Equipment training and proficiencies', 'longtext'),
    ], { icon: 'star' }),
    TAB('inventory', 'Equipment', [
      G('currency', 'Coins', ['cp', 'sp', 'ep', 'gp', 'pp'].map((c) => N(c, c.toUpperCase(), 'number', { default: 0 })), { frame: 'card', columns: 5, span: 3 }),
      N('carry', 'Carrying capacity (lb.)', 'formula', { formula: '@abilities.str.value * 15', display: 'big' }),
    ], { icon: 'shield', columns: 4 }),
    TAB('details', 'Journal', [
      N('appearance', 'Appearance', 'longtext'),
      N('personality', 'Personality', 'longtext'),
      N('notes', 'Notes', 'longtext'),
    ], { icon: 'journal', columns: 1 }),
  ],
});

// ---------------------------------------------------------------- monsters and NPCs

const npc = N('enemy', 'Monster / NPC', 'type', {
  width: 760,
  children: [
    PLACE('identity', 'Identity', 'header', [
      N('size', 'Size', 'text', { default: 'Medium' }),
      N('creature_type', 'Type', 'text', { default: 'Humanoid' }),
      N('alignment', 'Alignment', 'text'),
      N('cr', 'CR', 'number', { default: 0, hint: '¼ = 0.25, ½ = 0.5' }),
      N('prof', 'Proficiency', 'formula', { formula: "table('cr_prof', @cr)" }),
      N('xp', 'XP', 'formula', { formula: "table('cr_xp', @cr)" }),
    ]),
    PLACE('vitals', 'Vitals', 'vitals', [
      N('hp', 'HP', 'resource', { default: 10, bar: true, reset: { long: 'max' } }),
      N('ac', 'AC', 'number', { default: 10 }),
    ]),
    TAB('stats', 'Stat block', [
      N('speed', 'Speed (ft.)', 'number', { default: 30 }),
      N('speed_other', 'Other speeds', 'text', { hint: 'e.g. fly 60 ft., swim 30 ft.' }),
      ...initiative(),
      { ...abilitiesList(), span: 99 },
      { ...savesList(), span: 2 },
      N('skills_text', 'Skills', 'text', { hint: 'e.g. Stealth +6', span: 2 }),
      N('senses', 'Senses', 'text', { default: 'Passive Perception 10', span: 2 }),
      N('languages', 'Languages', 'text', { span: 2 }),
      N('exhaustion', 'Exhaustion', 'number', { default: 0, min: 0, max: 6 }),
      N('notes', 'Traits and tactics', 'longtext', { hint: 'Attacks and abilities are on the Items tab.' }),
    ], { icon: 'skull', columns: 4 }),
  ],
});

// ---------------------------------------------------------------- item types

const description = () => N('description', 'Description', 'longtext');
const ASI = 'Ability Score Improvement (+2 to one score or +1 to two, max 20)';
const item = (key, label, children, extra = {}) => N(key, label, 'type', { children, ...extra });

const classType = item('class', 'Class', [
  N('levels', 'Levels', 'number', { default: 0 }),
  N('hit_die', 'Hit die size', 'number', { default: 8, hint: '6, 8, 10 or 12' }),
  N('caster', 'Spellcasting', 'choice', { options: opts(['none', 'None'], ['full', 'Full caster'], ['half', 'Half caster'], ['third', 'Third caster']) }),
  N('primary', 'Primary ability', 'text'),
  N('hp_total', 'Hit points from this class', 'formula', { formula: 'sum(@item.hp_rolls)' }),
  N('caster_levels', 'Spellcaster levels', 'formula', { formula: "@item.caster == 'full' ? @item.levels : @item.caster == 'half' ? ceil(@item.levels / 2) : @item.caster == 'third' ? ceil(@item.levels / 3) : 0" }),
  description(),
], {
  grants: true,
  levels: 'levels',
  // Every new class made with "+ New item" starts with these; add its features and subclass.
  advancement: [
    // The full hit die only at the character's first level (a multiclass's first level rolls).
    { id: 'hp1', level: 1, kind: 'roll', label: 'Hit points', formula: '@item.hit_die', path: 'hp_rolls', when: '@level == 1' },
    { id: 'hp', level: 1, every: 1, kind: 'roll', label: 'Hit points', formula: '1d{@item.hit_die}', path: 'hp_rolls', average: true, when: '@level > 1' },
    { id: 'asi', level: 4, every: 4, until: 16, kind: 'points', label: ASI, path: 'abilities', field: 'value', amount: 2, max_each: 2, cap: 20 },
    { id: 'boon', level: 19, kind: 'points', label: 'Epic Boon (or +2 to one score / +1 to two, max 30)', path: 'abilities', field: 'value', amount: 2, max_each: 2, cap: 30 },
  ],
});

const subclassType = item('subclass', 'Subclass', [N('class_name', 'Class', 'text'), description()], { grants: true });

const species = item('race', 'Species', [
  N('size', 'Size', 'text', { default: 'Medium' }),
  N('speed', 'Speed (ft.)', 'number', { default: 30 }),
  description(),
  N('speed_effect', 'Sets your speed', 'effect', { changes: [{ path: 'speed_base', mode: 'set', value: '@item.speed' }] }),
], { grants: true });

const background = item('background', 'Background', [N('feat', 'Origin feat', 'text'), N('tools', 'Tool proficiency', 'text'), description()], { grants: true });

const feat = item('feat', 'Feat', [
  N('category', 'Category', 'choice', { options: opts(['origin', 'Origin'], ['general', 'General'], ['fighting_style', 'Fighting Style'], ['epic_boon', 'Epic Boon']) }),
  N('prerequisite', 'Prerequisite', 'text'),
  N('repeatable', 'Repeatable', 'checkbox'),
  description(),
]);

const feature = item('feature', 'Feature', [
  N('source', 'From', 'text'),
  N('activation', 'Activation', 'text', { hint: 'Action, Bonus Action, Reaction…' }),
  N('uses', 'Uses', 'resource', { default: 0, reset: { short: "@item.recharge == 'short' ? @max : @item.recharge == 'short_one' ? @value + 1 : @value", long: 'max' } }),
  N('recharge', 'Recharges on', 'choice', { options: opts(['long', 'Long rest'], ['short', 'Short or long rest'], ['short_one', 'One on a short rest, all on a long rest']) }),
  N('roll', 'Roll', 'text', { hint: 'Optional, e.g. 1d10 + @level' }),
  description(),
  N('use', 'Use', 'action', { roll_kind: 'other', roll: '@item.roll', cost: { path: 'uses', amount: '1' }, when: '@item.uses.max > 0' }),
  N('roll_it', 'Roll', 'action', { roll_kind: 'other', roll: '@item.roll', when: "@item.uses.max == 0 && @item.roll != ''" }),
]);

const DAMAGE_TYPES = opts('acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder');

const weapon = item('weapon', 'Weapon', [
  N('category', 'Category', 'choice', { options: opts(['simple', 'Simple'], ['martial', 'Martial']) }),
  N('range_type', 'Melee or ranged', 'choice', { options: opts(['melee', 'Melee'], ['ranged', 'Ranged']) }),
  N('damage', 'Damage', 'text', { default: '1d6' }),
  N('damage_type', 'Damage type', 'choice', { options: DAMAGE_TYPES, default: 'slashing' }),
  N('versatile', 'Two-handed damage (Versatile)', 'text'),
  N('finesse', 'Finesse', 'checkbox'),
  N('properties', 'Other properties', 'text'),
  N('mastery', 'Mastery', 'text'),
  N('range', 'Range', 'text'),
  N('proficient', 'Proficient', 'checkbox', { default: true }),
  N('bonus', 'Magic bonus', 'number', { default: 0 }),
  N('equipped', 'Equipped', 'checkbox'),
  N('weight', 'Weight (lb.)', 'number', { default: 0 }),
  N('mod', 'Ability modifier used', 'formula', { formula: "@item.finesse ? max(@abilities.str.mod, @abilities.dex.mod) : @item.range_type == 'ranged' ? @abilities.dex.mod : @abilities.str.mod" }),
  N('attack', 'Attack bonus', 'formula', { formula: `@item.mod + (@item.proficient ? @prof : 0) + @item.bonus + (@item.range_type == 'ranged' ? @bonuses.ranged_attack : @bonuses.melee_attack)${EXH}` }),
  N('dmg', 'Damage bonus', 'formula', { formula: "@item.mod + @item.bonus + (@item.range_type == 'ranged' ? @bonuses.ranged_damage : @bonuses.melee_damage)" }),
  N('attack_roll', 'Attack', 'action', { roll_kind: 'attack', roll: '1d20 + @item.attack', then: ['damage_roll', 'versatile_roll'] }),
  N('damage_roll', 'Damage', 'action', { roll_kind: 'damage', roll: '@item.damage + @item.dmg' }),
  N('versatile_roll', 'Damage (two hands)', 'action', { roll_kind: 'damage', roll: '@item.versatile + @item.dmg', when: "@item.versatile != ''" }),
]);

const armor = item('armor', 'Armor', [
  N('category', 'Category', 'choice', { options: opts(['light', 'Light'], ['medium', 'Medium'], ['heavy', 'Heavy'], ['shield', 'Shield']) }),
  N('base_ac', 'Armor Class (shield: bonus)', 'number', { default: 11 }),
  N('dex_cap', 'Most Dexterity added', 'number', { default: 99, hint: 'Light 99 (no limit), medium 2, heavy 0' }),
  N('strength', 'Strength needed', 'number', { default: 0 }),
  N('stealth', 'Disadvantage on Stealth', 'checkbox'),
  N('equipped', 'Worn', 'checkbox'),
  N('weight', 'Weight (lb.)', 'number', { default: 0 }),
  description(),
  N('armor_ac', 'Armor sets AC', 'effect', { when: "@item.equipped && @item.category != 'shield'", changes: [{ path: 'ac', mode: 'upgrade', value: '@item.base_ac + min(@abilities.dex.mod, @item.dex_cap)' }] }),
  N('shield_ac', 'Shield adds to AC', 'effect', { when: "@item.equipped && @item.category == 'shield'", changes: [{ path: 'ac', mode: 'add', value: '@item.base_ac' }] }),
]);

const CANTRIP_TIER = '(@level >= 17 ? 3 : @level >= 11 ? 2 : @level >= 5 ? 1 : 0)';
const spell = item('spell', 'Spell', [
  N('level', 'Level', 'number', { default: 1, hint: 'Spell level; 0 for a cantrip' }),
  N('school', 'School', 'choice', { options: opts('abjuration', 'conjuration', 'divination', 'enchantment', 'evocation', 'illusion', 'necromancy', 'transmutation') }),
  N('casting_time', 'Casting time', 'text', { default: 'Action' }),
  N('range', 'Range', 'text'),
  N('components', 'Components', 'text', { default: 'V, S' }),
  N('duration', 'Duration', 'text', { default: 'Instantaneous' }),
  N('concentration', 'Concentration', 'checkbox'),
  N('ritual', 'Ritual', 'checkbox'),
  N('prepared', 'Prepared', 'checkbox', { default: true }),
  N('attack', 'Spell attack', 'choice', { options: opts(['none', 'None'], ['melee', 'Melee'], ['ranged', 'Ranged']) }),
  N('save', 'Saving throw', 'choice', { options: opts(['none', 'None'], ...ABILITIES.map(([k, l]) => [k, l])) }),
  N('dice', 'Number of dice', 'number', { default: 0 }),
  N('die', 'Die size', 'number', { default: 6 }),
  N('add_mod', 'Add spellcasting modifier', 'checkbox'),
  N('plus', 'Flat bonus', 'number', { default: 0 }),
  N('per_level', 'Extra dice per slot level above', 'number', { default: 0 }),
  N('cantrip', 'Cantrip: more dice at levels 5, 11 and 17', 'checkbox'),
  N('damage_type', 'Damage type', 'choice', { options: [{ value: 'healing', label: 'Healing' }, ...DAMAGE_TYPES] }),
  N('save_dc', 'Save DC', 'formula', { formula: "@item.save == 'none' ? 0 : @spellcasting.dc" }),
  description(),
  N('cast', 'Cast', 'action', { roll_kind: 'other', roll: '', cost: { path: 'actor.spellcasting.slots.l{max(@cast_level || 0, @item.level)}', amount: '1' }, when: '@item.level > 0 && @item.prepared' }),
  N('spell_attack', 'Spell attack', 'action', { roll_kind: 'attack', roll: '1d20 + {@spellcasting.attack - 2 * @exhaustion}', when: "@item.attack != 'none'", then: ['effect'] }),
  N('effect', 'Damage / healing', 'action', {
    roll_kind: 'damage',
    roll: `{@item.cantrip ? @item.dice * (1 + ${CANTRIP_TIER}) : @item.dice + max(0, (@cast_level || @item.level) - @item.level) * @item.per_level}d{@item.die}{@item.plus + (@item.add_mod ? @abilities[@spellcasting.ability].mod : 0) == 0 ? '' : ' + ' + (@item.plus + (@item.add_mod ? @abilities[@spellcasting.ability].mod : 0))}`,
    when: '@item.dice > 0',
  }),
]);

const equipment = item('item', 'Equipment', [
  N('quantity', 'Quantity', 'number', { default: 1 }),
  N('weight', 'Weight (lb.)', 'number', { default: 0 }),
  N('cost', 'Cost', 'text'),
  N('equipped', 'Equipped', 'checkbox'),
  description(),
]);

// ---------------------------------------------------------------- rules

const SLOTS = {
  1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1], 8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2],
  11: [4, 3, 3, 3, 2, 1], 13: [4, 3, 3, 3, 2, 1, 1], 15: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1],
  18: [4, 3, 3, 3, 3, 1, 1, 1, 1], 19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1],
};
const pad = (a) => [...a, ...Array(9 - a.length).fill(0)];
const tables = {
  proficiency: { 1: 2, 5: 3, 9: 4, 13: 5, 17: 6 },
  spell_slots: Object.fromEntries(Object.entries(SLOTS).map(([k, v]) => [k, pad(v)])),
  cr_prof: { 0: 2, 5: 3, 9: 4, 13: 5, 17: 6, 21: 7, 25: 8, 29: 9 },
  cr_xp: { 0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000 },
};
// Condition summaries (SRD 5.2, CC-BY-4.0), shown on hover and in the Ctrl+Space lookup.
const CONDITION_TEXT = {
  blinded: "- You can't see, and you automatically fail any ability check that needs sight.\n- Attack rolls against you have **Advantage**; your attack rolls have **Disadvantage**.",
  charmed: "- You can't attack the charmer or target them with damaging abilities or magical effects.\n- The charmer has **Advantage** on ability checks to interact with you socially.",
  deafened: "- You can't hear, and you automatically fail any ability check that needs hearing.",
  frightened: "- **Disadvantage** on ability checks and attack rolls while the source of your fear is within line of sight.\n- You can't willingly move closer to the source of your fear.",
  grappled: "- Your Speed is 0 and can't increase.\n- **Disadvantage** on attack rolls against any target other than the grappler.\n- The grappler can drag or carry you when it moves, at the cost of 1 extra foot of movement for every foot (unless you are Tiny or two or more sizes smaller).\n\nIt ends if the grappler is [[Incapacitated]] or you end up out of its reach. See [[Grappling]].",
  incapacitated: "- You can't take any action, Bonus Action or Reaction.\n- Your [[Concentration]] is broken.\n- You can't speak.\n- If you're Incapacitated when you roll Initiative, you roll with **Disadvantage**.",
  invisible: "- **Advantage** on Initiative rolls.\n- You aren't affected by anything that needs its target to be seen, unless its creator can somehow see you. Gear you wear or carry is also concealed.\n- Attack rolls against you have **Disadvantage**, and yours have **Advantage**, unless the attacker can somehow see you.",
  paralyzed: "- You are [[Incapacitated]].\n- Your Speed is 0 and can't increase.\n- You automatically fail Strength and Dexterity saving throws.\n- Attack rolls against you have **Advantage**.\n- Any attack that hits you is a **Critical Hit** if the attacker is within 5 feet of you.",
  petrified: "- You and your nonmagical gear turn to a solid substance such as stone. Your weight increases tenfold and you stop aging.\n- You are [[Incapacitated]], and your Speed is 0.\n- Attack rolls against you have **Advantage**.\n- You automatically fail Strength and Dexterity saving throws.\n- You have **Resistance** to all damage, and **Immunity** to the [[Poisoned]] condition.",
  poisoned: "- **Disadvantage** on attack rolls and ability checks.",
  prone: "- Your only movement options are to crawl, or to spend movement equal to half your Speed (rounded down) to stand up and end the condition.\n- **Disadvantage** on attack rolls.\n- Attack rolls against you have **Advantage** if the attacker is within 5 feet of you; otherwise they have **Disadvantage**.",
  restrained: "- Your Speed is 0 and can't increase.\n- Attack rolls against you have **Advantage**, and your attack rolls have **Disadvantage**.\n- **Disadvantage** on Dexterity saving throws.",
  stunned: "- You are [[Incapacitated]].\n- You automatically fail Strength and Dexterity saving throws.\n- Attack rolls against you have **Advantage**.",
  unconscious: "- You are [[Incapacitated]] and [[Prone]], and you drop whatever you're holding. When the condition ends, you remain Prone.\n- Your Speed is 0 and can't increase.\n- You automatically fail Strength and Dexterity saving throws.\n- Attack rolls against you have **Advantage**.\n- Any attack that hits you is a **Critical Hit** if the attacker is within 5 feet of you.\n- You're unaware of your surroundings.",
};
const set = (p, v) => ({ path: p, mode: 'set', value: v });
const disAttack = set('mods.attack.disadvantage', '1');
const disCheck = set('mods.check.disadvantage', '1');
const noSpeed = set('speed', '0');
const conditions = [
  ['blinded', 'Blinded', [disAttack]],
  ['charmed', 'Charmed', []],
  ['deafened', 'Deafened', []],
  ['frightened', 'Frightened', [disAttack, disCheck]],
  ['grappled', 'Grappled', [noSpeed]],
  ['incapacitated', 'Incapacitated', []],
  ['invisible', 'Invisible', [set('mods.attack.advantage', '1')]],
  ['paralyzed', 'Paralyzed', [noSpeed]],
  ['petrified', 'Petrified', [noSpeed]],
  ['poisoned', 'Poisoned', [disAttack, disCheck]],
  ['prone', 'Prone', [disAttack]],
  ['restrained', 'Restrained', [noSpeed, disAttack]],
  ['stunned', 'Stunned', [noSpeed]],
  ['unconscious', 'Unconscious', [noSpeed]],
].map(([cid, name, changes]) => ({ id: cid, name, changes, description: CONDITION_TEXT[cid] }));

const onSheet = (t, extra) => Object.assign(t, extra);
onSheet(classType, { list_title: 'Classes', tab: 'classes', summary: ['caster'] });
onSheet(subclassType, { list_title: 'Subclasses', tab: 'classes', summary: ['class_name'] });
onSheet(species, { tab: 'classes', summary: ['size', 'speed'] });
onSheet(background, { tab: 'classes', summary: ['feat'] });
onSheet(feat, { list_title: 'Feats', tab: 'features', group_by: 'category', summary: ['prerequisite'] });
onSheet(feature, { list_title: 'Features', tab: 'features', summary: ['source', 'activation', 'uses'] });
onSheet(weapon, { list_title: 'Weapons', tab: 'inventory', summary: ['damage', 'damage_type', 'range', 'equipped'] });
onSheet(armor, { tab: 'inventory', summary: ['category', 'base_ac', 'equipped'] });
onSheet(spell, { list_title: 'Spellbook', tab: 'spellcasting', group_by: 'level', summary: ['school', 'casting_time', 'concentration', 'ritual', 'prepared'] });
onSheet(equipment, { list_title: 'Gear', tab: 'inventory', summary: ['quantity', 'weight', 'equipped'] });

// The look: "Dark and gold" from the Sheet style presets.
const style = { background: '#1b1b1d', header: '#141416', box: '#252527', raised: '#313134', input: '#1e1e20', accent: '#d9a52b', text: '#ebe8e3', muted: '#9c978f', border: '#3b3b3f', button: '#8e1d1d', heading_font: '"Trebuchet MS", sans-serif', radius: 6 };

// Character creation: how ability scores are set (each world picks from these and can change the numbers).
const creation = [{"id":"abilities","label":"Ability scores","path":"abilities","field":"value","actor_types":["player"],"methods":[{"id":"array","kind":"array","label":"Standard array","values":[15,14,13,12,10,8]},{"id":"points","kind":"pointbuy","label":"Point buy","points":27,"min":8,"max":15,"costs":{"8":0,"9":1,"10":2,"11":3,"12":4,"13":5,"14":7,"15":9}},{"id":"4d6","kind":"roll","label":"Roll 4d6, drop the lowest","formula":"4d6kh3"},{"id":"3d6","kind":"roll","label":"Roll 3d6 in order","formula":"3d6","in_order":true},{"id":"manual","kind":"manual","label":"Enter your own","min":3,"max":18}]}];

const blueprint = {
  style,
  creation,
  version: 1,
  rests: ['short', 'long'],
  tables,
  conditions,
  actor_types: [character, npc],
  item_types: [classType, subclassType, species, background, feat, feature, weapon, armor, spell, equipment],
};

// ---------------------------------------------------------------- content

let iseq = 0;
const iid = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${(++iseq).toString(36)}`;
const doc = (kind, name, data = {}, extra = {}) => ({ id: iid(name), name, kind, data, flags: {}, effects: [], ...extra });
const fx = (name, changes, requires = null) => ({ id: iid(name), name, changes, requires });
const featureDoc = (name, source, description, data = {}, extra = {}) => doc('feature', name, { source, description, activation: '', uses: { value: 0, max: 0 }, recharge: 'long', roll: '', ...data }, extra);
const usesN = (n, recharge = 'long', roll = '', activation = '') => ({ uses: { value: n, max: n }, recharge, roll, activation });
const grant = (gid, level, label, kind, rest) => ({ id: gid, level, label, kind, ...rest });
const asi = (gid, level, extra = {}) => grant(gid, level, ASI, 'points', { path: 'abilities', field: 'value', amount: 2, max_each: 2, cap: 20, ...extra });
const hp = (cls, die) => [
  grant(`${cls}_hp1`, 1, 'Hit points', 'roll', { formula: '@item.hit_die', path: 'hp_rolls', when: '@level == 1' }),
  grant(`${cls}_hp`, 1, 'Hit points', 'roll', { formula: '1d{@item.hit_die}', path: 'hp_rolls', average: true, every: 1, when: '@level > 1' }),
];

const featDoc = (name, category, description, effects = []) => doc('feat', name, { category, prerequisite: '', repeatable: false, description }, { effects });
const FEATS = {
  alert: featDoc('Alert', 'origin', 'Add your Proficiency Bonus to Initiative. You can swap Initiative with a willing ally right after rolling.', [fx('Alert', [{ path: 'initiative', mode: 'add', value: '@prof' }])]),
  skilled: featDoc('Skilled', 'origin', 'Gain proficiency in any combination of three skills or tools of your choice.'),
  savage: featDoc('Savage Attacker', 'origin', 'Once per turn when you hit with a weapon, roll its damage dice twice and use either result.'),
  magic_initiate: featDoc('Magic Initiate', 'origin', 'Learn two cantrips and one level 1 spell from the Cleric, Druid or Wizard list; cast the level 1 spell once per long rest without a slot.'),
  archery: featDoc('Archery', 'fighting_style', '+2 to attack rolls with Ranged weapons.', [fx('Archery', [{ path: 'bonuses.ranged_attack', mode: 'add', value: '2' }])]),
  defense: featDoc('Defense', 'fighting_style', '+1 to Armor Class while you wear armor.', [fx('Defense', [{ path: 'ac', mode: 'add', value: '1' }])]),
  great_weapon: featDoc('Great Weapon Fighting', 'fighting_style', 'Treat a 1 or 2 on a damage die as a 3 with two-handed or versatile weapons held in two hands.'),
  two_weapon: featDoc('Two-Weapon Fighting', 'fighting_style', 'When you make an extra attack with a Light weapon, add your ability modifier to its damage.'),
};
const skillChoice = (gid, level, label, n, only) => grant(gid, level, label, 'points', { path: 'skills', field: 'prof', amount: n, max_each: 1, cap: 1, ...(only ? { only } : {}) });

const champion = doc('subclass', 'Champion', { class_name: 'Fighter', description: 'A warrior who hones raw physical power to deadly perfection.' }, {
  advancement: [
    grant('champion_3', 3, 'Champion features', 'items', { items: [
      featureDoc('Improved Critical', 'Champion 3', 'Your weapon and Unarmed Strike attacks score a Critical Hit on a roll of 19 or 20.'),
      featureDoc('Remarkable Athlete', 'Champion 3', 'Advantage on Initiative and Strength (Athletics) checks; after a Critical Hit you can move up to half your Speed without provoking Opportunity Attacks.'),
    ] }),
  ],
});
const fighter = doc('class', 'Fighter', { levels: 0, hit_die: 10, caster: 'none', primary: 'Strength or Dexterity', description: 'A master of martial combat, skilled with a variety of weapons and armor.' }, {
  effects: [fx('Fighter saving throws', [{ path: 'saves.str.prof', mode: 'upgrade', value: '1' }, { path: 'saves.con.prof', mode: 'upgrade', value: '1' }])],
  advancement: [
    ...hp('fighter', 10),
    skillChoice('fighter_skills', 1, 'Skill proficiencies (choose 2: Acrobatics, Animal Handling, Athletics, History, Insight, Intimidation, Persuasion, Perception or Survival)', 2, ['acrobatics', 'animal_handling', 'athletics', 'history', 'insight', 'intimidation', 'persuasion', 'perception', 'survival']),
    grant('fighter_1', 1, 'Fighter 1', 'items', { items: [
      featureDoc('Second Wind', 'Fighter 1', 'Bonus Action: regain 1d10 + your Fighter level Hit Points. Regain one use on a Short Rest and all on a Long Rest.', usesN(2, 'short_one', '1d10 + @class_level', 'Bonus Action')),
      featureDoc('Weapon Mastery', 'Fighter 1', 'Use the mastery properties of three kinds of Simple or Martial weapons of your choice; change one on a Long Rest.'),
    ] }),
    grant('fighter_style', 1, 'Fighting Style', 'choice', { count: 1, items: [FEATS.archery, FEATS.defense, FEATS.great_weapon, FEATS.two_weapon] }),
    grant('fighter_2', 2, 'Fighter 2', 'items', { items: [
      featureDoc('Action Surge', 'Fighter 2', 'On your turn, take one additional action (not Magic). Once per Short or Long Rest.', usesN(1, 'short', '', 'Free')),
      featureDoc('Tactical Mind', 'Fighter 2', 'When you fail an ability check, spend a use of Second Wind to add 1d10 to it; if it still fails, the use is not spent.'),
    ] }),
    grant('fighter_sub', 3, 'Fighter subclass', 'choice', { count: 1, items: [champion] }),
    asi('fighter_asi', 4, { every: 4, until: 16 }),
    asi('fighter_asi6', 6),
    asi('fighter_asi14', 14),
    asi('fighter_asi19', 19),
    grant('fighter_5', 5, 'Fighter 5', 'items', { items: [
      featureDoc('Extra Attack', 'Fighter 5', 'Attack twice instead of once whenever you take the Attack action.'),
      featureDoc('Tactical Shift', 'Fighter 5', 'When you use Second Wind, you can move up to half your Speed without provoking Opportunity Attacks.'),
    ] }),
  ],
});

const evoker = doc('subclass', 'Evoker', { class_name: 'Wizard', description: 'A wizard who studies magic that creates powerful elemental effects.' }, {
  advancement: [grant('evoker_3', 3, 'Evoker features', 'items', { items: [
    featureDoc('Evocation Savant', 'Evoker 3', 'Add two Evocation spells of level 2 or lower to your spellbook for free, and one more whenever you gain a new spell slot level.'),
    featureDoc('Potent Cantrip', 'Evoker 3', 'When a creature succeeds on a save against your cantrip, or you miss with one, it still takes half the damage.'),
  ] })],
});
const wizard = doc('class', 'Wizard', { levels: 0, hit_die: 6, caster: 'full', primary: 'Intelligence', description: 'A scholarly magic-user who masters spells through study, recorded in a spellbook.' }, {
  effects: [fx('Wizard spellcasting', [
    { path: 'spellcasting.ability', mode: 'set', value: "'int'" },
    { path: 'saves.int.prof', mode: 'upgrade', value: '1' }, { path: 'saves.wis.prof', mode: 'upgrade', value: '1' }])],
  advancement: [
    ...hp('wizard', 6),
    asi('wizard_asi', 4, { every: 4, until: 16 }),
    asi('wizard_asi19', 19),
    skillChoice('wizard_skills', 1, 'Skill proficiencies (choose 2: Arcana, History, Insight, Investigation, Medicine, Nature or Religion)', 2, ['arcana', 'history', 'insight', 'investigation', 'medicine', 'nature', 'religion']),
    grant('wizard_1', 1, 'Wizard 1', 'items', { items: [
      featureDoc('Spellcasting', 'Wizard 1', 'You cast Wizard spells using Intelligence, preparing them from your spellbook. Your spell slots are on the Spellcasting part of your sheet.'),
      featureDoc('Ritual Adept', 'Wizard 1', 'Cast any Ritual spell in your spellbook as a Ritual without preparing it.'),
      featureDoc('Arcane Recovery', 'Wizard 1', 'Once per day after a Short Rest, recover spell slots with a combined level up to half your Wizard level (rounded up), none above level 5.', usesN(1, 'long')),
    ] }),
    grant('wizard_2', 2, 'Wizard 2', 'items', { items: [featureDoc('Scholar', 'Wizard 2', 'Gain Expertise in one of Arcana, History, Investigation, Medicine, Nature or Religion in which you are proficient.')] }),
    grant('wizard_sub', 3, 'Wizard subclass', 'choice', { count: 1, items: [evoker] }),
  ],
});

// The rest of the SRD 5.2 classes, levels 1–5 (summaries in our own words), each with its SRD subclass.
// f(name, description, uses?) is a feature at the level it's listed under.
const ABIL = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
const SK = { acrobatics: 'Acrobatics', animal_handling: 'Animal Handling', arcana: 'Arcana', athletics: 'Athletics', deception: 'Deception', history: 'History', insight: 'Insight', intimidation: 'Intimidation', investigation: 'Investigation', medicine: 'Medicine', nature: 'Nature', perception: 'Perception', performance: 'Performance', persuasion: 'Persuasion', religion: 'Religion', sleight_of_hand: 'Sleight of Hand', stealth: 'Stealth', survival: 'Survival' };
const mkClass = (c) => {
  const key = c.name.toLowerCase();
  const feats = (lvl, list, owner) => list.map(([n, d, u]) => featureDoc(n, `${owner} ${lvl}`, d, u ?? {}));
  const sub = doc('subclass', c.sub.name, { class_name: c.name, description: c.sub.desc }, {
    advancement: Object.entries(c.sub.levels).map(([lvl, list]) => grant(`${key}_sub_${lvl}`, Number(lvl), `${c.sub.name} features`, 'items', { items: feats(lvl, list, c.sub.name) })),
  });
  const changes = c.saves.map((s) => ({ path: `saves.${s}.prof`, mode: 'upgrade', value: '1' }));
  if (c.ability) changes.unshift({ path: 'spellcasting.ability', mode: 'set', value: `'${c.ability}'` });
  const only = c.skills[1] ?? Object.keys(SK);
  const cls = doc('class', c.name, { levels: 0, hit_die: c.die, caster: c.caster ?? 'none', primary: c.primary, description: c.desc }, {
    effects: [fx(`${c.name} proficiencies`, changes), ...(c.effects ?? [])],
    advancement: [
      ...hp(key, c.die),
      asi(`${key}_asi`, 4, { every: 4, until: 16 }),
      ...(c.extraAsi ?? []).map((l) => asi(`${key}_asi${l}`, l)),
      asi(`${key}_asi19`, 19),
      skillChoice(`${key}_skills`, 1, `Skill proficiencies (choose ${c.skills[0]}${c.skills[1] ? `: ${only.map((s) => SK[s]).join(', ')}` : ', any'})`, c.skills[0], c.skills[1]),
      ...Object.entries(c.levels).map(([lvl, list]) => grant(`${key}_${lvl}`, Number(lvl), `${c.name} ${lvl}`, 'items', { items: feats(lvl, list, c.name) })),
      ...(c.style ? [grant(`${key}_style`, c.style, 'Fighting Style', 'choice', { count: 1, items: [FEATS.archery, FEATS.defense, FEATS.great_weapon, FEATS.two_weapon] })] : []),
      grant(`${key}_sub`, 3, `${c.name} subclass`, 'choice', { count: 1, items: [sub] }),
    ],
  });
  return [cls, sub];
};
const spellcasting = (cls, abil, how) => ['Spellcasting', `You cast ${cls} spells using ${ABIL[abil]}${how ? `; ${how}` : ''}. Your spell slots are on the Spells tab.`];

const MORE_CLASSES = [
  mkClass({ name: 'Barbarian', die: 12, primary: 'Strength', saves: ['str', 'con'], desc: 'A fierce warrior who draws on primal fury in battle.',
    skills: [2, ['animal_handling', 'athletics', 'intimidation', 'nature', 'perception', 'survival']],
    effects: [fx('Unarmored Defense', [{ path: 'ac', mode: 'upgrade', value: '10 + @abilities.dex.mod + @abilities.con.mod' }])],
    levels: {
      1: [['Rage', 'Bonus Action, while not in Heavy armor: Resistance to Bludgeoning, Piercing and Slashing damage, +2 damage on Strength attacks, Advantage on Strength checks and saves; no spellcasting or Concentration. Lasts 10 minutes if you keep it going (attack, force a save, or use a Bonus Action). You regain one use on a Short Rest and all on a Long Rest.', usesN(2, 'short_one', '', 'Bonus Action')],
        ['Unarmored Defense', 'Without armor, your AC is 10 + Dexterity + Constitution modifiers (a Shield still adds). Already worked into your AC.'],
        ['Weapon Mastery', 'Use the mastery properties of two kinds of Simple or Martial Melee weapons; change one on a Long Rest.']],
      2: [['Danger Sense', 'Advantage on Dexterity saving throws unless you are Incapacitated.'], ['Reckless Attack', 'On your first attack of a turn, attack with Advantage on Strength attacks this turn; attacks against you have Advantage until your next turn.']],
      3: [['Primal Knowledge', 'Gain proficiency in another Barbarian skill; while raging, you can make some checks with Strength instead.']],
      5: [['Extra Attack', 'Attack twice whenever you take the Attack action.'], ['Fast Movement', 'Your Speed increases by 10 feet while you are not wearing Heavy armor.']] },
    sub: { name: 'Path of the Berserker', desc: 'Barbarians who channel rage into violent frenzy.', levels: { 3: [['Frenzy', 'While raging, if you use Reckless Attack, the first target you hit with a Strength attack each turn takes extra damage: d6s equal to your Rage Damage bonus.']] } } }),
  mkClass({ name: 'Bard', die: 8, caster: 'full', ability: 'cha', primary: 'Charisma', saves: ['dex', 'cha'], desc: 'An inspiring performer whose words and music carry magic.',
    skills: [3],
    levels: {
      1: [['Bardic Inspiration', 'Bonus Action: give a creature within 60 feet a Bardic Inspiration die (d6) to add to one failed D20 Test within the next hour. Uses equal your Charisma modifier (set the maximum), all back on a Long Rest.', usesN(3, 'long', '1d6', 'Bonus Action')], spellcasting('Bard', 'cha', 'a musical instrument can be your focus')],
      2: [['Expertise', 'Choose two skills you are proficient in: your Proficiency Bonus is doubled for them.'], ['Jack of All Trades', 'Add half your Proficiency Bonus to ability checks that don\'t already include it.']],
      5: [['Font of Inspiration', 'Bardic Inspiration comes back on a Short Rest too, and you can spend a spell slot to regain a use. The die becomes a d8.']] },
    sub: { name: 'College of Lore', desc: 'Bards who collect knowledge and wield words as weapons.', levels: { 3: [['Bonus Proficiencies', 'Gain proficiency in three skills of your choice.'], ['Cutting Words', 'Reaction when a creature within 60 feet makes a damage roll or succeeds on an ability check or attack roll: spend Bardic Inspiration and subtract the roll from it.']] } } }),
  mkClass({ name: 'Cleric', die: 8, caster: 'full', ability: 'wis', primary: 'Wisdom', saves: ['wis', 'cha'], desc: 'A priestly champion who wields divine magic.',
    skills: [2, ['history', 'insight', 'medicine', 'persuasion', 'religion']],
    levels: {
      1: [spellcasting('Cleric', 'wis', 'a Holy Symbol can be your focus'), ['Divine Order', 'Choose Protector (Martial weapons and Heavy armor training) or Thaumaturge (an extra cantrip, and add your Wisdom modifier to Arcana and Religion checks).']],
      2: [['Channel Divinity', 'Use Divine Spark (heal or deal Necrotic/Radiant damage of 1d8 + Wisdom modifier to a creature within 30 feet) or Turn Undead. You regain one use on a Short Rest and all on a Long Rest.', usesN(2, 'short_one', '1d8 + @abilities.wis.mod', 'Magic action')]],
      5: [['Sear Undead', 'When you Turn Undead, roll d8s equal to your Wisdom modifier; each Undead that fails takes that much Radiant damage.']] },
    sub: { name: 'Life Domain', desc: 'Clerics devoted to positive energy and healing.', levels: { 3: [['Disciple of Life', 'Healing spells of level 1 or higher restore an extra 2 + the spell\'s level Hit Points.'], ['Life Domain Spells', 'You always have Aid, Bless, Cure Wounds and Lesser Restoration prepared (more at higher levels).'], ['Preserve Life', 'Channel Divinity: restore Hit Points equal to five times your Cleric level, divided among creatures within 30 feet, none above half their maximum.']] } } }),
  mkClass({ name: 'Druid', die: 8, caster: 'full', ability: 'wis', primary: 'Wisdom', saves: ['int', 'wis'], desc: 'A priest of the Old Faith wielding the powers of nature.',
    skills: [2, ['arcana', 'animal_handling', 'insight', 'medicine', 'nature', 'perception', 'religion', 'survival']],
    levels: {
      1: [spellcasting('Druid', 'wis', 'a Druidic Focus can be your focus'), ['Druidic', 'You know the secret language of druids, and always have Speak with Animals prepared.'], ['Primal Order', 'Choose Magician (an extra cantrip, and add your Wisdom modifier to Arcana and Nature checks) or Warden (Martial weapons and Medium armor training).']],
      2: [['Wild Shape', 'Bonus Action: take the shape of a Beast you have learned (CR 1/4, no fly speed at first) for hours equal to half your Druid level. You regain one use on a Short Rest and all on a Long Rest.', usesN(2, 'short_one', '', 'Bonus Action')], ['Wild Companion', 'Spend a spell slot or a use of Wild Shape to cast Find Familiar without material components; the familiar is a Fey.']],
      5: [['Wild Resurgence', 'Once per turn, if you have no Wild Shape uses left, spend a spell slot to regain one; or once per Long Rest spend a Wild Shape use to regain a level 1 slot.']] },
    sub: { name: 'Circle of the Land', desc: 'Druids who draw magic from the land they guard.', levels: { 3: [['Circle of the Land Spells', 'After each Long Rest choose a land (arid, polar, temperate or tropical) and always have its spells prepared.'], ['Land\'s Aid', 'Magic action, spend a Wild Shape use: a 10-foot sphere within 60 feet deals 2d6 Necrotic damage (Con save halves) and one creature you choose there regains 2d6 Hit Points.']] } } }),
  mkClass({ name: 'Monk', die: 8, primary: 'Dexterity and Wisdom', saves: ['str', 'dex'], desc: 'A master of martial arts who harnesses inner energy.',
    skills: [2, ['acrobatics', 'athletics', 'history', 'insight', 'religion', 'stealth']],
    effects: [fx('Unarmored Defense', [{ path: 'ac', mode: 'upgrade', value: '10 + @abilities.dex.mod + @abilities.wis.mod' }])],
    levels: {
      1: [['Martial Arts', 'Unarmed and Monk weapons: use Dexterity instead of Strength, roll a d6 Martial Arts die for damage, and make an Unarmed Strike as a Bonus Action after you Attack.'], ['Unarmored Defense', 'Without armor or a Shield, your AC is 10 + Dexterity + Wisdom modifiers. Already worked into your AC.']],
      2: [['Monk\'s Focus', 'Focus Points equal to your Monk level (set the maximum): Flurry of Blows (two Unarmed Strikes as a Bonus Action), Patient Defense, Step of the Wind. All back on a Short or Long Rest.', usesN(2, 'short', '', 'Bonus Action')], ['Unarmored Movement', 'Your Speed increases by 10 feet without armor or a Shield.'], ['Uncanny Metabolism', 'When you roll Initiative, regain all Focus Points and heal your Martial Arts die + Monk level. Once per Long Rest.', usesN(1, 'long')]],
      3: [['Deflect Attacks', 'Reaction when hit by an attack dealing Bludgeoning, Piercing or Slashing damage: reduce it by 1d10 + Dexterity modifier + Monk level; if that makes it 0, spend 1 Focus to redirect it.']],
      4: [['Slow Fall', 'Reaction when you fall: reduce the fall damage by five times your Monk level.']],
      5: [['Extra Attack', 'Attack twice whenever you take the Attack action.'], ['Stunning Strike', 'Once per turn when you hit with a Monk weapon or Unarmed Strike, spend 1 Focus: the target makes a Constitution save or is Stunned until your next turn (on a success, its Speed is halved and your next attack has Advantage).']] },
    sub: { name: 'Warrior of the Open Hand', desc: 'Monks who master unarmed combat.', levels: { 3: [['Open Hand Technique', 'When you hit with a Flurry of Blows strike, impose one: Addle (no Reactions), Push (Strength save or pushed 15 feet), or Topple (Dexterity save or Prone).']] } } }),
  mkClass({ name: 'Paladin', die: 10, caster: 'half', ability: 'cha', primary: 'Strength and Charisma', saves: ['wis', 'cha'], desc: 'A holy warrior bound by a sacred oath.',
    skills: [2, ['athletics', 'insight', 'intimidation', 'medicine', 'persuasion', 'religion']], style: 2,
    levels: {
      1: [['Lay On Hands', 'Bonus Action: touch a creature and restore Hit Points from a pool of five times your Paladin level (set the maximum), or spend 5 to end the Poisoned condition. Refills on a Long Rest.', usesN(5, 'long', '', 'Bonus Action')], spellcasting('Paladin', 'cha', 'a Holy Symbol can be your focus'), ['Weapon Mastery', 'Use the mastery properties of two kinds of weapons; change one on a Long Rest.']],
      2: [['Paladin\'s Smite', 'You always have Divine Smite prepared, and can cast it once without a slot per Long Rest.', usesN(1, 'long', '2d8', 'Bonus Action')]],
      3: [['Channel Divinity', 'Divine Sense: for 10 minutes, know where Celestials, Fiends and Undead within 60 feet are. You regain one use on a Short Rest and all on a Long Rest.', usesN(2, 'short_one', '', 'Bonus Action')]],
      5: [['Extra Attack', 'Attack twice whenever you take the Attack action.'], ['Faithful Steed', 'You always have Find Steed prepared, and can cast it once without a slot per Long Rest.']] },
    sub: { name: 'Oath of Devotion', desc: 'Paladins sworn to honesty, courage and compassion.', levels: { 3: [['Oath of Devotion Spells', 'You always have Protection from Evil and Good and Shield of Faith prepared (more at higher levels).'], ['Sacred Weapon', 'Channel Divinity: for 10 minutes, add your Charisma modifier to attack rolls with one weapon, which deals Radiant or normal damage and sheds bright light.']] } } }),
  mkClass({ name: 'Ranger', die: 10, caster: 'half', ability: 'wis', primary: 'Dexterity and Wisdom', saves: ['str', 'dex'], desc: 'A wandering warrior who hunts with weapons and primal magic.',
    skills: [3, ['animal_handling', 'athletics', 'insight', 'investigation', 'nature', 'perception', 'stealth', 'survival']], style: 2,
    levels: {
      1: [spellcasting('Ranger', 'wis', 'a Druidic Focus can be your focus'), ['Favored Enemy', 'You always have Hunter\'s Mark prepared and can cast it twice without a slot per Long Rest.', usesN(2, 'long', '1d6', 'Bonus Action')], ['Weapon Mastery', 'Use the mastery properties of two kinds of weapons; change one on a Long Rest.']],
      2: [['Deft Explorer', 'Expertise in one skill you are proficient in, and two more languages.']],
      5: [['Extra Attack', 'Attack twice whenever you take the Attack action.']] },
    sub: { name: 'Hunter', desc: 'Rangers who protect the borders of civilisation from the monsters beyond.', levels: { 3: [['Hunter\'s Lore', 'While a creature is marked by your Hunter\'s Mark, you know its immunities, resistances and vulnerabilities.'], ['Hunter\'s Prey', 'Choose Colossus Slayer (once per turn, +1d8 damage to a creature below its Hit Point maximum) or Horde Breaker (once per turn, a second attack against another creature within 5 feet of the first). Change it on a rest.']] } } }),
  mkClass({ name: 'Rogue', die: 8, primary: 'Dexterity', saves: ['dex', 'int'], desc: 'A dexterous expert in stealth, skill and striking where it hurts.',
    skills: [4, ['acrobatics', 'athletics', 'deception', 'insight', 'intimidation', 'investigation', 'perception', 'persuasion', 'sleight_of_hand', 'stealth']], extraAsi: [10],
    levels: {
      1: [['Expertise', 'Choose two skills you are proficient in: your Proficiency Bonus is doubled for them.'], ['Sneak Attack', 'Once per turn, deal extra damage to a creature you hit with a Finesse or Ranged weapon if you have Advantage, or an ally is within 5 feet of it: 1d6 at level 1, +1d6 every odd level (3d6 at level 5).', { roll: '{ceil(@class_level / 2)}d6', activation: 'Free' }], ['Thieves\' Cant', 'You know the secret mix of jargon and signs of thieves, and one more language.'], ['Weapon Mastery', 'Use the mastery properties of two kinds of weapons; change one on a Long Rest.']],
      2: [['Cunning Action', 'Bonus Action: Dash, Disengage or Hide.']],
      3: [['Steady Aim', 'Bonus Action, if you haven\'t moved this turn: Advantage on your next attack this turn; your Speed is 0 until the end of the turn.']],
      5: [['Cunning Strike', 'When you Sneak Attack, give up Sneak Attack dice for an effect: Poison (1d6), Trip (1d6) or Withdraw (1d6).'], ['Uncanny Dodge', 'Reaction when an attacker you can see hits you: halve the attack\'s damage.']] },
    sub: { name: 'Thief', desc: 'Rogues who hone burglary, agility and quick hands.', levels: { 3: [['Fast Hands', 'Cunning Action can also make a Sleight of Hand check, use Thieves\' Tools, or take the Utilize action.'], ['Second-Story Work', 'Climbing costs no extra movement, and you can use Dexterity instead of Strength to work out jump distances.']] } } }),
  mkClass({ name: 'Sorcerer', die: 6, caster: 'full', ability: 'cha', primary: 'Charisma', saves: ['con', 'cha'], desc: 'A spellcaster with magic in their blood.',
    skills: [2, ['arcana', 'deception', 'insight', 'intimidation', 'persuasion', 'religion']],
    levels: {
      1: [spellcasting('Sorcerer', 'cha', 'an Arcane Focus can be your focus'), ['Innate Sorcery', 'Bonus Action: for 1 minute, your spell save DC rises by 1 and your Sorcerer spell attacks have Advantage.', usesN(2, 'long', '', 'Bonus Action')]],
      2: [['Font of Magic', 'Sorcery Points equal to your Sorcerer level (set the maximum): turn them into spell slots or slots into points. All back on a Long Rest.', usesN(2, 'long')], ['Metamagic', 'Choose two Metamagic options (e.g. Quickened, Twinned, Subtle) to change spells by spending Sorcery Points.']],
      5: [['Sorcerous Restoration', 'Once per Long Rest after a Short Rest, regain Sorcery Points up to half your Sorcerer level.', usesN(1, 'long')]] },
    sub: { name: 'Draconic Sorcery', desc: 'Sorcerers whose magic comes from a dragon\'s gift.', levels: { 3: [['Draconic Resilience', 'Your Hit Point maximum rises by 3 and by 1 more per Sorcerer level after 3; without armor, your AC is 10 + Dexterity + Charisma modifiers.'], ['Draconic Spells', 'You always have Alter Self, Chromatic Orb, Command and Dragon\'s Breath prepared (more at higher levels).']] } } }),
  mkClass({ name: 'Warlock', die: 8, caster: 'none', ability: 'cha', primary: 'Charisma', saves: ['wis', 'cha'], desc: 'A wielder of magic granted by a pact with an otherworldly patron.',
    skills: [2, ['arcana', 'deception', 'history', 'intimidation', 'investigation', 'nature', 'religion']],
    levels: {
      1: [['Eldritch Invocations', 'Gain one invocation (e.g. Pact of the Blade, Pact of the Chain or Pact of the Tome); more at higher levels.'], ['Pact Magic', 'You cast Warlock spells using Charisma. Your Pact slots are all the same level and come back on a Short Rest: 1 slot of level 1 at Warlock 1, 2 slots at 2, level 2 at 3–4, level 3 at 5. Track them here.', usesN(1, 'short')]],
      2: [['Magical Cunning', 'Once per Long Rest, spend 1 minute to regain half your Pact Magic slots.', usesN(1, 'long')]] },
    sub: { name: 'Fiend Patron', desc: 'Warlocks who bargain with a fiend of the Lower Planes.', levels: { 3: [['Fiend Spells', 'You always have Burning Hands, Command, Scorching Ray and Suggestion prepared (more at higher levels).'], ['Dark One\'s Blessing', 'When you reduce an enemy to 0 Hit Points (or one is within 10 feet of you), gain Temporary Hit Points equal to your Charisma modifier + Warlock level.']] } } }),
].flat();

const speciesDoc = (name, speed, size, description, grants, effects = []) => doc('race', name, { size, speed, description }, { effects, advancement: grants });
const SPECIES = [
  speciesDoc('Human', 30, 'Medium or Small', 'Found throughout the multiverse, humans are as varied as they are numerous.', [
    grant('human_1', 1, 'Human traits', 'items', { items: [
      featureDoc('Resourceful', 'Human', 'You gain Heroic Inspiration whenever you finish a Long Rest.'),
    ] }),
    skillChoice('human_skill', 1, 'Skillful: proficiency in one skill', 1),
    grant('human_feat', 1, 'Versatile: an Origin feat', 'choice', { count: 1, items: [FEATS.alert, FEATS.skilled, FEATS.savage, FEATS.magic_initiate] }),
  ]),
  speciesDoc('Elf', 30, 'Medium', 'Magical people of otherworldly grace, elves trace their origins to the Feywild.', [
    grant('elf_1', 1, 'Elf traits', 'items', { items: [
      featureDoc('Darkvision', 'Elf', 'You see in Dim Light within 60 feet as if it were Bright Light, and in Darkness as if it were Dim Light.'),
      featureDoc('Fey Ancestry', 'Elf', 'Advantage on saving throws you make to avoid or end the Charmed condition.'),
      featureDoc('Keen Senses', 'Elf', 'Proficiency in Insight, Perception or Survival (set it on the Skills list).'),
      featureDoc('Trance', 'Elf', 'You don\'t need to sleep, and a Long Rest takes you 4 hours of meditation.'),
    ] }),
    grant('elf_lineage', 1, 'Elven lineage', 'choice', { count: 1, items: [
      featureDoc('Drow Lineage', 'Elf', 'Darkvision 120 ft.; you know Dancing Lights, and later Faerie Fire and Darkness.'),
      featureDoc('High Elf Lineage', 'Elf', 'You know Prestidigitation, and later Detect Magic and Misty Step.'),
      featureDoc('Wood Elf Lineage', 'Elf', 'Your Speed is 35 feet; you know Druidcraft, and later Longstrider and Pass without Trace.', {}, { effects: [fx('Wood Elf speed', [{ path: 'speed_base', mode: 'set', value: '35' }])] }),
    ] }),
  ]),
  speciesDoc('Dwarf', 30, 'Medium', 'Raised from the earth by a god of the forge, dwarves are hardy and steadfast.', [
    grant('dwarf_1', 1, 'Dwarf traits', 'items', { items: [
      featureDoc('Darkvision', 'Dwarf', 'You see in Dim Light within 120 feet as if it were Bright Light, and in Darkness as if it were Dim Light.'),
      featureDoc('Dwarven Resilience', 'Dwarf', 'Resistance to Poison damage, and Advantage on saving throws to avoid or end the Poisoned condition.'),
      featureDoc('Dwarven Toughness', 'Dwarf', 'Your Hit Point maximum increases by 1, and by 1 again whenever you gain a level.', {}, { effects: [fx('Dwarven Toughness', [{ path: 'hp.max', mode: 'add', value: '@level' }])] }),
      featureDoc('Stonecunning', 'Dwarf', 'Bonus Action: gain Tremorsense 60 ft. for 10 minutes while on or touching stone. Proficiency Bonus uses per Long Rest.'),
    ] }),
  ]),
];

const skillFx = (name, skills) => fx(name, skills.map((s) => ({ path: `skills.${s}.prof`, mode: 'upgrade', value: '1' })));
const BACKGROUNDS = [
  doc('background', 'Soldier', { feat: 'Savage Attacker', tools: 'One kind of Gaming Set', description: 'You trained for war; your ability scores favour Strength, Dexterity and Constitution.' }, {
    effects: [skillFx('Soldier skills', ['athletics', 'intimidation'])],
    advancement: [
      grant('soldier_scores', 1, 'Ability scores (+2 and +1, or +1 to three, among Strength, Dexterity and Constitution)', 'points', { path: 'abilities', field: 'value', amount: 3, max_each: 2, cap: 20 }),
      grant('soldier_feat', 1, 'Origin feat', 'items', { items: [FEATS.savage] }),
    ],
  }),
  doc('background', 'Acolyte', { feat: 'Magic Initiate (Cleric)', tools: "Calligrapher's Supplies", description: 'You served in a temple; your ability scores favour Intelligence, Wisdom and Charisma.' }, {
    effects: [skillFx('Acolyte skills', ['insight', 'religion'])],
    advancement: [
      grant('acolyte_scores', 1, 'Ability scores (+2 and +1, or +1 to three, among Intelligence, Wisdom and Charisma)', 'points', { path: 'abilities', field: 'value', amount: 3, max_each: 2, cap: 20 }),
      grant('acolyte_feat', 1, 'Origin feat', 'items', { items: [FEATS.magic_initiate] }),
    ],
  }),
];

// The rest of the SRD 5.2 species and backgrounds (summaries in our own words).
const traits = (key, name, list, extra = []) => [grant(`${key}_1`, 1, `${name} traits`, 'items', { items: list.map(([n, d, data, more]) => featureDoc(n, name, d, data ?? {}, more ?? {})) }), ...extra];
const darkvision = (range) => ['Darkvision', `You see in Dim Light within ${range} feet as if it were Bright Light, and in Darkness as if it were Dim Light.`];
SPECIES.push(
  speciesDoc('Dragonborn', 30, 'Medium', 'Descended from dragons, dragonborn carry the draconic power of their ancestors.', traits('dragonborn', 'Dragonborn', [
    ['Breath Weapon', 'When you take the Attack action, replace one attack with a 15-foot cone or 30-foot line of your ancestry\'s damage: 1d10 (2d10 at level 5), Dexterity save (DC 8 + Constitution modifier + Proficiency Bonus) for half. Proficiency Bonus uses per Long Rest.', usesN(2, 'long', '{1 + (@level >= 5 ? 1 : 0) + (@level >= 11 ? 1 : 0) + (@level >= 17 ? 1 : 0)}d10', 'Action')],
    ['Damage Resistance', 'Resistance to the damage type of your draconic ancestry.'],
    darkvision(60),
    ['Draconic Flight', 'From level 5, a Bonus Action gives you spectral wings and a Fly Speed equal to your Speed for 10 minutes, once per Long Rest.'],
  ], [grant('dragonborn_ancestry', 1, 'Draconic ancestry', 'choice', { count: 1, items: [
    ['Black or Copper (Acid)', 'Acid'], ['Blue or Bronze (Lightning)', 'Lightning'], ['Brass, Gold or Red (Fire)', 'Fire'], ['Green (Poison)', 'Poison'], ['Silver or White (Cold)', 'Cold'],
  ].map(([n, t]) => featureDoc(`Draconic Ancestry: ${n}`, 'Dragonborn', `Your Breath Weapon and Damage Resistance use ${t} damage.`)) })])),
  speciesDoc('Gnome', 30, 'Small', 'Magical folk created by gods of invention, illusion and life underground.', traits('gnome', 'Gnome', [
    darkvision(60),
    ['Gnomish Cunning', 'Advantage on Intelligence, Wisdom and Charisma saving throws.'],
  ], [grant('gnome_lineage', 1, 'Gnomish lineage', 'choice', { count: 1, items: [
    featureDoc('Forest Gnome', 'Gnome', 'You know Minor Illusion, and always have Speak with Animals prepared (Proficiency Bonus free casts per Long Rest).'),
    featureDoc('Rock Gnome', 'Gnome', 'You know Mending and Prestidigitation, and can make tiny clockwork devices.'),
  ] })])),
  speciesDoc('Goliath', 35, 'Medium', 'Towering folk descended from giants, goliaths bear the marks of their ancestry.', traits('goliath', 'Goliath', [
    ['Large Form', 'From level 5, a Bonus Action makes you Large for 10 minutes (Advantage on Strength checks, +10 feet Speed), once per Long Rest.'],
    ['Powerful Build', 'Advantage on checks to end the Grappled condition, and you count as one size larger for carrying capacity.'],
  ], [grant('goliath_ancestry', 1, 'Giant ancestry', 'choice', { count: 1, items: [
    ['Cloud\'s Jaunt', 'Bonus Action: teleport up to 30 feet to a space you can see.'], ['Fire\'s Burn', 'When you hit, deal an extra 1d10 Fire damage.'], ['Frost\'s Chill', 'When you hit, deal an extra 1d6 Cold damage and reduce the target\'s Speed by 10 feet.'],
    ['Hill\'s Tumble', 'When you hit a Large or smaller creature, knock it Prone.'], ['Stone\'s Endurance', 'Reaction when you take damage: reduce it by 1d12 + Constitution modifier.'], ['Storm\'s Thunder', 'Reaction when a creature within 60 feet damages you: deal it 1d8 Thunder damage.'],
  ].map(([n, d]) => featureDoc(n, 'Goliath', `${d} Proficiency Bonus uses per Long Rest.`, usesN(2, 'long'))) })]), [fx('Goliath speed', [{ path: 'speed_base', mode: 'set', value: '35' }])]),
  speciesDoc('Halfling', 30, 'Small', 'Small, comfortable-loving folk with remarkable luck and courage.', traits('halfling', 'Halfling', [
    ['Brave', 'Advantage on saving throws you make to avoid or end the Frightened condition.'],
    ['Halfling Nimbleness', 'You can move through the space of any creature a size larger than you, but can\'t stop there.'],
    ['Luck', 'When you roll a 1 on the d20 of a D20 Test, you can reroll it and must use the new roll.'],
    ['Naturally Stealthy', 'You can take the Hide action even when obscured only by a creature at least one size larger than you.'],
  ])),
  speciesDoc('Orc', 30, 'Medium', 'Gifted with endurance and determination by their god Gruumsh.', traits('orc', 'Orc', [
    ['Adrenaline Rush', 'Bonus Action: Dash, and gain Temporary Hit Points equal to your Proficiency Bonus. Proficiency Bonus uses; all back on a Short or Long Rest.', usesN(2, 'short', '', 'Bonus Action')],
    darkvision(120),
    ['Relentless Endurance', 'When you drop to 0 Hit Points but aren\'t killed outright, drop to 1 instead. Once per Long Rest.', usesN(1, 'long')],
  ])),
  speciesDoc('Tiefling', 30, 'Medium or Small', 'Touched by the Lower Planes, tieflings carry a fiendish legacy.', traits('tiefling', 'Tiefling', [
    darkvision(60),
    ['Otherworldly Presence', 'You know Thaumaturgy, cast with the spellcasting ability of your legacy.'],
  ], [grant('tiefling_legacy', 1, 'Fiendish legacy', 'choice', { count: 1, items: [
    featureDoc('Abyssal Legacy', 'Tiefling', 'Resistance to Poison damage; you know Poison Spray, and later Ray of Sickness and Hold Person.'),
    featureDoc('Chthonic Legacy', 'Tiefling', 'Resistance to Necrotic damage; you know Chill Touch, and later False Life and Ray of Enfeeblement.'),
    featureDoc('Infernal Legacy', 'Tiefling', 'Resistance to Fire damage; you know Fire Bolt, and later Hellish Rebuke and Darkness.'),
  ] })])),
);
BACKGROUNDS.push(
  doc('background', 'Criminal', { feat: 'Alert', tools: "Thieves' Tools", description: 'You lived outside the law; your ability scores favour Dexterity, Constitution and Intelligence.' }, {
    effects: [skillFx('Criminal skills', ['sleight_of_hand', 'stealth'])],
    advancement: [
      grant('criminal_scores', 1, 'Ability scores (+2 and +1, or +1 to three, among Dexterity, Constitution and Intelligence)', 'points', { path: 'abilities', field: 'value', amount: 3, max_each: 2, cap: 20, only: ['dex', 'con', 'int'] }),
      grant('criminal_feat', 1, 'Origin feat', 'items', { items: [FEATS.alert] }),
    ],
  }),
  doc('background', 'Sage', { feat: 'Magic Initiate (Wizard)', tools: "Calligrapher's Supplies", description: 'You spent years studying lore; your ability scores favour Constitution, Intelligence and Wisdom.' }, {
    effects: [skillFx('Sage skills', ['arcana', 'history'])],
    advancement: [
      grant('sage_scores', 1, 'Ability scores (+2 and +1, or +1 to three, among Constitution, Intelligence and Wisdom)', 'points', { path: 'abilities', field: 'value', amount: 3, max_each: 2, cap: 20, only: ['con', 'int', 'wis'] }),
      grant('sage_feat', 1, 'Origin feat', 'items', { items: [FEATS.magic_initiate] }),
    ],
  }),
);
// The existing backgrounds' scores, limited to their three abilities too.
for (const [name, only] of [['Soldier', ['str', 'dex', 'con']], ['Acolyte', ['int', 'wis', 'cha']]]) {
  const g = BACKGROUNDS.find((b) => b.name === name)?.advancement.find((x) => x.path === 'abilities');
  if (g) g.only = only;
}

const w = (name, category, range_type, damage, damage_type, extra = {}) => doc('weapon', name, { category, range_type, damage, damage_type, versatile: '', finesse: false, properties: '', mastery: '', range: '', proficient: true, bonus: 0, equipped: false, weight: 0, ...extra });
const WEAPONS = [
  w('Dagger', 'simple', 'melee', '1d4', 'piercing', { finesse: true, properties: 'Light, Thrown (20/60)', mastery: 'Nick', weight: 1 }),
  w('Handaxe', 'simple', 'melee', '1d6', 'slashing', { properties: 'Light, Thrown (20/60)', mastery: 'Vex', weight: 2 }),
  w('Javelin', 'simple', 'melee', '1d6', 'piercing', { properties: 'Thrown (30/120)', mastery: 'Slow', weight: 2 }),
  w('Mace', 'simple', 'melee', '1d6', 'bludgeoning', { mastery: 'Sap', weight: 4 }),
  w('Quarterstaff', 'simple', 'melee', '1d6', 'bludgeoning', { versatile: '1d8', mastery: 'Topple', weight: 4 }),
  w('Spear', 'simple', 'melee', '1d6', 'piercing', { versatile: '1d8', properties: 'Thrown (20/60)', mastery: 'Sap', weight: 3 }),
  w('Light Crossbow', 'simple', 'ranged', '1d8', 'piercing', { properties: 'Ammunition, Loading, Two-Handed', range: '80/320', mastery: 'Slow', weight: 5 }),
  w('Shortbow', 'simple', 'ranged', '1d6', 'piercing', { properties: 'Ammunition, Two-Handed', range: '80/320', mastery: 'Vex', weight: 2 }),
  w('Greataxe', 'martial', 'melee', '1d12', 'slashing', { properties: 'Heavy, Two-Handed', mastery: 'Cleave', weight: 7 }),
  w('Greatsword', 'martial', 'melee', '2d6', 'slashing', { properties: 'Heavy, Two-Handed', mastery: 'Graze', weight: 6 }),
  w('Longsword', 'martial', 'melee', '1d8', 'slashing', { versatile: '1d10', mastery: 'Sap', weight: 3 }),
  w('Rapier', 'martial', 'melee', '1d8', 'piercing', { finesse: true, mastery: 'Vex', weight: 2 }),
  w('Scimitar', 'martial', 'melee', '1d6', 'slashing', { finesse: true, properties: 'Light', mastery: 'Nick', weight: 3 }),
  w('Shortsword', 'martial', 'melee', '1d6', 'piercing', { finesse: true, properties: 'Light', mastery: 'Vex', weight: 2 }),
  w('Warhammer', 'martial', 'melee', '1d8', 'bludgeoning', { versatile: '1d10', mastery: 'Push', weight: 5 }),
  w('Longbow', 'martial', 'ranged', '1d8', 'piercing', { properties: 'Ammunition, Heavy, Two-Handed', range: '150/600', mastery: 'Slow', weight: 2 }),
];
const a = (name, category, base_ac, dex_cap, extra = {}) => doc('armor', name, { category, base_ac, dex_cap, strength: 0, stealth: false, equipped: false, weight: 0, description: '', ...extra });
const ARMOR = [
  a('Padded Armor', 'light', 11, 99, { stealth: true, weight: 8 }),
  a('Leather Armor', 'light', 11, 99, { weight: 10 }),
  a('Studded Leather Armor', 'light', 12, 99, { weight: 13 }),
  a('Hide Armor', 'medium', 12, 2, { weight: 12 }),
  a('Chain Shirt', 'medium', 13, 2, { weight: 20 }),
  a('Scale Mail', 'medium', 14, 2, { stealth: true, weight: 45 }),
  a('Breastplate', 'medium', 14, 2, { weight: 20 }),
  a('Half Plate Armor', 'medium', 15, 2, { stealth: true, weight: 40 }),
  a('Ring Mail', 'heavy', 14, 0, { stealth: true, weight: 40 }),
  a('Chain Mail', 'heavy', 16, 0, { strength: 13, stealth: true, weight: 55 }),
  a('Splint Armor', 'heavy', 17, 0, { strength: 15, stealth: true, weight: 60 }),
  a('Plate Armor', 'heavy', 18, 0, { strength: 15, stealth: true, weight: 65 }),
  a('Shield', 'shield', 2, 0, { weight: 6 }),
];
const sp = (name, level, school, data) => doc('spell', name, { level, school, casting_time: 'Action', range: '', components: 'V, S', duration: 'Instantaneous', concentration: false, ritual: false, prepared: true, attack: 'none', save: 'none', dice: 0, die: 6, add_mod: false, plus: 0, per_level: 0, cantrip: false, damage_type: 'fire', description: '', ...data });
const SPELLS = [
  sp('Fire Bolt', 0, 'evocation', { range: '120 feet', attack: 'ranged', dice: 1, die: 10, cantrip: true, damage_type: 'fire', description: 'Hurl a mote of fire: ranged spell attack, 1d10 Fire damage. A flammable object hit starts burning. More dice at levels 5, 11 and 17.' }),
  sp('Sacred Flame', 0, 'evocation', { range: '60 feet', save: 'dex', dice: 1, die: 8, cantrip: true, damage_type: 'radiant', description: 'Flame descends on a creature: Dexterity save or 1d8 Radiant damage (no benefit from cover). More dice at levels 5, 11 and 17.' }),
  sp('Magic Missile', 1, 'evocation', { range: '120 feet', dice: 3, die: 4, plus: 3, per_level: 1, damage_type: 'force', description: 'Three glowing darts, each hitting a creature you can see for 1d4 + 1 Force damage. One more dart per slot level above 1.' }),
  sp('Burning Hands', 1, 'evocation', { range: 'Self (15-foot cone)', save: 'dex', dice: 3, die: 6, per_level: 1, damage_type: 'fire', description: 'A sheet of flame: Dexterity save, 3d6 Fire damage on a failure, half on a success.' }),
  sp('Cure Wounds', 1, 'abjuration', { range: 'Touch', dice: 2, die: 8, add_mod: true, per_level: 2, damage_type: 'healing', description: 'A creature you touch regains 2d8 + your spellcasting modifier Hit Points.' }),
  sp('Shield', 1, 'abjuration', { casting_time: 'Reaction', range: 'Self', duration: '1 round', description: 'An invisible barrier: +5 AC until the start of your next turn, and no damage from Magic Missile.' }),
  sp('Fireball', 3, 'evocation', { range: '150 feet', components: 'V, S, M (a ball of bat guano and sulfur)', save: 'dex', dice: 8, die: 6, per_level: 1, damage_type: 'fire', description: 'A 20-foot-radius burst: Dexterity save, 8d6 Fire damage on a failure, half on a success.' }),
];
const gear = (name, data) => doc('item', name, { quantity: 1, weight: 0, cost: '', equipped: false, description: '', ...data });
const GEAR = [
  gear('Backpack', { weight: 5, cost: '2 GP' }), gear('Bedroll', { weight: 7, cost: '1 GP' }), gear('Rations (1 day)', { quantity: 10, weight: 2, cost: '5 SP' }),
  gear('Rope (50 feet)', { weight: 5, cost: '1 GP' }), gear('Torch', { quantity: 10, weight: 1, cost: '1 CP', description: 'Bright Light 20 ft., Dim Light 20 ft. more, for 1 hour.' }),
  gear('Waterskin', { weight: 5, cost: '2 SP' }), gear("Healer's Kit", { weight: 3, cost: '5 GP', description: '10 uses: stabilize a creature at 0 Hit Points without a Medicine check.' }),
];

// Monsters: an NPC with weapons and features as items.
const mon = (name, data, items) => ({
  id: iid(name), name, kind: 'enemy', owners: [], flags: {}, effects: [],
  data: { ...data, abilities: Object.fromEntries(Object.entries(data.abilities).map(([k, v]) => [k, { value: v }])) },
  items,
});
const MONSTERS = [
  mon('Goblin Warrior', { cr: 0.25, size: 'Small', creature_type: 'Fey (Goblinoid)', alignment: 'Chaotic Neutral', ac: 15, hp: { value: 10, max: 10 }, speed: 30, skills_text: 'Stealth +6', senses: 'Darkvision 60 ft., Passive Perception 9', languages: 'Common, Goblin',
    abilities: { str: 8, dex: 15, con: 10, int: 10, wis: 8, cha: 8 } },
  [{ ...WEAPONS.find((x) => x.name === 'Scimitar'), id: iid('scimitar'), data: { ...WEAPONS.find((x) => x.name === 'Scimitar').data, equipped: true } },
    { ...WEAPONS.find((x) => x.name === 'Shortbow'), id: iid('shortbow') },
    featureDoc('Nimble Escape', 'Goblin', 'The goblin takes the Disengage or Hide action as a Bonus Action.')]),
  mon('Skeleton', { cr: 0.25, size: 'Medium', creature_type: 'Undead', alignment: 'Lawful Evil', ac: 13, hp: { value: 13, max: 13 }, speed: 30, senses: 'Darkvision 60 ft., Passive Perception 9', languages: 'Understands the languages it knew in life but can\'t speak',
    abilities: { str: 10, dex: 16, con: 15, int: 6, wis: 8, cha: 5 } },
  [{ ...WEAPONS.find((x) => x.name === 'Shortsword'), id: iid('shortsword') }, { ...WEAPONS.find((x) => x.name === 'Shortbow'), id: iid('shortbow') },
    featureDoc('Undead nature', 'Skeleton', 'Vulnerable to Bludgeoning damage; immune to Poison damage and the Exhaustion and Poisoned conditions.')]),
  mon('Wolf', { cr: 0.25, size: 'Medium', creature_type: 'Beast', alignment: 'Unaligned', ac: 12, hp: { value: 11, max: 11 }, speed: 40, skills_text: 'Perception +5, Stealth +4', senses: 'Passive Perception 15',
    abilities: { str: 14, dex: 15, con: 12, int: 3, wis: 12, cha: 6 } },
  [w('Bite', 'simple', 'melee', '1d6', 'piercing', { finesse: true, properties: 'If the target is Medium or smaller, it has the Prone condition.' }),
    featureDoc('Pack Tactics', 'Wolf', 'Advantage on attack rolls against a creature if an ally is within 5 feet of it and not Incapacitated.')]),
  mon('Ogre', { cr: 2, size: 'Large', creature_type: 'Giant', alignment: 'Chaotic Evil', ac: 11, hp: { value: 68, max: 68 }, speed: 40, senses: 'Darkvision 60 ft., Passive Perception 8', languages: 'Common, Giant',
    abilities: { str: 19, dex: 8, con: 16, int: 5, wis: 7, cha: 7 } },
  [w('Greatclub', 'simple', 'melee', '2d8', 'bludgeoning', { properties: 'Reach 5 ft.' }), w('Javelin', 'simple', 'melee', '2d6', 'piercing', { properties: 'Thrown (30/120)' })]),
];

// ---------------------------------------------------------------- write it all

fs.mkdirSync(path.join(out, 'packs'), { recursive: true });
fs.writeFileSync(path.join(out, 'builder.json'), JSON.stringify(blueprint, null, 2) + '\n');
// Rules reference (SRD 5.2, CC-BY-4.0), one entry per rule so the lookup finds each by name.
const rule = (folder, name, content) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), name, folder, content: `# ${name}\n\n${content}` });
const NOTICE_TEXT = "This work includes material from the System Reference Document 5.2 (\"SRD 5.2\") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.";
const LEGAL_ENTRY = {"id":"legal","name":"Legal: SRD 5.2 License","folder":"About","content":"# Legal: SRD 5.2 License\n\nThis work includes material from the System Reference Document 5.2 (\"SRD 5.2\") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.\n\nThe rules text in this system is summarised and reworded from the SRD 5.2; consult the SRD for the full rules. Dungeons & Dragons and D&D are trademarks of Wizards of the Coast; this system is not affiliated with or endorsed by Wizards of the Coast."};
const RULES = [
  LEGAL_ENTRY,
  rule('Basics', 'Advantage and Disadvantage', 'With **Advantage**, roll two d20s and use the higher; with **Disadvantage**, use the lower. If you have both, they cancel out and you roll one d20, however many sources of each you have.\n\nOn a sheet, Alt-click a roll for Advantage and Ctrl-click for Disadvantage.'),
  rule('Basics', 'D20 Tests', 'Ability checks, saving throws and attack rolls are all **D20 Tests**: roll a d20, add the relevant modifier and any bonuses, and compare the total to a target number (a DC or an Armor Class). Meeting or beating it succeeds.'),
  rule('Basics', 'Ability Checks', 'An ability check tests a creature\'s talent at something: roll a d20 and add the ability modifier, plus your [[Proficiency Bonus]] if you\'re proficient in a relevant skill or tool. Typical DCs: very easy 5, easy 10, medium 15, hard 20, very hard 25, nearly impossible 30.'),
  rule('Basics', 'Saving Throws', 'A saving throw is a reaction to a threat: roll a d20 and add the ability modifier (plus your [[Proficiency Bonus]] if you\'re proficient in that save) against the DC set by the effect.'),
  rule('Basics', 'Proficiency Bonus', 'Added to rolls you are proficient in: attack rolls with proficient weapons and spells, skill and tool checks, and proficient saving throws. It never applies twice to the same roll. Characters have +2 at levels 1–4, +3 at 5–8, +4 at 9–12, +5 at 13–16 and +6 at 17–20.'),
  rule('Basics', 'Heroic Inspiration', 'If you have Heroic Inspiration, you can spend it to reroll any die immediately after rolling it, and you must use the new roll. You can have only one at a time.'),
  rule('Combat', 'Combat Turn', 'On your turn you can **move** up to your Speed and take **one action**. You may also take one [[Bonus Action]] if something gives you one, and one [[Reaction]] each round (on anyone\'s turn). You can also talk briefly and interact with one object for free.'),
  rule('Combat', 'Initiative', 'At the start of combat everyone rolls a Dexterity check (Initiative); turns go from highest to lowest. Surprised creatures roll with Disadvantage.'),
  rule('Combat', 'Bonus Action', 'Some features and spells let you take a Bonus Action. You get at most one per turn, and only when something grants it. You choose when to take it during your turn.'),
  rule('Combat', 'Reaction', 'An instant response to a trigger, such as an [[Opportunity Attack]] or the *Shield* spell. You get one Reaction per round, and regain it at the start of your turn.'),
  rule('Combat', 'Opportunity Attack', 'When a creature you can see leaves your reach using its action, Bonus Action, Reaction or movement, you can use your Reaction to make one melee attack against it. Taking the [[Disengage]] action, or being moved without using movement, avoids this.'),
  rule('Combat', 'Critical Hits', 'When you roll a 20 on the d20 for an attack, it hits regardless of modifiers and is a **Critical Hit**: roll the attack\'s damage dice twice and add them together, then add modifiers as normal. A 1 always misses.'),
  rule('Combat', 'Cover', '- **Half cover** (a low wall, another creature): +2 to AC and Dexterity saving throws.\n- **Three-quarters cover** (an arrow slit): +5 to AC and Dexterity saving throws.\n- **Total cover**: can\'t be targeted directly by an attack or spell.'),
  rule('Combat', 'Difficult Terrain', 'Every foot of movement in difficult terrain (rubble, undergrowth, deep snow, another creature\'s space) costs 1 extra foot.'),
  rule('Combat', 'Unarmed Strike', 'A melee attack using your body. On a hit, choose one: **Damage** (1 + Strength modifier Bludgeoning), **[[Grappling]]**, or **Shove** (the target makes a Strength or Dexterity save against DC 8 + your Strength modifier + Proficiency Bonus or is pushed 5 feet or knocked [[Prone]]). The target must be no more than one size larger than you to grapple or shove.'),
  rule('Combat', 'Grappling', 'Use an [[Unarmed Strike]] option: the target makes a Strength or Dexterity saving throw (its choice) against DC 8 + your Strength modifier + Proficiency Bonus. On a failure it has the [[Grappled]] condition. You need a free hand. It can use its action to try to escape: a Strength (Athletics) or Dexterity (Acrobatics) check against the same DC.'),
  rule('Actions', 'Attack', 'Make one attack with a weapon or an [[Unarmed Strike]]. Features such as Extra Attack let you make more than one.'),
  rule('Actions', 'Dash', 'Gain extra movement equal to your Speed for the current turn.'),
  rule('Actions', 'Disengage', 'Your movement doesn\'t provoke [[Opportunity Attack]]s for the rest of the turn.'),
  rule('Actions', 'Dodge', 'Until the start of your next turn, attack rolls against you have Disadvantage if you can see the attacker, and you make Dexterity saving throws with Advantage. You lose the benefit if you are [[Incapacitated]] or your Speed is 0.'),
  rule('Actions', 'Help', 'Help an ally with an ability check (they get Advantage on their next check with that skill or tool), or distract an enemy within 5 feet of you (the next attack roll by one of your allies against it has Advantage).'),
  rule('Actions', 'Hide', 'Make a DC 15 Dexterity (Stealth) check while heavily obscured or behind three-quarters or total cover, out of any enemy\'s line of sight. On a success you have the [[Invisible]] condition until you make noise, attack, cast a spell with a Verbal component, or an enemy finds you.'),
  rule('Actions', 'Influence', 'Try to persuade, deceive, intimidate or perform for a creature with a Charisma check (or Wisdom for animal handling). The GM decides how willing it is and the DC.'),
  rule('Actions', 'Magic', 'Cast a spell with a casting time of an action, use a magic item, or use a magical feature.'),
  rule('Actions', 'Ready', 'Choose a trigger and an action (or a move) to take in response with your [[Reaction]] when it happens. A readied spell needs [[Concentration]] until it\'s released.'),
  rule('Actions', 'Search', 'Make a Wisdom check (Insight, Medicine, Perception or Survival) to notice or discern something.'),
  rule('Actions', 'Study', 'Make an Intelligence check (Arcana, History, Investigation, Nature or Religion) to recall or work something out.'),
  rule('Actions', 'Utilize', 'Use a nonmagical object that needs an action, such as a lever, a potion or a tool.'),
  rule('Health', 'Hit Points', 'When you take damage, subtract it from your hit points. At 0 you fall [[Unconscious]] and start making [[Death Saving Throws]], unless the damage left over after reaching 0 equals your hit point maximum (instant death). Healing can\'t raise hit points above the maximum.'),
  rule('Health', 'Temporary Hit Points', 'A buffer that absorbs damage before your real hit points. They don\'t stack: if you gain more, choose whether to keep the old or the new amount. Healing doesn\'t restore them, and they go away after a [[Long Rest]].'),
  rule('Health', 'Death Saving Throws', 'At the start of each turn at 0 hit points, roll a d20 (no modifiers): **10 or higher** is a success, lower a failure. Three successes: you become stable. Three failures: you die. A **1** counts as two failures; a **20** brings you back with 1 hit point. Taking damage at 0 hit points is a failure (a critical hit, two).'),
  rule('Health', 'Exhaustion', 'Exhaustion has levels 1 to 6. Each level gives −2 to every [[D20 Tests|D20 Test]] and −5 feet of Speed (the sheet does this for you). At level 6 you die. A [[Long Rest]] removes one level.'),
  rule('Health', 'Resistance and Vulnerability', '**Resistance** halves damage of that type (round down); **Vulnerability** doubles it; **Immunity** prevents it. Several sources of the same one count once.'),
  rule('Resting', 'Short Rest', 'At least 1 hour of light activity. You can spend [[Hit Point Dice]], and some features recharge.'),
  rule('Resting', 'Long Rest', 'At least 8 hours, mostly sleeping. You regain all lost hit points and all spent Hit Point Dice, spell slots and long-rest features, and reduce [[Exhaustion]] by 1. You can benefit from one Long Rest per 24 hours. Interrupting it with an hour of strenuous activity means starting again.'),
  rule('Resting', 'Hit Point Dice', 'One die per character level, of the size your class gives (d6 to d12). During a [[Short Rest]] spend any number: roll each and add your Constitution modifier to regain that many hit points. A [[Long Rest]] restores them all.'),
  rule('Magic', 'Spell Slots', 'Casting a spell of level 1 or higher spends a slot of that level or higher; a higher slot can strengthen the spell (upcasting). Cantrips need no slot. Spent slots come back on a [[Long Rest]]. You can cast only one spell with a slot per turn.'),
  rule('Magic', 'Concentration', 'Some spells last only while you concentrate. It ends if you cast another Concentration spell, become [[Incapacitated]], or die. When you take damage, make a Constitution saving throw (DC 10 or half the damage, whichever is higher, up to 30) to keep it.'),
  rule('Magic', 'Spell Attacks and Save DCs', '**Spell attack bonus** = your spellcasting ability modifier + [[Proficiency Bonus]]. **Spell save DC** = 8 + your spellcasting ability modifier + Proficiency Bonus. Both are on the Spells tab.'),
  rule('Magic', 'Ritual Casting', 'A spell with the Ritual tag can be cast as a ritual: it takes 10 minutes longer and doesn\'t use a spell slot. You must have it prepared.'),
];

const packs = {
  classes: ['Classes and subclasses', [fighter, wizard, champion, evoker, ...MORE_CLASSES], true],
  species: ['Species', SPECIES, true],
  backgrounds: ['Backgrounds', BACKGROUNDS, true],
  feats: ['Feats', Object.values(FEATS), true],
  weapons: ['Weapons', WEAPONS, true],
  armor: ['Armor', ARMOR, true],
  spells: ['Spells', SPELLS, true],
  gear: ['Adventuring gear', GEAR, true],
};
// Entries added from inside Hearth ("Add to the system's collection") are kept.
const writePack = (file, docs) => {
  const at = path.join(out, 'packs', `${file}.json`);
  let kept = [];
  try { kept = JSON.parse(fs.readFileSync(at, 'utf8')).filter((d) => d?.flags?.core?.user_added); } catch { /* new */ }
  const mine = new Set(docs.map((d) => `${d.kind}/${d.name.toLowerCase()}`));
  fs.writeFileSync(at, JSON.stringify([...docs, ...kept.filter((d) => !mine.has(`${d.kind}/${String(d.name).toLowerCase()}`))], null, 2) + '\n');
};
for (const [file, [, docs]] of Object.entries(packs)) writePack(file, docs);
writePack('monsters', MONSTERS);

const NOTICE = 'This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';
fs.writeFileSync(path.join(out, 'NOTICE.md'), `# Attribution\n\n${NOTICE}\n\nRules text here is summarised and reworded; consult the SRD 5.2 for the full rules.\n`);
const toml = `id = "d-d-5e-srd"
type = "system"
name = "D&D 5e SRD"
version = "0.2.0"
description = "A reference build of the fifth edition rules from the SRD 5.2: characters, monsters, classes, species, backgrounds, feats, weapons, armor and spells."
license = "CC-BY-4.0"
attribution = ${JSON.stringify(NOTICE_TEXT)}

# ${NOTICE}

# The character and item types are designed in Hearth's system builder
# (builder.json). Anything written here by hand is merged over them.

[combat]
initiative = "1d20 + @initiative"

${Object.entries(packs).map(([file, [label, , pub]]) => `[[packs]]\nid = "${file}"\nlabel = "${label}"\nkind = "item"\npath = "packs/${file}.json"\npublic = ${pub}\n`).join('\n')}
[[packs]]
id = "rules"
label = "Rules"
kind = "journal"
path = "packs/rules.json"
public = true

[[packs]]
id = "monsters"
label = "Monsters"
kind = "actor"
path = "packs/monsters.json"
`;
fs.writeFileSync(path.join(out, 'hearth.toml'), toml);
writePack('rules', RULES);
console.log(JSON.stringify({ items: Object.fromEntries(Object.entries(packs).map(([k, [, d]]) => [k, d.length])), monsters: MONSTERS.length }));
