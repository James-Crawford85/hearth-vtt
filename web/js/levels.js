// Levels: a scene's floors above the ground and cellars below it.
//
// scene.levels = [{ id, name, elevation }] besides the ground (id '', elevation 0, named
// scene.ground_name or "Ground"); elevation > 0 is above, < 0 below. Tokens, walls, lights and
// drawings carry `level` (missing: the ground). The ground's sketch is scene.sketch, the others'
// scene.level_sketches[id]. Links (scene.links) lead from one level to another.
//
// What you see is one level: the GM picks it (the level bar), a player sees their token's. The
// levels below show through where it has no floor.
import { el, openWindow } from './ui.js';
import { hooks } from './hooks.js';
import { isGM, ownsActor } from './store.js';

/** All the scene's levels, the ground included, lowest first. */
export function levelsOf(s) {
  const ground = { id: '', name: s?.ground_name || 'Ground', elevation: 0 };
  return [ground, ...(s?.levels ?? [])].sort((a, b) => a.elevation - b.elevation);
}

export const levelOf = (s, id) => levelsOf(s).find((l) => l.id === (id ?? '')) ?? null;
export const levelName = (s, id) => levelOf(s, id)?.name ?? 'Ground';
export const onLevel = (x, level) => (x?.level ?? '') === (level ?? '');

/** A level's sketch (the ground's is scene.sketch). */
export const sketchOf = (s, level) => (level ? s?.level_sketches?.[level] : s?.sketch) ?? null;

/** An id made from a sketch-made one on a level: the same on the ground, `@level` above or below. */
export const skId = (id, level) => (level ? `${id}@${level}` : id);

/** The level just above / below one, or null. */
export function levelNext(s, level, dir) {
  const list = levelsOf(s);
  const i = list.findIndex((l) => l.id === (level ?? ''));
  return list[i + dir] ?? null;
}

/** The level bar (bottom left of the board): which level you're looking at, and (GM) the levels window. */
export function registerLevels(api) {
  const board = api.board;
  const bar = el('div.level-bar', { hidden: true });
  document.getElementById('app')?.append(bar);

  function render() {
    const s = board.scene;
    const levels = levelsOf(s);
    const gm = isGM();
    bar.hidden = !s || (!gm && levels.length < 2);
    if (bar.hidden) return;
    const cur = board.level;
    if (gm) {
      const up = levelNext(s, cur, 1), down = levelNext(s, cur, -1);
      bar.replaceChildren(
        el('span.muted', { text: 'Level' }),
        el('select', { title: 'The level you\'re looking at (and building on)', on: { change: (e) => board.setLevel(e.target.value) } },
          ...[...levels].reverse().map((l) => el('option', { value: l.id, text: l.name, selected: l.id === cur }))),
        el('button', { type: 'button', text: '▲', title: up ? `Up to ${up.name}` : 'No level above', disabled: !up, on: { click: () => board.setLevel(up.id) } }),
        el('button', { type: 'button', text: '▼', title: down ? `Down to ${down.name}` : 'No level below', disabled: !down, on: { click: () => board.setLevel(down.id) } }),
        el('button', { type: 'button', text: 'Levels…', title: 'Add, rename and remove this scene\'s levels', on: { click: () => openLevels(api) } }),
      );
    } else {
      // Players: the levels their tokens are on; picking one looks at a token there.
      const mine = Object.values(s.tokens).filter((t) => t.actor_id && ownsActor(t.actor_id));
      const with_ = levels.filter((l) => mine.some((t) => onLevel(t, l.id)));
      bar.replaceChildren(
        el('span.muted', { text: 'Level' }),
        with_.length > 1
          ? el('select', { on: { change: (e) => board.focusLevel(e.target.value) } }, ...[...with_].reverse().map((l) => el('option', { value: l.id, text: l.name, selected: l.id === cur })))
          : el('b', { text: levelName(s, cur) }),
      );
    }
  }
  api.levels = { render, open: () => openLevels(api) };
  // Keep the bar and the levels window up to date.
  for (const ev of ['ready', 'op:scene_update', 'op:scene_activate', 'op:token_update', 'op:token_create', 'op:token_delete', 'board:tool', 'board:level']) hooks.on(ev, () => { render(); if (ev === 'op:scene_update') levelsWindowRender?.(); });
  return render;
}

