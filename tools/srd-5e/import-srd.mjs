// Imports SRD 5.2.1 content (from the Markdown conversion at
// https://github.com/downfallx/dnd-5e-srd-markdown, CC BY 4.0) into the 5e
// reference system's collections. Re-runnable: entries added from inside Hearth
// (flags.core.user_added) are kept.
//
//   node import-srd.mjs <folder with the .md files> <system folder> [spells|monsters|items|all]
//
// Attribution: This work includes material from the System Reference Document 5.2.1
// ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd.
// The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International
// License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

import fs from 'fs';
import path from 'path';

const [src, out, which = 'all'] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node import-srd.mjs <srd md folder> <system folder> [spells|monsters|items|all]'); process.exit(1); }
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const ABIL = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
const DAMAGE = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];

/** Split a file into entries under a heading level: [{ name, body }]. */
function entries(text, level, from = null, until = null) {
  let t = text;
  if (from) t = t.slice(t.indexOf(from));
  if (until && t.indexOf(until, 1) > 0) t = t.slice(0, t.indexOf(until, 1));
  const re = new RegExp(`^${'#'.repeat(level)} (.+)$`, 'gm');
  const heads = [...t.matchAll(re)];
  return heads.map((m, i) => ({ name: m[1].trim(), body: t.slice(m.index + m[0].length, heads[i + 1]?.index ?? t.length).trim() }));
}

/** Write a collection, keeping what was added from inside Hearth. */
function writePack(file, docs) {
  const at = path.join(out, 'packs', `${file}.json`);
  let kept = [];
  try { kept = JSON.parse(fs.readFileSync(at, 'utf8')).filter((d) => d?.flags?.core?.user_added); } catch { /* new */ }
  const mine = new Set(docs.map((d) => `${d.kind}/${d.name.toLowerCase()}`));
  const all = [...docs, ...kept.filter((d) => !mine.has(`${d.kind}/${String(d.name).toLowerCase()}`))];
  fs.writeFileSync(at, JSON.stringify(all, null, 2) + '\n');
  return all.length;
}

const field = (body, name) => body.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'm'))?.[1].trim() ?? '';

// ------------------------------------------------------------------ spells

function spells() {
  const text = read('spells.md');
  // Spells are the headings with a level line; others (a summoned creature's Actions…) belong to the spell above.
  const raw = entries(text.slice(text.indexOf('## Spell Descriptions')), 4);
  const isSpell = (e) => /^_(Level \d|.*Cantrip)/.test(e.body.split('\n').find((l) => l.trim()) ?? '');
  const list = [];
  for (const e of raw) {
    if (isSpell(e) || !list.length) list.push({ ...e });
    else list.at(-1).body += `\n\n#### ${e.name}\n\n${e.body}`;
  }
  return list.map(({ name, body }) => {
    const head = body.match(/^_(.+?)_\s*$/m)?.[1] ?? '';
    // "Level 3 Evocation (Sorcerer, Wizard)" or "Evocation Cantrip (Sorcerer, Wizard)"
    const lvl = head.match(/Level (\d)/);
    const level = lvl ? Number(lvl[1]) : 0;
    const school = (head.match(/(Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation)/i)?.[1] ?? 'evocation').toLowerCase();
    const classes = head.match(/\(([^)]+)\)/)?.[1] ?? '';
    const casting = field(body, 'Casting Time');
    const duration = field(body, 'Duration');
    const text2 = body.slice(body.indexOf('**Duration:**')).split('\n').slice(1).join('\n').trim();
    const firstPara = text2.split(/\n\n_(Using a Higher-Level Spell Slot|Cantrip Upgrade)\._/)[0];
    const attack = /melee spell attack/i.test(firstPara) ? 'melee' : /ranged spell attack/i.test(firstPara) ? 'ranged' : 'none';
    const save = (firstPara.match(/(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/i)?.[1] ?? '').toLowerCase();
    // The first damage (or healing) dice in the main text.
    const dmg = firstPara.match(/(\d+)d(\d+)(?:\s*(?:\+|plus)\s*(\d+|your spellcasting ability modifier))?\s+(\w+) damage/i);
    const heal = !dmg && firstPara.match(/regains?[^.]*?(\d+)d(\d+)(?:\s*(?:\+|plus)\s*(\d+|your spellcasting ability modifier))?/i);
    const dice = dmg ?? heal;
    const dtype = dmg ? dmg[4].toLowerCase() : heal ? 'healing' : 'force';
    const flat = dice && /^\d+$/.test(dice[3] ?? '') ? Number(dice[3]) : 0;
    const upcast = text2.match(/_Using a Higher-Level Spell Slot\._[^\n]*?increases by (\d+)d\d+ for each spell slot level above/i);
    const cantrip = /_Cantrip Upgrade\._/.test(text2);
    return {
      id: `srd_spell_${slug(name)}`, name, kind: 'spell', flags: {}, effects: [],
      data: {
        level, school, casting_time: casting.replace(/\s*(,|or)\s*Ritual\b/i, '').trim() || casting, range: field(body, 'Range'), components: field(body, 'Components'),
        duration: duration.replace(/^Concentration,\s*/i, ''), concentration: /^Concentration/i.test(duration), ritual: /Ritual/i.test(casting) || /\(Ritual\)/i.test(head),
        prepared: true, attack, save: ABIL[save] ?? 'none',
        dice: dice ? Number(dice[1]) : 0, die: dice ? Number(dice[2]) : 6,
        add_mod: !!dice && /spellcasting ability modifier/i.test(dice[0]), plus: flat,
        per_level: upcast ? Number(upcast[1]) : 0, cantrip: cantrip && level === 0,
        damage_type: DAMAGE.includes(dtype) || dtype === 'healing' ? dtype : 'force',
        description: `*${head}*\n\n${text2}`,
      },
    };
  });
}

