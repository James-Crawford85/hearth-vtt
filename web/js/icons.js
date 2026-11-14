// Hearth's interface icons: simple 24×24 stroke drawings, coloured by CSS
// (`currentColor`). icon('name') returns an <svg> element.

const P = {
  // tool groups
  token: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  drawing: '<path d="M4 20l4-1 10-10-3-3L5 16l-1 4z"/><path d="M14 7l3 3"/>',
  walls: '<path d="M3 5h18v14H3z"/><path d="M3 9.7h18M3 14.3h18M9 5v4.7M15 5v4.7M6 9.7v4.6M12 9.7v4.6M18 9.7v4.6M9 14.3V19M15 14.3V19"/>',
  lighting: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  sounds: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.3 6.5a7.5 7.5 0 0 1 0 11"/>',
  modules: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><path d="M16.5 13v7M13 16.5h7"/>',
  // token tools
  select: '<path d="M6 3l12 9.5-5.2.6 3 6.4-2.6 1.2-3-6.4L6 18z"/>',
  'box-select': '<path d="M4 4h3M10 4h4M17 4h3v3M20 10v4M20 17v3h-3M14 20h-4M7 20H4v-3M4 14v-4M4 7V4"/><path d="M10 10l7 5-3 .4 1.5 3-1.4.6-1.5-3-2.6 1.9z"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
  ruler: '<path d="M3 16.5L16.5 3 21 7.5 7.5 21z"/><path d="M7 12.5l2 2M10 9.5l1.5 1.5M13 6.5l2 2"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/>',
  'grid-align': '<path d="M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18"/><path d="M1 1l4 4M23 23l-4-4"/>',
  unconstrained: '<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  // sketch tools
  sketch: '<path d="M3 4h7v6h4v4h7v6H3z"/><path d="M10 10H3M14 14H3" stroke-dasharray="2 2"/>',
  'sketch-room': '<rect x="4" y="5" width="16" height="14"/><path d="M8 5v14M12 5v14M16 5v14M4 9.7h16M4 14.3h16" stroke-width="0.9"/>',
  'sketch-round': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1"/><path d="M12 12l5.6-5.6" stroke-dasharray="2 1.6"/>',
  'sketch-floor': '<rect x="4" y="5" width="16" height="14" stroke-dasharray="2.5 2"/><path d="M7 9h3M12 13h4M8 16h2"/>',
  'sketch-wall': '<path d="M4 19V8h10" stroke-width="3"/><path d="M14 8l6 6" stroke-width="3"/>',
  'sketch-place': '<rect x="4" y="9" width="12" height="7" rx="1"/><path d="M6 16v3M14 16v3"/><circle cx="18.5" cy="6.5" r="2.5"/>',
  'sketch-railing': '<path d="M3 8h18M3 16h18"/><path d="M6 8v8M10 8v8M14 8v8M18 8v8"/>',
  'sketch-copy-walls': '<path d="M4 20h10V12H4z"/><path d="M10 8V4h10v8h-4" stroke-dasharray="2.2 1.8"/><path d="M14 6l3-3 3 3M17 3v7"/>',
  'sketch-roof': '<path d="M3 11l9-7 9 7"/><path d="M5 10v9h14v-9"/><path d="M9 19v-5h6v5"/>',
  'sketch-brush': '<path d="M14.5 4.5l5 5-7.5 7.5-5-5z"/><path d="M7 12l-2.5 2.5c-1 1-1 3.5-1.5 5.5 2-.5 4.5-.5 5.5-1.5L11 16"/>',
  'sketch-erase': '<path d="M8.5 20H20M4.5 15.5l9-9 6 6-7.5 7.5H9z"/><path d="M10 10l6 6"/>',
  'sketch-textures': '<rect x="2.5" y="4" width="7" height="6" rx="1.2"/><rect x="14.5" y="14" width="7" height="6" rx="1.2"/><path d="M9.5 7c4 0 1 10 5 10"/><circle cx="9.5" cy="7" r="1"/><circle cx="14.5" cy="17" r="1"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 15v4.5h16V15"/>',
  // drawing tools
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6"/>',
  polygon: '<path d="M12 3.5l8.5 6.2-3.3 10H6.8L3.5 9.7z"/>',
  freehand: '<path d="M3 17c3-6 5-9 7-7s-1 7 2 7 4-8 6-9 3 1 3 1"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  // wall tools
  'wall-select': '<path d="M3 17h7"/><path d="M11 6l9 7-4 .5 2.3 4.7-2 .9-2.3-4.7-3 2.4z"/>',
  'wall-draw': '<path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.8"/><circle cx="20" cy="4" r="1.8"/>',
  'wall-solid': '<path d="M5 19L19 5" stroke-width="3.2"/>',
  'wall-terrain': '<path d="M3 19l4-7 3 4 4-9 7 12"/>',
  'wall-invisible': '<path d="M5 19L19 5" stroke-dasharray="2 3"/><path d="M3 3l18 18"/>',
  'wall-ethereal': '<path d="M7 20V10a5 5 0 0 1 10 0v10l-2-1.5-1.5 1.5-1.5-1.5-1.5 1.5L9 18.5z"/><circle cx="10" cy="10.5" r=".6"/><circle cx="14" cy="10.5" r=".6"/>',
  door: '<path d="M6 21V3h12v18"/><path d="M4 21h16"/><circle cx="14.5" cy="12" r=".8"/>',
  'door-secret': '<path d="M6 21V3h12v18" stroke-dasharray="3 2.5"/><path d="M4 21h16"/><path d="M10.5 10a1.8 1.8 0 1 1 2.4 1.7c-.6.3-.9.7-.9 1.4M12 16v.2"/>',
  window: '<rect x="5" y="4" width="14" height="16" rx="1"/><path d="M12 4v16M5 12h14"/>',
  'doors-close': '<path d="M6 21V3h12v18"/><path d="M4 21h16"/><path d="M9.5 9l5 5M14.5 9l-5 5"/>',
  'clear-all': '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/>',
  // lighting tools
  'light-select': '<path d="M3 17h0"/><circle cx="8" cy="8" r="3.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5"/><path d="M13 12l7.5 5.8-3.4.4 1.9 3.9-1.7.8-1.9-3.9-2.4 2z"/>',
  'light-draw': '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  daynight: '<path d="M14 3a8 8 0 1 0 7 11.5A7 7 0 0 1 14 3z"/>',
  fog: '<path d="M4 9h12a3 3 0 1 0-3-3M3 13h15M5 17h12a3 3 0 1 1-3 3"/>',
  // sound tools
  'sound-select': '<path d="M3 8h2.5L9 5v10L5.5 12H3z"/><path d="M13 12l7.5 5.8-3.4.4 1.9 3.9-1.7.8-1.9-3.9-2.4 2z"/>',
  'sound-place': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M18 8v8M14 12h8"/>',
  'sound-preview': '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',
  // sidebar panels
  chat: '<path d="M4 5h16v11H9l-4.5 3.5V16H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  combat: '<path d="M4 4l9.5 9.5M4 4v3.5L13 16.5M4 4h3.5L16.5 13"/><path d="M20 4l-9.5 9.5M20 4v3.5L11 16.5M20 4h-3.5L7.5 13"/><path d="M8.5 17.5l-3 3M15.5 17.5l3 3"/>',
  scenes: '<path d="M3 6l6-2.5 6 2.5 6-2.5v14.5L15 20.5 9 18l-6 2.5z"/><path d="M9 3.5V18M15 6v14.5"/>',
  actors: '<circle cx="9" cy="8" r="3"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.3"/><path d="M16.5 14c2.5 0 4 1.6 4.5 4"/>',
  items: '<path d="M6 8h12l-1 12H7z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  journal: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M5 18a2 2 0 0 1 2-2h11M9 8h6M9 11h4"/>',
  tables: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  macros: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  playlists: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  collections: '<path d="M4 8l8-4 8 4-8 4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  // character sheets (tab icons; see SHEET_ICONS)
  tower: '<path d="M6 21V9h12v12M4 21h16M6 9V4h2.5v2h2V4h3v2h2V4H18v5"/><path d="M10.5 21v-4a1.5 1.5 0 0 1 3 0v4"/>',
  scroll: '<path d="M8 4h10.5a2 2 0 0 1 0 4H17v10a2 2 0 0 1-2 2H5.5a2 2 0 0 1 0-4H7V5a1 1 0 0 1 1-1z"/><path d="M10 9h4.5M10 12h4.5"/>',
  strength: '<path d="M6.5 8v8M17.5 8v8M3.5 10v4M20.5 10v4M6.5 12h11"/>',
  wand: '<path d="M4 20L14.5 9.5"/><path d="M17 3v3M15.5 4.5h3M20.5 8.5v2M19.5 9.5h2M11 3.5v2M10 4.5h2"/>',
  sparkle: '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  wrench: '<path d="M14.5 3.5a5 5 0 0 0-4.6 6.9L3.5 16.8V20.5h3.7l6.4-6.4a5 5 0 0 0 6.9-4.6l-3 1-2.5-2.5z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
  sword: '<path d="M20 4l-10.5 10.5M20 4h-3.5L7 13.5M20 4v3.5L10.5 17"/><path d="M6 12l6 6M8.5 15.5L4 20"/>',
  bow: '<path d="M5 3c6 2 10 6 12 12M5 3v1c4.5 2 9 6.5 11 11h1"/><path d="M5 3l12 12M14 15l3 0 0-3M20 21l-3-3"/>',
  backpack: '<path d="M6 10a6 6 0 0 1 12 0v10.5H6z"/><path d="M9.5 4.5V3h5v1.5M9 14h6v6.5H9z"/>',
  book: '<path d="M12 6c-2-1.5-5-2-8-1.5v14c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-14c-3-.5-6 0-8 1.5z"/><path d="M12 6v14"/>',
  d20: '<path d="M12 2.5l8.5 5v9L12 21.5l-8.5-5v-9z"/><path d="M12 2.5L7 14h10zM7 14l5 7.5 5-7.5M3.5 7.5L7 14M20.5 7.5L17 14"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.2 4.2 0 0 1 12 7.2a4.2 4.2 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  flame: '<path d="M12 21c-4 0-6.5-2.7-6.5-6.3 0-3.7 3-5.6 3.5-9.2 2 1 3 3 3 4.5 1-1 1.5-2.2 1.5-3.5 3 2 5.5 5 5.5 8.2C19 18.3 16 21 12 21z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.2c-.5-.8-1.5-1.2-2.5-1.2-1.4 0-2.5.7-2.5 1.9 0 2.7 5.2 1.4 5.2 4.2 0 1.2-1.2 1.9-2.7 1.9-1.1 0-2.1-.5-2.6-1.3M12 6.5V8M12 16v1.5"/>',
  skull: '<path d="M12 3a7 7 0 0 0-7 7c0 2.3 1 4 2.5 5v3h9v-3c1.5-1 2.5-2.7 2.5-5a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="10.5" r="1.5"/><circle cx="14.5" cy="10.5" r="1.5"/><path d="M10 18v3M14 18v3"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
  potion: '<path d="M10 3h4M10.5 3v5L6 15.5A4 4 0 0 0 9.5 21h5a4 4 0 0 0 3.5-5.5L13.5 8V3"/><path d="M7.5 14h9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
  paw: '<circle cx="7" cy="10" r="1.8"/><circle cx="10.5" cy="6.5" r="1.8"/><circle cx="14.5" cy="6.5" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M12.5 11.5c2.5 0 5 4 5 6.3 0 1.7-1.6 2.2-3 1.7-1-.4-2-.6-3-.2-1.4.6-3.5.4-3.5-1.5 0-2.4 2-6.3 4.5-6.3z"/>',
  // chrome
  'chevron-left': '<path d="M15 5l-7 7 7 7"/>',
  'chevron-right': '<path d="M9 5l7 7-7 7"/>',
};

