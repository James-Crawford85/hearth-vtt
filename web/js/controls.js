// The left control palette: a column of tool groups (Tokens, Drawings,
// Walls, Lighting, Sounds) and, beside it, the active group's tools. The
// tools column collapses to give the scene more room.
//
// Tool kinds:
//   board   – a board mode (only one active per group)
//   type    – a radio choice inside a group (e.g. which kind of wall to draw)
//   action  – a one-shot button
// `soon: true` shows the tool greyed out until it's built.

import { hooks } from './hooks.js';
import { isGM } from './store.js';
import { el, toast } from './ui.js';
import { icon } from './icons.js';
import { animatedMaps, setAnimatedMaps } from './media.js';

const SOON = 'Coming soon';

function groups(api) {
  const board = api.board;
  const sceneId = () => board.sceneId;
  return [
    {
      id: 'token', icon: 'token', label: 'Token controls',
      tools: [
        { id: 'select', kind: 'board', icon: 'select', label: 'Select and move tokens', mode: 'select' },
        { id: 'box-select', kind: 'board', icon: 'box-select', label: 'Box selection: drag a rectangle to select tokens (Shift adds)', mode: 'box-select' },
        { id: 'target', kind: 'board', icon: 'target', label: 'Target: click tokens to target them (Shift adds; click empty space to clear)', mode: 'target' },
        { id: 'measure', kind: 'board', icon: 'ruler', label: 'Measure distance (also Ctrl-drag anywhere)', mode: 'measure' },
        {
          id: 'animated-maps', kind: 'toggle', icon: 'film',
          label: 'Animated maps: play video maps (off shows a still frame, easier on slower computers)',
          get: () => animatedMaps(),
          set: (on) => { setAnimatedMaps(on); board.invalidate(); toast(on ? 'Animated maps play.' : 'Animated maps paused on a still frame.'); },
        },
        { id: 'grid-align', kind: 'board', icon: 'grid-align', gmOnly: true, label: 'Align the map to the grid: drag from one grid corner across a block of squares (3 × 3 to start)', mode: 'grid-align' },
        {
          id: 'unconstrained', kind: 'toggle', icon: 'unconstrained', gmOnly: true,
          label: 'Unconstrained movement: move tokens through walls, off the grid',
          get: () => board.unconstrained,
          set: (on) => { board.unconstrained = on; toast(on ? 'Unconstrained movement on: walls and grid ignored.' : 'Unconstrained movement off.'); },
        },
      ],
    },
    {
      id: 'drawing', icon: 'drawing', label: 'Drawing tools',
      tools: [
        { id: 'draw-select', kind: 'board', icon: 'select', label: 'Select drawings: drag to move, double-click to style, Delete removes', mode: 'draw-select' },
        { id: 'rect', kind: 'board', icon: 'rect', label: 'Rectangle (drag)', mode: 'draw-rect' },
        { id: 'ellipse', kind: 'board', icon: 'ellipse', label: 'Ellipse (drag)', mode: 'draw-ellipse' },
        { id: 'polygon', kind: 'board', icon: 'polygon', label: 'Polygon: click corners; click the first corner, double-click or Enter to finish; Esc cancels', mode: 'draw-polygon' },
        { id: 'freehand', kind: 'board', icon: 'freehand', label: 'Freehand (drag)', mode: 'draw-freehand' },
        { id: 'text', kind: 'board', icon: 'text', label: 'Text (click where it goes)', mode: 'draw-text' },
        { sep: '' },
        {
          id: 'drawings-clear', kind: 'action', icon: 'clear-all', danger: true,
          get label() { return isGM() ? 'Delete all drawings on this scene' : 'Delete all my drawings on this scene'; },
          run: () => {
            const mine = Object.values(board.scene?.drawings ?? {}).filter((d) => board.canEditDrawing(d));
            if (!mine.length) { toast('There are no drawings to delete.'); return; }
            if (!confirm(`Delete ${mine.length} drawing${mine.length > 1 ? 's' : ''}?`)) return;
            for (const d of mine) api.op({ op: 'drawing_delete', scene_id: sceneId(), id: d.id });
          },
        },
      ],
    },
    {
      id: 'walls', icon: 'walls', label: 'Wall controls', gmOnly: true,
      tools: [
        { id: 'wall-select', kind: 'board', icon: 'wall-select', label: 'Select walls (click a wall; Delete removes it)', mode: 'wall-select' },
        { id: 'wall-draw', kind: 'board', icon: 'wall-draw', label: 'Draw walls (drag; Shift = no snapping)', mode: 'wall-draw' },
        { sep: 'Type' },
        { id: 'wall-solid', kind: 'type', icon: 'wall-solid', label: 'Solid wall: blocks movement, sight and sound', wallType: 'wall' },
        { id: 'wall-terrain', kind: 'type', icon: 'wall-terrain', label: 'Terrain wall: blocks movement; blocks sight and sound only past a second terrain wall', wallType: 'terrain' },
        { id: 'wall-invisible', kind: 'type', icon: 'wall-invisible', label: 'Invisible wall: blocks movement only', wallType: 'invisible' },
        { id: 'wall-ethereal', kind: 'type', icon: 'wall-ethereal', label: 'Ethereal wall: blocks sight and sound, not movement', wallType: 'ethereal' },
        { id: 'door', kind: 'type', icon: 'door', label: 'Door: click its icon to open or close; right-click to lock', wallType: 'door' },
        { id: 'door-secret', kind: 'type', icon: 'door-secret', label: 'Secret door: a wall to players; only the GM can open it', wallType: 'secret_door' },
        { id: 'window', kind: 'type', icon: 'window', label: 'Window: blocks movement and sound, not sight', wallType: 'window' },
        { sep: '' },
        {
          id: 'doors-close', kind: 'action', icon: 'doors-close', label: 'Close all doors on this scene',
          run: () => {
            const doors = Object.values(board.scene?.walls ?? {}).filter((w) => (w.kind === 'door' || w.kind === 'secret_door') && w.open);
            for (const d of doors) api.op({ op: 'wall_update', scene_id: sceneId(), id: d.id, patch: { open: false } });
            toast(doors.length ? `Closed ${doors.length} door${doors.length > 1 ? 's' : ''}.` : 'All doors are already closed.');
          },
        },
        {
          id: 'walls-clear', kind: 'action', icon: 'clear-all', label: 'Delete all walls and doors on this scene', danger: true,
          run: () => {
            const walls = Object.values(board.scene?.walls ?? {});
            if (!walls.length) { toast('There are no walls on this scene.'); return; }
            if (!confirm(`Delete all ${walls.length} walls and doors on this scene?`)) return;
            for (const w of walls) api.op({ op: 'wall_delete', scene_id: sceneId(), id: w.id });
          },
        },
      ],
    },
    {
      id: 'lighting', icon: 'lighting', label: 'Lighting controls', gmOnly: true,
      tools: [
        { id: 'light-select', kind: 'board', icon: 'light-select', label: 'Select lights: drag to move, double-click to configure, right-click to switch on/off, Delete removes', mode: 'light-select' },
        { id: 'light-draw', kind: 'board', icon: 'light-draw', label: 'Place a light: click for a torch, or drag to set how far it reaches (Shift = no snapping)', mode: 'light-draw' },
        {
          id: 'daynight', kind: 'action', icon: 'daynight', label: 'Day / night transition',
          run: () => {
            const s = board.scene;
            if (!s) return;
            const night = (s.darkness ?? 0) < 0.5;
            api.update.scene(s.id, { darkness: night ? 1 : 0 });
            toast(night ? 'Night falls…' : 'Day breaks…');
          },
        },
        {
          id: 'fog-reset', kind: 'action', icon: 'fog', label: 'Reset fog of war on this scene',
          run: () => {
            if (!board.scene) return;
            if (!confirm('Reset the fog of war for every player on this scene?')) return;
            api.op({ op: 'fog_reset', scene_id: sceneId() });
            toast('Fog reset.');
          },
        },
        {
          id: 'lights-clear', kind: 'action', icon: 'clear-all', label: 'Delete all lights on this scene', danger: true,
          run: () => {
            const lights = Object.values(board.scene?.lights ?? {});
            if (!lights.length) { toast('There are no lights on this scene.'); return; }
            if (!confirm(`Delete all ${lights.length} light${lights.length > 1 ? 's' : ''} on this scene?`)) return;
            for (const l of lights) api.op({ op: 'light_delete', scene_id: sceneId(), id: l.id });
          },
        },
      ],
    },
    {
      id: 'sounds', icon: 'sounds', label: 'Ambient sounds', gmOnly: true,
      tools: [
        { id: 'sound-select', kind: 'board', icon: 'sound-select', label: 'Select sounds: drag to move, double-click to configure, right-click to switch on/off, Delete removes', mode: 'sound-select' },
        { id: 'sound-place', kind: 'board', icon: 'sound-place', label: 'Place an ambient sound: click where it plays', mode: 'sound-place' },
        {
          id: 'sound-preview', kind: 'toggle', icon: 'sound-preview',
          label: 'Preview: hear the map from the mouse pointer, as a token there would',
          get: () => !!api.audio?.preview,
          set: (on) => {
            if (!api.audio) return;
            const v = board.viewArea();
            api.audio.preview = on ? { x: board.cam.x + (v.left + v.width / 2) / board.cam.z, y: board.cam.y + (v.height / 2) / board.cam.z } : null;
            board.invalidate();
            toast(on ? 'Preview on: you hear from the mouse pointer.' : 'Preview off.');
          },
        },
        {
          id: 'sounds-clear', kind: 'action', icon: 'clear-all', label: 'Delete all ambient sounds on this scene', danger: true,
          run: () => {
            const sounds = Object.values(board.scene?.sounds ?? {});
            if (!sounds.length) { toast('There are no ambient sounds on this scene.'); return; }
            if (!confirm(`Delete all ${sounds.length} ambient sound${sounds.length > 1 ? 's' : ''} on this scene?`)) return;
            for (const x of sounds) api.op({ op: 'sound_delete', scene_id: sceneId(), id: x.id });
          },
        },
      ],
    },
    { id: 'modules', icon: 'modules', label: 'Module tools', tools: [] },
  ];
}

