// Textures made in the texture creator. A recipe mixes textures (built-in or uploaded, such as
// free photo-scanned ones) into one repeating tile that covers 8 × 8 squares, so the pattern
// repeats far less often than its sources. Every client draws the same tile from the recipe,
// so only the recipe is stored: world.textures[id] = { id, name, recipe }, used on sketched
// maps as `tex:<id>` (floors, walls, roofs).
//
// A recipe is a graph of nodes (version 2), as the creator's node editor makes it:
//   { v: 2, nodes: { id: { type, x, y, p: { params }, in: { port: node id } } } }
// Each node has one output, a picture the size of the tile; `in` says which node feeds each
// of its inputs. The node of type 'output' is the texture. NODE_TYPES lists the types, their
// inputs and their settings (anything missing takes its default, so new settings and nodes
// can come later without breaking older recipes). Masks are grey pictures: white is "here".
//
// Version 1 (a fixed recipe, from before the node editor) still draws, and opens in the editor
// as the same graph:
//   {
//     base:    { src: 'stone' | upload url, squares: 2, hue: 0, sat: 100, bright: 100 },
//     overlay: { src, squares, hue, sat, bright } | null,   // blended in through the mask
//     mask:    { size: 2, cover: 50, soft: 40, seed: 1 },  // patch size in squares; cover, soft in %
//     vary: 30,                                           // % of light and dark patches over it all
//     seed: 1,
//   }
// `squares`: how many squares one copy of a source covers (1, 2, 4 or 8). hue in degrees,
// sat and bright in % (100 = unchanged).
import { store } from './store.js';
import { hooks } from './hooks.js';
import { texture, setTextureSource } from './sketch-textures.js';

/** Squares across one recipe tile, and its size in pixels (128 per square, like the built-ins). */
export const RECIPE_SQUARES = 8;
const FULL = 1024;
export const SQUARE_CHOICES = [0.5, 1, 2, 4, 8];
export const MASK_SIZES = [0.5, 1, 2, 4];

export const isRecipe = (id) => typeof id === 'string' && id.startsWith('tex:');
export const recipeId = (id) => id.slice(4);

/** A recipe with every default filled in. */
export function fullRecipe(r = {}) {
  const layer = (l, src) => ({ src, squares: l?.src && !texture(l.src) ? 4 : 2, hue: 0, sat: 100, bright: 100, ...(l ?? {}) });
  return {
    base: layer(r.base, 'stone'),
    overlay: r.overlay ? layer(r.overlay, 'grass') : null,
    mask: { size: 2, cover: 50, soft: 40, seed: 1, ...(r.mask ?? {}) },
    vary: r.vary ?? 30,
    seed: r.seed ?? 1,
  };
}

// ------------------------------------------------------------------ sources

const images = new Map(); // url → Image
/** An uploaded source, once loaded (null until then; a redraw follows when it arrives). */
function image(url) {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.onload = () => texturesChanged();
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}
const source = (src) => texture(src) ?? (src && !isRecipe(src) ? image(src) : null);

// ------------------------------------------------------------------ noise

/** Seeded random numbers (mulberry32). */
function rng(seed) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cloudy noise that repeats exactly every tile: `cells` blobs across at its coarsest, three
 * octaves. Values 0–1, one per pixel of an n × n tile.
 */