export function icon(name, title) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon-svg');
  svg.innerHTML = P[name] ?? '<circle cx="12" cy="12" r="6"/>';
  if (title) svg.setAttribute('data-title', title);
  return svg;
}

export const hasIcon = (name) => name in P;

/** Icons offered for character sheet tabs in the system builder. */
export const SHEET_ICONS = ['tower', 'scroll', 'strength', 'wand', 'sparkle', 'wrench', 'star', 'shield', 'sword', 'bow', 'combat',
  'backpack', 'items', 'coin', 'book', 'journal', 'd20', 'heart', 'flame', 'bolt', 'potion', 'eye', 'skull', 'paw', 'clock', 'token', 'settings'];

/** A tab icon as HTML text (for exported sheets). */
export function sheetIconHtml(name) {
  if (!name) return '';
  if (hasIcon(name)) return `<svg class="icon-svg" viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`;
  return `<span class="bp-emoji">${String(name).replace(/[<>&"]/g, '')}</span>`;
}

/** A tab icon: a built-in icon by name, otherwise the text itself (an emoji). */
export function sheetIcon(name) {
  if (!name) return null;
  if (hasIcon(name)) return icon(name);
  const s = document.createElement('span');
  s.className = 'bp-emoji';
  s.textContent = name;
  return s;
}
