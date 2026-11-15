// Props for sketched maps, drawn in code (no image files): light sources, which bring their
// own light, and furniture and nature. Each is drawn centred on 0, 0, `w` × `h` squares in size
// (one square = `u` px), facing up; the board turns and sizes it.
//
//   layer 0 lies on the floor (rugs), 1 stands on it, 2 is above the walls (tree tops)
//   block: the kind of wall round it when it stands in the way ('wall' blocks sight too,
//          'invisible' only movement); blocks: whether it does at first
//   round: its outline is round (for picking it and for its walls)
//   link: it can lead to another level (stairs, ladders): a token stepping onto it goes there
//   parts: what can be recoloured, [{ id, label, color }]. A prop's `colors` sets a part to
//          another colour (#rrggbb) or a texture (a built-in, an uploaded picture, tex:<id>);
//          its shading (darker boards, lit tops) follows. A light's 'glow' part is its light's
//          colour too.

const INK = '#17120e';
const WOOD = '#8a5a2e', WOOD_LIGHT = '#a7743f', STONE = '#8d8a84', LEAVES = '#3d6e2f', IRON = '#3a3530';
const part = (id, label, color) => ({ id, label, color });

/** Light sources: radii in squares. */
export const LIGHTS = [
  { id: 'torch', label: 'Torch', bright: 4, dim: 8, color: '#ff9a3c', parts: [part('wood', 'Handle', '#6b4424')] },
  { id: 'brazier', label: 'Brazier', bright: 3, dim: 6, color: '#ff7b2e', parts: [part('metal', 'Bowl', '#3b3632')] },
  { id: 'campfire', label: 'Campfire', bright: 4, dim: 8, color: '#ff8a3a', parts: [part('stone', 'Stones', '#77736c'), part('wood', 'Logs', '#6b4424')] },
  { id: 'candles', label: 'Candles', bright: 1, dim: 3, color: '#ffc46b', parts: [part('wax', 'Wax', '#efe6cf')] },
  { id: 'lantern', label: 'Lantern', bright: 3, dim: 6, color: '#ffe2a0', parts: [part('metal', 'Frame', '#2e2924')] },
  { id: 'crystal', label: 'Glowing crystal', bright: 2, dim: 5, color: '#8fb8ff', parts: [part('crystal', 'Crystal', '#7fb0ff')] },
  // A floor piece, not a small lamp: it isn't put on walls, and lies under other props.
  { id: 'magic-circle', label: 'Magic circle', w: 2, h: 2, layer: 0, bright: 1, dim: 3, color: '#9a7bff', parts: [part('stone', 'Stone', '#5f5c57')] },
].map((l) => ({ w: 0.6, h: 0.6, round: true, layer: 1, group: 'light', ...l, light: true, parts: [...l.parts, part('glow', 'Light', l.color)] }));

const WATER = '#2e5a73', BONE = '#e4dcc8', PAPER = '#e8dcb8', CLOTH = '#a08a5c';

/**
 * Furniture, buildings, camps, nature and clutter. Many are plain shapes meant to be
 * recoloured or textured: a basin of water, blood or lava; a stone or gilded sarcophagus.
 */
