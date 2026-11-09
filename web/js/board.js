// The game board: a 2D canvas with pan/zoom, grid, background, tokens,
// a measuring ruler and pings.
//
// Controls
//   Left-drag token .......... move (snaps to grid)
//   Left-drag empty .......... pan        Right/middle-drag ... pan
//   Wheel .................... zoom       Ctrl/⌘-drag ......... measure
//   Double-click token ....... open sheet Double-click empty .. ping
//   Delete ................... delete selected tokens (GM)
//   H ........................ hide/show selected tokens (GM)
//   Arrow keys ............... nudge selected tokens one cell
//   Click a door icon ........ open/close   Right-click (GM) .... lock/unlock
//
// GM tools (left toolbar): Select, Walls, Doors. With Walls/Doors, drag to
// draw (ends snap to grid corners and existing wall ends; Shift = no snap),
// click a wall to select it, Delete removes it, Esc goes back to Select.
//
// Vision (per scene): players see only what their tokens can see; walls and
// closed doors block sight and movement; with fog, explored areas stay dim.
//
// Hooks
//   board:drawBackground (ctx, scene, board)
//   board:drawToken      (ctx, token, actor, rect, board)  – after a token is drawn
//   board:drawOverlay    (ctx, scene, board)               – in world space, above tokens
//   board:tokenMove      (token, {x, y})                   – return false to block

import { hooks } from './hooks.js';
import { store, isGM, ownsActor } from './store.js';
import { segmentsCross, visibilityPolygon, sees, pointInPolygon, wallRules, bitsToBase64, base64ToBits } from './vision.js';
import { toast, formDialog } from './ui.js';
import { soundDialog } from './audio.js';
import { drawDrawing, drawSelection, hitDrawing, simplify } from './drawings.js';

export class Board {
  constructor(canvas, api) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.api = api;
    this.sceneId = null;
    this.cam = { x: 0, y: 0, z: 1 };
    this.selected = new Set();
    this.images = new Map();
    this.pings = [];
    this.ruler = null;
    this.drag = null;
    this.dirty = true;
    this.tool = 'select';          // 'select' | 'measure' | 'wall-select' | 'wall-draw'
    this.wallType = 'wall';        // what 'wall-draw' draws: 'wall' | 'door'
    this.selectedWall = null;
    this.visionDirty = true;       // recompute line of sight before next draw
    this.sources = [];             // [{ origin, poly, radius }] for this player's tokens
    this.explored = null;          // { sceneId, cols, rows, cell, bits, canvas }
    this.exploreTimer = null;
    this.targets = new Map();      // user id → Set of targeted token ids
    this.unconstrained = false;    // GM: ignore walls and the grid when moving
    this.selectedDrawing = null;
    this.polyDraft = null;         // polygon being drawn: { pts: [[x, y]…], cursor }
    this.drawStyle = { stroke: null, stroke_width: 4, fill: null, fill_alpha: 0.2, font_size: 32 }; // stroke null = my colour
    this.fogCanvas = document.createElement('canvas');
    this.lightCanvas = document.createElement('canvas');
    this.lightSources = [];        // [{ origin, poly, bright, dim (px), color }] for lights and lit tokens
    this.shownDarkness = null;     // darkness as drawn; eases toward the scene's for day/night transitions
    this.lastFrame = 0;
    this.selectedLight = null;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    // Redraw when something changed, or every frame while something animates
    // (pings, the active-turn glow).
    const loop = () => { if (this.dirty || this.pings.length || this.animating) this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  get scene() { return store.world?.scenes[this.sceneId] ?? null; }
  get grid() { return this.scene?.grid?.size ?? 70; }
  invalidate() { this.dirty = true; }

  resize() {
    const dpr = devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.invalidate();
  }

  view(sceneId, { fit = true } = {}) {
    if (this.sceneId === sceneId && !fit) return;
    this.flushExplored();
    this.sceneId = sceneId;
    this.selected.clear();
    this.selectedWall = null;
    this.selectedLight = null;
    this.selectedSound = null;
    this.shownDarkness = null;
    this.visionDirty = true;
    this.loadExplored();
    if (fit) this.fit();
    hooks.emit('board:view', this.scene);
    this.invalidate();
  }

  /** The visible part of the board: screen minus the side bars (CSS pixels). */
  viewArea() {
    const r = this.canvas.getBoundingClientRect();
    const css = getComputedStyle(document.documentElement);
    const left = parseFloat(css.getPropertyValue('--controls-w')) || 0;
    const right = parseFloat(css.getPropertyValue('--sidebar-w')) || 0;
    const width = Math.max(120, r.width - left - right);
    return { left, width, height: r.height };
  }

  fit() {
    const s = this.scene;
    if (!s) return;
    const v = this.viewArea();
    const z = Math.min(v.width / s.width, v.height / s.height) * 0.92;
    this.cam.z = Math.max(0.1, Math.min(3, z || 1));
    this.cam.x = s.width / 2 - (v.left + v.width / 2) / this.cam.z;
    this.cam.y = s.height / 2 - (v.height / 2) / this.cam.z;
  }

  toWorld(sx, sy) { return { x: sx / this.cam.z + this.cam.x, y: sy / this.cam.z + this.cam.y }; }

  image(url) {
    if (!url) return null;
    let img = this.images.get(url);
    if (!img) {
      img = new Image();
      img.onload = () => this.invalidate();
      img.src = url;
      this.images.set(url, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  tokens() {
    const s = this.scene;
    return s ? Object.values(s.tokens) : [];
  }

  tokenRect(t) {
    const g = this.grid;
    return { x: t.x, y: t.y, w: (t.w || 1) * g, h: (t.h || 1) * g };
  }

  tokenAt(wx, wy) {
    const list = this.tokens();
    for (let i = list.length - 1; i >= 0; i--) {
      const r = this.tokenRect(list[i]);
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return list[i];
    }
    return null;
  }

  canMove(t) {
    return isGM() || (!!t.actor_id && ownsActor(t.actor_id) && !t.hidden);
  }

  snap(v) {
    if (this.scene?.grid?.kind === 'none') return Math.round(v);
    const g = this.grid;
    return Math.round(v / g) * g;
  }

  // ------------------------------------------------------------------ draw

  draw() {
    this.dirty = false;
    this.animating = false; // set again by anything that wants the next frame
    const { ctx, canvas } = this;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--board-bg') || '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = this.scene;
    if (!s) return;
    const z = this.cam.z * dpr;
    ctx.setTransform(z, 0, 0, z, -this.cam.x * z, -this.cam.y * z);

    ctx.fillStyle = s.background_color || '#1d1f24';
    ctx.fillRect(0, 0, s.width, s.height);
    const bg = this.image(s.background);
    if (bg) ctx.drawImage(bg, 0, 0, s.width, s.height);
    hooks.emit('board:drawBackground', ctx, s, this);

    if (s.grid?.kind !== 'none') this.drawGrid(s);
    this.drawDrawings(s);

    const limited = this.visionLimited();
    if (this.visionDirty) this.computeVision();
    this.drawLighting(s);
    for (const t of this.tokens()) {
      if (!limited || this.tokenVisible(t)) this.drawToken(t);
    }
    hooks.emit('board:drawOverlay', ctx, s, this);
    if (limited) this.drawFog(s);
    ctx.setTransform(z, 0, 0, z, -this.cam.x * z, -this.cam.y * z);
    if (isGM()) this.drawWalls(s);
    if (isGM() && this.tool.startsWith('light-')) this.drawLightIcons(s);
    if (isGM() && this.tool.startsWith('sound-')) this.drawSoundIcons(s);
    this.drawDoors(s, limited);
    this.drawSelectionBox();
    this.drawDraft();
    if (this.ruler) this.drawRuler();
    this.drawPings();
  }

  // ------------------------------------------------------------------ vision

  /** Is this user's view of the current scene limited by line of sight? */
  visionLimited() {
    return !isGM() && !!this.scene?.vision?.enabled;
  }

  /** Walls that affect sight, with terrain walls marked `limited`. */
  sightSegments() {
    const out = [];
    for (const w of Object.values(this.scene?.walls ?? {})) {
      const { sight } = wallRules(w);
      if (sight !== 'pass') out.push({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] }, limited: sight === 'limited' });
    }
    return out;
  }

  /** Walls that stop tokens moving through them. */
  moveSegments() {
    return Object.values(this.scene?.walls ?? {})
      .filter((w) => wallRules(w).move)
      .map((w) => ({ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] } }));
  }

