// Sound: playlists the GM plays for everyone, and ambient sounds placed on
// the map.
//
// Playlist tracks carry a server timestamp (`started`), so everyone hears the
// same moment, including people who join late. When a non-looping track ends,
// one GM's browser moves the playlist on (next track, a random one, or stop).
//
// Ambient sounds loop; each token you control hears them louder the closer it
// is, out to the sound's radius, and walls that block sound cut them off. The
// GM hears from their selected tokens, or the middle of the view (or, with
// Preview, from the mouse).
//
// Everyone has their own volume for music, ambience and the map, kept in
// this browser.

import { hooks } from './hooks.js';
import { store, isGM, ownsActor } from './store.js';
import { el, toast, openWindow } from './ui.js';
import { segmentsCross, wallRules } from './vision.js';

const VOLUME_KEY = 'hearth.volume';

export class Audio {
  constructor(api) {
    this.api = api;
    this.tracks = new Map();   // 'playlistId/soundId' → { el, src }
    this.ambient = new Map();  // ambient sound id → { el, src, gain }
    this.preview = null;       // GM preview listening point (scene px), or null
    this.blocked = false;
    this.volume = { music: 0.6, ambience: 0.6, environment: 0.6 };
    try { Object.assign(this.volume, JSON.parse(localStorage.getItem(VOLUME_KEY) ?? '{}')); } catch { /* storage blocked */ }
    hooks.on('op', (op) => { if (/^(playlist_|sound_|scene_)/.test(op.op)) this.sync(); });
    hooks.on('ready', () => this.sync());
    hooks.on('board:view', () => this.sync());
    // Tokens move and the view pans all the time; re-mix a few times a second.
    setInterval(() => this.mixAmbient(), 200);
  }

  setVolume(kind, v) {
    this.volume[kind] = Math.max(0, Math.min(1, v));
    try { localStorage.setItem(VOLUME_KEY, JSON.stringify(this.volume)); } catch { /* storage blocked */ }
    this.sync();
  }

  // ------------------------------------------------------------------ playback helpers

  play(audioEl) {
    const p = audioEl.play();
    p?.catch((err) => { if (err?.name === 'NotAllowedError') this.showUnlock(); });
  }

  /** Browsers won't play sound until the page is clicked; offer a button. */
  showUnlock() {
    if (this.blocked) return;
    this.blocked = true;
    const b = el('button.sound-unlock', {
      text: '🔊 Click to turn on sound',
      on: {
        click: () => {
          this.blocked = false;
          b.remove();
          for (const t of [...this.tracks.values(), ...this.ambient.values()]) if (t.el.paused && t.wanted !== false) this.play(t.el);
        },
      },
    });
    document.getElementById('app').append(b);
  }

  // ------------------------------------------------------------------ playlists

  sync() {
    this.syncPlaylists();
    this.mixAmbient();
  }

  syncPlaylists() {
    const want = new Map();
    for (const pl of Object.values(store.world?.playlists ?? {})) {
      for (const s of Object.values(pl.sounds ?? {})) if (s.playing && s.src) want.set(`${pl.id}/${s.id}`, { pl, s });
    }
    for (const [key, t] of this.tracks) {
      const w = want.get(key);
      if (!w || w.s.src !== t.src || w.s.started !== t.started) {
        t.el.pause();
        t.el.src = '';
        this.tracks.delete(key);
      }
    }
    for (const [key, { pl, s }] of want) {
      const vol = s.volume * (pl.ambience ? this.volume.ambience : this.volume.music);
      let t = this.tracks.get(key);
      if (!t) {
        const a = new window.Audio();
        a.preload = 'auto';
        a.src = s.src;
        t = { el: a, src: s.src, started: s.started };
        this.tracks.set(key, t);
        a.addEventListener('loadedmetadata', () => {
          // Join the track where everyone else is.
          const elapsed = Math.max(0, (Date.now() - s.started) / 1000);
          if (Number.isFinite(a.duration) && a.duration > 0) {
            if (s.repeat) a.currentTime = elapsed % a.duration;
            else if (elapsed < a.duration - 0.25) a.currentTime = elapsed;
            else { this.trackEnded(pl.id, s.id); return; }
          }
          this.play(a);
        }, { once: true });
        a.addEventListener('ended', () => this.trackEnded(pl.id, s.id));
        a.addEventListener('error', () => toast(`Couldn't play "${s.name}".`, 'error'));
      }
      t.el.loop = !!s.repeat;
      t.el.volume = Math.max(0, Math.min(1, vol));
    }
  }