export const FURNITURE = [
  // Furniture
  { id: 'table', group: 'furniture', label: 'Table', w: 2, h: 1, block: 'invisible', parts: [part('wood', 'Top', WOOD_LIGHT)] },
  { id: 'round-table', group: 'furniture', label: 'Round table', w: 1.3, h: 1.3, round: true, block: 'invisible', parts: [part('wood', 'Top', WOOD_LIGHT)] },
  { id: 'desk', group: 'furniture', label: 'Desk', w: 1.5, h: 0.8, block: 'invisible', parts: [part('wood', 'Top', WOOD), part('paper', 'Papers', PAPER)] },
  { id: 'chair', group: 'furniture', label: 'Chair', w: 0.55, h: 0.55, parts: [part('wood', 'Wood', WOOD)] },
  { id: 'throne', group: 'furniture', label: 'Throne', w: 1, h: 1, block: 'invisible', parts: [part('frame', 'Frame', '#a8832e'), part('cushion', 'Cushion', '#7d2f2f')] },
  { id: 'bench', group: 'furniture', label: 'Bench', w: 2, h: 0.45, parts: [part('wood', 'Wood', WOOD)] },
  { id: 'counter', group: 'furniture', label: 'Counter', w: 2, h: 0.6, block: 'invisible', blocks: true, parts: [part('wood', 'Top', WOOD_LIGHT)] },
  { id: 'counter-corner', group: 'furniture', label: 'Counter corner', w: 2, h: 2, block: 'invisible', blocks: true, parts: [part('wood', 'Top', WOOD_LIGHT)] },
  { id: 'counter-end', group: 'furniture', label: 'Counter end', w: 1, h: 0.6, block: 'invisible', blocks: true, parts: [part('wood', 'Top', WOOD_LIGHT)] },
  { id: 'bed', group: 'furniture', label: 'Bed', w: 1, h: 2, block: 'invisible', parts: [part('wood', 'Frame', '#6b4424'), part('sheets', 'Sheets', '#e8e0cc'), part('pillow', 'Pillow', '#f8f4ea'), part('blanket', 'Blanket', '#7d2f2f')] },
  { id: 'bookshelf', group: 'furniture', label: 'Bookshelf', w: 2, h: 0.5, block: 'invisible', blocks: true, parts: [part('wood', 'Shelf', '#6b4424'), part('books', 'Books', '#7d2f2f')] },
  { id: 'wardrobe', group: 'furniture', label: 'Wardrobe', w: 1.5, h: 0.7, block: 'invisible', blocks: true, parts: [part('wood', 'Wood', '#6b4424'), part('metal', 'Handles', '#d8b04a')] },
  { id: 'dresser', group: 'furniture', label: 'Dresser', w: 1.2, h: 0.55, block: 'invisible', parts: [part('wood', 'Wood', WOOD), part('metal', 'Handles', '#d8b04a')] },
  { id: 'weapon-rack', group: 'furniture', label: 'Weapon rack', w: 1.5, h: 0.45, block: 'invisible', parts: [part('wood', 'Rack', '#6b4424'), part('metal', 'Weapons', '#b8bcc2')] },
  { id: 'armor-stand', group: 'furniture', label: 'Armour stand', w: 0.8, h: 0.6, parts: [part('wood', 'Stand', '#6b4424'), part('metal', 'Armour', '#9a9ea4')] },
  { id: 'rug', group: 'furniture', label: 'Rug', w: 2, h: 3, layer: 0, parts: [part('cloth', 'Rug', '#7d2f2f'), part('trim', 'Border', '#d8b04a'), part('pattern', 'Pattern', '#2f4f7d'), part('fringe', 'Fringe', '#d8c08a')] },
  // Storage
  { id: 'barrel', group: 'storage', label: 'Barrel', w: 0.75, h: 0.75, round: true, block: 'invisible', parts: [part('wood', 'Staves', WOOD), part('metal', 'Hoops', IRON)] },
  { id: 'crate', group: 'storage', label: 'Crate', w: 0.8, h: 0.8, block: 'invisible', parts: [part('wood', 'Wood', WOOD_LIGHT)] },
  { id: 'chest', group: 'storage', label: 'Chest', w: 0.9, h: 0.6, parts: [part('wood', 'Wood', WOOD), part('metal', 'Band', IRON), part('lock', 'Lock', '#d8b04a')] },
  { id: 'sacks', group: 'storage', label: 'Sacks', w: 1, h: 1, parts: [part('cloth', 'Sacking', '#b49a6a')] },
  { id: 'hay-bale', group: 'storage', label: 'Hay bale', w: 1, h: 0.6, block: 'invisible', parts: [part('straw', 'Straw', '#d6b85a')] },
  // Buildings and dungeons
  { id: 'stairs', group: 'structure', label: 'Stairs', w: 1, h: 2, link: true, parts: [part('steps', 'Steps', '#77736a')] },
  { id: 'ladder', group: 'structure', label: 'Ladder', w: 0.6, h: 1.2, link: true, parts: [part('wood', 'Wood', WOOD)] },
  { id: 'trapdoor', group: 'structure', label: 'Trapdoor', w: 1, h: 1, link: true, parts: [part('wood', 'Wood', WOOD), part('metal', 'Ring', IRON)] },
  { id: 'archway', group: 'structure', label: 'Archway', w: 2, h: 0.5, block: 'wall', parts: [part('stone', 'Stone', STONE)] },
  { id: 'bars', group: 'structure', label: 'Iron bars', w: 1, h: 0.2, block: 'invisible', blocks: true, parts: [part('metal', 'Bars', IRON)] },
  { id: 'fence', group: 'structure', label: 'Fence', w: 2, h: 0.25, block: 'invisible', blocks: true, parts: [part('wood', 'Wood', WOOD)] },
  { id: 'barricade', group: 'structure', label: 'Barricade', w: 2, h: 0.7, block: 'invisible', blocks: true, parts: [part('wood', 'Stakes', WOOD)] },
  { id: 'bridge', group: 'structure', label: 'Bridge', w: 1, h: 3, layer: 0, parts: [part('wood', 'Planks', WOOD_LIGHT), part('rope', 'Rope', '#8a7650')] },
  { id: 'pillar', group: 'structure', label: 'Pillar', w: 0.8, h: 0.8, round: true, block: 'wall', blocks: true, parts: [part('stone', 'Stone', STONE)] },
  { id: 'statue', group: 'structure', label: 'Statue', w: 1, h: 1, block: 'wall', blocks: true, parts: [part('plinth', 'Plinth', '#5f5c57'), part('stone', 'Figure', STONE)] },
  { id: 'dais', group: 'structure', label: 'Dais', w: 2, h: 2, round: true, layer: 0, parts: [part('stone', 'Steps', STONE), part('top', 'Top', '#a09c94'), part('inlay', 'Inlay', '#d8b04a')] },
  { id: 'altar', group: 'structure', label: 'Altar', w: 1.6, h: 0.9, block: 'invisible', parts: [part('stone', 'Stone', STONE), part('cloth', 'Cloth', '#7d2f2f')] },
  { id: 'sarcophagus', group: 'structure', label: 'Sarcophagus', w: 1, h: 2, block: 'invisible', parts: [part('stone', 'Base', '#77736c'), part('lid', 'Lid', '#9a968e')] },
  { id: 'basin', group: 'structure', label: 'Basin', w: 1.2, h: 1.2, round: true, block: 'invisible', parts: [part('stone', 'Stone', STONE), part('liquid', 'Liquid', WATER)] },
  { id: 'trough', group: 'structure', label: 'Trough', w: 2, h: 0.7, block: 'invisible', parts: [part('wood', 'Wood', WOOD), part('liquid', 'Liquid', WATER)] },
  { id: 'well', group: 'structure', label: 'Well', w: 1.4, h: 1.4, round: true, block: 'invisible', blocks: true, parts: [part('stone', 'Stone', STONE), part('water', 'Water', '#16242c'), part('wood', 'Beam', '#6b4424')] },
  { id: 'pit', group: 'structure', label: 'Pit', w: 2, h: 2, round: true, layer: 0, block: 'invisible', parts: [part('stone', 'Rim', '#6e6a63'), part('inside', 'Inside', '#0d0b0a')] },
  // Camps and travel
  { id: 'tent', group: 'camp', label: 'Tent', w: 2.5, h: 2.5, round: true, block: 'wall', parts: [part('cloth', 'Canvas', CLOTH)] },
  { id: 'bedroll', group: 'camp', label: 'Bedroll', w: 0.8, h: 1.8, layer: 0, parts: [part('cloth', 'Cover', '#4f6a3a'), part('lining', 'Lining', '#c9b48a')] },
  { id: 'cart', group: 'camp', label: 'Cart', w: 1.6, h: 2.6, block: 'invisible', blocks: true, parts: [part('wood', 'Body', WOOD), part('wheels', 'Wheels', '#4a3424')] },
  { id: 'rowboat', group: 'camp', label: 'Rowboat', w: 1.2, h: 3, parts: [part('wood', 'Hull', WOOD)] },
  // Nature
  { id: 'tree', group: 'nature', label: 'Tree', w: 2, h: 2, round: true, layer: 2, block: 'wall', parts: [part('leaves', 'Leaves', LEAVES)] },
  { id: 'bush', group: 'nature', label: 'Bush', w: 1, h: 1, round: true, parts: [part('leaves', 'Leaves', '#2f5a26')] },
  { id: 'log', group: 'nature', label: 'Fallen log', w: 2, h: 0.6, block: 'invisible', parts: [part('bark', 'Bark', '#5a3f28'), part('wood', 'Wood', '#b08a5a')] },
  { id: 'stump', group: 'nature', label: 'Tree stump', w: 0.9, h: 0.9, round: true, block: 'invisible', parts: [part('bark', 'Bark', '#5a3f28'), part('wood', 'Wood', '#b08a5a')] },
  { id: 'rock', group: 'nature', label: 'Rock', w: 1, h: 1, round: true, block: 'wall', blocks: true, parts: [part('stone', 'Rock', '#6e6a63')] },
  { id: 'rubble', group: 'nature', label: 'Rubble', w: 1, h: 1, round: true, block: 'invisible', parts: [part('stone', 'Stones', '#6c6963')] },
  // Clutter
  { id: 'books', group: 'clutter', label: 'Books', w: 0.5, h: 0.45, parts: [part('books', 'Books', '#7d2f2f')] },
  { id: 'scroll', group: 'clutter', label: 'Scroll', w: 0.55, h: 0.3, parts: [part('paper', 'Paper', PAPER)] },
  { id: 'papers', group: 'clutter', label: 'Papers', w: 0.6, h: 0.5, parts: [part('paper', 'Paper', PAPER)] },
  { id: 'plate', group: 'clutter', label: 'Plate', w: 0.4, h: 0.4, round: true, parts: [part('dish', 'Plate', '#d8d2c4'), part('food', 'Food', '#a0522d')] },
  { id: 'tankard', group: 'clutter', label: 'Tankard', w: 0.35, h: 0.3, parts: [part('metal', 'Tankard', '#8a8a86'), part('drink', 'Drink', '#c9a040')] },
  { id: 'bottles', group: 'clutter', label: 'Bottles', w: 0.5, h: 0.5, parts: [part('glass', 'Glass', '#3f6b3a')] },
  { id: 'bones', group: 'clutter', label: 'Bones', w: 1, h: 1, layer: 0, parts: [part('bone', 'Bone', BONE)] },
  { id: 'skull', group: 'clutter', label: 'Skull', w: 0.4, h: 0.45, parts: [part('bone', 'Bone', BONE)] },
  { id: 'splatter', group: 'clutter', label: 'Splatter', w: 1.5, h: 1.5, round: true, layer: 0, parts: [part('liquid', 'Liquid', '#7a1616')] },
  { id: 'scorch', group: 'clutter', label: 'Scorch mark', w: 1.5, h: 1.5, round: true, layer: 0, parts: [part('ash', 'Ash', '#1e1a17')] },
].map((f) => ({ layer: 1, block: null, blocks: false, round: false, ...f }));

/** The Map props tab's sections, in order. */
export const PROP_GROUPS = [
  { id: 'light', label: 'Light sources (each brings its light)' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'storage', label: 'Storage' },
  { id: 'structure', label: 'Buildings and dungeons' },
  { id: 'camp', label: 'Camps and travel' },
  { id: 'nature', label: 'Nature' },
  { id: 'clutter', label: 'Clutter' },
];

export const ALL_PROPS = [...LIGHTS, ...FURNITURE];
const BY_ID = Object.fromEntries(ALL_PROPS.map((p) => [p.id, p]));

/** A prop kind's definition (unknown kinds draw as a crate). */
export const propDef = (kind) => BY_ID[kind] ?? BY_ID.crate;
export const isLight = (kind) => !!BY_ID[kind]?.light;
export const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** A light prop's light colour: its 'glow' part if set (a colour), else its own. */
export function propLightColor(p) {
  const v = p.colors?.glow;
  return isHex(v) ? v : propDef(p.kind).color;
}

