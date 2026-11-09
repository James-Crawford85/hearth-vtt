// A tiny event bus. Packages subscribe with Hearth.hooks.on(name, fn).
//
// emit(name, ...args)  – notify every handler; errors are logged, not thrown.
// call(name, ...args)  – like emit, but any handler returning `false` cancels
//                        the action and call() returns false.

const handlers = new Map();

function list(name) {
  if (!handlers.has(name)) handlers.set(name, []);
  return handlers.get(name);
}

export const hooks = {
  on(name, fn) {
    list(name).push(fn);
    return () => hooks.off(name, fn);
  },
  once(name, fn) {
    const off = hooks.on(name, (...args) => { off(); return fn(...args); });
    return off;
  },
  off(name, fn) {
    const l = list(name);
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  },
  emit(name, ...args) {
    for (const fn of [...list(name)]) {
      try { fn(...args); } catch (e) { console.error(`[hearth] hook "${name}" failed`, e); }
    }
  },
  call(name, ...args) {
    for (const fn of [...list(name)]) {
      try { if (fn(...args) === false) return false; }
      catch (e) { console.error(`[hearth] hook "${name}" failed`, e); }
    }
    return true;
  },
};
