# Client API

Every package script receives the API as `init(hearth, pkg)`. It's also on `window.Hearth` for the browser console.

## State (read-only, keep in sync automatically)

```js
hearth.world          // the World (scenes, actors, users, chat, settings)
hearth.user           // { id, name, role: 'gm' | 'player', color }
hearth.system         // active system's package info (actor_types, item_types…)
hearth.packages       // { active: [...], available: [...] }
hearth.isGM()
hearth.ownsActor(id)
hearth.actor(id); hearth.scene(id?)   // scene() = active scene
```

Don't mutate these objects. Change things through ops so everyone stays in sync.

## Changing the world

```js
hearth.update.actor(id, { data: { hp: { value: 3 } } })    // merge patch
hearth.update.item(actorId, itemId, patch)
hearth.update.token(sceneId, tokenId, { x: 140, y: 70 })
hearth.update.scene(id, patch)
hearth.update.world(patch)

hearth.create.actor(kind, name, data?)
hearth.create.item(actorId, kind, name, data?)
hearth.create.token(sceneId, { name, x, y, actor_id?, img?, hidden? })

hearth.op({ op: 'token_delete', scene_id, id })   // any op from ops.rs
```

Every `update.*` takes an optional `onReject(reason)` callback.

## System rules: actions, rests, conditions

Systems declare formulas, resources, actions and conditions (see [rules.md](rules.md)); `hearth.rules` holds them. Calculated values are in `actor.derived` (item values in `actor.derived.items[itemId]`).

```js
hearth.actions.list(actor, item)                       // the actions an item (or the actor) has
hearth.actions.use(actorId, itemId, 'attack', { mode: 'advantage' })   // rolled and paid for on the server
hearth.actions.use(actorId, itemId, 'cast', { level: 3 })              // upcast: @cast_level
hearth.rest(actorId, 'long')
hearth.update.actor(actorId, { effects: [...actor.effects, { status: 'poisoned', changes: [] }] })
```

## Rolling and chat

```js
hearth.roll('1d20 + @abilities.dex.mod', { flavor: 'Stealth', actorId, gmOnly: false })
hearth.chat('Hello!')            // also supports /r, /gmr, /w
```

## Hooks

```js
const off = hearth.hooks.on('ready', (hearth) => {})
hearth.hooks.once(name, fn); hearth.hooks.off(name, fn)
```

| hook | args | |
|---|---|---|
| `init` | hearth | after all packages load, once |
| `ready` | hearth | after each (re)connect |
| `op` | op, byUserId | after any op is applied locally |
| `op:<name>` | op, byUserId | e.g. `op:token_update` |
| `presence` | onlineUserIds | |
| `chat:render` | li, message | decorate a chat message |
| `sheet:render` | root, actor, hearth | decorate any sheet |
| `board:view` | scene | the board switched scenes |
| `board:drawBackground` | ctx, scene, board | world-space canvas, under the grid |
| `board:drawToken` | ctx, token, actor, rect, board | after a token is drawn |
| `board:drawOverlay` | ctx, scene, board | above tokens |
| `board:tokenMove` | token, {x, y} | return `false` to block a move |
| `journal:render` | root, entry, hearth | after a journal entry is drawn |
| `combat:turn` | combat, combatant | the active combatant changed (combatant is `null` if hidden from you) |
| `board:tool` | tool | the board tool changed (`select`, `box-select`, `target`, `measure`, `wall-select`, `wall-draw`, `light-select`, `light-draw`, `sound-select`, `sound-place`, `draw-select`, `draw-rect`, `draw-ellipse`, `draw-polygon`, `draw-freehand`, `draw-text`) |

## Walls and vision

Walls live on scenes: `scene.walls[id] = { a: [x, y], b: [x, y], kind, open, locked }`, in scene pixels. `kind` is `wall`, `terrain`, `invisible`, `ethereal`, `door`, `secret_door` or `window`; `wallRules(wall)` in `web/js/vision.js` says what each blocks (movement, sight, sound). Scene vision settings are `scene.vision = { enabled, fog, range }`.