// ------------------------------------------------------------------ monsters (and animals)

const CR_PB = (cr) => (cr < 5 ? 2 : cr < 9 ? 3 : cr < 13 ? 4 : cr < 17 ? 5 : cr < 21 ? 6 : cr < 25 ? 7 : cr < 29 ? 8 : 9);
const num = (s) => Number(String(s).replace('−', '-').replace('+', ''));
const clean = (s) => s.replace(/<br\s*\/?>/g, '').replace(/<\/?hr>/g, '').trim();
let seq = 0;
const iid = (name) => `${slug(name)}_${(++seq).toString(36)}`;

function statBlock(name, body, sectionLevel = 4) {
  const line = (label) => clean(body.match(new RegExp(`\\*\\*${label}\\*\\*\\s*([^\\n]*)`))?.[1] ?? '');
  const head = body.match(/^_(.+?)_\s*$/m)?.[1] ?? '';
  const hm = head.match(/^(\w+(?: or \w+)?)\s+(.+?),\s*(.+)$/);
  const ac = num(line('AC').match(/^(\d+)/)?.[1] ?? 10);
  const hp = num(line('HP').match(/^(\d+)/)?.[1] ?? 1);
  const speedText = line('Speed');
  const crText = line('CR');
  const crRaw = crText.match(/^([\d/]+)/)?.[1] ?? '0';
  const cr = crRaw.includes('/') ? num(crRaw.split('/')[0]) / num(crRaw.split('/')[1]) : num(crRaw);
  const pb = num(crText.match(/PB \+(\d+)/)?.[1] ?? CR_PB(cr));
  // The ability table: STR 8 −1 −1 …
  const abilities = {}, saves = {};
  for (const m of body.matchAll(/<strong>(STR|DEX|CON|INT|WIS|CHA)<\/strong><\/td>\s*<td>(\d+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>/g)) {
    const k = m[1].toLowerCase();
    abilities[k] = { value: num(m[2]) };
    saves[k] = { prof: num(m[4]) !== num(m[3]) };
  }
  // A few tables are laid out irregularly: take the first number after each ability's name.
  for (const m of body.matchAll(/<strong>(STR|DEX|CON|INT|WIS|CHA)<\/strong><\/td>\s*<td>([+−-]?\d+)/g)) {
    const k = m[1].toLowerCase();
    // A signed number is the modifier (the score went missing in conversion): the lowest score with it.
    abilities[k] ??= { value: /^[+−-]/.test(m[2]) ? Math.max(1, 10 + 2 * num(m[2])) : num(m[2]) };
    saves[k] ??= { prof: false };
  }
  const mod = (k) => Math.floor(((abilities[k]?.value ?? 10) - 10) / 2);
  const extra = ['Resistances', 'Vulnerabilities', 'Immunities', 'Gear'].map((l) => (line(l) ? `**${l}** ${line(l)}` : '')).filter(Boolean);
  const items = [];
  // Sections: Traits, Actions, Bonus Actions, Reactions, Legendary Actions.
  for (const sec of entries(body, sectionLevel)) {
    const activation = { Traits: '', Actions: 'Action', 'Bonus Actions': 'Bonus Action', Reactions: 'Reaction', 'Legendary Actions': 'Legendary Action' }[sec.name] ?? sec.name;
    const intro = clean(sec.body.split(/\n\*\*_/)[0]);
    for (const m of sec.body.matchAll(/\*\*_(.+?)\._\*\*\s*([\s\S]*?)(?=\n\s*\*\*_|$)/g)) {
      const aname = m[1].trim();
      const text = clean(m[2]);
      const atk = text.match(/_(Melee|Ranged|Melee or Ranged) Attack Roll:_\s*([+−-]\d+)/);
      const hit = text.match(/_Hit:_\s*(\d+)\s*\((\d+d\d+)(?:\s*([+−-])\s*(\d+))?\)\s*(\w+) damage/);
      if (atk && hit) {
        // A weapon whose own maths give the stated numbers: attack = ability mod + PB + bonus; damage = dice + adjust + mod + bonus.
        const ranged = atk[1] === 'Ranged';
        const stated = num(atk[2]);
        const useDex = ranged || (stated - pb === mod('dex') && mod('dex') > mod('str'));
        const m2 = useDex ? mod('dex') : mod('str');
        const bonus = stated - pb - m2;
        const flat = hit[3] ? (hit[3] === '+' ? 1 : -1) * num(hit[4]) : 0;
        const adj = flat - (m2 + bonus);
        items.push({ id: iid(aname), name: aname, kind: 'weapon', flags: {}, effects: [], data: {
          category: 'martial', range_type: ranged ? 'ranged' : 'melee', damage: `${hit[2]}${adj ? ` ${adj > 0 ? '+' : '-'} ${Math.abs(adj)}` : ''}`,
          damage_type: hit[5].toLowerCase(), versatile: '', finesse: !ranged && useDex, properties: text, mastery: '',
          range: text.match(/range ([\d/]+ ft\.)/)?.[1] ?? '', proficient: true, bonus, equipped: true, weight: 0,
        } });
      } else {
        const dice = text.match(/\((\d+d\d+(?:\s*[+−-]\s*\d+)?)\)/)?.[1]?.replace('−', '-') ?? '';
        const per = aname.match(/\((\d+)\/Day\)/i);
        items.push({ id: iid(aname), name: aname, kind: 'feature', flags: {}, effects: [], data: {
          source: name, description: `${intro && activation === 'Legendary Action' ? `${intro}\n\n` : ''}${text}`, activation,
          uses: { value: per ? num(per[1]) : 0, max: per ? num(per[1]) : 0 }, recharge: 'long', roll: dice,
        } });
      }
    }
  }
  return {
    id: `srd_monster_${slug(name)}`, name, kind: 'enemy', owners: [], flags: {}, effects: [],
    data: {
      cr, size: hm?.[1] ?? 'Medium', creature_type: hm?.[2] ?? '', alignment: hm?.[3] ?? '',
      ac, hp: { value: hp, max: hp }, speed: num(speedText.match(/(\d+)/)?.[1] ?? 30), speed_other: speedText.replace(/^\d+\s*ft\.?,?\s*/, ''),
      abilities, saves, skills_text: line('Skills'), senses: line('Senses').replace(/;/g, ','), languages: line('Languages'), exhaustion: 0,
      notes: [`*${head}*`, `**HP** ${line('HP')} · **Initiative** ${line('Initiative') || clean(body.match(/\*\*Initiative\*\*\s*([^<\n]*)/)?.[1] ?? '')}`, ...extra].join('\n\n'),
    },
    items,
  };
}

function monsters() {
  const out = [];
  // Monsters are ### headings with #### sections; animals are ## with ###.
  for (const [file, level] of [['monsters-A-Z.md', 3], ['animals.md', 2]]) {
    for (const e of entries(read(file), level)) {
      if (!/\*\*AC\*\*/.test(e.body) || /^(Traits|Actions|Bonus Actions|Reactions|Legendary Actions)$/.test(e.name)) continue; // not a stat block
      out.push(statBlock(e.name, e.body, level + 1));
    }
  }
  return out;
}

// ------------------------------------------------------------------ feats and magic items

/** The text after an entry's italic subtitle line. */
const afterSubtitle = (body) => body.replace(/^_.+?_\s*$/m, '').trim();

function feats() {
  // Keep effects already worked out on the system's feats (Alert's Initiative, Archery's +2…).
  let had = [];
  try { had = JSON.parse(fs.readFileSync(path.join(out, 'packs', 'feats.json'), 'utf8')); } catch { /* none */ }
  const CAT = { 'Origin Feat': 'origin', 'General Feat': 'general', 'Fighting Style Feat': 'fighting_style', 'Epic Boon Feat': 'epic_boon' };
  return entries(read('feats.md'), 4).filter((e) => /^_(Origin|General|Fighting Style|Epic Boon) Feat/.test(e.body)).map(({ name, body }) => {
    const sub = body.match(/^_(.+?)_\s*$/m)?.[1] ?? '';
    const before = had.find((d) => d.name.toLowerCase() === name.toLowerCase());
    return {
      id: `srd_feat_${slug(name)}`, name, kind: 'feat', flags: {}, effects: before?.effects ?? [],
      data: {
        category: CAT[Object.keys(CAT).find((k) => sub.startsWith(k))] ?? 'general',
        prerequisite: sub.match(/Prerequisite:\s*([^)]+)/)?.[1]?.trim() ?? '',
        repeatable: /_Repeatable\._/.test(body),
        description: afterSubtitle(body),
      },
    };
  });
}

