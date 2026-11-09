// d20 Lite client script: highlight natural 20s and 1s flagged by rules.rhai.
export default function init(hearth, pkg) {
  hearth.hooks.on('chat:render', (li, message) => {
    const flags = message.flags?.[pkg.id];
    if (flags?.crit) li.classList.add('d20-crit');
    if (flags?.fumble) li.classList.add('d20-fumble');
  });
}