export class Controls {
  constructor(api) {
    this.api = api;
    this.groups = groups(api);
    this.group = 'token';
    this.mode = { token: 'select', drawing: 'draw-rect', walls: 'wall-draw', lighting: 'light-draw', sounds: 'sound-select' }; // last board mode per group
    this.wallType = 'wall';
    let collapsed = false;
    try { collapsed = localStorage.getItem('hearth.controls.collapsed') === '1'; } catch { /* storage blocked */ }
    this.collapsed = collapsed;

    this.root = el('nav.controls', { 'aria-label': 'Tools' });
    this.groupCol = el('div.control-groups');
    this.toolCol = el('div.control-tools');
    this.root.append(this.groupCol, this.toolCol);
    document.getElementById('app').append(this.root);

    // Keep highlights right when the board changes mode by itself (e.g. Esc).
    hooks.on('board:tool', (mode) => {
      const g = this.groupForMode(mode);
      if (g && g !== this.group) this.group = g;
      if (g) this.mode[g] = mode;
      this.render();
    });
    this.render();
  }

  groupForMode(mode) {
    return this.groups.find((g) => g.tools.some((t) => t.mode === mode))?.id ?? null;
  }

  visibleGroups() {
    const gm = isGM();
    return this.groups.filter((g) => (!g.gmOnly || gm) && (g.id !== 'modules' || g.tools.length));
  }

