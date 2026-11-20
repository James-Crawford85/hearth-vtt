// The look of journal books: cover colours, the gold line-drawn emblems, damage
// marks and stamps for the pages, and the masks and looks for pictures.
// Everything is drawn here (inline SVG and CSS), so books need no image files.

/** Leather colours for covers: [colour, name]. */
export const COVER_COLORS = [
  ['#6b2e2e', 'Oxblood'], ['#8a3b2c', 'Rust'], ['#5a3b22', 'Saddle'], ['#7a5a1e', 'Ochre'],
  ['#2f4a3a', 'Forest'], ['#24494a', 'Teal'], ['#27384f', 'Midnight'], ['#3d2b4f', 'Plum'],
  ['#6e6a5e', 'Ash'], ['#1f1f22', 'Raven'],
];
export const DEFAULT_COVER = { color: '#5a3b22', emblem: 'quill' };

const svg = (body, view = '0 0 64 64', extra = '') => `<svg viewBox="${view}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"${extra}>${body}</svg>`;

/** Line-drawn emblems for covers (64×64, drawn with the current colour). */
export const EMBLEMS = {
  compass: ['Compass', '<circle cx="32" cy="32" r="25"/><circle cx="32" cy="32" r="20" stroke-dasharray="2 4"/><path d="M32 5 L37 32 L32 59 L27 32Z M5 32 L32 27 L59 32 L32 37Z"/><circle cx="32" cy="32" r="3"/>'],
  sword: ['Sword', '<path d="M32 4 L36 12 V40 H28 V12 Z M32 12 V38"/><path d="M17 40 H47 M32 40 V53"/><circle cx="32" cy="56" r="3.5"/>'],
  shield: ['Shield', '<path d="M32 6 L54 14 V30 C54 44 44 54 32 59 C20 54 10 44 10 30 V14 Z"/><path d="M32 11 V54 M14 28 H50"/>'],
  crown: ['Crown', '<path d="M10 46 L13 20 L24 34 L32 13 L40 34 L51 20 L54 46 Z M10 52 H54"/><circle cx="13" cy="17" r="2.5"/><circle cx="32" cy="10" r="2.5"/><circle cx="51" cy="17" r="2.5"/><circle cx="32" cy="40" r="3"/>'],
  skull: ['Skull', '<path d="M17 33 C17 15 47 15 47 33 C47 39 43 41 43 45 V52 H21 V45 C21 41 17 39 17 33Z"/><circle cx="25.5" cy="33" r="4.5"/><circle cx="38.5" cy="33" r="4.5"/><path d="M32 39 L29.5 44 H34.5Z M27 52 V47 M32 52 V47 M37 52 V47"/>'],
  tree: ['Tree', '<path d="M20 35 C9 35 9 20 19 20 C19 10 33 7 36 13 C44 7 55 15 50 24 C59 28 53 39 44 36 C40 41 25 41 20 35Z"/><path d="M32 58 V36 M32 46 L24 38 M32 42 L40 34 M24 58 H40"/>'],
  moon: ['Moon', '<path d="M38 8 A24 24 0 1 0 54 46 A19 19 0 1 1 38 8Z"/><path d="M50 14 l1.5 3.5 3.5 1.5 -3.5 1.5 -1.5 3.5 -1.5 -3.5 -3.5 -1.5 3.5 -1.5Z M55 32 l1 2 2 1 -2 1 -1 2 -1 -2 -2 -1 2 -1Z"/>'],
  tower: ['Tower', '<path d="M20 58 V22 H44 V58 Z M17 22 V13 H23 V17 H29 V13 H35 V17 H41 V13 H47 V22"/><path d="M27 58 V49 A5 5 0 0 1 37 49 V58 M29.5 29 H34.5 V36 H29.5Z"/>'],
  ship: ['Ship', '<path d="M8 40 H56 L48 51 H16 Z M32 40 V7 M32 10 L50 34 H32 M30 14 L15 34 H30 M32 7 L40 10 L32 13"/><path d="M5 58 q4 -4 8 0 t8 0 t8 0 t8 0 t8 0 t8 0 t8 0"/>'],
  key: ['Key', '<circle cx="17" cy="32" r="11"/><circle cx="17" cy="32" r="4"/><path d="M28 32 H59 M51 32 V41 M57 32 V39 M45 32 V37"/>'],
  rose: ['Rose', '<path d="M32 31 c-6 -1 -7 -9 -1 -10 c6 -1 9 7 3 11 c-8 5 -16 -4 -12 -11 c3 -5 12 -7 17 -2"/><path d="M32 34 C21 34 17 23 22 15 M32 34 C43 34 47 23 42 15 M32 34 V59 M32 47 C26 42 20 43 17 47 C23 50 29 49 32 47 M32 52 C38 47 44 48 47 52 C41 55 35 54 32 52"/>'],
  map: ['Map', '<path d="M8 14 L24 8 L40 14 L56 8 V50 L40 56 L24 50 L8 56 Z M24 8 V50 M40 14 V56"/><path d="M13 44 C19 33 29 46 33 32 C35 26 41 26 44 24" stroke-dasharray="2.5 3"/><path d="M44 18 l6 6 M50 18 l-6 6"/>'],
  eye: ['Eye', '<path d="M5 32 C16 15 48 15 59 32 C48 49 16 49 5 32Z"/><circle cx="32" cy="32" r="9"/><circle cx="32" cy="32" r="3"/><path d="M32 8 V13 M18 11 L21 16 M46 11 L43 16"/>'],
  flame: ['Flame', '<path d="M32 58 C18 58 14 44 22 34 C22 40 26 42 28 40 C24 30 30 18 38 7 C38 20 50 26 48 42 C47 52 40 58 32 58Z"/><path d="M32 55 C26 55 24 48 30 42 C30 46 34 46 34 44 C38 48 38 55 32 55Z"/>'],
  mountain: ['Mountain', '<path d="M4 52 L22 21 L32 36 L40 26 L60 52 Z M22 21 L17 30 L22 27 L26 32 M40 26 L37 31 L41 30"/><circle cx="49" cy="13" r="5"/>'],
  dragon: ['Dragon', '<path d="M8 42 C13 31 24 25 35 25 L45 13 L43 25 C51 25 57 31 59 37 L49 38 L55 44 L42 44 C36 51 25 53 16 50 Z"/><circle cx="45" cy="31" r="2"/><path d="M16 50 C10 54 8 58 12 60 M26 36 C28 40 32 41 36 39 M35 25 L30 15 L38 22"/>'],
  quill: ['Quill', '<path d="M52 6 C31 10 18 29 14 55 L18 51 C27 41 41 30 52 6Z"/><path d="M14 55 L9 60 M21 44 L30 40 M25 36 L36 31 M31 27 L41 22"/><path d="M40 54 H56 L53 60 H43 Z"/>'],
  d20: ['Die', '<path d="M32 5 L55 18 V46 L32 59 L9 46 V18Z M32 5 L18 40 H46 Z M18 40 L9 18 M46 40 L55 18 M18 40 L32 59 L46 40 M9 46 L18 40 M55 46 L46 40"/>'],
};

