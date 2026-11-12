# System rules

A system can declare its rules in `hearth.toml` instead of writing code. The server works them out (so players can't fudge them) and writes the results into each actor's `derived` values, which sheets, rolls and macros read. `packages/d20-lite/hearth.toml` is a small working example.

What you can declare:

| | What it's for | Example |
|---|---|---|
| **Formulas** | Calculated values | ability modifiers, AC, skill bonuses |
| **Tables** | Values looked up by level (or anything) | proficiency bonus, spell slots |
| **Resources** | Things with a current and max value that reset on rests | hit points, spell slots, uses per day |
| **Actions** | Rolls an actor or item can make, with follow-ups and costs | attack, then damage; cast a spell |
| **Effects** | Changes to values from items, conditions and spells | +2 AC from a shield, disadvantage when poisoned |

A system can still have a Rhai `prepare_actor` script; its result is merged over the declared values.

## Formulas

```toml
[actor_types.character.formulas]
"abilities.*.mod" = "floor((@this.value - 10) / 2)"     # one per entry in data.abilities
prof = "table('proficiency', @level)"
ac = "10 + @abilities.dex.mod"
"skills.*.bonus" = "@abilities[@this.ability].mod + @this.prof * @prof"
```

The key is where the value goes (`derived.ac`, `derived.abilities.str.mod`…). A `*` repeats the formula for every key in the actor's data at that spot, and `@this` is that entry. Formulas can use each other in any order; a loop (A needs B needs A) is reported instead of hanging.

**The formula language**

| | |
|---|---|
| `@path` | A value: the actor's data, or a formula of that name. `@abilities[@this.ability].mod` picks a key from another value |
| `@item.x` | In item formulas, effects and actions: the item's own data or formula `x` (also `@item.name`) |
| `+ - * / %`, `( )` | Arithmetic. Text joins with `+` (`@item.damage + "+2"`) |
| `== != < <= > >=`, `&& \|\| !` | Comparisons and logic |
| `a ? b : c` | If a then b, else c |
| `floor ceil round abs min max sum clamp` | Maths. `min`/`max`/`sum` also take lists |
| `table('name', key)` | Look up a table |
| `count_items('kind')`, `sum_items('kind', 'path')`, `max_items(…)` | Over the actor's items, e.g. total level across classes |
| `has_status('poisoned')` | Whether a condition is on |
| `has_item('spell', 'Fireball')` | Whether the actor has an item of that kind and name |
| `len`, `has`, `if(c, a, b)`, `num`, `text`, `replace(text, from, to)` | Odds and ends |

Missing values count as 0, so a typo gives a wrong number rather than a broken sheet. Problems are listed for the GM at the bottom of the automatic sheet (and in `derived._errors`).

**Item formulas** work the same way and land in `derived.items.<item id>`:

```toml
[item_types.weapon.formulas]
attack = "@item.bonus + max(@abilities.str.mod, @item.finesse ? @abilities.dex.mod : -99) + @prof"
```

## Tables

```toml
[tables.proficiency]   # step table: the highest key not above the lookup wins
1 = 2
5 = 3
9 = 4

[tables.slots]         # values can be lists: table('slots', @level)[0]
1 = [2, 0, 0]
3 = [4, 2, 0]
```

## Resources and rests

```toml
rests = ["short", "long"]              # top of hearth.toml

[actor_types.character.resources.hp]
label = "Hit points"
max = "@hp.base + @abilities.con.mod * @level"   # optional; otherwise data's max
reset = { long = "max" }
bar = true                                        # show on tokens

[actor_types.character.resources.hit_dice]
max = "@level"
reset = { long = "@value + max(1, floor(@max / 2))" }

[item_types.feature.resources.uses]
max = "@prof"
reset = { short = "max", long = "max" }
```

Resources keep `{ value, max }` in data. A rest sets each resource that has a reset for that rest: `"max"`, or a formula using `@value` and `@max` (kept between 0 and the max). Sheets offer rests with `data-rest="long"`; the API is `hearth.rest(actorId, 'long')`.

## Actions

```toml
[[item_types.weapon.actions]]
id = "attack"
label = "Attack"
kind = "attack"                 # attack / check / save: advantage applies. damage: crits double the dice
roll = "1d20 + @item.attack"
then = ["damage"]               # follow-up buttons on the chat card

[[item_types.weapon.actions]]
id = "damage"
label = "Damage"
kind = "damage"
roll = "@item.damage + @item.dmg_mod"

[[item_types.spell.actions]]
id = "cast"
label = "Cast"
kind = "damage"
roll = "{@cast_level + 2}d6"                            # {formula} blocks are worked out first
cost = { path = "actor.spell_slots.l{@cast_level}" }    # spend 1 (amount = "…" to change)
when = "@item.prepared"                                 # only when this is true
```

- **Rolls**: `@paths` are filled in (text like `1d8` is kept as dice), then the server rolls.
- **Advantage**: for `attack`, `check` and `save` actions, the first `d20` becomes `2d20kh1` (or `kl1`). It's the player's choice (Alt-click / Ctrl-click on sheets), otherwise it comes from the actor's `mods.<kind>.advantage` and `mods.<kind>.disadvantage` values (both on cancels out). Conditions usually set these.
- **Crits**: a natural 20 on an attack marks the follow-ups as critical; critical damage doubles the dice (`1d8 + 3` → `2d8 + 3`).
  - An attack's `threat` (a formula) widens the range: `19` threatens on 19–20. With `confirm = true`, a threat isn't a critical yet: the card offers **Confirm critical**, a second roll of the attack whose follow-ups are critical.
  - A damage action's `crit_mult` (a formula, e.g. `3`) rolls the damage that many times on a critical instead of doubling the dice: `(1d12 + 3) + (1d12 + 3) + (1d12 + 3)`.
- **Costs**: `cost.path` is a resource on the item (`uses`), on the actor with `actor.` in front, or on another of the actor's items: `item[class:Wizard].slots.l3` (a spell spending its class's slot), or `item[class:].slots.l3` for the first class with one left. Without enough left, the action is refused.
- **Levels**: `level` in the options (upcasting) is `@cast_level`.
- **Uses that grow**: an item's resource can carry its own max formula, `uses.formula` (e.g. `@abilities.cha.mod`, `@level >= 6 ? 3 : 2`, `@prof`). It beats the type's formula, is worked out live (`derived.items.<id>.uses.max`), and rests refill to it. Sheets show a box for it under the item's uses.
- **When**: actions whose `when` is false right now are listed in `derived._off` (actor actions) and `derived.items.<id>._off` (item actions); sheets hide their buttons.

