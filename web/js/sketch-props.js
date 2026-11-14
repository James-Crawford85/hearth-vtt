// Props for sketched maps, drawn in code (no image files): light sources, which bring their
// own light, and furniture and nature. Each is drawn centred on 0, 0, `w` × `h` squares in size
// (one square = `u` px), facing up; the board turns and sizes it.
//
//   layer 0 lies on the floor (rugs), 1 stands on it, 2 is above the walls (tree tops)
//   block: the kind of wall round it when it stands in the way ('wall' blocks sight too,
//          'invisible' only movement); blocks: whether it does at first
//   round: its outline is round (for picking it and for its walls)
//   link: it can lead to another level (stairs, ladders): a token stepping onto it goes there

const INK = '#17120e';

/** Light sources: radii in squares. */
export const LIGHTS = [
  { id: 'torch', label: 'Torch', bright: 4, dim: 8, color: '#ff9a3c' },
  { id: 'brazier', label: 'Brazier', bright: 3, dim: 6, color: '#ff7b2e' },
  { id: 'campfire', label: 'Campfire', bright: 4, dim: 8, color: '#ff8a3a' },
  { id: 'candles', label: 'Candles', bright: 1, dim: 3, color: '#ffc46b' },
  { id: 'lantern', label: 'Lantern', bright: 3, dim: 6, color: '#ffe2a0' },
  { id: 'crystal', label: 'Glowing crystal', bright: 2, dim: 5, color: '#8fb8ff' },
].map((l) => ({ ...l, w: 0.6, h: 0.6, round: true, layer: 1, light: true }));

/** Furniture and nature. */
export const FURNITURE = [
  { id: 'table', label: 'Table', w: 2, h: 1, block: 'invisible' },
  { id: 'round-table', label: 'Round table', w: 1.3, h: 1.3, round: true, block: 'invisible' },
  { id: 'chair', label: 'Chair', w: 0.55, h: 0.55 },
  { id: 'bench', label: 'Bench', w: 2, h: 0.45 },
  { id: 'bed', label: 'Bed', w: 1, h: 2, block: 'invisible' },
  { id: 'bookshelf', label: 'Bookshelf', w: 2, h: 0.5, block: 'invisible', blocks: true },
  { id: 'barrel', label: 'Barrel', w: 0.75, h: 0.75, round: true, block: 'invisible' },
  { id: 'crate', label: 'Crate', w: 0.8, h: 0.8, block: 'invisible' },
  { id: 'chest', label: 'Chest', w: 0.9, h: 0.6 },
  { id: 'rug', label: 'Rug', w: 2, h: 3, layer: 0 },
  { id: 'stairs', label: 'Stairs', w: 1, h: 2, link: true },
  { id: 'ladder', label: 'Ladder', w: 0.6, h: 1.2, link: true },
  { id: 'trapdoor', label: 'Trapdoor', w: 1, h: 1, link: true },
  { id: 'pillar', label: 'Pillar', w: 0.8, h: 0.8, round: true, block: 'wall', blocks: true },
  { id: 'statue', label: 'Statue', w: 1, h: 1, block: 'wall', blocks: true },
  { id: 'well', label: 'Well', w: 1.4, h: 1.4, round: true, block: 'invisible', blocks: true },
  { id: 'rock', label: 'Rock', w: 1, h: 1, round: true, block: 'wall', blocks: true },
  { id: 'tree', label: 'Tree', w: 2, h: 2, round: true, layer: 2, block: 'wall' },
  { id: 'bush', label: 'Bush', w: 1, h: 1, round: true },
  { id: 'rubble', label: 'Rubble', w: 1, h: 1, round: true, block: 'invisible' },
].map((f) => ({ layer: 1, block: null, blocks: false, round: false, ...f }));

export const ALL_PROPS = [...LIGHTS, ...FURNITURE];
const BY_ID = Object.fromEntries(ALL_PROPS.map((p) => [p.id, p]));

