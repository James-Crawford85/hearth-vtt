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
//
// Hooks
//   board:drawBackground (ctx, scene, board)
//   board:drawToken      (ctx, token, actor, rect, board)  – after a token is drawn
//   board:drawOverlay    (ctx, scene, board)               – in world space, above tokens
//   board:tokenMove      (token, {x, y})                   – return false to block

import { hooks } from './hooks.js';
import { store, isGM, ownsActor } from './store.js';

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
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = () => { if (this.dirty || this.pings.length) this.draw(); requestAnimationFrame(loop); };
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
    this.sceneId = sceneId;
    this.selected.clear();
    if (fit) this.fit();
    hooks.emit('board:view', this.scene);
    this.invalidate();
  }

  fit() {
    const s = this.scene;
    if (!s) return;
    const r = this.canvas.getBoundingClientRect();
    const usableW = r.width - 360; // leave room for the sidebar
    const z = Math.min(usableW / s.width, r.height / s.height) * 0.92;
    this.cam.z = Math.max(0.1, Math.min(3, z || 1));
    this.cam.x = s.width / 2 - (usableW / 2) / this.cam.z;
    this.cam.y = s.height / 2 - (r.height / 2) / this.cam.z;
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

    for (const t of this.tokens()) this.drawToken(t);
    hooks.emit('board:drawOverlay', ctx, s, this);
    if (this.ruler) this.drawRuler();
    this.drawPings();
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
    const pos = this.drag?.id === t.id ? this.drag.pos : t;
    const r = { ...this.tokenRect(t), x: pos.x, y: pos.y };
    const actor = t.actor_id ? store.world.actors[t.actor_id] : null;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, rad = Math.min(r.w, r.h) / 2 - 2;
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
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam } };
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        this.ruler = { a: { x: this.snapCenter(w.x), y: this.snapCenter(w.y) }, b: w };
        this.drag = { kind: 'ruler' };
        return;
      }
      const t = this.tokenAt(w.x, w.y);
      if (t) {
        if (!e.shiftKey && !this.selected.has(t.id)) this.selected.clear();
        this.selected.add(t.id);
        if (this.canMove(t)) {
          this.drag = { kind: 'token', id: t.id, ox: w.x - t.x, oy: w.y - t.y, pos: { x: t.x, y: t.y } };
        }
      } else {
        this.selected.clear();
        this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam: { ...this.cam } };
      }
      this.invalidate();
    });

    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
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
      }
      this.invalidate();
    });

    c.addEventListener('pointerup', () => {
      const d = this.drag;
      this.drag = null;
      if (d?.kind === 'token') {
        const t = this.scene?.tokens[d.id];
        if (t) {
          const pos = { x: this.snap(d.pos.x), y: this.snap(d.pos.y) };
          if ((pos.x !== t.x || pos.y !== t.y) && hooks.call('board:tokenMove', t, pos)) {
            const prev = { x: t.x, y: t.y };
            Object.assign(t, pos); // optimistic; rolled back if the server rejects
            this.api.update.token(this.sceneId, t.id, pos, () => { Object.assign(t, prev); this.invalidate(); });
          }
        }
      }
      if (d?.kind === 'ruler') this.ruler = null;
      this.invalidate();
    });

    c.addEventListener('dblclick', (e) => {
      const w = this.toWorld(e.offsetX, e.offsetY);
      const t = this.tokenAt(w.x, w.y);
      if (t?.actor_id) this.api.sheets.open(t.actor_id);
      else if (!t) this.api.socket.emit('core.ping', { scene_id: this.sceneId, x: w.x, y: w.y });
    });

    c.addEventListener('keydown', (e) => {
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

  snapCenter(v) {
    const g = this.grid;
    return Math.floor(v / g) * g + g / 2;
  }

  onOp(op) {
    if (op.op === 'token_delete') this.selected.delete(op.id);
    if (op.op === 'scene_delete' && op.id === this.sceneId) this.view(store.world.active_scene);
    this.invalidate();
  }
}