Sheets use actions with `data-use="attack" data-item-id="…"`; the API is `hearth.actions.use(actorId, itemId, 'attack', { mode, crit, level })`. Actor types can have actions too (no item id).

## Effects and conditions

An effect is a list of changes. Actors carry effects (`actor.effects`), and so do items (`item.effects`, which apply to whoever carries the item):

```json
{ "name": "Chain shirt", "requires": "@item.equipped",
  "changes": [ { "path": "ac", "mode": "upgrade", "value": "13 + min(@abilities.dex.mod, 2)" } ] }
```

| Mode | Does | Example |
|---|---|---|
| `set` | Replaces the value | Belt of Giant Strength: `abilities.str.value` = 21 |
| `upgrade` | At least this | Armour: AC at least 13 + Dex |
| `downgrade` | At most this | Exhaustion: speed at most 10 |
| `multiply` | Multiplies | Slowed: speed × 0.5 |
| `add` (default) | Adds | Shield: AC + 2 |

They apply in that order, so the base is chosen first (armour or unarmoured), then bonuses are added.

**Bonus types.** An `add` change can name a type: `{ "path": "ac_bonus.deflection", "mode": "add", "value": "2", "type": "deflection" }`. Bonuses of the same type on the same value don't stack: only the biggest counts (a ring of protection +1 and a cloak +2 give +2). Untyped bonuses and all penalties (negative values) always add up, and so do types the system lists as stacking (`stacking = ["dodge", "circumstance"]` at the top of `hearth.toml`, or in the builder under Rules › Rests and bonuses). `requires` is a formula checked against the item (it sees values before effects). Effects can target any path, including data values that formulas read (a belt's Strength feeds the Strength modifier).

**Effects on the item itself.** A change whose path starts with `item.` changes the item the effect belongs to rather than its owner: `{ "path": "item.damage", "mode": "add", "value": "'1d6'" }` makes a weapon's damage `1d8+1d6`. Items can carry **parts** (`item.parts`): other items attached to them, such as a weapon's flaming ability or armor's mithral. A part's effects apply as if they were the item's own (`requires` sees the item as `@item`), and formulas can total them with `sum_parts('bonus')`, `max_parts('cl')`, `count_parts()` or `count_parts('part_type', 'material')`.

## The item forge

An item type can declare **forge** rules, and then the GM (and, if the world allows, players) can make items of that type in the forge: start from a base item, set its numbers (enhancement…), attach parts, and see the price and any broken rules as you go.

```json
"forge": {
  "price": "@item.value + 2000 * (@item.enhancement + sum_parts('bonus')) * (@item.enhancement + sum_parts('bonus'))",
  "parts": ["enchantment"],
  "fits": "@part.applies_to == 'weapon'",
  "checks": [ { "when": "@item.enhancement > 5", "message": "The enhancement bonus goes up to +5" } ],
  "craft": { "feat": "'Craft Magic Arms and Armor'", "bonus": "@skills.spellcraft.total", "dc": "5 + 3 * @item.enhancement",
             "cost": "@price / 2", "days": "ceil(@price / 1000)", "currency": "currency.gp" }
}
```

- `name` (optional) suggests a name for what's being made (`'Wand of ' + parts('name')[0]`); the forge uses it until the maker types their own.
- **Spells as parts.** A consumable can take a spell as its part: `replace(parts('roll')[0], '@spells.caster_level', text(@item.cl))` gives the spell's roll at the item's own caster level, for a Use button to roll.
- `price`, `checks` and `craft` are formulas about the item (`@item…`, with its parts applied) and the crafter. `@price` is the worked-out price. `fits` decides which parts can go on it (`@part` is the part).
- **Create** makes the item outright: on a character, or (GM, from the Items directory's ⚒ Forge) into the Items directory, folder *Forged*.
- **Craft** makes it as a character: they need the feat (an item of that name) and the money; the money is spent, the check is rolled (`1d20 + bonus` against the DC), and the item is made on a success. The result goes to chat.
- **Who may use it** is each world's choice (GM: Settings → **⚒ Item forge…**): GM only, players craft by the rules, or players make anything.

Forge rules are edited in the system builder (select an item type: **Item forge**), and saved as the type's `forge` in `builder.json` (or written in `hearth.toml`). `nth_parts('level', 2)` gives the second-highest value among the parts, for prices that rank them (a staff's spells).

**Conditions** are effects the system names, which players and the GM switch on and off:

```toml
[[conditions]]
id = "poisoned"
name = "Poisoned"
changes = [
  { path = "mods.attack.disadvantage", mode = "set", value = "1" },
  { path = "mods.check.disadvantage", mode = "set", value = "1" },
]
```

An actor has a condition when one of its effects has `status = "poisoned"`. Sheets toggle them with `data-toggle-condition="poisoned"` (the button gets the `on` class while it's on), and formulas can ask `has_status('poisoned')`.
