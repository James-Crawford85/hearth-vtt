// Turn a builder type's layout into a hand-editable HTML sheet template.
//
// The template uses the same markup and classes as the generated sheet
// (blueprint-sheet.js), so the system's Sheet style still applies, and the
// same bindings (name="data.x", data-use, data-roll, data-rest,
// data-toggle-condition), so the rules keep working. See docs/sheets.md.

import { systemInfo } from './store.js';
import { sheetIconHtml } from './icons.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const label = (n) => n.label || n.key;
const span = (n, full = false) => (n.span === 99 || (!n.span && full) ? ' style="grid-column: 1 / -1"' : n.span ? ` style="grid-column: span ${n.span}"` : '');
const cls = (n) => ['bp-field', `bp-${n.kind}`, n.display ? `bp-show-${n.display}` : '', n.hide_label ? 'bp-nolabel' : ''].filter(Boolean).join(' ');
const lbl = (n) => (n.hide_label ? '' : `<span class="bp-label">${esc(label(n))}</span>`);
const grid = (n) => (n?.columns ? `<div class="bp-grid" style="grid-template-columns: repeat(${n.columns}, minmax(0, 1fr))">` : '<div class="bp-grid">');

function findList(bp, key) {
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.key === key && n.kind === 'list') return n;
      const x = walk(n.children);
      if (x) return x;
    }
    return null;
  };
  for (const t of bp?.actor_types ?? []) { const x = walk(t.children); if (x) return x; }
  return null;
}

function options(n, bp) {
  if (n.source) {
    const list = findList(bp, n.source);
    return ['<option value="">—</option>', ...(list?.entries ?? []).map((e) => `<option value="${esc(e.key)}">${esc(e.label || e.key)}</option>`)].join('');
  }
  return (n.options ?? []).map((o) => `<option value="${esc(o.value)}">${esc(o.label || o.value)}</option>`).join('');
}

function nodes(list, path, bp, ind) {
  return (list ?? []).filter((n) => !n.hidden).map((n) => node(n, [...path, n.key], bp, ind)).filter(Boolean).join('\n');
}

// Inputs write to the actor ("data.x"), or for item sheets to the item ("items.{{item.id}}.data.x").
let DATA = 'data';
let ITEM_ATTR = '';

function node(n, path, bp, ind) {
  const key = path.join('.');
  const name = `${DATA}.${key}`;
  const pad = ' '.repeat(ind);
  const aria = n.hide_label ? ` aria-label="${esc(label(n))}"` : '';
  switch (n.kind) {
    case 'group': {
      const inner = nodes(n.children, n.flat ? path.slice(0, -1) : path, bp, ind + 4);
      return `${pad}<section class="bp-group bp-frame-${n.frame || 'box'}" data-key="${key}"${span(n, true)}>\n`
        + (n.hide_label ? '' : `${pad}  <h4 class="bp-group-title">${esc(label(n))}</h4>\n`)
        + `${pad}  ${grid(n)}\n${inner}\n${pad}  </div>\n${pad}</section>`;
    }
    case 'number':
      return `${pad}<label class="${cls(n)}" data-key="${key}"${span(n)}>${lbl(n)}<input type="number" name="${name}" step="any"${aria}></label>`;
    case 'text':
      return `${pad}<label class="${cls(n)}" data-key="${key}"${span(n)}>${lbl(n)}<input type="text" name="${name}"${aria}></label>`;
    case 'longtext':
      return `${pad}<label class="${cls(n)}" data-key="${key}"${span(n, true)}>${lbl(n)}<textarea name="${name}" rows="4"${aria}></textarea></label>`;
    case 'checkbox':
      return `${pad}<label class="${cls(n)}" data-key="${key}"${span(n)}><input type="checkbox" name="${name}"${aria}>${lbl(n)}</label>`;
    case 'choice':
      return `${pad}<label class="${cls(n)}" data-key="${key}"${span(n)}>${lbl(n)}<select name="${name}"${aria}>${options(n, bp)}</select></label>`;
    case 'formula':
      return `${pad}<div class="${cls(n)}" data-key="${key}"${span(n)}>${lbl(n)}<strong class="bp-val">{{derived.${key}}}</strong></div>`;
    case 'resource':
      return `${pad}<div class="${cls(n)}" data-key="${key}"${span(n)}>${lbl(n)}<span class="bp-res"><input type="number" name="${name}.value" aria-label="${esc(label(n))} (current)"><span class="muted">/</span>`
        + (n.formula ? `<span class="bp-max">{{derived.${key}.max}}</span>` : `<input type="number" name="${name}.max" aria-label="${esc(label(n))} (max)">`) + '</span></div>';
    case 'action':
      return `${pad}<button type="button" class="bp-action" data-key="${key}" data-use="${esc(n.key)}"${ITEM_ATTR} title="${esc(n.roll)}"${span(n)}>${n.hide_label ? '🎲' : esc(label(n))}</button>`;
    case 'list': {
      const fields = (n.children ?? []).filter((c) => !c.hidden);
      const head = `<tr>${n.roll ? '<th></th>' : ''}<th></th>${fields.map((f) => `<th>${f.hide_label ? '' : esc(label(f))}</th>`).join('')}</tr>`;
      const rows = (n.entries ?? []).map((e) => {
        const base = `${key}.${e.key}`;
        const roll = n.roll ? `<td class="bp-roll"><button type="button" class="icon roll-btn" data-roll="${esc(n.roll.replace(/@this\b/g, `@${base}`).replace(/@key\b/g, e.key))}" data-flavor="${esc(e.label || e.key)}">🎲</button></td>` : '';
        const cells = fields.map((f) => {
          const fp = `${base}.${f.key}`;
          const c = f.kind === 'formula' ? `<strong class="bp-val">{{derived.${fp}}}</strong>`
            : f.kind === 'checkbox' ? `<input type="checkbox" name="${DATA}.${fp}">`
              : f.kind === 'choice' ? `<select name="${DATA}.${fp}">${options(f, bp)}</select>`
                : `<input type="${f.kind === 'number' ? 'number' : 'text'}" name="${DATA}.${fp}">`;
          return `<td class="bp-${f.kind}" data-col="${f.key}">${c}</td>`;
        }).join('');
        return `${pad}      <tr data-key="${base}">${roll}<th>${esc(e.label || e.key)}</th>${cells}</tr>`;
      }).join('\n');
      return `${pad}<div class="bp-list-wrap"${span(n, true)}>\n`
        + (n.hide_label ? '' : `${pad}  <div class="bp-list-title">${esc(label(n))}</div>\n`)
        + `${pad}  <table class="bp-list" data-key="${key}">\n${pad}    <thead>${head}</thead>\n${pad}    <tbody>\n${rows}\n${pad}    </tbody>\n${pad}  </table>\n${pad}</div>`;
    }
    default:
      return '';
  }
}