  center(t) {
    const r = this.tokenRect(t);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /** Line of sight from every token this player owns on the scene. */
  computeVision() {
    const s = this.scene;
    this.visionDirty = false;
    const segs = this.sightSegments();
    const poly = (origin) => visibilityPolygon(origin, segs, s.width, s.height);
    // Light: placed lights that are on, and tokens carrying light.
    this.lightSources = [];
    for (const l of Object.values(s.lights ?? {})) {
      if (l.off) continue;
      const origin = { x: l.x, y: l.y };
      this.lightSources.push(this.lightSource(origin, poly(origin), l));
    }
    for (const t of this.tokens()) {
      if (!t.light || !(t.light.dim > 0 || t.light.bright > 0)) continue;
      const origin = this.center(t);
      this.lightSources.push(this.lightSource(origin, poly(origin), t.light));
    }
    if (!this.visionLimited()) { this.sources = []; return; }
    const range = Number(s.vision.range) || 0;
    const radius = range > 0 ? this.toPx(range) : Infinity;
    this.sources = this.tokens()
      .filter((t) => t.actor_id && ownsActor(t.actor_id) && !t.hidden)
      .map((t) => {
        const origin = this.center(t);
        // A token always sees its own square, even in the dark.
        const own = Math.max(t.w ?? 1, t.h ?? 1) * this.grid * 0.75;
        return { origin, poly: poly(origin), radius, sight: Math.max(own, this.toPx(t.sight || 0)) };
      });
    if (s.vision.fog) this.markExplored();
  }

  /** Scene distance units (e.g. feet) to pixels. */
  toPx(d) {
    const s = this.scene;
    return (Number(d) || 0) / (s?.grid?.distance || 5) * (s?.grid?.size ?? 70);
  }

  lightSource(origin, poly, l) {
    const dim = this.toPx(Math.max(l.dim || 0, l.bright || 0));
    return { origin, poly, bright: Math.min(this.toPx(l.bright || 0), dim), dim, color: l.color || null };
  }

  /** Is it dark enough that only lit areas (and darkvision) can be seen? */
  isDark() { return (this.scene?.darkness ?? 0) >= 0.5; }

  litAt(pt) {
    return this.lightSources.some((l) => {
      const dx = pt.x - l.origin.x, dy = pt.y - l.origin.y;
      return dx * dx + dy * dy <= l.dim * l.dim && pointInPolygon(pt, l.poly);
    });
  }

  /** Can this vision source see the point: in line of sight and range, and lit or within its own sight? */
  canSee(src, pt) {
    if (!sees(src, pt)) return false;
    if (!this.isDark()) return true;
    const dx = pt.x - src.origin.x, dy = pt.y - src.origin.y;
    return dx * dx + dy * dy <= src.sight * src.sight || this.litAt(pt);
  }

  /** Darkness over the map, with lit areas cut out and tinted. Drawn under tokens. */
  drawLighting(s) {
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const target = Math.max(0, Math.min(1, Number(s.darkness) || 0));
    if (this.shownDarkness == null) this.shownDarkness = target;
    if (this.shownDarkness !== target) {
      const step = dt / 2.5; // a full day↔night change takes 2.5 s
      const diff = target - this.shownDarkness;
      this.shownDarkness = Math.abs(diff) <= step ? target : this.shownDarkness + Math.sign(diff) * step;
      this.animating = true;
    }
    const dark = this.shownDarkness;
    const { ctx, canvas, lightCanvas } = this;
    const dpr = devicePixelRatio || 1;
    const z = this.cam.z * dpr;
    const shape = (c, l, alpha) => {
      c.save();
      c.beginPath();
      l.poly.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.clip();
      const g = c.createRadialGradient(l.origin.x, l.origin.y, 0, l.origin.x, l.origin.y, l.dim);
      const b = l.dim > 0 ? l.bright / l.dim : 1;
      g.addColorStop(0, alpha(1));
      g.addColorStop(Math.min(0.999, b), alpha(1));
      g.addColorStop(Math.min(1, b + (1 - b) * 0.5), alpha(0.55));
      g.addColorStop(1, alpha(0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(l.origin.x, l.origin.y, l.dim, 0, Math.PI * 2);
      c.fill();
      c.restore();
    };
    if (dark > 0.01) {
      if (lightCanvas.width !== canvas.width || lightCanvas.height !== canvas.height) {
        lightCanvas.width = canvas.width;
        lightCanvas.height = canvas.height;
      }
      const f = lightCanvas.getContext('2d');
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalCompositeOperation = 'source-over';
      f.clearRect(0, 0, lightCanvas.width, lightCanvas.height);
      f.setTransform(z, 0, 0, z, -this.cam.x * z, -this.cam.y * z);
      // The GM keeps a little more of the map visible so they can work.
      f.fillStyle = `rgba(4, 6, 18, ${dark * (isGM() ? 0.7 : 0.92)})`;
      f.fillRect(0, 0, s.width, s.height);
      f.globalCompositeOperation = 'destination-out';
      for (const l of this.lightSources) shape(f, l, (a) => `rgba(0, 0, 0, ${a})`);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(lightCanvas, 0, 0);
      ctx.restore();
    }
    // Coloured lights tint what they reach.
    const tinted = this.lightSources.filter((l) => l.color);
    if (tinted.length) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (const l of tinted) {
        const rgb = hexRgb(l.color);
        if (rgb) shape(ctx, l, (a) => `rgba(${rgb}, ${a * 0.35})`);
      }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ light tools (GM)

  /** The light whose icon is under a point. */
  lightAt(w) {
    const r = 16 / this.cam.z;
    let best = null, bestD = r;
    for (const l of Object.values(this.scene?.lights ?? {})) {
      const d = Math.hypot(l.x - w.x, l.y - w.y);
      if (d <= bestD) { best = l; bestD = d; }
    }
    return best;
  }

  drawLightIcons(s) {
    const ctx = this.ctx;
    const z = this.cam.z;
    const d = this.drag;
    for (const l of Object.values(s.lights ?? {})) {
      const moving = d?.kind === 'light-move' && d.id === l.id;
      const x = moving ? d.pos.x : l.x, y = moving ? d.pos.y : l.y;
      const sel = l.id === this.selectedLight;
      if (sel) {
        ctx.save();
        ctx.setLineDash([6 / z, 5 / z]);
        ctx.lineWidth = 1.5 / z;
        ctx.strokeStyle = 'rgba(255, 220, 140, 0.9)';
        for (const r of [l.bright, l.dim]) {
          if (!(r > 0)) continue;
          ctx.beginPath();
          ctx.arc(x, y, this.toPx(r), 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 11 / z, 0, Math.PI * 2);
      ctx.fillStyle = l.off ? 'rgba(30, 30, 36, 0.9)' : (l.color || '#ffd27a');
      ctx.fill();
      ctx.lineWidth = (sel ? 3 : 2) / z;
      ctx.strokeStyle = sel ? '#ffffff' : 'rgba(0, 0, 0, 0.8)';
      ctx.stroke();
      ctx.fillStyle = l.off ? '#888' : '#2a2000';
      ctx.font = `${13 / z}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✦', x, y + 0.5 / z);
      ctx.restore();
    }
    // A light being placed: its dim radius follows the mouse.
    if (d?.kind === 'light-new') {
      const r = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
      ctx.save();
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.lineWidth = 1.5 / z;
      ctx.strokeStyle = 'rgba(255, 220, 140, 0.9)';
      for (const rr of [r / 2, r]) {
        ctx.beginPath();
        ctx.arc(d.a.x, d.a.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Light settings (double-click a light, or right-click with Select lights). */
  async configureLight(l) {
    const units = this.scene?.grid?.units ?? 'ft';
    const v = await formDialog({
      title: 'Light',
      fields: [
        { name: 'bright', label: `Bright light radius (${units})`, type: 'number', value: l.bright, min: 0, step: 'any' },
        { name: 'dim', label: `Dim light radius (${units})`, type: 'number', value: l.dim, min: 0, step: 'any' },
        { name: 'tinted', label: 'Coloured light', type: 'checkbox', value: !!l.color },
        { name: 'color', label: 'Colour', type: 'color', value: l.color || '#ffb347' },
        { name: 'on', label: 'On', type: 'checkbox', value: !l.off },
      ],
    });
    if (!v || !this.scene?.lights?.[l.id]) return;
    const bright = Math.max(0, v.bright || 0);
    this.api.op({
      op: 'light_update', scene_id: this.sceneId, id: l.id,
      patch: { bright, dim: Math.max(bright, v.dim || 0), color: v.tinted ? v.color : null, off: !v.on },
    }, (why) => toast(why, 'error'));
  }

  // ------------------------------------------------------------------ ambient sounds (GM)

  soundAt(w) {
    const r = 16 / this.cam.z;
    let best = null, bestD = r;
    for (const x of Object.values(this.scene?.sounds ?? {})) {
      const d = Math.hypot(x.x - w.x, x.y - w.y);
      if (d <= bestD) { best = x; bestD = d; }
    }
    return best;
  }

  drawSoundIcons(s) {
    const ctx = this.ctx;
    const z = this.cam.z;
    const d = this.drag;
    for (const x of Object.values(s.sounds ?? {})) {
      const moving = d?.kind === 'sound-move' && d.id === x.id;
      const px = moving ? d.pos.x : x.x, py = moving ? d.pos.y : x.y;
      const sel = x.id === this.selectedSound;
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, this.toPx(x.radius), 0, Math.PI * 2);
      ctx.fillStyle = x.off ? 'rgba(120, 120, 130, 0.06)' : 'rgba(90, 170, 255, 0.08)';
      ctx.fill();
      ctx.setLineDash([6 / z, 5 / z]);
      ctx.lineWidth = (sel ? 2 : 1.2) / z;
      ctx.strokeStyle = x.off ? 'rgba(150, 150, 160, 0.6)' : 'rgba(110, 180, 255, 0.85)';
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(px, py, 11 / z, 0, Math.PI * 2);
      ctx.fillStyle = x.off ? 'rgba(30, 30, 36, 0.9)' : '#5aaaff';
      ctx.fill();
      ctx.lineWidth = (sel ? 3 : 2) / z;
      ctx.strokeStyle = sel ? '#ffffff' : 'rgba(0, 0, 0, 0.8)';
      ctx.stroke();
      ctx.fillStyle = x.off ? '#888' : '#06203a';
      ctx.font = `${13 / z}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♪', px, py + 0.5 / z);
      ctx.restore();
    }
    // Preview: where the GM is listening from.
    const pv = this.api.audio?.preview;
    if (pv) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(pv.x, pv.y, 8 / z, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2 / z;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Settings for an ambient sound; with no `x`, place a new one at `at`. */
  async configureSound(x, at = null) {
    const units = this.scene?.grid?.units ?? 'ft';
    const v = await soundDialog(this.api, {
      title: x ? 'Ambient sound' : 'New ambient sound',
      values: x ?? { src: '', radius: (this.scene.grid.distance || 5) * 6, volume: 0.8, walls: true, on: true },
      fields: [
        { name: 'radius', label: `Heard within (${units})`, type: 'number', min: 0, step: 'any' },
        { name: 'volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05 },
        { name: 'walls', label: 'Walls block it', type: 'checkbox' },
        { name: 'on', label: 'On', type: 'checkbox' },
      ].map((f) => f),
    });
    if (!v || !v.src) return;
    const fields = { src: v.src, radius: Math.max(0, v.radius || 0), volume: v.volume, walls: v.walls, off: !v.on };
    if (x) {
      if (this.scene?.sounds?.[x.id]) this.api.op({ op: 'sound_update', scene_id: this.sceneId, id: x.id, patch: fields }, (why) => toast(why, 'error'));
    } else {
      this.api.op({ op: 'sound_create', scene_id: this.sceneId, sound: { id: '', x: Math.round(at.x), y: Math.round(at.y), ...fields } }, (why) => toast(why, 'error'));
    }
  }

  /** Token settings: appearance, sight and the light it carries (GM; right-click a token). */
  async configureToken(t) {
    const units = this.scene?.grid?.units ?? 'ft';
    const v = await formDialog({
      title: `Token: ${t.name}`,
      fields: [
        { name: 'name', label: 'Name', value: t.name, required: true },
        { name: 'show_name', label: 'Show name', type: 'checkbox', value: t.show_name !== false },
        { name: 'size', label: 'Size (grid squares)', type: 'number', value: t.w ?? 1, min: 0.5, step: 0.5 },
        { name: 'color', label: 'Colour', type: 'color', value: t.color || '#5b8def' },
        { name: 'img', label: 'Image URL', value: t.img ?? '' },
        { name: 'hidden', label: 'Hidden from players', type: 'checkbox', value: !!t.hidden },
        { name: 'sight', label: `Sees in the dark to (${units}, darkvision)`, type: 'number', value: t.sight ?? 0, min: 0, step: 'any' },
        { name: 'bright', label: `Carries bright light (${units})`, type: 'number', value: t.light?.bright ?? 0, min: 0, step: 'any' },
        { name: 'dim', label: `…and dim light (${units})`, type: 'number', value: t.light?.dim ?? 0, min: 0, step: 'any' },
        { name: 'tinted', label: 'Coloured light', type: 'checkbox', value: !!t.light?.color },
        { name: 'lcolor', label: 'Light colour', type: 'color', value: t.light?.color || '#ffb347' },
      ],
    });
    if (!v || !this.scene?.tokens?.[t.id]) return;
    const bright = Math.max(0, v.bright || 0), dim = Math.max(bright, v.dim || 0);
    const size = Math.max(0.5, v.size || 1);
    this.api.update.token(this.sceneId, t.id, {
      name: v.name.trim() || t.name,
      show_name: v.show_name,
      w: size, h: size,
      color: v.color,
      img: v.img.trim() || null,
      hidden: v.hidden,
      sight: Math.max(0, v.sight || 0),
      light: dim > 0 ? { bright, dim, color: v.tinted ? v.lcolor : null } : null,
    }, (why) => toast(why, 'error'));
  }

  tokenVisible(t) {
    if (t.actor_id && ownsActor(t.actor_id)) return true;
    const c = this.center(t);
    return this.sources.some((src) => this.canSee(src, c));
  }

  /** Darkness everywhere except what's visible; explored areas only dimmed. */
  drawFog(s) {
    const { canvas, fogCanvas } = this;
    if (fogCanvas.width !== canvas.width || fogCanvas.height !== canvas.height) {
      fogCanvas.width = canvas.width;
      fogCanvas.height = canvas.height;
    }
    const f = fogCanvas.getContext('2d');
    const dpr = devicePixelRatio || 1;
    const z = this.cam.z * dpr;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.globalCompositeOperation = 'source-over';
    f.globalAlpha = 1;
    f.fillStyle = '#000';
    f.fillRect(0, 0, fogCanvas.width, fogCanvas.height);
    f.setTransform(z, 0, 0, z, -this.cam.x * z, -this.cam.y * z);
    f.globalCompositeOperation = 'destination-out';
    const ex = this.explored;
    if (s.vision.fog && ex?.sceneId === this.sceneId) {
      f.globalAlpha = 0.55; // explored but not in sight: dim
      f.imageSmoothingEnabled = true;
      f.drawImage(ex.canvas, 0, 0, ex.cols * ex.cell, ex.rows * ex.cell);
      f.globalAlpha = 1;
    }
    const dark = this.isDark();
    for (const src of this.sources) {
      f.save();
      if (Number.isFinite(src.radius)) {
        f.beginPath();
        f.arc(src.origin.x, src.origin.y, src.radius, 0, Math.PI * 2);
        f.clip();
      }
      f.beginPath();
      src.poly.forEach((p, i) => (i ? f.lineTo(p.x, p.y) : f.moveTo(p.x, p.y)));
      f.closePath();
      if (!dark) {
        f.fill();
      } else {
        // In the dark: only what this token's own sight reaches, plus lit areas.
        f.clip();
        f.beginPath();
        f.arc(src.origin.x, src.origin.y, src.sight, 0, Math.PI * 2);
        f.fill();
        for (const l of this.lightSources) {
          f.save();
          f.beginPath();
          l.poly.forEach((p, i) => (i ? f.lineTo(p.x, p.y) : f.moveTo(p.x, p.y)));
          f.closePath();
          f.clip();
          f.beginPath();
          f.arc(l.origin.x, l.origin.y, l.dim, 0, Math.PI * 2);
          f.fill();
          f.restore();
        }
      }
      f.restore();
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(fogCanvas, 0, 0);
  }

  // ------------------------------------------------------------------ fog memory

  /** Load this player's explored map for the current scene from the world. */
  loadExplored() {
    const s = this.scene;
    if (!s || !store.user) { this.explored = null; return; }
    const cell = (s.grid?.size ?? 70) / 2;
    const cols = Math.ceil(s.width / cell), rows = Math.ceil(s.height / cell);
    const saved = store.world.fog?.[s.id]?.[store.user.id];
    const bytes = Math.ceil((cols * rows) / 8);
    const bits = saved && saved.cols === cols && saved.rows === rows ? base64ToBits(saved.data, bytes) : new Uint8Array(bytes);
    const canvas = document.createElement('canvas');
    canvas.width = cols;
    canvas.height = rows;
    this.explored = { sceneId: s.id, cols, rows, cell, bits, canvas, pending: false };
    this.paintExplored();
  }

  paintExplored() {
    const ex = this.explored;
    const c = ex.canvas.getContext('2d');
    const img = c.createImageData(ex.cols, ex.rows);
    for (let i = 0; i < ex.cols * ex.rows; i++) {
      if (ex.bits[i >> 3] & (1 << (i & 7))) img.data.set([255, 255, 255, 255], i * 4);
    }
    c.putImageData(img, 0, 0);
  }

  /** Mark cells currently in sight as explored; send news to the server. */
  markExplored() {
    const ex = this.explored;
    if (!ex || ex.sceneId !== this.sceneId || !this.sources.length) return;
    let changed = false;
    for (let r = 0; r < ex.rows; r++) {
      for (let col = 0; col < ex.cols; col++) {
        const i = r * ex.cols + col;
        if (ex.bits[i >> 3] & (1 << (i & 7))) continue;
        const pt = { x: (col + 0.5) * ex.cell, y: (r + 0.5) * ex.cell };
        if (this.sources.some((src) => this.canSee(src, pt))) {
          ex.bits[i >> 3] |= 1 << (i & 7);
          changed = true;
        }
      }
    }
    if (!changed) return;
    this.paintExplored();
    ex.pending = true;
    clearTimeout(this.exploreTimer);
    this.exploreTimer = setTimeout(() => this.flushExplored(), 1500);
  }

  flushExplored() {
    clearTimeout(this.exploreTimer);
    const ex = this.explored;
    if (!ex?.pending) return;
    ex.pending = false;
    this.api.sendExplore(ex.sceneId, { cols: ex.cols, rows: ex.rows, data: bitsToBase64(ex.bits) });
  }

  // ------------------------------------------------------------------ walls & doors

  drawWalls(s) {
    const { ctx } = this;
    const editing = this.tool.startsWith('wall');
    const z = this.cam.z;
    for (const w of Object.values(s.walls ?? {})) {
      const style = wallStyle(w);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = (editing ? 5 : 3) / z;
      ctx.globalAlpha = editing ? 1 : 0.55;
      ctx.strokeStyle = w.id === this.selectedWall ? '#ffffff' : style.color;
      if (style.dash) ctx.setLineDash(style.dash.map((n) => n / z));
      ctx.beginPath();
      ctx.moveTo(w.a[0], w.a[1]);
      ctx.lineTo(w.b[0], w.b[1]);
      ctx.stroke();
      if (editing) {
        ctx.setLineDash([]);
        ctx.fillStyle = ctx.strokeStyle;
        for (const p of [w.a, w.b]) { ctx.beginPath(); ctx.arc(p[0], p[1], 4 / z, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
    }
    const d = this.drag;
    if (d?.kind === 'wall') {
      ctx.save();
      ctx.lineWidth = 5 / z;
      ctx.lineCap = 'round';
      ctx.strokeStyle = wallStyle({ kind: this.wallType }).color;
      ctx.setLineDash([10 / z, 6 / z]);
      ctx.beginPath(); ctx.moveTo(d.a.x, d.a.y); ctx.lineTo(d.b.x, d.b.y); ctx.stroke();
      ctx.restore();
    }
  }

  /** Can this user see and use the door's icon? Secret doors are GM-only. */
  doorUsable(w) {
    if (w.kind === 'door') return true;
    return w.kind === 'secret_door' && isGM();
  }

  /** Doors get a clickable icon at their middle. Players see only doors in sight. */
  drawDoors(s, limited) {
    const { ctx } = this;
    const r = 11 / this.cam.z;
    for (const w of Object.values(s.walls ?? {})) {
      if (!this.doorUsable(w)) continue;
      const m = { x: (w.a[0] + w.b[0]) / 2, y: (w.a[1] + w.b[1]) / 2 };
      if (limited && !this.doorVisible(m)) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
      ctx.fillStyle = w.locked ? '#8a2f2f' : w.open ? '#2f6b45' : w.kind === 'secret_door' ? '#4a2f7a' : '#24425a';
      ctx.fill();
      ctx.lineWidth = 2 / this.cam.z;
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.stroke();
      // A little door (closed: solid panel, open: outline) or a padlock.
      ctx.fillStyle = ctx.strokeStyle = '#fff';
      const u = r / 11;
      if (w.locked) {
        ctx.fillRect(m.x - 4 * u, m.y - 1 * u, 8 * u, 6 * u);
        ctx.beginPath(); ctx.arc(m.x, m.y - 1 * u, 3 * u, Math.PI, 0); ctx.stroke();
      } else if (w.open) {
        ctx.strokeRect(m.x - 3.5 * u, m.y - 5 * u, 7 * u, 10 * u);
      } else {
        ctx.fillRect(m.x - 3.5 * u, m.y - 5 * u, 7 * u, 10 * u);
      }
      ctx.restore();
    }
  }

  /** A door's icon is visible if any of the player's tokens can see near it. */
  doorVisible(m) {
    const off = this.grid * 0.3;
    return [m, { x: m.x + off, y: m.y }, { x: m.x - off, y: m.y }, { x: m.x, y: m.y + off }, { x: m.x, y: m.y - off }]
      .some((p) => this.sources.some((src) => this.canSee(src, p)));
  }

  doorAt(w) {
    const s = this.scene;
    const r = 13 / this.cam.z;
    const limited = this.visionLimited();
    return Object.values(s?.walls ?? {}).find((wall) => {
      if (!this.doorUsable(wall)) return false;
      const m = { x: (wall.a[0] + wall.b[0]) / 2, y: (wall.a[1] + wall.b[1]) / 2 };
      return Math.hypot(m.x - w.x, m.y - w.y) <= r && (!limited || this.doorVisible(m));
    }) ?? null;
  }

  wallAt(w) {
    const tol = 7 / this.cam.z;
    let best = null, bestD = tol;
    for (const wall of Object.values(this.scene?.walls ?? {})) {
      const [ax, ay] = wall.a, [bx, by] = wall.b;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((w.x - ax) * dx + (w.y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(w.x - (ax + t * dx), w.y - (ay + t * dy));
      if (d < bestD) { best = wall; bestD = d; }
    }
    return best;
  }

  /** Snap a wall end to an existing wall end, else a grid corner or half-corner. */
  snapPoint(w, free) {
    if (free) return { x: Math.round(w.x), y: Math.round(w.y) };
    const tol = 12 / this.cam.z;
    for (const wall of Object.values(this.scene?.walls ?? {})) {
      for (const p of [wall.a, wall.b]) {
        if (Math.hypot(p[0] - w.x, p[1] - w.y) <= tol) return { x: p[0], y: p[1] };
      }
    }
    const step = this.grid / 2;
    return { x: Math.round(w.x / step) * step, y: Math.round(w.y / step) * step };
  }

  setTool(tool) {
    this.tool = tool;
    this.selectedWall = null;
    this.selectedDrawing = null;
    this.selectedLight = null;
    this.selectedSound = null;
    this.polyDraft = null;
    this.drag = null;
    const cross = ['wall-draw', 'light-draw', 'sound-place', 'measure', 'box-select', 'target'].includes(tool) || (tool.startsWith('draw-') && tool !== 'draw-select');
    this.canvas.style.cursor = cross ? 'crosshair' : '';
    hooks.emit('board:tool', tool);
    this.invalidate();
  }

  // ------------------------------------------------------------------ drawings

  canEditDrawing(d) { return !!d && (isGM() || d.author === store.user?.id); }

  drawDrawings(s) {
    const ds = Object.values(s.drawings ?? {});
    if (!ds.length) return;
    const d = this.drag;
    const shift = (x) => (d?.kind === 'drawing' && d.id === x.id ? [d.dx, d.dy] : [0, 0]);
    for (const x of ds) drawDrawing(this.ctx, x, ...shift(x));
    const sel = s.drawings?.[this.selectedDrawing];
    if (sel && this.tool === 'draw-select') drawSelection(this.ctx, sel, this.cam.z, ...shift(sel));
  }

  /** The shape being drawn right now, if any. */
  draft() {
    const d = this.drag;
    if (d?.kind === 'shape') {
      const r = rectFrom(d.a, d.b);
      return this.newDrawing(d.shape, r.x, r.y, { w: r.w, h: r.h });
    }
    if (d?.kind === 'freehand') return this.newDrawing('freehand', d.origin.x, d.origin.y, { points: d.points });
    if (this.polyDraft) {
      const pd = this.polyDraft;
      const pts = pd.cursor ? [...pd.pts, pd.cursor] : pd.pts;
      const o = pts[0];
      return this.newDrawing(pts.length > 2 ? 'polygon' : 'freehand', o[0], o[1], { points: pts.map((p) => [p[0] - o[0], p[1] - o[1]]) });
    }
    return null;
  }

  drawDraft() {
    const d = this.draft();
    if (!d) return;
    drawDrawing(this.ctx, d);
    if (this.polyDraft) {
      // Mark the first corner: click it to close the polygon.
      const [x, y] = this.polyDraft.pts[0];
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, 5 / this.cam.z, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  newDrawing(kind, x, y, extra = {}) {
    const st = this.drawStyle;
    return {
      id: '', kind, x: Math.round(x), y: Math.round(y), w: 0, h: 0, points: [],
      stroke: st.stroke ?? store.user?.color ?? '#e0a040',
      stroke_width: st.stroke_width, fill: st.fill, fill_alpha: st.fill_alpha,
      text: '', font_size: st.font_size, ...extra,
    };
  }

  createDrawing(d) {
    this.api.op({ op: 'drawing_create', scene_id: this.sceneId, drawing: d }, (why) => toast(why, 'error'));
  }

  /** The topmost drawing under a point that this user may edit. */
  drawingAt(w) {
    const tol = 6 / this.cam.z;
    const ds = Object.values(this.scene?.drawings ?? {}).filter((d) => this.canEditDrawing(d));
    for (let i = ds.length - 1; i >= 0; i--) if (hitDrawing(ds[i], w, tol)) return ds[i];
    return null;
  }

  finishPolygon() {
    const pd = this.polyDraft;
    this.polyDraft = null;
    this.invalidate();
    if (!pd) return;
    const pts = simplify(pd.pts.map((p) => [Math.round(p[0]), Math.round(p[1])]), 2);
    if (pts.length < 3) return;
    const o = pts[0];
    this.createDrawing(this.newDrawing('polygon', o[0], o[1], { points: pts.map((p) => [p[0] - o[0], p[1] - o[1]]) }));
  }

  async placeText(w) {
    const v = await formDialog({
      title: 'Add text',
      fields: [
        { name: 'text', label: 'Text', type: 'textarea', value: '', required: true },
        { name: 'font_size', label: 'Font size', type: 'number', value: this.drawStyle.font_size, min: 8, step: 1 },
        { name: 'stroke', label: 'Colour', type: 'color', value: this.drawStyle.stroke ?? store.user?.color ?? '#ffffff' },
      ],
      submit: 'Add',
    });
    if (!v || !v.text.trim()) return;
    this.drawStyle.font_size = v.font_size || 32;
    this.createDrawing(this.newDrawing('text', w.x, w.y, { text: v.text, font_size: v.font_size || 32, stroke: v.stroke }));
  }

  /** Style dialog for a drawing (double-click it with Select drawings). */
  async editDrawing(d) {
    const fields = d.kind === 'text'
      ? [
        { name: 'text', label: 'Text', type: 'textarea', value: d.text, required: true },
        { name: 'font_size', label: 'Font size', type: 'number', value: d.font_size, min: 8, step: 1 },
        { name: 'stroke', label: 'Colour', type: 'color', value: d.stroke },
      ]
      : [
        { name: 'stroke', label: 'Line colour', type: 'color', value: d.stroke },
        { name: 'stroke_width', label: 'Line width (0 = none)', type: 'number', value: d.stroke_width, min: 0, step: 1 },
        ...(d.kind === 'freehand' ? [] : [
          { name: 'filled', label: 'Filled', type: 'checkbox', value: !!d.fill },
          { name: 'fill', label: 'Fill colour', type: 'color', value: d.fill ?? d.stroke },
          { name: 'fill_alpha', label: 'Fill opacity (0–1)', type: 'number', value: d.fill_alpha, min: 0, step: 0.05 },
        ]),
      ];
    const v = await formDialog({ title: 'Drawing', fields });
    if (!v || !this.scene?.drawings?.[d.id]) return;
    const patch = d.kind === 'text'
      ? { text: v.text, font_size: v.font_size || 32, stroke: v.stroke }
      : { stroke: v.stroke, stroke_width: Math.max(0, v.stroke_width) };
    if (d.kind !== 'text' && d.kind !== 'freehand') {
      patch.fill = v.filled ? v.fill : null;
      patch.fill_alpha = Math.min(1, Math.max(0, v.fill_alpha));
    }
    // New drawings use the last style you picked.
    for (const k of ['stroke', 'stroke_width', 'fill', 'fill_alpha', 'font_size']) if (k in patch) this.drawStyle[k] = patch[k];
    this.api.op({ op: 'drawing_update', scene_id: this.sceneId, id: d.id, patch }, (why) => toast(why, 'error'));
  }

  deleteSelectedDrawing() {
    if (!this.selectedDrawing) return false;
    this.api.op({ op: 'drawing_delete', scene_id: this.sceneId, id: this.selectedDrawing }, (why) => toast(why, 'error'));
    this.selectedDrawing = null;
    return true;
  }

  /** Where to draw a token: shifted along with a group drag in progress. */
  dragPos(t) {
    const d = this.drag;
    if (d?.kind !== 'token') return t;
    const m = d.group.find((g) => g.id === t.id);
    return m ? { x: m.x + d.pos.x - d.start.x, y: m.y + d.pos.y - d.start.y } : t;
  }

  /** The visible token under a point (players can't pick tokens out of sight). */
  pickToken(w) {
    const t = this.tokenAt(w.x, w.y);
    return t && (!this.visionLimited() || this.tokenVisible(t)) ? t : null;
  }

  /** Drop one or more dragged tokens: snap, check walls, send moves. */
  finishTokenDrag(d) {
    const dx = d.pos.x - d.start.x, dy = d.pos.y - d.start.y;
    let blocked = 0;
    for (const m of d.group) {
      const t = this.scene?.tokens[m.id];
      if (!t) continue;
      const raw = { x: m.x + dx, y: m.y + dy };
      const pos = this.free ? { x: Math.round(raw.x), y: Math.round(raw.y) } : { x: this.snap(raw.x), y: this.snap(raw.y) };
      if (pos.x === t.x && pos.y === t.y) continue;
      if (this.moveBlocked(t, pos)) { blocked++; continue; }
      if (!hooks.call('board:tokenMove', t, pos)) continue;
      const prev = { x: t.x, y: t.y };
      Object.assign(t, pos); // optimistic; rolled back if the server rejects
      this.api.update.token(this.sceneId, t.id, pos, () => { Object.assign(t, prev); this.invalidate(); });
    }
    if (blocked) toast(blocked === 1 ? 'A wall is in the way.' : `${blocked} tokens were blocked by walls.`);
    this.visionDirty = true;
  }

  // ------------------------------------------------------------------ targets

  /** Each user's targeted token ids. Shared live; not saved. */
  myTargets() {
    return this.targets.get(store.user?.id) ?? new Set();
  }

  setTargets(ids) {
    const mine = new Set(ids);
    this.targets.set(store.user.id, mine);
    this.api.socket.emit('core.target', { ids: [...mine] });
    hooks.emit('targets:change', [...mine]);
    this.invalidate();
  }

  toggleTarget(id, add) {
    const mine = new Set(add ? this.myTargets() : []);
    if (this.myTargets().has(id) && (add || this.myTargets().size === 1)) mine.delete(id);
    else mine.add(id);
    this.setTargets([...mine]);
  }

  /** Someone else's targets changed (relayed by the server). */
  receiveTargets(userId, ids) {
    this.targets.set(userId, new Set(ids));
    this.invalidate();
  }

  drawTargets(t, r) {
    const { ctx } = this;
    let ring = 0;
    for (const [uid, ids] of this.targets) {
      if (!ids.has(t.id)) continue;
      const color = store.world.users[uid]?.color ?? '#ff5555';
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const rad = Math.min(r.w, r.h) / 2 + 6 / this.cam.z + ring * 5 / this.cam.z;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5 / this.cam.z;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      // Four ticks pointing in, like a reticle.
      for (let i = 0; i < 4; i++) {
        const a = (Math.PI / 2) * i;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (rad + 6 / this.cam.z), cy + Math.sin(a) * (rad + 6 / this.cam.z));
        ctx.lineTo(cx + Math.cos(a) * (rad - 5 / this.cam.z), cy + Math.sin(a) * (rad - 5 / this.cam.z));
        ctx.stroke();
      }
      ctx.restore();
      ring++;
    }
  }

  drawSelectionBox() {
    const d = this.drag;
    if (d?.kind !== 'box') return;
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 209, 102, .12)';
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 1.5 / this.cam.z;
    ctx.setLineDash([6 / this.cam.z, 4 / this.cam.z]);
    const x = Math.min(d.a.x, d.b.x), y = Math.min(d.a.y, d.b.y);
    ctx.fillRect(x, y, Math.abs(d.b.x - d.a.x), Math.abs(d.b.y - d.a.y));
    ctx.strokeRect(x, y, Math.abs(d.b.x - d.a.x), Math.abs(d.b.y - d.a.y));
    ctx.restore();
  }

  /** GM with "unconstrained movement" on: ignore walls and the grid. */
  get free() { return isGM() && this.unconstrained; }

  /**
   * Would this move pass through a wall? Players are always checked (the server
   * enforces it too); the GM is unless unconstrained movement is on.
   */
  moveBlocked(t, pos) {
    if (this.free) return false;
    const from = this.center(t);
    const to = this.center({ ...t, x: pos.x, y: pos.y });
    return this.moveSegments().some((s) => segmentsCross(from, to, s.a, s.b));
  }

  drawGrid(s) {
    const { ctx } = this;
    const g = s.grid.size;
    ctx.beginPath();
    for (let x = 0; x <= s.width + 0.5; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, s.height); }
    for (let y = 0; y <= s.height + 0.5; y += g) { ctx.moveTo(0, y); ctx.lineTo(s.width, y); }
    ctx.strokeStyle = s.grid.color || 'rgba(255,255,255,.15)';
    ctx.lineWidth = 1 / this.cam.z;
    ctx.stroke();
  }

  drawToken(t) {
    const { ctx } = this;
    const pos = this.dragPos(t);
    const r = { ...this.tokenRect(t), x: pos.x, y: pos.y };
    const actor = t.actor_id ? store.world.actors[t.actor_id] : null;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = Math.min(r.w, r.h) / 2 - 2;
    if (this.isActiveCombatant(t)) {
      // Pulsing glow under the token whose turn it is.
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 350);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rad + 6 + pulse * 4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 190, 80, ${0.55 + pulse * 0.4})`;
      ctx.lineWidth = 5;
      ctx.shadowColor = '#ffb347';
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.restore();
      this.animating = true;
    }
    ctx.save();
    if (t.hidden) ctx.globalAlpha = 0.45;
    ctx.translate(cx, cy);
    ctx.rotate((t.rotation || 0) * Math.PI / 180);
    const img = this.image(t.img || actor?.img);
    ctx.beginPath();
    ctx.arc(0, 0, rad, 0, Math.PI * 2);
    if (img) {
      ctx.save(); ctx.clip();
      ctx.drawImage(img, -r.w / 2, -r.h / 2, r.w, r.h);
      ctx.restore();
    } else {
      ctx.fillStyle = t.color || '#5b8def';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${rad}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText((t.name || '?').trim().charAt(0).toUpperCase(), 0, rad * 0.06);
    }
    ctx.lineWidth = this.selected.has(t.id) ? 4 : 2;
    ctx.strokeStyle = this.selected.has(t.id) ? '#ffd166' : 'rgba(0,0,0,.6)';
    ctx.stroke();
    ctx.restore();

    if (t.show_name !== false && t.name) {
      ctx.save();
      ctx.font = `600 ${Math.max(11, this.grid * 0.2)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(t.name).width;
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.fillRect(cx - tw / 2 - 4, r.y + r.h + 2, tw + 8, Math.max(11, this.grid * 0.2) + 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(t.name, cx, r.y + r.h + 5);
      ctx.restore();
    }
    this.drawTargets(t, r);
    hooks.emit('board:drawToken', ctx, t, actor, r, this);
  }

  drawRuler() {
    const { ctx } = this;
    const { a, b } = this.ruler;
    const s = this.scene;
    const cells = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / s.grid.size;
    const dist = Math.round(cells) * (s.grid.distance ?? 5);
    ctx.save();
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 3 / this.cam.z;
    ctx.setLineDash([10 / this.cam.z, 6 / this.cam.z]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    const label = `${dist} ${s.grid.units ?? ''}`.trim();
    const fs = 16 / this.cam.z;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,.75)';
    ctx.fillRect(b.x + 10 / this.cam.z, b.y - fs, w + 12 / this.cam.z, fs * 1.5);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(label, b.x + 16 / this.cam.z, b.y + fs * 0.2);
    ctx.restore();
  }

  ping(x, y, color) {
    this.pings.push({ x, y, color, t0: performance.now() });
  }

  drawPings() {
    const now = performance.now();
    this.pings = this.pings.filter((p) => now - p.t0 < 1600);
    const { ctx } = this;
    for (const p of this.pings) {
      const k = (now - p.t0) / 1600;
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = p.color || '#ffd166';
      ctx.lineWidth = 4 / this.cam.z;
      for (const off of [0, 0.3]) {
        const kk = Math.min(1, k + off);
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.grid * (0.3 + kk * 1.4), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ input

  bind() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toWorld(e.offsetX, e.offsetY);
      this.cam.z = Math.max(0.1, Math.min(4, this.cam.z * Math.exp(-e.deltaY * 0.0015)));
      const after = this.toWorld(e.offsetX, e.offsetY);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
      this.invalidate();
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      c.focus();
      c.setPointerCapture(e.pointerId);
      const w = this.toWorld(e.offsetX, e.offsetY);
      // Door icons: click to open/close; GM right-click to lock/unlock.
      const door = (e.button === 0 || e.button === 2) ? this.doorAt(w) : null;
      if (door) {
        if (e.button === 2) {
          if (isGM()) this.api.op({ op: 'wall_update', scene_id: this.sceneId, id: door.id, patch: { locked: !door.locked } });
        } else if (door.locked && !isGM()) {
          toast('The door is locked.');
        } else {
          this.api.op({ op: 'wall_update', scene_id: this.sceneId, id: door.id, patch: { open: !door.open } });
        }
        return;
      }
      // Sound tools (GM): right-click a sound to switch it on or off.
      if (isGM() && this.tool.startsWith('sound-') && e.button === 2) {
        const x = this.soundAt(w);
        if (x) {
          this.api.op({ op: 'sound_update', scene_id: this.sceneId, id: x.id, patch: { off: !x.off } });
          return;
        }
      }
      // Light tools (GM): right-click a light to switch it on or off.
      if (isGM() && this.tool.startsWith('light-') && e.button === 2) {
        const l = this.lightAt(w);
        if (l) {
          this.api.op({ op: 'light_update', scene_id: this.sceneId, id: l.id, patch: { off: !l.off } });
          return;
        }
      }
      if (e.button === 1 || e.button === 2) {
        // A right-click without dragging opens token settings (GM).
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam }, button: e.button, w };
        return;
      }
      if (isGM() && this.tool === 'sound-select') {
        const x = this.soundAt(w);
        this.selectedSound = x?.id ?? null;
        this.drag = x
          ? { kind: 'sound-move', id: x.id, ox: w.x - x.x, oy: w.y - x.y, pos: { x: x.x, y: x.y } }
          : { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam } };
        this.invalidate();
        return;
      }
      if (isGM() && this.tool === 'sound-place') {
        const at = e.shiftKey ? { x: w.x, y: w.y } : { x: this.snapCenter(w.x), y: this.snapCenter(w.y) };
        this.configureSound(null, at);
        return;
      }
      if (isGM() && this.tool === 'light-select') {
        const l = this.lightAt(w);
        this.selectedLight = l?.id ?? null;
        this.drag = l
          ? { kind: 'light-move', id: l.id, ox: w.x - l.x, oy: w.y - l.y, pos: { x: l.x, y: l.y } }
          : { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam } };
        this.invalidate();
        return;
      }
      if (isGM() && this.tool === 'light-draw') {
        // Click to place a light; drag to set how far it reaches.
        const a = e.shiftKey ? { x: w.x, y: w.y } : { x: this.snapCenter(w.x), y: this.snapCenter(w.y) };
        this.drag = { kind: 'light-new', a, b: a };
        this.invalidate();
        return;
      }
      // Wall tools (GM). Select: click a wall to select it, drag empty space to
      // pan. Draw: drag to draw a wall of the chosen type.
      if (isGM() && this.tool === 'wall-select') {
        const hit = this.wallAt(w);
        this.selectedWall = hit?.id ?? null;
        if (!hit) this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam } };
        this.invalidate();
        return;
      }
      if (isGM() && this.tool === 'wall-draw') {
        this.selectedWall = null;
        const a = this.snapPoint(w, e.shiftKey);
        this.drag = { kind: 'wall', a, b: a };
        this.invalidate();
        return;
      }
      // Drawing tools (everyone). Select: click your drawing, drag to move it.
      if (this.tool === 'draw-select') {
        const hit = this.drawingAt(w);
        this.selectedDrawing = hit?.id ?? null;
        this.drag = hit
          ? { kind: 'drawing', id: hit.id, sx: w.x, sy: w.y, dx: 0, dy: 0 }
          : { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam } };
        this.invalidate();
        return;
      }
      if (this.tool === 'draw-rect' || this.tool === 'draw-ellipse') {
        this.drag = { kind: 'shape', shape: this.tool.slice(5), a: w, b: w };
        return;
      }
      if (this.tool === 'draw-freehand') {
        this.drag = { kind: 'freehand', origin: w, points: [[0, 0]] };
        return;
      }
      if (this.tool === 'draw-polygon') {
        // Click corners; click the first corner, double-click or press Enter to finish.
        const pd = this.polyDraft;
        const p = [w.x, w.y];
        if (!pd) this.polyDraft = { pts: [p], cursor: p };
        else if (pd.pts.length > 2 && Math.hypot(p[0] - pd.pts[0][0], p[1] - pd.pts[0][1]) <= 10 / this.cam.z) this.finishPolygon();
        else pd.pts.push(p);
        this.invalidate();
        return;
      }
      if (this.tool === 'draw-text') {
        this.placeText(w);
        return;
      }
      if (e.ctrlKey || e.metaKey || this.tool === 'measure') {
        this.ruler = { a: { x: this.snapCenter(w.x), y: this.snapCenter(w.y) }, b: w };
        this.drag = { kind: 'ruler' };
        return;
      }
      const t = this.pickToken(w);
      if (this.tool === 'target') {
        if (t) this.toggleTarget(t.id, e.shiftKey);
        else if (!e.shiftKey) this.setTargets([]);
        this.invalidate();
        return;
      }
      if (t) {
        if (!e.shiftKey && !this.selected.has(t.id)) this.selected.clear();
        this.selected.add(t.id);
        if (this.canMove(t)) {
          // Dragging one of several selected tokens moves them all.
          const group = [...this.selected]
            .map((id) => this.scene.tokens[id])
            .filter((x) => x && this.canMove(x))
            .map((x) => ({ id: x.id, x: x.x, y: x.y }));
          this.drag = { kind: 'token', id: t.id, ox: w.x - t.x, oy: w.y - t.y, start: { x: t.x, y: t.y }, pos: { x: t.x, y: t.y }, group };
        }
      } else if (this.tool === 'box-select') {
        if (!e.shiftKey) this.selected.clear();
        this.drag = { kind: 'box', a: w, b: w };
      } else {
        this.selected.clear();
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam } };
      }
      this.invalidate();
    });

    c.addEventListener('pointermove', (e) => {
      if (this.api.audio?.preview) {
        this.api.audio.preview = this.toWorld(e.offsetX, e.offsetY);
        if (this.tool.startsWith('sound-')) this.invalidate();
      }
      const d = this.drag;
      if (!d && this.polyDraft) {
        const w = this.toWorld(e.offsetX, e.offsetY);
        this.polyDraft.cursor = [w.x, w.y];
        this.invalidate();
        return;
      }
      if (!d) return;
      if (d.kind === 'pan') {
        this.cam.x = d.cam.x - (e.clientX - d.sx) / this.cam.z;
        this.cam.y = d.cam.y - (e.clientY - d.sy) / this.cam.z;
      } else if (d.kind === 'token') {
        const w = this.toWorld(e.offsetX, e.offsetY);
        d.pos = { x: w.x - d.ox, y: w.y - d.oy };
      } else if (d.kind === 'ruler') {
        const w = this.toWorld(e.offsetX, e.offsetY);
        this.ruler.b = { x: this.snapCenter(w.x), y: this.snapCenter(w.y) };
      } else if (d.kind === 'wall') {
        d.b = this.snapPoint(this.toWorld(e.offsetX, e.offsetY), e.shiftKey);
      } else if (d.kind === 'box' || d.kind === 'shape' || d.kind === 'light-new') {
        d.b = this.toWorld(e.offsetX, e.offsetY);
      } else if (d.kind === 'sound-move') {
        const w = this.toWorld(e.offsetX, e.offsetY);
        d.pos = { x: w.x - d.ox, y: w.y - d.oy };
      } else if (d.kind === 'light-move') {
        const w = this.toWorld(e.offsetX, e.offsetY);
        d.pos = { x: w.x - d.ox, y: w.y - d.oy };
      } else if (d.kind === 'drawing') {
        const w = this.toWorld(e.offsetX, e.offsetY);
        d.dx = w.x - d.sx;
        d.dy = w.y - d.sy;
      } else if (d.kind === 'freehand') {
        const w = this.toWorld(e.offsetX, e.offsetY);
        const p = [w.x - d.origin.x, w.y - d.origin.y];
        const q = d.points.at(-1);
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 3 / this.cam.z && d.points.length < 5000) d.points.push(p);
      }
      this.invalidate();
    });

    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d?.kind === 'pan' && d.button === 2 && isGM() && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) {
        const l = this.tool.startsWith('light-') ? this.lightAt(d.w) : null;
        const snd = this.tool.startsWith('sound-') ? this.soundAt(d.w) : null;
        const t = l || snd ? null : this.pickToken(d.w);
        if (l) this.configureLight(l);
        else if (snd) { /* right-click on a sound toggles it (handled on press) */ }
        else if (t) this.configureToken(t);
      }
      if (d?.kind === 'sound-move') {
        const x = this.scene?.sounds?.[d.id];
        if (x && Math.hypot(d.pos.x - x.x, d.pos.y - x.y) > 1) {
          this.api.op({ op: 'sound_update', scene_id: this.sceneId, id: d.id, patch: { x: Math.round(d.pos.x), y: Math.round(d.pos.y) } });
        }
      }
      if (d?.kind === 'light-move') {
        const l = this.scene?.lights?.[d.id];
        if (l && Math.hypot(d.pos.x - l.x, d.pos.y - l.y) > 1) {
          this.api.op({ op: 'light_update', scene_id: this.sceneId, id: d.id, patch: { x: Math.round(d.pos.x), y: Math.round(d.pos.y) } });
        }
      }
      if (d?.kind === 'light-new') {
        // Dragged: the drag sets the dim radius (bright is half). Clicked: a torch.
        const px = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
        const per = (this.scene.grid.distance || 5) / this.grid;
        const dim = px > this.grid / 3 ? Math.round(px * per * 2) / 2 : (this.scene.grid.distance || 5) * 8;
        this.api.op({
          op: 'light_create', scene_id: this.sceneId,
          light: { id: '', x: Math.round(d.a.x), y: Math.round(d.a.y), bright: dim / 2, dim, color: null, off: false },
        }, (why) => toast(why, 'error'));
      }
      if (d?.kind === 'wall' && Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 2) {
        this.api.op({
          op: 'wall_create',
          scene_id: this.sceneId,
          wall: { id: '', a: [d.a.x, d.a.y], b: [d.b.x, d.b.y], kind: this.wallType },
        });
      }
      if (d?.kind === 'token') this.finishTokenDrag(d);
      if (d?.kind === 'shape') {
        const r = rectFrom(d.a, d.b);
        if (r.w > 3 && r.h > 3) this.createDrawing(this.newDrawing(d.shape, r.x, r.y, { w: Math.round(r.w), h: Math.round(r.h) }));
      }
      if (d?.kind === 'freehand') {
        const pts = simplify(d.points.map((p) => [Math.round(p[0]), Math.round(p[1])]), 2);
        if (pts.length > 1) this.createDrawing(this.newDrawing('freehand', d.origin.x, d.origin.y, { points: pts }));
      }
      if (d?.kind === 'drawing' && (Math.abs(d.dx) > 1 || Math.abs(d.dy) > 1)) {
        const x = this.scene?.drawings?.[d.id];
        if (x) {
          const patch = { x: Math.round(x.x + d.dx), y: Math.round(x.y + d.dy) };
          this.api.op({ op: 'drawing_update', scene_id: this.sceneId, id: d.id, patch }, (why) => toast(why, 'error'));
        }
      }
      if (d?.kind === 'box') {
        const x0 = Math.min(d.a.x, d.b.x), x1 = Math.max(d.a.x, d.b.x);
        const y0 = Math.min(d.a.y, d.b.y), y1 = Math.max(d.a.y, d.b.y);
        for (const t of this.tokens()) {
          const c = this.center(t);
          if (c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1 && this.canMove(t)) this.selected.add(t.id);
        }
      }
      if (d?.kind === 'ruler') this.ruler = null;
      this.invalidate();
    });

    c.addEventListener('dblclick', (e) => {
      const w = this.toWorld(e.offsetX, e.offsetY);
      if (this.tool === 'draw-polygon') { this.finishPolygon(); return; }
      if (this.tool.startsWith('sound-')) {
        const x = isGM() && this.soundAt(w);
        if (x) this.configureSound(x);
        return;
      }
      if (this.tool.startsWith('light-')) {
        const l = isGM() && this.lightAt(w);
        if (l) this.configureLight(l);
        return;
      }
      if (this.tool.startsWith('draw-')) {
        const hit = this.tool === 'draw-select' && this.drawingAt(w);
        if (hit) this.editDrawing(hit);
        return;
      }
      const t = this.tokenAt(w.x, w.y);
      if (t?.actor_id) this.api.sheets.open(t.actor_id);
      else if (!t) this.api.socket.emit('core.ping', { scene_id: this.sceneId, x: w.x, y: w.y });
    });

    c.addEventListener('keydown', (e) => {
      if (this.polyDraft && (e.key === 'Enter' || e.key === 'Escape')) {
        if (e.key === 'Enter') this.finishPolygon();
        else { this.polyDraft = null; this.invalidate(); }
        return;
      }
      if (this.tool === 'draw-select' && (e.key === 'Delete' || e.key === 'Backspace') && this.deleteSelectedDrawing()) return;
      if (isGM() && this.tool === 'sound-select' && (e.key === 'Delete' || e.key === 'Backspace') && this.selectedSound) {
        this.api.op({ op: 'sound_delete', scene_id: this.sceneId, id: this.selectedSound });
        this.selectedSound = null;
        return;
      }
      if (isGM() && this.tool === 'light-select' && (e.key === 'Delete' || e.key === 'Backspace') && this.selectedLight) {
        this.api.op({ op: 'light_delete', scene_id: this.sceneId, id: this.selectedLight });
        this.selectedLight = null;
        return;
      }
      if (this.tool !== 'select') {
        if (isGM() && (e.key === 'Delete' || e.key === 'Backspace') && this.selectedWall) {
          this.api.op({ op: 'wall_delete', scene_id: this.sceneId, id: this.selectedWall });
          this.selectedWall = null;
        } else if (e.key === 'Escape') {
          this.setTool('select');
        }
        if (this.tool.startsWith('wall') || this.tool.startsWith('draw-') || this.tool.startsWith('light-') || this.tool.startsWith('sound-')) return;
      }
      if (!this.selected.size || !this.scene) return;
      const ids = [...this.selected].filter((id) => this.scene.tokens[id]);
      const g = this.grid;
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (dir) {
        e.preventDefault();
        for (const id of ids) {
          const t = this.scene.tokens[id];
          if (!this.canMove(t)) continue;
          const pos = { x: t.x + dir[0] * g, y: t.y + dir[1] * g };
          if (this.moveBlocked(t, pos)) { toast('A wall is in the way.'); continue; }
          if (hooks.call('board:tokenMove', t, pos)) this.api.update.token(this.sceneId, id, pos);
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && isGM()) {
        for (const id of ids) this.api.op({ op: 'token_delete', scene_id: this.sceneId, id });
        this.selected.clear();
      } else if (e.key.toLowerCase() === 'h' && isGM()) {
        for (const id of ids) this.api.update.token(this.sceneId, id, { hidden: !this.scene.tokens[id].hidden });
      }
    });

    // Drag actors from the sidebar onto the board.
    c.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-hearth-actor')) e.preventDefault();
    });
    c.addEventListener('drop', (e) => {
      const actorId = e.dataTransfer.getData('application/x-hearth-actor');
      const actor = store.world.actors[actorId];
      if (!actor || !this.scene) return;
      e.preventDefault();
      const w = this.toWorld(e.offsetX, e.offsetY);
      const g = this.grid;
      const size = actor.flags?.token?.size ?? 1;
      this.api.create.token(this.sceneId, {
        name: actor.name,
        actor_id: actor.id,
        x: Math.floor(w.x / g) * g,
        y: Math.floor(w.y / g) * g,
        w: size, h: size,
        img: actor.img ?? null,
        color: actor.flags?.token?.color ?? '#5b8def',
        hidden: e.altKey,
      });
    });
  }

