// Party loot: one pile the party shares (settings.core.loot, kept by the server; see
// AppState::loot). Members put items and coins in, give or buy things out (buying pays
// the item's sell value into the pile, so when it's split they get their share back),
// sell where the GM has opened a market, and split the coins evenly.

import { store, isGM, ownsActor, systemInfo } from './store.js';
import { el, toast, formDialog } from './ui.js';
import { DOC_MIME } from './collections.js';

const ITEM_MIME = 'application/x-hearth-item';

export class Loot {
  constructor(api) {
    this.api = api;
    this.info = null; // { money, members } from the server
    this.seq = 0;
  }

  pile() {
    return store.world?.settings?.core?.loot ?? {};
  }

  async call(body) {
    const res = await fetch('/api/loot', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hearth-session': this.api.session ?? '' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  /** Do something to the pile; problems show as a toast. */
  async act(body) {
    try { await this.call(body); return true; } catch (e) { toast(e.message, 'error'); return false; }
  }

  // ------------------------------------------------------------------ money

  coins() { return this.info?.money?.coins ?? [{ key: 'gp', value: 1, payout: true }]; }
  main() { return this.coins().find((c) => c.key === 'gp') ?? this.coins()[0]; }
  total(map = {}) { return this.coins().reduce((s, c) => s + (map[c.key] ?? 0) * c.value, 0); }
  breakdown(amount) {
    const out = {};
    for (const c of this.coins().filter((c) => c.payout)) { out[c.key] = Math.floor(amount / c.value); amount -= out[c.key] * c.value; }
    return out;
  }
  format(amount) {
    const b = this.breakdown(amount);
    return this.coins().filter((c) => b[c.key]).map((c) => `${b[c.key]} ${c.key}`).join(' ') || `0 ${this.main().key}`;
  }
  formatCoins(map = {}) {
    return this.coins().filter((c) => map[c.key]).map((c) => `${map[c.key]} ${c.key}`).join(' ');
  }
  actorCoins(a) {
    let at = a?.data;
    for (const seg of String(this.info?.money?.path ?? 'currency').split('.').filter(Boolean)) at = at?.[seg];
    return Object.fromEntries(this.coins().map((c) => [c.key, Math.floor(Number(at?.[c.key]) || 0)]));
  }

  // ------------------------------------------------------------------ the panel

  members() {
    return (this.info?.members ?? []).map((id) => store.world.actors[id]).filter(Boolean);
  }
  mine() {
    return this.members().filter((a) => ownsActor(a.id));
  }

  renderPanel(panel) {
    const mine = ++this.seq;
    // The coins and the party come from the server (the system's currency); draw once they're here.
    this.call({ action: 'info' }).then((info) => {
      if (mine !== this.seq) return;
      this.info = info;
      this.draw(panel);
    }).catch((e) => panel.replaceChildren(el('p.muted', { text: `The loot pile isn't available: ${e.message}` })));
    if (this.info) this.draw(panel);
  }

  draw(panel) {
    const gm = isGM();
    const pile = this.pile();
    const members = this.members();
    const mine = this.mine();
    const total = this.total(pile.coins);
    const n = members.length;
    const share = n ? Math.floor(total / n) : 0;
    const market = !!pile.market;
    const items = pile.items ?? [];

    const head = el('div.loot-coins', {},
      el('div', {}, el('span.muted', { text: 'Coins ' }), el('strong', { text: this.formatCoins(pile.coins) || `0 ${this.main().key}` }),
        total && this.formatCoins(pile.coins) !== this.format(total) ? el('small.muted', { text: ` (${this.format(total)})` }) : null),
      el('div.row', {},
        el('button.primary', {
          text: n ? `Split ${n} ways` : 'Split', disabled: share <= 0,
          title: share > 0 ? `${this.format(share)} each to ${members.map((a) => a.name).join(', ')}; what doesn't divide stays` : 'Not enough to split',
          on: { click: () => { if (confirm(`Split ${this.format(share * n)}: ${this.format(share)} each to ${members.map((a) => a.name).join(', ')}?`)) this.act({ action: 'split' }); } },
        }),
        mine.length || gm ? el('button', { text: '+ Put in…', title: 'Put items or coins from your character into the pile', on: { click: () => this.depositDialog() } }) : null,
        gm ? el('button', { text: '+ Coins', title: 'Add found coins', on: { click: () => this.addCoinsDialog() } }) : null));

    const pct = pile.sell_pct ?? 50;
    const marketRow = gm
      ? el('div.loot-gm', {},
        el('label.check.loot-market', { title: 'While it\'s open, players can sell from the pile' },
          el('input', { type: 'checkbox', checked: market, on: { change: (e) => this.act({ action: 'settings', market: e.target.checked }) } }),
          ' Market open: the party can sell here'),
        el('label.small', { title: 'New loot is valued at this share of its listed cost (items already in the pile keep their value)' }, 'New loot sells for ',
          el('input', { type: 'number', min: 0, max: 1000, value: pct, style: 'width:4.5em', on: { change: (e) => this.act({ action: 'settings', sell_pct: Number(e.target.value) || 0 }) } }),
          '% of its cost'))
      : el('p.small', { class: market ? 'small loot-open' : 'small muted', text: market ? '🏪 The party can sell here.' : 'Nowhere to sell right now.' });

    const party = el('p.small.muted', {},
      `Party: ${members.map((a) => a.name).join(', ') || 'nobody yet'}`,
      gm ? el('button.small.link', { text: ' Change…', on: { click: () => this.membersDialog() } }) : null);

    const sellable = items.filter((it) => it.flags?.core?.loot_value != null);
    const list = el('ul.entity-list.loot-items', {}, items.map((it) => this.itemRow(it, { gm, mine, members, market })));
    const sellAll = (market || gm) && sellable.length ? el('button', {
      text: `Sell all (${sellable.length}) for ${this.format(sellable.reduce((s, it) => s + it.flags.core.loot_value, 0))}`,
      title: items.length > sellable.length ? 'Items without a value are kept' : '',
      on: { click: () => { if (confirm(`Sell ${sellable.map((it) => it.name).join(', ')}?`)) this.act({ action: 'sell', item_ids: sellable.map((it) => it.id) }); } },
    }) : null;

    const drop = el('div.loot', {}, head, marketRow, party,
      el('h4', { text: `Items (${items.length})` }),
      items.length ? list : el('p.muted.small', { text: gm ? 'Empty. Drag loot here from search, a collection or the Items tab, or put things in from a character.' : 'Empty. Put things in from your character.' }),
      sellAll ? el('div.row', {}, sellAll) : null,
      el('p.hint.muted', { text: `Buying pays the item's value into the pile, so when it\'s split you get your share back. Values start at ${pct}% of the listed cost; anyone in the party can change them.` }));
    if (gm) {
      drop.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DOC_MIME) || e.dataTransfer.types.includes(ITEM_MIME)) { e.preventDefault(); drop.classList.add('drop-on'); } });
      drop.addEventListener('dragleave', () => drop.classList.remove('drop-on'));
      drop.addEventListener('drop', (e) => {
        drop.classList.remove('drop-on');
        let doc = null;
        try { const d = JSON.parse(e.dataTransfer.getData(DOC_MIME) || 'null'); if (d?.kind === 'item') doc = d.doc; } catch { /* not ours */ }
        const lib = store.world.items?.[e.dataTransfer.getData(ITEM_MIME)];
        if (lib) doc = lib;
        if (!doc) return;
        e.preventDefault();
        const item = structuredClone(doc);
        for (const k of ['folder', 'access', 'players']) delete item[k];
        item.id = '';
        item.effects ??= [];
        item.flags ??= {};
        item.data ??= {};
        this.act({ action: 'add', item });
      });
    }
    panel.replaceChildren(drop);
  }

  itemRow(it, { gm, mine, members, market }) {
    const sys = systemInfo();
    const value = it.flags?.core?.loot_value;
    const qty = Number(it.data?.quantity) > 1 ? ` ×${it.data.quantity}` : '';
    const valueInput = el('input.loot-value', {
      value: value != null ? this.format(value) : '', placeholder: 'value?', size: 9,
      title: 'What it sells for (and what a party member pays to buy it): 7 gp 5 sp, or a plain number of gp',
      on: { change: (e) => this.act({ action: 'value', item_id: it.id, value: e.target.value }) },
    });
    const buy = mine.length ? el('button.small', {
      text: 'Buy', disabled: value == null, title: value == null ? 'Set a value first' : `Pay ${this.format(value)} into the pile for it`,
      on: { click: async () => {
        const who = await this.pickActor(mine, `Buy ${it.name} for ${this.format(value)}`);
        if (who) this.act({ action: 'take', item_id: it.id, actor_id: who, pay: true });
      } },
    }) : null;
    const give = el('button.small', {
      text: 'Give…', title: 'Hand it to someone in the party for free',
      on: { click: async () => {
        const who = await this.pickActor(members, `Give ${it.name} to…`);
        if (who) this.act({ action: 'take', item_id: it.id, actor_id: who, pay: false });
      } },
    });
    const sell = market || gm ? el('button.small', {
      text: 'Sell', disabled: value == null, title: value == null ? 'Set a value first' : `Sell it for ${this.format(value)}`,
      on: { click: () => this.act({ action: 'sell', item_ids: [it.id] }) },
    }) : null;
    return el('li.entity.loot-item', {},
      it.img ? el('img.avatar', { src: it.img, alt: '' }) : el('span.avatar', { text: it.name.charAt(0).toUpperCase() }),
      el('span.grow', {},
        el('a.loot-name', { href: '#', text: `${it.name}${qty}`, on: { click: (e) => { e.preventDefault(); this.api.lookup?.showDoc('item', it, 'Party loot'); } } }),
        el('small.muted', { text: ` ${sys.item_types?.[it.kind]?.label ?? it.kind}` })),
      el('div.loot-actions', {}, valueInput, buy, give, sell),
      gm ? el('button.icon', { title: 'Take it out of the pile (it\'s gone)', text: '✕', on: { click: () => { if (confirm(`Remove ${it.name} from the loot?`)) this.act({ action: 'remove', item_id: it.id }); } } }) : null);
  }

  // ------------------------------------------------------------------ dialogs

  async pickActor(actors, title) {
    if (!actors.length) { toast('Nobody in the party to pick.'); return null; }
    if (actors.length === 1) return confirm(`${title}: ${actors[0].name}?`) ? actors[0].id : null;
    const v = await formDialog({ title, submit: 'OK', fields: [{ name: 'actor', label: 'Who', type: 'select', value: actors[0].id, options: actors.map((a) => [a.id, a.name]) }] });
    return v?.actor ?? null;
  }

  /** Coin inputs, one per coin; `have` shows what's there. */
  coinFields(have) {
    const inputs = {};
    return {
      name: 'coins', type: 'custom', label: 'Coins',
      render: () => el('div.loot-coin-inputs', {}, this.coins().map((c) => el('label', {}, `${c.key}${have ? ` (${have[c.key] ?? 0})` : ''}`,
        (inputs[c.key] = el('input', { type: 'number', min: 0, max: have ? have[c.key] ?? 0 : undefined, value: 0, size: 5 }))))),
      read: () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, Math.max(0, Math.floor(Number(i.value) || 0))]).filter(([, n]) => n > 0)),
    };
  }

  async depositDialog() {
    const actors = isGM() ? this.members() : this.mine();
    if (!actors.length) { toast('You need a character in the party.'); return; }
    let actorId = actors[0].id;
    if (actors.length > 1) {
      actorId = await this.pickActor(actors, 'Put in from…');
      if (!actorId) return;
    }
    const a = store.world.actors[actorId];
    // Things you carry (they have a weight or quantity), not class features or spells.
    const gear = (a.items ?? []).filter((it) => !it.advancement?.length && (it.data?.weight != null || it.data?.quantity != null));
    const boxes = {};
    const v = await formDialog({
      title: `Put in from ${a.name}`, submit: 'Put in the pile',
      fields: [
        {
          name: 'items', type: 'custom', label: 'Items',
          render: () => (gear.length ? el('div.loot-pick', {}, gear.map((it) => el('label.check', {},
            (boxes[it.id] = el('input', { type: 'checkbox' })), ` ${it.name}${Number(it.data?.quantity) > 1 ? ` ×${it.data.quantity}` : ''}${it.data?.equipped ? ' (equipped)' : ''}`)))
            : el('p.muted.small', { text: 'Nothing to put in.' })),
          read: () => Object.entries(boxes).filter(([, b]) => b.checked).map(([id]) => id),
        },
        this.coinFields(this.actorCoins(a)),
      ],
    });
    if (!v) return;
    if (!v.items.length && !Object.keys(v.coins).length) return;
    this.act({ action: 'deposit', actor_id: actorId, item_ids: v.items, coins: v.coins });
  }

  async addCoinsDialog() {
    const v = await formDialog({ title: 'Add found coins', submit: 'Add', fields: [this.coinFields(null)] });
    if (v && Object.keys(v.coins).length) this.act({ action: 'add', coins: v.coins });
  }

  async membersDialog() {
    const players = new Set(Object.values(store.world.users ?? {}).filter((u) => u.role !== 'gm' && u.role !== 'Gm').map((u) => u.id));
    const current = new Set(this.info?.members ?? []);
    const actors = Object.values(store.world.actors).filter((a) => !a.flags?.core?.placed)
      .sort((a, b) => Number(current.has(b.id)) - Number(current.has(a.id)) || a.name.localeCompare(b.name));
    const boxes = {};
    const v = await formDialog({
      title: 'Who shares the loot', submit: 'Save',
      fields: [{
        name: 'members', type: 'custom', label: 'Party members',
        render: () => el('div.loot-pick', {}, actors.map((a) => el('label.check', {}, (boxes[a.id] = el('input', { type: 'checkbox', checked: current.has(a.id) })), ` ${a.name}`,
          a.owners?.some((o) => players.has(o)) ? el('small.muted', { text: ' (a player\'s)' }) : null))),
        read: () => Object.entries(boxes).filter(([, b]) => b.checked).map(([id]) => id),
      }],
    });
    if (v) this.act({ action: 'settings', members: v.members });
  }
}
