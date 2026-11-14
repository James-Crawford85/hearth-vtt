// The sketch map's built-in textures, painted in code (no image files, nothing to license): each
// is a 256 px tile that repeats seamlessly and covers 2 × 2 grid squares. Seeded, so every
// player sees the same floor.

const SIZE = 256;

/** The built-in materials, in palette order. `floor: false` ones make better outsides. */
export const MATERIALS = [
  { id: 'stone', label: 'Stone flagstones' },
  { id: 'wood', label: 'Wooden planks' },
  { id: 'tiles', label: 'Tiles' },
  { id: 'dirt', label: 'Dirt' },
  { id: 'grass', label: 'Grass' },
  { id: 'sand', label: 'Sand' },
  { id: 'water', label: 'Water' },
  { id: 'rock', label: 'Rock (cave walls)' },
  { id: 'brick', label: 'Brick' },
];

/** What roofs can be made of. */
export const ROOF_MATERIALS = [
  { id: 'shingles', label: 'Wooden shingles' },
  { id: 'thatch', label: 'Thatch' },
  { id: 'slate', label: 'Slate' },
  { id: 'tiles-red', label: 'Clay tiles' },
];

/** How walls can be drawn: a plain ink line, or a band of texture edged in ink. */
export const WALL_STYLES = [
  { id: 'ink', label: 'Ink line' },
  { id: 'stone', label: 'Stone blocks' },
  { id: 'brick', label: 'Brick' },
  { id: 'wood', label: 'Wooden' },
  { id: 'rock', label: 'Cave rock' },
  { id: 'hedge', label: 'Hedge' },
];

