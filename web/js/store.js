// Local mirror of the world. Applies the same ops as the Rust server
// (crates/hearth-core/src/ops.rs) — keep the two in sync.

export const store = {
  world: null,
  user: null,
  online: [],
  packages: { active: [], available: [] },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : structuredClone(v));

/** RFC 7386 JSON merge patch, in place. Returns the target. */
export function mergePatch(target, patch) {
  if (!isObj(patch)) return clone(patch);
  if (!isObj(target)) target = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (isObj(v)) target[k] = mergePatch(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

function patchEntity(entity, patch, protectedKeys = []) {
  if (!isObj(patch)) return;
  const p = { ...patch };
  delete p.id;
  for (const k of protectedKeys) delete p[k];
  mergePatch(entity, p);
}

/** Read `a.b.c` from an object. */
export function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Build `{a: {b: {c: value}}}` from `a.b.c`. */
export function pathPatch(path, value) {
  const keys = path.split('.');
  const root = {};
  let cur = root;
  keys.forEach((k, i) => { cur[k] = i === keys.length - 1 ? value : {}; cur = cur[k]; });
  return root;
}

export function applyOp(op) {
  const w = store.world;
  const scene = (id) => w.scenes[id];
  const actor = (id) => w.actors[id];
  switch (op.op) {
    case 'world_update': patchEntity(w, op.patch, ['system', 'scenes', 'actors', 'users', 'chat', 'active_scene']); break;
    case 'scene_create': w.scenes[op.scene.id] = op.scene; if (!w.active_scene) w.active_scene = op.scene.id; break;
    case 'scene_update': if (scene(op.id)) patchEntity(scene(op.id), op.patch, ['tokens', 'walls', 'drawings', 'lights', 'sounds', 'level_sketches', 'links']); break;
    case 'scene_delete':
      delete w.scenes[op.id];
      if (w.active_scene === op.id) w.active_scene = Object.keys(w.scenes)[0] ?? null;
      if (w.combat?.scene_id === op.id) w.combat = null;
      if (w.fog) delete w.fog[op.id];
      break;
    case 'scene_activate': w.active_scene = op.id; break;
    case 'token_create': if (scene(op.scene_id)) scene(op.scene_id).tokens[op.token.id] = op.token; break;
    case 'token_update': {
      const t = scene(op.scene_id)?.tokens[op.id];
      if (t) patchEntity(t, op.patch);
      break;
    }
    case 'token_delete':
      if (scene(op.scene_id)) delete scene(op.scene_id).tokens[op.id];
      if (w.combat?.scene_id === op.scene_id) w.combat.combatants = w.combat.combatants.filter((x) => x.token_id !== op.id);
      break;
    case 'actor_create': w.actors[op.actor.id] = op.actor; break;
    case 'journal_create': (w.journal ??= {})[op.entry.id] = op.entry; break;
    case 'journal_update': if (w.journal?.[op.id]) patchEntity(w.journal[op.id], op.patch, ['id']); break;
    case 'journal_delete': if (w.journal) delete w.journal[op.id]; break;
    case 'library_item_create': (w.items ??= {})[op.item.id] = op.item; break;
    case 'library_item_update': if (w.items?.[op.id]) patchEntity(w.items[op.id], op.patch, ['id']); break;
    case 'library_item_delete': if (w.items) delete w.items[op.id]; break;
    case 'table_create': (w.tables ??= {})[op.table.id] = op.table; break;
    case 'table_update': if (w.tables?.[op.id]) patchEntity(w.tables[op.id], op.patch, ['id']); break;
    case 'table_delete': if (w.tables) delete w.tables[op.id]; break;
    case 'texture_set': (w.textures ??= {})[op.texture.id] = op.texture; break;
    case 'texture_delete': if (w.textures) delete w.textures[op.id]; break;
    case 'macro_create': (w.macros ??= {})[op.macro.id] = op.macro; break;
    case 'macro_update': if (w.macros?.[op.id]) patchEntity(w.macros[op.id], op.patch, ['id', 'author']); break;
    case 'macro_delete':
      if (w.macros) delete w.macros[op.id];
      for (const bar of Object.values(w.hotbars ?? {})) for (const [k, v] of Object.entries(bar)) if (v === op.id) delete bar[k];
      break;
    case 'hotbar_set': {
      const bar = ((w.hotbars ??= {})[op.user_id] ??= {});
      if (op.macro_id) bar[op.slot] = op.macro_id; else delete bar[op.slot];
      break;
    }
    case 'actor_update': if (actor(op.id)) patchEntity(actor(op.id), op.patch, ['items', 'derived']); break;
    case 'actor_delete':
      delete w.actors[op.id];
      for (const x of w.combat?.combatants ?? []) if (x.actor_id === op.id) x.actor_id = null;
      for (const s of Object.values(w.scenes)) for (const t of Object.values(s.tokens)) if (t.actor_id === op.id) t.actor_id = null;
      break;
    case 'actor_derive': if (actor(op.id)) actor(op.id).derived = op.derived; break;
    case 'item_create': actor(op.actor_id)?.items.push(op.item); break;
    case 'item_update': {
      const it = actor(op.actor_id)?.items.find((i) => i.id === op.id);
      if (it) patchEntity(it, op.patch);
      break;
    }
    case 'item_delete': {
      const a = actor(op.actor_id);
      if (a) a.items = a.items.filter((i) => i.id !== op.id);
      break;
    }
    case 'chat_create': w.chat.push(op.message); if (w.chat.length > 500) w.chat.splice(0, w.chat.length - 500); break;
    case 'chat_delete': w.chat = w.chat.filter((m) => m.id !== op.id); break;
    case 'chat_clear': w.chat = []; break;
    case 'user_upsert':
      w.users[op.user.id] = op.user;
      if (store.user && op.user.id === store.user.id) store.user = op.user;
      break;
    case 'user_delete':
      delete w.users[op.id];
      for (const a of Object.values(w.actors)) a.owners = a.owners.filter((o) => o !== op.id);
      break;
    case 'wall_create': if (scene(op.scene_id)) (scene(op.scene_id).walls ??= {})[op.wall.id] = op.wall; break;
    case 'wall_update': {
      const wall = scene(op.scene_id)?.walls?.[op.id];
      if (wall) patchEntity(wall, op.patch);
      break;
    }
    case 'wall_delete': if (scene(op.scene_id)?.walls) delete scene(op.scene_id).walls[op.id]; break;
    case 'sound_create': if (scene(op.scene_id)) (scene(op.scene_id).sounds ??= {})[op.sound.id] = op.sound; break;
    case 'sound_update': { const x = scene(op.scene_id)?.sounds?.[op.id]; if (x) patchEntity(x, op.patch); break; }
    case 'sound_delete': if (scene(op.scene_id)?.sounds) delete scene(op.scene_id).sounds[op.id]; break;
    case 'collection_create': (w.collections ??= {})[op.collection.id] = op.collection; break;
    case 'collection_update': if (w.collections?.[op.id]) patchEntity(w.collections[op.id], op.patch, ['id']); break;
    case 'collection_delete': if (w.collections) delete w.collections[op.id]; break;
    case 'playlist_create': (w.playlists ??= {})[op.playlist.id] = op.playlist; break;
    case 'playlist_update': if (w.playlists?.[op.id]) patchEntity(w.playlists[op.id], op.patch, ['id']); break;
    case 'playlist_delete': if (w.playlists) delete w.playlists[op.id]; break;
    case 'light_create': if (scene(op.scene_id)) (scene(op.scene_id).lights ??= {})[op.light.id] = op.light; break;
    case 'light_update': { const l = scene(op.scene_id)?.lights?.[op.id]; if (l) patchEntity(l, op.patch); break; }
    case 'light_delete': if (scene(op.scene_id)?.lights) delete scene(op.scene_id).lights[op.id]; break;
    case 'drawing_create': if (scene(op.scene_id)) (scene(op.scene_id).drawings ??= {})[op.drawing.id] = op.drawing; break;
    case 'drawing_update': {
      const d = scene(op.scene_id)?.drawings?.[op.id];
      if (d) patchEntity(d, op.patch, ['author']);
      break;
    }
    case 'drawing_delete': if (scene(op.scene_id)?.drawings) delete scene(op.scene_id).drawings[op.id]; break;
    case 'sketch_update': {
      const s = scene(op.scene_id);
      const level = op.level ?? '';
      if (!s || (level && !(s.levels ?? []).some((l) => l.id === level))) break;
      const blank = { cells: {}, outside: null, walls: true, size: 0 };
      if (level) { s.level_sketches ??= {}; s.level_sketches[level] = mergePatch(s.level_sketches[level] ?? blank, op.patch); s.level_sketches[level].cells ??= {}; } else { s.sketch = mergePatch(s.sketch ?? blank, op.patch); s.sketch.cells ??= {}; }
      // The level's own sketch-made walls, lights and links are replaced (others are left alone).
      const mine = (id, x) => id.startsWith('sk-') && (x.level ?? '') === level;
      const tag = (x) => (level ? { ...x, level } : (({ level: _, ...rest }) => rest)(x));
      if (op.walls) {
        const walls = (s.walls ??= {});
        const old = {};
        for (const [id, x] of Object.entries(walls)) if (mine(id, x)) { old[id] = x; delete walls[id]; }
        for (const [id, w] of Object.entries(op.walls)) {
          if (!id.startsWith('sk-') || walls[id]) continue;
          const prev = old[id];
          const door = (x) => x?.kind === 'door' || x?.kind === 'secret_door';
          walls[id] = tag({ ...w, id, open: door(prev) && door(w) ? !!prev.open : !!w.open, locked: door(prev) && door(w) ? !!prev.locked : !!w.locked });
        }
      }
      if (op.lights) {
        const lights = (s.lights ??= {});
        const off = {};
        for (const [id, x] of Object.entries(lights)) if (mine(id, x)) { off[id] = !!x.off; delete lights[id]; }
        for (const [id, l] of Object.entries(op.lights)) {
          if (!id.startsWith('sk-') || lights[id]) continue;
          const bright = Math.max(0, l.bright ?? 0);
          lights[id] = tag({ ...l, id, bright, dim: Math.max(l.dim ?? 0, bright), off: id in off ? off[id] : !!l.off });
        }
      }
      if (op.links) {
        const links = (s.links ??= {});
        for (const [id, x] of Object.entries(links)) if (mine(id, x)) delete links[id];
        for (const [id, l] of Object.entries(op.links)) if (id.startsWith('sk-') && !links[id] && l.poly?.length >= 3) links[id] = tag({ ...l, id });
      }
      break;
    }
    case 'fog_reset': if (w.fog) delete w.fog[op.scene_id]; break;
    case 'fog_explore': ((w.fog ??= {})[op.scene_id] ??= {})[op.user_id] = op.fog; break;
    case 'combat_create': w.combat = op.combat; break;
    case 'combat_update': if (w.combat) patchEntity(w.combat, op.patch, ['combatants', 'scene_id']); break;
    case 'combat_end': w.combat = null; break;
    case 'combatant_add': if (w.combat && !w.combat.combatants.some((x) => x.id === op.combatant.id)) w.combat.combatants.push(op.combatant); break;
    case 'combatant_update': {
      const x = w.combat?.combatants.find((c) => c.id === op.id);
      if (x) patchEntity(x, op.patch, ['token_id', 'actor_id']);
      break;
    }
    case 'combatant_remove': if (w.combat) w.combat.combatants = w.combat.combatants.filter((x) => x.id !== op.id); break;
    default: console.warn('[hearth] unknown op', op);
  }
}

export const isGM = () => store.user?.role === 'gm';

export function ownsActor(actorId) {
  if (isGM()) return true;
  const a = store.world?.actors[actorId];
  return !!a && a.owners.includes(store.user.id);
}

/** Turn order, matching the server: initiative high→low, unrolled last, then name, then id. */
export function combatOrder(combat) {
  if (!combat) return [];
  const init = (x) => (x.initiative == null ? -Infinity : x.initiative);
  const cmp = (p, q) => (p < q ? -1 : p > q ? 1 : 0); // plain code-point order, like Rust's String::cmp
  return [...combat.combatants].sort((a, b) => cmp(init(b), init(a))
    || cmp(a.name.toLowerCase(), b.name.toLowerCase())
    || cmp(a.id, b.id));
}

export function systemInfo() {
  return store.packages.active.find((p) => p.type === 'system') ?? { id: store.world?.system, actor_types: {}, item_types: {} };
}