/** A card listing the actor's items of one type (the template can't group, so it's one list). */
function itemSection(t, ind) {
  const pad = ' '.repeat(ind);
  const fields = t.children ?? [];
  const acts = fields.filter((c) => c.kind === 'action')
    .map((a) => `<button type="button" class="small bp-btn" data-use="${esc(a.key)}" data-item-id="{{this.id}}">${esc(label(a))}</button>`).join(' ');
  // Stored values only: calculated item values aren't reachable from inside {{#each}}.
  const chips = (t.summary ?? []).map((k) => fields.find((f) => f.key === k)).filter((f) => f && !['formula', 'resource', 'checkbox'].includes(f.kind))
    .map((f) => `<span class="bp-chip" title="${esc(label(f))}">{{this.data.${f.key}}}</span>`).join(' ');
  return `${pad}<section class="bp-group bp-frame-card bp-items" data-key="items:${t.key}">
${pad}  <h4 class="bp-group-title"><span>${esc(t.list_title || label(t))}</span>
${pad}    <button type="button" class="small bp-btn bp-add" data-action="create-item" data-type="${t.key}">+ Add</button></h4>
${pad}  <ul class="bp-item-cards">
${pad}    {{#each items:${t.key}}}
${pad}    <li class="bp-item-card">
${pad}      <div class="bp-item-main">
${pad}        <input class="bp-item-name" name="items.{{this.id}}.name" aria-label="Name">
${chips ? `${pad}        <div class="bp-item-meta">${chips}</div>\n` : ''}${pad}      </div>
${pad}      <div class="bp-item-buttons">${acts}
${pad}        <button type="button" class="icon bp-btn" data-action="delete-item" data-item-id="{{this.id}}" title="Delete">🗑</button></div>
${pad}    </li>
${pad}    {{/each}}
${pad}  </ul>
${pad}</section>`;
}

