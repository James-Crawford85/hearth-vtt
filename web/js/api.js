// The public client API, exposed as `window.Hearth` and passed to every
// package script's `init(hearth)`. Documented in docs/client-api.md.

import { hooks } from './hooks.js';
import { store, mergePatch, getPath, isGM, ownsActor, systemInfo } from './store.js';
import { el, escape, openWindow, toast, formDialog } from './ui.js';
import { openSheet, registerSheet, renderTemplate, bindSheet } from './sheets.js';

export function createApi(conn) {
  const rejectHandlers = new Map();
  const socketHandlers = new Map();

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
      // A new token goes on the level the board shows (unless it says otherwise).
      token: (sceneId, token) => op({ op: 'token_create', scene_id: sceneId, token: { id: '', x: 0, y: 0, ...(api.board?.level && sceneId === api.board.sceneId ? { level: api.board.level } : {}), ...token } }),
    },

    /** The system's declared rules: formulas, tables, resources, actions, conditions. */
    get rules() { return systemInfo().rules ?? {}; },

    /** Actions declared by the system: roll them on the server (costs are spent there). */
    actions: {
      /** Actions an item (or, with no item, the actor) has. */
      list(actor, item = null) {
        const r = systemInfo().rules ?? {};
        const t = item ? r.item_types?.[item.kind] : r.actor_types?.[actor.kind];
        return t?.actions ?? [];
      },
      /** options: { mode: 'advantage' | 'disadvantage' | 'normal', crit, level } */
      use(actorId, itemId, action, options = {}, gmOnly = false) {
        conn.send({ type: 'use_action', actor_id: actorId, item_id: itemId ?? null, action, options, gm_only: gmOnly });
      },
    },

    /** Send a message that isn't an op (used by built-in features). */
    _send(msg) { conn.send(msg); },

    /** Take a rest (`short`, `long`…): the system's resources reset. */
    rest(actorId, kind) { conn.send({ type: 'rest', actor_id: actorId, kind }); },

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
      /**
       * Add a button to the "Module tools" group of the left controls.
       * `icon` is a short text/emoji glyph.
       */
      addTool({ icon, title, onClick, gmOnly = false }) {
        return api.controls.addModuleTool({ icon, title, onClick, gmOnly });
      },
      /**
       * Add a panel to the right-hand sidebar. `icon` is a built-in icon name
       * or a short glyph; `render(panel, hearth)` runs whenever it's shown.
       */
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

    /** Token ids this user has targeted (Target tool). */
    get targets() { return [...(api.board?.myTargets() ?? [])]; },

    /** Internal: send newly explored areas for fog of war. */
    sendExplore: (sceneId, fog) => conn.send({ type: 'explore', scene_id: sceneId, fog }),

    /** Combat helpers. The encounter itself is `hearth.world.combat`. */
    combat: {
      get current() { return store.world?.combat ?? null; },
      rollInitiative: (ids) => conn.send({ type: 'roll_initiative', ids }),
      next: () => op({ op: 'combat_next' }),
      prev: () => op({ op: 'combat_prev' }),
    },

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