function magicItems() {
  return entries(read('magic-items.md'), 4).filter((e) => /^_(Armor|Potion|Ring|Rod|Scroll|Staff|Wand|Weapon|Wondrous Item)/m.test(e.body.trim())).map(({ name, body }) => {
    const sub = body.match(/^_(.+?)_\s*$/m)?.[1] ?? '';
    return {
      id: `srd_item_${slug(name)}`, name, kind: 'item', flags: {}, effects: [],
      data: { quantity: 1, weight: 0, cost: sub.replace(/^[^,(]+(\([^)]*\))?,\s*/, ''), equipped: false, description: `*${sub}*\n\n${afterSubtitle(body)}` },
    };
  });
}

// ------------------------------------------------------------------ class and subclass features, levels 1–20

/** Features from "#### Level N: Name" headings: [{ level, name, text }]. */
function levelFeatures(body) {
  return entries(body, 4).map((e) => {
    const m = e.name.match(/^Level (\d+):\s*(.+)$/);
    return m ? { level: Number(m[1]), name: m[2].trim(), text: e.body } : null;
  }).filter(Boolean);
}

/**
 * Rebuild each class's (and subclass's) per-level feature grants from the SRD,
 * keeping everything else (hit points, ASIs, skills, choices). A feature that
 * already exists by name keeps its uses, dice and effects, with the SRD's text.
 */
