// Character creation: steps a new character goes through, such as setting
// ability scores. The system lists the steps and the methods each offers
// (standard array, point buy, rolls, typing them in); each world picks which
// methods players may use and can change their numbers (e.g. 32 points instead
// of 27). The server rolls and checks everything; see crates/hearth-core/src/creation.rs.

import { store, isGM, ownsActor, systemInfo, getPath, pathPatch } from './store.js';
import { el, openWindow, toast } from './ui.js';
import { nodeAt } from './layout-sheet.js';
import { hooks } from './hooks.js';

// Rolls arrive and settings change as ops: keep open dialogs current.
hooks.on('op', (op) => {
  creationOnChange();
  if (op.op === 'world_update') creationSettingsOnChange();
});

/** The numbers a world may change on a method. */
export const ADJUSTABLE = { array: ['values'], pointbuy: ['points', 'min', 'max'], roll: ['formula', 'count'], manual: ['min', 'max'] };
const KIND_NAMES = { array: 'Fixed values (e.g. a standard array)', pointbuy: 'Point buy', roll: 'Roll dice', manual: 'Enter your own' };

/** The system's creation steps. */
export function creationSteps() {
  return systemInfo().blueprint?.creation ?? [];
}

/** The world's settings for a step: { allowed, default, lock, methods: { id: overrides } }. */
export function worldSettings(stepId) {
  return getPath(store.world?.settings ?? {}, `core.creation.${stepId}`) ?? {};
}

/** The methods this world allows for a step, with its numbers (mirrors the server). */
export function worldMethods(step) {
  const st = worldSettings(step.id);
  const allowed = Array.isArray(st.allowed) ? st.allowed : null;
  return (step.methods ?? []).filter((m) => !allowed || allowed.includes(m.id)).map((m) => {
    const over = st.methods?.[m.id];
    if (!over) return m;
    const out = { ...m };
    for (const k of [...(ADJUSTABLE[m.kind] ?? []), 'label']) if (over[k] != null && over[k] !== '') out[k] = over[k];
    return out;
  });
}

const stepState = (actor, step) => actor.flags?.core?.creation?.[step.id] ?? {};

/** The actor's entries for a step (Strength, Dexterity…), in the system's order, with names. */
function entriesOf(actor, step) {
  const list = getPath(actor.data, step.path) ?? {};
  const node = nodeAt((systemInfo().blueprint?.actor_types ?? []).find((t) => t.key === actor.kind)?.children ?? [], step.path);
  const order = (node?.entries ?? []).map((e) => e.key);
  const names = Object.fromEntries((node?.entries ?? []).map((e) => [e.key, e.label || e.key]));
  return Object.keys(list)
    .sort((a, b) => ((order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9)) || a.localeCompare(b))
    .map((key) => ({ key, name: names[key] ?? key, current: Number(list[key]?.[step.field || 'value'] ?? 0) }));
}

/** Steps this actor still has to do (for its owners). */
export function pendingSteps(actor) {
  if (!ownsActor(actor.id)) return [];
  return creationSteps().filter((s) => !stepState(actor, s).done && entriesOf(actor, s).length && worldMethods(s).length);
}

/** A prompt at the top of a new character's sheet; for the GM, a way to let a player redo a step. */
export function creationBar(actor, api) {
  const pending = pendingSteps(actor);
  if (pending.length) {
    return el('div.new-character', {},
      el('span.grow', { text: `New character: set their ${pending.map((s) => (s.label || s.id).toLowerCase()).join(', ')}.` }),
      el('button.primary', { type: 'button', text: `Set ${(pending[0].label || pending[0].id).toLowerCase()}`, on: { click: () => openCreation(api, actor.id, pending[0].id) } }));
  }
  return null;
}

