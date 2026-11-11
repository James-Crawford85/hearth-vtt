# Sheets

This guide is for anyone making a character sheet look a particular way: a GM in the system builder, a programmer, or an AI asked to "make this sheet look like X".

## Choosing a sheet for each type

Every top-level type, actor or item (Character, Monster, Weapon, Spell, Feat…), has a **Sheet** setting in the system builder:

| Sheet | What you get |
|---|---|
| **Generated** (default) | Laid out from the type's tree and its Layout settings (below). |
| **Designed** | Your own layout: blocks on a grid, each showing a field, a list of items, a heading, text… (see [Designed layouts](#designed-layouts)). It starts as a copy of the generated sheet. |
| **Custom HTML** | A hand-written or AI-written HTML file in the system folder (see [Custom HTML sheets](#custom-html-sheets)). |
| **None** (item types) | No window of its own: on a character sheet, clicking the item's name opens its details in place, editable, under the row. Good for small things like features and feats. |

Every type also has a **window width**.

For actor types, a JS renderer registered with `hearth.sheets.register(kind, (root, actor, hearth) => { … })` overrides all of these; with no builder type at all, an automatic form is built from `actor.data`. Whichever sheet it is, the system's **Sheet style** (system builder → Rules → Sheet style) applies on top.

## Three levels of control

| You want | Use |
|---|---|
| Fields in sensible places, a few big numbers, some things on top | **Layout settings** in the system builder (below). No code. |
| Your colours and fonts, or one value in red | **Sheet style**: colour pickers and fonts, plus an Extra CSS box. |
| An exact layout (a classic two-page sheet, a dense table, a picture behind it) | **A custom HTML sheet**: make one from the layout, then edit the HTML. |

The three build on each other. A custom sheet starts as an export of the generated one, with the same classes and bindings, so the Sheet style still applies and the rules keep working.

## Layout settings (system builder)

Each node in the tree has a **Layout** box:

| Setting | On | Does |
|---|---|---|
| Hide the label / title | fields, groups, lists, actions | Shows the value or input only (actions show just 🎲). The name stays as a tooltip and for screen readers. |
| Width | anything | 1–4 columns of its group's grid, or the whole row. |
| Display | numbers, text, choices, formulas, resources, actions | Normal, **big number box**, **round badge**, **label beside value**, or **plain** (no box). |
| Columns inside | groups | A fixed number of columns, or as many as fit. |
| Frame | groups | A box, a filled card, or none. |
| Placement | top-level groups | A **tab** (default); the **header** (small values under the name: level, alignment…); the header's **right-hand side** (HP, AC); **always on top** above the tabs; or a **side column** beside them. |
| Tab icon | tabs | One of the built-in drawings, or any emoji. |
| No column heading | fields inside a list | Hides that column's heading. |

Groups marked **Layout only** arrange the sheet without adding to `@paths`, so a "Combat" tab can hold `@ac` rather than `@combat.ac`.

The header always shows the actor's picture (owners click it to upload a new one) and name.

### Item lists

Each item type has an **On the character sheet** box:

| Setting | Does |
|---|---|
| Listed on | The **Items** tab (default), **a tab of its own** (with an icon), or one of the actor's tabs (spells on the Spells tab, weapons on Equipment). |
| Group by | A field to group the list by, with a heading per value: spells by level ("Level 1", "Level 2"), feats by category. |
| List title | The list's heading, e.g. "Spellbook" (default: the type's name). |
| Show beside each name | Fields shown as small chips on each row (school, casting time, damage). |

Each row has the item's action buttons. A button whose **Only when** is false right now (Cast on a cantrip, a spell attack on Magic Missile) is hidden.

## Sheet style

**Start from a look** sets everything at once: *Dark and gold*, *Parchment*, *Clean light*, *Midnight* or *Forest*. Then adjust any colour (accent, sheet background, header and tab bar, boxes and cards, rows inside cards, input boxes, text, labels, borders, buttons), the heading and body fonts, and corner rounding. Unset colours follow the app's theme. **Extra CSS** is added after everything else, for one-off touches:

```css
.bp-sheet [data-key="ac"] .bp-val { color: crimson; }
.bp-sheet[data-type="player"] .bp-group-title { border-bottom: 1px solid var(--accent); }
```

## Markup reference

Generated and exported sheets use the same markup, which is what CSS and custom sheets target:

| Element | What it is |
|---|---|
| `.bp-sheet[data-type="player"]` | The sheet, with the actor type |
| `.bp-header`, `.bp-portrait`, `.bp-ident`, `.bp-header-stats`, `.bp-vitals` | The header: picture, name, small values, right-hand side |
| `.bp-tabs button`, `.bp-tab-body` | A tab (with `.icon-svg` or `.bp-emoji`), a tab's content |
| `.bp-items`, `.bp-subhead`, `.bp-item-card`, `.bp-item-name`, `.bp-chip`, `.bp-btn` | An item list card, a group heading, a row, its name, a summary chip, a button |
| `.bp-top`, `.bp-body`, `.bp-side`, `.bp-main`, `.bp-tabs` | Regions: above the tabs, side column, main column, tab bar |
| `section.bp-group.bp-frame-box\|card\|plain[data-key]` | A group; `.bp-group-title`, then `.bp-grid` |
| `.bp-field.bp-<kind>[data-key]` | A field (`bp-number`, `bp-text`, `bp-formula`, `bp-resource`…) |
| `.bp-label`, `.bp-val` | A field's label; a shown (calculated) value |
| `.bp-show-big\|badge\|inline\|plain`, `.bp-nolabel` | Display style; label hidden |
| `.bp-res`, `.bp-max` | A resource's current / max |
| `table.bp-list[data-key]`, `tr[data-key]`, `td[data-col]` | A list, an entry, a field column |
| `.bp-action`, `.roll-btn` | An action button; a list row's 🎲 |

`data-key` is always the value's path (`ac`, `abilities.str`, `spellcasting.slots.l1`), so `[data-key="…"]` picks out exactly one thing.

The app's colours are CSS variables you can use or override inside `.bp-sheet`: `--accent`, `--text`, `--muted`, `--border`, `--panel`, `--panel-2` (boxes), `--panel-3` (rows inside cards), `--sheet-header`, `--danger`, `--font-display`.

## Designed layouts

A designed sheet is a **layout**: blocks placed on a 12-column grid. Layouts are kept apart from the type's tree (in its `layouts` list in `builder.json`): a block *points at* a field by its path, so moving blocks around never changes the data or breaks a formula, and the same value can appear in two places. Choosing **Designed** starts from a copy of the generated sheet and opens the **sheet designer** (later: **✎ Open the sheet designer** in the type's Sheet box). Switching a type to another setting and back never deletes its layouts (or its HTML file).

### Styling blocks, tabs and layouts

Three levels, each over the one before (and all over the system's **Sheet style**):

- **A block:** select it in the designer and open **Style**: text size, colour, bold, italic, alignment; the label's (and headings') size and colour; background, border and its colour, corners and inner space. **Copy style** / **Paste style** make blocks match; **Clear** removes it. A box's style flows to everything inside it (except buttons' size). In JSON: `"style": { "size": 30, "color": "#e03a3a", "bold": true, "align": "center", "label_size": 10, "label_color": "#8a8a8a", "background": "#2a1414", "border": "thick", "border_color": "#d9a52b", "radius": 12, "padding": 8 }`.
- **A tab:** click it; **Style** sets its background and text colour (labels and input boxes follow), e.g. a parchment Journal tab. In JSON, the tab's `"style": { "background": "#efe2c3", "color": "#2b2118" }`.
- **A layout:** with nothing selected, **Colours for this layout** overrides the system's colours for this layout only (accent, background, header, boxes, text…), so a "Play" layout can look different from the full sheet. In JSON, the layout's `style`, with the same keys as the Sheet style.

For anything else, the Sheet style's **Extra CSS** still works: designed sheets carry `data-type`, `data-layout` and each block's `data-block`.

### Several layouts per type

A type can have any number of layouts, say a full "Sheet" and a compact "Play" one. In the type's Sheet box:

- **Layout** picks which one the box (and **✎ Open the sheet designer**) works on.
- **+ New** makes one from the generated sheet; **⧉ Duplicate** copies the one shown, to vary it.
- **★ Make this the default** sets the one sheets use; **Rename** and **Delete** do what they say (the last one can't be deleted).

With more than one layout, a **Sheet** menu appears at the top of each character's window, so a player (or the GM) can switch that character to another layout. The choice is kept on the actor (`flags.core.layout`); picking the default clears it, and a deleted layout falls back to the default. Item sheets always use their type's default.

In `builder.json`, each layout in a type's `layouts` has its own `id` and `name`, and `default_layout` names the default (empty: the first).

### The sheet designer

Three panes: the type's **fields** and other **blocks** on the left, the **sheet itself** in the middle (live, with one of your characters, or a blank sample), and the **settings** of whatever is selected on the right.

- **Add:** drag a field or block onto the sheet, or click it to add it to the bottom of the open tab.
- **Move:** drag a block. It snaps to the 12-column grid; blocks it would cover move down, and everything floats up to close gaps. Drop it into a box, the header (small values under the name), the header's right-hand side (HP, AC), or above the tabs (shown on every tab).
- **Resize:** select a block and drag its right edge, bottom edge or corner.
- **Settings:** what it shows, its label (or none), display (big box, badge…), its exact place, and **When it's full** (grow, scroll, or show the first N rows).
- **Tabs:** click one to rename it, pick an icon, move it or delete it; **+ Tab** adds one. A sheet with one tab shows no tab bar.
- **Keys:** Delete removes the selected block, arrow keys move it, Shift+arrows resize it, Ctrl+Z / Ctrl+Y undo and redo.

Changes save as you go, and open sheets update. The layout can also be edited as JSON under **Layout data (advanced)** in the Sheet box, which is handy for an AI or a programmer.

```json
{ "id": "main", "name": "Sheet",
  "header": { "portrait": true,
              "blocks": [ { "kind": "field", "bind": "level" } ],
              "side":   [ { "kind": "field", "bind": "hp" }, { "kind": "field", "bind": "ac", "display": "big" } ] },
  "top": [],
  "tabs": [
    { "key": "spells", "label": "Spells", "icon": "wand", "blocks": [
      { "id": "b1", "kind": "field", "bind": "spellcasting.dc", "x": 1, "y": 1, "w": 4, "h": 1, "display": "big" },
      { "id": "b2", "kind": "group", "title": "Spell slots", "frame": "card", "x": 1, "y": 2, "w": 12, "h": 1,
        "blocks": [ { "kind": "field", "bind": "spellcasting.slots.l1", "w": 4 } ] },
      { "id": "b3", "kind": "items", "item_type": "spell", "title": "Spellbook", "x": 1, "y": 3, "w": 12, "h": 4, "overflow": "scroll" }
    ] } ] }
```

| Block `kind` | Shows | Its settings |
|---|---|---|
| `field` | A field, list, resource, action or group, by its path | `bind`, and optionally `label`, `hide_label`, `display` (`big`, `badge`, `inline`, `plain`), `show_hint` |
| `group` | A box holding its own grid of blocks | `title`, `hide_label`, `frame` (`box`, `card`, `plain`), `blocks` |
| `items` | The actor's items of one type, as on the generated sheet | `item_type`, `title` |
| `heading`, `text` | A heading; markdown text (with `[[links]]`) | `text` |
| `image`, `divider` | A picture; a line | `src` |
| `conditions`, `rests`, `problems`, `advance` | Condition toggles; rest buttons; the GM's formula problems; the Advance button | |

Every block has a place: `x` (column 1–12), `w` (columns wide), `y` (row) and `h` (rows tall). A block fills the whole area it gets (its rows, which are as tall as the tallest block in them), so two tables side by side come out the same height, with their rows spread evenly; `"fit": true` (**Shrink to fit its content** in the designer) keeps it at its content's height instead. Rows are at least 34px and **grow with their content**, so a list that gets longer pushes what's below it down rather than overlapping it. `overflow` changes that per block: `"grow"` (default), `"scroll"` (stays `h` rows tall and scrolls), or `"limit"` with `"limit": 10` (the first 10 rows, then a *Show all* button). Header blocks sit in a row under the name (`blocks`) or on the right (`side`) and ignore `x`/`y`. A layout with one tab shows no tab bar, which suits item sheets.

The builder lists problems in a layout, such as a block pointing at a field that has been renamed.

## Custom HTML sheets

In the system builder, select a type and set its **Sheet** to **Custom HTML**, then **Make the HTML file**. Hearth writes `sheets/<type>.html` (item types: `sheets/item-<type>.html`) into the system's folder, made from the generated sheet, and the type uses it from then on. Edit it in any text editor; reload the world to see changes. Switching the setting back keeps the file.

You can also write one from scratch and point `actor_types.<kind>.sheet` (or `item_types.<kind>.sheet`) at it in `hearth.toml`.

In an **item** sheet, the context is the item: `{{item.name}}`, `{{data.x}}` (the item's values), `{{derived.x}}` (its calculated values), `{{actor.…}}` (who carries it). Inputs are named `items.{{item.id}}.data.x`, and action buttons need `data-item-id="{{item.id}}"`.

The template re-renders whenever the actor changes.

### Values

`{{path}}` inserts an escaped value. The context is:

| Name | |
|---|---|
| `actor` | The whole actor |
| `data` | `actor.data`: what players type in |
| `derived` | `actor.derived`: everything the system calculates (formulas, resource maxes, `derived.items.<id>.*` for item formulas) |
| `items` | `actor.items` |
| `system` | The system's package info |
| `isGM`, `isOwner` | Booleans |

Filters: `{{derived.abilities.str.mod|signed}}` → `+2`. Also `upper`, `lower`, `json`.

### Blocks (can't be nested)

```html
{{#if isGM}} secret GM notes {{else}} … {{/if}}

{{#each items:weapon}}            <!-- ":weapon" filters by item kind; optional -->
  {{this.name}} {{this.data.damage}} {{index}}
{{/each}}
```

### Binding

Any `input`, `select` or `textarea` with a `name` is filled from the actor and saved on change:

| Name | Writes to |
|---|---|
| `name`, `img` | Actor fields |
| `data.hp.value` | `actor.data.hp.value` |
| `flags.my-module.x` | `actor.flags` |
| `items.{{this.id}}.name` / `items.{{this.id}}.data.damage` | That item |

`type="number"` saves numbers; checkboxes save booleans. Inputs are disabled for users who don't own the actor.

### Buttons

```html
<button data-use="attack_roll" data-item-id="{{this.id}}">Attack</button>   <!-- a system action -->
<button data-use="roll_initiative">Initiative</button>                      <!-- an actor action -->
<button data-roll="1d20 + @skills.stealth.bonus" data-flavor="Stealth">🎲</button>
<button data-rest="long">Long rest</button>
<button data-toggle-condition="poisoned" class="chip">Poisoned</button>    <!-- gets class "on" while on -->
<button data-action="create-item" data-type="weapon">+ Weapon</button>         <!-- opens a list of weapons to pick from -->
<button data-action="delete-item" data-item-id="{{this.id}}">Delete</button>
```

Action buttons hide themselves while the action's **Only when** is false.

### Tabs

```html
<nav class="bp-tabs">
  <button data-sheet-tab="spells">Spells</button>
  <button data-sheet-tab="gear">Gear</button>
</nav>
<div data-sheet-panel="spells"> … </div>
<div data-sheet-panel="gear"> … </div>
```

Clicking a `data-sheet-tab` shows the matching `data-sheet-panel` and hides the rest; the open tab survives re-renders. The exported sheet uses this already.

Click modifiers on `data-use` and `data-roll`: **Shift** rolls privately to the GM, **Alt** with advantage, **Ctrl** with disadvantage (on a single d20). Actions are rolled and paid for on the server (see [rules.md](rules.md)); `data-roll` formulas resolve `@paths` against `derived`, then `data`.

### Tips for writing one (or asking an AI to)

- Start from the export: it already has every field, roll and action bound correctly. Rearrange and restyle rather than rewriting the bindings.
- Keep `name="…"`, `data-use`, `data-roll`, `data-rest` and `data-toggle-condition` attributes as they are; move the elements around freely.
- Calculated values come from `{{derived.…}}`; anything a player types goes in an input named `data.…`.
- Style with the classes above (they're what the Sheet style targets), or add your own classes and put the CSS in the Sheet style's Extra CSS box.
- Values that change while a sheet is open re-render it; there's no need for scripts in the template (scripts in templates don't run). For behaviour, use a JS renderer.

## JS renderers

```js
export default function init(hearth) {
  hearth.sheets.register('vehicle', async (root, actor, hearth) => {
    root.innerHTML = hearth.sheets.renderTemplate(MY_TEMPLATE, { actor, data: actor.data, derived: actor.derived });
    hearth.sheets.bind(root, actor);   // optional: reuse the standard binding and buttons
  });
}
```

The `sheet:render` hook fires after any sheet renders, so modules can decorate other systems' sheets.
