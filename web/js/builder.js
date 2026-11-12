// The system builder (GM): edit the world's system as a tree of actor and item
// types made of groups, fields, formulas, resources, lists, actions and
// effects, plus tables, conditions and rests. Changes save automatically to
// the system's builder.json; the server reloads the system and every open
// sheet updates, so a test character works as a live preview.

import { hooks } from './hooks.js';
import { store } from './store.js';
import { el, toast, openWindow } from './ui.js';
import { sheetTemplate, itemSheetTemplate } from './sheet-export.js';
import { sheetMode } from './blueprint-sheet.js';
import { advancementEditor } from './advancement.js';
import { layoutFromType, describeLayout, newLayoutId } from './layout-sheet.js';
import { openDesigner, closeDesigner } from './designer.js';
import { icon, SHEET_ICONS } from './icons.js';

const KINDS = {
  type: { icon: '◆', label: 'Type' },
  group: { icon: '▤', label: 'Group', hint: 'A section (a tab, at the top level)' },
  number: { icon: '#', label: 'Number' },
  text: { icon: 'T', label: 'Text' },
  longtext: { icon: '¶', label: 'Long text' },
  checkbox: { icon: '☑', label: 'Checkbox' },
  choice: { icon: '◉', label: 'Choice', hint: 'One of a list of options' },
  formula: { icon: 'ƒ', label: 'Formula', hint: 'Calculated, read-only' },
  resource: { icon: '♥', label: 'Resource', hint: 'Current and max; rests restore it' },
  list: { icon: '☰', label: 'List', hint: 'Repeating entries, like abilities or skills' },
  action: { icon: '🎲', label: 'Action', hint: 'A roll button' },
  effect: { icon: '✦', label: 'Effect', hint: 'Changes the owner\'s values while they have the item' },
};
const ROLL_KINDS = [['attack', 'Attack (advantage applies)'], ['check', 'Check (advantage applies)'], ['save', 'Save (advantage applies)'], ['damage', 'Damage (crits double dice)'], ['heal', 'Healing'], ['other', 'Other']];
const MODES = [['set', 'Set to'], ['upgrade', 'At least'], ['downgrade', 'At most'], ['multiply', 'Multiply by'], ['add', 'Add']];

const uid = () => Math.random().toString(36).slice(2, 10);
const slug = (s) => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1').slice(0, 40);

/** Which kinds can go inside a node. */
function childKinds(parent, isItem) {
  if (parent.kind === 'list') return ['number', 'text', 'checkbox', 'choice', 'formula'];
  const base = ['group', 'number', 'text', 'longtext', 'checkbox', 'choice', 'formula', 'resource', 'list', 'action'];
  if (parent.kind === 'type' && isItem) base.push('effect');
  if (parent.kind === 'group' && isItem) base.push('effect');
  return base;
}

const COLOR_KEYS = ['accent', 'background', 'header', 'box', 'raised', 'input', 'text', 'muted', 'border', 'button'];

/** Ready-made looks for the Sheet style. */
const SHEET_PRESETS = [
  { name: 'Dark and gold', style: { background: '#1b1b1d', header: '#141416', box: '#252527', raised: '#313134', input: '#1e1e20', accent: '#d9a52b', text: '#ebe8e3', muted: '#9c978f', border: '#3b3b3f', button: '#8e1d1d', heading_font: '"Trebuchet MS", sans-serif', radius: 6 } },
  { name: 'Parchment', style: { background: '#f3e8d0', header: '#e6d4ad', box: '#fbf4e2', raised: '#efe2c3', input: '#fffaf0', accent: '#7a1f1f', text: '#2b2118', muted: '#6f5d45', border: '#c8b186', button: '#7a1f1f', heading_font: '"Palatino Linotype", "Book Antiqua", Palatino, serif', body_font: 'Georgia, "Times New Roman", serif', radius: 4 } },
  { name: 'Clean light', style: { background: '#ffffff', header: '#eef1f5', box: '#f7f8fa', raised: '#eaedf2', input: '#ffffff', accent: '#2f6fde', text: '#1d2330', muted: '#667085', border: '#d5dae1', button: '#2f6fde', body_font: 'system-ui, sans-serif', radius: 8 } },
  { name: 'Midnight', style: { background: '#121826', header: '#0c111c', box: '#1a2233', raised: '#232d42', input: '#0f1522', accent: '#5cc8ff', text: '#e6edf7', muted: '#8a9ab5', border: '#2c3850', button: '#2a6fdb', radius: 8 } },
  { name: 'Forest', style: { background: '#17201a', header: '#0f1611', box: '#1f2b23', raised: '#29382e', input: '#141c16', accent: '#a5d46f', text: '#e4eee2', muted: '#93a592', border: '#33453a', button: '#3c7a3a', heading_font: 'Georgia, "Times New Roman", serif', radius: 6 } },
];

export class Builder {
  constructor(api) {
    this.api = api;
    this.win = null;
    this.bp = null;
    this.sel = null;          // selected node id, or 'tables' | 'conditions' | 'rests'
    this.saveTimer = null;
    this.status = '';
    this.errors = [];
    this.info = null;
    hooks.on('packages', () => this.renderStatus());
  }

  async open() {
    if (this.win) { openWindow({ id: 'system-builder' }); return; }
    const res = await fetch('/api/builder', { headers: { 'x-hearth-session': this.api.session ?? '' } });
    if (!res.ok) { toast(await res.text(), 'error'); return; }
    this.info = await res.json();
    this.bp = this.info.blueprint;
    this.errors = this.info.errors ?? [];
    for (const k of ['actor_types', 'item_types', 'conditions', 'rests', 'creation']) this.bp[k] ??= [];
    this.bp.tables ??= {};
    this.walk((n) => { n.id ||= uid(); n.children ??= []; });
    this.win = openWindow({ id: 'system-builder', title: `System builder: ${this.info.name}`, width: Math.min(1000, innerWidth - 40), height: Math.min(680, innerHeight - 60) });
    this.win.el.classList.add('builder-window');
    this.win.onClose(() => { this.flush(); this.win = null; });
    this.sel ??= this.bp.actor_types[0]?.id ?? null;
    this.render();
  }

  // ------------------------------------------------------------------ tree helpers

  walk(fn) {
    const go = (nodes, parent, type, isItem) => {
      for (const n of nodes) { fn(n, parent, type ?? n, isItem); go(n.children ?? [], n, type ?? n, isItem); }
    };
    go(this.bp.actor_types, null, null, false);
    go(this.bp.item_types, null, null, true);
  }

  /** { node, parent, siblings, type, isItem } for an id. */
  find(id) {
    let hit = null;
    const go = (nodes, parent, type, isItem) => {
      for (const n of nodes) {
        if (hit) return;
        if (n.id === id) { hit = { node: n, parent, siblings: nodes, type: type ?? n, isItem }; return; }
        go(n.children ?? [], n, type ?? n, isItem);
      }
    };
    go(this.bp.actor_types, null, null, false);
    go(this.bp.item_types, null, null, true);
    return hit;
  }