/** The HTML template for a type's sheet. */
export function sheetTemplate(type) {
  const bp = systemInfo().blueprint;
  const visible = (type.children ?? []).filter((n) => !n.hidden);
  const isGroup = (n) => n.kind === 'group';
  const placed = (p) => visible.filter((n) => isGroup(n) && n.place === p);
  const top = visible.filter((n) => !isGroup(n) || n.place === 'top');
  const side = placed('side');
  const tabGroups = visible.filter((n) => isGroup(n) && !n.place);
  const tabKeys = new Set(tabGroups.map((g) => g.key));
  const itemTypes = bp?.item_types ?? [];
  const itemsOn = (where) => itemTypes.filter((t) => (where === '' ? !t.tab || (t.tab !== 'own' && !tabKeys.has(t.tab)) : t.tab === where));
  const rules = systemInfo().rules ?? {};
  const inner = (g, ind) => nodes(g.children, g.flat ? [] : [g.key], bp, ind);
  const sections = (types, ind) => (types.length
    ? `${' '.repeat(ind)}<div class="bp-item-sections">\n${types.map((t) => itemSection(t, ind + 2)).join('\n')}\n${' '.repeat(ind)}</div>` : '');

  const tabs = tabGroups.map((g) => ({ key: g.key, label: label(g), icon: g.icon, body: `        ${grid(g)}\n${inner(g, 10)}\n        </div>\n${sections(itemsOn(g.key), 8)}` }));
  for (const t of itemsOn('own')) tabs.push({ key: `items-${t.key}`, label: label(t), icon: t.icon || 'items', body: sections([t], 8) });
  if (itemsOn('').length) tabs.push({ key: 'items', label: 'Items', icon: 'backpack', body: sections(itemsOn(''), 8) });
  const conditions = (rules.conditions ?? []).map((c) => `<button type="button" class="chip" data-toggle-condition="${esc(c.id)}">${esc(c.name || c.id)}</button>`).join('\n            ');
  const rests = (rules.rests ?? []).map((r) => `<button type="button" class="bp-btn" data-rest="${esc(r)}">${esc(r[0].toUpperCase() + r.slice(1))} rest</button>`).join(' ');
  tabs.push({ key: 'status', label: 'Status', icon: 'heart', body: `        <section class="bp-group bp-frame-card" data-key="status">
          <h4 class="bp-group-title">Conditions</h4>
          <div class="bp-grid row conditions">
            ${conditions}
          </div>
        </section>
        <div class="row">${rests}</div>` });
  const withIcons = tabs.some((t) => t.icon && t.key !== 'status' && t.key !== 'items');
  const header = (groups, cls) => groups.map((g) => `      <div class="${cls}" data-key="${g.key}">\n${inner(g, 8)}\n      </div>`).join('\n');

  return `<!--
  Sheet for "${esc(label(type))}", made from its layout in the system builder.
  Edit it freely in any text editor; the system uses it instead of the
  generated sheet (System builder → this type → Sheet → "Use the generated
  sheet again" switches back). The reference is docs/sheets.md in Hearth.

  {{derived.path}}                  a calculated value (formulas, resource max)
  {{data.path}}                     a stored value, as text
  <input name="data.path">          an editable value (also select, textarea, checkbox)
  data-use="action" [data-item-id]  a system action (Alt: advantage, Ctrl: disadvantage)
  data-roll="1d20 + @path"          a plain roll;  data-rest="long";  data-toggle-condition="poisoned"
  data-sheet-tab="x" / data-sheet-panel="x"   tabs
  {{#each items:kind}} … {{this.id}} {{this.name}} {{this.data.x}} … {{/each}}
  {{#if path}} … {{else}} … {{/if}}
  Classes and data-key attributes match the generated sheet, so the system's
  Sheet style (colours, fonts, extra CSS) applies here too.
-->
<div class="bp-sheet" data-type="${type.key}">
  <header class="bp-header">
    <div class="bp-portrait">{{#if actor.img}}<img src="{{actor.img}}" alt="">{{else}}<span>✦</span>{{/if}}</div>
    <div class="bp-ident">
      <input class="title-input" name="name" aria-label="Name">
${header(placed('header'), 'bp-header-stats')}
    </div>
    <div class="bp-vitals">
${header(placed('vitals'), 'bp-vitals-group')}
    </div>
  </header>
${top.length ? `\n  <div class="bp-grid bp-top">\n${nodes(top, [], bp, 4)}\n  </div>\n` : ''}
  <div class="${side.length ? 'bp-body' : 'bp-main'}">
${side.length ? `    <aside class="bp-side">\n${nodes(side, [], bp, 6)}\n    </aside>\n    <div class="bp-main">` : '    <div>'}
      <nav class="bp-tabs${withIcons ? ' bp-tabs-icons' : ''}" role="tablist">
${tabs.map((t) => `        <button type="button" role="tab" data-sheet-tab="${t.key}">${withIcons ? sheetIconHtml(t.icon || 'star') : ''}<span>${esc(t.label)}</span></button>`).join('\n')}
      </nav>
${tabs.map((t) => `      <div class="bp-tab-body" data-sheet-panel="${t.key}">\n${t.body}\n      </div>`).join('\n')}
    </div>
  </div>
</div>
`;
}

/** The HTML template for an item type's sheet (its window when the item is on an actor). */
export function itemSheetTemplate(type) {
  const bp = systemInfo().blueprint;
  DATA = 'items.{{item.id}}.data';
  ITEM_ATTR = ' data-item-id="{{item.id}}"';
  try {
    const body = nodes((type.children ?? []).filter((n) => n.kind !== 'effect'), [], bp, 4);
    return `<!--
  Sheet for the item type "${esc(label(type))}", made in the system builder. Edit it freely;
  System builder → this type → Sheet switches back. The reference is docs/sheets.md in Hearth.

  {{item.name}} {{item.id}}                     the item
  {{data.path}}                                 a stored value of the item, as text
  {{derived.path}}                              a calculated value of the item (its formulas)
  <input name="items.{{item.id}}.data.path">    an editable value
  data-use="action" data-item-id="{{item.id}}"  one of its actions
  {{actor.name}}, {{actor.data.path}}           the actor carrying it
-->
<div class="bp-sheet" data-type="${type.key}">
  <div class="sheet-head"><input class="title-input" name="items.{{item.id}}.name" aria-label="Name"></div>
  ${grid(type)}
${body}
  </div>
</div>
`;
  } finally {
    DATA = 'data';
    ITEM_ATTR = '';
  }
}
