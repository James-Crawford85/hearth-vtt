// The right-hand sidebar: an icon rail (always visible) and the open panel
// beside it. Clicking the open panel's icon again, or the arrow at the bottom
// of the rail, folds the panel away so the scene gets the full width.
// Packages can add panels with hearth.ui.addTab({ id, label, icon, render }).

import { hooks } from './hooks.js';
import { store, isGM, ownsActor, systemInfo, combatOrder } from './store.js';
import { el, formDialog, openWindow, toast } from './ui.js';
import { icon, hasIcon } from './icons.js';

const PANEL_W = 340;
const RAIL_W = 52;

export class Sidebar {
  constructor(api) {
    this.api = api;
    this.tabs = new Map();
    this.root = document.getElementById('sidebar');
    this.rail = document.getElementById('tabs');
    this.panels = document.getElementById('tab-panels');
    this.title = document.getElementById('panel-title');
    this.chatControls = el('div.chat-controls');
    this.collapseBtn = el('button.rail-btn.rail-collapse', { on: { click: () => this.setCollapsed(!this.collapsed) } });
    let collapsed = false;
    try { collapsed = localStorage.getItem('hearth.sidebar.collapsed') === '1'; } catch { /* storage blocked */ }
    this.collapsed = collapsed;

    this.addTab({ id: 'chat', label: 'Chat', icon: 'chat', render: (p) => this.renderChat(p) });
    this.addTab({ id: 'combat', label: 'Combat Tracker', icon: 'combat', render: (p) => this.renderCombat(p) });
    this.addTab({ id: 'scenes', label: 'Scenes', icon: 'scenes', gmOnly: true, render: (p) => this.renderScenes(p) });
    this.addTab({ id: 'actors', label: 'Actors', icon: 'actors', render: (p) => this.renderActors(p) });
    this.addTab({ id: 'items', label: 'Items', icon: 'items', render: (p) => this.api.items.renderPanel(p) });
    this.addTab({ id: 'journal', label: 'Journal', icon: 'journal', render: (p) => this.api.journal.renderPanel(p) });
    this.addTab({ id: 'tables', label: 'Rollable Tables', icon: 'tables', render: (p) => this.api.tables.renderPanel(p) });
    this.addTab({ id: 'macros', label: 'Macros', icon: 'macros', render: (p) => this.api.macros.renderPanel(p) });
    this.addTab({ id: 'playlists', label: 'Playlists', icon: 'playlists', render: (p) => this.api.playlists.renderPanel(p) });
    this.addTab({ id: 'collections', label: 'Collections', icon: 'collections', render: (p) => this.api.collections.renderPanel(p) });
    this.addTab({ id: 'settings', label: 'Settings', icon: 'settings', render: (p) => this.renderSettings(p) });
    this.select('chat', { toggle: false, open: !this.collapsed });
    this.applyLayout();
  }

  addTab({ id, label, render, icon: glyph, gmOnly = false, soon = false }) {
    const content = glyph && hasIcon(glyph) ? icon(glyph) : el('span.rail-letter', { text: glyph || label.charAt(0) });
    const button = el('button.rail-btn', {
      role: 'tab', title: soon ? `${label} (coming soon)` : label, 'aria-label': label,
      class: soon ? 'rail-btn soon' : 'rail-btn',
      on: { click: () => this.select(id) },
    }, content);
    const panel = el('section.panel', { role: 'tabpanel', hidden: true, 'aria-label': label });
    this.tabs.set(id, { button, panel, render, gmOnly, soon, label });
    // Package panels go just above Settings.
    const settings = this.tabs.get('settings')?.button;
    if (settings && id !== 'settings') this.rail.insertBefore(button, settings);
    else this.rail.append(button);
    this.rail.append(this.collapseBtn);
    this.panels.append(panel);
    this.refreshVisibility();
  }

  refreshVisibility() {
    for (const t of this.tabs.values()) t.button.hidden = t.gmOnly && !isGM();
    if (this.current && this.tabs.get(this.current)?.button.hidden) this.select('chat', { toggle: false });
  }

