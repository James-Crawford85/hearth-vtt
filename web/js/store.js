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
    case 'scene_update': if (scene(op.id)) patchEntity(scene(op.id), op.patch, ['tokens']); break;
    case 'scene_delete':
      delete w.scenes[op.id];
      if (w.active_scene === op.id) w.active_scene = Object.keys(w.scenes)[0] ?? null;
      break;
    case 'scene_activate': w.active_scene = op.id; break;
    case 'token_create': if (scene(op.scene_id)) scene(op.scene_id).tokens[op.token.id] = op.token; break;
    case 'token_update': {
      const t = scene(op.scene_id)?.tokens[op.id];
      if (t) patchEntity(t, op.patch);
      break;
    }
    case 'token_delete': if (scene(op.scene_id)) delete scene(op.scene_id).tokens[op.id]; break;
    case 'actor_create': w.actors[op.actor.id] = op.actor; break;
    case 'actor_update': if (actor(op.id)) patchEntity(actor(op.id), op.patch, ['items', 'derived']); break;
    case 'actor_delete':
      delete w.actors[op.id];
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
    default: console.warn('[hearth] unknown op', op);
  }
}

export const isGM = () => store.user?.role === 'gm';

export function ownsActor(actorId) {
  if (isGM()) return true;
  const a = store.world?.actors[actorId];
  return !!a && a.owners.includes(store.user.id);
}

export function systemInfo() {
  return store.packages.active.find((p) => p.type === 'system') ?? { id: store.world?.system, actor_types: {}, item_types: {} };
}