  /** One GM moves a playlist on when a track finishes. */
  trackEnded(playlistId, soundId) {
    if (!isGM()) return;
    const gms = (store.online ?? []).filter((id) => store.world.users[id]?.role === 'gm').sort();
    if (gms.length && gms[0] !== store.user.id) return; // another GM handles it
    const pl = store.world.playlists?.[playlistId];
    const cur = pl?.sounds?.[soundId];
    if (!cur?.playing || cur.repeat) return;
    const patch = { sounds: { [soundId]: { playing: false } } };
    if (pl.mode !== 'simultaneous') {
      const order = Object.values(pl.sounds).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      let next = null;
      if (pl.mode === 'shuffle') {
        const others = order.filter((x) => x.id !== soundId);
        next = others.length ? others[Math.floor(Math.random() * others.length)] : null;
      } else {
        next = order[order.findIndex((x) => x.id === soundId) + 1] ?? null;
      }
      if (next) patch.sounds[next.id] = { playing: true };
    }
    this.api.op({ op: 'playlist_update', id: playlistId, patch });
  }

  /** GM: play a playlist (first track, a random one, or all of them). */
  playPlaylist(id) {
    const pl = store.world.playlists[id];
    const order = Object.values(pl?.sounds ?? {}).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    if (!order.length) { toast('This playlist has no tracks yet.'); return; }
    const sounds = {};
    for (const s of order) sounds[s.id] = { playing: false };
    if (pl.mode === 'simultaneous') for (const s of order) sounds[s.id] = { playing: true };
    else sounds[(pl.mode === 'shuffle' ? order[Math.floor(Math.random() * order.length)] : order[0]).id] = { playing: true };
    this.api.op({ op: 'playlist_update', id, patch: { sounds } });
  }

  stopPlaylist(id) {
    const pl = store.world.playlists[id];
    const sounds = {};
    for (const s of Object.values(pl?.sounds ?? {})) if (s.playing) sounds[s.id] = { playing: false };
    if (Object.keys(sounds).length) this.api.op({ op: 'playlist_update', id, patch: { sounds } });
  }

  playTrack(playlistId, soundId, on = true) {
    const pl = store.world.playlists[playlistId];
    const sounds = { [soundId]: { playing: on } };
    // In a one-at-a-time playlist, starting a track stops the others.
    if (on && pl.mode !== 'simultaneous') for (const s of Object.values(pl.sounds)) if (s.playing && s.id !== soundId) sounds[s.id] = { playing: false };
    this.api.op({ op: 'playlist_update', id: playlistId, patch: { sounds } });
  }

  // ------------------------------------------------------------------ ambient sounds

  /** Where this user hears the map from (scene px). */
  listeners() {
    const b = this.api.board;
    const s = b?.scene;
    if (!s) return [];
    if (isGM()) {
      if (this.preview) return [this.preview];
      const sel = [...b.selected].map((id) => s.tokens[id]).filter(Boolean);
      if (sel.length) return sel.map((t) => b.center(t));
      const v = b.viewArea();
      return [{ x: b.cam.x + (v.left + v.width / 2) / b.cam.z, y: b.cam.y + (v.height / 2) / b.cam.z }];
    }
    return b.tokens().filter((t) => t.actor_id && ownsActor(t.actor_id) && !t.hidden).map((t) => b.center(t));
  }

  /** How loudly a listener hears a sound: 1 at the source, 0 at its radius or behind a wall. */
  gainAt(sound, p, segs) {
    const r = this.api.board.toPx(sound.radius);
    const d = Math.hypot(p.x - sound.x, p.y - sound.y);
    if (!(r > 0) || d >= r) return 0;
    if (sound.walls) {
      let limited = 0;
      for (const w of segs) {
        if (!segmentsCross(p, { x: sound.x, y: sound.y }, w.a, w.b)) continue;
        if (w.limited && ++limited < 2) continue;
        return 0;
      }
    }
    const g = 1 - d / r;
    return g * g * (3 - 2 * g); // ease out toward the edge
  }

