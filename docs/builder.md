# System builder

The system builder lets a GM design a game system inside Hearth, without editing files: the stats, resources, lists, rolls and item types, and the rules that connect them. It's in **Settings → 🛠 System builder** (GM only) and edits the system the current world uses.

**Starting a system.** In the launcher's **Game Systems** tab, **New system** makes an empty one, then offers to make a world that uses it (a "workshop" world to build it in). Built-in systems can't be changed, so they have **Copy to edit**, which makes your own copy under a new name; systems you made or installed have **Copy** too.

Changes save as you type. The server reloads the system straight away: every actor is recalculated, actors gain any new fields, and open sheets redraw. **Test character** opens (or makes) an actor of the selected type, so you can watch its sheet change as you build.

## The tree

A system is a tree. At the top are **actor types** (characters, monsters, vehicles) and **item types** (weapons, spells, classes, features). Inside them:

| Node | What it is | On the sheet |
|---|---|---|
| Group | A section that holds other nodes | Top-level groups are tabs; inner ones are boxes |
| Number, Text, Long text, Checkbox | Values players fill in | Inputs |
| Choice | One of a set of options, typed in or taken from a list's entries (e.g. "which ability") | A dropdown |
| Formula | A calculated value | Shown, read-only |
| Resource | Current and max (hit points, uses, slots). Rests can restore it; it can show as a token bar | `value / max` |
| List | Repeating entries with the same fields (abilities, skills, saves). Starts with the entries you list; optionally players can add more | A table |
| Action | A roll: attack, check, save, damage, healing… with follow-ups and costs | A button |
| Effect (item types) | A change every item of the type gives its owner while a condition holds (armour's AC, a ring's bonus) | — |

Each node has a **name** and a **key**. The key is how formulas refer to it: a field `str` in a list `abilities` is `@abilities.str.value`. A new field's key follows its name until you edit it; after the first save it stays put, because data is stored under the key (changing it later disconnects data saved under the old key).

Under **Rules** are the system-wide parts: **tables** (values looked up by level, like proficiency), **conditions** (poisoned, prone… that switch changes on and off) and **rests** (short, long). Give each condition a **What it does** text: it shows when you hover over the condition on a sheet, and in the lookup.

## Formulas

Formulas use the language in [rules.md](rules.md): `floor((@this.value - 10) / 2)`, `table('proficiency', @level)`, `@abilities[@item.ability].mod + @combat.prof`, `@level >= 5 ? 2 : 1`. Under each formula box, **Values you can use** lists the paths in that type and inserts them for you. Inside a list, `@this` is the entry. In item types, `@item.x` is the item's own field and the owner's values are available directly.

