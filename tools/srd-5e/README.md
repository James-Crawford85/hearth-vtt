# D&D 5e SRD reference system: build tools

Two scripts build the `d-d-5e-srd` reference system:

| Script | Makes |
|---|---|
| `gen-srd.mjs` | The system itself: `builder.json` (character and monster types, item types, character creation, sheet layout), `hearth.toml`, `NOTICE.md`, and the hand-written collections: classes and subclasses (levels 1–5), species, backgrounds, weapons, armor, gear, rules |
| `import-srd.mjs` | Collections read from the SRD 5.2.1 text: **spells** (339), **monsters and animals** (330), **feats** (17) and **magic items** (258) |

```bash
node gen-srd.mjs <system folder>
node import-srd.mjs <srd markdown folder> <system folder> all
```

Run the importer after the generator: the generator writes small placeholder spells, monsters and feats that the importer replaces. Both keep entries added from inside Hearth ("Add to the system's collection", marked `flags.core.user_added`), and the importer keeps effects already set on feats with the same name.

The SRD source is the Markdown conversion of SRD 5.2.1 at https://github.com/downfallx/dnd-5e-srd-markdown (CC BY 4.0): download its `.md` files into one folder.

What the importer reads:

- **Spells:** level, school, classes, casting time, range, components, duration, concentration, ritual, the full text, the attack or saving throw, and the first damage or healing dice (with "+ spellcasting modifier", flat bonuses, upcasting dice and cantrip scaling), so Cast, Spell attack and Damage roll.
- **Monsters:** size, type, alignment, AC, HP, speeds, the six abilities and proficient saves, skills, senses, languages, CR, resistances and gear (in the notes). Attacks become weapons whose bonus and damage are set so they roll the stat block's exact numbers; other actions, bonus actions, reactions, legendary actions and traits become features with their text and dice.
- **Class features (levels 1–20):** each class's and subclass's "Level N: Feature" entries replace their per-level feature grants (hit points, ASIs, skills, Fighting Style and subclass choices stay as the generator made them). A feature that already exists by name keeps its uses, dice and effects, with the SRD's text.
- **Feats:** category, prerequisite, repeatable, text. **Magic items:** type and rarity, text (a new GM-only "Magic items" collection).

## Attribution

This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.