  mixAmbient() {
    const b = this.api.board;
    const s = b?.scene;
    const sounds = Object.values(s?.sounds ?? {}).filter((x) => !x.off && x.src);
    const ids = new Set(sounds.map((x) => x.id));
    for (const [id, t] of this.ambient) {
      if (!ids.has(id) || t.src !== s.sounds[id].src) { t.el.pause(); t.el.src = ''; this.ambient.delete(id); }
    }
    if (!sounds.length) return;
    const segs = Object.values(s.walls ?? {}).flatMap((w) => {
      const { sound } = wallRules(w);
      return sound === 'pass' ? [] : [{ a: { x: w.a[0], y: w.a[1] }, b: { x: w.b[0], y: w.b[1] }, limited: sound === 'limited' }];
    });
    const ears = this.listeners();
    for (const x of sounds) {
      const gain = Math.max(0, ...ears.map((p) => this.gainAt(x, p, segs)));
      let t = this.ambient.get(x.id);
      if (!t && gain <= 0) continue;
      if (!t) {
        const a = new window.Audio();
        a.src = x.src;
        a.loop = true;
        a.volume = 0;
        t = { el: a, src: x.src, gain: 0 };
        this.ambient.set(x.id, t);
        this.play(a);
      }
      // Glide toward the new volume so moving tokens don't make it jump.
      t.gain += (gain - t.gain) * 0.5;
      if (Math.abs(gain - t.gain) < 0.01) t.gain = gain;
      t.el.volume = Math.max(0, Math.min(1, t.gain * (x.volume ?? 1) * this.volume.environment));
      if (t.el.paused && t.gain > 0 && !this.blocked) this.play(t.el);
    }
  }

  /** Is this ambient sound audible for this user right now? (for the UI and tests) */
  audible(id) { return (this.ambient.get(id)?.el.volume ?? 0) > 0; }
}

/** GM dialog for an ambient sound or playlist track: file, then settings. Resolves with the values or null. */
export function soundDialog(api, { title, fields, values }) {
  return new Promise((resolve) => {
    const win = openWindow({ title, width: 380 });
    const src = el('input', { value: values.src ?? '', placeholder: '/assets/rain.ogg or https://…', required: true });
    const file = el('input', { type: 'file', accept: 'audio/*', hidden: true, on: { change: async () => {
      const f = file.files[0];
      if (!f) return;
      upload.disabled = true;
      upload.textContent = 'Uploading…';
      try {
        src.value = await api.upload(f);
        if (inputs.name && !inputs.name.value) inputs.name.value = f.name.replace(/\.[^.]+$/, '');
      } catch (err) { toast(`Upload failed: ${err.message ?? err}`, 'error'); }
      upload.disabled = false;
      upload.textContent = 'Upload…';
    } } });
    const upload = el('button', { type: 'button', text: 'Upload…', on: { click: () => file.click() } });
    const inputs = {};
    const rows = fields.map((f) => {
      const input = f.type === 'checkbox'
        ? el('input', { type: 'checkbox', checked: !!values[f.name] })
        : el('input', { type: f.type ?? 'text', min: f.min, max: f.max, step: f.step });
      // Set the value after min/max/step, or a range input rounds it to the default step.
      if (f.type !== 'checkbox') input.value = values[f.name] ?? '';
      inputs[f.name] = input;
      return f.type === 'checkbox' ? el('label.check', {}, input, f.label) : el('label', {}, f.label, input);
    });
    let done = false;
    const form = el('form.form', {
      on: {
        submit: (e) => {
          e.preventDefault();
          const out = { src: src.value.trim() };
          for (const f of fields) out[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : f.type === 'number' || f.type === 'range' ? Number(inputs[f.name].value) : inputs[f.name].value;
          done = true;
          win.close();
          resolve(out);
        },
      },
    },
    el('div.row', {}, el('label.grow', {}, 'Audio file', src), file, upload),
    ...rows,
    el('button.primary', { type: 'submit', text: 'Save' }));
    win.onClose(() => { if (!done) resolve(null); });
    win.body.append(form);
    src.focus();
  });
}