  /**
   * Show a panel. Clicking the icon of the panel that's already open folds the
   * sidebar away (`toggle`); `open: false` just switches without unfolding.
   */
  select(id, { toggle = true, open = true } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (tab.soon) { toast(`${tab.label} — coming soon.`); return; }
    if (toggle && id === this.current && !this.collapsed) {
      this.setCollapsed(true);
      return;
    }
    this.current = id;
    for (const [tid, t] of this.tabs) {
      t.button.setAttribute('aria-selected', String(tid === id));
      t.button.classList.toggle('active', tid === id);
      t.panel.hidden = tid !== id;
    }
    this.title.textContent = tab.label;
    if (open && this.collapsed) this.setCollapsed(false);
    else this.applyLayout();
    this.refresh(id);
  }

  setCollapsed(c) {
    this.collapsed = c;
    try { localStorage.setItem('hearth.sidebar.collapsed', c ? '1' : '0'); } catch { /* storage blocked */ }
    this.applyLayout();
    if (!c) {
      this.refresh(this.current);
      this.tabs.get(this.current)?.button.classList.remove('unread');
    }
  }

  /** Width of the right side the board should keep clear of. */
  get width() { return RAIL_W + (this.collapsed ? 0 : PANEL_W); }

  applyLayout() {
    this.root.classList.toggle('collapsed', this.collapsed);
    for (const [tid, t] of this.tabs) t.button.classList.toggle('active', tid === this.current && !this.collapsed);
    this.collapseBtn.replaceChildren(icon(this.collapsed ? 'chevron-left' : 'chevron-right'));
    this.collapseBtn.title = this.collapsed ? 'Show panel' : 'Hide panel';
    document.documentElement.style.setProperty('--sidebar-w', `${this.width}px`);
    hooks.emit('layout:change');
  }

  refresh(id = this.current) {
    const t = this.tabs.get(id);
    if (t?.render && store.world) t.render(t.panel, this.api);
  }

  refreshAll() {
    this.refreshVisibility();
    for (const id of this.tabs.keys()) this.refresh(id);
  }

  onOp(op) {
    const kind = op.op.split('_')[0];
    if (kind === 'chat') {
      if (op.op === 'chat_create' && this.log) {
        this.log.append(this.chatMessage(op.message));
        this.log.scrollTop = this.log.scrollHeight;
        if (this.current !== 'chat' || this.collapsed) this.tabs.get('chat').button.classList.add('unread');
      } else this.refresh('chat');
    }
    if (kind === 'actor' || kind === 'item' || kind === 'user') this.refresh('actors');
    if (kind === 'combat' || kind === 'combatant' || kind === 'token' || kind === 'actor' || kind === 'scene') this.refresh('combat');
    if (kind === 'scene') this.refresh('scenes');
    if (kind === 'playlist') this.refresh('playlists');
    if (kind === 'user' || kind === 'world') this.refresh('settings');
  }

  // ------------------------------------------------------------ chat

