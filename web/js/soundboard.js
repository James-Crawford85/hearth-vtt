// The GM's soundboard: a mix of looping layers (music, crowd, rain…) that
// everyone hears, one-shot pads fired over it, and saved presets of mixes.
// It's separate from playlists and from the sounds placed on maps.
//
// The board lives in the world at settings.core.soundboard:
//   master      the GM's master volume for everyone (0–1)
//   fade        seconds to fade layers in and out, and to crossfade presets
//   layers      { id: { name, src, icon, color, volume, loop, muted, playing, started, sort,
//                       random, minWait, maxWait } }
//               A `random` layer is a one-shot (thunder, a distant howl) that plays again and
//               again: after each play it waits minWait–maxWait seconds. Everyone works out the
//               same waits from the layer's id and start time, so they hear each play together.
//   presets     { id: { name, sort, master, layers: { id: { …layer, on } } } }
//   pads        { id: { name, src, icon, color, volume, sort } }
//   preset      id of the preset last recalled
// The server stamps `started` (its clock) when a layer starts, so everyone,
// including anyone who joins late, hears the same moment of each loop.
//
// Each browser mixes with Web Audio: layer → its gain → board master → this
// person's own soundboard volume (kept in this browser) → speakers.
// Looping layers are decoded and looped by Web Audio, with the last few
// milliseconds blended into the start, so no loop ticks where it repeats (even
// files that weren't made to loop). Layers that play once, and very big files,
// stream through an <audio> element instead.
// One-shots aren't stored: pressing a pad sends a message that everyone online
// plays once.
//
// Sound files come from uploads (kept in the world's assets, optionally in
// subfolders) or from any audio already in the assets folder: a library of
// sounds can be copied into worlds/<world>/assets/sounds/… and browsed here.

import { hooks } from './hooks.js';
import { store, isGM } from './store.js';
import { el, toast, openWindow, formDialog } from './ui.js';
import { newId } from './directory.js';

const LOCAL_KEY = 'hearth.volume.soundboard';
const SHOT_CHANNEL = 'core.soundboard.shot';
const AUDIO_FILE = /\.(mp3|ogg|oga|opus|m4a|flac|wav|webm)$/i;
const WAIT_MIN = 10, WAIT_MAX = 60;   // random sounds: default seconds of quiet between plays

/** A random layer's [min, max] seconds between plays. */
const waits = (l) => {
  const min = Math.max(0, Math.min(3600, Number(l.minWait ?? WAIT_MIN) || 0));
  return [min, Math.max(min, Math.min(3600, Number(l.maxWait ?? WAIT_MAX) || 0))];
};

/** A repeatable random sequence in [0, 1) from a string (mulberry32 seeded with an FNV-1a hash). */
function seededRandom(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOOP_XFADE = 0.06;       // seconds of a loop's end blended into its start
const MAX_LOOP_BYTES = 8e6;     // bigger looping files stream through <audio> (decoded, they'd take a lot of memory)

/**
 * A copy of `buf` that repeats without a seam: its last `LOOP_XFADE` seconds are
 * blended into the first ones (raised-cosine weights that sum to 1), and the copy
 * is that much shorter. Wrapping from its end to its start is then the original
 * audio running on, and the file's own first and last samples, where lossy codecs
 * leave a small step, are faded out.
 */
function seamless(ctx, buf) {
  const x = Math.min(Math.round(LOOP_XFADE * buf.sampleRate), Math.floor(buf.length / 4));
  if (x < 16) return buf;
  const n = buf.length - x;
  const out = ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const a = buf.getChannelData(c);
    const o = out.getChannelData(c);
    o.set(a.subarray(0, n));
    for (let k = 0; k < x; k++) {
      const w = Math.sin((Math.PI / 2) * (k + 0.5) / x) ** 2;
      o[k] = a[k] * w + a[n + k] * (1 - w);
    }
  }
  return out;
}

/** Guess an icon from a sound's name. Specific sounds come before places, so "door wood slam" is a door. */
const ICONS = [
  [/scream|shriek|yell/, '😱'], [/door|gate|creak/, '🚪'], [/explo|boom|blast/, '💥'], [/fireball|magic|spell|arcane|shimmer|portal/, '✨'],
  [/dragon|roar|monster|beast|growl/, '🐉'], [/wolf|howl|dog|bark/, '🐺'], [/bell|chime|church/, '🔔'], [/horse|hoof|gallop|cart/, '🐎'],
  [/step|foot|walk/, '👣'], [/\bheart(beat)?\b/, '💓'], [/coin|gold|treasure/, '🪙'], [/sword|clash|battle|combat|fight|\bwar\b|arrow|shield/, '⚔'],
  [/tavern|\binn\b|\bale\b|beer|\bpub\b|mug|tankard|cutlery/, '🍺'], [/crowd|people|chatter|market|murmur|town|city/, '👥'],
  [/rain|drizzle/, '🌧'], [/thunder|storm|lightning/, '⛈'], [/wind|gust|breeze/, '💨'], [/fire|flame|hearth|campfire|torch/, '🔥'],
  [/sea|ocean|wave|water|river|stream|brook|lake|shore/, '🌊'], [/forest|woods\b|woodland|tree|jungle/, '🌲'], [/bird|chirp|\bowls?\b|\bcrows?\b|raven/, '🐦'],
  [/night|cricket|insect/, '🌙'], [/cave|dungeon|drip|crypt|tomb/, '🕳'], [/horror|creepy|spooky|ghost|haunt/, '👻'],
  [/snow|ice|blizzard|cold/, '❄'], [/room|tone|hall/, '🏠'], [/music|song|theme|tune|lute|harp|bard|drum|jig|ballad|ambient|score/, '🎵'],
];
const COLORS = ['#e0a040', '#57a5e0', '#57c785', '#c76ad6', '#e06060', '#4fc1b9', '#d6b44f', '#8c8fe0', '#e0805a', '#7fb35a'];
const guessIcon = (name, fallback) => ICONS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? fallback;
const colorFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
/** A display name from a file name: "tavern_crowd-3f2a1c.ogg" → "tavern crowd". */
export const soundName = (file) => decodeURIComponent(String(file).split('/').pop()).replace(/\.[^.]+$/, '').replace(/-[0-9a-f]{6}$/, '').replace(/[-_]+/g, ' ').trim() || 'Sound';
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const byOrder = (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name));

