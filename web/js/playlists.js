// The Playlists panel. The GM makes playlists of tracks (music or ambience)
// and plays them for everyone; each player sees what's playing and sets
// their own volumes.

import { store, isGM } from './store.js';
import { el, toast, formDialog } from './ui.js';
import { soundDialog } from './audio.js';
import { newId, rejectToast } from './directory.js';

const MODES = [['sequential', 'In order'], ['shuffle', 'Shuffle'], ['simultaneous', 'All at once']];

export class Playlists {
  constructor(api) {
    this.api = api;
    this.open = new Set(); // expanded playlist ids
  }

  get audio() { return this.api.audio; }
  get all() { return store.world?.playlists ?? {}; }
  order(pl) { return Object.values(pl.sounds ?? {}).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)); }

  renderPanel(panel) {
    const parts = [this.volumes()];
    const playlists = Object.values(this.all).sort((a, b) => a.name.localeCompare(b.name));
    if (isGM()) {
      parts.push(el('div.row', {}, el('button.primary', { text: '+ New playlist', on: { click: () => this.create() } })));
      if (!playlists.length) parts.push(el('p.muted', { text: 'No playlists yet. Make one, add tracks (upload audio or paste a link), and press ▶ to play it for everyone.' }));
      for (const pl of playlists) parts.push(this.playlistBlock(pl));
    } else {
      const playing = playlists.flatMap((pl) => this.order(pl).filter((s) => s.playing).map((s) => ({ pl, s })));
      parts.push(el('h3', { text: 'Now playing' }));
      parts.push(playing.length
        ? el('ul.entity-list', {}, playing.map(({ pl, s }) => el('li.entity', {}, el('span.avatar', { text: '♪' }), el('span.grow', {}, el('span', { text: s.name }), el('small.muted', { text: ` ${pl.name}` })))))
        : el('p.muted', { text: 'Nothing is playing.' }));
    }
    panel.replaceChildren(...parts);
  }

  volumes() {
    const a = this.audio;
    const slider = (kind, label) => el('label', {}, label, el('input', {
      type: 'range', min: 0, max: 1, step: 0.05, value: a.volume[kind], 'aria-label': `${label} volume`,
      on: { input: (e) => a.setVolume(kind, Number(e.target.value)) },
    }));
    return el('details.volumes', { open: !isGM() }, el('summary', { text: '🔊 Your volume' }),
      el('div.volume-grid', {}, slider('music', 'Music'), slider('ambience', 'Ambience'), slider('environment', 'Map sounds')));
  }

  playlistBlock(pl) {
    const tracks = this.order(pl);
    const anyPlaying = tracks.some((s) => s.playing);
    const expanded = this.open.has(pl.id) || anyPlaying;
    const head = el('div.playlist-head', {},
      el('button.icon', { title: anyPlaying ? 'Stop' : 'Play', text: anyPlaying ? '■' : '▶', on: { click: () => (anyPlaying ? this.audio.stopPlaylist(pl.id) : this.audio.playPlaylist(pl.id)) } }),
      el('button.link.grow', {
        text: `${expanded ? '▾' : '▸'} ${pl.name}`,
        on: { click: () => { if (this.open.has(pl.id)) this.open.delete(pl.id); else this.open.add(pl.id); this.api.sidebar.refresh('playlists'); } },
      }),
      el('small.muted', { text: `${MODES.find(([m]) => m === pl.mode)?.[1] ?? ''}${pl.ambience ? ' · ambience' : ''}` }),
      el('button.icon', { title: 'Playlist settings', text: '⚙', on: { click: () => this.edit(pl) } }));
    const block = el('div.playlist', { class: anyPlaying ? 'playlist playing' : 'playlist' }, head);
    if (expanded) {
      const ul = el('ul.entity-list.tracks');
      for (const s of tracks) {
        ul.append(el('li.entity', { class: s.playing ? 'entity playing' : 'entity' },
          el('button.icon', { title: s.playing ? 'Stop' : 'Play', text: s.playing ? '■' : '▶', on: { click: () => this.audio.playTrack(pl.id, s.id, !s.playing) } }),
          el('span.grow', { text: s.name }),
          s.repeat ? el('small.muted', { text: '⟳', title: 'Loops' }) : null,
          el('button.icon', { title: 'Track settings', text: '✎', on: { click: () => this.editTrack(pl, s) } }),
          el('button.icon', { title: 'Remove track', text: '✕', on: { click: () => { if (confirm(`Remove "${s.name}"?`)) this.api.op({ op: 'playlist_update', id: pl.id, patch: { sounds: { [s.id]: null } } }, rejectToast); } } })));
      }
      if (!tracks.length) ul.append(el('li.muted', { text: 'No tracks yet.' }));
      block.append(ul, el('div.row', {}, el('button', { text: '+ Track', on: { click: () => this.editTrack(pl, null) } })));
    }
    return block;
  }

  async create() {
    const v = await formDialog({
      title: 'New playlist',
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'mode', label: 'Plays', type: 'select', options: MODES, value: 'sequential' },
        { name: 'ambience', label: 'Ambience (players have a separate volume for it)', type: 'checkbox', value: false },
      ],
      submit: 'Create',
    });
    if (!v) return;
    const id = newId();
    this.open.add(id);
    this.api.op({ op: 'playlist_create', playlist: { id, name: v.name.trim(), mode: v.mode, ambience: v.ambience, sounds: {} } }, rejectToast);
  }

  async edit(pl) {
    const v = await formDialog({
      title: `Playlist: ${pl.name}`,
      fields: [
        { name: 'name', label: 'Name', value: pl.name, required: true },
        { name: 'mode', label: 'Plays', type: 'select', options: MODES, value: pl.mode },
        { name: 'ambience', label: 'Ambience (players have a separate volume for it)', type: 'checkbox', value: pl.ambience },
        { name: 'delete', label: 'Delete this playlist', type: 'checkbox', value: false },
      ],
    });
    if (!v) return;
    if (v.delete) {
      if (confirm(`Delete the playlist "${pl.name}" and its tracks?`)) this.api.op({ op: 'playlist_delete', id: pl.id }, rejectToast);
      return;
    }
    this.api.op({ op: 'playlist_update', id: pl.id, patch: { name: v.name.trim() || pl.name, mode: v.mode, ambience: v.ambience } }, rejectToast);
  }

  async editTrack(pl, s) {
    const v = await soundDialog(this.api, {
      title: s ? `Track: ${s.name}` : `Add a track to ${pl.name}`,
      values: s ?? { src: '', name: '', volume: 0.8, repeat: pl.ambience },
      fields: [
        { name: 'name', label: 'Name' },
        { name: 'volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05 },
        { name: 'repeat', label: 'Loop', type: 'checkbox' },
      ],
    });
    if (!v || !v.src) return;
    const id = s?.id ?? newId();
    const fields = { name: v.name.trim() || v.src.split('/').pop(), src: v.src, volume: v.volume, repeat: v.repeat };
    if (!s) Object.assign(fields, { id, playing: false, started: 0, sort: Object.keys(pl.sounds ?? {}).length });
    this.api.op({ op: 'playlist_update', id: pl.id, patch: { sounds: { [id]: fields } } }, rejectToast);
    if (!s) toast(`Added "${fields.name}".`);
  }
}
