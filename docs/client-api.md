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
| `combat:turn` | combat, combatant | the active combatant changed (combatant is `null` if hidden from you) |

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