```js
hearth.op({ op: 'wall_create', scene_id, wall: { id: '', a: [0, 0], b: [700, 0], kind: 'wall' } })
hearth.op({ op: 'wall_update', scene_id, id, patch: { open: true } })   // players: unlocked doors only
hearth.op({ op: 'wall_delete', scene_id, id })
hearth.update.scene(sceneId, { vision: { enabled: true, fog: true, range: 60 } })
hearth.op({ op: 'fog_reset', scene_id })
```

### Lighting

`scene.darkness` runs from 0 (day) to 1 (night); the board fades between values over a couple of seconds. Lights live on scenes: `scene.lights[id] = { x, y, bright, dim, color, off }`, with radii in the scene's distance units (e.g. feet) and `color` `null` for plain light. Tokens can carry light (`token.light = { bright, dim, color }`, or `null`) and see in the dark to `token.sight` (darkvision). Light is blocked by the same walls as sight.

At darkness 0.5 or more, players' tokens see only what is in line of sight *and* either lit or within the token's own `sight` (a token always sees its own square). Below 0.5 they see by daylight. Lights, darkness and token light are GM-only.

```js
hearth.op({ op: 'light_create', scene_id, light: { id: '', x: 350, y: 350, bright: 20, dim: 40, color: null, off: false } })
hearth.op({ op: 'light_update', scene_id, id, patch: { off: true } })
hearth.op({ op: 'light_delete', scene_id, id })
hearth.update.scene(sceneId, { darkness: 1 })
hearth.update.token(sceneId, tokenId, { sight: 60, light: { bright: 20, dim: 40, color: '#ffb347' } })
```

`hearth.board.isDark()` says whether the scene is past the halfway point, and `hearth.board.litAt({ x, y })` whether a point is lit.

On the board, `hearth.board.visionLimited()` says whether the current user's view is limited, `hearth.board.sources` holds their line-of-sight polygons, and `hearth.board.tokenVisible(token)` says whether a token is in sight. The server refuses player moves that cross a wall or closed door.

## Drawings

Drawings live on scenes: `scene.drawings[id] = { kind, author, x, y, w, h, points, stroke, stroke_width, fill, fill_alpha, text, font_size }`, in scene pixels. `kind` is `rect`, `ellipse`, `polygon`, `freehand` or `text`. Rectangles and ellipses use `x, y, w, h`; polygons and freehand lines use `points` (`[[x, y], …]`, relative to `x, y`); text has its top-left corner at `x, y`. `fill` is a colour or `null`.

```js
hearth.op({ op: 'drawing_create', scene_id, drawing: { id: '', kind: 'rect', x: 140, y: 140, w: 210, h: 140, stroke: '#e0a040', fill: '#e0a040' } })
hearth.op({ op: 'drawing_update', scene_id, id, patch: { x: 280 } })
hearth.op({ op: 'drawing_delete', scene_id, id })
```

Everyone can draw. The server sets `author` to whoever created the drawing; players can change or delete only their own drawings, the GM can change any. Drawings sit under tokens, so fog and line of sight hide them like the map.

## Journal

Entries live in `hearth.world.journal[id] = { name, folder, content, img, access, players }`. `content` is Markdown (`# heading`, `**bold**`, `*italic*`, lists, `> quote`, `---`, `[text](url)`, `![alt](url)`), plus `[[Entry name]]` or `[[Entry name|label]]` links (to a journal entry, else an actor) and `[[/r 1d20 + 2]]` roll buttons. It's rendered without HTML, so entries can't inject markup.

Who sees an entry: `access` applies to every player, `players[userId]` raises it for one player. Levels: `none` (hidden), `limited` (name and image), `observer` (read), `owner` (read and edit). The server only sends players what they may see; limited entries arrive with empty `content`.