/** GM: steps this actor has done, with a button to let them do it again. */
export function creationResetButtons(actor, api) {
  if (!isGM()) return [];
  return creationSteps().filter((s) => stepState(actor, s).done || stepState(actor, s).rolls).map((s) => el('button.small', {
    type: 'button', text: `↺ Redo ${(s.label || s.id).toLowerCase()}`, title: 'Let them set these again (their rolls are forgotten)',
    on: { click: () => { if (confirm(`Let ${actor.name}'s ${(s.label || s.id).toLowerCase()} be set again? Rolls already made are forgotten.`)) api.update.actor(actor.id, pathPatch(`flags.core.creation.${s.id}`, null)); } },
  }));
}

// ------------------------------------------------------------------ the dialog

const windows = new Map(); // actor/step → render()

/** Set a step's scores: pick a method, then assign. */
export function openCreation(api, actorId, stepId) {
  const step = creationSteps().find((s) => s.id === stepId);
  if (!step) return;
  const key = `${actorId}/${stepId}`;
  if (windows.has(key)) { openWindow({ id: `creation-${key}` }); return; }
  const actor0 = store.world.actors[actorId];
  const win = openWindow({ id: `creation-${key}`, title: `${step.label || step.id} for ${actor0?.name ?? ''}`, width: 520 });
  const st = { method: null, assign: {} };
  const render = () => {
    const actor = store.world.actors[actorId];
    if (!actor) { win.close(); return; }
    const methods = worldMethods(step);
    const done = stepState(actor, step);
    if (done.done && worldSettings(step.id).lock !== false && !isGM()) {
      win.body.replaceChildren(el('p', { text: 'These are set. The GM can let you set them again.' }));
      return;
    }
    // Once rolled, that method stays (no rolling with another to fish for better numbers).
    const rolledWith = done.rolls ? done.method : null;
    if (rolledWith) st.method = rolledWith;
    st.method ??= methods.find((m) => m.id === worldSettings(step.id).default)?.id ?? methods[0]?.id;
    const m = methods.find((x) => x.id === st.method);
    if (!m) { win.body.replaceChildren(el('p.muted', { text: 'The GM hasn\'t allowed any way to set these in this world.' })); return; }
    const entries = entriesOf(actor, step);
    const parts = [];
    parts.push(el('div.creation-methods', { role: 'radiogroup', 'aria-label': 'Method' }, ...methods.map((x) => el('label', {
      class: x.id === m.id ? 'creation-method on' : 'creation-method', title: rolledWith && x.id !== rolledWith ? 'You\'ve rolled already' : '',
    }, el('input', { type: 'radio', name: `cm-${key}`, checked: x.id === m.id, disabled: !!rolledWith && x.id !== rolledWith, on: { change: () => { st.method = x.id; st.assign = {}; render(); } } }), x.label || x.id))));
    const body = el('div.creation-body');
    parts.push(body);
    const confirmBtn = el('button.primary', { type: 'button', text: 'Set them' });
    const err = el('p.error-text');
    const send = () => {
      err.textContent = '';
      api._send({ type: 'creation_apply', actor_id: actorId, step: step.id, method: m.id, assign: st.assign });
      // Close once the server has set them (it reports problems as a toast).
      let tries = 0;
      const check = () => {
        if (stepState(store.world.actors[actorId] ?? {}, step).done) { win.close(); return; }
        if (++tries < 20) setTimeout(check, 150);
      };
      check();
    };
    confirmBtn.addEventListener('click', send);

    // Assign values from a pool (an array, or rolls) to the entries, each once.
    const assignFrom = (pool) => {
      const used = new Set(Object.values(st.assign));
      body.append(el('p.muted.small', { text: 'Give each score one of the values; each value once.' }),
        el('div.creation-pool', {}, ...pool.map((v, i) => el('span', { class: used.has(i) ? 'chip used' : 'chip', text: String(v) }))));
      for (const e of entries) {
        const sel = el('select', { 'aria-label': e.name, on: { change: (ev) => { if (ev.target.value === '') delete st.assign[e.key]; else st.assign[e.key] = Number(ev.target.value); render(); } } },
          el('option', { value: '', text: '—' }),
          ...pool.map((v, i) => el('option', { value: i, text: String(v), disabled: used.has(i) && st.assign[e.key] !== i, selected: st.assign[e.key] === i })));
        body.append(el('div.row.creation-row', {}, el('span.grow', { text: e.name }), sel));
      }
      confirmBtn.disabled = entries.some((e) => st.assign[e.key] == null);
    };

    if (m.kind === 'array') {
      assignFrom(m.values ?? []);
    } else if (m.kind === 'roll') {
      const n = m.count || entries.length;
      if (!done.rolls) {
        body.append(el('p', { text: `Roll ${m.formula} ${n} times${m.in_order ? ', in order' : ', then place them where you like'}. The rolls are made openly and posted to chat.` }),
          el('button.primary', { type: 'button', text: `🎲 Roll ${m.formula} × ${n}`, on: { click: (ev) => { ev.target.disabled = true; api._send({ type: 'creation_roll', actor_id: actorId, step: step.id, method: m.id }); } } }));
        confirmBtn.disabled = true;
      } else if (m.in_order) {
        body.append(el('p.muted.small', { text: 'Rolled in order:' }), ...entries.map((e, i) => el('div.row.creation-row', {}, el('span.grow', { text: e.name }), el('strong', { text: String(done.rolls[i] ?? '—') }))));
      } else {
        assignFrom(done.rolls);
      }
    } else if (m.kind === 'pointbuy') {
      const lo = m.min ?? 8, hi = m.max ?? 15;
      for (const e of entries) st.assign[e.key] ??= lo;
      const cost = (v) => m.costs?.[String(v)];
      const spent = entries.reduce((s, e) => s + (cost(st.assign[e.key]) ?? 0), 0);
      body.append(el('p', {}, el('strong', { text: `${m.points - spent}` }), ` of ${m.points} points left. Scores ${lo}–${hi}.`));
      for (const e of entries) {
        const v = st.assign[e.key];
        const bump = (d) => {
          const n = v + d;
          if (n < lo || n > hi || cost(n) == null) return;
          if (d > 0 && spent - (cost(v) ?? 0) + cost(n) > m.points) return;
          st.assign[e.key] = n;
          render();
        };
        body.append(el('div.row.creation-row', {}, el('span.grow', { text: e.name }),
          el('button.icon', { type: 'button', text: '−', 'aria-label': `Lower ${e.name}`, on: { click: () => bump(-1) } }),
          el('strong.creation-score', { text: String(v) }),
          el('button.icon', { type: 'button', text: '+', 'aria-label': `Raise ${e.name}`, on: { click: () => bump(1) } }),
          el('small.muted', { text: `costs ${cost(v) ?? '—'}` })));
      }
      confirmBtn.disabled = spent > m.points;
    } else if (m.kind === 'manual') {
      body.append(el('p.muted.small', { text: `Type them in${m.min != null || m.max != null ? ` (${m.min ?? 'any'}–${m.max ?? 'any'})` : ''}.` }));
      for (const e of entries) {
        st.assign[e.key] ??= e.current || m.min || 10;
        body.append(el('div.row.creation-row', {}, el('span.grow', { text: e.name }), el('input', {
          type: 'number', min: m.min ?? null, max: m.max ?? null, value: st.assign[e.key], 'aria-label': e.name, style: 'width: 80px',
          on: { change: (ev) => { st.assign[e.key] = Number(ev.target.value); } },
        })));
      }
    }
    parts.push(err, el('div.row', {}, el('span.grow'), el('button', { type: 'button', text: 'Later', on: { click: () => win.close() } }), confirmBtn));
    win.body.replaceChildren(...parts);
  };
  windows.set(key, render);
  win.onClose(() => windows.delete(key));
  render();
}