function clouds(n, cells, seed, octaves = 3) {
  const out = new Float32Array(n * n);
  const rand = rng(seed);
  let amp = 1, total = 0;
  for (let o = 0, c = Math.max(1, Math.round(cells)); o < octaves; o++, c *= 2, amp *= 0.5) {
    const grid = new Float32Array(c * c).map(() => rand());
    const step = n / c;
    for (let y = 0; y < n; y++) {
      const gy = y / step, y0 = Math.floor(gy), ty = gy - y0, sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % c) * c, r1 = ((y0 + 1) % c) * c;
      for (let x = 0; x < n; x++) {
        const gx = x / step, x0 = Math.floor(gx), tx = gx - x0, sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % c, c1 = (x0 + 1) % c;
        const top = grid[r0 + c0] + (grid[r0 + c1] - grid[r0 + c0]) * sx;
        const bot = grid[r1 + c0] + (grid[r1 + c1] - grid[r1 + c0]) * sx;
        out[y * n + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  // Spread the values out (cloud noise bunches up round the middle).
  let lo = Infinity, hi = -Infinity;
  for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / span;
  return out;
}

// ------------------------------------------------------------------ drawing

/** A layer: its source repeated across the tile, with its colour changes. False if not loaded yet. */
function drawLayer(ctx, l, n, span = RECIPE_SQUARES) {
  const src = source(l.src);
  if (!src) return false;
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const size = (n / span) * (SQUARE_CHOICES.includes(l.squares) ? l.squares : 2);
  const pat = ctx.createPattern(src, 'repeat');
  pat.setTransform(new DOMMatrix().scale(size / w, size / h));
  ctx.save();
  const f = [];
  if (l.hue) f.push(`hue-rotate(${l.hue}deg)`);
  if (l.sat !== 100) f.push(`saturate(${l.sat}%)`);
  if (l.bright !== 100) f.push(`brightness(${l.bright}%)`);
  if (f.length) ctx.filter = f.join(' ');
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, n, n);
  ctx.restore();
  return true;
}

function canvasOf(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return c;
}

/** A grey picture of noise values, or an alpha mask from them. */
function noiseCanvas(n, values, toAlpha) {
  const c = canvasOf(n);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(values[i] * 255);
    if (toAlpha) img.data.set([255, 255, 255, v], i * 4); else img.data.set([v, v, v, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Draw a recipe into a new tile n pixels across (it covers 8 × 8 squares at any size, or 16 × 16
 * when its Output says so; by default 128 pixels a square). Null while a source is still loading.
 */
export function renderRecipe(recipe, n = null) {
  n ??= recipe?.nodes ? 128 * spanOf(recipe) : FULL;
  if (recipe?.nodes) {
    const out = evalGraph(recipe, n).get(outputOf(recipe));
    if (out === LOADING) return null;
    if (out) return out;
    // Nothing reaches the output yet: plain grey.
    const c = canvasOf(n);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#6b6359';
    ctx.fillRect(0, 0, n, n);
    return c;
  }
  const r = fullRecipe(recipe);
  const out = canvasOf(n);
  const ctx = out.getContext('2d');
  if (!drawLayer(ctx, r.base, n)) return null;
  if (r.overlay) {
    const layer = canvasOf(n);
    const lctx = layer.getContext('2d');
    if (!drawLayer(lctx, r.overlay, n)) return null;
    // The mask: where the cloud noise is above the line set by "cover", softened by "soft".
    const m = r.mask;
    const size = MASK_SIZES.includes(m.size) ? m.size : 2;
    const noise = clouds(n, RECIPE_SQUARES / size, m.seed);
    const cover = Math.max(0, Math.min(100, m.cover)) / 100;
    const soft = Math.max(0.02, Math.min(100, m.soft) / 100) * 0.5;
    const line = 1 - cover;
    for (let i = 0; i < noise.length; i++) {
      const t = (noise[i] - (line - soft)) / (2 * soft);
      const v = Math.max(0, Math.min(1, t));
      noise[i] = cover >= 1 ? 1 : cover <= 0 ? 0 : v * v * (3 - 2 * v);
    }
    lctx.globalCompositeOperation = 'destination-in';
    lctx.drawImage(noiseCanvas(n, noise, true), 0, 0);
    ctx.drawImage(layer, 0, 0);
  }
  // Light and dark patches over everything, so the eye finds no repeat.
  const vary = Math.max(0, Math.min(100, r.vary)) / 100;
  if (vary > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = vary * 0.8;
    ctx.drawImage(noiseCanvas(n, clouds(n, 3, r.seed + 7), false), 0, 0);
    ctx.restore();
  }
  return out;
}

// ------------------------------------------------------------------ node graphs

/** A source picture still loading: whatever it feeds waits too. */
export const LOADING = Symbol('loading');
/** Where Relief's light comes from: a direction on the map (y down). Walls' shadows fall down and right. */
export const LIGHT_FROM = {
  tl: { label: 'Top left', x: -1, y: -1 }, t: { label: 'Top', x: 0, y: -1 }, tr: { label: 'Top right', x: 1, y: -1 },
  l: { label: 'Left', x: -1, y: 0 }, r: { label: 'Right', x: 1, y: 0 },
  bl: { label: 'Bottom left', x: -1, y: 1 }, b: { label: 'Bottom', x: 0, y: 1 }, br: { label: 'Bottom right', x: 1, y: 1 },
};
export const BLEND_MODES = [['source-over', 'Normal'], ['multiply', 'Multiply'], ['overlay', 'Overlay'], ['screen', 'Screen'], ['soft-light', 'Soft light'], ['darken', 'Darken'], ['lighten', 'Lighten']];

/**
 * The kinds of node: their inputs (port ids, with labels) and settings. A setting's `kind`:
 * source (a texture: built-in or uploaded), select, range, colour, seed (a number with a
 * "new pattern" button).
 */
export const NODE_TYPES = {
  texture: {
    label: 'Texture', group: 'Sources', inputs: [],
    params: [
      { k: 'src', kind: 'source', def: 'stone', label: 'Texture' },
      { k: 'squares', kind: 'select', def: 2, label: 'Size (one copy)', options: SQUARE_CHOICES.map((n) => [n, n === 0.5 ? '½ × ½ square' : `${n} × ${n} square${n > 1 ? 's' : ''}`]) },
    ],
  },
  color: {
    label: 'Colour', group: 'Sources', inputs: [],
    params: [{ k: 'color', kind: 'color', def: '#5e7f3c', label: 'Colour' }],
  },
  noise: {
    label: 'Cloud noise', group: 'Masks', inputs: [],
    params: [
      { k: 'size', kind: 'select', def: 2, label: 'Patches', options: MASK_SIZES.map((n) => [n, `${n === 0.5 ? '½' : n} square${n > 1 ? 's' : ''}`]) },
      { k: 'detail', kind: 'range', def: 3, min: 1, max: 5, step: 1, label: 'Detail' },
      { k: 'seed', kind: 'seed', def: 1, label: 'Pattern' },
    ],
  },
  levels: {
    label: 'Levels', group: 'Masks', inputs: [['in', 'Mask']],
    params: [
      { k: 'cover', kind: 'range', def: 50, min: 0, max: 100, step: 1, label: 'Cover', unit: '%' },
      { k: 'soft', kind: 'range', def: 40, min: 0, max: 100, step: 1, label: 'Softness', unit: '%' },
    ],
  },
  invert: { label: 'Invert', group: 'Masks', inputs: [['in', 'In']], params: [] },
  scale: {
    label: 'Scale', group: 'Transform', inputs: [['in', 'In']],
    params: [
      { k: 'times', kind: 'select', def: 2, label: 'Smaller: copies across', options: [1, 2, 3, 4, 5, 6, 8].map((k) => [k, k === 1 ? '1 (as it is)' : `${k} (1/${k} the size)`]) },
      { k: 'turn', kind: 'select', def: 0, label: 'Turn', options: [[0, 'None'], [90, '90°'], [180, '180°'], [270, '270°']] },
    ],
  },
  adjust: {
    label: 'Adjust colour', group: 'Colour', inputs: [['in', 'In']],
    params: [
      { k: 'hue', kind: 'range', def: 0, min: -180, max: 180, step: 1, label: 'Hue', unit: '°' },
      { k: 'sat', kind: 'range', def: 100, min: 0, max: 200, step: 1, label: 'Colour', unit: '%' },
      { k: 'bright', kind: 'range', def: 100, min: 40, max: 160, step: 1, label: 'Brightness', unit: '%' },
    ],
  },
  blend: {
    label: 'Blend', group: 'Colour', inputs: [['a', 'Under'], ['b', 'Over'], ['mask', 'Mask']],
    params: [
      { k: 'mode', kind: 'select', def: 'source-over', label: 'Mode', options: BLEND_MODES },
      { k: 'amount', kind: 'range', def: 100, min: 0, max: 100, step: 1, label: 'Amount', unit: '%' },
    ],
  },
  // Height: a height map (grey, white is high), as photo-scanned textures come with, or a
  // normal map. Wire one from a Texture node at the same size as the colour picture.
  relief: {
    label: 'Relief', group: 'Height', inputs: [['in', 'Colour'], ['height', 'Height map'], ['normal', 'Normal map']],
    params: [
      { k: 'strength', kind: 'range', def: 100, min: 0, max: 300, step: 5, label: 'Strength', unit: '%' },
      { k: 'light', kind: 'select', def: 'tl', label: 'Light from', options: Object.entries(LIGHT_FROM).map(([v, l]) => [v, l.label]) },
      { k: 'sun', kind: 'range', def: 45, min: 10, max: 80, step: 1, label: 'Light height', unit: '°' },
      { k: 'cracks', kind: 'range', def: 40, min: 0, max: 100, step: 1, label: 'Dark cracks', unit: '%' },
      { k: 'green', kind: 'select', def: 'gl', label: 'Normal map', options: [['gl', 'OpenGL (green up)'], ['dx', 'DirectX (green down)']] },
    ],
  },
  heightmask: {
    label: 'Height mask', group: 'Height', inputs: [['mask', 'Mask'], ['height', 'Height map']],
    params: [
      { k: 'fill', kind: 'select', def: 'low', label: 'Fills', options: [['low', 'Low places first (moss, water, dirt in cracks)'], ['high', 'High places first (snow, dust on tops)']] },
      { k: 'amount', kind: 'range', def: 60, min: 0, max: 100, step: 1, label: 'Follows the height', unit: '%' },
    ],
  },
  output: {
    label: 'Output', group: null, inputs: [['in', 'Texture']],
    params: [
      { k: 'span', kind: 'select', def: 8, label: 'Repeats every', options: [[8, '8 × 8 squares'], [16, '16 × 16 squares (more memory)']] },
      { k: 'macro', kind: 'range', def: 0, min: 0, max: 100, step: 1, label: 'Map-wide light and dark', unit: '%' },
      { k: 'macroSize', kind: 'select', def: 32, label: 'Map-wide patches', options: [[16, '16 squares across'], [32, '32 squares across'], [64, '64 squares across']] },
    ],
  },
};

/** A node's setting, or its default. */
export function param(node, k) {
  const v = node.p?.[k];
  if (v !== undefined && v !== null) return v;
  return NODE_TYPES[node.type]?.params.find((x) => x.k === k)?.def;
}
/** How many squares a graph's tile covers across (its Output's "Repeats every"). */
export const spanOf = (g) => {
  const v = Number(Object.values(g?.nodes ?? {}).find((x) => x.type === 'output')?.p?.span);
  return v === 16 ? 16 : RECIPE_SQUARES;
};
export const outputOf = (g) => Object.keys(g.nodes ?? {}).find((id) => g.nodes[id].type === 'output');

/** Grey values (0–1) of a picture: its brightness. */
function greys(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
  return out;
}

/**
 * Work out every node's picture, n pixels across: Map(node id → canvas, null when nothing
 * feeds it, or LOADING).
 */
export function evalGraph(g, n) {
  const nodes = g.nodes ?? {};
  const span = spanOf(g);
  const done = new Map();
  const busy = new Set();
  const get = (id) => {
    if (!id || !nodes[id]) return null;
    if (done.has(id)) return done.get(id);
    if (busy.has(id)) return null; // a loop: ignored
    busy.add(id);
    let out = null;
    try { out = run(nodes[id], (port) => get(nodes[id].in?.[port])); } catch (err) { console.warn('texture node', id, err); out = null; }
    busy.delete(id);
    done.set(id, out);
    return out;
  };
  const run = (node, input) => {
    const P = (k) => param(node, k);
    switch (node.type) {
      case 'texture': {
        const c = canvasOf(n);
        return drawLayer(c.getContext('2d'), { src: P('src'), squares: Number(P('squares')), hue: 0, sat: 100, bright: 100 }, n, span) ? c : LOADING;
      }
      case 'color': {
        const c = canvasOf(n);
        const ctx = c.getContext('2d');
        ctx.fillStyle = P('color');
        ctx.fillRect(0, 0, n, n);
        return c;
      }
      case 'noise': {
        const size = MASK_SIZES.includes(Number(P('size'))) ? Number(P('size')) : 2;
        return noiseCanvas(n, clouds(n, span / size, Number(P('seed')) || 1, Math.max(1, Math.min(5, Number(P('detail')) || 3))), false);
      }
      case 'levels': case 'invert': {
        const src = input('in');
        if (!src || src === LOADING) return src;
        const v = greys(src);
        if (node.type === 'invert') { for (let i = 0; i < v.length; i++) v[i] = 1 - v[i]; return noiseCanvas(n, v, false); }
        const cover = Math.max(0, Math.min(100, Number(P('cover')))) / 100;
        const soft = Math.max(0.02, Math.min(100, Number(P('soft'))) / 100) * 0.5;
        const line = 1 - cover;
        for (let i = 0; i < v.length; i++) {
          const t = Math.max(0, Math.min(1, (v[i] - (line - soft)) / (2 * soft)));
          v[i] = cover >= 1 ? 1 : cover <= 0 ? 0 : t * t * (3 - 2 * t);
        }
        return noiseCanvas(n, v, false);
      }
      case 'scale': {
        const src = input('in');
        if (!src || src === LOADING) return src;
        const k = Math.max(1, Math.min(8, Math.round(Number(P('times')) || 1)));
        const turn = ((Number(P('turn')) || 0) % 360 + 360) % 360;
        const c = canvasOf(n);
        const ctx = c.getContext('2d');
        // The picture repeats, so k smaller copies across still meet seamlessly.
        const pat = ctx.createPattern(src, 'repeat');
        pat.setTransform(new DOMMatrix().translate(n / 2, n / 2).rotate(turn).translate(-n / 2, -n / 2).scale(1 / k));
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, n, n);
        return c;
      }
      case 'adjust': {
        const src = input('in');
        if (!src || src === LOADING) return src;
        const c = canvasOf(n);
        const ctx = c.getContext('2d');
        const f = [];
        if (Number(P('hue'))) f.push(`hue-rotate(${Number(P('hue'))}deg)`);
        if (Number(P('sat')) !== 100) f.push(`saturate(${Number(P('sat'))}%)`);
        if (Number(P('bright')) !== 100) f.push(`brightness(${Number(P('bright'))}%)`);
        if (f.length) ctx.filter = f.join(' ');
        ctx.drawImage(src, 0, 0, n, n);
        return c;
      }
      case 'blend': {
        const a = input('a'), b = input('b'), m = input('mask');
        if (a === LOADING || b === LOADING || m === LOADING) return LOADING;
        if (!a && !b) return null;
        const c = canvasOf(n);
        const ctx = c.getContext('2d');
        if (a) ctx.drawImage(a, 0, 0, n, n);
        if (!b) return c;
        let over = b;
        if (m) {
          // The mask's brightness says where the top picture shows.
          const layer = canvasOf(n);
          const l = layer.getContext('2d');
          l.drawImage(b, 0, 0, n, n);
          l.globalCompositeOperation = 'destination-in';
          l.drawImage(noiseCanvas(n, greys(m), true), 0, 0);
          over = layer;
        }
        const mode = BLEND_MODES.some(([v]) => v === P('mode')) ? P('mode') : 'source-over';
        ctx.globalCompositeOperation = a ? mode : 'source-over';
        ctx.globalAlpha = Math.max(0, Math.min(100, Number(P('amount')))) / 100;
        ctx.drawImage(over, 0, 0, n, n);
        return c;
      }
      case 'relief': {
        const src = input('in'), hgt = input('height'), nrm = input('normal');
        if (src === LOADING || hgt === LOADING || nrm === LOADING) return LOADING;
        if (!src) return null;
        if (!hgt && !nrm) return src;
        const c = canvasOf(n);
        const ctx = c.getContext('2d');
        ctx.drawImage(src, 0, 0, n, n);
        const img = ctx.getImageData(0, 0, n, n);
        const d = img.data;
        const H = hgt ? greys(hgt) : null;
        const N = nrm ? nrm.getContext('2d').getImageData(0, 0, n, n).data : null;
        const dir = LIGHT_FROM[P('light')] ?? LIGHT_FROM.tl;
        const el = (Math.max(10, Math.min(80, Number(P('sun')))) * Math.PI) / 180;
        const dl = Math.hypot(dir.x, dir.y) || 1;
        const L = [(dir.x / dl) * Math.cos(el), (dir.y / dl) * Math.cos(el), Math.sin(el)];
        const strength = Math.max(0, Number(P('strength'))) / 100;
        const slope = strength * 6 * (n / 256); // the same look at any size
        const cracks = Math.max(0, Math.min(100, Number(P('cracks')))) / 100;
        const up = P('green') === 'dx' ? 1 : -1; // OpenGL normal maps point green up (y down on the map)
        for (let y = 0, i = 0; y < n; y++) {
          const yu = ((y - 1 + n) % n) * n, yd = ((y + 1) % n) * n, row = y * n;
          for (let x = 0; x < n; x++, i++) {
            let nx, ny, nz;
            if (N) {
              nx = (N[i * 4] / 127.5 - 1) * strength;
              ny = (N[i * 4 + 1] / 127.5 - 1) * strength * up;
              nz = Math.max(0.05, N[i * 4 + 2] / 127.5 - 1);
            } else {
              // The slope of the height map, wrapping round so the tile still repeats cleanly.
              nx = -(H[row + ((x + 1) % n)] - H[row + ((x - 1 + n) % n)]) * slope;
              ny = -(H[yd + x] - H[yu + x]) * slope;
              nz = 1;
            }
            const len = Math.hypot(nx, ny, nz);
            // Lit as a flat floor would be = 1; facing the light brighter, facing away darker.
            let f = Math.max(0.1, (nx * L[0] + ny * L[1] + nz * L[2]) / len / L[2]);
            if (H && cracks) f *= 1 - cracks * Math.max(0, 0.55 - H[i]) * 1.6;
            d[i * 4] *= f;
            d[i * 4 + 1] *= f;
            d[i * 4 + 2] *= f;
          }
        }
        ctx.putImageData(img, 0, 0);
        return c;
      }
      case 'heightmask': {
        const m = input('mask'), hgt = input('height');
        if (m === LOADING || hgt === LOADING) return LOADING;
        if (!hgt) return m;
        const H = greys(hgt);
        const v = m ? greys(m) : new Float32Array(n * n).fill(0.5);
        const k = (Math.max(0, Math.min(100, Number(P('amount')))) / 100) * 2;
        const low = P('fill') !== 'high';
        for (let i = 0; i < v.length; i++) v[i] = Math.max(0, Math.min(1, v[i] + (low ? 0.5 - H[i] : H[i] - 0.5) * k));
        return noiseCanvas(n, v, false);
      }
      case 'output': return input('in');
      default: return null;
    }
  };
  for (const id of Object.keys(nodes)) get(id);
  return done;
}

/** A new node's settings: every default. */
export function newNode(type, x, y) {
  return { type, x: Math.round(x), y: Math.round(y), p: Object.fromEntries(NODE_TYPES[type].params.map((q) => [q.k, q.def])), in: {} };
}

/** The graph a recipe opens as in the node editor (a version 1 recipe becomes the same graph). */
export function graphOf(recipe) {
  if (recipe?.nodes) return JSON.parse(JSON.stringify({ v: 2, nodes: recipe.nodes }));
  const nodes = {};
  let k = 0;
  const add = (type, x, y, p = {}, inp = {}) => { const id = `n${++k}`; nodes[id] = { ...newNode(type, x, y), in: inp }; Object.assign(nodes[id].p, p); return id; };
  if (!recipe) {
    const t = add('texture', 40, 80);
    add('output', 420, 100, {}, { in: t });
    return { v: 2, nodes };
  }
  const r = fullRecipe(recipe);
  const layer = (l, y) => {
    let id = add('texture', 40, y, { src: l.src, squares: l.squares });
    if (l.hue || l.sat !== 100 || l.bright !== 100) id = add('adjust', 300, y, { hue: l.hue, sat: l.sat, bright: l.bright }, { in: id });
    return id;
  };
  let last = layer(r.base, 40);
  if (r.overlay) {
    const top = layer(r.overlay, 300);
    const noise = add('noise', 40, 560, { size: r.mask.size, seed: r.mask.seed, detail: 3 });
    const lv = add('levels', 300, 560, { cover: r.mask.cover, soft: r.mask.soft }, { in: noise });
    last = add('blend', 560, 260, {}, { a: last, b: top, mask: lv });
  }
  if (r.vary > 0) {
    const noise = add('noise', 560, 560, { size: 4, seed: r.seed + 7, detail: 3 });
    last = add('blend', 820, 300, { mode: 'overlay', amount: Math.round(r.vary * 0.8) }, { a: last, b: noise });
  }
  add('output', 1080, 300, {}, { in: last });
  return { v: 2, nodes };
}

// ------------------------------------------------------------------ the world's textures

const tiles = new Map(); // id → canvas
const drafts = new Map(); // id → recipe being edited (this user only, until it's saved)

/**
 * Show a texture on the map as it's being edited, before it's saved (only on this screen);
 * null goes back to the saved one.
 */
export function setDraft(id, recipe) {
  if (recipe) drafts.set(id, JSON.parse(JSON.stringify(recipe)));
  else if (!drafts.delete(id)) return;
  texturesChanged(id);
}
const recipeOf = (key) => drafts.get(key) ?? store.world?.textures?.[key]?.recipe;
export function recipes() {
  return Object.values(store.world?.textures ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

/** The tile for `tex:<id>`, drawn on first use (null while its sources load, or if it's gone). */
function recipeTile(id) {
  if (!isRecipe(id)) return null;
  const key = recipeId(id);
  if (tiles.has(key)) return tiles.get(key);
  const recipe = recipeOf(key);
  if (!recipe) return null;
  const c = renderRecipe(recipe);
  if (c) tiles.set(key, c);
  return c;
}
setTextureSource(recipeTile);

/**
 * Map-wide light and dark for a material: { amount 0–1, size in squares }, or null. Drawn over
 * the painted floor itself (not the tile), so it doesn't repeat with the tile.
 */
export function macroOf(id) {
  if (!isRecipe(id)) return null;
  const out = Object.values(recipeOf(recipeId(id))?.nodes ?? {}).find((x) => x.type === 'output');
  const amount = Number(out?.p?.macro) || 0;
  if (amount <= 0) return null;
  const size = [16, 32, 64].includes(Number(out.p.macroSize)) ? Number(out.p.macroSize) : 32;
  return { amount: Math.min(100, amount) / 100, size };
}
let macroNoise = null;
/** A pattern of very large, soft light and dark patches, `size` squares across, placed by `key`. */
export function macroPattern(ctx, g, size, key = '') {
  macroNoise ??= noiseCanvas(256, clouds(256, 4, 4242, 3), false);
  const pat = ctx.createPattern(macroNoise, 'repeat');
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // Each texture's patches sit somewhere else, so two floors side by side don't match.
  const off = ((h % 997) / 997) * 256;
  pat.setTransform(new DOMMatrix().scale((size * g) / 256).translate(off, (off * 7) % 256));
  return pat;
}

/** Recipes or their sources changed: everything that drew them draws again. */
export function texturesChanged(id = null) {
  if (id) tiles.delete(id); else tiles.clear();
  hooks.emit('textures:changed');
}
hooks.on('op:texture_set', (op) => texturesChanged(op.texture.id));
hooks.on('op:texture_delete', (op) => texturesChanged(op.id));
