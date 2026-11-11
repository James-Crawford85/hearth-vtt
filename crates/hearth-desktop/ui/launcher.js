// Hearth desktop launcher. Talks to the Rust side (src/commands.rs) through Tauri commands.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  info: null,
  hosting: null,
  worlds: { hosted: [], joined: [] },
  packages: [],
};

// ------------------------------------------------------------------ helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [e, fn] of Object.entries(v)) el.addEventListener(e, fn);
    else if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

let toastTimer;
function toast(msg, kind = 'info') {
  const t = $('toast');
  // An open modal dialog sits in the browser's top layer; put the toast inside
  // it so it isn't hidden behind the backdrop.
  const dlg = $('dialog');
  const host = dlg.open ? dlg : document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 4000);
}

async function call(cmd, args) {
  try { return await invoke(cmd, args); } catch (e) { toast(String(e), 'error'); throw e; }
}

async function busy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } catch { /* already toasted */ } finally { if (button) button.disabled = false; }
}

function ago(ms) {
  if (!ms) return 'never';
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} days ago`;
  return new Date(ms).toLocaleDateString();
}
const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const initial = (s) => (s || '?').trim().charAt(0).toUpperCase();
const pkgName = (id) => state.packages.find((p) => p.id === id)?.name ?? id;

/** Open the game page and hand it our name (and the GM key when hosting). */
function openGame(url, join) {
  const u = new URL(url);
  u.hash = `join=${encodeURIComponent(JSON.stringify(join))}`;
  location.href = u.toString();
}

// ------------------------------------------------------------------ dialog

/**
 * Show a modal form. `onOk(form)` may throw (the dialog stays open) or return
 * a value (the dialog closes and the promise resolves with it).
 */
function dialog({ title, body = [], ok = 'Save', okClass = 'primary', cancel = 'Cancel', onOk, wide = false }) {
  const dlg = $('dialog');
  const form = $('dialog-form');
  dlg.style.width = wide ? 'min(720px, calc(100vw - 32px))' : '';
  const okBtn = ok ? h('button', { class: okClass, value: 'ok', text: ok }) : null;
  form.replaceChildren(
    h('h2', { text: title }),
    ...body,
    h('div', { class: 'actions' }, cancel ? h('button', { value: 'cancel', text: cancel, formnovalidate: true }) : null, okBtn),
  );
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; dlg.close(); resolve(v); } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (e.submitter?.value !== 'ok') return finish(null);
      if (!onOk) return finish(true);
      okBtn.disabled = true;
      try { finish((await onOk(form)) ?? true); } catch { /* toasted; keep open */ } finally { okBtn.disabled = false; }
    };
    dlg.onclose = () => finish(null);
    dlg.showModal();
    form.querySelector('input:not([type=checkbox]), textarea, select')?.focus();
  });
}

function confirmDialog(title, text, ok = 'Confirm', okClass = 'danger') {
  return dialog({ title, body: [h('p', { text })], ok, okClass });
}

/** Make sure we know the player's name, asking once if needed. */
async function ensureName() {
  if (state.settings.player_name) return state.settings.player_name;
  const ok = await dialog({
    title: 'What should players call you?',
    body: [h('label', {}, 'Your name', h('input', { name: 'player_name', required: true, maxlength: 40 }))],
    ok: 'Continue',
    onOk: async (f) => {
      state.settings = await call('save_settings', { settings: { ...state.settings, player_name: f.elements.player_name.value } });
    },
  });
  return ok ? state.settings.player_name : null;
}

// ------------------------------------------------------------------ tabs & filters

function selectTab(name) {
  for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${name}`;
  if (name === 'settings') fillSettings();
}
for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));

function applyFilter(panel) {
  const input = panel.querySelector('.filter');
  const q = (input?.value ?? '').trim().toLowerCase();
  for (const card of panel.querySelectorAll('.card')) card.hidden = !!q && !card.textContent.toLowerCase().includes(q);
}
for (const f of document.querySelectorAll('.filter')) f.addEventListener('input', () => applyFilter(f.closest('.tab-panel')));

for (const b of document.querySelectorAll('[data-open-folder]')) {
  b.addEventListener('click', () => call('open_folder', { which: b.dataset.openFolder, worldId: null }).catch(() => {}));
}

// ------------------------------------------------------------------ hosting banner