/** A prop kind's definition (unknown kinds draw as a crate). */
export const propDef = (kind) => BY_ID[kind] ?? BY_ID.crate;
export const isLight = (kind) => !!BY_ID[kind]?.light;

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
function drawLight(ctx, kind, u, lit) {
  const s = u * 0.6;
  const def = propDef(kind);
  if (lit) {
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 0.75);
    glow.addColorStop(0, `${def.color}88`);
    glow.addColorStop(1, `${def.color}00`);
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.75, 0, Math.PI * 2); ctx.fill();
  }
  const fl = (x, y, r) => { if (lit) flame(ctx, x, y, r); };
  switch (kind) {
    case 'brazier':
      ctx.fillStyle = '#3b3632';
      ctx.beginPath(); ctx.arc(0, 0, s * 0.32, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = lit ? '#c9461c' : '#4a3a30';
      ctx.beginPath(); ctx.arc(0, 0, s * 0.22, 0, Math.PI * 2); ctx.fill();
      fl(0, 0, s * 0.12);
      break;
    case 'campfire':
      ctx.fillStyle = '#77736c';
      for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; ctx.beginPath(); ctx.arc(Math.cos(a) * s * 0.36, Math.sin(a) * s * 0.36, s * 0.08, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      ctx.save();
      ctx.strokeStyle = '#6b4424';
      ctx.lineWidth = s * 0.09;
      ctx.beginPath(); ctx.moveTo(-s * 0.22, -s * 0.15); ctx.lineTo(s * 0.22, s * 0.15); ctx.moveTo(-s * 0.22, s * 0.15); ctx.lineTo(s * 0.22, -s * 0.15); ctx.stroke();
      ctx.restore();
      fl(0, 0, s * 0.13);
      break;
    case 'candles':
      for (const [cx, cy] of [[-s * 0.15, s * 0.05], [s * 0.15, s * 0.08], [0, -s * 0.12]]) {
        ctx.fillStyle = '#efe6cf';
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.08, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        fl(cx, cy - s * 0.02, s * 0.045);
      }
      break;
    case 'lantern':
      ctx.fillStyle = '#2e2924';
      ctx.fillRect(-s * 0.17, -s * 0.2, s * 0.34, s * 0.4);
      ctx.strokeRect(-s * 0.17, -s * 0.2, s * 0.34, s * 0.4);
      ctx.fillStyle = lit ? '#ffd76a' : '#6a6050';
      ctx.fillRect(-s * 0.1, -s * 0.13, s * 0.2, s * 0.26);
      ctx.beginPath(); ctx.arc(0, -s * 0.2, s * 0.1, Math.PI, 0); ctx.stroke();
      break;
    case 'crystal':
      ctx.fillStyle = lit ? '#7fb0ff' : '#4d5a70';
      ctx.beginPath(); ctx.moveTo(0, -s * 0.32); ctx.lineTo(s * 0.17, 0); ctx.lineTo(0, s * 0.32); ctx.lineTo(-s * 0.17, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.moveTo(0, -s * 0.32); ctx.lineTo(s * 0.06, 0); ctx.lineTo(0, s * 0.1); ctx.lineTo(-s * 0.08, 0); ctx.closePath(); ctx.fill();
      break;
    default: // torch
      ctx.save();
      ctx.strokeStyle = '#6b4424';
      ctx.lineWidth = s * 0.1;
      ctx.beginPath(); ctx.moveTo(0, s * 0.3); ctx.lineTo(0, -s * 0.02); ctx.stroke();
      ctx.restore();
      ctx.strokeRect(-s * 0.07, -s * 0.06, s * 0.14, s * 0.08);
      fl(0, -s * 0.12, s * 0.11);
  }
}

const WOOD = '#8a5a2e', WOOD_DARK = '#6b4424', WOOD_LIGHT = '#a7743f', STONE = '#8d8a84', STONE_DARK = '#5f5c57';

/** Draw furniture or nature (centred on 0, 0). */
function drawFurniture(ctx, kind, u, seed) {
  const def = propDef(kind);
  const W = def.w * u, H = def.h * u;
  const rnd = rng(`${kind}:${seed}`);
  const rect = (x, y, w, h, fill) => { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); };
  const circle = (x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); };
  const lines = (pts, width, color) => { ctx.save(); ctx.lineWidth = width; ctx.strokeStyle = color; ctx.beginPath(); for (const [a, b, c, d] of pts) { ctx.moveTo(a, b); ctx.lineTo(c, d); } ctx.stroke(); ctx.restore(); };
  switch (kind) {
    case 'table':
      rect(-W / 2, -H / 2, W, H, WOOD_LIGHT);
      lines([[-W / 2, -H / 6, W / 2, -H / 6], [-W / 2, H / 6, W / 2, H / 6]], u * 0.02, WOOD_DARK);
      break;
    case 'round-table':
      circle(0, 0, W / 2, WOOD_LIGHT);
      ctx.save(); ctx.strokeStyle = WOOD_DARK; ctx.lineWidth = u * 0.02; ctx.beginPath(); ctx.arc(0, 0, W / 2.8, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      break;
    case 'chair':
      rect(-W / 2, -H / 2 + H * 0.2, W, H * 0.8, WOOD);
      rect(-W / 2, -H / 2, W, H * 0.22, WOOD_DARK);
      break;
    case 'bench':
      rect(-W / 2, -H / 2, W, H, WOOD);
      lines([[-W / 2, 0, W / 2, 0]], u * 0.02, WOOD_DARK);
      break;
    case 'bed':
      rect(-W / 2, -H / 2, W, H, WOOD_DARK);
      rect(-W / 2 + u * 0.06, -H / 2 + u * 0.06, W - u * 0.12, H - u * 0.12, '#e8e0cc');
      rect(-W / 2 + u * 0.15, -H / 2 + u * 0.12, W - u * 0.3, H * 0.15, '#f8f4ea');
      rect(-W / 2 + u * 0.06, -H / 2 + H * 0.35, W - u * 0.12, H * 0.62, '#7d2f2f');
      lines([[-W / 2 + u * 0.06, -H / 2 + H * 0.45, W / 2 - u * 0.06, -H / 2 + H * 0.45]], u * 0.02, '#5a1f1f');
      break;
    case 'bookshelf': {
      rect(-W / 2, -H / 2, W, H, WOOD_DARK);
      const colors = ['#7d2f2f', '#2f4f7d', '#3f6b3a', '#8a6d2a', '#5a3d6e', '#a0522d'];
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
      circle(0, 0, W / 2, WOOD);
      ctx.save(); ctx.strokeStyle = '#3a3530'; ctx.lineWidth = u * 0.04;
      ctx.beginPath(); ctx.arc(0, 0, W / 2 - u * 0.06, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = u * 0.02; ctx.strokeStyle = WOOD_DARK;
      ctx.beginPath(); ctx.arc(0, 0, W / 5, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      break;
    case 'crate':
      rect(-W / 2, -H / 2, W, H, WOOD_LIGHT);
      lines([[-W / 2, -H / 2, W / 2, H / 2], [W / 2, -H / 2, -W / 2, H / 2]], u * 0.04, WOOD_DARK);
      ctx.strokeRect(-W / 2 + u * 0.06, -H / 2 + u * 0.06, W - u * 0.12, H - u * 0.12);
      break;
    case 'chest':
      rect(-W / 2, -H / 2, W, H, WOOD);
      rect(-W / 2, -H / 2 + H * 0.35, W, H * 0.12, '#3a3530');
      rect(-u * 0.07, -H / 2 + H * 0.3, u * 0.14, H * 0.22, '#d8b04a');
      break;
    case 'rug': {
      rect(-W / 2, -H / 2, W, H, '#7d2f2f');
      ctx.save();
      ctx.strokeStyle = '#d8b04a'; ctx.lineWidth = u * 0.05;
      ctx.strokeRect(-W / 2 + u * 0.15, -H / 2 + u * 0.15, W - u * 0.3, H - u * 0.3);
      ctx.fillStyle = '#2f4f7d';
      ctx.beginPath(); ctx.moveTo(0, -H * 0.25); ctx.lineTo(W * 0.25, 0); ctx.lineTo(0, H * 0.25); ctx.lineTo(-W * 0.25, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      // Fringes.
      lines(Array.from({ length: 9 }, (_, i) => { const x = -W / 2 + (W * (i + 0.5)) / 9; return [[x, -H / 2, x, -H / 2 - u * 0.08], [x, H / 2, x, H / 2 + u * 0.08]]; }).flat(), u * 0.02, '#d8c08a');
      break;
    }
    case 'stairs': {
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        const shade = 70 + Math.round((i / steps) * 80);
        rect(-W / 2, -H / 2 + (H * i) / steps, W, H / steps, `rgb(${shade}, ${shade - 4}, ${shade - 10})`);
      }
      // An arrow: up the stairs.
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.globalAlpha = 0.6; ctx.lineWidth = u * 0.04;
      ctx.beginPath(); ctx.moveTo(0, H * 0.3); ctx.lineTo(0, -H * 0.3); ctx.moveTo(-u * 0.15, -H * 0.18); ctx.lineTo(0, -H * 0.3); ctx.lineTo(u * 0.15, -H * 0.18); ctx.stroke();
      ctx.restore();
      break;
    }
    case 'ladder':
      lines([[-W / 2 + u * 0.06, -H / 2, -W / 2 + u * 0.06, H / 2], [W / 2 - u * 0.06, -H / 2, W / 2 - u * 0.06, H / 2]], u * 0.07, WOOD_DARK);
      lines(Array.from({ length: 6 }, (_, i) => { const y = -H / 2 + (H * (i + 0.5)) / 6; return [-W / 2 + u * 0.06, y, W / 2 - u * 0.06, y]; }), u * 0.05, WOOD);
      break;
    case 'trapdoor':
      rect(-W / 2, -H / 2, W, H, WOOD_DARK);
      rect(-W / 2 + u * 0.08, -H / 2 + u * 0.08, W - u * 0.16, H - u * 0.16, WOOD);
      lines([[-W / 2 + u * 0.08, 0, W / 2 - u * 0.08, 0]], u * 0.03, WOOD_DARK);
      ctx.save(); ctx.strokeStyle = '#3a3530'; ctx.lineWidth = u * 0.05; ctx.beginPath(); ctx.arc(W * 0.25, 0, u * 0.08, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      break;
    case 'pillar':
      circle(0, 0, W / 2, STONE);
      ctx.save(); ctx.strokeStyle = STONE_DARK; ctx.lineWidth = u * 0.03; ctx.beginPath(); ctx.arc(0, 0, W / 3, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(-W / 8, -W / 8, W / 5, 0, Math.PI * 2); ctx.fill();
      break;
    case 'statue':
      rect(-W / 2, -H / 2, W, H, STONE_DARK);
      circle(0, -H * 0.12, W * 0.18, STONE);
      ctx.fillStyle = STONE;
      ctx.beginPath(); ctx.ellipse(0, H * 0.12, W * 0.3, H * 0.2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      circle(0, -H * 0.12, W * 0.18, '#a6a39c');
      break;
    case 'well':
      circle(0, 0, W / 2, STONE);
      ctx.save(); ctx.strokeStyle = STONE_DARK; ctx.lineWidth = u * 0.02;
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * W * 0.32, Math.sin(a) * W * 0.32); ctx.lineTo(Math.cos(a) * W / 2, Math.sin(a) * W / 2); ctx.stroke(); }
      ctx.restore();
      circle(0, 0, W * 0.32, '#16242c');
      lines([[-W / 2, 0, W / 2, 0]], u * 0.06, WOOD_DARK);
      break;
    case 'rock':
      ctx.fillStyle = '#6e6a63';
      blob(ctx, rnd, W / 2, 9, 0.35); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.save(); ctx.translate(-W / 10, -W / 10); blob(ctx, rnd, W / 3.2, 7, 0.3); ctx.fill(); ctx.restore();
      lines([[-W * 0.1, -W * 0.05, W * 0.15, W * 0.12]], u * 0.02, '#3d3a35');
      break;
    case 'tree': {
      // A shadow, then the canopy in clumps.
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(u * 0.12, u * 0.12, W / 2, 0, Math.PI * 2); ctx.fill();
      const greens = ['#2f5a26', '#3d6e2f', '#4a7f38', '#2a4f22'];
      ctx.fillStyle = greens[3];
      blob(ctx, rnd, W / 2, 14, 0.2); ctx.fill(); ctx.stroke();
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * W * 0.28, r = W * (0.12 + rnd() * 0.1);
        ctx.fillStyle = greens[Math.floor(rnd() * 3)];
        ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,220,0.12)';
      ctx.beginPath(); ctx.arc(-W * 0.12, -W * 0.12, W * 0.2, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case 'bush':
      ctx.fillStyle = '#2f5a26';
      blob(ctx, rnd, W / 2, 10, 0.3); ctx.fill(); ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * W * 0.22;
        ctx.fillStyle = rnd() > 0.5 ? '#4a7f38' : '#3d6e2f';
        ctx.beginPath(); ctx.arc(Math.cos(a) * d, Math.sin(a) * d, W * 0.16, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'rubble':
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2, d = rnd() * W * 0.36, r = W * (0.06 + rnd() * 0.08);
        ctx.save();
        ctx.translate(Math.cos(a) * d, Math.sin(a) * d);
        ctx.fillStyle = rnd() > 0.5 ? '#7a766f' : '#5f5c57';
        blob(ctx, rnd, r, 6, 0.4); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      break;
    default:
      rect(-W / 2, -H / 2, W, H, WOOD);
  }
}

/**
 * Draw a prop: { kind, x, y, rot, scale } (squares, degrees) for a grid of `g` px. `seed` keeps
 * a rock or tree's shape; `lit`: a light source's flame and glow.
 */
export function drawPropAt(ctx, p, g, { seed = '', lit = true } = {}) {
  ctx.save();
  ctx.translate(p.x * g, p.y * g);
  ctx.rotate(((p.rot ?? 0) * Math.PI) / 180);
  const sc = p.scale ?? 1;
  ctx.scale(sc, sc);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, (g * 0.03) / sc);
  if (isLight(p.kind)) drawLight(ctx, p.kind, g, lit); else drawFurniture(ctx, p.kind, g, seed);
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
