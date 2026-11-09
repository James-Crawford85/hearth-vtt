// Dice Tray: a minimal example module.
export default function init(hearth) {
  const { el } = hearth.ui;
  for (const d of [4, 6, 8, 10, 12, 20, 100]) {
    hearth.ui.chatControls.append(el('button', {
      text: `d${d}`,
      title: `Roll 1d${d} (shift: GM only)`,
      on: { click: (e) => hearth.roll(`1d${d}`, { gmOnly: e.shiftKey }) },
    }));
  }
  hearth.ui.chatControls.append(el('button', {
    text: 'Adv', title: '2d20, keep highest',
    on: { click: (e) => hearth.roll('2d20kh1', { flavor: 'Advantage', gmOnly: e.shiftKey }) },
  }));
}