/** A small seeded random number generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise that repeats every `px` × `py` lattice cells across the tile. */
function noiseField(seed, px, py) {
  const r = rng(seed);
  const v = Array.from({ length: px * py }, () => r());
  const s = (t) => t * t * (3 - 2 * t);
  return (x, y) => { // x, y in 0..1 over the tile
    const fx = x * px, fy = y * py;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = s(fx - x0), ty = s(fy - y0);
    const at = (i, j) => v[(((j % py) + py) % py) * px + (((i % px) + px) % px)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}

/** Fractal noise (0..1): octaves of `noiseField`, each twice as fine. */
function fbm(seed, px, py = px, octaves = 4) {
  const fields = Array.from({ length: octaves }, (_, i) => noiseField(seed + i * 101, px << i, py << i));
  return (x, y) => {
    let sum = 0, amp = 1, norm = 0;
    for (const f of fields) { sum += f(x, y) * amp; norm += amp; amp /= 2; }
    return sum / norm;
  };
}

function canvas() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return c;
}

/** Fill the tile pixel by pixel: `fn(x, y)` (0..1) → [r, g, b]. */
function paint(ctx, fn) {
  const img = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = fn(x / SIZE, y / SIZE);
      const i = (y * SIZE + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Draw something nine times, shifted by a tile each way, so what crosses an edge wraps. */
function wrap(ctx, draw) {
  for (const dx of [-SIZE, 0, SIZE]) for (const dy of [-SIZE, 0, SIZE]) { ctx.save(); ctx.translate(dx, dy); draw(); ctx.restore(); }
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

const PAINTERS = {
  stone(ctx) {
    const n = fbm(11, 8);
    paint(ctx, (x, y) => mix([58, 56, 54], [96, 94, 90], n(x, y)));
    const r = rng(12);
    const rowH = SIZE / 4; // two slabs per square, top to bottom
    for (let row = 0; row < 4; row++) {
      let x = r() * 60;
      const end = x + SIZE;
      while (x < end - 1) {
        const w = Math.min(end - x, 52 + r() * 50);
        const shade = 0.75 + r() * 0.5;
        const sx = x, sy = row * rowH, gap = 3;
        wrap(ctx, () => {
          ctx.fillStyle = `rgba(${Math.round(120 * shade)}, ${Math.round(117 * shade)}, ${Math.round(110 * shade)}, 0.55)`;
          ctx.fillRect(sx + gap, sy + gap, w - gap * 2, rowH - gap * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.12)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(sx + gap, sy + rowH - gap); ctx.lineTo(sx + gap, sy + gap); ctx.lineTo(sx + w - gap, sy + gap); ctx.stroke();
          ctx.strokeStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath(); ctx.moveTo(sx + w - gap, sy + gap); ctx.lineTo(sx + w - gap, sy + rowH - gap); ctx.lineTo(sx + gap, sy + rowH - gap); ctx.stroke();
        });
        x += w;
      }
    }
  },
  wood(ctx) {
    const grain = fbm(21, 2, 32, 3);
    const n = fbm(22, 8);
    paint(ctx, (x, y) => {
      const g = grain(x, y);
      return mix([92, 60, 34], [150, 104, 62], g * 0.7 + n(x, y) * 0.3);
    });
    const r = rng(23);
    const plank = SIZE / 8; // four planks per square
    for (let row = 0; row < 8; row++) {
      const y = row * plank;
      const tint = r();
      ctx.fillStyle = `rgba(${tint > 0.5 ? '40,20,0' : '255,220,170'}, ${0.04 + r() * 0.08})`;
      ctx.fillRect(0, y, SIZE, plank);
      ctx.fillStyle = 'rgba(30, 16, 6, 0.75)';
      ctx.fillRect(0, y, SIZE, 2);
      // Butt joints, staggered.
      let x = r() * SIZE;
      for (let i = 0; i < 2; i++) {
        const jx = x % SIZE;
        wrap(ctx, () => { ctx.fillRect(jx, y, 2, plank); });
        x += SIZE / 2 + (r() - 0.5) * 60;
      }
    }
  },
  tiles(ctx) {
    const n = fbm(31, 8);
    paint(ctx, (x, y) => {
      const cell = (Math.floor(x * 8) + Math.floor(y * 8)) % 2;
      const base = cell ? [196, 186, 166] : [120, 112, 100];
      return mix(base, base.map((v) => v * 0.8), n(x, y));
    });
    ctx.fillStyle = 'rgba(40, 34, 28, 0.6)';
    for (let i = 0; i < 8; i++) { ctx.fillRect(i * 32, 0, 1.5, SIZE); ctx.fillRect(0, i * 32, SIZE, 1.5); }
  },
  dirt(ctx) {
    const n = fbm(41, 6);
    const d = fbm(42, 24, 24, 2);
    paint(ctx, (x, y) => mix(mix([88, 64, 40], [128, 96, 62], n(x, y)), [70, 50, 32], d(x, y) > 0.62 ? 0.5 : 0));
    const r = rng(43);
    for (let i = 0; i < 60; i++) {
      const x = r() * SIZE, y = r() * SIZE, rad = 1 + r() * 2.5, l = r() > 0.5;
      wrap(ctx, () => { ctx.fillStyle = l ? 'rgba(170,140,100,0.6)' : 'rgba(40,28,16,0.6)'; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill(); });
    }
  },
  grass(ctx) {
    const n = fbm(51, 6);
    paint(ctx, (x, y) => mix([46, 82, 34], [86, 124, 52], n(x, y)));
    const r = rng(52);
    ctx.lineCap = 'round';
    for (let i = 0; i < 700; i++) {
      const x = r() * SIZE, y = r() * SIZE, len = 3 + r() * 6, lean = (r() - 0.5) * 4;
      const c = r() > 0.5 ? `rgba(120,165,70,${0.35 + r() * 0.4})` : `rgba(30,60,22,${0.3 + r() * 0.4})`;
      wrap(ctx, () => { ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + lean, y - len); ctx.stroke(); });
    }
  },
  sand(ctx) {
    const n = fbm(61, 4);
    const ripple = fbm(62, 4, 2, 2);
    paint(ctx, (x, y) => {
      const rp = 0.5 + 0.5 * Math.sin((y * 10 + ripple(x, y) * 3) * Math.PI * 2);
      return mix(mix([196, 170, 120], [222, 200, 150], n(x, y)), [180, 152, 104], rp * 0.25);
    });
    const r = rng(63);
    for (let i = 0; i < 400; i++) {
      const x = r() * SIZE, y = r() * SIZE;
      ctx.fillStyle = r() > 0.5 ? 'rgba(120,96,60,0.5)' : 'rgba(250,236,200,0.6)';
      ctx.fillRect(x, y, 1.2, 1.2);
    }
  },
  water(ctx) {
    const n = fbm(71, 4);
    const w = fbm(72, 8, 8, 3);
    paint(ctx, (x, y) => mix([26, 66, 96], [46, 104, 138], n(x, y) * 0.6 + w(x, y) * 0.4));
    const r = rng(73);
    ctx.lineCap = 'round';
    for (let i = 0; i < 40; i++) {
      const x = r() * SIZE, y = r() * SIZE, len = 10 + r() * 18, alpha = 0.15 + r() * 0.25;
      wrap(ctx, () => {
        ctx.strokeStyle = `rgba(190, 225, 240, ${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + len / 2, y - 4, x + len, y); ctx.stroke();
      });
    }
  },
  brick(ctx) {
    const n = fbm(91, 8);
    paint(ctx, (x, y) => mix([150, 146, 136], [178, 172, 160], n(x, y))); // mortar
    const r = rng(92);
    const rowH = 16, w = 32;
    for (let row = 0; row < SIZE / rowH; row++) {
      const off = row % 2 ? w / 2 : 0;
      for (let x = -w; x < SIZE; x += w) {
        const shade = 0.8 + r() * 0.35;
        const bx = x + off, by = row * rowH;
        wrap(ctx, () => {
          ctx.fillStyle = `rgb(${Math.round(146 * shade)}, ${Math.round(66 * shade)}, ${Math.round(48 * shade)})`;
          ctx.fillRect(bx + 1.5, by + 1.5, w - 3, rowH - 3);
          ctx.fillStyle = 'rgba(255,255,255,0.08)';
          ctx.fillRect(bx + 1.5, by + 1.5, w - 3, 2);
        });
      }
    }
  },
  // Roofs: rows of overlapping pieces, each row's lower edge shaded.
  shingles(ctx) { roofRows(ctx, 111, [104, 70, 44], [142, 98, 60], 16, 22); },
  slate(ctx) { roofRows(ctx, 121, [58, 64, 74], [88, 96, 108], 14, 20); },
  'tiles-red'(ctx) { roofRows(ctx, 131, [150, 62, 40], [190, 92, 60], 16, 16, true); },
  thatch(ctx) {
    const n = fbm(141, 4, 16, 3);
    paint(ctx, (x, y) => mix([140, 112, 62], [196, 166, 102], n(x, y)));
    const r = rng(142);
    ctx.lineCap = 'round';
    for (let i = 0; i < 900; i++) {
      const x = r() * SIZE, y = r() * SIZE, len = 8 + r() * 14, c = r() > 0.5 ? `rgba(90,66,30,${0.3 + r() * 0.3})` : `rgba(230,205,140,${0.3 + r() * 0.3})`;
      wrap(ctx, () => { ctx.strokeStyle = c; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 1, y + len); ctx.stroke(); });
    }
    ctx.fillStyle = 'rgba(60, 40, 15, 0.35)';
    for (let row = 0; row < SIZE / 32; row++) ctx.fillRect(0, row * 32 + 28, SIZE, 4);
  },
  hedge(ctx) {
    const n = fbm(101, 6);
    paint(ctx, (x, y) => mix([22, 46, 20], [44, 82, 34], n(x, y)));
    const r = rng(102);
    for (let i = 0; i < 500; i++) {
      const x = r() * SIZE, y = r() * SIZE, rad = 3 + r() * 5, light = r();
      const c = light > 0.6 ? `rgba(96,150,62,${0.5 + r() * 0.4})` : light > 0.25 ? `rgba(58,104,42,${0.5 + r() * 0.4})` : `rgba(16,34,14,${0.4 + r() * 0.4})`;
      const turn = r() * Math.PI;
      wrap(ctx, () => { ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(x, y, rad, rad * 0.7, turn, 0, Math.PI * 2); ctx.fill(); });
    }
  },
  rock(ctx) {
    const n = fbm(81, 6);
    const c = fbm(82, 12, 12, 2);
    paint(ctx, (x, y) => {
      const crack = Math.abs(c(x, y) - 0.5) < 0.015 ? 0.6 : 0;
      return mix(mix([40, 37, 34], [70, 64, 58], n(x, y)), [16, 14, 12], crack);
    });
  },
};

/** Roof pieces in staggered rows (round-ended when `round`), shaded along each row's foot. */
function roofRows(ctx, seed, dark, light, rowH, w, round = false) {
  const n = fbm(seed, 8);
  paint(ctx, (x, y) => mix(dark, light, n(x, y) * 0.6));
  const r = rng(seed + 1);
  for (let row = 0; row < SIZE / rowH; row++) {
    const off = row % 2 ? w / 2 : 0;
    for (let x = -w; x < SIZE + w; x += w) {
      const t = 0.25 + r() * 0.75, bx = x + off, by = row * rowH;
      wrap(ctx, () => {
        ctx.fillStyle = `rgb(${mix(dark, light, t).map(Math.round).join(',')})`;
        ctx.beginPath();
        if (round) { ctx.moveTo(bx + 1, by); ctx.lineTo(bx + 1, by + rowH * 0.55); ctx.arc(bx + w / 2, by + rowH * 0.55, w / 2 - 1, Math.PI, 0, true); ctx.lineTo(bx + w - 1, by); } else ctx.rect(bx + 1, by, w - 2, rowH - 1);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(bx + 1, by + rowH - 3, w - 2, 2.5);
      });
    }
  }
}

const cache = new Map();
let more = null; // textures from elsewhere (the texture creator's), by id

/** Let another module supply tiles for ids that aren't built in (null: not one of its). */
export function setTextureSource(fn) { more = fn; }

/**
 * A material's tile (a canvas), or null for an unknown one. Painted once, on first use.
 * Built-ins cover 2 × 2 squares, the texture creator's 8 × 8: 128 pixels a square either way.
 */
export function texture(id) {
  if (!PAINTERS[id]) return more?.(id) ?? null;
  let c = cache.get(id);
  if (!c) {
    c = canvas();
    PAINTERS[id](c.getContext('2d'));
    cache.set(id, c);
  }
  return c;
}

/** How many grid squares one built-in tile covers, across. */
export const TILE_SQUARES = 2;
export const TILE_SIZE = SIZE;