async function refreshHosting() {
  state.hosting = await call('hosting');
  const hi = state.hosting;
  $('hosting').hidden = !hi;
  if (hi) {
    $('hosting-name').textContent = hi.world_name;
    $('hosting-url').textContent = hi.lan_url ?? `${hi.local_url} (this computer only)`;
    $('gm-key').textContent = 'hidden';
    $('show-key').textContent = 'Show';
  }
}

async function launch(id, button) {
  const name = await ensureName();
  if (!name) return;
  await busy(button, async () => {
    const info = await call('host_world', { id });
    openGame(info.local_url, { name, key: info.gm_key });
  });
}

$('return-world').addEventListener('click', (e) => launch(state.hosting.world_id, e.currentTarget));
$('stop-world').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  await call('stop_world');
  toast('World stopped and saved.');
  await refreshWorlds();
}));
$('copy-url').addEventListener('click', async () => {
  await navigator.clipboard.writeText(state.hosting.lan_url ?? state.hosting.local_url);
  toast('Address copied. Send it to your players.');
});
$('show-key').addEventListener('click', () => {
  const shown = $('gm-key').textContent !== 'hidden';
  $('gm-key').textContent = shown ? 'hidden' : state.hosting.gm_key;
  $('show-key').textContent = shown ? 'Show' : 'Hide';
});

// ------------------------------------------------------------------ worlds

function systemOptions(selected) {
  return state.packages.filter((p) => p.kind === 'system')
    .map((s) => h('option', { value: s.id, text: s.name, selected: s.id === selected }));
}

function hostedCard(w) {
  const running = state.hosting?.world_id === w.id;
  const launchBtn = h('button', { class: 'primary', text: running ? 'Open' : 'Launch' });
  launchBtn.addEventListener('click', () => launch(w.id, launchBtn));
  return h('li', { class: `card${running ? ' running' : ''}` },
    h('div', { class: 'card-head' },
      h('div', { class: 'badge-icon', text: initial(w.name) }),
      h('div', {},
        h('div', { class: 'card-title' }, w.name, running ? h('span', { class: 'tag ok', text: 'Running' }) : null),
        h('div', { class: 'card-meta', text: `${pkgName(w.system)} · ${w.players} players · ${w.actors} actors · played ${ago(w.modified)}` }),
        w.next_session ? h('div', { class: 'card-meta', text: `Next session: ${new Date(w.next_session).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` }) : null)),
    w.description ? h('div', { class: 'card-desc', text: w.description }) : null,
    h('div', { class: 'card-actions' },
      launchBtn,
      h('button', { text: 'Edit', disabled: running, title: running ? 'Stop the world to edit it' : null, on: { click: () => editWorld(w) } }),
      h('button', { text: 'Backups', on: { click: () => backupsDialog(w.id, w.name) } }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'danger', text: 'Delete', disabled: running, on: { click: () => deleteWorld(w) } })));
}

function joinedCard(g) {
  const joinBtn = h('button', { class: 'primary', text: 'Join' });
  joinBtn.addEventListener('click', () => busy(joinBtn, async () => {
    const t = await call('join_game', { address: g.address, playerName: g.player_name || state.settings.player_name });
    openGame(t.url, { name: t.game.player_name });
  }));
  return h('li', { class: 'card joined' },
    h('div', { class: 'card-head' },
      h('div', { class: 'badge-icon', text: initial(g.name) }),
      h('div', {},
        h('div', { class: 'card-title' }, g.name, g.system ? h('span', { class: 'tag', text: pkgName(g.system) }) : null),
        h('div', { class: 'card-meta', text: `${g.address.replace(/^https?:\/\//, '').replace(/\/$/, '')} · as ${g.player_name} · joined ${ago(g.last_joined)}` }))),
    h('div', { class: 'card-actions' },
      joinBtn,
      h('span', { class: 'spacer' }),
      h('button', {
        text: 'Forget',
        on: {
          click: async () => {
            if (await confirmDialog('Forget this game?', `“${g.name}” will be removed from your list. You can join it again with its address.`, 'Forget')) {
              await call('forget_joined', { id: g.id });
              await refreshWorlds();
            }
          },
        },
      })));
}