export class Soundboard {
  constructor(api) {
    this.api = api;
    this.ctx = null;
    this.nodes = new Map();      // layer id → { el, source, gain, src, started, fade }
    this.buffers = new Map();    // one-shot src → Promise<AudioBuffer>
    this.loops = new Map();      // looping layer src → Promise<seamless AudioBuffer | null (too big)>
    this.views = new Set();      // containers showing the board (sidebar panel, big window)
    this.dragging = false;       // a slider is held: don't redraw under it
    this.pending = false;
    this.sendTimers = new Map();
    this.library = null;         // cached /api/sounds list
    this.local = 0.8;
    try { const v = localStorage.getItem(LOCAL_KEY); if (v != null) this.local = clamp01(v); } catch { /* storage blocked */ }

    hooks.on('ready', () => { this.sync(); this.redraw(); });
    hooks.on('op', (op) => {
      if (op.op === 'world_update' && op.patch?.settings?.core?.soundboard !== undefined) { this.sync(); this.redraw(); }
    });
    api.socket.on(SHOT_CHANNEL, (p, from) => {
      if (store.world?.users?.[from]?.role === 'gm' && p?.src) this.playShot(p.src, p.volume);
    });
    // Browsers keep sound off until the page is clicked; start then.
    const wake = () => this.wake();
    addEventListener('pointerdown', wake, true);
    addEventListener('keydown', wake, true);
    addEventListener('pointerup', () => { if (this.dragging) { this.dragging = false; if (this.pending) this.redraw(); } }, true);
  }

  get board() { return store.world?.settings?.core?.soundboard ?? {}; }
  get layers() { return Object.values(this.board.layers ?? {}).filter((l) => l && l.src).sort(byOrder); }
  get pads() { return Object.values(this.board.pads ?? {}).filter((p) => p && p.src).sort(byOrder); }
  get presets() { return Object.values(this.board.presets ?? {}).filter(Boolean).sort(byOrder); }
  fadeSecs() { const f = Number(this.board.fade); return Number.isFinite(f) ? Math.max(0, Math.min(20, f)) : 2; }

  // ------------------------------------------------------------------ audio graph

