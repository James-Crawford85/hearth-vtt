// DOM helpers, floating windows and toasts.

export function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** el('div.class#id', {attrs, on: {click}}, ...children) */
export function el(spec, props = {}, ...children) {
  const [, tag = 'div', rest = ''] = spec.match(/^([a-z0-9-]*)(.*)$/i);
  const node = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === '.') node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export function toast(message, kind = 'info') {
  const t = el(`div.toast.${kind}`, { text: message });
  document.getElementById('toasts').append(t);
  setTimeout(() => t.classList.add('out'), 3500);
  setTimeout(() => t.remove(), 4000);
}

let zTop = 100;
const windows = new Map();

/**
 * Open (or focus) a floating window.
 * Returns { el, body, close(), setTitle(t), onClose(fn) }.
 */
export function openWindow({ id, title, width = 420, height }) {
  if (id && windows.has(id)) {
    const w = windows.get(id);
    w.el.style.zIndex = ++zTop;
    return w;
  }
  const closeFns = [];
  const titleEl = el('span.window-title', { text: title });
  const body = el('div.window-body');
  const node = el('section.window', { role: 'dialog', 'aria-label': title },
    el('header.window-header', {}, titleEl, el('button.icon', { title: 'Close', text: '✕', on: { click: () => api.close() } })),
    body);
  node.style.width = `${width}px`;
  if (height) node.style.height = `${height}px`;
  const n = windows.size;
  // Cascade new windows, but keep wide ones fully on screen.
  node.style.left = `${Math.max(8, Math.min(80 + n * 24, innerWidth - width - 360, innerWidth - width - 8))}px`;
  node.style.top = `${60 + n * 24}px`;
  node.style.zIndex = ++zTop;
  node.addEventListener('pointerdown', () => { node.style.zIndex = ++zTop; });

  // drag by header
  const header = node.querySelector('header');
  header.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const sx = e.clientX - node.offsetLeft, sy = e.clientY - node.offsetTop;
    header.setPointerCapture(e.pointerId);
    const move = (ev) => {
      node.style.left = `${Math.max(0, Math.min(innerWidth - 80, ev.clientX - sx))}px`;
      node.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - sy))}px`;
    };
    const up = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', up); };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
  });

  // Resize by dragging the right edge, the bottom edge or the corner.
  for (const edge of ['e', 's', 'se']) {
    const grip = el(`div.window-grip.grip-${edge}`, { 'aria-hidden': 'true' });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      node.style.zIndex = ++zTop;
      const r = node.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      grip.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing');
      const move = (ev) => {
        if (edge.includes('e')) node.style.width = `${Math.max(240, Math.min(innerWidth - r.left - 4, r.width + ev.clientX - sx))}px`;
        if (edge.includes('s')) {
          node.style.height = `${Math.max(120, Math.min(innerHeight - r.top - 4, r.height + ev.clientY - sy))}px`;
          node.style.maxHeight = 'none';
        }
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing');
        if (id) rememberSize(id, node);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    node.append(grip);
  }
  if (id) restoreSize(id, node);

  const api = {
    el: node,
    body,
    setTitle(t) { titleEl.textContent = t; },
    onClose(fn) { closeFns.push(fn); },
    close() {
      node.remove();
      if (id) windows.delete(id);
      closeFns.forEach((f) => f());
    },
  };
  document.getElementById('windows').append(node);
  if (id) windows.set(id, api);
  return api;
}

// Windows keep the size you give them, per kind of window ("sheet-…" for all
// actor sheets, "builder", "journal-…"), in this browser.
const SIZE_KEY = 'hearth.windowSizes';
const sizeKind = (id) => String(id).replace(/[-:/][^-:/]*$/, '') || String(id);
function readSizes() {
  try { return JSON.parse(localStorage.getItem(SIZE_KEY) || '{}'); } catch { return {}; }
}
function rememberSize(id, node) {
  const sizes = readSizes();
  sizes[sizeKind(id)] = { w: Math.round(node.offsetWidth), h: node.style.height ? Math.round(node.offsetHeight) : null };
  try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizes)); } catch { /* storage off: sizes just aren't kept */ }
}
function restoreSize(id, node) {
  const s = readSizes()[sizeKind(id)];
  if (!s) return;
  node.style.width = `${Math.min(s.w, innerWidth - 24)}px`;
  if (s.h) { node.style.height = `${Math.min(s.h, innerHeight - 40)}px`; node.style.maxHeight = 'none'; }
  const left = parseFloat(node.style.left) || 0;
  if (left + Math.min(s.w, innerWidth - 24) > innerWidth - 8) node.style.left = `${Math.max(8, innerWidth - Math.min(s.w, innerWidth - 24) - 8)}px`;
}

export function closeWindow(id) {
  windows.get(id)?.close();
}

/** Small promise-based prompt built from form fields. */
export function formDialog({ title, fields, submit = 'Save' }) {
  return new Promise((resolve) => {
    const w = openWindow({ title, width: 360 });
    const form = el('form.form');
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = el('select', { name: f.name }, ...f.options.map(([v, l]) => el('option', { value: v, text: l, selected: v === f.value })));
      } else if (f.type === 'textarea') {
        input = el('textarea', { name: f.name, rows: 4, required: f.required ?? false });
        input.value = f.value ?? '';
      } else if (f.type === 'checkbox') {
        input = el('input', { name: f.name, type: 'checkbox' });
        input.checked = !!f.value;
      } else {
        input = el('input', { name: f.name, type: f.type ?? 'text', value: f.value ?? '', required: f.required ?? false, min: f.min, step: f.step });
      }
      form.append(f.type === 'checkbox' ? el('label.check', {}, input, f.label) : el('label', {}, f.label, input));
    }
    form.append(el('button.primary', { type: 'submit', text: submit }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const input = form.elements[f.name];
        const v = input.value;
        out[f.name] = f.type === 'number' ? Number(v) : f.type === 'checkbox' ? input.checked : v;
      }
      resolved = true;
      w.close();
      resolve(out);
    });
    let resolved = false;
    w.onClose(() => { if (!resolved) resolve(null); });
    w.body.append(form);
    form.querySelector('input,select,textarea')?.focus();
  });
}