async function refreshWorlds() {
  await refreshHosting();
  state.worlds = await call('list_worlds');
  const { hosted, joined } = state.worlds;
  $('hosted-list').replaceChildren(...hosted.map(hostedCard));
  $('hosted-empty').hidden = hosted.length > 0;
  $('joined-list').replaceChildren(...joined.map(joinedCard));
  $('joined-empty').hidden = joined.length > 0;
  const deleted = await call('deleted_worlds');
  $('deleted-note').hidden = deleted.length === 0;
  $('deleted-list').replaceChildren(...deleted.map((id, i) => h('span', {},
    i ? ', ' : '', h('button', { class: 'link', text: id, title: 'Restore from a backup', on: { click: () => backupsDialog(id, id) } }))));
  applyFilter($('tab-worlds'));
}

$('create-world-btn').addEventListener('click', () => createWorldDialog());

async function createWorldDialog(system, { name = '', note = null } = {}) {
  if (!state.packages.some((p) => p.kind === 'system')) {
    toast('Install a game system first (Game Systems tab).', 'error');
    return;
  }
  const w = await dialog({
    title: 'Create a world',
    body: [
      note ? h('p', { class: 'small muted', text: note }) : null,
      h('label', {}, 'World name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'The Sunken Keep', value: name })),
      h('label', {}, 'Game system', h('select', { name: 'system' }, systemOptions(system))),
      h('label', {}, 'Description (optional)', h('textarea', { name: 'description', maxlength: 2000, placeholder: 'What is this campaign about?' })),
    ],
    ok: 'Create',
    onOk: (f) => call('create_world', { name: f.elements.name.value, system: f.elements.system.value, description: f.elements.description.value }),
  });
  if (w) {
    toast(`Created “${w.name}”.`);
    await refreshWorlds();
  }
}

$('new-system-btn').addEventListener('click', async () => {
  const m = await dialog({
    title: 'New game system',
    body: [
      h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'Ember Saga' })),
      h('label', {}, 'Description (optional)', h('textarea', { name: 'description', maxlength: 2000, placeholder: 'A gritty low-magic game of…' })),
      h('p', { class: 'small muted', text: 'It starts empty. You design it in a world: open the world, then Settings → System builder.' }),
    ],
    ok: 'Create',
    onOk: (f) => call('create_system', { name: f.elements.name.value, description: f.elements.description.value }),
  });
  if (!m) return;
  await refreshPackages();
  toast(`Created “${m.name}”.`);
  await createWorldDialog(m.id, { name: `${m.name} workshop`, note: `Make a world that uses ${m.name} to build it in. You can make more worlds with it later.` });
});

async function copySystemDialog(p) {
  const m = await dialog({
    title: `Copy “${p.name}”`,
    body: [
      h('label', {}, 'Name of the copy', h('input', { name: 'name', required: true, maxlength: 80, value: `My ${p.name}` })),
      h('p', { class: 'small muted', text: 'The copy is yours to change in the system builder. Worlds keep using whichever system they were made with.' }),
    ],
    ok: 'Copy',
    onOk: (f) => call('copy_package', { id: p.id, name: f.elements.name.value }),
  });
  if (!m) return;
  await refreshPackages();
  toast(`Copied to “${m.name}”.`);
  await createWorldDialog(m.id, { name: `${m.name} workshop`, note: `Make a world that uses ${m.name} to edit it in the system builder.` });
}

$('join-game-btn').addEventListener('click', async () => {
  const t = await dialog({
    title: 'Join a game',
    body: [
      h('label', {}, 'Server address', h('input', { name: 'address', required: true, placeholder: '192.168.1.20:30080 or game.example.com' })),
      h('label', {}, 'Your name', h('input', { name: 'player_name', required: true, maxlength: 40, value: state.settings.player_name })),
      h('p', { class: 'small muted', text: 'Ask your GM for the address. The game is saved to your list so you can rejoin later.' }),
    ],
    ok: 'Join',
    onOk: (f) => call('join_game', { address: f.elements.address.value, playerName: f.elements.player_name.value }),
  });
  if (t) openGame(t.url, { name: t.game.player_name });
});