  renderChat(panel) {
    this.tabs.get('chat').button.classList.remove('unread');
    if (!this.log) {
      this.log = el('ol.chat-log', { 'aria-live': 'polite' });
      const input = el('textarea.chat-input', {
        rows: 2,
        placeholder: 'Chat, or /r 1d20+5 # Perception · /gmr · /w name msg',
        on: {
          keydown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const v = input.value.trim();
              if (v) this.api.chat(v);
              input.value = '';
            }
          },
        },
      });
      panel.append(this.log, this.chatControls, input);
    }
    this.log.replaceChildren(...store.world.chat.map((m) => this.chatMessage(m)));
    this.log.scrollTop = this.log.scrollHeight;
  }

  chatMessage(m) {
    const author = store.world.users[m.author];
    const speaker = m.speaker_actor ? store.world.actors[m.speaker_actor]?.name : null;
    const li = el('li.msg', { 'data-id': m.id },
      el('div.msg-head', {},
        el('strong', { text: speaker ?? m.author_name, style: `color:${author?.color ?? 'inherit'}` }),
        speaker ? el('span.muted', { text: ` (${m.author_name})` }) : null,
        m.whisper.length ? el('span.whisper', { text: ' whisper' }) : null,
        el('time.muted', { text: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })),
      m.flavor ? el('div.flavor', { text: m.flavor }) : null,
      // A table roll shows the dice, then the result it picked.
      m.flags?.core?.table ? null : m.content ? el('div.msg-body', { text: m.content }) : null,
      m.roll ? this.rollCard(m.roll) : null,
      m.flags?.core?.table && m.content ? el('div.msg-body.table-result', { text: m.content }) : null);
    hooks.emit('chat:render', li, m);
    return li;
  }

  rollCard(r) {
    const dice = r.groups.flatMap((g) => g.dice.map((d) => {
      const cls = ['die'];
      if (!d.kept) cls.push('dropped');
      if (g.sides > 1 && d.value === g.sides) cls.push('max');
      if (g.sides > 1 && d.value === 1) cls.push('min');
      return el(`span.${cls.join('.')}`, { text: d.value, title: `d${g.sides || 'F'}` });
    }));
    return el('div.roll', {},
      el('div.roll-formula', { text: r.formula }),
      el('div.roll-dice', {}, ...dice),
      el('div.roll-detail.muted', { text: r.rendered }),
      el('div.roll-total', { text: r.total }));
  }

  // ------------------------------------------------------------ actors

  renderActors(panel) {
    const sys = systemInfo();
    const types = Object.entries(sys.actor_types ?? {});
    const actors = Object.values(store.world.actors).sort((a, b) => a.name.localeCompare(b.name));
    const list = el('ul.entity-list');
    for (const a of actors) {
      const mine = a.owners.includes(store.user.id);
      list.append(el('li.entity', {
        draggable: isGM(),
        on: {
          dragstart: (e) => e.dataTransfer.setData('application/x-hearth-actor', a.id),
          click: () => this.api.sheets.open(a.id),
        },
      },
      a.img ? el('img.avatar', { src: a.img, alt: '' }) : el('span.avatar', { text: a.name.charAt(0).toUpperCase() }),
      el('span.grow', {}, el('span', { text: a.name }), el('small.muted', { text: ` ${sys.actor_types?.[a.kind]?.label ?? a.kind}` })),
      mine ? el('span.badge', { text: 'yours' }) : null,
      isGM() ? el('button.icon', {
        title: 'Delete actor', text: '🗑',
        on: { click: (e) => { e.stopPropagation(); if (confirm(`Delete ${a.name}?`)) this.api.op({ op: 'actor_delete', id: a.id }); } },
      }) : null));
    }
    const children = [];
    if (isGM()) {
      children.push(el('div.row', {}, el('button.primary', {
        text: '+ New actor',
        on: {
          click: async () => {
            const res = await formDialog({
              title: 'New actor',
              fields: [
                { name: 'name', label: 'Name', required: true },
                { name: 'kind', label: 'Type', type: 'select', options: types.length ? types.map(([k, d]) => [k, d.label]) : [['character', 'Character']] },
              ],
              submit: 'Create',
            });
            if (res) this.api.create.actor(res.kind, res.name);
          },
        },
      })), el('p.hint.muted', { text: 'Drag an actor onto the board to place a token (hold Alt to place it hidden).' }));
    }
    if (!actors.length) children.push(el('p.muted', { text: 'No actors yet.' }));
    panel.replaceChildren(...children, list);
  }

  // ------------------------------------------------------------ combat

  renderCombat(panel) {
    const w = store.world;
    const c = w.combat;
    const gm = isGM();
    const api = this.api;
    const op = (o) => api.op(o);

    if (!c) {
      panel.replaceChildren(...[
        el('p.muted', { text: gm ? 'No combat is running.' : 'No combat right now.' }),
        gm ? el('div.row', {},
          el('button.primary', {
            text: 'Start combat',
            title: 'Create an encounter on the scene you are viewing',
            on: { click: () => this.startCombat(false) },
          }),
          el('button', { text: 'Start with all tokens', on: { click: () => this.startCombat(true) } })) : null,
        gm ? el('p.hint.muted', { text: 'Select tokens on the board (shift-click for several) and use "Add selected", or start with every token on the scene.' }) : null,
      ].filter(Boolean));
      return;
    }

    const scene = w.scenes[c.scene_id];
    const order = combatOrder(c);
    const started = c.round > 0;
    const owns = (x) => !!x.actor_id && ownsActor(x.actor_id);
    const current = c.combatants.find((x) => x.id === c.current);
    const myTurn = started && current && !gm && owns(current);

    const header = el('div.combat-head', {},
      el('div', {},
        el('strong', { text: started ? `Round ${c.round}` : 'Not started' }),
        el('div.muted.small', { text: scene ? scene.name : 'Scene removed' })),
      started && current ? el('div.combat-now', {}, el('span.muted.small', { text: 'Turn: ' }), el('strong', { text: current.name })) : null);

    const controls = [];
    if (gm) {
      controls.push(el('div.row.combat-controls', {},
        el('button', { text: '+ Selected', title: 'Add the tokens selected on the board (shift-click for several)', on: { click: () => this.addSelected() } }),
        el('button', {
          text: '🎲 NPCs', title: 'Roll initiative for combatants no player owns',
          on: { click: () => this.rollInitiative(order.filter((x) => x.initiative == null && !this.playerOwned(x)).map((x) => x.id)) },
        }),
        el('button', {
          text: '🎲 All', title: 'Roll initiative for everyone who hasn\'t rolled',
          on: { click: () => this.rollInitiative(order.filter((x) => x.initiative == null).map((x) => x.id)) },
        })));
      controls.push(el('div.row.combat-controls', {},
        started
          ? [el('button', { text: '◀ Prev', on: { click: () => op({ op: 'combat_prev' }) } }),
            el('button.primary', { text: 'Next turn ▶', on: { click: () => op({ op: 'combat_next' }) } })]
          : el('button.primary', { text: 'Begin combat', disabled: !c.combatants.length, on: { click: () => op({ op: 'combat_start' }) } }),
        el('button.danger', { text: 'End', title: 'End this combat', on: { click: () => { if (confirm('End this combat?')) op({ op: 'combat_end' }); } } })));
    }
    if (myTurn) {
      controls.push(el('div.row', {}, el('button.primary', { text: 'End my turn', on: { click: () => op({ op: 'combat_next' }) } })));
    }

    const list = el('ol.combat-list');
    for (const x of order) {
      const isCurrent = started && x.id === c.current;
      const canRoll = gm || owns(x);
      const initCell = x.initiative != null
        ? (gm
          ? el('input.init-input', {
            type: 'number', value: x.initiative, step: 'any', title: 'Initiative (edit to change)',
            on: { change: (e) => op({ op: 'combatant_update', id: x.id, patch: { initiative: e.target.value === '' ? null : Number(e.target.value) } }) },
          })
          : el('span.init', { text: x.initiative }))
        : canRoll
          ? el('button.icon.roll-init', { title: 'Roll initiative', text: '🎲', on: { click: (e) => { e.stopPropagation(); this.rollInitiative([x.id]); } } })
          : el('span.init.muted', { text: '–' });
      const avatar = x.img ? el('img.avatar', { src: x.img, alt: '' }) : el('span.avatar', { text: (x.name || '?').charAt(0).toUpperCase() });
      list.append(el(`li.combatant${isCurrent ? '.current' : ''}${x.defeated ? '.defeated' : ''}${x.hidden ? '.hidden-c' : ''}`, {
        title: 'Click to show this token',
        on: { click: () => { if (x.token_id && c.scene_id === api.board.sceneId) api.board.focusToken(x.token_id); } },
      },
      avatar,
      el('span.grow', {}, el('span', { text: x.name }),
        x.hidden ? el('small.muted', { text: ' (hidden)' }) : null,
        owns(x) && !gm ? el('span.badge', { text: 'yours' }) : null),
      gm ? el('span.combat-actions', {},
        el('button.icon', {
          title: x.defeated ? 'Mark as not defeated' : 'Mark defeated (skipped in turns)', text: x.defeated ? '♥' : '☠',
          on: { click: (e) => { e.stopPropagation(); op({ op: 'combatant_update', id: x.id, patch: { defeated: !x.defeated } }); } },
        }),
        el('button.icon', {
          title: x.hidden ? 'Reveal to players' : 'Hide from players', text: x.hidden ? '👁' : '🙈',
          on: { click: (e) => { e.stopPropagation(); op({ op: 'combatant_update', id: x.id, patch: { hidden: !x.hidden } }); } },
        }),
        el('button.icon', { title: 'Remove from combat', text: '✕', on: { click: (e) => { e.stopPropagation(); op({ op: 'combatant_remove', id: x.id }); } } })) : null,
      initCell));
    }

    panel.replaceChildren(header, ...controls,
      order.length ? list : el('p.muted', { text: gm ? 'No combatants yet. Select tokens and press "Add selected".' : 'Waiting for the GM to add combatants.' }));
  }

  /** True when a non-GM user owns the combatant's actor. */
  playerOwned(x) {
    const a = x.actor_id && store.world.actors[x.actor_id];
    return !!a && a.owners.some((id) => store.world.users[id]?.role !== 'gm');
  }

  startCombat(withAll) {
    const sceneId = this.api.board.sceneId;
    const scene = store.world.scenes[sceneId];
    if (!scene) { toast('Open a scene first.', 'error'); return; }
    const tokens = withAll ? Object.values(scene.tokens) : [...this.api.board.selected].map((id) => scene.tokens[id]).filter(Boolean);
    this.api.op({
      op: 'combat_create',
      combat: { id: '', scene_id: sceneId, combatants: tokens.map((t) => ({ id: '', token_id: t.id })) },
    });
    this.select('combat', { toggle: false });
  }

  addSelected() {
    const c = store.world.combat;
    const scene = store.world.scenes[c.scene_id];
    if (this.api.board.sceneId !== c.scene_id) { toast('Switch to the combat\'s scene to add its tokens.', 'error'); return; }
    const already = new Set(c.combatants.map((x) => x.token_id));
    const ids = [...this.api.board.selected].filter((id) => scene?.tokens[id] && !already.has(id));
    if (!ids.length) { toast('Select tokens on the board first (shift-click for several).'); return; }
    for (const id of ids) this.api.op({ op: 'combatant_add', combatant: { id: '', token_id: id } });
  }

  rollInitiative(ids) {
    if (!ids.length) { toast('Nobody left to roll for.'); return; }
    this.api.combat.rollInitiative(ids);
  }

  // ------------------------------------------------------------ scenes

  renderScenes(panel) {
    if (!isGM()) { panel.replaceChildren(); return; }
    const list = el('ul.entity-list');
    for (const s of Object.values(store.world.scenes)) {
      const active = store.world.active_scene === s.id;
      const viewing = this.api.board.sceneId === s.id;
      list.append(el('li.entity', {},
        el('span.grow', {}, el('span', { text: s.name }), active ? el('span.badge', { text: 'active' }) : null,
          viewing ? el('small.muted', { text: ' viewing' }) : null),
        el('button', { text: 'View', on: { click: () => { this.api.board.view(s.id); this.refresh('scenes'); } } }),
        active ? null : el('button', { text: 'Activate', title: 'Move all players to this scene', on: { click: () => this.api.op({ op: 'scene_activate', id: s.id }) } }),
        el('button.icon', { title: 'Configure', text: '⚙', on: { click: () => this.configureScene(s.id) } })));
    }
    panel.replaceChildren(el('div.row', {}, el('button.primary', {
      text: '+ New scene',
      on: {
        click: async () => {
          const res = await formDialog({
            title: 'New scene',
            fields: [
              { name: 'name', label: 'Name', required: true },
              { name: 'cols', label: 'Columns', type: 'number', value: 30, min: 1 },
              { name: 'rows', label: 'Rows', type: 'number', value: 20, min: 1 },
              { name: 'size', label: 'Grid size (px)', type: 'number', value: 70, min: 10 },
            ],
            submit: 'Create',
          });
          if (!res) return;
          this.api.op({
            op: 'scene_create',
            scene: {
              id: '', name: res.name, width: res.cols * res.size, height: res.rows * res.size,
              grid: { kind: 'square', size: res.size }, tokens: {},
            },
          });
        },
      },
    })), list);
  }

  configureScene(id) {
    const s = store.world.scenes[id];
    const win = openWindow({ id: `scene-${id}`, title: `Scene: ${s.name}`, width: 380 });
    const g = s.grid;
    const form = el('form.form', {},
      el('label', {}, 'Name', el('input', { name: 'name', value: s.name })),
      el('div.row', {},
        el('label', {}, 'Columns', el('input', { name: 'cols', type: 'number', value: Math.round(s.width / g.size), min: 1 })),
        el('label', {}, 'Rows', el('input', { name: 'rows', type: 'number', value: Math.round(s.height / g.size), min: 1 }))),
      el('div.row', {},
        el('label', {}, 'Grid px', el('input', { name: 'size', type: 'number', value: g.size, min: 10 })),
        el('label', {}, 'Cell distance', el('input', { name: 'distance', type: 'number', value: g.distance, step: 'any' })),
        el('label', {}, 'Units', el('input', { name: 'units', value: g.units }))),
      el('label', {}, 'Grid', el('select', { name: 'kind' },
        el('option', { value: 'square', text: 'Square', selected: g.kind === 'square' }),
        el('option', { value: 'none', text: 'None', selected: g.kind === 'none' }))),
      el('label', {}, 'Background colour', el('input', { name: 'background_color', type: 'color', value: s.background_color })),
      el('label', {}, 'Background image', el('input', { name: 'file', type: 'file', accept: 'image/*' })),
      el('fieldset.auto', {},
        el('legend', { text: 'Vision' }),
        el('label.check', {}, el('input', { name: 'vision_enabled', type: 'checkbox', checked: !!s.vision?.enabled }),
          'Players see only what their tokens can see'),
        el('label.check', {}, el('input', { name: 'vision_fog', type: 'checkbox', checked: !!s.vision?.fog }),
          'Fog of war: remember explored areas'),
        el('label', {}, `Sight range in ${g.units || 'units'} (0 = unlimited)`,
          el('input', { name: 'vision_range', type: 'number', min: 0, step: 'any', value: s.vision?.range ?? 0 })),
        el('label', {}, 'Darkness: 0 = daylight, 1 = night (at 0.5 or more, tokens see only lit areas and their darkvision)',
          el('input', { name: 'darkness', type: 'range', min: 0, max: 1, step: 0.05, value: s.darkness ?? 0 })),
        el('div.row', {},
          el('button', {
            type: 'button', text: 'Reset fog',
            title: 'Forget what every player has explored on this scene',
            on: { click: () => { if (confirm('Reset the fog of war for every player on this scene?')) { this.api.op({ op: 'fog_reset', scene_id: id }); toast('Fog reset.'); } } },
          }),
          el('span.muted.small', { text: `${Object.keys(s.walls ?? {}).length} walls/doors` }))),
      el('div.row', {},
        el('button.primary', { type: 'submit', text: 'Save' }),
        el('button.danger', {
          type: 'button', text: 'Delete scene',
          on: { click: () => { if (confirm(`Delete ${s.name}?`)) { this.api.op({ op: 'scene_delete', id }); win.close(); } } },
        })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = form.elements;
      const size = Number(f.size.value);
      const patch = {
        name: f.name.value,
        width: Number(f.cols.value) * size,
        height: Number(f.rows.value) * size,
        background_color: f.background_color.value,
        grid: { kind: f.kind.value, size, distance: Number(f.distance.value), units: f.units.value },
        vision: {
          enabled: f.vision_enabled.checked,
          fog: f.vision_fog.checked,
          range: Math.max(0, Number(f.vision_range.value) || 0),
        },
        darkness: Number(f.darkness.value) || 0,
      };
      if (f.file.files[0]) {
        try { patch.background = await this.api.upload(f.file.files[0]); }
        catch (err) { toast(err.message, 'error'); return; }
      }
      this.api.update.scene(id, patch);
      win.close();
    });
    win.body.append(form);
  }

  // ------------------------------------------------------------ settings

  renderSettings(panel) {
    const w = store.world;
    const online = new Set(store.online);
    const users = Object.values(w.users).sort((a, b) => a.name.localeCompare(b.name));
    const gm = isGM();
    const userRow = (u) => {
      const me = u.id === store.user.id;
      const actions = gm ? el('span.user-actions', {},
        el('button.icon', { title: 'Reset password', text: '🔑', on: { click: () => this.resetPassword(u) } }),
        me ? null : el('button.icon', {
          title: u.role === 'gm' ? 'Make player' : 'Make GM', text: u.role === 'gm' ? '⬇' : '⬆',
          on: { click: () => this.api.admin.updateUser(u.id, { role: u.role === 'gm' ? 'player' : 'gm' }) },
        }),
        me ? null : el('button.icon', {
          title: 'Remove player', text: '🗑',
          on: { click: () => { if (confirm(`Remove ${u.name}? They won't be able to log in, and lose ownership of their actors.`)) this.api.admin.deleteUser(u.id); } },
        })) : null;
      return el('li', {},
        el('span.dot', { style: `background:${online.has(u.id) ? u.color : 'transparent'};border-color:${u.color}`, title: online.has(u.id) ? 'Online' : 'Offline' }),
        el('span.grow', {}, el('span', { text: u.name }), u.role === 'gm' ? el('span.badge', { text: 'GM' }) : null,
          me ? el('small.muted', { text: ' (you)' }) : null),
        actions);
    };
    const parts = [
      el('h3', { text: w.name }),
      el('p.muted', { text: `System: ${systemInfo().name ?? w.system}` }),
      w.next_session ? el('p.muted', { text: `Next session: ${new Date(w.next_session).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` }) : null,
      el('h4', { text: 'Players' }),
      el('ul.users', {}, ...users.map(userRow)),
      gm ? el('div.row', {}, el('button.primary', { text: '+ Add player', on: { click: () => this.addPlayer() } }),
        el('button', { text: 'Game details…', on: { click: () => this.editDetails() } })) : null,
      gm ? el('p.hint.muted', { text: 'Players log in by picking their name and entering the password you give them; they choose their own on first login.' }) : null,
    ].filter(Boolean);

    if (gm) {
      const themes = store.packages.available.filter((p) => p.type === 'theme');
      const modules = store.packages.available.filter((p) => p.type === 'module' && (!p.systems.length || p.systems.includes(w.system)));
      parts.push(
        el('h4', { text: 'Theme' }),
        el('select', {
          on: { change: (e) => this.api.op({ op: 'world_update', patch: { theme: e.target.value || null } }) },
        }, el('option', { value: '', text: 'Hearth (default)' }),
        ...themes.map((t) => el('option', { value: t.id, text: t.name, selected: w.theme === t.id }))),
        el('h4', { text: 'Modules' }),
        modules.length ? el('ul.modules', {}, ...modules.map((m) => el('li', {}, el('label.check', {},
          el('input', {
            type: 'checkbox', checked: w.modules.includes(m.id),
            on: {
              change: (e) => {
                const mods = e.target.checked ? [...w.modules, m.id] : w.modules.filter((x) => x !== m.id);
                this.api.op({ op: 'world_update', patch: { modules: mods } });
              },
            },
          }),
          el('span', {}, el('strong', { text: m.name }), el('small.muted', { text: ` v${m.version}` }),
            m.description ? el('div.muted', { text: m.description }) : null))))) : el('p.muted', { text: 'No modules installed.' }),
        el('p.hint.muted', { text: 'Changing the theme or modules reloads every connected client.' }),
      );
    }
    parts.push(el('div.row', {},
      el('button', { text: 'Change my password', on: { click: () => this.api.changePassword?.() } }),
      el('button', { text: 'Leave world', on: { click: () => this.api.leave() } })));
    panel.replaceChildren(...parts);
  }

  async addPlayer() {
    const res = await formDialog({
      title: 'Add a player',
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'role', label: 'Role', type: 'select', options: [['player', 'Player'], ['gm', 'Game master']], value: 'player' },
        { name: 'password', label: 'Temporary password (they change it on first login; leave empty to let them pick one)', type: 'text' },
      ],
      submit: 'Add',
    });
    if (res) this.api.admin.createUser(res.name.trim(), res.role, res.password);
  }

  async resetPassword(u) {
    const res = await formDialog({
      title: `Reset ${u.name}'s password`,
      fields: [{ name: 'password', label: 'Temporary password (at least 4 characters)', type: 'text', required: true }],
      submit: 'Reset',
    });
    if (res) this.api.admin.resetPassword(u.id, res.password);
  }

  editDetails() {
    const w = store.world;
    const win = openWindow({ id: 'game-details', title: 'Game details', width: 460 });
    const desc = el('textarea', { name: 'description', rows: 8, maxlength: 2000 });
    desc.value = w.description ?? '';
    const form = el('form.form', {},
      el('label', {}, 'Next session', el('input', { name: 'next', type: 'datetime-local', value: w.next_session ?? '' })),
      el('label', {}, 'World description (shown on the join page)', desc),
      el('div.row', {},
        el('button.primary', { type: 'submit', text: 'Save' }),
        el('button', { type: 'button', text: 'Clear date', on: { click: () => { form.elements.next.value = ''; } } })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.api.update.world({ description: desc.value.trim(), next_session: form.elements.next.value || null });
      win.close();
      toast('Game details saved.');
    });
    win.body.append(form);
  }
}