function classFeatures() {
  const file = path.join(out, 'packs', 'classes.json');
  const docs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const text = read('classes.md');
  const handled = /^(Ability Score Improvement|Epic Boon|Fighting Style|.+ Subclass)$/; // their own grants
  let added = 0;
  const known = new Map(); // feature name → existing feature (to keep uses/dice/effects)
  for (const d of docs) for (const g of d.advancement ?? []) for (const it of g.items ?? []) known.set(it.name.toLowerCase(), it);
  const featureItem = (f, owner) => {
    const had = known.get(f.name.toLowerCase());
    const data = { ...(had?.data ?? {}), source: `${owner} ${f.level}`, description: f.text };
    data.activation ??= ''; data.uses ??= { value: 0, max: 0 }; data.recharge ??= 'long'; data.roll ??= '';
    added++;
    return { id: had?.id ?? `srd_feat_${slug(owner)}_${f.level}_${slug(f.name)}`, name: f.name, kind: 'feature', flags: {}, effects: had?.effects ?? [], data };
  };
  const rebuild = (doc, feats, key, isSub) => {
    // Drop the old per-level feature grants (only "items" grants of features); keep the rest.
    const keep = (doc.advancement ?? []).filter((g) => !(g.kind === 'items' && (g.items ?? []).every((i) => i.kind === 'feature')));
    const byLevel = new Map();
    for (const f of feats) if (!handled.test(f.name)) (byLevel.get(f.level) ?? byLevel.set(f.level, []).get(f.level)).push(f);
    const grants = [...byLevel].map(([lvl, list]) => ({
      id: `${key}_${isSub ? 'sub_' : ''}${lvl}`, level: lvl, label: `${doc.name} ${lvl}`, kind: 'items', items: list.map((f) => featureItem(f, doc.name)),
    }));
    doc.advancement = [...keep, ...grants].sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  };
  for (const cls of entries(text, 2)) {
    const doc = docs.find((d) => d.kind === 'class' && d.name === cls.name);
    if (!doc) continue;
    const key = slug(cls.name);
    const featureBlock = cls.body.slice(cls.body.indexOf(`### ${cls.name} Class Features`));
    const classPart = featureBlock.split(/\n### /)[0];
    rebuild(doc, levelFeatures(classPart), key, false);
    for (const sub of entries(cls.body, 3)) {
      const m = sub.name.match(/Subclass:\s*(.+)$/);
      if (!m) continue;
      const sdoc = docs.find((d) => d.kind === 'subclass' && d.name === m[1].trim());
      if (sdoc) rebuild(sdoc, levelFeatures(sub.body), slug(sdoc.name), true);
      // The class's own subclass choice carries a copy of the subclass: refresh it too.
      for (const g of doc.advancement) if (g.kind === 'choice') g.items = (g.items ?? []).map((i) => (i.kind === 'subclass' && sdoc && i.name === sdoc.name ? structuredClone(sdoc) : i));
    }
  }
  fs.writeFileSync(file, JSON.stringify(docs, null, 2) + '\n');
  return added;
}

// ------------------------------------------------------------------ use counts that grow

// Features whose number of uses follows a rule (SRD 5.2.1 class tables and text).
// @class_level is the character's level; @prof its Proficiency Bonus.
const USES = {
  'Rage': '@class_level >= 17 ? 6 : @class_level >= 12 ? 5 : @class_level >= 6 ? 4 : @class_level >= 3 ? 3 : 2',
  'Bardic Inspiration': 'max(1, @abilities.cha.mod)',
  'Channel Divinity': "@item.source == 'Paladin 3' ? (@class_level >= 11 ? 3 : 2) : (@class_level >= 18 ? 4 : @class_level >= 6 ? 3 : 2)",
  'Wild Shape': '@class_level >= 17 ? 4 : @class_level >= 6 ? 3 : 2',
  'Second Wind': '@class_level >= 10 ? 4 : @class_level >= 4 ? 3 : 2',
  'Action Surge': '@class_level >= 17 ? 2 : 1',
  'Indomitable': '@class_level >= 17 ? 3 : @class_level >= 13 ? 2 : 1',
  "Monk's Focus": '@class_level',
  'Lay On Hands': '5 * @class_level',
  'Favored Enemy': '@class_level >= 17 ? 6 : @class_level >= 13 ? 5 : @class_level >= 9 ? 4 : @class_level >= 5 ? 3 : 2',
  'Font of Magic': '@class_level',
  'Pact Magic': '@class_level >= 17 ? 4 : @class_level >= 11 ? 3 : @class_level >= 2 ? 2 : 1',
  'Breath Weapon': '@prof',
  'Stonecunning': '@prof',
  'Adrenaline Rush': '@prof',
  "Cloud's Jaunt": '@prof', "Fire's Burn": '@prof', "Frost's Chill": '@prof', "Hill's Tumble": '@prof', "Stone's Endurance": '@prof', "Storm's Thunder": '@prof',
};

/** Give those features their formula (in classes and species, including copies inside grants). */
function useFormulas() {
  let n = 0;
  const visit = (item) => {
    const f = USES[item?.name];
    if (f && item.kind === 'feature') { item.data.uses = { ...(item.data.uses ?? {}), formula: f }; n++; }
    // Dice that grow with level count the class's level too (Sneak Attack, Second Wind…).
    if (item?.kind === 'feature' && typeof item.data?.roll === 'string') item.data.roll = item.data.roll.replace(/@level(?!\w)/g, '@class_level');
    for (const g of item?.advancement ?? []) for (const i of g.items ?? []) visit(i);
  };
  for (const file of ['classes', 'species']) {
    const at = path.join(out, 'packs', `${file}.json`);
    const docs = JSON.parse(fs.readFileSync(at, 'utf8'));
    docs.forEach(visit);
    fs.writeFileSync(at, JSON.stringify(docs, null, 2) + '\n');
  }
  return n;
}

// ------------------------------------------------------------------ run

const counts = {};
if (which === 'spells' || which === 'all') counts.spells = writePack('spells', spells());
if (which === 'monsters' || which === 'all') counts.monsters = writePack('monsters', monsters());
if (which === 'classes' || which === 'all') { counts.class_features = classFeatures(); counts.use_formulas = useFormulas(); }
if (which === 'items' || which === 'all') {
  counts.feats = writePack('feats', feats());
  counts.magic_items = writePack('magic_items', magicItems());
  // The magic items collection is new: declare it in hearth.toml (GM only; share entries as you like).
  const toml = path.join(out, 'hearth.toml');
  if (fs.existsSync(toml) && !fs.readFileSync(toml, 'utf8').includes('id = "magic_items"')) {
    fs.appendFileSync(toml, '\n[[packs]]\nid = "magic_items"\nlabel = "Magic items"\nkind = "item"\npath = "packs/magic_items.json"\npublic = false\n');
  }
}
console.log(JSON.stringify(counts));