```js
hearth.journal.open(id)            // open an entry (if you can see it)
hearth.journal.byName('The Keep')  // find an entry you can see
hearth.journal.access(entry)       // your level for an entry
hearth.journal.show(id)            // GM: pop it up for every player who can see it
hearth.op({ op: 'journal_create', entry: { id: '', name: 'Notes', folder: 'Lore', content: '', access: 'none', players: {} } })   // GM
hearth.op({ op: 'journal_update', id, patch: { content: '…' } })   // owners: name, folder, img, content only
hearth.op({ op: 'journal_delete', id })                              // GM
```

The `journal:render` hook (`root, entry, hearth`) runs after an entry is drawn, for modules that decorate entries.

## Items directory

Library items (not owned by an actor) live in `hearth.world.items[id]`: an item (`name, kind, img, data, flags`) plus `folder`, `access` and `players`, with the same access levels as journal entries (limited players get the name and image only). New items start from the system's item template. Dropping one on an actor's sheet gives that actor a copy.

```js
hearth.op({ op: 'library_item_create', item: { id: '', name: 'Longsword', kind: 'weapon', data: {}, flags: {}, folder: 'Weapons', access: 'observer', players: {} } })  // GM
hearth.op({ op: 'library_item_update', id, patch: { data: { damage: '1d8' } } })   // GM
hearth.items.giveTo(actorId, itemId)   // copy onto an actor you own
```

## Rollable tables

`hearth.world.tables[id] = { name, folder, description, results: [{ text, weight }], access, players }`. Rolling uses a die the size of the total weight; each result covers `weight` numbers in order (weight 0 never comes up). The server rolls and posts the result to chat (the message has `flags.core.table`).

```js
hearth.tables.draw(id)                     // players: tables they can read
hearth.tables.draw(id, { gmOnly: true })   // whispered to the GM
hearth.tables.byName('Forest Encounters')
hearth.op({ op: 'table_update', id, patch: { results: [{ text: 'Wolves', weight: 3 }, { text: 'Owlbear', weight: 1 }] } })   // GM
```

## Macros and the hotbar

`hearth.world.macros[id] = { name, kind, command, img, author, shared }`. A `chat` macro sends each line as chat (`/r 1d20 + 5` rolls). A `script` macro is JavaScript run in the clicking user's browser as an async function of `(hearth, token, actor)`, where `token`/`actor` belong to the first selected token. Only the GM can write script macros or share macros; players make chat macros of their own and see their own plus shared ones.

Each user's hotbar is `hearth.world.hotbars[userId] = { slot: macroId }` for slots 1–10 (players only receive their own). Drag a macro onto a slot, click or press 1–0 to run it, right-click to clear.

```js
hearth.macros.run(id)
hearth.op({ op: 'macro_create', macro: { id: '', name: 'Attack', kind: 'chat', command: '/r 1d20 + 5 # Attack', img: null, author: '', shared: false } })
hearth.op({ op: 'hotbar_set', user_id: hearth.user.id, slot: 1, macro_id: id })   // macro_id null clears
```

## Collections

World collections are `hearth.world.collections[id] = { name, kind, entries: { id: document }, access, players }` (`kind`: `actor`, `item`, `journal`, `table` or `macro`), shared like journal entries; limited players get no entries. Package packs are listed in `hearth.packages.active[n].packs` and loaded on demand.

```js
await hearth.collections.loadPack('d20-lite', 'weapons')   // → array of documents
hearth.collections.importMany('actor', docs, 'Folder')       // GM: copy into the world
hearth.collections.giveItem(actorId, itemDoc)                // copy an item onto an actor you own
hearth.op({ op: 'collection_create', collection: { id: '', name: 'Loot', kind: 'item', entries: {}, access: 'none', players: {} } })   // GM
hearth.op({ op: 'collection_update', id, patch: { entries: { [entryId]: doc } } })   // null removes an entry
```

## Sound

