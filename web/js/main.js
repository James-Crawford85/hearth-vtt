import { Connection } from './net.js';
import { store, applyOp, isGM } from './store.js';
import { hooks } from './hooks.js';
import { createApi, loadPackages } from './api.js';
import { Board } from './board.js';
import { Sidebar } from './sidebar.js';
import { sheetsOnOp } from './sheets.js';
import { toast } from './ui.js';

const joinScreen = document.getElementById('join');
const appScreen = document.getElementById('app');
const form = document.getElementById('join-form');
const joinError = document.getElementById('join-error');
const status = document.getElementById('status');
const sceneTitle = document.getElementById('scene-title');

let started = false;
let api;

const conn = new Connection({
  onMessage: (msg) => handle(msg),
  onStatus: (s) => { status.hidden = s === 'online'; },
});
api = createApi(conn);
window.Hearth = api;

fetch('/api/info').then((r) => r.json()).then((info) => {
  document.getElementById('join-world').textContent = `${info.world} · ${info.system}`;
  document.title = `${info.world} · Hearth`;
}).catch(() => {});

// The desktop launcher opens the game as `/#join={"name":…,"key":…}`. The
// fragment never reaches the server; drop it from the address bar right away.
if (location.hash.startsWith('#join=')) {
  try {
    const j = JSON.parse(decodeURIComponent(location.hash.slice(6)));
    if (j.name) sessionStorage.setItem('hearth.name', j.name);
    if (j.key) sessionStorage.setItem('hearth.key', j.key); else sessionStorage.removeItem('hearth.key');
    sessionStorage.setItem('hearth.autojoin', '1');
  } catch { /* ignore a malformed link */ }
  history.replaceState(null, '', location.pathname + location.search);
}
// A join link opened on an already-loaded page only changes the hash; reload to apply it.
addEventListener('hashchange', () => { if (location.hash.startsWith('#join=')) location.reload(); });

// sessionStorage is per tab, so a GM and a test player in two tabs don't
// overwrite each other's identity; localStorage only pre-fills new tabs.
form.elements.name.value = sessionStorage.getItem('hearth.name') ?? localStorage.getItem('hearth.name') ?? '';
form.elements.key.value = sessionStorage.getItem('hearth.key') ?? '';
form.addEventListener('submit', (e) => {
  e.preventDefault();
  joinError.textContent = '';
  const name = form.elements.name.value.trim();
  const key = form.elements.key.value.trim();
  localStorage.setItem('hearth.name', name);
  sessionStorage.setItem('hearth.name', name);
  sessionStorage.setItem('hearth.key', key);
  conn.connect(name, key);
});
// Rejoin automatically after a reload (e.g. when modules change).
if (sessionStorage.getItem('hearth.autojoin') && form.elements.name.value) {
  sessionStorage.removeItem('hearth.autojoin');
  form.requestSubmit();
}

api.leave = () => {
  conn.close();
  sessionStorage.removeItem('hearth.key');
  // In the desktop app, go back to the launcher (a hosted world keeps running there).
  if (window.__HEARTH_DESKTOP__) location.href = window.__HEARTH_DESKTOP__.launcher;
  else location.reload();
};

function updateSceneTitle() {
  const s = api.board?.scene;
  sceneTitle.textContent = s ? s.name : '';
  sceneTitle.hidden = !s;
}

async function start() {
  joinScreen.hidden = true;
  appScreen.hidden = false;
  if (!started) {
    started = true;
    api.board = new Board(document.getElementById('board'), api);
    api.sidebar = new Sidebar(api);
    hooks.on('board:view', updateSceneTitle);
    api.socket.on('core.ping', (p, from) => {
      if (p.scene_id === api.board.sceneId) api.board.ping(p.x, p.y, store.world.users[from]?.color);
    });
    applyTheme();
    await loadPackages(api);
    hooks.emit('init', api);
  }
  // Keep a GM's current view across reconnects; players follow the active scene.
  const keep = isGM() && store.world.scenes[api.board.sceneId];
  api.board.view(keep ? api.board.sceneId : store.world.active_scene, { fit: !keep });
  api.sidebar.refreshAll();
  updateSceneTitle();
  hooks.emit('ready', api);
}

function applyTheme() {
  document.body.dataset.theme = store.world.theme ?? 'default';
}

function reloadSoon(reason) {
  toast(reason);
  sessionStorage.setItem('hearth.autojoin', '1');
  setTimeout(() => location.reload(), 800);
}

function handle(msg) {
  switch (msg.type) {
    case 'welcome': {
      const packagesChanged = started && JSON.stringify(store.packages.active.map((p) => p.id)) !== JSON.stringify(msg.packages.active.map((p) => p.id));
      store.user = msg.user;
      store.world = msg.world;
      store.packages = msg.packages;
      store.online = msg.online;
      if (packagesChanged) return reloadSoon('Packages changed — reloading');
      start();
      break;
    }
    case 'applied': {
      const op = msg.op;
      applyOp(op);
      api._applied();
      if (op.op === 'world_update' && ('modules' in op.patch || 'theme' in op.patch)) {
        return reloadSoon('World packages changed — reloading');
      }
      if (op.op === 'scene_activate' || (op.op === 'scene_create' && !api.board.scene)) {
        api.board.view(store.world.active_scene);
        if (op.op === 'scene_activate') toast(`Scene: ${store.world.scenes[op.id]?.name}`);
      }
      api.board.onOp(op);
      api.sidebar.onOp(op);
      sheetsOnOp(op);
      if (op.op.startsWith('scene_')) updateSceneTitle();
      if (op.op === 'user_upsert') api.sidebar.refreshVisibility();
      hooks.emit('op', op, msg.by);
      hooks.emit(`op:${op.op}`, op, msg.by);
      break;
    }
    case 'rejected':
      api._rejected(msg.req, msg.reason);
      break;
    case 'presence':
      store.online = msg.online;
      api.sidebar?.refresh('settings');
      hooks.emit('presence', msg.online);
      break;
    case 'emit':
      api._emit(msg.from, msg.channel, msg.payload);
      break;
    case 'error':
      if (!started || joinScreen.hidden === false) {
        joinError.textContent = msg.message;
        joinScreen.hidden = false;
        appScreen.hidden = true;
      } else if (msg.message !== 'resync') {
        toast(msg.message, 'error');
      }
      break;
  }
}
