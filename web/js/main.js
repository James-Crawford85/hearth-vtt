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

// ------------------------------------------------------------------ join page
//
// Players pick their account from the list and enter their password. The
// server answers with a session token, kept per tab in sessionStorage, so a
// reload (e.g. when the GM changes modules) logs straight back in.

const SESSION = 'hearth.session';
const store_ = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* private mode */ } },
  getLocal: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setLocal: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let preferredName = null; // from the desktop launcher's hand-off
let infoTimer = null;

function formatSession(iso) {
  if (!iso) return 'Not scheduled';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function loadInfo() {
  let info;
  try { info = await fetch('/api/info', { cache: 'no-store' }).then((r) => r.json()); } catch { return; }
  document.title = `${info.world} · Hearth`;
  document.getElementById('join-world').textContent = info.world;
  document.getElementById('join-system').textContent = info.system_name;
  document.getElementById('join-version').textContent = `Hearth ${info.version}`;
  document.getElementById('detail-next').textContent = formatSession(info.next_session);
  document.getElementById('detail-players').textContent = `${info.players_online} / ${info.players_total}`;
  document.getElementById('detail-system').textContent = info.system_name;
  const desc = document.getElementById('world-desc');
  desc.textContent = info.description || 'The GM hasn\'t written a description yet.';
  desc.classList.toggle('empty', !info.description);

  // Rebuild the player list, keeping the current choice.
  const select = form.elements.user;
  const chosen = select.value || store_.getLocal('hearth.user');
  const byName = preferredName && info.users.find((u) => u.name.toLowerCase() === preferredName.toLowerCase());
  select.replaceChildren(
    new Option('Choose your player…', ''),
    ...info.users.map((u) => new Option(`${u.name}${u.role === 'gm' ? ' (GM)' : ''}${u.online ? ' · online' : ''}`, u.id)),
  );
  select.value = byName?.id ?? (info.users.some((u) => u.id === chosen) ? chosen : '');
  if (byName) preferredName = null;
  // A brand-new world has nobody to pick yet: lead the GM to the key login.
  const empty = info.users.length === 0;
  document.getElementById('join-empty').hidden = !empty;
  form.querySelector('.player-login').hidden = empty;
  const gmBox = form.querySelector('details.gm-key');
  if (empty && !gmBox.open) {
    gmBox.open = true;
    if (!form.elements.gm_name.value) form.elements.gm_name.focus();
  }
}

function showJoin(message = '') {
  joinError.textContent = message;
  joinScreen.hidden = false;
  appScreen.hidden = true;
  loadInfo();
  clearInterval(infoTimer);
  infoTimer = setInterval(() => { if (!joinScreen.hidden) loadInfo(); }, 10000);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  joinError.textContent = '';
  const userId = form.elements.user.value;
  if (!userId) { joinError.textContent = 'Choose your player first.'; return; }
  store_.setLocal('hearth.user', userId);
  conn.connect({ user_id: userId, password: form.elements.password.value });
  form.elements.password.value = '';
});

document.getElementById('gm-join').addEventListener('click', () => {
  joinError.textContent = '';
  const name = form.elements.gm_name.value.trim();
  const key = form.elements.key.value.trim();
  if (!name || !key) { joinError.textContent = 'Enter your name and the GM key.'; return; }
  store_.setLocal('hearth.gm_name', name);
  conn.connect({ key, name });
  form.elements.key.value = '';
});
form.elements.gm_name.value = store_.getLocal('hearth.gm_name') ?? '';

// The desktop launcher opens the game as `/#join={"name":…,"key":…}`. The
// fragment never reaches the server; drop it from the address bar right away.
let handoff = null;
if (location.hash.startsWith('#join=')) {
  try { handoff = JSON.parse(decodeURIComponent(location.hash.slice(6))); } catch { /* malformed link */ }
  history.replaceState(null, '', location.pathname + location.search);
}
// A join link opened on an already-loaded page only changes the hash; reload to apply it.
addEventListener('hashchange', () => { if (location.hash.startsWith('#join=')) location.reload(); });

if (handoff?.key && handoff?.name) {
  conn.connect({ key: handoff.key, name: handoff.name });          // GM launching from the app
} else if (store_.get(SESSION)) {
  conn.connect({ session: store_.get(SESSION) });                  // reload: rejoin quietly
} else {
  preferredName = handoff?.name ?? null;                           // joined game: preselect name
}
showJoin();

// ------------------------------------------------------------------ password change

const pwDialog = document.getElementById('password-dialog');
const pwForm = document.getElementById('password-form');
const pwError = document.getElementById('password-error');
let pwRequired = false;

function askNewPassword(required, reason) {
  pwRequired = required;
  pwForm.reset();
  pwError.textContent = '';
  document.getElementById('password-reason').textContent = reason;
  if (!pwDialog.open) pwDialog.showModal();
}
api.changePassword = () => askNewPassword(false, 'Choose a new password for your account.');
// A required change can't be skipped with Esc.
pwDialog.addEventListener('cancel', (e) => { if (pwRequired) e.preventDefault(); });
pwForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const { new: pw, repeat } = pwForm.elements;
  if (pw.value !== repeat.value) { pwError.textContent = 'The passwords don\'t match.'; return; }
  pwError.textContent = '';
  conn.send({ type: 'set_password', new: pw.value, current: null });
});

api.leave = () => {
  conn.send({ type: 'logout' });
  conn.close();
  store_.del(SESSION);
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

/** Tell people when combat starts, ends, and when it's their turn. */
function announceCombat(op, before) {
  const c = store.world.combat;
  if (op.op === 'combat_create') {
    toast('Combat! Roll initiative.');
    api.sidebar.select('combat');
  } else if (op.op === 'combat_end') {
    toast('The combat is over.');
  } else if (op.op === 'combat_update' && c && c.round > 0) {
    if (!before || before.round === 0) toast(`Round ${c.round} — the fight begins!`);
    else if (c.round > before.round) toast(`Round ${c.round}`);
    if (c.current !== before?.current) {
      const x = c.combatants.find((m) => m.id === c.current);
      hooks.emit('combat:turn', c, x ?? null);
      if (x && !isGM() && x.actor_id && store.world.actors[x.actor_id]?.owners.includes(store.user.id)) {
        toast(`It's your turn: ${x.name}`);
      }
    }
  }
}

function reloadSoon(reason) {
  toast(reason);
  // The session token in sessionStorage logs us straight back in.
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
      store_.set(SESSION, msg.session);
      api.session = msg.session;
      clearInterval(infoTimer);
      if (packagesChanged) return reloadSoon('Packages changed — reloading');
      start();
      if (msg.must_change_password) {
        askNewPassword(true, 'Welcome! Your GM set a temporary password (or none). Choose your own password to continue.');
      }
      break;
    }
    case 'password_changed':
      pwRequired = false;
      if (pwDialog.open) pwDialog.close();
      toast('Password saved.');
      break;
    case 'notice':
      toast(msg.message);
      break;
    case 'applied': {
      const op = msg.op;
      const before = store.world.combat ? { round: store.world.combat.round, current: store.world.combat.current } : null;
      applyOp(op);
      api._applied();
      announceCombat(op, before);
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
      // Errors from the password dialog belong in the dialog.
      if (pwDialog.open && msg.req == null) { pwError.textContent = msg.reason; break; }
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
      if (msg.refused) {
        // Join refused or account removed: back to the login page.
        store_.del(SESSION);
        if (pwDialog.open) { pwRequired = false; pwDialog.close(); }
        showJoin(msg.message);
      } else if (msg.message !== 'resync') {
        toast(msg.message, 'error');
      }
      break;
  }
}