export function emblemSvg(key, cls = '') {
  const e = EMBLEMS[key];
  if (!e) return '';
  return svg(e[1], '0 0 64 64', ` class="jb-emblem ${cls}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`);
}

// ------------------------------------------------------------------ randomness

/** A repeatable random sequence in [0, 1) from a string. */
export function seeded(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uri = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;

/** A ragged edge (torn or burned paper) as a CSS mask, the same every time for a seed. */
function raggedMask(seed, depth) {
  const r = seeded(seed);
  const pts = [];
  const side = (n, f) => { for (let i = 0; i <= n; i++) pts.push(f(i / n, (r() * depth).toFixed(2))); };
  side(26, (t, d) => `${(t * 100).toFixed(2)},${d}`);
  side(26, (t, d) => `${100 - d},${(t * 100).toFixed(2)}`);
  side(26, (t, d) => `${(100 - t * 100).toFixed(2)},${100 - d}`);
  side(26, (t, d) => `${d},${(100 - t * 100).toFixed(2)}`);
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="${pts.join(' ')}"/></svg>`);
}

/** Picture masks: [label, how to apply it to an <img>]. */
export const MASKS = {
  none: 'Plain',
  torn: 'Torn paper',
  burned: 'Burned edge',
  oval: 'Oval',
  circle: 'Circle',
  polaroid: 'Snapshot',
  stamp: 'Postage stamp',
  soft: 'Faded edge',
};

/** Picture looks (filters). */
export const LOOKS = {
  none: 'As it is',
  sepia: 'Sepia',
  faded: 'Faded',
  ink: 'Ink sketch',
  aged: 'Aged print',
};

/** Style a picture (an <img>, or a frame around one) with a mask and a look. */
export function dressPicture(img, { mask = 'none', look = 'none', seed = '' } = {}) {
  img.classList.remove(...[...img.classList].filter((c) => c.startsWith('jb-mask-') || c.startsWith('jb-look-')));
  img.style.removeProperty('-webkit-mask-image');
  img.style.removeProperty('mask-image');
  if (MASKS[mask] && mask !== 'none') img.classList.add(`jb-mask-${mask}`);
  if (LOOKS[look] && look !== 'none') img.classList.add(`jb-look-${look}`);
  if (mask === 'torn' || mask === 'burned') {
    const m = raggedMask(seed || img.src, mask === 'torn' ? 4.5 : 6.5);
    img.style.setProperty('-webkit-mask-image', m);
    img.style.setProperty('mask-image', m);
  }
}

// ------------------------------------------------------------------ marks

const blob = (r, seed, cx, cy, rad, wob, n = 14) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = rad * (1 - wob / 2 + r() * wob);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  // A smooth closed curve through the points.
  let d = '';
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    if (!i) d += `M${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return `${d}Z`;
};

const splats = (r, n, cx, cy, spread, size) => Array.from({ length: n }, () => {
  const a = r() * Math.PI * 2, d = spread * (0.3 + r() * 0.9);
  return `<circle cx="${(cx + Math.cos(a) * d).toFixed(1)}" cy="${(cy + Math.sin(a) * d).toFixed(1)}" r="${(size * (0.3 + r())).toFixed(1)}"/>`;
}).join('');

/**
 * Damage and decorations placed on pages: { label, group, w (width as a share of the page),
 * draw(seed) → SVG markup }. Damage sits "in" the paper (multiplied into it).
 */
export const MARKS = {
  coffee: { label: 'Coffee ring', group: 'damage', w: 0.32, draw: (s) => {
    const r = seeded(s);
    return svg(`<defs><filter id="f${s}"><feTurbulence baseFrequency="0.9" numOctaves="2" seed="${Math.floor(r() * 99)}"/><feDisplacementMap in="SourceGraphic" scale="3"/></filter></defs>
      <g filter="url(#f${s})" fill="none" stroke="#6b3d16"><circle cx="50" cy="50" r="38" stroke-width="5" stroke-opacity=".38"/><circle cx="50" cy="50" r="36" stroke-width="1.5" stroke-opacity=".5"/>
      <path d="${blob(r, s, 50, 50, 38, 0.08)}" stroke-width="2" stroke-opacity=".25"/></g><path d="${blob(r, s, 50, 50, 34, 0.1)}" fill="#7a4a1c" fill-opacity=".06"/>`, '0 0 100 100');
  } },
  water: { label: 'Water stain', group: 'damage', w: 0.45, draw: (s) => {
    const r = seeded(s);
    return svg(`<path d="${blob(r, s, 50, 50, 42, 0.45, 18)}" fill="#8a6a3a" fill-opacity=".12" stroke="#6e4b20" stroke-opacity=".35" stroke-width="1.6"/>
      <path d="${blob(r, s, 46, 52, 26, 0.5, 14)}" fill="#8a6a3a" fill-opacity=".08" stroke="#6e4b20" stroke-opacity=".18" stroke-width="1"/>`, '0 0 100 100');
  } },
  burn: { label: 'Burn hole', group: 'damage', w: 0.24, draw: (s) => {
    const r = seeded(s);
    return svg(`<defs><radialGradient id="g${s}"><stop offset=".45" stop-color="#1a0d05"/><stop offset=".62" stop-color="#3a1a08"/><stop offset=".8" stop-color="#7a3d12" stop-opacity=".55"/><stop offset="1" stop-color="#a0601e" stop-opacity="0"/></radialGradient></defs>
      <path d="${blob(r, s, 50, 50, 46, 0.35, 16)}" fill="url(#g${s})"/><path d="${blob(r, s, 50, 50, 20, 0.5, 12)}" fill="#120904"/>`, '0 0 100 100');
  } },
  ink: { label: 'Ink blot', group: 'damage', w: 0.2, draw: (s) => {
    const r = seeded(s);
    return svg(`<g fill="#14100c" fill-opacity=".85"><path d="${blob(r, s, 50, 50, 22, 0.6, 16)}"/>${splats(r, 12, 50, 50, 40, 2.6)}</g>`, '0 0 100 100');
  } },
  blood: { label: 'Blood spatter', group: 'damage', w: 0.28, draw: (s) => {
    const r = seeded(s);
    return svg(`<g fill="#5e0e0a" fill-opacity=".78"><path d="${blob(r, s, 44, 48, 14, 0.7, 14)}"/>${splats(r, 18, 46, 48, 44, 2.2)}<path d="M52 56 C54 66 53 74 55 86 C57 74 57 64 55 56Z"/></g>`, '0 0 100 100');
  } },
  mud: { label: 'Muddy boot print', group: 'damage', w: 0.18, draw: (s) => {
    const r = seeded(s);
    return svg(`<g fill="#3e2c1a" fill-opacity=".4"><path d="M32 10 C46 6 58 16 58 34 C58 50 52 60 44 62 C36 64 26 58 24 44 C22 30 22 14 32 10Z"/><path d="M30 72 C40 68 52 72 52 84 C52 94 44 98 38 98 C30 98 26 92 26 84 C26 78 26 74 30 72Z"/>${splats(r, 10, 42, 50, 40, 1.6)}</g>`, '0 0 80 100');
  } },
  tear: { label: 'Torn corner', group: 'damage', w: 0.22, draw: (s) => {
    // The top-right corner is gone: a ragged line from the top edge to the right edge.
    const r = seeded(s);
    const pts = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, j = i && i < 14 ? (r() - 0.5) * 9 : 0;
      pts.push(`${(t * 100 + j).toFixed(1)},${(t * 100 - j).toFixed(1)}`);
    }
    const edge = pts.join(' ');
    return svg(`<polygon points="${edge} 100,0" style="fill:var(--jb-desk,#1b1612)"/><polyline points="${edge}" fill="none" stroke="#b39a6a" stroke-width="2.2" stroke-opacity=".9"/>`, '0 0 100 100');
  } },
  seal: { label: 'Wax seal', group: 'decor', w: 0.16, draw: (s) => {
    const r = seeded(s);
    return svg(`<defs><radialGradient id="w${s}" cx=".4" cy=".35"><stop offset="0" stop-color="#c0392b"/><stop offset=".7" stop-color="#8e1f17"/><stop offset="1" stop-color="#5c120d"/></radialGradient></defs>
      <path d="${blob(r, s, 50, 50, 46, 0.18, 16)}" fill="url(#w${s})"/><circle cx="50" cy="50" r="30" fill="none" stroke="#5c120d" stroke-width="3" stroke-opacity=".7"/>
      <g transform="translate(29 29) scale(.66)" fill="none" stroke="#f0b3a8" stroke-opacity=".55" stroke-width="3" stroke-linecap="round">${EMBLEMS.rose[1]}</g>`, '0 0 100 100');
  } },
  tape: { label: 'Tape', group: 'decor', w: 0.22, draw: () => svg('<path d="M3 4 L97 0 L99 24 L1 28 Z" fill="#efe6c8" fill-opacity=".55" stroke="#c8b98e" stroke-opacity=".5"/>', '0 0 100 28') },
  rosette: { label: 'Compass rose', group: 'decor', w: 0.3, draw: () => svg(`<g fill="none" stroke="#3b2a18" stroke-opacity=".75" stroke-width="1.6">${EMBLEMS.compass[1]}</g><text x="32" y="3" font-size="6" text-anchor="middle" fill="#3b2a18" font-family="Georgia">N</text>`, '0 -4 64 70') },
  divider: { label: 'Flourish', group: 'decor', w: 0.6, draw: () => svg('<g fill="none" stroke="#3b2a18" stroke-opacity=".7" stroke-width="1.4" stroke-linecap="round"><path d="M4 10 C24 10 30 2 40 6 C46 8 46 14 50 10 C54 14 54 8 60 6 C70 2 76 10 96 10"/><circle cx="50" cy="10" r="2.2" fill="#3b2a18"/><path d="M30 13 C36 16 42 14 46 12 M70 13 C64 16 58 14 54 12"/></g>', '0 0 100 20') },
  xmark: { label: 'X marks the spot', group: 'decor', w: 0.12, draw: () => svg('<path d="M14 14 L86 86 M86 14 L14 86" stroke="#7a1c12" stroke-width="12" stroke-linecap="round" stroke-opacity=".85"/>', '0 0 100 100') },
  arrow: { label: 'Hand-drawn arrow', group: 'decor', w: 0.26, draw: () => svg('<g fill="none" stroke="#2a1d10" stroke-opacity=".8" stroke-width="2.4" stroke-linecap="round"><path d="M6 34 C30 10 60 8 90 20"/><path d="M78 10 L91 20 L77 28"/></g>', '0 0 100 40') },
};

/** A mark's SVG for a seed (ids inside the SVG are made from the seed, so keep them plain). */
export function markSvg(kind, seed) {
  const m = MARKS[kind];
  return m ? m.draw(String(seed).replace(/[^a-z0-9]/gi, '') || 'x') : '';
}

/** Fonts a page can be written in. */
export const FONTS = {
  book: ['Book', '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif'],
  hand: ['Handwriting', '"Segoe Print", "Bradley Hand", "Ink Free", "Comic Neue", cursive'],
  script: ['Flowing script', '"Segoe Script", "Snell Roundhand", "Apple Chancery", "URW Chancery L", cursive'],
  scrawl: ['Scrawl', '"Ink Free", "Chalkboard SE", "Marker Felt", "Segoe Print", cursive'],
  plain: ['Plain', 'Georgia, "Times New Roman", serif'],
};