  context() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return null;
    this.ctx = new Ctx();
    this.localGain = this.ctx.createGain();
    this.localGain.gain.value = this.local;
    this.localGain.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = clamp01(this.board.master ?? 0.8);
    this.master.connect(this.localGain);
    // Looped buffers stand still while the context is suspended: put them back in step when it runs.
    this.ctx.addEventListener('statechange', () => this.reseat());
    return this.ctx;
  }

  wake() {
    const ctx = this.ctx;
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    for (const n of this.nodes.values()) if (n.el && n.wanted && n.el.paused && n.ready && !n.ended) this.start(n);
    this.reseat();
  }

  /** Seconds since a layer started (server clock), as everyone hears it. */
  elapsed(n) { return Math.max(0, (Date.now() - (n.started || Date.now())) / 1000); }

  /** Start looped layers that were waiting for sound to be allowed, and re-seek any that fell behind. */
  reseat() {
    const ctx = this.ctx;
    if (ctx?.state !== 'running') return;
    for (const n of this.nodes.values()) {
      if (n.random || !n.buffer || !n.wanted || n.ended) continue;
      if (!n.source) { this.playBuffer(n); continue; }
      if (!n.loop) continue;
      const d = n.buffer.duration;
      const off = ((n.offset + ctx.currentTime - n.at) % d) - (this.elapsed(n) % d);
      const drift = Math.abs(off - d * Math.round(off / d));
      if (drift > 0.2) this.playBuffer(n);
    }
  }

  ramp(param, to, secs) {
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    if (secs <= 0.01) param.setValueAtTime(to, t);
    else param.linearRampToValueAtTime(to, t + secs);
  }

  start(n) {
    const p = n.el.play();
    p?.catch((err) => { if (err?.name === 'NotAllowedError') this.api.audio?.showUnlock(); });
  }

  /** Make this browser's mix match the board. */
  sync() {
    if (!store.world) return;
    const want = new Map(this.layers.filter((l) => l.playing).map((l) => [l.id, l]));
    if (!want.size && !this.nodes.size) return;
    const ctx = this.context();
    if (!ctx) return;
    // Not allowed to make sound until the page is clicked: offer the button.
    if (ctx.state === 'suspended' && want.size) {
      ctx.resume().catch(() => {});
      setTimeout(() => { if (ctx.state === 'suspended') this.api.audio?.showUnlock(); }, 300);
    }
    const fade = this.fadeSecs();
    this.ramp(this.master.gain, clamp01(this.board.master ?? 0.8), 0.15);
    for (const [id, n] of this.nodes) {
      const l = want.get(id);
      if (!l || l.src !== n.src || !!l.random !== !!n.random || (l.started && l.started !== n.started)) this.retire(id, n, fade);
    }
    for (const [id, l] of want) {
      let n = this.nodes.get(id);
      const target = l.muted ? 0 : clamp01(l.volume ?? 0.8);
      if (!n) {
        n = this.create(l, target, fade);
        this.nodes.set(id, n);
        continue;
      }
      if (n.random) {
        n.target = target;
        if (n.ready) this.ramp(n.gain.gain, target, 0.15);
        const [min, max] = waits(l);
        if (min !== n.min || max !== n.max) { n.min = min; n.max = max; this.scheduleRandom(n); }
        continue;
      }
      n.loop = l.loop !== false;
      if (n.el) n.el.loop = n.loop;
      else if (n.source) n.source.loop = n.loop;
      n.target = target;
      if (n.ready && !n.ended) this.ramp(n.gain.gain, target, 0.15);
    }
    // Forget decoded loops nothing on the board uses any more.
    for (const src of this.loops.keys()) {
      if (!this.layers.some((l) => l.src === src) && ![...this.nodes.values()].some((n) => n.src === src)) this.loops.delete(src);
    }
  }

  /** A layer's sound: looping layers through a seamless buffer, the rest (or if that fails) through <audio>. */
  create(l, target, fade) {
    if (l.random) return this.createRandom(l, target, fade);
    if (l.loop === false) return this.createElement(l, target, fade);
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const n = { buffer: null, source: null, gain, src: l.src, started: l.started ?? 0, loop: true, wanted: true, ready: false, ended: false, target, fade, offset: 0, at: 0 };
    const fallback = () => {
      if (!n.wanted) return;
      n.wanted = false;
      gain.disconnect();
      if (this.nodes.get(l.id) === n) this.nodes.set(l.id, this.createElement(l, n.target, fade));
    };
    this.loopBuffer(l.src).then((buf) => {
      if (!n.wanted) return;
      if (!buf) { fallback(); return; }
      n.buffer = buf;
      if (ctx.state === 'running') this.playBuffer(n);   // otherwise reseat() starts it once sound is allowed
    }, fallback);
    return n;
  }

  /** Fetch and decode a looping file once (null: too big to hold decoded). */
  loopBuffer(src) {
    let p = this.loops.get(src);
    if (!p) {
      p = fetch(src)
        .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.arrayBuffer(); })
        .then((b) => (b.byteLength > MAX_LOOP_BYTES ? null : this.ctx.decodeAudioData(b).then((buf) => seamless(this.ctx, buf))));
      this.loops.set(src, p);
      p.catch(() => { if (this.loops.get(src) === p) this.loops.delete(src); });
    }
    return p;
  }

  /** (Re)start a buffer layer at the point everyone else is at. */
  playBuffer(n) {
    const ctx = this.ctx;
    const d = n.buffer.duration;
    const elapsed = this.elapsed(n);
    if (!n.loop && elapsed >= d - 0.25) { n.ended = true; this.redraw(); return; }
    const offset = n.loop ? elapsed % d : elapsed;
    const s = ctx.createBufferSource();
    s.buffer = n.buffer;
    s.loop = n.loop;
    s.connect(n.gain);
    s.start(0, offset);
    s.onended = () => { if (n.source === s && n.wanted) { n.ended = true; this.redraw(); } };
    const old = n.source;
    n.source = s;
    n.offset = offset;
    n.at = ctx.currentTime;
    if (old) { old.onended = null; try { old.stop(); } catch { /* not started */ } old.disconnect(); }
    if (!n.ready) {
      n.ready = true;
      // Just started: fade in. Joining a layer that's been going a while: come in quickly.
      this.ramp(n.gain.gain, n.target, elapsed < n.fade + 1 ? n.fade : 0.4);
    }
  }

  /**
   * A random layer: a one-shot played over and over with a random wait between plays.
   * The waits come from a generator seeded with the layer's id and start time, so every
   * browser works out the same plays at the same moments without any messages.
   */
  createRandom(l, target, fade) {
    const gain = this.ctx.createGain();
    gain.gain.value = target;
    gain.connect(this.master);
    const [min, max] = waits(l);
    const n = { random: true, buffer: null, gain, src: l.src, id: l.id, started: l.started ?? Date.now(), min, max, wanted: true, ready: false, ended: false, target, fade, timer: 0, last: -Infinity, sources: new Set() };
    this.shotBuffer(l.src).then((buf) => {
      if (!n.wanted) return;
      n.buffer = buf;
      // The same length everywhere (decoders at different rates differ by a sample or so).
      n.dur = Math.round(buf.duration * 10) / 10;
      n.ready = true;
      this.scheduleRandom(n);
    }, () => { if (n.wanted) toast(`Couldn't play "${l.name}".`, 'error'); });
    return n;
  }

  /** When the next play of a random layer starts (ms, server clock): the one playing now, or the next. */
  nextRandom(n) {
    const rnd = seededRandom(`${n.id}:${n.started}`);
    const now = Date.now();
    // The first play comes within the minimum wait; after that, each sound ends, then waits min–max.
    let t = n.started + rnd() * n.min * 1000;
    while (t + n.dur * 1000 <= now || t <= n.last) t += Math.max(0.5, n.dur + n.min + rnd() * (n.max - n.min)) * 1000;
    return t;
  }

  scheduleRandom(n) {
    clearTimeout(n.timer);
    if (!n.wanted || !n.buffer) return;
    const t = this.nextRandom(n);
    n.next = t;
    // Wake a little early and start it on the audio clock at the exact moment.
    n.timer = setTimeout(() => {
      if (!n.wanted) return;
      n.last = t;
      const late = (Date.now() - t) / 1000;
      if (this.ctx.state === 'running' && late < n.buffer.duration - 0.25) {
        const s = this.ctx.createBufferSource();
        s.buffer = n.buffer;
        s.connect(n.gain);
        s.start(this.ctx.currentTime + Math.max(0, -late), Math.max(0, late));
        n.sources.add(s);
        setTimeout(() => this.markSounding(n), Math.max(0, -late * 1000));
        s.onended = () => { n.sources.delete(s); s.disconnect(); this.markSounding(n); };
      }
      this.scheduleRandom(n);
    }, Math.max(0, t - Date.now() - 150));
  }

  /** Light up a random layer's card while it's sounding. */
  markSounding(n) {
    for (const c of document.querySelectorAll(`.sb-card[data-layer="${CSS.escape(n.id)}"]`)) c.classList.toggle('sounding', n.wanted && n.sources.size > 0);
  }

  /** Fetch and decode a one-shot once. */
  shotBuffer(src) {
    if (!this.buffers.has(src)) {
      const p = fetch(src).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.arrayBuffer(); }).then((b) => this.ctx.decodeAudioData(b));
      this.buffers.set(src, p);
      p.catch(() => { if (this.buffers.get(src) === p) this.buffers.delete(src); });
    }
    return this.buffers.get(src);
  }

  createElement(l, target, fade) {
    const ctx = this.ctx;
    const a = new window.Audio();
    // Same-origin files feed Web Audio as they are; others need CORS.
    try { if (new URL(l.src, location.href).origin !== location.origin) a.crossOrigin = 'anonymous'; } catch { /* odd URL */ }
    a.preload = 'auto';
    a.loop = l.loop !== false;
    a.src = l.src;
    const source = ctx.createMediaElementSource(a);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(this.master);
    const n = { el: a, source, gain, src: l.src, started: l.started ?? 0, loop: a.loop, wanted: true, ready: false, ended: false, target, fade };
    a.addEventListener('loadedmetadata', () => {
      if (!n.wanted) return;
      const elapsed = Math.max(0, (Date.now() - (n.started || Date.now())) / 1000);
      const d = a.duration;
      if (Number.isFinite(d) && d > 0) {
        if (a.loop) a.currentTime = elapsed % d;
        else if (elapsed < d - 0.25) a.currentTime = elapsed;
        else { n.ended = true; return; }
      }
      n.ready = true;
      // Just started: fade in. Joining a layer that's been going a while: come in quickly.
      this.ramp(gain.gain, n.target, elapsed < fade + 1 ? fade : 0.4);
      this.start(n);
    }, { once: true });
    a.addEventListener('ended', () => { n.ended = true; this.redraw(); });
    a.addEventListener('error', () => { if (n.wanted) toast(`Couldn't play "${l.name}".`, 'error'); });
    return n;
  }

  retire(id, n, fade) {
    this.nodes.delete(id);
    n.wanted = false;
    clearTimeout(n.timer);
    const sounding = n.ready && !n.ended && (n.el ? !n.el.paused : n.random ? n.sources.size > 0 : !!n.source);
    if (sounding) this.ramp(n.gain.gain, 0, fade);
    setTimeout(() => {
      for (const s of n.sources ?? []) { s.onended = null; try { s.stop(); } catch { /* done */ } s.disconnect(); }
      if (n.el) { n.el.pause(); n.el.removeAttribute('src'); n.el.load(); }
      if (n.source) { n.source.onended = null; try { n.source.stop(); } catch { /* not started */ } n.source.disconnect(); }
      n.gain.disconnect();
    }, (sounding ? fade : 0) * 1000 + 100);
  }

  /** Play a one-shot once over the mix. */
  async playShot(src, volume = 1) {
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const buf = await this.shotBuffer(src);
      const s = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = clamp01(volume);
      s.buffer = buf;
      s.connect(g).connect(this.master);
      s.start();
      s.onended = () => { s.disconnect(); g.disconnect(); };
    } catch {
      toast(`Couldn't play ${soundName(src)}.`, 'error');
    }
  }

  setLocalVolume(v) {
    this.local = clamp01(v);
    try { localStorage.setItem(LOCAL_KEY, String(this.local)); } catch { /* storage blocked */ }
    if (this.ctx) this.ramp(this.localGain.gain, this.local, 0.05);
  }

  /** For tests and the UI: is this layer audible here right now? */
  audible(id) {
    const n = this.nodes.get(id);
    if (!n || !n.ready || n.ended || n.gain.gain.value <= 0.001) return false;
    if (n.el) return !n.el.paused;
    return (n.random || !!n.source) && this.ctx.state === 'running';
  }

  // ------------------------------------------------------------------ GM actions

  send(patch) {
    return this.api.op({ op: 'world_update', patch: { settings: { core: { soundboard: patch } } } });
  }

  /** Volume sliders: hear it now, tell everyone a few times a second. */
  sendSoon(key, patch, now = false) {
    clearTimeout(this.sendTimers.get(key)?.t);
    const fire = () => { this.sendTimers.delete(key); this.send(patch); };
    if (now) { fire(); return; }
    const last = this.sendTimers.get(key)?.at ?? 0;
    if (Date.now() - last > 150) { this.send(patch); this.sendTimers.set(key, { at: Date.now() }); return; }
    this.sendTimers.set(key, { at: last, t: setTimeout(fire, 150) });
  }

  newLayer(src, name = soundName(src), random = false) {
    const id = newId();
    const sort = Math.max(0, ...this.layers.map((l) => (l.sort ?? 0) + 1));
    const layer = { name, src, icon: guessIcon(name, random ? '🎲' : '🎵'), color: colorFor(name), volume: 0.8, loop: true, muted: false, playing: true, sort };
    if (random) Object.assign(layer, { random: true, minWait: WAIT_MIN, maxWait: WAIT_MAX });
    return { id, layer };
  }

  /** Add sounds to the mix: as looping layers, or (`random`) as one-shots that repeat at random. */
  addLayers(sounds, { random = false } = {}) {
    const layers = {};
    let sort = Math.max(0, ...this.layers.map((l) => (l.sort ?? 0) + 1));
    for (const s of sounds) { const { id, layer } = this.newLayer(s.src, s.name, random); layer.sort = sort++; layers[id] = layer; }
    if (Object.keys(layers).length) this.send({ layers });
  }

  addPads(sounds) {
    const pads = {};
    let sort = Math.max(0, ...this.pads.map((p) => (p.sort ?? 0) + 1));
    for (const s of sounds) {
      const name = s.name ?? soundName(s.src);
      const id = newId();
      pads[id] = { id, name, src: s.src, icon: guessIcon(name, '🔊'), color: colorFor(name), volume: 1, sort: sort++ };
    }
    if (Object.keys(pads).length) this.send({ pads });
  }

  setLayer(id, patch) { this.send({ layers: { [id]: patch } }); }
  removeLayer(id) { this.send({ layers: { [id]: null } }); }
  stopAll() {
    const layers = {};
    for (const l of this.layers) if (l.playing) layers[l.id] = { playing: false };
    if (Object.keys(layers).length) this.send({ layers });
  }

  fire(pad) { this.api.socket.emit(SHOT_CHANNEL, { src: pad.src, volume: pad.volume ?? 1 }); }

  /** The current mix as a preset's layers. */
  snapshot() {
    const out = {};
    for (const l of this.layers) {
      const { playing, started, ...keep } = l;
      out[l.id] = { ...keep, on: !!playing };
    }
    return out;
  }

  savePreset(name) {
    const id = newId();
    const sort = Math.max(0, ...this.presets.map((p) => (p.sort ?? 0) + 1));
    this.send({ presets: { [id]: { id, name, sort, master: clamp01(this.board.master ?? 0.8), layers: this.snapshot() } }, preset: id });
    toast(`Saved the preset "${name}".`);
  }

  /** Re-save a preset with the current mix (layers no longer in the mix leave it). */
  overwritePreset(p) {
    const layers = this.snapshot();
    for (const id of Object.keys(p.layers ?? {})) if (!(id in layers)) layers[id] = null;
    this.send({ presets: { [p.id]: { master: clamp01(this.board.master ?? 0.8), layers } }, preset: p.id });
    toast(`Updated "${p.name}".`);
  }

  /** Switch to a preset: its layers fade in, the others fade out; shared ones carry on. */
  recall(p) {
    const layers = {};
    for (const l of this.layers) if (!p.layers?.[l.id]) layers[l.id] = null;
    for (const [id, l] of Object.entries(p.layers ?? {})) {
      if (!l) continue;
      const { on, ...keep } = l;
      layers[id] = { ...keep, id, playing: !!on };
    }
    const patch = { layers, preset: p.id };
    if (p.master != null) patch.master = p.master;
    this.send(patch);
  }

  /** Does the mix still match the preset it came from? */
  matches(p) {
    if (!p) return false;
    const cur = this.snapshot();
    const saved = Object.entries(p.layers ?? {}).filter(([, l]) => l);
    if (saved.length !== Object.keys(cur).length) return false;
    return saved.every(([id, l]) => {
      const c = cur[id];
      return c && c.src === l.src && c.on === !!l.on && c.loop === l.loop && !!c.muted === !!l.muted && Math.abs((c.volume ?? 0) - (l.volume ?? 0)) < 0.01
        && !!c.random === !!l.random && (!c.random || (c.minWait === l.minWait && c.maxWait === l.maxWait));
    });
  }

  // ------------------------------------------------------------------ files

  async uploadFiles(files, folder = 'sounds') {
    const audio = [...files].filter((f) => AUDIO_FILE.test(f.name));
    if (!audio.length) { toast('No audio files there (mp3, ogg, opus, m4a, flac, wav, webm).'); return []; }
    const out = [];
    const note = el('div.toast.info', { text: `Uploading ${audio.length} sound${audio.length === 1 ? '' : 's'}…` });
    document.getElementById('toasts')?.append(note);
    for (const [i, f] of audio.entries()) {
      // A file picked from a folder keeps its subfolder: sounds/<folder>/<sub>/…
      const rel = (f.webkitRelativePath || '').split('/').slice(0, -1).join('/');
      const dir = [folder, rel].filter(Boolean).join('/');
      note.textContent = `Uploading ${i + 1} of ${audio.length}: ${f.name}`;
      try {
        const body = new FormData();
        body.append('file', f);
        const res = await fetch(`/api/upload?folder=${encodeURIComponent(dir)}`, { method: 'POST', body, headers: { 'x-hearth-session': this.api.session ?? '' } });
        if (!res.ok) throw new Error(await res.text());
        out.push({ src: (await res.json()).url, name: soundName(f.name) });
      } catch (err) { toast(`${f.name}: ${err.message ?? err}`, 'error'); }
    }
    note.remove();
    this.library = null;
    if (out.length) toast(`Uploaded ${out.length} sound${out.length === 1 ? '' : 's'}.`);
    return out;
  }

  /** Pick files (or a whole folder) from this computer and upload them. */
  pickFiles({ folder = false } = {}) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true });
      if (folder) input.webkitdirectory = true;
      input.addEventListener('change', async () => { input.remove(); resolve(input.files?.length ? await this.uploadFiles(input.files) : []); });
      input.addEventListener('cancel', () => { input.remove(); resolve([]); });
      document.body.append(input);
      input.click();
    });
  }

  async loadLibrary(force = false) {
    if (this.library && !force) return this.library;
    const res = await fetch('/api/sounds', { headers: { 'x-hearth-session': this.api.session ?? '' } });
    if (!res.ok) throw new Error(await res.text());
    this.library = await res.json();
    return this.library;
  }

  /**
   * The sound library: every audio file in the world's assets, by folder.
   * `as`: 'layer', 'random' or 'pad' — what the + buttons add.
   */
  async openLibrary(as = 'layer') {
    const win = openWindow({ id: 'sound-library', title: 'Sound library', width: 520, height: 560 });
    const search = el('input', { type: 'search', placeholder: 'Search sounds…', 'aria-label': 'Search sounds' });
    const mode = el('select', { 'aria-label': 'Add as' },
      el('option', { value: 'layer', text: 'Add as layers', selected: as === 'layer' }),
      el('option', { value: 'random', text: 'Add as random sounds', selected: as === 'random' }),
      el('option', { value: 'pad', text: 'Add as one-shot pads', selected: as === 'pad' }));
    const list = el('div.sb-library');
    let audition = null;
    const stopAudition = () => { audition?.pause(); audition = null; };
    win.onClose(stopAudition);
    const add = (items) => { if (mode.value === 'pad') this.addPads(items); else this.addLayers(items, { random: mode.value === 'random' }); toast(`Added ${items.length === 1 ? `"${items[0].name}"` : `${items.length} sounds`}.`); };
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const items = (this.library ?? []).filter((s) => !q || `${s.folder}/${s.name}`.toLowerCase().includes(q));
      const groups = new Map();
      for (const s of items) { if (!groups.has(s.folder)) groups.set(s.folder, []); groups.get(s.folder).push(s); }
      if (!items.length) {
        list.replaceChildren(el('p.muted', { text: this.library?.length ? 'Nothing matches.' : 'No sounds yet. Upload some, or copy a folder of audio into this world\'s assets folder (worlds/<world>/assets/sounds/…) and press Refresh.' }));
        return;
      }
      list.replaceChildren(...[...groups].map(([folder, sounds]) => el('details.sb-folder', { open: !!q || groups.size <= 3 },
        el('summary', {}, el('span.grow', { text: `📁 ${folder || '(assets)'}` }), el('small.muted', { text: ` ${sounds.length}` }),
          el('button.small', { text: '+ all', title: `Add all ${sounds.length}`, on: { click: (e) => { e.preventDefault(); add(sounds.map((s) => ({ src: s.url, name: soundName(s.name) }))); } } })),
        el('ul.entity-list', {}, sounds.map((s) => el('li.entity', {},
          el('button.icon', { title: 'Listen (just you)', text: '▶', on: { click: (e) => {
            const playing = audition && audition.dataset.src === s.url;
            stopAudition();
            list.querySelectorAll('.auditioning').forEach((b) => { b.classList.remove('auditioning'); b.textContent = '▶'; });
            if (playing) return;
            audition = new window.Audio(s.url);
            audition.dataset.src = s.url;
            audition.volume = this.local;
            audition.play().catch(() => {});
            e.target.classList.add('auditioning');
            e.target.textContent = '■';
            audition.onended = () => { e.target.classList.remove('auditioning'); e.target.textContent = '▶'; };
          } } }),
          el('span.grow', { text: soundName(s.name), title: s.name }),
          el('small.muted', { text: `${Math.max(1, Math.round(s.bytes / 1024))} KB` }),
          el('button.small', { text: '+', title: 'Add', on: { click: () => add([{ src: s.url, name: soundName(s.name) }]) } })))))));
    };
    const refresh = async (force) => {
      list.replaceChildren(el('p.muted', { text: 'Loading…' }));
      try { await this.loadLibrary(force); } catch (err) { list.replaceChildren(el('p.muted', { text: `Couldn't list sounds: ${err.message ?? err}` })); return; }
      draw();
    };
    const upload = async (folder) => { const got = await this.pickFiles({ folder }); if (got.length) { add(got); refresh(true); } };
    search.addEventListener('input', draw);
    win.body.replaceChildren(el('div.sb-library-win', {},
      el('div.row', {}, search, mode),
      el('div.row', {},
        el('button', { text: '⬆ Upload files…', on: { click: () => upload(false) } }),
        el('button', { text: '📁 Import folder…', title: 'Upload every audio file in a folder (and its subfolders)', on: { click: () => upload(true) } }),
        el('button', { text: '⟳ Refresh', on: { click: () => refresh(true) } })),
      list));
    refresh(false);
  }

  // ------------------------------------------------------------------ UI

  /** Show the board in a container (the sidebar panel or the big window). */
  mount(container) {
    this.views.add(container);
    this.render(container);
  }

  redraw() {
    if (this.dragging) { this.pending = true; return; }
    this.pending = false;
    for (const v of this.views) {
      if (!v.isConnected) { this.views.delete(v); continue; }
      this.render(v);
    }
  }

  openBig() {
    const win = openWindow({ id: 'soundboard', title: 'Soundboard', width: Math.min(900, innerWidth - 40), height: Math.min(720, innerHeight - 80) });
    const body = el('div.soundboard.big');
    win.body.replaceChildren(body);
    win.onClose(() => this.views.delete(body));
    this.mount(body);
  }

  slider({ value, label, onInput, onChange, cls = '' }) {
    return el(`input.sb-slider${cls}`, {
      type: 'range', min: 0, max: 1, step: 0.01, value, 'aria-label': label, title: label,
      on: {
        pointerdown: () => { this.dragging = true; },
        input: (e) => onInput(Number(e.target.value)),
        change: (e) => { this.dragging = false; onChange?.(Number(e.target.value)); if (this.pending) setTimeout(() => this.redraw(), 0); },
      },
    });
  }

  render(root) {
    if (!store.world) return;
    root.classList.add('soundboard');
    const gm = isGM();
    const mine = el('label.sb-local', {}, el('span', { text: '🔊 Your soundboard volume' }),
      this.slider({ value: this.local, label: 'Your soundboard volume', onInput: (v) => this.setLocalVolume(v) }));
    if (!gm) {
      const playing = this.layers.filter((l) => l.playing && !l.muted);
      root.replaceChildren(mine,
        el('h3', { text: 'Now playing' }),
        playing.length
          ? el('div.sb-now', {}, playing.map((l) => el('span.sb-chip', { style: `--c:${l.color ?? '#888'}` }, `${l.icon ?? '🎵'} ${l.name}`)))
          : el('p.muted', { text: 'Nothing is playing.' }));
      return;
    }
    const b = this.board;
    const big = root.classList.contains('big');
    const fade = this.fadeSecs();
    const active = b.preset && b.presets?.[b.preset];
    const head = el('div.sb-head', {},
      el('label.sb-master', {}, el('span', { text: 'Master' }),
        this.slider({ value: clamp01(b.master ?? 0.8), label: 'Master volume (everyone)',
          onInput: (v) => { if (this.ctx) this.ramp(this.master.gain, v, 0.05); this.sendSoon('master', { master: v }); },
          onChange: (v) => this.sendSoon('master', { master: v }, true) })),
      el('button', { text: '■ Stop all', title: `Fade everything out (${fade}s)`, on: { click: () => this.stopAll() } }),
      big ? null : el('button', { text: '⤢ Big board', title: 'Open the soundboard in a big window', on: { click: () => this.openBig() } }));

    // Layers: loops, and random one-shots. Both are part of the mix (and of presets).
    const cardGrid = (random) => {
      const grid = el('div.sb-cards', {
        on: {
          dragover: (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); grid.classList.add('drop'); } },
          dragleave: () => grid.classList.remove('drop'),
          drop: async (e) => { e.preventDefault(); grid.classList.remove('drop'); const got = await this.uploadFiles(e.dataTransfer.files); this.addLayers(got, { random }); },
        },
      }, this.layers.filter((l) => !!l.random === random).map((l) => this.layerCard(l)),
      random
        ? el('button.sb-card.sb-add', { title: 'Add a sound that plays now and then, with a random wait between plays (or drop audio files here)', on: { click: () => this.openLibrary('random') } }, el('span.sb-add-plus', { text: '+' }), el('span', { text: 'Add random sound' }))
        : el('button.sb-card.sb-add', { title: 'Add a layer from the library or your computer (or drop audio files here)', on: { click: () => this.openLibrary('layer') } }, el('span.sb-add-plus', { text: '+' }), el('span', { text: 'Add layer' })));
      return grid;
    };
    const cards = cardGrid(false);
    const randoms = cardGrid(true);

    // Presets
    const presets = el('div.sb-presets', {},
      this.presets.map((p) => {
        const isActive = active && p.id === b.preset;
        const changed = isActive && !this.matches(p);
        return el('div.sb-preset', { class: `sb-preset${isActive ? ' active' : ''}` },
          el('button.sb-preset-go', { title: `Switch to "${p.name}" (crossfade ${fade}s)`, on: { click: () => this.recall(p) } },
            el('span', { text: isActive ? '▶' : '▷' }), el('span.grow', { text: p.name }),
            el('small.muted', { text: changed ? 'changed' : `${Object.values(p.layers ?? {}).filter(Boolean).length} layers` })),
          el('button.icon', { title: 'Save the current mix into this preset', text: '💾', on: { click: () => this.overwritePreset(p) } }),
          el('button.icon', { title: 'Rename', text: '✎', on: { click: async () => {
            const v = await formDialog({ title: 'Rename preset', fields: [{ name: 'name', label: 'Name', value: p.name, required: true }] });
            if (v?.name?.trim()) this.send({ presets: { [p.id]: { name: v.name.trim() } } });
          } } }),
          el('button.icon', { title: 'Delete', text: '✕', on: { click: () => { if (confirm(`Delete the preset "${p.name}"? The sounds stay in the library.`)) this.send({ presets: { [p.id]: null }, ...(isActive ? { preset: null } : {}) }); } } }));
      }),
      this.presets.length ? null : el('p.muted', { text: 'Build a mix, then save it here to bring it back with one click.' }),
      el('div.row', {},
        el('button', { text: '+ Save mix as preset', disabled: !this.layers.length, on: { click: async () => {
          const v = await formDialog({ title: 'Save the mix as a preset', fields: [{ name: 'name', label: 'Name', value: '', required: true }], submit: 'Save' });
          if (v?.name?.trim()) this.savePreset(v.name.trim());
        } } }),
        el('label.sb-fade', { title: 'Seconds to fade layers in and out, and to crossfade between presets' }, 'Fade',
          el('input', { type: 'number', min: 0, max: 20, step: 0.5, value: fade, 'aria-label': 'Fade seconds', on: { change: (e) => this.send({ fade: Math.max(0, Math.min(20, Number(e.target.value) || 0)) }) } }), 's')));

    // One-shots
    const pads = el('div.sb-pads', {
      on: {
        dragover: (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); pads.classList.add('drop'); } },
        dragleave: () => pads.classList.remove('drop'),
        drop: async (e) => { e.preventDefault(); pads.classList.remove('drop'); this.addPads(await this.uploadFiles(e.dataTransfer.files)); },
      },
    }, this.pads.map((p) => el('button.sb-pad', {
      style: `--c:${p.color ?? '#888'}`, title: `${p.name} — click to play for everyone · right-click to edit`,
      on: {
        click: (e) => { this.fire(p); e.currentTarget.classList.remove('hit'); void e.currentTarget.offsetWidth; e.currentTarget.classList.add('hit'); },
        contextmenu: (e) => { e.preventDefault(); this.editPad(p); },
      },
    }, el('span.sb-pad-icon', { text: p.icon ?? '🔊' }), el('span.sb-pad-name', { text: p.name }),
    el('span.sb-pad-edit', { text: '✎', title: 'Edit', on: { click: (e) => { e.stopPropagation(); this.editPad(p); } } }))),
    el('button.sb-pad.sb-add', { title: 'Add a one-shot (or drop audio files here)', on: { click: () => this.openLibrary('pad') } }, el('span.sb-pad-icon', { text: '+' }), el('span.sb-pad-name', { text: 'Add' })));

    const section = (title, extra, body) => el('section.sb-section', {}, el('div.sb-section-head', {}, el('h3', { text: title }), extra), body);
    const library = el('button.small', { text: '🎧 Library', title: 'Browse, upload and import sounds', on: { click: () => this.openLibrary('layer') } });
    const parts = [
      head,
      section('Mix', library, cards),
      section('Random', el('small.muted', { text: 'plays now and then, at random' }), randoms),
      section('One-shots', el('small.muted', { text: 'plays once over the mix' }), pads),
      section('Presets', null, presets),
      el('details.sb-mine', {}, el('summary', { text: 'Your own volume' }), mine),
    ];
    root.replaceChildren(...(big ? [head, el('div.sb-big-grid', {}, el('div', {}, parts[1], parts[2]), el('div', {}, parts[3], parts[4], parts[5]))] : parts));
  }

  layerCard(l) {
    const n = this.nodes.get(l.id);
    const ended = l.playing && n?.ended;
    const state = !l.playing ? 'stopped' : ended ? 'ended' : l.muted ? 'muted' : 'playing';
    const [min, max] = waits(l);
    const span = min === max ? `${min} s` : `${min}–${max} s`;
    const status = state === 'playing' ? (l.random ? `on · waits ${span}` : 'playing') : state === 'muted' ? 'muted' : state === 'ended' ? 'finished' : l.random ? `off · waits ${span}` : 'stopped';
    const tools = l.random
      ? el('button.sb-toggle.on', { title: 'Seconds of quiet after each play: a random time between these two', text: `⏱ ${span}`, on: { click: () => this.editWaits(l) } })
      : el('button.sb-toggle', { class: `sb-toggle${l.loop !== false ? ' on' : ''}`, title: l.loop !== false ? 'Loops (click to play once)' : 'Plays once (click to loop)', text: '⟳ Loop', on: { click: () => this.setLayer(l.id, { loop: l.loop === false }) } });
    return el('div.sb-card', { class: `sb-card ${state}${l.random ? ' random' : ''}${n?.sources?.size ? ' sounding' : ''}`, style: `--c:${l.color ?? '#888'}`, 'data-layer': l.id },
      el('div.sb-card-top', {},
        el('button.sb-play', {
          title: l.playing ? 'Stop (fade out)' : 'Play (fade in)', 'aria-label': `${l.playing ? 'Stop' : 'Play'} ${l.name}`,
          on: { click: () => this.setLayer(l.id, l.playing && !ended ? { playing: false } : { playing: true, restart: true }) },
        }, el('span.sb-icon', { text: l.icon ?? '🎵' }), el('span.sb-state', { text: l.playing && !ended ? '■' : '▶' })),
        el('div.sb-card-title', {}, el('strong', { text: l.name, title: l.name }),
          el('small.muted', { text: status })),
        el('span.sb-eq', { 'aria-hidden': 'true' }, el('i'), el('i'), el('i'))),
      this.slider({ value: clamp01(l.volume ?? 0.8), label: `${l.name} volume`,
        onInput: (v) => { if (n?.ready && !l.muted) this.ramp(n.gain.gain, v, 0.05); this.sendSoon(`v-${l.id}`, { layers: { [l.id]: { volume: v } } }); },
        onChange: (v) => this.sendSoon(`v-${l.id}`, { layers: { [l.id]: { volume: v } } }, true) }),
      el('div.sb-card-tools', {},
        tools,
        el('button.sb-toggle', { class: `sb-toggle${l.muted ? ' on warn' : ''}`, title: l.muted ? 'Unmute' : 'Mute (keeps its place)', text: l.muted ? '🔇 Muted' : '🔈 Mute', on: { click: () => this.setLayer(l.id, { muted: !l.muted }) } }),
        el('button.icon', { title: 'Edit', text: '✎', on: { click: () => this.editLayer(l) } }),
        el('button.icon', { title: 'Remove from the mix', text: '✕', on: { click: () => this.removeLayer(l.id) } })));
  }

  waitFields(l) {
    const [min, max] = waits(l);
    return [
      { name: 'minWait', label: 'Shortest wait after each play (seconds)', type: 'number', min: 0, max: 3600, step: 1, value: min },
      { name: 'maxWait', label: 'Longest wait (seconds)', type: 'number', min: 0, max: 3600, step: 1, value: max },
    ];
  }

  /** Read the wait fields back: whole seconds, 0–3600, longest no shorter than shortest. */
  waitPatch(v) {
    const min = Math.max(0, Math.min(3600, Math.round(Number(v.minWait) || 0)));
    return { minWait: min, maxWait: Math.max(min, Math.min(3600, Math.round(Number(v.maxWait) || 0))) };
  }

  async editWaits(l) {
    const v = await formDialog({ title: `${l.name}: time between plays`, fields: this.waitFields(l), submit: 'Save' });
    if (v) this.setLayer(l.id, this.waitPatch(v));
  }

  async editLayer(l) {
    const v = await formDialog({
      title: `${l.random ? 'Random sound' : 'Layer'}: ${l.name}`,
      fields: [
        { name: 'name', label: 'Name', value: l.name, required: true },
        { name: 'icon', label: 'Icon (an emoji)', value: l.icon ?? '🎵' },
        { name: 'color', label: 'Colour', type: 'color', value: l.color ?? '#e0a040' },
        { name: 'src', label: 'Audio file', value: l.src, required: true },
        ...(l.random ? this.waitFields(l) : []),
      ],
    });
    if (!v) return;
    this.setLayer(l.id, { name: v.name.trim() || l.name, icon: v.icon.trim() || '🎵', color: v.color, src: v.src.trim() || l.src, ...(l.random ? this.waitPatch(v) : {}) });
  }

  async editPad(p) {
    const v = await formDialog({
      title: `One-shot: ${p.name}`,
      fields: [
        { name: 'name', label: 'Name', value: p.name, required: true },
        { name: 'icon', label: 'Icon (an emoji)', value: p.icon ?? '🔊' },
        { name: 'color', label: 'Colour', type: 'color', value: p.color ?? '#e0a040' },
        { name: 'volume', label: 'Volume (0–100)', type: 'number', min: 0, step: 5, value: Math.round((p.volume ?? 1) * 100) },
        { name: 'src', label: 'Audio file', value: p.src, required: true },
        { name: 'delete', label: 'Remove this pad', type: 'checkbox', value: false },
      ],
    });
    if (!v) return;
    if (v.delete) { this.send({ pads: { [p.id]: null } }); return; }
    this.send({ pads: { [p.id]: { name: v.name.trim() || p.name, icon: v.icon.trim() || '🔊', color: v.color, volume: clamp01(v.volume / 100), src: v.src.trim() || p.src } } });
  }
}