  /** Is it this token's turn in the running combat? */
  isActiveCombatant(t) {
    const c = store.world?.combat;
    if (!c || c.round < 1 || c.scene_id !== this.sceneId || !c.current) return false;
    return c.combatants.some((x) => x.id === c.current && x.token_id === t.id);
  }

  /** Centre the view on a token and select it. */
  focusToken(id) {
    const t = this.scene?.tokens[id];
    if (!t) return;
    const r = this.tokenRect(t);
    const v = this.viewArea();
    this.cam.x = r.x + r.w / 2 - (v.left + v.width / 2) / this.cam.z;
    this.cam.y = r.y + r.h / 2 - (v.height / 2) / this.cam.z;
    this.selected.clear();
    this.selected.add(id);
    this.invalidate();
  }

  snapCenter(v) {
    const g = this.grid;
    return Math.floor(v / g) * g + g / 2;
  }

  onOp(op) {
    if (op.op === 'token_delete') this.selected.delete(op.id);
    if (op.op === 'wall_delete' && op.id === this.selectedWall) this.selectedWall = null;
    if (op.op === 'drawing_delete' && op.id === this.selectedDrawing) this.selectedDrawing = null;
    if (op.op === 'scene_delete' && op.id === this.sceneId) this.view(store.world.active_scene);
    // Anything that can change what a token sees.
    if (/^(token_|wall_|light_|actor_update|scene_update)/.test(op.op)) this.visionDirty = true;
    if (op.op === 'light_delete' && op.id === this.selectedLight) this.selectedLight = null;
    if (op.op === 'sound_delete' && op.id === this.selectedSound) this.selectedSound = null;
    // The scene's size or grid changed, or the GM reset the fog: reload explored areas.
    if ((op.op === 'scene_update' && op.id === this.sceneId && (op.patch.width || op.patch.height || op.patch.grid))
      || (op.op === 'fog_reset' && op.scene_id === this.sceneId)) {
      this.loadExplored();
      this.visionDirty = true;
    }
    this.invalidate();
  }
}

/** How each kind of wall is drawn for the GM (colour, dash pattern). */
function wallStyle(w) {
  const open = (w.kind === 'door' || w.kind === 'secret_door') && w.open;
  if (open) return { color: '#57c785', dash: [8, 6] };
  switch (w.kind) {
    case 'terrain': return { color: '#c99a5b', dash: [4, 5] };
    case 'invisible': return { color: '#d4d4d4', dash: [1, 6] };
    case 'ethereal': return { color: '#b07ce8', dash: [12, 5] };
    case 'door': return { color: '#5bc0ff' };
    case 'secret_door': return { color: '#9a6cff' };
    case 'window': return { color: '#7fe0e8', dash: [14, 4, 2, 4] };
    default: return { color: '#e8a24a' };
  }
}

/** Normalised rectangle between two corner points. */
function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** '#rrggbb' or '#rgb' → 'r, g, b' (or null). */
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
}
