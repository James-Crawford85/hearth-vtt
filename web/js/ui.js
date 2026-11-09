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
  node.style.left = `${Math.min(80 + n * 24, innerWidth - width - 360)}px`;
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