/** A small seeded random number generator, so a rock or tree keeps its shape. */
function rng(seed) {
  let a = 0;
  for (const ch of String(seed)) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A colour lighter (k > 0) or darker (k < 0), k from -1 to 1. */
function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

/**
 * A prop's paints: `fill(part, k)` paints the current path with the part's look, shaded by k
 * (a texture gets a dark or light veil); `color(part, k)` is a plain colour for lines and
 * small details (a texture's own colour isn't known, so its part's usual one, shaded).
 */
function paints(ctx, def, colors, u, texFill) {
  const usual = (id) => def.parts?.find((x) => x.id === id)?.color ?? '#888888';
  const get = (id) => colors?.[id] ?? usual(id);
  const color = (id, k = 0) => {
    const v = isHex(get(id)) ? get(id) : usual(id);
    return k ? shadeHex(v, k) : v;
  };
  const fill = (id, k = 0, fn = () => ctx.fill()) => {
    const v = get(id);
    if (isHex(v)) { ctx.fillStyle = k ? shadeHex(v, k) : v; fn(); return; }
    ctx.fillStyle = texFill?.(ctx, v, u) ?? color(id, k);
    fn();
    if (k) { ctx.fillStyle = k < 0 ? `rgba(0,0,0,${-k})` : `rgba(255,255,255,${k})`; fn(); }
  };
  return { fill, color, custom: (id) => !!colors?.[id] };
}

function blob(ctx, rnd, rad, points = 9, wobble = 0.25) {
  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = rad * (1 - wobble / 2 + rnd() * wobble);
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
}

/** Seeded radii for an irregular outline, to draw at several sizes (a pit and its rim). */
function radii(rnd, points, wobble) {
  return Array.from({ length: points }, () => 1 - wobble / 2 + rnd() * wobble);
}
function outline(ctx, rs, rad) {
  ctx.beginPath();
  rs.forEach((k, i) => {
    const a = (i / rs.length) * Math.PI * 2;
    if (i === 0) ctx.moveTo(Math.cos(a) * rad * k, Math.sin(a) * rad * k); else ctx.lineTo(Math.cos(a) * rad * k, Math.sin(a) * rad * k);
  });
  ctx.closePath();
}

/** A rectangle with round corners (a path). */
function rrect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function flame(ctx, fx, fy, r) {
  ctx.fillStyle = '#ff8a1e';
  ctx.beginPath();
  ctx.moveTo(fx, fy - r * 1.8);
  ctx.quadraticCurveTo(fx + r * 1.1, fy - r * 0.2, fx, fy + r);
  ctx.quadraticCurveTo(fx - r * 1.1, fy - r * 0.2, fx, fy - r * 1.8);
  ctx.fill();
  ctx.fillStyle = '#ffe27a';
  ctx.beginPath(); ctx.arc(fx, fy + r * 0.2, r * 0.45, 0, Math.PI * 2); ctx.fill();
}

/** Draw a light source (centred on 0, 0). `lit`: flame and glow. */
function drawLight(ctx, p, u, lit, P) {
  const kind = p.kind;
  const s = u * 0.6;
  const glowColor = propLightColor(p);
  if (kind === 'magic-circle') {
    const R = (propDef(kind).w * u) / 2;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); P.fill('stone', -0.15); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R * 0.86, 0, Math.PI * 2); P.fill('stone', 0.05); ctx.stroke();
    if (lit) {
      const glow = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 0.9);
      glow.addColorStop(0, `${glowColor}55`); glow.addColorStop(1, `${glowColor}00`);
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, R * 0.9, 0, Math.PI * 2); ctx.fill();
    }
    // Rings, runes between them and a star: bright when lit, carved when not.
    ctx.save();
    ctx.strokeStyle = lit ? glowColor : P.color('stone', -0.45);
    ctx.lineWidth = u * 0.045;
    for (const k of [0.74, 0.56]) { ctx.beginPath(); ctx.arc(0, 0, R * k, 0, Math.PI * 2); ctx.stroke(); }
    ctx.lineWidth = u * 0.03;
    ctx.beginPath();
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2, r1 = R * 0.6, r2 = R * 0.7;
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a + (i % 2 ? 0.08 : -0.08)) * r2, Math.sin(a + (i % 2 ? 0.08 : -0.08)) * r2);
    }
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + ((i * 2) / 5) * Math.PI * 2;
      if (i === 0) ctx.moveTo(Math.cos(a) * R * 0.56, Math.sin(a) * R * 0.56); else ctx.lineTo(Math.cos(a) * R * 0.56, Math.sin(a) * R * 0.56);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (lit) {
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.75);
    glow.addColorStop(0, `${glowColor}88`);
    glow.addColorStop(1, `${glowColor}00`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.75, 0, Math.PI * 2); ctx.fill();
  }
  const fl = (x, y, r) => { if (lit) flame(ctx, x, y, r); };
  const disc = (x, y, r, id, k = 0) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); P.fill(id, k); ctx.stroke(); };
  switch (kind) {
    case 'brazier':
      disc(0, 0, s * 0.32, 'metal');
      ctx.fillStyle = lit ? '#c9461c' : '#4a3a30';
      ctx.beginPath(); ctx.arc(0, 0, s * 0.22, 0, Math.PI * 2); ctx.fill();
      fl(0, 0, s * 0.12);
      break;
    case 'campfire':
      for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; disc(Math.cos(a) * s * 0.36, Math.sin(a) * s * 0.36, s * 0.08, 'stone'); }
      ctx.save();
      ctx.strokeStyle = P.color('wood');
      ctx.lineWidth = s * 0.09;
      ctx.beginPath(); ctx.moveTo(-s * 0.22, -s * 0.15); ctx.lineTo(s * 0.22, s * 0.15); ctx.moveTo(-s * 0.22, s * 0.15); ctx.lineTo(s * 0.22, -s * 0.15); ctx.stroke();
      ctx.restore();
      fl(0, 0, s * 0.13);
      break;
    case 'candles':
      for (const [cx, cy] of [[-s * 0.15, s * 0.05], [s * 0.15, s * 0.08], [0, -s * 0.12]]) {
        disc(cx, cy, s * 0.08, 'wax');
        fl(cx, cy - s * 0.02, s * 0.045);
      }
      break;
    case 'lantern':
      ctx.beginPath(); ctx.rect(-s * 0.17, -s * 0.2, s * 0.34, s * 0.4); P.fill('metal'); ctx.stroke();
      ctx.fillStyle = lit ? shadeHex(glowColor, 0.3) : '#6a6050';
      ctx.fillRect(-s * 0.1, -s * 0.13, s * 0.2, s * 0.26);
      ctx.beginPath(); ctx.arc(0, -s * 0.2, s * 0.1, Math.PI, 0); ctx.stroke();
      break;
    case 'crystal':
      ctx.beginPath(); ctx.moveTo(0, -s * 0.32); ctx.lineTo(s * 0.17, 0); ctx.lineTo(0, s * 0.32); ctx.lineTo(-s * 0.17, 0); ctx.closePath();
      P.fill('crystal', lit ? 0 : -0.45); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.moveTo(0, -s * 0.32); ctx.lineTo(s * 0.06, 0); ctx.lineTo(0, s * 0.1); ctx.lineTo(-s * 0.08, 0); ctx.closePath(); ctx.fill();
      break;
    default: // torch
      ctx.save();
      ctx.strokeStyle = P.color('wood');
      ctx.lineWidth = s * 0.1;
      ctx.beginPath(); ctx.moveTo(0, s * 0.3); ctx.lineTo(0, -s * 0.02); ctx.stroke();
      ctx.restore();
      ctx.strokeRect(-s * 0.07, -s * 0.06, s * 0.14, s * 0.08);
      fl(0, -s * 0.12, s * 0.11);
  }
}