  selectGroup(id) {
    if (this.group === id && !this.collapsed) {
      this.setCollapsed(true);
      return;
    }
    this.group = id;
    this.setCollapsed(false);
    // Switch the board to this group's mode (or plain select for groups without one).
    const g = this.groups.find((x) => x.id === id);
    const mode = this.mode[id] ?? g.tools.find((t) => t.kind === 'board' && t.mode && !t.soon)?.mode ?? 'select';
    if (this.api.board.tool !== mode) this.api.board.setTool(mode);
    else this.render();
  }

  setCollapsed(c) {
    this.collapsed = c;
    try { localStorage.setItem('hearth.controls.collapsed', c ? '1' : '0'); } catch { /* storage blocked */ }
    this.render();
  }

  useTool(t) {
    if (t.soon) { toast(`${t.label} — coming soon.`); return; }
    if (t.kind === 'board') {
      this.api.board.setTool(t.mode);
    } else if (t.kind === 'type') {
      this.wallType = t.wallType;
      this.api.board.wallType = t.wallType;
      if (this.api.board.tool !== 'wall-draw') this.api.board.setTool('wall-draw');
      else this.render();
    } else if (t.kind === 'action') {
      t.run?.();
    } else if (t.kind === 'toggle') {
      t.set(!t.get());
      this.render();
    }
  }