  changed({ tree = true } = {}) {
    if (tree) this.renderTree();
    this.status = 'Unsaved changes…';
    this.renderStatus();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 900);
  }

  flush() { if (this.saveTimer) { clearTimeout(this.saveTimer); this.save(); } }

  async save() {
    this.saveTimer = null;
    this.status = 'Saving…';
    this.renderStatus();
    try {
      const res = await fetch('/api/builder', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-hearth-session': this.api.session ?? '' },
        body: JSON.stringify(this.bp),
      });
      if (!res.ok) throw new Error(await res.text());
      const out = await res.json();
      this.errors = out.errors ?? [];
      this.status = this.errors.length ? `Saved, with ${this.errors.length} problem${this.errors.length > 1 ? 's' : ''}` : 'Saved';
    } catch (e) {
      this.status = 'Not saved';
      toast(`Couldn't save the system: ${e.message}`, 'error');
    }
    this.renderStatus();
  }

  // ------------------------------------------------------------------ layout

  render() {
    this.treeEl = el('div.builder-tree');
    this.editEl = el('div.builder-edit');
    this.statusEl = el('div.builder-status');
    const top = el('div.builder-top', {},
      el('button.small', { type: 'button', text: '+ Actor type', on: { click: () => this.addType(false) } }),
      el('button.small', { type: 'button', text: '+ Item type', on: { click: () => this.addType(true) } }),
      el('span.grow'),
      el('button.small', { type: 'button', text: 'Test character', title: 'Open (or make) an actor of the selected type to see its sheet change as you build', on: { click: () => this.testActor() } }),
      this.statusEl);
    const notes = [];
    if (this.info.hand_written_types?.length) notes.push(el('p.muted.small', { text: `Also in this system, written by hand in hearth.toml: ${this.info.hand_written_types.join(', ')}. Those keep working; builder types with the same key are merged under them.` }));
    this.win.body.replaceChildren(top, ...notes, el('div.builder-main', {}, this.treeEl, this.editEl));
    this.renderTree();
    this.renderEdit();
    this.renderStatus();
  }

  renderStatus() {
    // Open sheet designers show the same save status.
    for (const s of document.querySelectorAll('.dz-status')) s.textContent = this.status ?? '';
    if (!this.statusEl) return;
    const errs = this.errors.length
      ? el('details.rule-errors', {}, el('summary', { text: this.status }), el('ul', {}, this.errors.map((e) => el('li', { text: e }))))
      : el('span.muted.small', { text: this.status });
    this.statusEl.replaceChildren(errs);
  }

  renderTree() {
    const rows = [];
    const row = (n, depth, isItem) => {
      const k = KINDS[n.kind] ?? KINDS.group;
      rows.push(el('div.btree-row', {
        class: this.sel === n.id ? 'btree-row sel' : 'btree-row',
        style: `padding-left:${8 + depth * 16}px`,
        on: { click: () => { this.sel = n.id; this.renderTree(); this.renderEdit(); } },
      }, el('span.btree-icon', { text: k.icon }), el('span.grow', { text: n.label || n.key || '(unnamed)' }), el('span.btree-kind', { text: n.kind === 'type' ? (isItem ? 'item' : 'actor') : k.label.toLowerCase() })));
      for (const c of n.children ?? []) row(c, depth + 1, isItem);
    };
    rows.push(el('div.btree-head', { text: 'Actors' }));
    for (const t of this.bp.actor_types) row(t, 0, false);
    if (!this.bp.actor_types.length) rows.push(el('div.muted.small.btree-empty', { text: 'No actor types yet.' }));
    rows.push(el('div.btree-head', { text: 'Items' }));
    for (const t of this.bp.item_types) row(t, 0, true);
    if (!this.bp.item_types.length) rows.push(el('div.muted.small.btree-empty', { text: 'No item types yet.' }));
    rows.push(el('div.btree-head', { text: 'Rules' }));
    for (const [id, name] of [['tables', `Tables (${Object.keys(this.bp.tables).length})`], ['conditions', `Conditions (${this.bp.conditions.length})`], ['rests', 'Rests and bonuses'], ['creation', `Character creation (${this.bp.creation.length})`], ['style', 'Sheet style']]) {
      rows.push(el('div', { class: this.sel === id ? 'btree-row sel' : 'btree-row', on: { click: () => { this.sel = id; this.renderTree(); this.renderEdit(); } } },
        el('span.btree-icon', { text: '⚙' }), el('span.grow', { text: name })));
    }
    this.treeEl.replaceChildren(...rows);
  }

  // ------------------------------------------------------------------ structure edits

  addType(isItem) {
    const list = isItem ? this.bp.item_types : this.bp.actor_types;
    const name = isItem ? 'New item type' : 'New actor type';
    let key = slug(name);
    for (let i = 2; list.some((t) => t.key === key); i++) key = `${slug(name)}_${i}`;
    const t = { id: uid(), key, label: name, kind: 'type', children: [], _new: true };
    list.push(t);
    this.sel = t.id;
    this.changed();
    this.renderEdit();
  }

  addChild(parentId, kind) {
    const f = this.find(parentId);
    if (!f) return;
    const n = { id: uid(), key: '', label: `New ${KINDS[kind].label.toLowerCase()}`, kind, children: [], _new: true };
    n.key = this.uniqueKey(f.node.children, slug(n.label));
    if (kind === 'action') Object.assign(n, { roll: '1d20', roll_kind: 'check' });
    if (kind === 'formula') n.formula = '0';
    if (kind === 'list') n.children.push({ id: uid(), key: 'value', label: 'Value', kind: 'number', default: 0, children: [] });
    if (kind === 'effect') n.changes = [{ path: '', mode: 'add', value: '0' }];
    f.node.children.push(n);
    this.sel = n.id;
    this.changed();
    this.renderEdit();
  }

  uniqueKey(siblings, base) {
    let key = base || 'field';
    for (let i = 2; siblings.some((s) => s.key === key); i++) key = `${base}_${i}`;
    return key;
  }

  move(id, dir) {
    const f = this.find(id);
    const i = f.siblings.indexOf(f.node);
    const j = i + dir;
    if (j < 0 || j >= f.siblings.length) return;
    [f.siblings[i], f.siblings[j]] = [f.siblings[j], f.siblings[i]];
    this.changed();
  }

  duplicate(id) {
    const f = this.find(id);
    const copy = structuredClone(f.node);
    const fresh = (n) => { n.id = uid(); (n.children ?? []).forEach(fresh); };
    fresh(copy);
    copy.key = this.uniqueKey(f.siblings, `${f.node.key}_copy`);
    copy.label = `${f.node.label || f.node.key} (copy)`;
    f.siblings.splice(f.siblings.indexOf(f.node) + 1, 0, copy);
    this.sel = copy.id;
    this.changed();
    this.renderEdit();
  }

  remove(id) {
    const f = this.find(id);
    if (!confirm(`Delete "${f.node.label || f.node.key}"${f.node.children?.length ? ' and everything inside it' : ''}? Data already saved on actors stays.`)) return;
    f.siblings.splice(f.siblings.indexOf(f.node), 1);
    this.sel = f.parent?.id ?? null;
    this.changed();
    this.renderEdit();
  }

  // ------------------------------------------------------------------ the settings panel

  renderEdit() {
    if (this.sel === 'tables') return this.editTables();
    if (this.sel === 'conditions') return this.editConditions();
    if (this.sel === 'rests') return this.editRests();
    if (this.sel === 'creation') return this.editCreation();
    if (this.sel === 'style') return this.editStyle();
    const f = this.sel && this.find(this.sel);
    if (!f) {
      this.editEl.replaceChildren(el('div.builder-empty', {},
        el('p', { text: 'Build your system as a tree: actor types (characters, monsters) and item types (weapons, spells, classes), made of fields, formulas, resources, lists and actions.' }),
        el('p.muted', { text: 'Start with "+ Actor type", then add fields inside it. Make a test character to watch its sheet change as you go.' })));
      return;
    }
    const n = f.node;
    const parts = [];
    const head = el('div.builder-edit-head', {},
      el('strong', { text: `${KINDS[n.kind]?.icon ?? ''} ${n.kind === 'type' ? (f.isItem ? 'Item type' : 'Actor type') : KINDS[n.kind]?.label}` }),
      el('span.grow'),
      el('button.icon', { type: 'button', title: 'Move up', text: '↑', on: { click: () => this.move(n.id, -1) } }),
      el('button.icon', { type: 'button', title: 'Move down', text: '↓', on: { click: () => this.move(n.id, 1) } }),
      el('button.icon', { type: 'button', title: 'Duplicate', text: '⧉', on: { click: () => this.duplicate(n.id) } }),
      el('button.icon', { type: 'button', title: 'Delete', text: '🗑', on: { click: () => this.remove(n.id) } }));
    parts.push(head);
    if (KINDS[n.kind]?.hint) parts.push(el('p.muted.small', { text: KINDS[n.kind].hint }));

    // Name and key: the key follows the name until edited by hand.
    const keyInput = this.input(n, 'key', { label: n.kind === 'action' ? 'Key (used by "then" and data-use)' : 'Key (used in formulas)', onInput: (v) => { n.keyEdited = true; n.key = v; if (pathEl) pathEl.textContent = `Path: @${this.pathOf(n.id)}`; } });
    parts.push(el('div.row', {},
      el('label.grow', {}, 'Name', el('input', {
        value: n.label ?? '',
        on: {
          input: (e) => {
            n.label = e.target.value;
            // The key follows the name only while the field is new: renaming it later keeps existing data connected.
            if (n._new && !n.keyEdited) {
              n.key = n.kind === 'type' ? (slug(n.label) || n.key) : this.uniqueKey(f.siblings.filter((s) => s !== n), slug(n.label));
              keyInput.querySelector('input').value = n.key;
              if (pathEl) pathEl.textContent = `Path: @${this.pathOf(n.id)}`;
            }
            this.changed();
          },
        },
      })),
      keyInput));
    const pathEl = n.kind === 'type' ? null : el('div.muted.small');
    if (pathEl) parts.push(pathEl);
    if (pathEl) pathEl.textContent = n._new ? `Path: @${this.pathOf(n.id)}` : `Path: @${this.pathOf(n.id)} (changing the key disconnects data already saved under the old one)`;

    const add = (...xs) => parts.push(...xs);
    if (n.kind === 'type' && f.isItem) {
      const numbers = (n.children ?? []).filter((c) => c.kind === 'number');
      const levelSel = el('select', { on: { change: (e) => { n.levels = e.target.value || null; if (n.levels) n.grants = true; this.changed({ tree: false }); this.renderEdit(); } } },
        el('option', { value: '', text: 'No levels (gives everything when added)' }),
        ...numbers.map((c) => el('option', { value: c.key, text: `Levels counted by: ${c.label || c.key}`, selected: n.levels === c.key })));
      add(el('fieldset.bfield', {}, el('legend', { text: 'Advancement' }),
        el('label.check', {}, el('input', { type: 'checkbox', checked: !!n.grants || !!n.levels, on: { change: (e) => { n.grants = e.target.checked; if (!n.grants) n.levels = null; this.changed({ tree: false }); this.renderEdit(); } } }),
          'Items of this type give features (classes, ancestries, backgrounds)'),
        (n.grants || n.levels) ? levelSel : null,
        (n.grants || n.levels) && !numbers.length ? el('p.muted.small', { text: 'For classes, add a Number field (e.g. Levels) to this type, then pick it here.' }) : null,
        el('p.muted.small', { text: 'What each item gives is set on the item itself (e.g. the Fighter in the Items directory): open it to edit its advancement.' })));
      if (n.grants || n.levels) {
        // What a brand-new item of this type starts with (e.g. every class: hit points each level).
        const box = advancementEditor(this.api, { advancement: n.advancement ?? [] }, (adv) => { if (adv.length) n.advancement = adv; else delete n.advancement; this.changed({ tree: false }); }, !!n.levels);
        box.querySelector('legend').textContent = `Starting advancement for every new ${(n.label || n.key).toLowerCase()}`;
        box.prepend(el('p.muted.small', { text: `A new ${(n.label || n.key).toLowerCase()} made with "+ New item" starts with these grants; change them on the item as needed. Things every ${(n.label || n.key).toLowerCase()} has belong here (e.g. hit points each level).` }));
        add(box);
      }
    }
    if (n.kind === 'type' && f.isItem) add(this.forgeEditor(n, f));
    if (n.kind === 'type' && !f.isItem) {
      // Grants by total level across all classes: a feat every odd level, +1 to an ability every 4…
      const box = advancementEditor(this.api, { advancement: n.advancement ?? [] }, (adv) => { if (adv.length) n.advancement = adv; else delete n.advancement; this.changed({ tree: false }); }, true);
      box.querySelector('legend').textContent = 'Advancement by character level';
      box.prepend(el('p.muted.small', { text: `Grants every ${(n.label || n.key).toLowerCase()} gets at a total level (all classes together), e.g. a feat at levels 1, 3, 5… (level 1, again every 2). They come with whichever class level reaches it, and go if that level is taken back.` }));
      add(box);
    }
    switch (n.kind) {
      case 'number':
        add(el('div.row', {}, this.input(n, 'default', { label: 'Starting value', type: 'number' }), this.input(n, 'min', { label: 'Min', type: 'number' }), this.input(n, 'max', { label: 'Max', type: 'number' })));
        break;
      case 'text':
      case 'longtext':
        add(this.input(n, 'default', { label: 'Starting text' }));
        break;
      case 'checkbox':
        add(this.check(n, 'default', 'Ticked to start with'));
        break;
      case 'choice':
        add(this.choiceEditor(n, f));
        break;
      case 'formula':
        add(this.formulaInput(n, 'formula', 'Formula', f));
        break;
      case 'group':
        add(this.check(n, 'flat', 'Layout only: arranges the sheet, but its fields keep the parent\'s @paths'));
        break;
      case 'resource':
        add(this.input(n, 'default', { label: 'Starting value and max', type: 'number' }),
          this.formulaInput(n, 'formula', 'Max from a formula (optional; otherwise players set the max)', f),
          this.resetEditor(n), this.check(n, 'bar', 'Show as a bar on tokens'));
        break;
      case 'list':
        add(this.entriesEditor(n), this.check(n, 'open', 'Players can add and remove entries'),
          this.formulaInput(n, 'roll', 'Roll for each entry (optional)', f, 'Adds a 🎲 to each row, e.g. 1d20 + @this.bonus for a skill check. @this is the entry, @key its key.'),
          el('p.muted.small', { text: 'Fields inside the list repeat for every entry. In their formulas, @this is the entry (e.g. @this.value).' }));
        break;
      case 'action':
        add(this.formulaInput(n, 'roll', 'Roll', f, 'Dice and @values, e.g. 1d20 + @abilities.str.mod. {formula} blocks are worked out first.'),
          el('label', {}, 'Kind', this.select(n, 'roll_kind', ROLL_KINDS)),
          this.thenEditor(n, f), this.costEditor(n),
          this.formulaInput(n, 'when', 'Only when (optional)', f));
        // Criticals: when an attack threatens one, and how a critical multiplies damage.
        if (n.roll_kind === 'attack') {
          add(el('fieldset.bfield', {}, el('legend', { text: 'Critical hits' }),
            this.formulaInput(n, 'threat', 'Threatens on a natural (blank: 20)', f, 'The lowest d20 roll that threatens, e.g. @item.threat for a 19–20 weapon.'),
            this.check(n, 'confirm', 'A threat must be confirmed with a second attack roll')));
        }
        if (n.roll_kind === 'damage') {
          add(this.formulaInput(n, 'crit_mult', 'On a critical, roll the damage this many times (blank: double the dice)', f, 'e.g. @item.crit_mult for ×2, ×3, ×4 weapons.'));
        }
        break;
      case 'effect':
        add(this.formulaInput(n, 'when', 'Only while (e.g. @item.equipped)', f), this.changesEditor(n, n.changes ??= [], f));
        break;
      default:
        break;
    }
    if (!['type', 'action', 'effect'].includes(n.kind)) {
      add(this.input(n, 'hint', { label: 'Help text on the sheet (optional)' }), this.check(n, 'hidden', 'Hide on the sheet (still usable in formulas)'));
    }
    if (!['type', 'effect'].includes(n.kind) && f.parent?.kind !== 'list') add(this.layoutEditor(n, f));
    if (f.parent?.kind === 'list') add(this.check(n, 'hide_label', 'No column heading'));
    if (n.kind === 'type') add(this.sheetEditor(n, f.isItem));
    if (n.kind === 'type' && f.isItem) add(this.itemListEditor(n));
    // Children.
    if (['type', 'group', 'list'].includes(n.kind)) {
      const kinds = childKinds(n, f.isItem);
      add(el('div.builder-add', {}, el('span.muted.small', { text: n.kind === 'list' ? 'Add a field to each entry:' : 'Add inside:' }),
        ...kinds.map((k) => el('button.small', { type: 'button', title: KINDS[k].hint ?? '', text: `${KINDS[k].icon} ${KINDS[k].label}`, on: { click: () => this.addChild(n.id, k) } }))));
    }
    this.editEl.replaceChildren(...parts.filter(Boolean));
  }

  /** The data path of a node (list fields use * for the entry). */
  pathOf(id) {
    const out = [];
    let f = this.find(id);
    while (f && f.node.kind !== 'type') {
      if (f.node.kind !== 'action' && f.node.kind !== 'effect' && !(f.node.kind === 'group' && f.node.flat)) out.unshift(f.node.key);
      if (f.parent?.kind === 'list') out.unshift('*');
      f = f.parent ? this.find(f.parent.id) : null;
    }
    return out.join('.');
  }

  /** Values a formula in this type can use, for the helper list. */
  pathsIn(type, isItem) {
    const out = [];
    const go = (nodes, prefix) => {
      for (const n of nodes) {
        if (n.kind === 'action' || n.kind === 'effect') continue;
        const p = prefix ? `${prefix}.${n.key}` : n.key;
        if (n.kind === 'group') go(n.children, n.flat ? prefix : p);
        else if (n.kind === 'list') {
          const first = n.entries?.[0]?.key ?? 'entry';
          for (const c of n.children ?? []) out.push(`${p}.${first}.${c.key}`);
        } else if (n.kind === 'resource') out.push(`${p}.value`, `${p}.max`);
        else out.push(p);
      }
    };
    go(type.children ?? [], '');
    return out.map((p) => (isItem ? `@item.${p}` : `@${p}`));
  }

  // ------------------------------------------------------------------ small editors

  input(obj, key, { label, type = 'text', onInput } = {}) {
    const v = obj[key];
    return el('label', {}, label, el('input', {
      type, value: v ?? '', step: type === 'number' ? 'any' : null,
      on: {
        input: (e) => {
          const raw = e.target.value;
          const val = type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
          if (onInput) onInput(val); else obj[key] = val;
          this.changed({ tree: key === 'label' || key === 'key' });
        },
      },
    }));
  }

  /** Item types: the item forge's rules (price, which parts fit, checks, crafting). See docs/rules.md. */
  forgeEditor(n, f) {
    const box = el('fieldset.bfield.forge-editor', {}, el('legend', { text: 'Item forge' }));
    const on = !!n.forge;
    box.append(el('label.check', {}, el('input', {
      type: 'checkbox', checked: on,
      on: { change: (e) => { if (e.target.checked) n.forge = { price: '0', parts: [], checks: [] }; else delete n.forge; this.changed({ tree: false }); this.renderEdit(); } },
    }), `Items of this type can be made in the forge (magic weapons, potions…)`));
    if (!on) return box;
    const fg = n.forge;
    fg.checks ??= [];
    const types = this.bp.item_types.filter((t) => t.key !== n.key);
    const craftOn = !!fg.craft;
    box.append(
      this.formulaInput(fg, 'price', 'Price', f, 'A formula about @item (with its parts: sum_parts(\'bonus\'), max_parts(\'cl\'), count_parts()).'),
      this.formulaInput(fg, 'name', 'Suggested name (optional)', f, 'e.g. \'Wand of \' + parts(\'name\')[0]; used until the maker types their own.'),
      el('div.row', {}, el('span.muted.small', { text: 'Parts it takes:' }), ...types.map((t) => el('label.check', {}, el('input', {
        type: 'checkbox', checked: (fg.parts ?? []).includes(t.key),
        on: { change: (e) => { const s = new Set(fg.parts ?? []); if (e.target.checked) s.add(t.key); else s.delete(t.key); fg.parts = [...s]; this.changed({ tree: false }); } },
      }), t.label || t.key))),
      this.formulaInput(fg, 'fits', 'Which parts fit (optional)', f, '@part is the part, e.g. @part.applies_to == \'weapon\'.'),
    );
    const checks = el('div');
    const drawChecks = () => checks.replaceChildren(...fg.checks.map((c, i) => el('div.row.change-row', {},
      el('input', { value: c.when ?? '', placeholder: 'problem when, e.g. @item.enhancement > 5', on: { input: (e) => { c.when = e.target.value; this.changed({ tree: false }); } } }),
      el('input.grow', { value: c.message ?? '', placeholder: 'message', on: { input: (e) => { c.message = e.target.value; this.changed({ tree: false }); } } }),
      el('button.icon', { type: 'button', text: '✕', on: { click: () => { fg.checks.splice(i, 1); drawChecks(); this.changed({ tree: false }); } } }))));
    drawChecks();
    box.append(el('fieldset.bfield', {}, el('legend', { text: 'Rules it must keep' }), checks,
      el('button.small', { type: 'button', text: '+ Rule', on: { click: () => { fg.checks.push({ when: '', message: '' }); drawChecks(); this.changed({ tree: false }); } } })));
    const craftBox = el('fieldset.bfield', {}, el('legend', { text: 'Crafting by a character' }),
      el('label.check', {}, el('input', {
        type: 'checkbox', checked: craftOn,
        on: { change: (e) => { if (e.target.checked) fg.craft = { feat: '', bonus: '', dc: '', cost: '@price / 2', days: '1', currency: '' }; else delete fg.craft; this.changed({ tree: false }); this.renderEdit(); } },
      }), 'Characters can craft these (needs a feat, a check and money)'));
    if (craftOn) {
      const c = fg.craft;
      craftBox.append(
        this.formulaInput(c, 'feat', 'Feat needed (a formula giving its name; \'\' for none)', f),
        this.formulaInput(c, 'bonus', 'Check bonus', f, 'e.g. @skills.spellcraft.total'),
        this.formulaInput(c, 'dc', 'DC', f),
        this.formulaInput(c, 'cost', 'Cost', f, '@price is the price.'),
        this.formulaInput(c, 'days', 'Days', f),
        this.input(c, 'currency', { label: 'Money spent from (a number in the character\'s data, e.g. currency.gp)' }));
    }
    box.append(craftBox);
    return box;
  }

  check(obj, key, label) {
    return el('label.check', {}, el('input', { type: 'checkbox', checked: !!obj[key], on: { change: (e) => { obj[key] = e.target.checked; this.changed({ tree: false }); } } }), label);
  }

  select(obj, key, options) {
    return el('select', { on: { change: (e) => { obj[key] = e.target.value; this.changed({ tree: false }); } } },
      ...options.map(([v, l]) => el('option', { value: v, text: l, selected: obj[key] === v })));
  }

  formulaInput(obj, key, label, f, hint) {
    const ta = el('textarea.formula-input', { rows: 2, spellcheck: false, on: { input: (e) => { obj[key] = e.target.value; this.changed({ tree: false }); } } });
    ta.value = obj[key] ?? '';
    const insert = (p) => {
      const s = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, s) + p + ta.value.slice(ta.selectionEnd ?? s);
      ta.focus();
      ta.dispatchEvent(new Event('input'));
    };
    // Built when opened, so it reflects renames made since.
    const chips = el('div.formula-paths');
    const fill = () => chips.replaceChildren(
        ...this.pathsIn(f.type, f.isItem).filter((p) => p !== `@${this.pathOf(f.node.id)}`).map((p) => el('button.chip', { type: 'button', text: p, on: { click: () => insert(p) } })),
        ...(f.isItem ? [el('span.muted.small', { text: 'Item formulas can also use the owner\'s values, e.g. @abilities.str.mod.' })] : []),
        ...(this.pathOf(f.node.id).includes('*') ? [el('button.chip', { type: 'button', text: '@this', on: { click: () => insert('@this.') } })] : []),
        ...Object.keys(this.bp.tables).map((t) => el('button.chip', { type: 'button', text: `table('${t}', …)`, on: { click: () => insert(`table('${t}', @level)`) } })));
    const helper = el('details.formula-help', { on: { toggle: (e) => { if (e.target.open) fill(); } } }, el('summary', { text: 'Values you can use' }), chips,
      el('p.muted.small', { text: 'Maths: + − × ÷, floor() ceil() round() min() max() abs(). Conditions: a > b ? x : y. Text: "1d8".' }));
    return el('div.formula-field', {}, el('label', {}, label, ta), hint ? el('small.muted', { text: hint }) : null, helper);
  }

  choiceEditor(n, f) {
    const lists = [];
    const go = (nodes, prefix) => { for (const c of nodes) { const p = prefix ? `${prefix}.${c.key}` : c.key; if (c.kind === 'list') lists.push(p); if (c.kind === 'group') go(c.children, c.flat ? prefix : p); } };
    go(f.type.children, '');
    const src = el('select', { on: { change: (e) => { n.source = e.target.value || null; this.changed({ tree: false }); this.renderEdit(); } } },
      el('option', { value: '', text: 'Options I type in' }), ...lists.map((l) => el('option', { value: l, text: `The entries of ${l}`, selected: n.source === l })));
    const parts = [el('label', {}, 'Options', src)];
    if (!n.source) {
      const ta = el('textarea', { rows: 4, placeholder: 'One per line: value: Label (or just value)', on: {
        input: (e) => {
          n.options = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
            const [v, ...rest] = l.split(':');
            return { value: v.trim(), label: rest.join(':').trim() || v.trim() };
          });
          this.changed({ tree: false });
        },
      } });
      ta.value = (n.options ?? []).map((o) => (o.label && o.label !== o.value ? `${o.value}: ${o.label}` : o.value)).join('\n');
      parts.push(ta, this.input(n, 'default', { label: 'Starting choice (a value)' }));
    }
    return el('div', {}, ...parts);
  }

  resetEditor(n) {
    n.reset ??= {};
    const rests = this.bp.rests.length ? this.bp.rests : ['short', 'long'];
    return el('fieldset.bfield', {}, el('legend', { text: 'On a rest' }),
      ...rests.map((r) => el('label', {}, `${r} rest`, el('input', {
        value: n.reset[r] ?? '', placeholder: 'nothing; "max"; or a formula with @value and @max',
        on: { input: (e) => { const v = e.target.value.trim(); if (v) n.reset[r] = v; else delete n.reset[r]; this.changed({ tree: false }); } },
      }))),
      this.bp.rests.length ? null : el('p.muted.small', { text: 'Add rests under Rules › Rests to use these.' }));
  }

  entriesEditor(n) {
    n.entries ??= [];
    const fields = (n.children ?? []).filter((c) => c.kind !== 'formula');
    const body = el('tbody');
    const draw = () => {
      body.replaceChildren(...n.entries.map((e, i) => el('tr', {},
        el('td', {}, el('input', { value: e.label ?? '', placeholder: 'Name', on: { input: (ev) => { e.label = ev.target.value; if (e._new && !e.keyEdited) e.key = slug(e.label).slice(0, 12) || e.key; this.changed({ tree: false }); } } })),
        el('td', {}, el('input', { value: e.key ?? '', placeholder: 'key', size: 8, on: { input: (ev) => { e.key = ev.target.value; e.keyEdited = true; this.changed({ tree: false }); } } })),
        ...fields.map((fd) => el('td', {}, el('input', {
          value: e.values?.[fd.key] ?? '', placeholder: String(fd.default ?? ''), size: 6,
          on: { input: (ev) => { e.values ??= {}; const raw = ev.target.value; if (raw === '') delete e.values[fd.key]; else e.values[fd.key] = fd.kind === 'number' ? Number(raw) : fd.kind === 'checkbox' ? raw === 'true' : raw; this.changed({ tree: false }); } },
        }))),
        el('td', {}, el('button.icon', { type: 'button', text: '✕', title: 'Remove', on: { click: () => { n.entries.splice(i, 1); draw(); this.changed({ tree: false }); } } })))));
    };
    draw();
    return el('fieldset.bfield', {}, el('legend', { text: 'Starting entries' }),
      el('table.roll-table.editing', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Name' }), el('th', { text: 'Key' }), ...fields.map((fd) => el('th', { text: fd.label || fd.key })), el('th'))), body),
      el('button.small', { type: 'button', text: '+ Entry', on: { click: () => { n.entries.push({ key: `entry${n.entries.length + 1}`, label: '', values: {}, _new: true }); draw(); this.changed({ tree: false }); } } }));
  }

  thenEditor(n, f) {
    const others = (f.type.children ?? []).flatMap(function flat(c) { return c.kind === 'action' ? [c] : (c.children ?? []).flatMap(flat); }).filter((a) => a !== n);
    if (!others.length) return null;
    n.then ??= [];
    return el('fieldset.bfield', {}, el('legend', { text: 'Then offer (buttons on the chat card)' }),
      ...others.map((a) => el('label.check', {}, el('input', {
        type: 'checkbox', checked: n.then.includes(a.key),
        on: { change: (e) => { n.then = e.target.checked ? [...n.then, a.key] : n.then.filter((k) => k !== a.key); this.changed({ tree: false }); } },
      }), a.label || a.key)));
  }

  costEditor(n) {
    const cost = n.cost ?? { path: '', amount: '1' };
    const set = () => { n.cost = cost.path.trim() ? cost : null; this.changed({ tree: false }); };
    return el('fieldset.bfield', {}, el('legend', { text: 'Cost (optional)' }),
      el('div.row', {},
        el('label.grow', {}, 'Spend from (a resource: on the item, or actor.something)', el('input', { value: cost.path, placeholder: 'uses', on: { input: (e) => { cost.path = e.target.value; set(); } } })),
        el('label', {}, 'Amount', el('input', { value: cost.amount ?? '1', size: 4, on: { input: (e) => { cost.amount = e.target.value || '1'; set(); } } }))));
  }

  changesEditor(owner, changes, f) {
    const body = el('div.changes');
    const draw = () => {
      body.replaceChildren(...changes.map((c, i) => el('div.row.change-row', {},
        el('input', { value: c.path, placeholder: 'value it changes, e.g. ac', on: { input: (e) => { c.path = e.target.value.replace(/^@/, ''); this.changed({ tree: false }); } } }),
        this.select(c, 'mode', MODES),
        el('input.grow', { value: c.value, placeholder: 'formula', on: { input: (e) => { c.value = e.target.value; this.changed({ tree: false }); } } }),
        el('input', { size: 9, value: c.type ?? '', placeholder: 'bonus type', title: 'Bonuses of the same type don\'t stack: only the biggest counts. Blank: always stacks.', on: { input: (e) => { const t = e.target.value.trim(); if (t) c.type = t; else delete c.type; this.changed({ tree: false }); } } }),
        el('button.icon', { type: 'button', text: '✕', on: { click: () => { changes.splice(i, 1); draw(); this.changed({ tree: false }); } } }))));
    };
    draw();
    return el('fieldset.bfield', {}, el('legend', { text: 'Changes' }), body,
      el('button.small', { type: 'button', text: '+ Change', on: { click: () => { changes.push({ path: '', mode: 'add', value: '0' }); draw(); this.changed({ tree: false }); } } }),
      el('p.muted.small', { text: 'Order: set, then at least / at most (pick the base, e.g. armour), then multiply, then add (bonuses). For advantage, set mods.attack.advantage (or check, save) to 1.' }),
      f ? null : null);
  }

  // ------------------------------------------------------------------ layout and sheets

  /** How a node sits on the sheet: label, width, display; groups: columns, frame, placement. */
  layoutEditor(n, f) {
    const num = (v) => (v === '' ? 0 : Number(v));
    const sel = (key, options, conv = (v) => v) => el('select', {
      on: { change: (e) => { const v = conv(e.target.value); if (v === '' || v === 0) delete n[key]; else n[key] = v; this.changed({ tree: false }); } },
    }, ...options.map(([v, l]) => el('option', { value: v, text: l, selected: String(n[key] ?? '') === String(v) || (!n[key] && (v === '' || v === 0)) })));
    const parts = [
      el('label.check', {}, el('input', { type: 'checkbox', checked: !!n.hide_label, on: { change: (e) => { n.hide_label = e.target.checked || undefined; this.changed({ tree: false }); } } }),
        n.kind === 'group' ? 'Hide the title' : n.kind === 'action' ? 'Show just 🎲 (no name)' : 'Hide the label'),
      el('label', {}, 'Width', sel('span', [[0, 'Automatic'], [1, '1 column'], [2, '2 columns'], [3, '3 columns'], [4, '4 columns'], [99, 'Whole row']], num)),
    ];
    if (['number', 'text', 'choice', 'formula', 'resource', 'action'].includes(n.kind)) {
      parts.push(el('label', {}, 'Display', sel('display', [['', 'Normal'], ['big', 'Big number box'], ['badge', 'Round badge'], ['inline', 'Label beside value'], ['plain', 'Plain (no box)']])));
    }
    if (n.kind === 'group') {
      parts.push(
        el('label', {}, 'Columns inside', sel('columns', [[0, 'As many as fit'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']], num)),
        el('label', {}, 'Frame', sel('frame', [['', 'Box'], ['card', 'Card (filled)'], ['plain', 'None']])));
      if (f.parent?.kind === 'type' && !f.isItem) {
        parts.push(el('label', {}, 'Placement', el('select', {
          on: { change: (e) => { if (e.target.value) n.place = e.target.value; else delete n.place; this.changed({ tree: false }); this.renderEdit(); } },
        }, ...[['', 'A tab'], ['header', 'Header: small values under the name'], ['vitals', 'Header: right-hand side (HP, AC…)'],
          ['top', 'Always on top (above the tabs)'], ['side', 'Side column (beside the tabs)']].map(([v, l]) => el('option', { value: v, text: l, selected: (n.place ?? '') === v })))));
      }
    }
    const box = el('fieldset.bfield.layout-editor', {}, el('legend', { text: 'Layout' }), el('div.row.layout-row', {}, ...parts));
    if (n.kind === 'group' && f.parent?.kind === 'type' && !f.isItem && !n.place) box.append(this.iconPicker(n, 'Tab icon'));
    return box;
  }

  /** Pick a tab icon: a built-in drawing, or any emoji. */
  iconPicker(n, legend) {
    const wrap = el('div.icon-picker');
    const pick = (v) => { if (v) n.icon = v; else delete n.icon; this.changed({ tree: false }); draw(); };
    const draw = () => {
      wrap.replaceChildren(
        el('button', { type: 'button', title: 'No icon', class: n.icon ? 'icon-choice' : 'icon-choice on', text: '∅', on: { click: () => pick('') } }),
        ...SHEET_ICONS.map((name) => el('button', { type: 'button', title: name, class: n.icon === name ? 'icon-choice on' : 'icon-choice', on: { click: () => pick(name) } }, icon(name))),
        el('input.icon-emoji', {
          value: n.icon && !SHEET_ICONS.includes(n.icon) ? n.icon : '', placeholder: 'or an emoji', maxlength: 4,
          on: { change: (e) => pick(e.target.value.trim()) },
        }));
    };
    draw();
    return el('div.icon-picker-wrap', {}, el('span.small.muted', { text: legend }), wrap);
  }

  /** Item types: where and how the character sheet lists them. */
  itemListEditor(n) {
    const tabs = [];
    for (const t of this.bp.actor_types ?? []) {
      for (const g of t.children ?? []) {
        if (g.kind === 'group' && !g.place && !tabs.some(([k]) => k === g.key)) tabs.push([g.key, `The ${g.label || g.key} tab`]);
      }
    }
    const fields = (n.children ?? []).filter((c) => ['number', 'text', 'choice', 'checkbox', 'formula', 'resource'].includes(c.kind));
    const opt = (cur) => ([v, l]) => el('option', { value: v, text: l, selected: (cur ?? '') === v });
    const tabSel = el('select', { on: { change: (e) => { if (e.target.value) n.tab = e.target.value; else delete n.tab; this.changed({ tree: false }); this.renderEdit(); } } },
      ...[['', 'The Items tab'], ['own', 'A tab of its own'], ...tabs].map(opt(n.tab)));
    const groupSel = el('select', { on: { change: (e) => { if (e.target.value) n.group_by = e.target.value; else delete n.group_by; this.changed({ tree: false }); } } },
      ...[['', 'No grouping'], ...fields.filter((c) => c.kind !== 'resource').map((c) => [c.key, c.label || c.key])].map(opt(n.group_by)));
    const summary = new Set(n.summary ?? []);
    const checks = fields.map((c) => el('label.check', {}, el('input', {
      type: 'checkbox', checked: summary.has(c.key),
      on: {
        change: (e) => {
          if (e.target.checked) summary.add(c.key); else summary.delete(c.key);
          const order = fields.map((x) => x.key).filter((k) => summary.has(k));
          if (order.length) n.summary = order; else delete n.summary;
          this.changed({ tree: false });
        },
      },
    }), c.label || c.key));
    const box = el('fieldset.bfield', {}, el('legend', { text: 'On the character sheet' }),
      el('div.row.layout-row', {}, el('label', {}, 'Listed on', tabSel), el('label', {}, 'Group by', groupSel),
        el('label', {}, 'List title', el('input', { value: n.list_title ?? '', placeholder: n.label || n.key, on: { input: (e) => { if (e.target.value.trim()) n.list_title = e.target.value; else delete n.list_title; this.changed({ tree: false }); } } }))),
      el('p.muted.small', { text: 'Grouping by a number shows "Level 1", "Level 2"…; by a choice, its option names.' }));
    if (n.tab === 'own') box.append(this.iconPicker(n, 'Tab icon'));
    if (fields.length) box.append(el('div.small.muted', { text: 'Show beside each name:' }), el('div.row.summary-checks', {}, ...checks));
    return box;
  }

  /** Every type: which sheet it uses (generated, designed, hand-made HTML, or for items none). */
  sheetEditor(n, isItem) {
    const box = el('fieldset.bfield.sheet-editor', {}, el('legend', { text: 'Sheet' }));
    const mode = sheetMode(n);
    const MODES = [
      ['generated', 'Generated', 'Laid out from this tree and its Layout settings.'],
      ['designed', 'Designed', 'Your own layout, arranged by dragging in the sheet designer.'],
      ['html', 'Custom HTML', 'A hand-written (or AI-written) HTML file in the system folder.'],
      ...(isItem ? [['none', 'None', 'No window of its own: on a character sheet, its details open in place under its name.']] : []),
    ];
    const setMode = (m) => {
      const fresh = m === 'designed' && !n.layouts?.length;
      if (fresh) n.layouts = [layoutFromType(n, isItem)];
      n.sheet_mode = m;
      this.changed({ tree: false });
      this.renderEdit();
      if (fresh) openDesigner(this, n, isItem);
    };
    box.append(el('div.sheet-modes', { role: 'radiogroup', 'aria-label': 'Sheet' }, ...MODES.map(([v, l, help]) => el('label.sheet-mode', { class: v === mode ? 'sheet-mode on' : 'sheet-mode', title: help },
      el('input', { type: 'radio', name: `sheet-mode-${n.id}`, value: v, checked: v === mode, on: { change: () => setMode(v) } }),
      el('strong', { text: l }), el('small.muted', { text: help })))));

    if (mode === 'designed') {
      // Which layout this box is showing (not necessarily the default).
      this.layoutPick ??= {};
      const def = n.layouts.find((l) => l.id === n.default_layout) ?? n.layouts[0];
      let layout = n.layouts.find((l) => l.id === this.layoutPick[n.id]) ?? def;
      const pickLayout = (id) => { this.layoutPick[n.id] = id; this.renderEdit(); };
      const nameOf = (l) => l.name || l.id;
      const add = (fresh) => {
        const name = prompt('Name of the new layout', fresh ? 'New sheet' : `${nameOf(layout)} (copy)`);
        if (!name?.trim()) return;
        const made = fresh ? layoutFromType(n, isItem) : structuredClone(layout);
        made.id = newLayoutId(n);
        made.name = name.trim();
        n.layouts.push(made);
        this.changed({ tree: false });
        pickLayout(made.id);
        this.flush();
        openDesigner(this, n, isItem, made.id);
      };
      const isDefault = layout === def;
      const json = el('textarea.formula-input', { rows: 12, spellcheck: false, text: JSON.stringify(layout, null, 2) });
      const status = el('small.muted');
      json.addEventListener('change', () => {
        try {
          const v = JSON.parse(json.value);
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('a layout is an object { id, name, header, top, tabs }');
          v.id ||= layout.id;
          n.layouts[n.layouts.indexOf(layout)] = v;
          status.textContent = 'Saved.';
          this.changed({ tree: false });
        } catch (e) {
          status.textContent = `Not saved: ${e.message}`;
        }
      });
      box.append(
        el('div.row.layout-pick', {},
          el('label.grow', {}, 'Layout', el('select', {
            on: { change: (e) => pickLayout(e.target.value) },
          }, ...n.layouts.map((l) => el('option', { value: l.id, text: `${nameOf(l)}${l === def ? ' (default)' : ''}`, selected: l === layout })))),
          el('button.small', { type: 'button', text: '+ New', title: 'A new layout, starting from the generated sheet', on: { click: () => add(true) } }),
          el('button.small', { type: 'button', text: '⧉ Duplicate', title: 'A copy of this layout to change', on: { click: () => add(false) } })),
        el('p.small.muted', {}, `${describeLayout(layout)}. `, isDefault
          ? (n.layouts.length > 1 ? 'Sheets use this one unless a character picks another (the Sheet menu on its window).' : 'Sheets of this type use it.')
          : 'Characters can pick it from the Sheet menu on their window.'),
        el('div.row', {},
          el('button.small.primary', { type: 'button', text: '✎ Open the sheet designer', on: { click: () => { this.flush(); openDesigner(this, n, isItem, layout.id); } } }),
          isDefault ? null : el('button.small', { type: 'button', text: '★ Make this the default', on: { click: () => { n.default_layout = layout.id; this.changed({ tree: false }); this.renderEdit(); } } }),
          el('button.small', {
            type: 'button', text: 'Rename',
            on: { click: () => { const v = prompt('Name of this layout', nameOf(layout)); if (v?.trim()) { layout.name = v.trim(); this.changed({ tree: false }); this.renderEdit(); } } },
          }),
          el('button.small.danger', {
            type: 'button', text: 'Delete', disabled: n.layouts.length < 2, title: n.layouts.length < 2 ? 'A designed sheet needs at least one layout' : 'Delete this layout',
            on: {
              click: () => {
                if (!confirm(`Delete the layout "${nameOf(layout)}"? Characters using it go back to the default.`)) return;
                closeDesigner(n, layout.id);
                n.layouts.splice(n.layouts.indexOf(layout), 1);
                if (n.default_layout === layout.id) delete n.default_layout;
                delete this.layoutPick[n.id];
                this.changed({ tree: false });
                this.renderEdit();
              },
            },
          })),
        el('details.layout-json', {}, el('summary', { text: 'Layout data (advanced)' }),
          el('p.muted.small', { text: 'Blocks on a 12-column grid: x and w are columns, y and h are rows (rows grow with their content). A field block shows a value by its path, e.g. "bind": "abilities.str.mod". See docs/sheets.md.' }),
          json, status));
    } else if (mode === 'html') {
      if (n.sheet) {
        box.append(
          el('p.small', {}, 'Uses ', el('code', { text: n.sheet }), ' in the system folder. Edit it in any text editor (see docs/sheets.md); save, then reload the world to see changes. The Sheet style applies to it too.'),
          el('button.small', { type: 'button', text: 'Remake it from the generated sheet', title: 'Overwrites the file', on: { click: () => { if (confirm(`Overwrite ${n.sheet} with a fresh copy made from the generated sheet?`)) this.exportSheet(n, isItem); } } }));
      } else {
        box.append(
          el('p.muted.small', { text: 'Make an HTML file from the generated sheet, then edit it freely; the rules keep working.' }),
          el('button.small.primary', { type: 'button', text: 'Make the HTML file', on: { click: () => this.exportSheet(n, isItem) } }));
      }
    } else if (mode === 'none') {
      box.append(el('p.muted.small', { text: 'Click its name in a list on a character sheet to show and edit its details right there.' }));
    }
    if (mode !== 'none') {
      box.append(el('label.row', {}, 'Window width (px)', el('input', {
        type: 'number', min: 300, max: 1600, step: 20, value: n.width || '', placeholder: isItem ? '440' : '760', style: 'width: 90px',
        on: { change: (e) => { const v = Number(e.target.value); if (v >= 300) n.width = Math.round(v); else delete n.width; this.changed({ tree: false }); } },
      })));
    }
    return box;
  }

  async exportSheet(n, isItem = false) {
    this.flush();
    // The template is made from the saved system, so wait a moment for the save to land.
    await new Promise((r) => setTimeout(r, 500));
    const html = isItem ? itemSheetTemplate(n) : sheetTemplate(n);
    try {
      const res = await fetch('/api/builder/sheet', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-hearth-session': this.api.session ?? '' },
        body: JSON.stringify({ type: n.key, html, item: isItem }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { path } = await res.json();
      n.sheet = path;
      n.sheet_mode = 'html';
      this.changed({ tree: false });
      this.renderEdit();
      toast(`Saved ${path} in the system folder. The ${n.label || n.key} sheet now uses it.`);
    } catch (e) {
      toast(`Couldn't make the sheet: ${e.message}`, 'error');
    }
  }

  editStyle() {
    const s = (this.bp.style && typeof this.bp.style === 'object') ? this.bp.style : (this.bp.style = {});
    const FONTS = [['', 'Hearth default'], ['system-ui, sans-serif', 'Sans-serif'], ['Georgia, "Times New Roman", serif', 'Serif'],
      ['"Palatino Linotype", "Book Antiqua", Palatino, serif', 'Book (Palatino)'], ['"Trebuchet MS", sans-serif', 'Humanist (Trebuchet)'],
      ['"Courier New", monospace', 'Typewriter']];
    const color = (key, labelText) => {
      const on = el('input', { type: 'checkbox', checked: !!s[key], title: 'Use this colour (otherwise the theme decides)' });
      const pick = el('input', { type: 'color', value: s[key] || '#888888' });
      const update = () => { if (on.checked) s[key] = pick.value; else delete s[key]; this.changed({ tree: false }); };
      on.addEventListener('change', update);
      pick.addEventListener('input', () => { on.checked = true; update(); });
      return el('label.check.style-color', {}, on, pick, labelText);
    };
    const font = (key, labelText) => el('label', {}, labelText, el('select', {
      on: { change: (e) => { if (e.target.value) s[key] = e.target.value; else delete s[key]; this.changed({ tree: false }); } },
    }, ...FONTS.map(([v, l]) => el('option', { value: v, text: l, selected: (s[key] ?? '') === v }))));
    const css = el('textarea.formula-input', { rows: 8, spellcheck: false, placeholder: '.bp-sheet [data-key="ac"] .bp-val { color: crimson; }\n.bp-sheet .bp-group-title { border-bottom: 1px solid var(--accent); }', on: { input: (e) => { s.css = e.target.value; this.changed({ tree: false }); } } });
    css.value = s.css ?? '';
    const reset = () => { for (const k of [...COLOR_KEYS, 'heading_font', 'body_font', 'radius']) delete s[k]; };
    const presets = SHEET_PRESETS.map((p) => el('button.preset', {
      type: 'button', title: `Use the ${p.name} colours and fonts (your Extra CSS stays)`,
      on: { click: () => { reset(); Object.assign(s, p.style); this.changed({ tree: false }); this.editStyle(); } },
    }, el('span.preset-swatch', {}, ...[p.style.header, p.style.box, p.style.accent, p.style.button].map((c) => el('i', { style: `background:${c}` }))), p.name));
    const clear = el('button.small', { type: 'button', text: 'Back to the app theme', on: { click: () => { reset(); this.changed({ tree: false }); this.editStyle(); } } });
    this.editEl.replaceChildren(
      el('div.builder-edit-head', {}, el('strong', { text: '⚙ Sheet style' })),
      el('p.muted.small', { text: 'Colours and fonts for this system\'s sheets (generated or hand-made). Unticked colours follow the app\'s theme. Open a test character to see changes as you make them.' }),
      el('fieldset.bfield', {}, el('legend', { text: 'Start from a look' }), el('div.style-presets', {}, ...presets, clear)),
      el('fieldset.bfield', {}, el('legend', { text: 'Colours' }),
        el('div.style-colors', {}, color('accent', 'Accent (names, titles)'), color('background', 'Sheet background'), color('header', 'Header and tab bar'),
          color('box', 'Boxes and cards'), color('raised', 'Rows inside cards'), color('input', 'Input boxes'), color('text', 'Text'), color('muted', 'Labels'),
          color('border', 'Borders'), color('button', 'Buttons'))),
      el('fieldset.bfield', {}, el('legend', { text: 'Fonts and shape' }),
        el('div.row', {}, font('heading_font', 'Headings'), font('body_font', 'Body'),
          el('label', {}, 'Corner rounding (px)', el('input', { type: 'number', min: 0, max: 30, value: s.radius ?? '', placeholder: 'default', on: { input: (e) => { if (e.target.value === '') delete s.radius; else s.radius = Number(e.target.value); this.changed({ tree: false }); } } })))),
      el('fieldset.bfield', {}, el('legend', { text: 'Extra CSS (advanced)' }), css,
        el('p.muted.small', { text: 'Everything on a sheet has a class (.bp-field, .bp-group, .bp-val, .bp-label…) and data-key="its path", so you can style one value or a whole group. See docs/sheets.md.' })));
  }

  // ------------------------------------------------------------------ rules sections

  editTables() {
    const t = this.bp.tables;
    const parts = [el('div.builder-edit-head', {}, el('strong', { text: '⚙ Tables' })),
      el('p.muted.small', { text: 'Values looked up by a number, like level. Formulas use table(\'name\', @level): the row with the highest number not above the lookup wins. A value can be a list, e.g. 4, 3, 2 → table(\'slots\', @level)[0].' })];
    for (const name of Object.keys(t)) {
      const rows = Object.entries(t[name] ?? {});
      const ta = el('textarea', { rows: Math.min(10, rows.length + 2), placeholder: '1: 2\n5: 3\n9: 4', on: {
        input: (e) => {
          const obj = {};
          for (const line of e.target.value.split('\n')) {
            const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
            if (!m) continue;
            const raw = m[2].trim();
            obj[m[1].trim()] = raw.includes(',') ? raw.split(',').map((x) => Number(x.trim()) || 0) : (Number.isNaN(Number(raw)) ? raw : Number(raw));
          }
          t[name] = obj;
          this.changed({ tree: false });
        },
      } });
      ta.value = rows.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
      parts.push(el('fieldset.bfield', {}, el('legend', {}, name, ' ', el('button.icon', { type: 'button', text: '✕', title: 'Delete table', on: { click: () => { if (confirm(`Delete the table ${name}?`)) { delete t[name]; this.changed(); this.renderEdit(); } } } })), ta));
    }
    parts.push(el('button.small', { type: 'button', text: '+ Table', on: { click: () => {
      const name = slug(prompt('Table name (e.g. proficiency)') ?? '');
      if (!name) return;
      t[name] ??= { 1: 0 };
      this.changed();
      this.renderEdit();
    } } }));
    this.editEl.replaceChildren(...parts);
  }

  editConditions() {
    const list = this.bp.conditions;
    const parts = [el('div.builder-edit-head', {}, el('strong', { text: '⚙ Conditions' })),
      el('p.muted.small', { text: 'Conditions players and the GM switch on and off (poisoned, prone…). Each one changes values while it\'s on.' })];
    list.forEach((c, i) => {
      parts.push(el('fieldset.bfield', {}, el('legend', {}, c.name || c.id, ' ', el('button.icon', { type: 'button', text: '✕', title: 'Delete', on: { click: () => { list.splice(i, 1); this.changed(); this.renderEdit(); } } })),
        el('div.row', {}, el('label.grow', {}, 'Name', el('input', { value: c.name ?? '', on: { input: (e) => { c.name = e.target.value; if (c._new && !c.idEdited) c.id = slug(c.name); this.changed({ tree: false }); } } })),
          el('label', {}, 'Key', el('input', { value: c.id ?? '', size: 10, on: { input: (e) => { c.id = e.target.value; c.idEdited = true; this.changed({ tree: false }); } } }))),
        el('label', {}, 'What it does (shown on hover and in the Ctrl+Space lookup)', el('textarea', {
          rows: 3, text: c.description ?? '', placeholder: 'e.g. Disadvantage on attack rolls and ability checks.',
          on: { input: (e) => { if (e.target.value.trim()) c.description = e.target.value; else delete c.description; this.changed({ tree: false }); } },
        })),
        this.changesEditor(c, c.changes ??= [], null)));
    });
    parts.push(el('button.small', { type: 'button', text: '+ Condition', on: { click: () => { list.push({ id: `condition_${list.length + 1}`, name: 'New condition', changes: [], _new: true }); this.changed(); this.renderEdit(); } } }));
    this.editEl.replaceChildren(...parts);
  }

  /** Character creation: steps (e.g. ability scores) and the methods each offers; worlds pick from these. */
  editCreation() {
    const steps = this.bp.creation;
    const KINDS = [['array', 'Fixed values (standard array)'], ['pointbuy', 'Point buy'], ['roll', 'Roll dice'], ['manual', 'Enter your own']];
    const ch = () => this.changed({ tree: false });
    const field = (obj, key, labelText, opts = {}) => el('label', {}, labelText, el('input', {
      value: Array.isArray(obj[key]) ? obj[key].join(', ') : obj[key] ?? '', placeholder: opts.placeholder ?? '', type: opts.number ? 'number' : 'text', style: opts.width ? `width: ${opts.width}` : null,
      on: {
        input: (e) => {
          const raw = e.target.value.trim();
          if (raw === '') delete obj[key];
          else if (opts.list) obj[key] = raw.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
          else obj[key] = opts.number ? Number(raw) : raw;
          ch();
        },
      },
    }));
    const costsField = (m) => el('label', {}, 'Cost of each score (score:cost, …)', el('input', {
      value: Object.entries(m.costs ?? {}).map(([k, v]) => `${k}:${v}`).join(', '), placeholder: '8:0, 9:1, 10:2, 11:3, 12:4, 13:5, 14:7, 15:9', style: 'width: 100%',
      on: { input: (e) => { const c = {}; for (const part of e.target.value.split(',')) { const [k, v] = part.split(':').map((x) => x.trim()); if (k && v !== undefined && Number.isFinite(Number(v))) c[k] = Number(v); } m.costs = c; ch(); } },
    }));
    const methodBox = (step, m, i) => {
      const box = el('div.creation-method-edit', {},
        el('div.row', {}, field(m, 'label', 'Name', { placeholder: 'Standard array' }), field(m, 'id', 'Key', { width: '90px' }),
          el('label', {}, 'Kind', el('select', { on: { change: (e) => { m.kind = e.target.value; ch(); this.editCreation(); } } }, ...KINDS.map(([v, l]) => el('option', { value: v, text: l, selected: (m.kind ?? 'array') === v })))),
          el('button.icon', { type: 'button', text: '✕', title: 'Remove this method', on: { click: () => { step.methods.splice(i, 1); ch(); this.editCreation(); } } })));
      const k = m.kind ?? 'array';
      if (k === 'array') box.append(field(m, 'values', 'Values (separated by commas)', { list: true, placeholder: '15, 14, 13, 12, 10, 8' }));
      if (k === 'pointbuy') box.append(el('div.row', {}, field(m, 'points', 'Points', { number: true, width: '70px' }), field(m, 'min', 'Lowest', { number: true, width: '70px' }), field(m, 'max', 'Highest', { number: true, width: '70px' })), costsField(m));
      if (k === 'roll') {
        box.append(el('div.row', {}, field(m, 'formula', 'Dice', { placeholder: '4d6kh3' }), field(m, 'count', 'Rolls (blank: one per score)', { number: true, width: '70px' }),
          el('label.check', {}, el('input', { type: 'checkbox', checked: !!m.in_order, on: { change: (e) => { if (e.target.checked) m.in_order = true; else delete m.in_order; ch(); } } }), 'In order (no rearranging)')));
      }
      if (k === 'manual') box.append(el('div.row', {}, field(m, 'min', 'Lowest', { number: true, width: '70px' }), field(m, 'max', 'Highest', { number: true, width: '70px' })));
      return box;
    };
    const parts = [el('div.builder-edit-head', {}, el('strong', { text: '⚙ Character creation' })),
      el('p.muted.small', { text: 'Steps a new character goes through first, like setting ability scores, and the methods each offers. The GM of each world picks which methods players may use there, and can change their numbers (e.g. the points for point buy).' })];
    steps.forEach((step, si) => {
      step.methods ??= [];
      parts.push(el('fieldset.bfield', {}, el('legend', {}, step.label || step.id, ' ', el('button.icon', { type: 'button', text: '✕', title: 'Remove this step', on: { click: () => { if (confirm(`Remove the "${step.label || step.id}" step?`)) { steps.splice(si, 1); ch(); this.editCreation(); } } } })),
        el('div.row', {}, field(step, 'label', 'Name', { placeholder: 'Ability scores' }), field(step, 'id', 'Key', { width: '100px' }),
          field(step, 'path', 'Sets the list', { placeholder: 'abilities', width: '110px' }), field(step, 'field', 'Field in each entry', { placeholder: 'value', width: '90px' })),
        // Which actor types go through it (e.g. characters, not monsters). None ticked: all.
        el('div.row', {}, el('span.muted.small', { text: 'For:' }), ...this.bp.actor_types.map((t) => el('label.check', {}, el('input', {
          type: 'checkbox', checked: !!step.actor_types?.includes(t.key),
          on: { change: (e) => { const s = new Set(step.actor_types ?? []); if (e.target.checked) s.add(t.key); else s.delete(t.key); if (s.size) step.actor_types = [...s]; else delete step.actor_types; ch(); } },
        }), t.label || t.key)), el('span.muted.small', { text: '(none ticked: every type)' })),
        ...step.methods.map((m, i) => methodBox(step, m, i)),
        el('button.small', { type: 'button', text: '+ Method', on: { click: () => { const n = step.methods.length + 1; step.methods.push({ id: `method_${n}`, kind: 'manual', label: 'New method' }); ch(); this.editCreation(); } } })));
    });
    parts.push(el('button.small', {
      type: 'button', text: '+ Ability scores step',
      title: 'Standard array, point buy (27), 4d6 drop lowest, 3d6 in order and enter-your-own, filling the "abilities" list',
      on: {
        click: () => {
          steps.push({ id: steps.some((s) => s.id === 'abilities') ? `scores_${steps.length + 1}` : 'abilities', label: 'Ability scores', path: 'abilities', field: 'value', methods: [
            { id: 'array', kind: 'array', label: 'Standard array', values: [15, 14, 13, 12, 10, 8] },
            { id: 'points', kind: 'pointbuy', label: 'Point buy', points: 27, min: 8, max: 15, costs: { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 } },
            { id: '4d6', kind: 'roll', label: 'Roll 4d6, drop the lowest', formula: '4d6kh3' },
            { id: '3d6', kind: 'roll', label: 'Roll 3d6 in order', formula: '3d6', in_order: true },
            { id: 'manual', kind: 'manual', label: 'Enter your own', min: 3, max: 18 }] });
          ch();
          this.editCreation();
        },
      },
    }));
    this.editEl.replaceChildren(...parts);
  }

  editRests() {
    const ta = el('input', { value: this.bp.rests.join(', '), placeholder: 'short, long', on: { input: (e) => { this.bp.rests = e.target.value.split(',').map((x) => slug(x)).filter(Boolean); this.changed({ tree: false }); } } });
    const stack = el('input', { value: (this.bp.stacking ?? []).join(', '), placeholder: 'dodge, circumstance', on: { input: (e) => { const v = e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); if (v.length) this.bp.stacking = v; else delete this.bp.stacking; this.changed({ tree: false }); } } });
    this.editEl.replaceChildren(el('div.builder-edit-head', {}, el('strong', { text: '⚙ Rests and bonuses' })),
      el('label', {}, 'Kinds of rest, separated by commas', ta),
      el('p.muted.small', { text: 'Sheets get a button for each. Resources say what each rest restores.' }),
      el('label', {}, 'Bonus types that stack with themselves, separated by commas', stack),
      el('p.muted.small', { text: 'A change that adds can name a bonus type (enhancement, morale, deflection…). Bonuses of one type on the same value don\'t stack: only the biggest counts. Types listed here (and untyped bonuses, and all penalties) always add up.' }));
  }

  // ------------------------------------------------------------------ preview

  /** Open (or make) an actor of the selected actor type, to watch its sheet as you build. */
  async testActor() {
    const f = this.sel && this.find(this.sel);
    const type = f && !f.isItem ? f.type : this.bp.actor_types[0];
    if (!type) { toast('Make an actor type first.'); return; }
    this.flush();
    const existing = Object.values(store.world.actors).find((a) => a.kind === type.key && a.name.startsWith('Test '));
    if (existing) { this.api.sheets.open(existing.id); return; }
    const id = uid() + uid().slice(0, 4);
    this.api.op({ op: 'actor_create', actor: { id, name: `Test ${type.label || type.key}`, kind: type.key, data: {}, owners: [], items: [] } });
    const off = hooks.on('op:actor_create', (op) => { if (op.actor.id === id) { off?.(); this.api.sheets.open(id); } });
    setTimeout(() => { if (store.world.actors[id]) this.api.sheets.open(id); }, 1200);
  }
}
