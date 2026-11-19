// This player's own look for the client, kept in this browser (not the world):
// the Glass style turns the sidebar, tool panels and windows into frosted glass
// so the map shows through. The CSS lives under `body.glass` in core.css and is
// driven by --glass-tint, --glass-alpha and --glass-blur.

import { el } from './ui.js';

const KEY = 'hearth.appearance';
const DEFAULTS = { glass: false, tint: '#1f2127', strength: 55, blur: 14 };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}
function save(a) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* storage blocked: kept for this visit only */ }
}

/** A light tint needs dark text to stay readable. */
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

let current = load();

export function appearance() { return { ...current }; }

export function applyAppearance(a = current) {
  const body = document.body;
  if (!body) return;
  body.classList.toggle('glass', !!a.glass);
  body.classList.toggle('glass-light', !!a.glass && isLight(a.tint));
  const s = body.style;
  if (a.glass) {
    s.setProperty('--glass-tint', a.tint);
    s.setProperty('--glass-alpha', `${Math.max(5, Math.min(95, Number(a.strength) || DEFAULTS.strength))}%`);
    s.setProperty('--glass-blur', `${Math.max(0, Math.min(40, Number(a.blur) || 0))}px`);
  } else {
    for (const p of ['--glass-tint', '--glass-alpha', '--glass-blur']) s.removeProperty(p);
  }
}

export function setAppearance(patch) {
  current = { ...current, ...patch };
  save(current);
  applyAppearance();
}

/** The Appearance section of the Settings tab. */
export function appearanceSettings() {
  const a = current;
  const wrap = el('div.appearance');
  const opts = el('div.appearance-opts', { hidden: !a.glass });
  const value = (text) => el('span.appearance-val.muted', { text });
  const strengthVal = value(`${a.strength}%`);
  const blurVal = value(`${a.blur}px`);
  const tint = el('input', { type: 'color', value: a.tint, title: 'Glass colour',
    on: { input: (e) => setAppearance({ tint: e.target.value }) } });
  const strength = el('input', { type: 'range', min: 5, max: 95, step: 1, value: a.strength, title: 'How much colour the glass has (more is easier to read)',
    on: { input: (e) => { strengthVal.textContent = `${e.target.value}%`; setAppearance({ strength: Number(e.target.value) }); } } });
  const blur = el('input', { type: 'range', min: 0, max: 40, step: 1, value: a.blur, title: 'How much the map behind is blurred',
    on: { input: (e) => { blurVal.textContent = `${e.target.value}px`; setAppearance({ blur: Number(e.target.value) }); } } });
  opts.append(
    el('div.appearance-row', {}, el('span', { text: 'Colour' }), tint,
      el('button.small', { type: 'button', text: 'Reset', title: 'Back to the default glass',
        on: { click: () => {
          setAppearance({ tint: DEFAULTS.tint, strength: DEFAULTS.strength, blur: DEFAULTS.blur });
          tint.value = DEFAULTS.tint; strength.value = DEFAULTS.strength; blur.value = DEFAULTS.blur;
          strengthVal.textContent = `${DEFAULTS.strength}%`; blurVal.textContent = `${DEFAULTS.blur}px`;
        } } })),
    el('div.appearance-row', {}, el('span', { text: 'Tint' }), strength, strengthVal),
    el('div.appearance-row', {}, el('span', { text: 'Blur' }), blur, blurVal));
  wrap.append(
    el('label.check', {}, el('input', { type: 'checkbox', checked: !!a.glass,
      on: { change: (e) => { setAppearance({ glass: e.target.checked }); opts.hidden = !e.target.checked; } } }),
    el('span', { text: 'Glass: see-through frosted panels and windows' })),
    opts,
    el('p.hint.muted', { text: 'Only changes how Hearth looks for you, on this browser.' }));
  return wrap;
}

applyAppearance();
