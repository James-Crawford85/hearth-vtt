# Sheets

For each actor type, Hearth picks the first of:

1. A JS renderer registered with `hearth.sheets.register(kind, (root, actor, hearth) => { … })`
2. The HTML template at `actor_types.<kind>.sheet`
3. An automatic form built from `actor.data`

## HTML templates

The template re-renders whenever the actor changes.

### Values

`{{path}}` inserts an escaped value. The context is:

| name | |
|---|---|
| `actor` | the whole actor |
| `data` | `actor.data` |
| `derived` | `actor.derived` (from `prepare_actor`) |
| `items` | `actor.items` |
| `system` | the system's package info |
| `isGM`, `isOwner` | booleans |

Filters: `{{derived.str_mod|signed}}` → `+2`. Also `upper`, `lower`, `json`.

### Blocks (can't be nested)

```html
{{#if isGM}} secret GM notes {{else}} … {{/if}}

{{#each items:weapon}}            <!-- ":weapon" filters by item kind; optional -->
  {{this.name}} {{this.data.damage}} {{index}}
{{/each}}
```

### Binding

Any `input`, `select` or `textarea` with a `name` is filled from the actor and saved on change:

| name | writes to |
|---|---|
| `name`, `img` | actor fields |
| `data.hp.value` | `actor.data.hp.value` |
| `flags.my-module.x` | `actor.flags` |
| `items.{{this.id}}.name` / `items.{{this.id}}.data.damage` | that item |

`type="number"` saves numbers; checkboxes save booleans. Inputs are disabled for users who don't own the actor.

### Rolls and actions

```html
<button data-roll="1d20 + @abilities.str.mod" data-flavor="Strength check">STR</button>
<button data-action="create-item" data-type="weapon">+ Weapon</button>
<button data-action="delete-item" data-item-id="{{this.id}}">Delete</button>
```

Shift-click a roll button to roll privately to the GM.

## JS renderers

```js
export default function init(hearth) {
  hearth.sheets.register('vehicle', async (root, actor, hearth) => {
    root.innerHTML = hearth.sheets.renderTemplate(MY_TEMPLATE, { actor, data: actor.data });
    hearth.sheets.bind(root, actor);   // optional: reuse the standard binding
  });
}
```

The `sheet:render` hook fires after any sheet renders, so modules can decorate other systems' sheets.