async function editWorld(w) {
  const modules = state.packages.filter((p) => p.kind === 'module' && (!p.systems.length || p.systems.includes(w.system)));
  const themes = state.packages.filter((p) => p.kind === 'theme');
  const saved = await dialog({
    title: `Edit “${w.name}”`,
    wide: true,
    body: [
      h('label', {}, 'World name', h('input', { name: 'name', required: true, maxlength: 80, value: w.name })),
      h('label', {}, 'Description', (() => { const t = h('textarea', { name: 'description', maxlength: 2000 }); t.value = w.description; return t; })()),
      h('div', { class: 'small muted', text: `Game system: ${pkgName(w.system)} (fixed when the world is created). Add players and their passwords in-game under Settings.` }),
      h('label', {}, 'Next session', h('input', { name: 'next_session', type: 'datetime-local', value: w.next_session ?? '' })),
      h('label', {}, 'Theme', h('select', { name: 'theme' },
        h('option', { value: '', text: 'Hearth (default)' }),
        themes.map((t) => h('option', { value: t.id, text: t.name, selected: w.theme === t.id })))),
      h('div', { class: 'small muted', text: 'Modules' }),
      modules.length
        ? h('div', { class: 'checklist' }, modules.map((m) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', name: 'module', value: m.id, checked: w.modules.includes(m.id) }),
          h('span', {}, m.name, h('span', { class: 'muted small', text: `  v${m.version}` })))))
        : h('p', { class: 'muted small', text: 'No modules installed for this system.' }),
    ],
    onOk: (f) => call('update_world', {
      id: w.id,
      edit: {
        name: f.elements.name.value,
        description: f.elements.description.value,
        theme: f.elements.theme.value || null,
        next_session: f.elements.next_session.value || null,
        modules: [...f.querySelectorAll('input[name=module]:checked')].map((i) => i.value),
      },
    }),
  });
  if (saved) {
    toast('World saved.');
    await refreshWorlds();
  }
}

async function deleteWorld(w) {
  const ok = await confirmDialog(`Delete “${w.name}”?`,
    'The world is removed from your list. A final backup is kept, so you can bring it back from the Backups list later.', 'Delete world');
  if (!ok) return;
  await call('delete_world', { id: w.id }).catch(() => {});
  toast(`Deleted “${w.name}”. A backup was kept.`);
  await refreshWorlds();
}

// ------------------------------------------------------------------ backups

async function backupsDialog(worldId, worldName) {
  const running = state.hosting?.world_id === worldId;
  const list = h('ul', { class: 'backup-list' });
  const render = async () => {
    const items = await call('list_backups', { worldId });
    if (!items.length) {
      list.replaceChildren(h('li', {}, h('span', { class: 'muted', text: 'No backups yet.' })));
      return;
    }
    list.replaceChildren(...items.map((b) => h('li', {},
      h('div', { class: 'grow' },
        h('div', {}, new Date(b.created).toLocaleString(), h('span', { class: `tag${b.label === 'manual' ? ' accent' : ''}`, text: b.label })),
        h('div', { class: 'small muted', text: size(b.size) })),
      h('button', {
        type: 'button', text: 'Restore', disabled: running, title: running ? 'Stop the world to restore' : null,
        on: {
          click: async () => {
            const sure = window.confirm(`Restore “${worldName}” to ${new Date(b.created).toLocaleString()}?\n\nThe current state is backed up first.`);
            if (!sure) return;
            await call('restore_backup', { worldId, file: b.file });
            toast('Backup restored.');
            await render();
            await refreshWorlds();
          },
        },
      }),
      h('button', {
        type: 'button', class: 'danger', text: 'Delete',
        on: {
          click: async () => {
            if (!window.confirm('Delete this backup permanently?')) return;
            await call('delete_backup', { worldId, file: b.file });
            await render();
          },
        },
      }))));
  };
  const backupNow = h('button', {
    type: 'button', class: 'primary', text: 'Back up now',
    on: { click: (e) => busy(e.currentTarget, async () => { await call('create_backup', { worldId }); toast('Backup created.'); await render(); }) },
  });
  const openBtn = h('button', { type: 'button', text: 'Open folder', on: { click: () => call('open_folder', { which: 'backups', worldId }).catch(() => {}) } });
  render();
  await dialog({
    title: `Backups · ${worldName}`,
    wide: true,
    body: [
      h('div', { class: 'row' }, backupNow, openBtn,
        running ? h('span', { class: 'small muted', text: 'Running now: backups include the latest changes; stop the world to restore.' }) : null),
      list,
    ],
    ok: null,
    cancel: 'Close',
  });
}

// ------------------------------------------------------------------ packages