/** GM: the scene's levels, to add, rename and remove. */
export function openLevels(api) {
  const board = api.board;
  const s = board.scene;
  if (!s) return;
  const win = openWindow({ id: 'levels', title: `Levels: ${s.name}`, width: 380 });
  const save = (levels) => api.update.scene(s.id, { levels });
  const others = () => (board.scene?.levels ?? []).map((l) => ({ ...l }));

  function add(dir) {
    const list = levelsOf(board.scene);
    const elev = dir > 0 ? Math.max(...list.map((l) => l.elevation)) + 1 : Math.min(...list.map((l) => l.elevation)) - 1;
    const id = Math.random().toString(36).slice(2, 10);
    const name = dir > 0 ? (elev === 1 ? 'Upper floor' : `Floor ${elev + 1}`) : (elev === -1 ? 'Cellar' : `Cellar ${-elev}`);
    save([...others(), { id, name, elevation: elev }]);
    setTimeout(() => { board.setLevel(id); render(); }, 150);
  }

  function remove(level) {
    const sc = board.scene;
    const n = (m) => Object.values(sc[m] ?? {}).filter((x) => onLevel(x, level.id)).length;
    const what = [n('tokens') && `${n('tokens')} token(s) go to the ground`, n('walls') && `${n('walls')} walls`, n('lights') && `${n('lights')} lights`, n('drawings') && `${n('drawings')} drawings`].filter(Boolean);
    if (!confirm(`Remove ${level.name}? Its sketch, walls, lights and drawings are deleted${what.length ? ` (${what.join(', ')})` : ''}.`)) return;
    // Its sketch and what was made from it, then everything else on it, then the level.
    api.op({ op: 'sketch_update', scene_id: sc.id, level: level.id, patch: Object.fromEntries(['cells', 'floor', 'edges', 'shapes', 'lines', 'props', 'styles', 'roofs'].map((k) => [k, null])), walls: {}, lights: {}, links: {} });
    for (const t of Object.values(sc.tokens)) if (onLevel(t, level.id)) api.update.token(sc.id, t.id, { level: null });
    for (const [m, op] of [['walls', 'wall_delete'], ['lights', 'light_delete'], ['drawings', 'drawing_delete']]) {
      for (const x of Object.values(sc[m] ?? {})) if (onLevel(x, level.id)) api.op({ op, scene_id: sc.id, id: x.id });
    }
    save(others().filter((l) => l.id !== level.id));
    if (board.level === level.id) board.setLevel('');
    setTimeout(render, 150);
  }

  function render() {
    const sc = board.scene;
    if (!sc) return;
    const rows = [...levelsOf(sc)].reverse().map((l) => el('div.row', { style: 'gap: 6px; align-items: center; margin-bottom: 4px' },
      el('input', {
        value: l.name, style: 'flex: 1', title: 'Its name',
        on: {
          change: (e) => {
            const name = e.target.value.trim() || l.name;
            if (!l.id) api.update.scene(sc.id, { ground_name: name === 'Ground' ? null : name });
            else save(others().map((x) => (x.id === l.id ? { ...x, name } : x)));
            setTimeout(() => api.levels?.render(), 150);
          },
        },
      }),
      el('span.small.muted', { text: l.elevation === 0 ? 'ground' : l.elevation > 0 ? `+${l.elevation}` : `${l.elevation}`, style: 'width: 44px; text-align: right' }),
      el('button', { type: 'button', text: 'View', title: 'Look at this level', on: { click: () => board.setLevel(l.id) } }),
      l.id ? el('button.danger', { type: 'button', text: 'Remove', on: { click: () => remove(l) } }) : el('span', { style: 'width: 64px' })));
    win.body.replaceChildren(
      el('p.small.muted', { text: 'Each level has its own sketch, walls, lights, drawings and tokens. Levels below show through where a level has no floor. Stairs (and ladders) lead between levels: select one with the sketch Select tool and choose where it leads.' }),
      ...rows,
      el('div.row', { style: 'gap: 6px; margin-top: 8px' },
        el('button', { type: 'button', text: 'Add a floor above', on: { click: () => add(1) } }),
        el('button', { type: 'button', text: 'Add a cellar below', on: { click: () => add(-1) } })),
    );
  }
  render();
  levelsWindowRender = render;
}
let levelsWindowRender = null;