Problems (a formula that doesn't parse, two fields with the same key) are listed next to the save status. Problems found while calculating a particular actor are shown to the GM at the bottom of that actor's sheet.

## Classes, ancestries and backgrounds

Item types can **give features**: tick that in the type's settings (the Advancement box). For classes, also pick the number field that **counts levels**. Then each item of the type (the Fighter, the Elf…) carries its own list of grants, edited in the item's window by the GM:

| Grant | Does | Example |
|---|---|---|
| Gives items | Adds copies of items | Fighter 1: Second Wind |
| Choose from items | The player picks some | Fighting style: Archery or Defense |
| Spend points | The player raises entries of a list (optionally **only** some of them) | Ability score improvement: +2, at most 2 on one, none above 20; Fighter skills: 2 of Athletics, Perception… |
| Roll | Rolls dice (or takes the average) and records the result in a list on the item | Hit points: `1d{@item.hit_die}`, recorded in `hp_rolls` |
| Pick any of a type | The player picks from every item of a type they can take (collections and the Items directory), optionally only those whose fields match (**Only where** `feat_type = combat`) | A feat: any feat; a fighter's bonus feat: a combat feat |

Any grant can have an **Only when** formula, checked with the new level in place: it's skipped when false (a full hit die only when `@level == 1`; a favored class bonus only when `@favored_class == @item.name`).

A points grant's **Points** and **Cap** can be formulas, worked out with the new level in place: skill ranks of `@item.skill_ranks + @abilities.int.mod` per level, none above `@level`. The server works them out and the level-up dialog shows the result.

**Advancement by character level.** An actor type (in the builder: select the type) can have grants of its own by *total* level, across all classes: a feat at levels 1, 3, 5… (level 1, again every 2), +1 to an ability every 4 levels. They come in the dialog of whichever class level reaches that total, and go if that level is taken back.

A points grant asks only for as many points as can really be spent (its amount, limited by the allowed entries and caps). If the actor has nothing to raise, such as a monster with no skills list taking a Fighter level, the step is skipped and says so, rather than blocking the level.

For classes, a grant can **repeat**: *Then again every N levels*, optionally *until level M*. One row gives hit points at every level from 2 (every 1), or ability points at 4, 8, 12 and 16 (every 4, until 16).

**Starting advancement:** in the system builder, a type that gives features has a *Starting advancement for every new …* box. A new item of the type made with **+ New item** (Start from: *Blank*) starts with those grants, so every new class arrives with its hit points and ability score improvements and needs only its features and subclass. **+ New item** can also start from a **copy** of any item of that type in the world or a collection (e.g. a copy of the Fighter).

**Into the system:** a GM can put a finished class (or any item, actor or journal entry) into one of the system's own collections with **📚 Add to the system's collection…** on its window. It's written into the system's files, so it appears in every world using the system: in the Add dialog, the Collections sidebar and the Ctrl+Space lookup. Adding one with the same name and type again asks, then replaces it. Entries added this way are marked `flags.core.user_added`, for tools that regenerate a system's collections to keep. It's a copy: changes to the world item need adding again.

Pick items for a grant from the Items directory, or drag them in from the Items directory or a collection. A granted item that has grants of its own (✦, like a subclass) brings them at the same class levels: the Champion's level-3 features arrive with Fighter 3.

On a character's sheet, **⬆ Advance** adds an ancestry, background or class, or levels up a class; a new character gets a prompt to start. The dialog shows what the step gives, asks for the choices, points and rolls, and the server applies it. **+ Add** on a sheet's list (Classes, Spells, Weapons…) opens a searchable list of that type from the system's collections, world collections and the Items directory; picking a class, species, background or subclass runs the Add steps above, and picking anything else gives the character a copy. Only the GM gets a *blank* option, and not for types that give features, so players choose from what the GM has provided. Each class row shows its level with **Level up** and **Level down** (take the last level back: its features, points and hit points go with it), and every item has **🗑** (also at the bottom of its own window): for a class, ancestry, background or subclass it removes the item *and everything it gave*, across all its levels; for anything else, just the item.

Formulas can total it all up: `level = sum_items('class', 'levels')`, a class's `hp_total = sum(@item.hp_rolls)`, hit points `max = sum_items('class', 'hp_total') + @abilities.con.mod * @level`. When a level up or down changes a resource's max, the current value moves by the same amount.

Individual items can also carry **effects** (a ring's +1 AC, an ancestry's +2 Dexterity): in the item's window, **Effects on whoever has it**. They can be switched off, and can apply only while a formula holds (`@item.equipped`).

## Character creation (ability scores)

Under **Rules → Character creation**, a system lists the steps a new character goes through first and the methods each offers. A step fills a list (`abilities`, field `value`); **+ Ability scores step** adds the usual five:

| Kind | How it works | Its numbers |
|---|---|---|
| Fixed values | Assign the values to the scores, each once | the values (15, 14, 13, 12, 10, 8) |
| Point buy | Spend a budget; each score costs what the table says | points (27), lowest and highest (8–15), the cost table |
| Roll dice | Roll a formula some number of times, then place the results (or **in order**) | the dice (`4d6kh3`, `3d6`…), how many rolls |
| Enter your own | Type them in | lowest and highest (3–18) |

A step can be **for** some actor types only (tick them; none ticked means every type), so monsters don't get asked for ability scores. The "New character? Add their class…" prompt follows the same choice.

**Each world chooses** (GM: Settings → **🎲 Character creation…**): which methods players may use, the default, any of the numbers above (e.g. **32 points** instead of 27; blank uses the system's), and whether scores lock once set.

New characters get a **Set ability scores** prompt at the top of their sheet. The server makes the rolls (posted to chat, and kept: once rolled, that method stays) and checks every choice: each value once, the budget, the limits, only allowed methods. Once set they're locked; the GM's **↺ Redo ability scores** on the character's window lets the player set them again (rolls are forgotten). Bonuses from species and backgrounds are added by their own grants afterwards.

In `builder.json` this is `creation`; each world's choices are `settings.core.creation.<step>` (`allowed`, `default`, `methods.<id>` overrides, `lock`).

## Where it's saved

The builder writes `builder.json` in the system's folder. When Hearth loads the system it compiles that file into data templates and rules: the same things a hand-written `hearth.toml` declares (see [packages.md](packages.md) and [rules.md](rules.md)). So:

- A system can mix both: hand-written parts of `hearth.toml` win where both say something, and anything the builder can't express (custom sheets, Rhai scripts) still works.
- Sheets are laid out from the tree, unless the system has its own sheet template or a module registers a custom sheet.
- Systems made in the builder share like any other: zip the folder.

Systems that came with Hearth live in the app's install folder and can't be changed; the builder says so if you try. Copy the system to your packages folder (shown on the launcher) under a new id to edit it.