  /** Modules add tools here (hearth.ui.addTool). Returns the button. */
  addModuleTool({ icon: glyph, title, onClick, gmOnly = false }) {
    const tool = { id: `mod-${this.groups.at(-1).tools.length}`, kind: 'action', glyph, label: title, gmOnly, run: onClick };
    this.groups.at(-1).tools.push(tool);
    this.render();
    return tool;
  }

  render() {
    const gm = isGM();
    const groups = this.visibleGroups();
    if (!groups.some((g) => g.id === this.group)) this.group = 'token';

    this.groupCol.replaceChildren(
      ...groups.map((g) => el('button.ctl', {
        title: g.label, 'aria-label': g.label, 'aria-pressed': String(g.id === this.group),
        class: g.id === this.group ? 'ctl active' : 'ctl',
        on: { click: () => this.selectGroup(g.id) },
      }, icon(g.icon))),
      el('div.ctl-spacer'),
      el('button.ctl.ctl-collapse', {
        title: this.collapsed ? 'Show tools' : 'Hide tools', 'aria-label': this.collapsed ? 'Show tools' : 'Hide tools',
        on: { click: () => this.setCollapsed(!this.collapsed) },
      }, icon(this.collapsed ? 'chevron-right' : 'chevron-left')),
    );

    const g = groups.find((x) => x.id === this.group);
    this.toolCol.hidden = this.collapsed || !g;
    // Tell the board and centred overlays how much of the left edge is covered.
    requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--controls-w', `${this.root.getBoundingClientRect().width + 8}px`);
    });
    if (!g) return;
    const board = this.api.board;
    const items = [el('div.ctl-title', { text: g.label })];
    for (const t of g.tools) {
      if (t.sep !== undefined) { items.push(el('div.ctl-sep', { text: t.sep })); continue; }
      if (t.gmOnly && !gm) continue;
      const active = (t.kind === 'board' && board.tool === t.mode)
        || (t.kind === 'type' && board.tool === 'wall-draw' && this.wallType === t.wallType)
        || (t.kind === 'toggle' && t.get());
      const cls = ['ctl', active ? 'active' : '', t.soon ? 'soon' : '', t.danger ? 'danger' : ''].filter(Boolean).join(' ');
      items.push(el('button', {
        class: cls,
        title: t.soon ? `${t.label} (${SOON})` : t.label,
        'aria-label': t.label,
        'aria-disabled': t.soon ? 'true' : null,
        on: { click: () => this.useTool(t) },
      }, t.glyph ? el('span.ctl-glyph', { text: t.glyph }) : icon(t.icon)));
    }
    this.toolCol.replaceChildren(...items);
  }

  /** Call when the user's role changes. */
  refresh() {
    const t = this.api.board.tool;
    if (!isGM() && (t.startsWith('wall') || t.startsWith('light') || t.startsWith('sound'))) this.api.board.setTool('select');
    this.render();
  }
}

