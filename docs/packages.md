# Packages

A package is a folder in `packages/` with a `hearth.toml`. Restart the server after adding one.

## Sharing and installing

To share a package, zip its folder. `hearth.toml` can sit at the root of the zip or inside one top-level folder, so GitHub's **Code → Download ZIP** and release archives work as-is. In the desktop app, use **Install from link** (paste the `.zip` URL) or **Install from file** on the Game Systems or Add-on Modules tab. Installed packages go to the app's `packages` folder and override built-in ones with the same `id`. Reinstalling replaces the old version. The GM turns modules and themes on in **Settings**.

```toml
id = "my-system"          # lowercase letters, digits, '-'. Must be unique.
type = "system"           # "system" | "module" | "theme"
name = "My System"
version = "0.1.0"
description = "…"
authors = ["You"]
license = "MIT"
systems = []              # modules only: compatible system ids (empty = any)

[client]
scripts = ["main.js"]     # ES modules; `export default function init(hearth, pkg)`
styles  = ["style.css"]

[server]
script = "rules.rhai"     # optional Rhai script

[actor_types.character]
label = "Character"
sheet = "sheets/character.html"   # optional; see sheets.md
template = { hp = { value = 10, max = 10 }, level = 1 }

[item_types.weapon]
label = "Weapon"
template = { damage = "1d8" }
```

All paths are relative to the package folder and can't leave it. Files are served at `/packages/<id>/<path>`.

## Systems

A world uses exactly one system, chosen when the world is created (`--system`). The smallest possible system is a manifest with one actor type (see `packages/freeform`). Hearth generates a sheet from the template.

## Combat

A system sets how initiative is rolled:

```toml
[combat]
initiative = "1d20 + @initiative"   # @paths resolve against the combatant's actor
```

`@paths` look in the actor's `derived` values (from `prepare_actor`) first, then its `data`. Without a `[combat]` section, initiative is `1d20`. If a combatant's actor lacks a value the formula needs, that roll falls back to `1d20`.

## Server scripts (Rhai)

Define any of these functions. Each runs for the system and every enabled module that defines it.

```rhai
// Called after any change to an actor or its items.
// Return a map; results from all packages are merged into actor.derived.
fn prepare_actor(actor) {
    #{ str_mod: floor_div(actor.data.str - 10, 2) }
}

// Called for every roll. Return a map to store in message.flags[<package id>], or ().
fn on_roll(roll, actor) {
    // roll.total, roll.formula, roll.groups[i].sides, roll.groups[i].dice[j].value / .kept
    ()
}
```

Helpers: `roll("2d6") -> int`, `floor_div(a, b) -> int` (rounds down; Rhai's `/` truncates toward zero), `print(x)` (goes to the server log).

Derived values work in roll formulas: `1d20 + @str_mod`.

## Modules

Modules are client scripts and/or server scripts. Example (`packages/dice-tray`):

```js
export default function init(hearth, pkg) {
  hearth.ui.chatControls.append(
    hearth.ui.el('button', { text: 'd20', on: { click: () => hearth.roll('1d20') } }));
}
```

Store module data in `flags[pkg.id]` on entities, or world settings via `hearth.settings.set(pkg.id, key, value)`. See [client-api.md](client-api.md).

## Themes

A theme is a stylesheet. Override the custom properties at the top of `web/css/core.css` (`--bg`, `--panel`, `--text`, `--accent`, `--font`, …) and add any extra rules. See `packages/theme-parchment`.