function packageCard(p) {
  const kindTag = p.kind === 'theme' ? 'Theme' : p.kind === 'module' ? 'Module' : null;
  const usedBy = p.used_by.length ? `Used by ${p.used_by.join(', ')}` : 'Not used by any of your worlds';
  return h('li', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'badge-icon', text: initial(p.name) }),
      h('div', {},
        h('div', { class: 'card-title' }, p.name,
          kindTag ? h('span', { class: 'tag', text: kindTag }) : null,
          h('span', { class: `tag${p.source === 'installed' ? ' accent' : ''}`, text: p.source === 'installed' ? 'Installed' : 'Built-in' })),
        h('div', { class: 'card-meta', text: [`v${p.version}`, p.authors.join(', '), p.license].filter(Boolean).join(' · ') }))),
    p.description ? h('div', { class: 'card-desc', text: p.description }) : null,
    h('div', { class: 'card-meta', text: usedBy }),
    p.kind === 'system' && p.source !== 'installed'
      ? h('div', { class: 'card-actions' }, h('span', { class: 'spacer' }), h('button', { text: 'Copy to edit', title: 'Built-in systems can\'t be changed; make your own copy', on: { click: () => copySystemDialog(p) } }))
      : null,
    p.source === 'installed'
      ? h('div', { class: 'card-actions' }, h('span', { class: 'spacer' }),
        p.kind === 'system' ? h('button', { text: 'Copy', on: { click: () => copySystemDialog(p) } }) : null,
        h('button', {
        class: 'danger', text: 'Remove',
        on: {
          click: async () => {
            const warn = p.used_by.length ? ` It is used by: ${p.used_by.join(', ')}.` : '';
            if (!(await confirmDialog(`Remove “${p.name}”?`, `The package files are deleted from this computer.${warn}`, 'Remove'))) return;
            await call('uninstall_package', { id: p.id });
            toast(`Removed “${p.name}”.`);
            await refreshPackages();
          },
        },
      }))
      : null);
}

async function refreshPackages() {
  state.packages = await call('list_packages');
  const systems = state.packages.filter((p) => p.kind === 'system');
  const mods = state.packages.filter((p) => p.kind !== 'system');
  $('systems-list').replaceChildren(...systems.map(packageCard));
  $('systems-empty').hidden = systems.length > 0;
  $('modules-list').replaceChildren(...mods.map(packageCard));
  $('modules-empty').hidden = mods.length > 0;
  applyFilter($('tab-systems'));
  applyFilter($('tab-modules'));
}

async function afterInstall(m) {
  if (!m) return;
  toast(`Installed “${m.name}” v${m.version}.`);
  await refreshPackages();
  await refreshWorlds();
}

for (const b of document.querySelectorAll('[data-install]')) {
  b.addEventListener('click', async () => {
    if (b.dataset.install === 'file') {
      await busy(b, async () => afterInstall(await call('install_package_file')));
      return;
    }
    const m = await dialog({
      title: 'Install from a link',
      body: [
        h('label', {}, 'Link to a package .zip', h('input', { name: 'url', type: 'url', required: true, placeholder: 'https://github.com/someone/their-system/archive/refs/heads/main.zip' })),
        h('p', { class: 'small muted', text: 'Systems, modules and themes are zip files containing a hearth.toml. Only install packages you trust: modules run code in the game.' }),
      ],
      ok: 'Install',
      onOk: (f) => call('install_package_url', { url: f.elements.url.value }),
    });
    await afterInstall(m);
  });
}

// ------------------------------------------------------------------ settings & updates

function fillSettings() {
  const f = $('settings-form');
  const s = state.settings;
  f.elements.player_name.value = s.player_name;
  f.elements.port.value = s.port;
  f.elements.allow_network.checked = s.allow_network;
  f.elements.backup_on_launch.checked = s.backup_on_launch;
  f.elements.keep_auto_backups.value = s.keep_auto_backups;
  f.elements.check_updates.checked = s.check_updates;
  $('settings-saved').textContent = '';
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  await busy(f.querySelector('[type=submit]'), async () => {
    state.settings = await call('save_settings', {
      settings: {
        player_name: f.elements.player_name.value,
        port: Number(f.elements.port.value),
        allow_network: f.elements.allow_network.checked,
        backup_on_launch: f.elements.backup_on_launch.checked,
        keep_auto_backups: Number(f.elements.keep_auto_backups.value),
        check_updates: f.elements.check_updates.checked,
      },
    });
    fillSettings();
    $('settings-saved').textContent = state.hosting ? 'Saved. Hosting changes apply next time you launch a world.' : 'Saved.';
  });
});