/** Draw furniture or nature (centred on 0, 0). */
function drawFurniture(ctx, p, u, seed, P) {
  const kind = p.kind;
  const def = propDef(kind);
  const W = def.w * u, H = def.h * u;
  const rnd = rng(`${kind}:${seed}`);
  const rect = (x, y, w, h, id, k = 0) => { ctx.beginPath(); ctx.rect(x, y, w, h); P.fill(id, k); ctx.stroke(); };
  const circle = (x, y, r, id, k = 0) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); P.fill(id, k); ctx.stroke(); };
  const lines = (pts, width, color) => { ctx.save(); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.beginPath(); for (const [a, b, c, d] of pts) { ctx.moveTo(a, b); ctx.lineTo(c, d); } ctx.stroke(); ctx.restore(); };
  const grain = (id) => P.color(id, -0.3);
  switch (kind) {
    case 'table':
      rect(-W / 2, -H / 2, W, H, 'wood');
      lines([[-W / 2, -H / 6, W / 2, -H / 6], [-W / 2, H / 6, W / 2, H / 6]], u * 0.02, grain('wood'));
      break;
    case 'round-table':
      circle(0, 0, W / 2, 'wood');
      ctx.save(); ctx.strokeStyle = grain('wood'); ctx.lineWidth = u * 0.02; ctx.beginPath(); ctx.arc(0, 0, W / 2.8, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      break;
    case 'chair':
      rect(-W / 2, -H / 2 + H * 0.2, W, H * 0.8, 'wood');
      rect(-W / 2, -H / 2, W, H * 0.22, 'wood', -0.25);
      break;
    case 'bench':
      rect(-W / 2, -H / 2, W, H, 'wood');
      lines([[-W / 2, 0, W / 2, 0]], u * 0.02, grain('wood'));
      break;
    case 'bed':
      rect(-W / 2, -H / 2, W, H, 'wood');
      rect(-W / 2 + u * 0.06, -H / 2 + u * 0.06, W - u * 0.12, H - u * 0.12, 'sheets');
      rect(-W / 2 + u * 0.15, -H / 2 + u * 0.12, W - u * 0.3, H * 0.15, 'pillow');
      rect(-W / 2 + u * 0.06, -H / 2 + H * 0.35, W - u * 0.12, H * 0.62, 'blanket');
      lines([[-W / 2 + u * 0.06, -H / 2 + H * 0.45, W / 2 - u * 0.06, -H / 2 + H * 0.45]], u * 0.02, P.color('blanket', -0.3));
      break;
    case 'bookshelf': {
      rect(-W / 2, -H / 2, W, H, 'wood');
      // Books: many colours, or shades of the one chosen.
      const colors = P.custom('books')
        ? [-0.35, -0.2, 0, 0.15, 0.3].map((k) => P.color('books', k))
        : ['#7d2f2f', '#2f4f7d', '#3f6b3a', '#8a6d2a', '#5a3d6e', '#a0522d'];
      let x = -W / 2 + u * 0.05;
      while (x < W / 2 - u * 0.1) {
        const bw = u * (0.06 + rnd() * 0.06);
        ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
        ctx.fillRect(x, -H / 2 + u * 0.06, bw, H - u * 0.12);
        x += bw + u * 0.01;
      }
      ctx.strokeRect(-W / 2, -H / 2, W, H);
      break;
    }
    case 'barrel':
      circle(0, 0, W / 2, 'wood');
      ctx.save(); ctx.strokeStyle = P.color('metal'); ctx.lineWidth = u * 0.04;
      ctx.beginPath(); ctx.arc(0, 0, W / 2 - u * 0.06, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = u * 0.02; ctx.strokeStyle = grain('wood');
      ctx.beginPath(); ctx.arc(0, 0, W / 5, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      break;
    case 'crate':
      rect(-W / 2, -H / 2, W, H, 'wood');
      lines([[-W / 2, -H / 2, W / 2, H / 2], [W / 2, -H / 2, -W / 2, H / 2]], u * 0.04, grain('wood'));
      ctx.strokeRect(-W / 2 + u * 0.06, -H / 2 + u * 0.06, W - u * 0.12, H - u * 0.12);
      break;
    case 'chest':
      rect(-W / 2, -H / 2, W, H, 'wood');
      rect(-W / 2, -H / 2 + H * 0.35, W, H * 0.12, 'metal');
      rect(-u * 0.07, -H / 2 + H * 0.3, u * 0.14, H * 0.22, 'lock');
      break;
    case 'rug': {
      rect(-W / 2, -H / 2, W, H, 'cloth');
      ctx.save();
      ctx.strokeStyle = P.color('trim'); ctx.lineWidth = u * 0.05;
      ctx.strokeRect(-W / 2 + u * 0.15, -H / 2 + u * 0.15, W - u * 0.3, H - u * 0.3);
      ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, u * 0.03);
      ctx.beginPath(); ctx.moveTo(0, -H * 0.25); ctx.lineTo(W * 0.25, 0); ctx.lineTo(0, H * 0.25); ctx.lineTo(-W * 0.25, 0); ctx.closePath(); P.fill('pattern'); ctx.stroke();
      ctx.restore();
      // Fringes.
      lines(Array.from({ length: 9 }, (_, i) => { const x = -W / 2 + (W * (i + 0.5)) / 9; return [[x, -H / 2, x, -H / 2 - u * 0.08], [x, H / 2, x, H / 2 + u * 0.08]]; }).flat(), u * 0.02, P.color('fringe'));
      break;
    }
    case 'stairs': {
      const steps = 8;
      // Darker at the bottom, lighter towards the top.
      for (let i = 0; i < steps; i++) rect(-W / 2, -H / 2 + (H * i) / steps, W, H / steps, 'steps', -0.4 + (i / (steps - 1)) * 0.75);
      // An arrow: up the stairs.
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.globalAlpha = 0.6; ctx.lineWidth = u * 0.04;
      ctx.beginPath(); ctx.moveTo(0, H * 0.3); ctx.lineTo(0, -H * 0.3); ctx.moveTo(-u * 0.15, -H * 0.18); ctx.lineTo(0, -H * 0.3); ctx.lineTo(u * 0.15, -H * 0.18); ctx.stroke();
      ctx.restore();
      break;
    }
    case 'ladder':
      lines([[-W / 2 + u * 0.06, -H / 2, -W / 2 + u * 0.06, H / 2], [W / 2 - u * 0.06, -H / 2, W / 2 - u * 0.06, H / 2]], u * 0.07, P.color('wood', -0.25));
      lines(Array.from({ length: 6 }, (_, i) => { const y = -H / 2 + (H * (i + 0.5)) / 6; return [-W / 2 + u * 0.06, y, W / 2 - u * 0.06, y]; }), u * 0.05, P.color('wood'));
      break;
    case 'trapdoor':
      rect(-W / 2, -H / 2, W, H, 'wood', -0.25);
      rect(-W / 2 + u * 0.08, -H / 2 + u * 0.08, W - u * 0.16, H - u * 0.16, 'wood');
      lines([[-W / 2 + u * 0.08, 0, W / 2 - u * 0.08, 0]], u * 0.03, grain('wood'));
      ctx.save(); ctx.strokeStyle = P.color('metal'); ctx.lineWidth = u * 0.05; ctx.beginPath(); ctx.arc(W * 0.25, 0, u * 0.08, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      break;
    case 'pillar':
      circle(0, 0, W / 2, 'stone');
      ctx.save(); ctx.strokeStyle = P.color('stone', -0.3); ctx.lineWidth = u * 0.03; ctx.beginPath(); ctx.arc(0, 0, W / 3, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(-W / 8, -W / 8, W / 5, 0, Math.PI * 2); ctx.fill();
      break;
    case 'statue':
      rect(-W / 2, -H / 2, W, H, 'plinth');
      ctx.beginPath(); ctx.ellipse(0, H * 0.12, W * 0.3, H * 0.2, 0, 0, Math.PI * 2); P.fill('stone'); ctx.stroke();
      circle(0, -H * 0.12, W * 0.18, 'stone', 0.2);
      break;
    case 'well':
      circle(0, 0, W / 2, 'stone');
      ctx.save(); ctx.strokeStyle = P.color('stone', -0.3); ctx.lineWidth = u * 0.02;
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * W * 0.32, Math.sin(a) * W * 0.32); ctx.lineTo(Math.cos(a) * W / 2, Math.sin(a) * W / 2); ctx.stroke(); }
      ctx.restore();
      circle(0, 0, W * 0.32, 'water');
      lines([[-W / 2, 0, W / 2, 0]], u * 0.06, P.color('wood'));
      break;
    case 'rock':
      blob(ctx, rnd, W / 2, 9, 0.35); P.fill('stone'); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.save(); ctx.translate(-W / 10, -W / 10); blob(ctx, rnd, W / 3.2, 7, 0.3); ctx.fill(); ctx.restore();
      lines([[-W * 0.1, -W * 0.05, W * 0.15, W * 0.12]], u * 0.02, P.color('stone', -0.45));
      break;
    case 'tree': {
      // A shadow, then the canopy in clumps of lighter and darker leaves.
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(u * 0.12, u * 0.12, W / 2, 0, Math.PI * 2); ctx.fill();
      blob(ctx, rnd, W / 2, 14, 0.2); P.fill('leaves', -0.25); ctx.stroke();
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * W * 0.28, r = W * (0.12 + rnd() * 0.1);
        const k = [-0.15, 0, 0.15][Math.floor(rnd() * 3)];
        ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2); P.fill('leaves', k);
      }
      ctx.fillStyle = 'rgba(255,255,220,0.12)';
      ctx.beginPath(); ctx.arc(-W * 0.12, -W * 0.12, W * 0.2, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'bush':
      blob(ctx, rnd, W / 2, 10, 0.3); P.fill('leaves'); ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * W * 0.22;
        ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, W * 0.16, 0, Math.PI * 2); P.fill('leaves', rnd() > 0.5 ? 0.25 : 0.12);
      }
      break;
    case 'rubble':
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * W * 0.36, r = W * (0.06 + rnd() * 0.08);
        ctx.save();
        ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
        blob(ctx, rnd, r, 6, 0.4); P.fill('stone', rnd() > 0.5 ? 0.1 : -0.1); ctx.stroke();
        ctx.restore();
      }
      break;
    // ---- furniture
    case 'desk':
      rect(-W / 2, -H / 2, W, H, 'wood');
      lines([[-W / 2, -H / 6, W / 2, -H / 6]], u * 0.02, grain('wood'));
      ctx.save(); ctx.rotate(-0.12); rect(-W * 0.3, -H * 0.25, W * 0.22, H * 0.5, 'paper'); ctx.restore();
      ctx.save(); ctx.rotate(0.1); rect(-W * 0.22, -H * 0.2, W * 0.22, H * 0.5, 'paper', 0.05); ctx.restore();
      ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(W * 0.3, -H * 0.15, u * 0.07, 0, Math.PI * 2); ctx.fill();
      lines([[W * 0.3, -H * 0.15, W * 0.4, -H * 0.38]], u * 0.02, '#f2efe6');
      break;
    case 'throne':
      rect(-W / 2, -H / 2, W, H * 0.3, 'frame', -0.15);
      rect(-W / 2, -H / 2 + H * 0.25, W * 0.2, H * 0.75, 'frame');
      rect(W / 2 - W * 0.2, -H / 2 + H * 0.25, W * 0.2, H * 0.75, 'frame');
      rect(-W / 2 + W * 0.2, -H / 2 + H * 0.3, W * 0.6, H * 0.66, 'cushion');
      lines([[-W * 0.22, H * 0.05, W * 0.22, H * 0.05]], u * 0.02, P.color('cushion', -0.3));
      for (const x of [-W * 0.4, W * 0.4]) circle(x, -H * 0.4, W * 0.09, 'frame', 0.25);
      break;
    case 'counter':
      rect(-W / 2, -H / 2, W, H, 'wood');
      lines([[-W / 2, H / 2 - u * 0.12, W / 2, H / 2 - u * 0.12]], u * 0.03, grain('wood'));
      lines([[-W / 2, -H / 6, W / 2, -H / 6]], u * 0.015, grain('wood'));
      break;
    case 'counter-corner': {
      // An L: one arm along the top, one down the left, each 0.6 squares deep and 0.2 in from
      // the edge, so it lines up with counters put down on the squares beside it.
      const a = u * 0.2, d = u * 0.6;
      ctx.beginPath();
      ctx.moveTo(-W / 2 + a, -H / 2 + a); ctx.lineTo(W / 2, -H / 2 + a); ctx.lineTo(W / 2, -H / 2 + a + d);
      ctx.lineTo(-W / 2 + a + d, -H / 2 + a + d); ctx.lineTo(-W / 2 + a + d, H / 2); ctx.lineTo(-W / 2 + a, H / 2); ctx.closePath();
      P.fill('wood'); ctx.stroke();
      lines([[-W / 2 + a + d - u * 0.12, H / 2, -W / 2 + a + d - u * 0.12, -H / 2 + a + d - u * 0.12], [-W / 2 + a + d - u * 0.12, -H / 2 + a + d - u * 0.12, W / 2, -H / 2 + a + d - u * 0.12]], u * 0.03, grain('wood'));
      break;
    }
    case 'counter-end':
      ctx.beginPath(); ctx.moveTo(-W / 2, -H / 2); ctx.lineTo(W / 2 - H / 2, -H / 2); ctx.arc(W / 2 - H / 2, 0, H / 2, -Math.PI / 2, Math.PI / 2); ctx.lineTo(-W / 2, H / 2); ctx.closePath();
      P.fill('wood'); ctx.stroke();
      lines([[-W / 2, H / 2 - u * 0.12, W / 2 - H / 2, H / 2 - u * 0.12]], u * 0.03, grain('wood'));
      break;
    case 'wardrobe':
      rect(-W / 2, -H / 2, W, H, 'wood');
      ctx.strokeRect(-W / 2 + u * 0.06, -H / 2 + u * 0.06, W - u * 0.12, H - u * 0.12);
      lines([[0, -H / 2 + u * 0.06, 0, H / 2]], u * 0.03, grain('wood'));
      for (const x of [-u * 0.08, u * 0.08]) circle(x, H / 2 - u * 0.1, u * 0.04, 'metal');
      break;
    case 'dresser':
      rect(-W / 2, -H / 2, W, H, 'wood');
      rect(-W / 2 + u * 0.06, -H / 2 + u * 0.06, W - u * 0.12, H - u * 0.18, 'wood', 0.1);
      for (const x of [-W * 0.3, 0, W * 0.3]) rect(x - u * 0.07, H / 2 - u * 0.07, u * 0.14, u * 0.05, 'metal');
      break;
    case 'weapon-rack':
      rect(-W / 2, -H / 2, W, H * 0.3, 'wood');
      for (let i = 0; i < 5; i++) {
        const x = -W / 2 + (W * (i + 0.5)) / 5;
        lines([[x, -H / 2 + H * 0.1, x, H / 2 - u * 0.04]], u * 0.045, P.color('metal'));
        if (i % 2) { // a spear: a point
          ctx.beginPath(); ctx.moveTo(x, H / 2 + u * 0.04); ctx.lineTo(x - u * 0.05, H / 2 - u * 0.1); ctx.lineTo(x + u * 0.05, H / 2 - u * 0.1); ctx.closePath(); P.fill('metal', 0.2); ctx.stroke();
        } else { // a sword: a guard and grip
          lines([[x - u * 0.08, -H / 2 + H * 0.38, x + u * 0.08, -H / 2 + H * 0.38]], u * 0.04, P.color('wood', 0.1));
        }
      }
      break;
    case 'armor-stand':
      lines([[-W * 0.45, 0, W * 0.45, 0]], u * 0.06, P.color('wood'));
      ctx.beginPath(); ctx.ellipse(0, H * 0.05, W * 0.32, H * 0.36, 0, 0, Math.PI * 2); P.fill('metal'); ctx.stroke();
      for (const x of [-W * 0.32, W * 0.32]) circle(x, 0, W * 0.13, 'metal', -0.15);
      circle(0, -H * 0.05, W * 0.15, 'metal', 0.2);
      lines([[-W * 0.08, -H * 0.05, W * 0.08, -H * 0.05]], u * 0.025, INK);
      break;
    // ---- storage
    case 'sacks':
      for (const [x, y, r] of [[-W * 0.18, -H * 0.12, 0.26], [W * 0.2, -H * 0.05, 0.24], [0, H * 0.22, 0.25]]) {
        ctx.save(); ctx.translate(x, y);
        blob(ctx, rnd, W * r, 9, 0.18); P.fill('cloth', rnd() > 0.5 ? 0.05 : -0.05); ctx.stroke();
        circle(0, -W * r * 0.55, W * 0.06, 'cloth', -0.3);
        ctx.restore();
      }
      break;
    case 'hay-bale':
      rrect(ctx, -W / 2, -H / 2, W, H, u * 0.1); P.fill('straw'); ctx.stroke();
      lines(Array.from({ length: 22 }, () => { const x = (rnd() - 0.5) * W * 0.85, y = (rnd() - 0.5) * H * 0.8, l = u * (0.06 + rnd() * 0.1); return [x, y, x + l, y + (rnd() - 0.5) * l * 0.4]; }), u * 0.015, P.color('straw', -0.3));
      lines([[-W * 0.25, -H / 2, -W * 0.25, H / 2], [W * 0.25, -H / 2, W * 0.25, H / 2]], u * 0.035, P.color('straw', -0.5));
      break;
    // ---- buildings and dungeons
    case 'archway': {
      rect(-W / 2, -H / 2, W * 0.24, H, 'stone', -0.1);
      rect(W / 2 - W * 0.24, -H / 2, W * 0.24, H, 'stone', -0.1);
      rect(-W / 2 + W * 0.24, -H * 0.32, W * 0.52, H * 0.64, 'stone', 0.12);
      const blocks = 6, x0 = -W / 2 + W * 0.24, bw = (W * 0.52) / blocks;
      lines(Array.from({ length: blocks - 1 }, (_, i) => [x0 + bw * (i + 1), -H * 0.32, x0 + bw * (i + 1), H * 0.32]), u * 0.02, P.color('stone', -0.35));
      rect(-u * 0.1, -H * 0.32, u * 0.2, H * 0.64, 'stone', 0.25); // the keystone
      break;
    }
    case 'bars':
      lines([[-W / 2, 0, W / 2, 0]], u * 0.05, P.color('metal', -0.2));
      for (let i = 0; i < 7; i++) circle(-W / 2 + u * 0.06 + ((W - u * 0.12) * i) / 6, 0, u * 0.05, 'metal', 0.15);
      break;
    case 'fence':
      lines([[-W / 2, -H * 0.2, W / 2, -H * 0.2], [-W / 2, H * 0.2, W / 2, H * 0.2]], u * 0.06, P.color('wood'));
      for (let i = 0; i <= 2; i++) rect(-W / 2 + ((W - u * 0.2) * i) / 2, -u * 0.1, u * 0.2, u * 0.2, 'wood', -0.2);
      break;
    case 'barricade': {
      const n = 4;
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + (W * (i + 0.5)) / n;
        for (const s of [-1, 1]) {
          lines([[x - s * u * 0.18, -H / 2 + u * 0.04, x + s * u * 0.18, H / 2 - u * 0.04]], u * 0.08, INK);
          lines([[x - s * u * 0.18, -H / 2 + u * 0.04, x + s * u * 0.18, H / 2 - u * 0.04]], u * 0.055, P.color('wood', s * 0.08));
        }
      }
      rect(-W / 2, -u * 0.07, W, u * 0.14, 'wood', -0.2);
      break;
    }
    case 'bridge': {
      const planks = Math.round(def.h * 4);
      for (let i = 0; i < planks; i++) rect(-W / 2 + u * 0.05, -H / 2 + (H * i) / planks, W - u * 0.1, H / planks - u * 0.02, 'wood', (rnd() - 0.5) * 0.3);
      lines([[-W / 2 + u * 0.05, -H / 2, -W / 2 + u * 0.05, H / 2], [W / 2 - u * 0.05, -H / 2, W / 2 - u * 0.05, H / 2]], u * 0.06, P.color('rope'));
      break;
    }
    case 'dais':
      circle(0, 0, W / 2, 'stone', -0.2);
      circle(0, 0, W * 0.42, 'stone');
      circle(0, 0, W * 0.34, 'top');
      ctx.save(); ctx.strokeStyle = P.color('inlay'); ctx.lineWidth = u * 0.04;
      ctx.beginPath(); ctx.arc(0, 0, W * 0.27, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = u * 0.025; ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.moveTo(Math.cos(a) * W * 0.2, Math.sin(a) * W * 0.2); ctx.lineTo(Math.cos(a) * W * 0.27, Math.sin(a) * W * 0.27); }
      ctx.stroke(); ctx.restore();
      break;
    case 'altar':
      rect(-W / 2, -H / 2, W, H, 'stone');
      ctx.strokeRect(-W / 2 + u * 0.07, -H / 2 + u * 0.07, W - u * 0.14, H - u * 0.14);
      rect(-W * 0.16, -H / 2, W * 0.32, H, 'cloth');
      lines([[-W * 0.16, H / 2 - u * 0.1, W * 0.16, H / 2 - u * 0.1]], u * 0.025, P.color('cloth', 0.35));
      for (const x of [-W * 0.36, W * 0.36]) { ctx.fillStyle = '#efe6cf'; ctx.beginPath(); ctx.arc(x, 0, u * 0.06, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      break;
    case 'sarcophagus': {
      const coffin = (k) => {
        ctx.beginPath();
        ctx.moveTo(-W * 0.3 * k, -H / 2 * k); ctx.lineTo(W * 0.3 * k, -H / 2 * k); ctx.lineTo(W / 2 * k, -H * 0.25 * k);
        ctx.lineTo(W * 0.36 * k, H / 2 * k); ctx.lineTo(-W * 0.36 * k, H / 2 * k); ctx.lineTo(-W / 2 * k, -H * 0.25 * k); ctx.closePath();
      };
      coffin(1); P.fill('stone'); ctx.stroke();
      coffin(0.84); P.fill('lid'); ctx.stroke();
      // A carved figure on the lid.
      ctx.save(); ctx.strokeStyle = P.color('lid', -0.35); ctx.lineWidth = u * 0.025;
      ctx.beginPath(); ctx.arc(0, -H * 0.27, W * 0.11, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, H * 0.08, W * 0.17, H * 0.27, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-W * 0.1, -H * 0.02); ctx.lineTo(W * 0.1, H * 0.06); ctx.moveTo(W * 0.1, -H * 0.02); ctx.lineTo(-W * 0.1, H * 0.06); ctx.stroke();
      ctx.restore();
      break;
    }
    case 'basin':
      circle(0, 0, W / 2, 'stone');
      circle(0, 0, W * 0.36, 'liquid');
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = u * 0.03;
      ctx.beginPath(); ctx.arc(0, 0, W * 0.26, Math.PI * 1.1, Math.PI * 1.45); ctx.stroke(); ctx.restore();
      break;
    case 'trough':
      rect(-W / 2, -H / 2, W, H, 'wood');
      rect(-W / 2 + u * 0.1, -H / 2 + u * 0.1, W - u * 0.2, H - u * 0.2, 'liquid');
      lines([[-W * 0.3, -H * 0.05, -W * 0.1, -H * 0.05], [W * 0.05, H * 0.08, W * 0.25, H * 0.08]], u * 0.02, 'rgba(255,255,255,0.3)');
      break;
    case 'pit': {
      const rs = radii(rnd, 14, 0.22);
      outline(ctx, rs, W / 2); P.fill('stone'); ctx.stroke();
      outline(ctx, rs, W * 0.43); P.fill('stone', -0.3); ctx.stroke();
      outline(ctx, rs, W * 0.36); P.fill('inside');
      // Deeper towards the middle, whatever fills it (a hole, lava, acid, ice).
      const dark = ctx.createRadialGradient(0, 0, W * 0.05, 0, 0, W * 0.4);
      dark.addColorStop(0, 'rgba(0,0,0,0)'); dark.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = dark; ctx.fill(); ctx.stroke();
      break;
    }
    // ---- camps and travel
    case 'tent': {
      const n = 8, R = W / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.arc(u * 0.1, u * 0.1, R, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < n; i++) {
        const a = ((i - 0.5) / n) * Math.PI * 2 - Math.PI / 2, b = ((i + 0.5) / n) * Math.PI * 2 - Math.PI / 2;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(b) * R, Math.sin(b) * R); ctx.closePath();
        P.fill('cloth', i % 2 ? -0.12 : 0.05); ctx.stroke();
      }
      // The door flap, at the front.
      ctx.beginPath(); ctx.moveTo(0, R * 0.35); ctx.lineTo(Math.cos(Math.PI / 2 - 0.3) * R, Math.sin(Math.PI / 2 - 0.3) * R); ctx.lineTo(Math.cos(Math.PI / 2 + 0.3) * R, Math.sin(Math.PI / 2 + 0.3) * R); ctx.closePath();
      P.fill('cloth', -0.4); ctx.stroke();
      circle(0, 0, u * 0.07, 'cloth', -0.3);
      break;
    }
    case 'bedroll':
      rrect(ctx, -W / 2, -H / 2, W, H, u * 0.12); P.fill('cloth'); ctx.stroke();
      rrect(ctx, -W / 2 + u * 0.08, -H / 2 + u * 0.08, W - u * 0.16, H * 0.3, u * 0.08); P.fill('lining'); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-W / 2 + u * 0.04, -H / 2 + H * 0.33); ctx.lineTo(W / 2 - u * 0.04, -H / 2 + H * 0.33); ctx.lineTo(W / 2 - u * 0.04, -H / 2 + H * 0.18); ctx.closePath();
      P.fill('cloth', 0.18); ctx.stroke();
      lines([[-W * 0.3, H * 0.15, W * 0.3, H * 0.15], [-W * 0.3, H * 0.32, W * 0.3, H * 0.32]], u * 0.02, P.color('cloth', -0.3));
      break;
    case 'cart': {
      // Shafts to the front (the top), the bed, and a wheel each side.
      lines([[-W * 0.22, -H * 0.12, -W * 0.18, -H / 2], [W * 0.22, -H * 0.12, W * 0.18, -H / 2], [-W * 0.18, -H * 0.42, W * 0.18, -H * 0.42]], u * 0.06, P.color('wood', -0.15));
      for (const s of [-1, 1]) rect(s > 0 ? W / 2 - W * 0.12 : -W / 2, H * 0.02, W * 0.12, H * 0.32, 'wheels');
      rect(-W * 0.38, -H * 0.15, W * 0.76, H * 0.65, 'wood');
      lines(Array.from({ length: 4 }, (_, i) => { const x = -W * 0.38 + (W * 0.76 * (i + 1)) / 5; return [x, -H * 0.15, x, H / 2]; }), u * 0.02, grain('wood'));
      ctx.strokeRect(-W * 0.38 + u * 0.06, -H * 0.15 + u * 0.06, W * 0.76 - u * 0.12, H * 0.65 - u * 0.12);
      break;
    }
    case 'rowboat': {
      const hull = (k) => {
        ctx.beginPath();
        ctx.moveTo(0, -H / 2 * k);
        ctx.bezierCurveTo(W * 0.55 * k, -H * 0.25 * k, W * 0.5 * k, H * 0.35 * k, W * 0.3 * k, H / 2 * k);
        ctx.lineTo(-W * 0.3 * k, H / 2 * k);
        ctx.bezierCurveTo(-W * 0.5 * k, H * 0.35 * k, -W * 0.55 * k, -H * 0.25 * k, 0, -H / 2 * k);
        ctx.closePath();
      };
      hull(1); P.fill('wood', -0.2); ctx.stroke();
      hull(0.86); P.fill('wood', 0.05); ctx.stroke();
      lines([[0, -H * 0.38, 0, H * 0.4]], u * 0.02, grain('wood'));
      for (const y of [-H * 0.15, H * 0.1, H * 0.3]) rect(-W * 0.38, y - u * 0.07, W * 0.76, u * 0.14, 'wood', -0.08);
      for (const s of [-1, 1]) lines([[s * W * 0.4, -H * 0.02, s * W * 0.8, H * 0.05]], u * 0.04, P.color('wood', 0.15));
      break;
    }
    // ---- nature
    case 'log': {
      const r = H / 2;
      ctx.beginPath(); ctx.ellipse(-W / 2 + r * 0.5, 0, r * 0.5, r, 0, 0, Math.PI * 2); P.fill('bark', -0.2); ctx.stroke();
      ctx.beginPath(); ctx.rect(-W / 2 + r * 0.5, -r, W - r, H); P.fill('bark');
      ctx.beginPath(); ctx.moveTo(-W / 2 + r * 0.5, -r); ctx.lineTo(W / 2 - r * 0.5, -r); ctx.moveTo(-W / 2 + r * 0.5, r); ctx.lineTo(W / 2 - r * 0.5, r); ctx.stroke();
      lines(Array.from({ length: 7 }, () => { const x = -W * 0.4 + rnd() * W * 0.7, y = (rnd() - 0.5) * H * 0.7; return [x, y, x + u * (0.2 + rnd() * 0.3), y]; }), u * 0.02, P.color('bark', -0.4));
      ctx.beginPath(); ctx.ellipse(W / 2 - r * 0.5, 0, r * 0.5, r, 0, 0, Math.PI * 2); P.fill('wood'); ctx.stroke();
      ctx.save(); ctx.strokeStyle = P.color('wood', -0.3); ctx.lineWidth = u * 0.015;
      for (const k of [0.65, 0.35]) { ctx.beginPath(); ctx.ellipse(W / 2 - r * 0.5, 0, r * 0.5 * k, r * k, 0, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
      break;
    }
    case 'stump':
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + rnd();
        ctx.save(); ctx.rotate(a); ctx.beginPath(); ctx.ellipse(W * 0.42, 0, W * 0.16, W * 0.08, 0, 0, Math.PI * 2); P.fill('bark', -0.15); ctx.stroke(); ctx.restore();
      }
      circle(0, 0, W * 0.42, 'bark');
      circle(0, 0, W * 0.34, 'wood');
      ctx.save(); ctx.strokeStyle = P.color('wood', -0.3); ctx.lineWidth = u * 0.015;
      for (const k of [0.25, 0.16, 0.07]) { ctx.beginPath(); ctx.arc(0, 0, W * k, 0, Math.PI * 2); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(W * 0.05, 0); ctx.lineTo(W * 0.3, W * 0.12); ctx.stroke();
      ctx.restore();
      break;
    // ---- clutter
    case 'books': {
      const colors = P.custom('books') ? [-0.25, 0, 0.2].map((k) => P.color('books', k)) : ['#7d2f2f', '#2f4f7d', '#3f6b3a'];
      [[-0.06, 0.04, -0.2], [0.05, -0.03, 0.15], [0, 0, -0.02]].forEach(([x, y, a], i) => {
        ctx.save(); ctx.translate(x * u, y * u); ctx.rotate(a);
        ctx.fillStyle = colors[i]; ctx.fillRect(-W * 0.4, -H * 0.38, W * 0.8, H * 0.76); ctx.strokeRect(-W * 0.4, -H * 0.38, W * 0.8, H * 0.76);
        ctx.fillStyle = '#efe6cf'; ctx.fillRect(W * 0.32, -H * 0.32, W * 0.06, H * 0.64);
        ctx.restore();
      });
      break;
    }
    case 'scroll':
      rect(-W * 0.35, -H * 0.4, W * 0.7, H * 0.8, 'paper');
      lines([[-W * 0.25, -H * 0.15, W * 0.25, -H * 0.15], [-W * 0.25, 0, W * 0.2, 0], [-W * 0.25, H * 0.15, W * 0.1, H * 0.15]], u * 0.015, P.color('paper', -0.55));
      for (const x of [-W / 2, W * 0.35]) rect(x, -H / 2, W * 0.15, H, 'paper', -0.15);
      break;
    case 'papers':
      [[-0.25, -0.06, 0], [0.18, 0.05, 0.04], [0, 0, -0.03]].forEach(([a, x, y]) => {
        ctx.save(); ctx.translate(x * u, y * u); ctx.rotate(a);
        rect(-W * 0.3, -H * 0.4, W * 0.6, H * 0.8, 'paper');
        lines([0, 1, 2, 3].map((i) => [-W * 0.22, -H * 0.25 + i * H * 0.14, W * 0.18, -H * 0.25 + i * H * 0.14]), u * 0.012, P.color('paper', -0.5));
        ctx.restore();
      });
      break;
    case 'plate':
      circle(0, 0, W / 2, 'dish');
      ctx.save(); ctx.strokeStyle = P.color('dish', -0.2); ctx.lineWidth = u * 0.012; ctx.beginPath(); ctx.arc(0, 0, W * 0.36, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      blob(ctx, rnd, W * 0.2, 7, 0.4); P.fill('food'); ctx.stroke();
      break;
    case 'tankard':
      rect(W * 0.18, -H * 0.12, W * 0.28, H * 0.24, 'metal', -0.2);
      circle(-W * 0.06, 0, H * 0.45, 'metal');
      circle(-W * 0.06, 0, H * 0.33, 'drink');
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.arc(-W * 0.1, -H * 0.06, H * 0.12, 0, Math.PI * 2); ctx.fill();
      break;
    case 'bottles':
      for (const [x, y, r] of [[-0.12, -0.08, 0.1], [0.12, -0.04, 0.09], [-0.02, 0.13, 0.1]]) {
        circle(x * u, y * u, r * u, 'glass');
        ctx.fillStyle = '#a0784a'; ctx.beginPath(); ctx.arc(x * u, y * u, r * u * 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.arc(x * u - r * u * 0.5, y * u - r * u * 0.5, r * u * 0.2, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'bones': {
      const bone = (x, y, a, l) => {
        ctx.save(); ctx.translate(x, y); ctx.rotate(a);
        for (const s of [-1, 1]) for (const t of [-1, 1]) circle(s * l / 2, t * u * 0.035, u * 0.04, 'bone');
        lines([[-l / 2, 0, l / 2, 0]], u * 0.07, INK);
        lines([[-l / 2, 0, l / 2, 0]], u * 0.045, P.color('bone'));
        ctx.restore();
      };
      for (let i = 0; i < 6; i++) bone((rnd() - 0.5) * W * 0.65, (rnd() - 0.5) * H * 0.65, rnd() * Math.PI, u * (0.2 + rnd() * 0.22));
      ctx.save(); ctx.translate(W * 0.18, -H * 0.2); ctx.scale(0.6, 0.6);
      ctx.beginPath(); ctx.ellipse(0, 0, u * 0.17, u * 0.2, 0, 0, Math.PI * 2); P.fill('bone'); ctx.stroke();
      ctx.fillStyle = INK; for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(s * u * 0.07, u * 0.06, u * 0.045, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      break;
    }
    case 'skull':
      ctx.beginPath(); ctx.ellipse(0, -H * 0.06, W * 0.44, H * 0.4, 0, 0, Math.PI * 2); P.fill('bone'); ctx.stroke();
      rect(-W * 0.24, H * 0.22, W * 0.48, H * 0.22, 'bone', -0.1);
      lines([[-W * 0.12, H * 0.25, -W * 0.12, H * 0.44], [0, H * 0.25, 0, H * 0.44], [W * 0.12, H * 0.25, W * 0.12, H * 0.44]], u * 0.012, INK);
      ctx.fillStyle = INK;
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * W * 0.17, H * 0.06, W * 0.11, H * 0.09, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.beginPath(); ctx.moveTo(0, H * 0.13); ctx.lineTo(-W * 0.05, H * 0.21); ctx.lineTo(W * 0.05, H * 0.21); ctx.closePath(); ctx.fill();
      break;
    case 'splatter': {
      // A blob with lobes, and drops thrown round it: blood, water, slime, oil, whatever its colour.
      ctx.save();
      ctx.strokeStyle = P.color('liquid', -0.35);
      blob(ctx, rnd, W * 0.3, 16, 0.55); P.fill('liquid'); ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const a = rnd() * Math.PI * 2, d = W * (0.25 + rnd() * 0.12);
        ctx.save(); ctx.translate(Math.cos(a) * d, Math.sin(a) * d); blob(ctx, rnd, W * (0.06 + rnd() * 0.06), 8, 0.4); P.fill('liquid'); ctx.stroke(); ctx.restore();
      }
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2, d = W * (0.36 + rnd() * 0.12);
        ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, W * (0.01 + rnd() * 0.02), 0, Math.PI * 2); P.fill('liquid');
      }
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.save(); ctx.translate(-W * 0.08, -W * 0.08); blob(ctx, rnd, W * 0.09, 7, 0.4); ctx.fill(); ctx.restore();
      ctx.restore();
      break;
    }
    case 'scorch': {
      const ash = P.color('ash');
      const soot = ctx.createRadialGradient(0, 0, W * 0.05, 0, 0, W / 2);
      soot.addColorStop(0, ash); soot.addColorStop(0.55, `${ash}cc`); soot.addColorStop(1, `${ash}00`);
      ctx.save();
      blob(ctx, rnd, W / 2, 18, 0.35); ctx.fillStyle = soot; ctx.fill();
      ctx.globalAlpha = 0.5;
      lines(Array.from({ length: 10 }, () => { const a = rnd() * Math.PI * 2, d1 = W * 0.15, d2 = W * (0.3 + rnd() * 0.18); return [Math.cos(a) * d1, Math.sin(a) * d1, Math.cos(a) * d2, Math.sin(a) * d2]; }), u * 0.03, ash);
      ctx.restore();
      break;
    }
    default:
      rect(-W / 2, -H / 2, W, H, 'wood');
  }
}

/**
 * Draw a prop: { kind, x, y, rot, scale, colors } (squares, degrees) for a grid of `g` px.
 * `seed` keeps a rock or tree's shape; `lit`: a light source's flame and glow; `texFill(ctx,
 * texture, px a square)`: a fill for a part set to a texture (the map's own textures).
 */
export function drawPropAt(ctx, p, g, { seed = '', lit = true, texFill = null } = {}) {
  ctx.save();
  ctx.translate(p.x * g, p.y * g);
  ctx.rotate(((p.rot ?? 0) * Math.PI) / 180);
  const sc = p.scale ?? 1;
  ctx.scale(sc, sc);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, (g * 0.03) / sc);
  const P = paints(ctx, propDef(p.kind), p.colors, g, texFill);
  // Small clutter (a tankard, a plate) gets thinner ink lines.
  if (Math.max(propDef(p.kind).w, propDef(p.kind).h) < 0.6) ctx.lineWidth = Math.max(1, (g * 0.02) / sc);
  if (isLight(p.kind)) drawLight(ctx, p, g, lit, P); else drawFurniture(ctx, p, g, seed, P);
  ctx.restore();
}

/** A prop's picture for a palette: a canvas data URL, `size` px square. */
const thumbs = new Map();
export function propThumb(kind, size = 56) {
  const key = `${kind}:${size}`;
  if (thumbs.has(key)) return thumbs.get(key);
  const def = propDef(kind);
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = (size * 0.8) / Math.max(def.w, def.h, 0.9);
  drawPropAt(c.getContext('2d'), { kind, x: size / 2 / g, y: size / 2 / g }, g, { seed: 'thumb' });
  const url = c.toDataURL();
  thumbs.set(key, url);
  return url;
}

/**
 * Where a prop stands in the way: its outline as points (scene px), turned and sized, for its
 * walls. Round props get a polygon.
 */
export function propOutline(p, g) {
  const def = propDef(p.kind);
  const sc = p.scale ?? 1, a = ((p.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const hw = (def.w * sc * g) / 2, hh = (def.h * sc * g) / 2;
  const local = def.round
    ? Array.from({ length: 12 }, (_, i) => [Math.cos((i / 12) * Math.PI * 2) * hw * 0.9, Math.sin((i / 12) * Math.PI * 2) * hh * 0.9])
    : [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  return local.map(([x, y]) => [p.x * g + x * cos - y * sin, p.y * g + x * sin + y * cos]);
}

/** Is a point (scene px) on the prop? `pad` in px. */
export function propHit(p, g, w, pad = 0) {
  const def = propDef(p.kind);
  const sc = p.scale ?? 1, a = (-(p.rot ?? 0) * Math.PI) / 180;
  const dx = w.x - p.x * g, dy = w.y - p.y * g;
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  const hw = (def.w * sc * g) / 2 + pad, hh = (def.h * sc * g) / 2 + pad;
  return def.round ? (lx / hw) ** 2 + (ly / hh) ** 2 <= 1 : Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}
