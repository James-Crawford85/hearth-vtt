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
].map((l) => ({ ...l, w: 0.6, h: 0.6, round: true, layer: 1, light: true, parts: [...l.parts, part('glow', 'Light', l.color)] }));

/** Furniture and nature. */
export const FURNITURE = [
  { id: 'table', label: 'Table', w: 2, h: 1, block: 'invisible', parts: [part('wood', 'Top', WOOD_LIGHT)] },
  { id: 'round-table', label: 'Round table', w: 1.3, h: 1.3, round: true, block: 'invisible', parts: [part('wood', 'Top', WOOD_LIGHT)] },
  { id: 'chair', label: 'Chair', w: 0.55, h: 0.55, parts: [part('wood', 'Wood', WOOD)] },
  { id: 'bench', label: 'Bench', w: 2, h: 0.45, parts: [part('wood', 'Wood', WOOD)] },
  { id: 'bed', label: 'Bed', w: 1, h: 2, block: 'invisible', parts: [part('wood', 'Frame', '#6b4424'), part('sheets', 'Sheets', '#e8e0cc'), part('pillow', 'Pillow', '#f8f4ea'), part('blanket', 'Blanket', '#7d2f2f')] },
  { id: 'bookshelf', label: 'Bookshelf', w: 2, h: 0.5, block: 'invisible', blocks: true, parts: [part('wood', 'Shelf', '#6b4424'), part('books', 'Books', '#7d2f2f')] },
  { id: 'barrel', label: 'Barrel', w: 0.75, h: 0.75, round: true, block: 'invisible', parts: [part('wood', 'Staves', WOOD), part('metal', 'Hoops', IRON)] },
  { id: 'crate', label: 'Crate', w: 0.8, h: 0.8, block: 'invisible', parts: [part('wood', 'Wood', WOOD_LIGHT)] },
  { id: 'chest', label: 'Chest', w: 0.9, h: 0.6, parts: [part('wood', 'Wood', WOOD), part('metal', 'Band', IRON), part('lock', 'Lock', '#d8b04a')] },
  { id: 'rug', label: 'Rug', w: 2, h: 3, layer: 0, parts: [part('cloth', 'Rug', '#7d2f2f'), part('trim', 'Border', '#d8b04a'), part('pattern', 'Pattern', '#2f4f7d'), part('fringe', 'Fringe', '#d8c08a')] },
  { id: 'stairs', label: 'Stairs', w: 1, h: 2, link: true, parts: [part('steps', 'Steps', '#77736a')] },
  { id: 'ladder', label: 'Ladder', w: 0.6, h: 1.2, link: true, parts: [part('wood', 'Wood', WOOD)] },
  { id: 'trapdoor', label: 'Trapdoor', w: 1, h: 1, link: true, parts: [part('wood', 'Wood', WOOD), part('metal', 'Ring', IRON)] },
  { id: 'pillar', label: 'Pillar', w: 0.8, h: 0.8, round: true, block: 'wall', blocks: true, parts: [part('stone', 'Stone', STONE)] },
  { id: 'statue', label: 'Statue', w: 1, h: 1, block: 'wall', blocks: true, parts: [part('plinth', 'Plinth', '#5f5c57'), part('stone', 'Figure', STONE)] },
  { id: 'well', label: 'Well', w: 1.4, h: 1.4, round: true, block: 'invisible', blocks: true, parts: [part('stone', 'Stone', STONE), part('water', 'Water', '#16242c'), part('wood', 'Beam', '#6b4424')] },
  { id: 'rock', label: 'Rock', w: 1, h: 1, round: true, block: 'wall', blocks: true, parts: [part('stone', 'Rock', '#6e6a63')] },
  { id: 'tree', label: 'Tree', w: 2, h: 2, round: true, layer: 2, block: 'wall', parts: [part('leaves', 'Leaves', LEAVES)] },
  { id: 'bush', label: 'Bush', w: 1, h: 1, round: true, parts: [part('leaves', 'Leaves', '#2f5a26')] },
  { id: 'rubble', label: 'Rubble', w: 1, h: 1, round: true, block: 'invisible', parts: [part('stone', 'Stones', '#6c6963')] },
].map((f) => ({ layer: 1, block: null, blocks: false, round: false, ...f }));

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
