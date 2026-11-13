// Import a ready-made map as a scene (GM): the map (image or video) with its grid, walls, doors
// and lights. Reads two kinds of scene file:
//   - Foundry-style scene JSON, as Dungeon Alchemist exports beside its PNG or MP4 map
//     (width, height, grid, walls with move/sense/sound/door, lights in grid distance units);
//   - Universal VTT (.dd2vtt, .uvtt, .df2vtt): Dungeondraft, Dungeon Alchemist and others, with
//     the map image inside and walls, doors and lights in grid squares.
import { el, openWindow, toast } from './ui.js';
import { mediaSize } from './media.js';

const newId = () => Math.random().toString(36).slice(2, 14);
const hex = (s) => {
  const h = String(s ?? '').replace(/^#/, '').trim();
  if (/^[0-9a-f]{8}$/i.test(h)) return `#${h.slice(2)}`; // AARRGGBB
  if (/^[0-9a-f]{6}$/i.test(h)) return `#${h}`;
  return null;
};

/** A Foundry wall's kind in Hearth: what it blocks (movement, sight, sound) and whether it's a door. */
export function foundryWallKind(w) {
  if (w.door === 1) return 'door';
  if (w.door === 2) return 'secret_door';
  const move = (w.move ?? 1) !== 0;
  const sight = w.sense ?? w.sight ?? 1; // 0: none, 1: blocks, 2: limited (newer Foundry: sight)
  const sound = (w.sound ?? 1) !== 0;
  if (!move && !sight) return null; // blocks nothing
  if (!move) return 'ethereal'; // blocks sight, not movement
  if (sight === 2) return 'terrain';
  if (!sight) return sound ? 'window' : 'invisible';
  return 'wall';
}

/**
 * A scene file read into what Hearth needs: { name, width, height, grid, darkness, walls, lights,
 * map: { x, y, w, h } (where the map goes and its size in the scene), image (embedded, as a Blob) }.
 */
export function readSceneFile(json, name = 'Imported map') {
  // ---- Universal VTT
  if (json.resolution && (json.line_of_sight || json.portals)) {
    const ppg = Number(json.resolution.pixels_per_grid) || 70;
    const origin = json.resolution.map_origin ?? { x: 0, y: 0 };
    const size = json.resolution.map_size ?? { x: 10, y: 10 };
    const px = (p) => [(p.x - origin.x) * ppg, (p.y - origin.y) * ppg];
    const distance = 5;
    const walls = [];
    const line = (pts, kind) => { for (let i = 1; i < pts.length; i++) walls.push({ a: px(pts[i - 1]), b: px(pts[i]), kind }); };
    for (const pts of json.line_of_sight ?? []) line(pts, 'wall');
    for (const pts of json.objects_line_of_sight ?? []) line(pts, 'wall');
    for (const d of json.portals ?? []) {
      const [a, b] = d.bounds ?? [];
      if (a && b) walls.push({ a: px(a), b: px(b), kind: 'door', open: d.closed === false });
    }
    const lights = (json.lights ?? []).map((l) => {
      const [x, y] = px(l.position);
      const dim = (Number(l.range) || 0) * distance;
      return { x, y, dim, bright: dim / 2, color: hex(l.color) };
    });
    let image = null;
    if (typeof json.image === 'string' && json.image.length > 100) {
      const bytes = Uint8Array.from(atob(json.image.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
      const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
      image = new Blob([bytes], { type });
    }
    const width = size.x * ppg, height = size.y * ppg;
    return {
      name, width, height, grid: { size: ppg, distance, units: 'ft' },
      darkness: json.environment?.baked_lighting === false ? 0.6 : 0,
      walls, lights, map: { x: 0, y: 0, w: width, h: height }, image,
    };
  }
  // ---- Foundry-style (Dungeon Alchemist's JSON)
  if (Number(json.width) > 0 && Number(json.height) > 0 && json.grid) {
    const grid = Number(typeof json.grid === 'object' ? json.grid.size : json.grid) || 100;
    const width = Number(json.width), height = Number(json.height);
    // Padding: a blank border around the map, in whole squares (as Foundry adds it).
    const pad = Number(json.padding) || 0;
    const padX = Math.ceil((width * pad) / grid) * grid, padY = Math.ceil((height * pad) / grid) * grid;
    // A grid shift moves the grid over the map; Hearth's grid starts at the corner, so move the rest.
    const sx = -(Number(json.shiftX) || 0), sy = -(Number(json.shiftY) || 0);
    const walls = [];
    for (const w of json.walls ?? []) {
      const kind = foundryWallKind(w);
      const c = w.c ?? [];
      if (!kind || c.length < 4) continue;
      walls.push({ a: [c[0] + sx, c[1] + sy], b: [c[2] + sx, c[3] + sy], kind, open: w.ds === 1, locked: w.ds === 2 });
    }
    const lights = (json.lights ?? []).map((l) => {
      const cfg = l.config ?? l;
      const alpha = Number(cfg.alpha ?? l.tintAlpha ?? 0);
      return { x: l.x + sx, y: l.y + sy, dim: Number(cfg.dim) || 0, bright: Number(cfg.bright) || 0, color: alpha > 0 ? hex(cfg.color ?? l.tintColor) : null };
    });
    // "Global light": the whole map is lit whatever the darkness. Hearth hides what isn't lit
    // from half darkness up, so keep it just under that: dim, but everything visible.
    let darkness = Math.min(1, Math.max(0, Number(json.darkness) || 0));
    if (json.globalLight) darkness = Math.min(darkness, 0.45);
    const alpha = json.gridAlpha ?? 0.2;
    const gc = hex(json.gridColor);
    const color = gc ? `rgba(${parseInt(gc.slice(1, 3), 16)},${parseInt(gc.slice(3, 5), 16)},${parseInt(gc.slice(5, 7), 16)},${alpha})` : undefined;
    return {
      name: json.name || name,
      width: width + 2 * padX, height: height + 2 * padY,
      grid: { size: grid, distance: Number(json.gridDistance) || 5, units: json.gridUnits || 'ft', ...(color ? { color } : {}) },
      darkness, walls, lights, map: { x: padX + sx, y: padY + sy, w: width, h: height }, image: null,
    };
  }
  return null;
}

/** GM: the Import map window. */
export function openSceneImport(api) {
  const win = openWindow({ id: 'scene-import', title: 'Import a map', width: 440 });
  const form = el('form.form', {},
    el('p.small.muted', { text: 'A map from Dungeon Alchemist, Dungeondraft or similar, with its grid, walls, doors and lights. Choose the scene file, and the map it goes with: Dungeon Alchemist exports a JSON file beside a PNG or MP4. Universal VTT files (.dd2vtt, .uvtt) carry their own map.' }),
    el('label', {}, 'Scene file (.json, .dd2vtt, .uvtt)', el('input', { name: 'scene', type: 'file', accept: '.json,.dd2vtt,.uvtt,.df2vtt,application/json', required: true })),
    el('label', {}, 'Map (image or MP4/WebM video), if it isn\'t inside the scene file', el('input', { name: 'map', type: 'file', accept: 'image/*,video/mp4,video/webm' })),
    el('label.check', {}, el('input', { name: 'vision', type: 'checkbox', checked: true }), ' Players see only what their tokens see (walls block sight)'),
    el('p.small.error-text', { hidden: true }),
    el('div.row', {}, el('span.grow'), el('button.primary', { type: 'submit', text: 'Import' })));
  const error = form.querySelector('.error-text');
  const fail = (msg) => { error.textContent = msg; error.hidden = false; };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const f = form.elements;
    const file = f.scene.files[0];
    if (!file) return;
    let json;
    try { json = JSON.parse(await file.text()); } catch { fail(`${file.name} isn't a scene file Hearth can read (not JSON).`); return; }
    const sc = readSceneFile(json, file.name.replace(/\.[^.]+$/, ''));
    if (!sc) { fail(`${file.name} doesn't look like a Foundry-style or Universal VTT scene.`); return; }
    const mapFile = f.map.files[0] ?? (sc.image ? new File([sc.image], `${sc.name}.${sc.image.type.split('/')[1]}`, { type: sc.image.type }) : null);
    if (!mapFile) { fail('This scene file has no map inside it: choose the map image or video it goes with.'); return; }
    const button = form.querySelector('button.primary');
    button.disabled = true;
    button.textContent = 'Uploading the map…';
    try {
      const url = await api.upload(mapFile);
      const size = await mediaSize(url);
      if (!size?.w) throw new Error('The map didn\'t load. Is it an image or an MP4/WebM video?');
      const walls = {}, lights = {};
      for (const w of sc.walls) { const id = newId(); walls[id] = { id, a: w.a, b: w.b, kind: w.kind, open: !!w.open, locked: !!w.locked }; }
      for (const l of sc.lights) { const id = newId(); lights[id] = { id, x: l.x, y: l.y, bright: l.bright, dim: l.dim, color: l.color, off: false }; }
      api.op({
        op: 'scene_create',
        scene: {
          id: '', name: sc.name, width: Math.round(sc.width), height: Math.round(sc.height), tokens: {},
          background: url,
          // Where the scene file puts the map, scaled to the size it gives (the video may be smaller).
          background_fit: { x: sc.map.x, y: sc.map.y, sx: sc.map.w / size.w, sy: sc.map.h / size.h },
          grid: { kind: 'square', ...sc.grid },
          darkness: sc.darkness,
          vision: { enabled: !!f.vision.checked && sc.walls.length > 0, fog: false, range: 0 },
          walls, lights,
        },
      });
      toast(`Imported ${sc.name}: ${sc.walls.length} walls and doors, ${sc.lights.length} lights.`);
      win.close();
    } catch (err) {
      fail(err.message);
      button.disabled = false;
      button.textContent = 'Import';
    }
  });
  win.body.replaceChildren(form);
}