**Playlists** (`hearth.world.playlists[id] = { name, mode, ambience, sounds: { id: { name, src, volume, repeat, playing, started, sort } } }`). `mode` is `sequential`, `shuffle` or `simultaneous`. Start or stop a track by patching `sounds.<id>.playing`; the server stamps `started` with its clock so everyone (and anyone joining later) hears the same moment. When a non-looping track ends, one GM's client moves the playlist on. GM only.

```js
hearth.audio.playPlaylist(id); hearth.audio.stopPlaylist(id)
hearth.audio.playTrack(playlistId, soundId, true)   // false stops it
hearth.op({ op: 'playlist_update', id, patch: { sounds: { [newId]: { id: newId, name: 'Rain', src: '/assets/rain.ogg', volume: 0.8, repeat: true, sort: 0 } } } })
```

**Ambient sounds** live on scenes: `scene.sounds[id] = { x, y, radius, src, volume, off, walls }`, with `radius` in distance units. They loop; each listener hears them louder the closer they are, and walls that block sound (see `wallRules`) cut them off when `walls` is on. Players listen from their tokens; the GM from their selected tokens, the middle of the view, or (with Preview) the mouse pointer. GM only.

```js
hearth.op({ op: 'sound_create', scene_id, sound: { id: '', x: 350, y: 350, radius: 30, src: '/assets/fire.ogg', volume: 0.8, off: false, walls: true } })
hearth.audio.preview = { x, y }   // GM: listen from a point (null to stop)
hearth.audio.setVolume('music' | 'ambience' | 'environment', 0.5)   // this user's own volume
```

Browsers only play sound after the page has been clicked; if a sound is blocked, a "Click to turn on sound" button appears.

## Combat

```js
hearth.combat.current            // the encounter: { scene_id, round, current, combatants: [...] } or null
hearth.combat.rollInitiative([combatantId, …])   // GM: anyone; players: their own
hearth.combat.next(); hearth.combat.prev()       // players may call next() on their own turn
hearth.op({ op: 'combat_create', combat: { id: '', scene_id, combatants: [{ id: '', token_id }] } })
hearth.op({ op: 'combatant_add', combatant: { id: '', token_id } })   // name/actor filled from the token
hearth.op({ op: 'combatant_update', id, patch: { defeated: true } })
hearth.op({ op: 'combat_start' }); hearth.op({ op: 'combat_end' })
```

Turn order is initiative high→low, then name. The server works out turns and rounds, so every client agrees.

## Messaging between clients

```js
hearth.socket.emit('my-module.ping', { hello: 1 })        // everyone
hearth.socket.emit('my-module.ping', data, [userId])      // only some users
hearth.socket.on('my-module.ping', (payload, fromUserId) => {})
```

Prefix channels with your package id.

## Settings

```js
hearth.settings.get(pkg.id, 'volume')
hearth.settings.set(pkg.id, 'volume', 0.5)      // GM only
```

## UI

```js
hearth.ui.el('div.card#id', { text, html, on: { click } }, ...children)
hearth.ui.toast('Saved!', 'info' | 'error')
const win = hearth.ui.window({ id, title, width })   // { el, body, close(), setTitle(), onClose(fn) }
const values = await hearth.ui.form({ title, fields: [{ name, label, type, value, options }] })
hearth.ui.addTool({ icon: '🎲', title: 'Dice', onClick, gmOnly })
hearth.ui.addTab({ id, label, render: (panel, hearth) => {}, gmOnly })
hearth.ui.chatControls     // element above the chat input
hearth.board               // the Board (view(sceneId), invalidate(), ping(x, y), cam, selected)
await hearth.upload(file)  // GM only, returns the asset URL
```

## Selection and targets

`hearth.board.selected` is the set of selected token ids (click, Shift-click, or the Box selection tool). `hearth.targets` lists the tokens this user has targeted with the Target tool; everyone sees target markers in the targeting user's colour. The `targets:change` hook fires with the new list when you change your targets.
