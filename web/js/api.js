// The public client API, exposed as `window.Hearth` and passed to every
// package script's `init(hearth)`. Documented in docs/client-api.md.

import { hooks } from './hooks.js';
import { store, mergePatch, getPath, isGM, ownsActor, systemInfo } from './store.js';
import { el, escape, openWindow, toast, formDialog } from './ui.js';
import { openSheet, registerSheet, renderTemplate, bindSheet } from './sheets.js';

export function createApi(conn) {
  const rejectHandlers = new Map();
  const socketHandlers = new Map();
  const toolbar = document.getElementById('toolbar');

  const op = (o, onReject) => {
    const req = conn.op(o);
    if (onReject) rejectHandlers.set(req, onReject);
    return req;
  };

  const api = {
    version: '0.1.0',
    hooks,
    get world() { return store.world; },
    get user() { return store.user; },
    get packages() { return store.packages; },
    get system() { return systemInfo(); },
    isGM,
    ownsActor,
    actor: (id) => store.world.actors[id],
    scene: (id) => store.world.scenes[id ?? store.world.active_scene],

    /** Send a raw op (see crates/hearth-core/src/ops.rs). */
    op,
    update: {
      actor: (id, patch, onReject) => op({ op: 'actor_update', id, patch }, onReject),
      item: (actorId, id, patch, onReject) => op({ op: 'item_update', actor_id: actorId, id, patch }, onReject),
      token: (sceneId, id, patch, onReject) => op({ op: 'token_update', scene_id: sceneId, id, patch }, onReject),
      scene: (id, patch, onReject) => op({ op: 'scene_update', id, patch }, onReject),
      world: (patch, onReject) => op({ op: 'world_update', patch }, onReject),
    },
    create: {
      actor: (kind, name, data = {}) => op({ op: 'actor_create', actor: { id: '', name, kind, data, owners: [], items: [] } }),
      item: (actorId, kind, name, data = {}) => op({ op: 'item_create', actor_id: actorId, item: { id: '', name, kind, data } }),
      token: (sceneId, token) => op({ op: 'token_create', scene_id: sceneId, token: { id: '', x: 0, y: 0, ...token } }),
    },

    /** Roll on the server. `@paths` resolve against the actor's derived, then data, values. */
    roll(formula, { flavor, actorId, gmOnly = false } = {}) {
      conn.send({ type: 'roll', formula, flavor: flavor ?? null, actor_id: actorId ?? null, gm_only: gmOnly });
    },
    chat(content, speakerActor) {
      conn.send({ type: 'chat', content, speaker_actor: speakerActor ?? null });
    },

    /** Package-to-package messaging relayed by the server. */
    socket: {
      emit(channel, payload, to) { conn.send({ type: 'emit', channel, payload, to: to ?? null }); },
      on(channel, fn) {
        if (!socketHandlers.has(channel)) socketHandlers.set(channel, []);
        socketHandlers.get(channel).push(fn);
      },
    },

    /** Per-package world settings stored in world.settings[packageId][key]. */
    settings: {
      get: (pkg, key) => getPath(store.world.settings ?? {}, `${pkg}.${key}`),
      set: (pkg, key, value) => op({ op: 'world_update', patch: { settings: { [pkg]: { [key]: value } } } }),
    },

    sheets: {
      register: registerSheet,
      open: (actorId) => openSheet(actorId, api),
      renderTemplate,
      bind: (root, actor) => bindSheet(root, actor, api),
    },

    ui: {
      el, escape, toast, window: openWindow, form: formDialog,
      /** Add a button to the left toolbar. */
      addTool({ icon, title, onClick, gmOnly = false }) {
        if (gmOnly && !isGM()) return null;
        const b = el('button.tool', { title, 'aria-label': title, text: icon, on: { click: onClick } });
        toolbar.append(b);
        return b;
      },
      /** Add a sidebar tab. `render(panel, hearth)` runs whenever it's shown. */
      addTab(tab) { api.sidebar.addTab(tab); },
      /** Element above the chat input, for dice trays etc. */
      get chatControls() { return api.sidebar.chatControls; },
    },

    async upload(file) {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body, headers: { 'x-hearth-session': api.session ?? '' } });
      if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
      return (await res.json()).url;
    },

    util: { mergePatch, getPath },

    /** GM-only account management. Results arrive as a toast (notice) or error. */
    admin: {
      createUser: (name, role = 'player', password = '') => conn.send({ type: 'admin', action: 'create', name, role, password }),
      updateUser: (id, changes) => conn.send({ type: 'admin', action: 'update', id, ...changes }),
      resetPassword: (id, password) => conn.send({ type: 'admin', action: 'reset_password', id, password }),
      deleteUser: (id) => conn.send({ type: 'admin', action: 'delete', id }),
    },
    /** Set by main.js: the current session token and a "change my password" dialog. */
    session: null,
    changePassword: null,

    // filled in by main.js
    board: null,
    sidebar: null,
    leave: null,

    // internal
    _rejected(req, reason) {
      const fn = rejectHandlers.get(req);
      rejectHandlers.delete(req);
      fn?.(reason);
      toast(reason, 'error');
    },
    _applied() {
      if (rejectHandlers.size > 200) rejectHandlers.clear();
    },
    _emit(from, channel, payload) {
      for (const fn of socketHandlers.get(channel) ?? []) {
        try { fn(payload, from); } catch (e) { console.error(e); }
      }
    },
  };
  return api;
}

const loaded = new Set();

/** Load styles and scripts of every active package (system, modules, theme). */
export async function loadPackages(api) {
  for (const pkg of store.packages.active) {
    for (const href of pkg.styles) {
      if (loaded.has(href)) continue;
      loaded.add(href);
      document.head.append(el('link', { rel: 'stylesheet', href, 'data-package': pkg.id }));
    }
  }
  for (const pkg of store.packages.active) {
    for (const src of pkg.scripts) {
      if (loaded.has(src)) continue;
      loaded.add(src);
      try {
        const mod = await import(src);
        if (typeof mod.default === 'function') await mod.default(api, pkg);
      } catch (e) {
        console.error(`[hearth] ${pkg.id}: ${src} failed`, e);
        toast(`Package "${pkg.name}" failed to load (see console)`, 'error');
      }
    }
  }
}