async function checkUpdate({ quiet = false } = {}) {
  let u;
  try { u = await invoke('check_update'); } catch (e) { if (!quiet) toast(`Couldn't check for updates: ${e}`, 'error'); return; }
  $('update-dot').hidden = !u.available;
  $('update-btn').title = u.available ? `Version ${u.latest} is available` : 'Check for updates';
  if (quiet) return;
  if (!u.configured) {
    await dialog({ title: 'Updates', body: [h('p', { text: `You're running Hearth ${u.current}. Update checks switch on once Hearth publishes releases on GitHub.` })], ok: null, cancel: 'Close' });
  } else if (u.available && u.can_install) {
    await installDialog(u);
  } else if (u.available) {
    // Older releases can't be installed from inside the app; send them to the page.
    const go = await dialog({ title: 'Update available', body: [h('p', { text: `Hearth ${u.latest} is available (you have ${u.current}).` })], ok: 'Download', cancel: 'Later' });
    if (go && u.url) call('open_url', { url: u.url }).catch(() => {});
  } else if (!u.latest) {
    toast(`You're running Hearth ${u.current}. No releases have been published on GitHub yet.`);
  } else {
    toast(`You're up to date (Hearth ${u.current}).`);
  }
}
/** "Update now" dialog: download with a progress bar, install, relaunch. */
async function installDialog(u) {
  const bar = h('progress', { max: 100, value: 0, class: 'update-progress', hidden: true });
  const status = h('p', { class: 'small muted', text: '' });
  const notes = u.notes ? h('div', { class: 'release-notes', text: u.notes }) : null;
  const hostingNote = state.hosting
    ? h('p', { class: 'small', text: `“${state.hosting.world_name}” is running. It will be saved and stopped before updating.` })
    : null;
  let unlisten = null;
  try {
    unlisten = await window.__TAURI__.event.listen('update-progress', ({ payload }) => {
      bar.hidden = false;
      if (payload.installing) {
        bar.removeAttribute('value'); // indeterminate
        status.textContent = 'Installing… Hearth will restart in a moment.';
      } else if (payload.total) {
        bar.value = Math.round((payload.downloaded / payload.total) * 100);
        status.textContent = `Downloading… ${size(payload.downloaded)} of ${size(payload.total)}`;
      } else {
        status.textContent = `Downloading… ${size(payload.downloaded)}`;
      }
    });
  } catch { /* progress is nice-to-have */ }
  await dialog({
    title: `Update to Hearth ${u.latest}`,
    wide: true,
    body: [
      h('p', { text: `You have ${u.current}. Hearth downloads the right version for this computer, installs it and restarts.` }),
      notes, hostingNote, bar, status,
      u.url ? h('button', { type: 'button', class: 'link', text: 'View the release on GitHub', on: { click: () => call('open_url', { url: u.url }).catch(() => {}) } }) : null,
    ],
    ok: 'Update now',
    cancel: 'Later',
    onOk: async (f) => {
      const buttons = [...f.querySelectorAll('button')];
      buttons.forEach((b) => { b.disabled = true; });
      status.textContent = 'Starting download…';
      bar.hidden = false;
      try {
        await call('install_update'); // on success the app restarts and this never returns
      } catch (e) {
        buttons.forEach((b) => { b.disabled = false; });
        bar.hidden = true;
        status.textContent = 'The update didn\'t finish. Check your connection and try again, or download it from GitHub.';
        throw e;
      }
      return false;
    },
  });
  unlisten?.();
}

$('update-btn').addEventListener('click', () => checkUpdate());
$('check-update-btn').addEventListener('click', () => checkUpdate());

// ------------------------------------------------------------------ start

(async () => {
  try {
    [state.info, state.settings] = await Promise.all([call('app_info'), call('get_settings')]);
    $('path-worlds').textContent = state.info.worlds_dir;
    $('path-packages').textContent = state.info.packages_dir;
    $('path-backups').textContent = state.info.backups_dir;
    $('version-line').textContent = `Hearth ${state.info.version}${state.info.dev_build ? ' (development build)' : ''}`;
    if (state.info.dev_build) {
      // Make it obvious which Hearth is open when an installed copy exists too.
      document.querySelector('.top-actions').prepend(h('span', {
        class: 'dev-badge', text: 'DEV BUILD',
        title: `Running from source. Game client: ${state.info.web_dir}`,
      }));
      document.title = 'Hearth (dev)';
    }
    await refreshPackages();
    await refreshWorlds();
    if (state.settings.check_updates && state.info.updates_configured) checkUpdate({ quiet: true });
  } catch { /* toasted */ }
})();