/** Keep open creation dialogs current (rolls arriving, settings changing). */
export function creationOnChange() {
  for (const r of windows.values()) r();
}

// ------------------------------------------------------------------ GM: this world's choices

/** Which methods players may use in this world, the default, and the numbers. */
export function openCreationSettings(api) {
  const steps = creationSteps();
  const win = openWindow({ id: 'creation-settings', title: 'Character creation in this world', width: 560 });
  const render = () => {
    const parts = [el('p.muted.small', { text: 'Pick how players set up new characters here. Blank numbers use the system\'s; other worlds using this system aren\'t affected.' })];
    if (!steps.length) parts.push(el('p', { text: 'This system has no character creation steps. Add them in the system builder (Rules → Character creation).' }));
    for (const step of steps) {
      const st = worldSettings(step.id);
      const allowed = Array.isArray(st.allowed) ? st.allowed : step.methods.map((m) => m.id);
      const save = (patch) => api.settings.set('core', 'creation', { [step.id]: patch });
      const box = el('fieldset.bfield', {}, el('legend', { text: step.label || step.id }));
      for (const m of step.methods ?? []) {
        const on = allowed.includes(m.id);
        const over = st.methods?.[m.id] ?? {};
        const row = el('div.creation-setting', {},
          el('label.check', {}, el('input', {
            type: 'checkbox', checked: on,
            on: { change: (e) => { const next = e.target.checked ? [...new Set([...allowed, m.id])] : allowed.filter((x) => x !== m.id); save({ allowed: step.methods.map((x) => x.id).filter((x) => next.includes(x)) }); } },
          }), el('strong', { text: m.label || m.id }), el('small.muted', { text: ` ${KIND_NAMES[m.kind] ?? m.kind}` })),
          el('label.check', {}, el('input', { type: 'radio', name: `def-${step.id}`, checked: (st.default ?? allowed[0]) === m.id, disabled: !on, on: { change: () => save({ default: m.id }) } }), 'Default'));
        const fields = el('div.row.creation-numbers');
        for (const k of ADJUSTABLE[m.kind] ?? []) {
          const sys = m[k];
          const shown = k === 'values' ? (Array.isArray(sys) ? sys.join(', ') : '') : sys ?? '';
          const cur = over[k] == null ? '' : k === 'values' ? over[k].join(', ') : over[k];
          const input = el('input', {
            value: cur, placeholder: String(shown), type: ['formula', 'values'].includes(k) ? 'text' : 'number', style: k === 'values' ? 'width: 180px' : 'width: 80px',
            on: {
              change: (e) => {
                const raw = e.target.value.trim();
                let v = null;
                if (raw !== '') v = k === 'values' ? raw.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : k === 'formula' ? raw : Number(raw);
                save({ methods: { [m.id]: { [k]: v } } });
              },
            },
          });
          const names = { values: 'Values', points: 'Points to spend', min: 'Lowest', max: 'Highest', formula: 'Dice', count: 'Rolls' };
          fields.append(el('label', {}, `${names[k]} `, input, el('small.muted', { text: ` system: ${shown === '' ? 'one per score' : shown}` })));
        }
        if (fields.childElementCount && on) row.append(fields);
        box.append(row);
      }
      box.append(el('label.check', {}, el('input', { type: 'checkbox', checked: st.lock !== false, on: { change: (e) => save({ lock: e.target.checked }) } }),
        'Lock them once set (you can let a player redo them from their sheet)'));
      parts.push(box);
    }
    win.body.replaceChildren(...parts);
  };
  render();
  const off = () => { if (win.el.isConnected) render(); };
  win.onClose(() => { settingsWindows.delete(off); });
  settingsWindows.add(off);
}
const settingsWindows = new Set();

/** Re-draw open settings windows after the world changes. */
export function creationSettingsOnChange() {
  for (const f of settingsWindows) f();
}
