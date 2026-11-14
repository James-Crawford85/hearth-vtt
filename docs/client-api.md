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
| `board:tool` | tool | the board tool changed (`select`, `box-select`, `target`, `measure`, `grid-align`, `wall-select`, `wall-draw`, `light-select`, `light-draw`, `sound-select`, `sound-place`, `draw-select`, `draw-rect`, `draw-ellipse`, `draw-polygon`, `draw-freehand`, `draw-text`) |

**A board tool of your own.** `hearth.board.registerTool(id, handler)` gives a tool its own left clicks, drags, keys and drawing while it's selected (`hearth.board.setTool(id)`). Right-drag still pans and the wheel still zooms. Everything is optional, and positions are scene pixels:

```js
hearth.board.registerTool('my-tool', {
  cursor: 'crosshair',
  enter() {}, leave() {},           // selected / deselected
  down(w, e) {}, move(w, e) {}, up(w, e) {},
  key(e) { return false; },         // true: the key was used
  draw(ctx, board) {},              // after everything else, in scene coordinates
});
```

## The map and the grid

The grid always starts at the scene's top-left corner, with squares of `scene.grid.size` pixels. A map placed on a scene has `scene.background_fit = { x, y, sx, sy }`: its top-left corner (may be negative, to crop) and its scale on each axis. The board draws it there, cut to the scene.

A map can be an image or a video (MP4 or WebM) for an animated map. A video plays muted and looped, each player's copy on its own clock; only the scene on screen plays. Each player can pause animation with **Animated maps** in the token tools, which leaves a still frame and saves battery on slower computers.

**Importing a ready-made map.** **Import map…** in the Scenes tab makes a scene from a map exported by Dungeon Alchemist, Dungeondraft and similar tools, grid, walls, doors and lights included:

- **Foundry-style scene JSON** (Dungeon Alchemist's export, beside its PNG or MP4): choose the JSON and the map. Walls become Hearth's wall kinds by what they block: movement and sight make a wall; movement only, a window (or an invisible wall if it lets sound through); sight only, an ethereal wall; limited sight, terrain; doors and secret doors stay doors, locked or open as exported. Lights keep their ranges (in the scene's units) and their colour when it's tinted. Padding and grid shift are respected. "Global light" keeps the darkness under half, so the whole map stays visible.
- **Universal VTT** (`.dd2vtt`, `.uvtt`): the map image is inside the file. Lines of sight become walls, portals become doors, and light ranges in squares become distances.

Vision is switched on when the map has walls, so players see only what their tokens see.

A map loaded in the scene settings keeps its own size and shape: `{ x: 0, y: 0, sx: 1, sy: 1 }`, never stretched. The scene grows to whole squares around it if it's bigger than the columns and rows chosen, and saving the settings later never crops a placed map. Scenes from before this (no `background_fit`) still stretch their map over the scene as they always did; **Original size** in the alignment tool fixes one in a click.

The GM's **Align the map to the grid** tool (with the token tools) sets it. Drag from a grid corner drawn on the map to the corner a few squares across and down (3 × 3 to start; more is more precise). Then pick:

- **Fit the grid to the map:** the grid's squares become the measured size (rounded to a pixel), and the map is scaled by the small remainder.
- **Fit the map to the grid:** the grid keeps its size, and the map is scaled to it. Better once tokens, walls or drawings are placed, since they stay where they are in pixels.

Either way the map's squares land exactly on the grid's, and the scene grows or shrinks to whole squares around the map. If the measured squares aren't square (a stretched scan), the panel says so and the map is evened out. Arrow keys nudge the far corner (Shift: 10 px), Enter applies, **Undo** takes it back, and **Original size** puts the map back at 1:1 with the scene around it.

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

`scene.darkness` runs from 0 (day) to 1 (night); the board fades between values over a couple of seconds. Lights live on scenes: `scene.lights[id] = { x, y, bright, dim, color, tint?, anim?, off }`, with radii in the scene's distance units (e.g. feet) and `color` `null` for plain light. Tokens can carry light (`token.light = { bright, dim, color, tint?, anim? }`, or `null`) and see in the dark to `token.sight` (darkvision). Light is blocked by the same walls as sight.

A coloured light tints what it reaches, less by day and fully by night; `tint` (0–1, 0.5 when left out) is how strongly. `anim` makes it move: `{ kind, speed, strength }`, `speed` 1 being its usual pace (0.1–5) and `strength` how much it moves (0–1, 0.5 when left out). The kinds are `candle` (candle flicker), `torch`, `campfire` (flicker with embers), `pulse`, `swirl` (swirling energy), `smoke` (glowing smoke), `vortex`, `rays` (radiant rays), `fairy` (fairy lights), `chroma` (shifting colours), `storm` (lightning flashes) and `ghost` (ghostly waver). An animation with no colour glows in a colour of its own. Every client animates lights itself; nothing is sent while they move.

**The light editor.** Double-click a light (or right-click it with Select lights) to edit it: sliders for bright and dim from 0 to 50 (a box beside each takes any other number), the colour and its strength, the animation with its speed and strength, and on or off. The map shows each change as it's made; Save keeps it and Cancel puts it back. A token's settings have the same editor under Carries light, and a light source drawn on the map (a torch, a crystal…) has a Light… button in Select. A light source keeps its light on the prop (`props[id].light = { bright, dim, tint?, anim? }`, in distance units), so drawing the map again keeps it; its colour is its glow part.

At darkness 0.5 or more, players' tokens see only what is in line of sight *and* either lit or within the token's own `sight` (a token always sees its own square). Below 0.5 they see by daylight. Lights, darkness and token light are GM-only.

```js
hearth.op({ op: 'light_create', scene_id, light: { id: '', x: 350, y: 350, bright: 20, dim: 40, color: null, off: false } })
hearth.op({ op: 'light_update', scene_id, id, patch: { off: true } })
hearth.op({ op: 'light_update', scene_id, id, patch: { color: '#7fb0ff', tint: 0.8, anim: { kind: 'swirl', speed: 1.5, strength: 0.7 } } })
hearth.op({ op: 'light_update', scene_id, id, patch: { anim: null } })   // still again
hearth.op({ op: 'light_delete', scene_id, id })
hearth.update.scene(sceneId, { darkness: 1 })
hearth.update.token(sceneId, tokenId, { sight: 60, light: { bright: 20, dim: 40, color: '#ffb347' } })
```

`hearth.board.isDark()` says whether the scene is past the halfway point, and `hearth.board.litAt({ x, y })` whether a point is lit.

On the board, `hearth.board.visionLimited()` says whether the current user's view is limited, `hearth.board.sources` holds their line-of-sight polygons, and `hearth.board.tokenVisible(token)` says whether a token is in sight. The server refuses player moves that cross a wall or closed door.

**See as token (GM).** The eye toggle in Token controls (`hearth.board.seeAs = true`) makes the board show what the selected tokens see, as their player would: their sight, darkness and level, with hidden tokens, secret doors and the GM's wall lines left out, and the fog their players have explored (as of when the GM last loaded the world: exploring isn't sent to the GM as it happens). Select another token to look through it; select none to see everything again. It only changes the GM's own screen, and nothing the GM sees this way counts as explored. `hearth.board.seeing` is the tokens being looked through (else null), and `hearth.board.gmView` is false while it's on.

## Drawings

Drawings live on scenes: `scene.drawings[id] = { kind, author, x, y, w, h, points, stroke, stroke_width, fill, fill_alpha, text, font_size }`, in scene pixels. `kind` is `rect`, `ellipse`, `polygon`, `freehand` or `text`. Rectangles and ellipses use `x, y, w, h`; polygons and freehand lines use `points` (`[[x, y], …]`, relative to `x, y`); text has its top-left corner at `x, y`. `fill` is a colour or `null`.

```js
hearth.op({ op: 'drawing_create', scene_id, drawing: { id: '', kind: 'rect', x: 140, y: 140, w: 210, h: 140, stroke: '#e0a040', fill: '#e0a040' } })
hearth.op({ op: 'drawing_update', scene_id, id, patch: { x: 280 } })
hearth.op({ op: 'drawing_delete', scene_id, id })
```

Everyone can draw. The server sets `author` to whoever created the drawing; players can change or delete only their own drawings, the GM can change any. Drawings sit under tokens, so fog and line of sight hide them like the map.

## Sketched maps

The GM's **Sketch a map** tools paint a map straight onto a scene's grid, for a quick map at the table:

- **Select**: click a prop, door, window, wall or round room. Drag it to move it (doors and windows to another grid edge); its handles resize it and turn it (props) or move a diagonal's ends. Delete removes it, R / Shift+R turn a prop, + and − resize, arrow keys nudge. A bar above the map shows its options: size, turning, whether a prop blocks, a light source on or off, a wall's style, a door's kind. Removing a stretch of a room's wall opens it.
- **Room**: drag a rectangle of floor with walls round it. A one-square-wide room makes a corridor.
- **Round room**: drag from the centre out (half-square steps). Alt makes a round floor without walls, such as a pond; Shift-click one to remove it.
- **Floor**: drag a rectangle of floor without walls, for porches, yards and paths.
- **Brush**: paint floor without walls square by square (`[` and `]` change its size). On a room it changes the floor and keeps the walls, so water or a rug can go inside a room.
- **Erase**: removes floor, round rooms and props under the brush.
- **Wall**: drag along grid lines to add a wall, or corner to corner at an angle for a diagonal. Shift-drag along grid lines takes walls away, a room's own included, to open a side; Shift-click removes a diagonal.
- **Railing**: like Wall, but you see over it (walkways, balconies): it blocks movement, not sight. Shift-drag takes railings away.
- **Door** and **Window**: click a grid edge (Shift for a secret door); click again to remove. Windows block movement but not sight.
- **Copy walls from below** (on an upper level): the level below's walls, doors and windows become walls here, for a hall or tower two storeys tall. Round rooms' walls aren't copied.
- **Roof**: drag a rectangle over a building and pick thatch, wooden shingles, slate or clay tiles in the bar at the top. Players outside see the roof, except where their token's sight reaches in under it (through an open door or a window); a player whose token is under it doesn't (they're inside). The GM sees roofs faintly, and can hide them (**Show roofs** in the Roof tool's bar). Select a roof to move or resize it, change its material or turn its ridge.
- **Place props**, chosen in the **Map props** tab of the sidebar (it opens with the tool): light sources (torch, brazier, campfire, candles, lantern, glowing crystal), each with its own light, and furniture and nature (tables, chairs, benches, beds, bookshelves, barrels, crates, chests, rugs, stairs, pillars, statues, a well, rocks, trees, bushes, rubble). Click one, then click the map, or drag one from the sidebar onto the map; light sources next to a wall go on the wall. Some props can stand in the way: rocks, pillars and statues block movement and sight at first; tables, beds and barrels can be set to block movement. Props are drawn in code (`web/js/sketch-props.js`), so they cost nothing to download. Each has parts that can be recoloured: select it and open **Colours** in the bar, then give a part another colour or a texture (a built-in, an uploaded picture or one made in the texture creator); its shading follows. A light source's **Light** part is the colour of the light it casts too. **Shift+wheel** over a prop (or on the selected one) makes it bigger or smaller (10% a notch; Ctrl+Shift: 2%), **Alt+wheel** turns it 10° a notch and **Shift+Alt+wheel** 1°; with Place props, the same sets the size and turn of the next prop, and a right-click stops placing and goes to Select. Stairs, ladders and trapdoors can lead to another level: select one and pick **Leads to**.

Hold **Ctrl** (Cmd on a Mac) to stop snapping, even partway through a drag: round rooms, props, wall ends, and moving, turning and resizing with Select go exactly where the pointer is (a wall whose ends are off the grid is free-standing, like a diagonal). Shift erases with Room, Floor and Brush, Ctrl+Z undoes.

**The tool bar.** While a sketch tool is on, a bar at the top of the board shows what it uses, and a click on a texture opens a picker. Room and Round room: the floor and the walls; Floor and Brush: the floor (and the brush's size); Wall: the walls; Roof: the roof, and Show roofs; Place props: the prop. Floors: nine built-in textures (stone, wood, tiles, dirt, grass, sand, water, rock, brick), or **Your own…**, an uploaded image that repeats. Walls: **Default** (the sketch's own, from Sketch settings) or a style of their own, which new walls, rooms and round rooms get. With Select, the bar shows what's selected instead.

**The texture creator.** **Textures** in the Sketch menu (the nodes icon, no tool needed), or **New texture…** and ✎ in any texture picker (floor, walls, roof), opens a node editor, like a blueprint. The **Texture** list at the top of its side panel switches between the world's textures (or starts a new one), asking first if there are unsaved changes. Changes show on the map as you make them, on your screen only (`setDraft` in `texture-recipes.js`); **Save** sends them to everyone and keeps the editor open, **Save as new** makes a copy and goes on with that, and closing without saving puts the map back as it was. Each node makes or changes a picture and shows it; drag from a node's output (right) to another node's input (left) to wire them, and the **Output** node is the texture. Right-click the grid (or **Add node**) to add a node there; drag a node by its title; drag a wired input away to unwire it; drag the grid to pan and use the wheel to zoom; ✕ or Delete removes a node. Wires that would make a loop are refused. Drag the Output node's corner to see the texture bigger (the editor keeps its size as `p.view`; it doesn't change the texture).

| Node | Inputs | Settings |
|---|---|---|
| Texture | | a built-in, or **Upload…** a picture of your own (free photo-scanned textures work well); how many squares one copy covers (½ to 8; 2 to start, about right for a 2 m photo-scanned surface) |
| Colour | | a colour |
| Cloud noise | | patch size, detail, pattern (**New pattern**) |
| Levels | mask | cover (how much is white), softness of the edges |
| Invert | in | |
| Scale | in | smaller: 1 to 8 copies across (each 1/n the size, still seamless); turn 90°, 180° or 270° |
| Adjust colour | in | hue, colour, brightness |
| Blend | under, over, mask | mode (normal, multiply, overlay, screen, soft light, darken, lighten), amount |
| Relief | colour, height map, normal map | strength, light from (top left by default, as walls' shadows fall), light height, dark cracks, normal map style (OpenGL or DirectX) |
| Height mask | mask, height map | fills low places first (moss, water, dirt in cracks) or high places first (snow, dust on tops), how closely it follows the height |
| Output | texture | repeats every 8 or 16 squares; map-wide light and dark (how strong, how big the patches are) |

Masks are grey pictures: white is where Blend's top picture shows.

**Repetition, zoomed out.** A picture's resolution is detail, not area: a photo-scanned texture shows about 2 m of ground however many pixels it has, so at its true size it repeats every couple of squares, and everything in a made texture repeats with its tile. Two settings on Output help when you look at a whole map: **Repeats every 16 × 16 squares** doubles the tile (its noise patches and all; it takes four times the memory), and **Map-wide light and dark** lays very large soft patches (16 to 64 squares across) over the floor as it's painted on the map, so they never repeat with the tile and a field of the same texture stops looking like a grid. Bigger Cloud noise patches feeding the masks help too.

**Height maps.** Photo-scanned texture sets (Megascans and the like) come as several pictures of the same surface: its colour (albedo), a height map (grey, white is high) and a normal map. Upload each into its own Texture node at the same size, so they line up. **Relief** lights the colour from the height map (or the normal map, if one is wired: it wins), so stones get lit tops, shaded sides and dark cracks; it works on any picture, so a built-in's own brightness can serve as a rough height map too. **Height mask** bends a mask by the height, so a second texture blended through it gathers in the low places, or on the high ones, the way moss and snow do; a Levels after it sharpens its edge. An ambient occlusion map, where a set has one, goes on with Blend in Multiply. A typical texture: two Textures into a Blend, with Cloud noise → Levels as its mask, then a second Cloud noise blended over it all in Overlay at a low amount to hide the repeat. One copy covers 8 × 8 squares (noise lines up at the edges, so there are no seams), so it repeats far less often than its sources; the preview shows four copies side by side. A changed texture updates on every map that uses it, for everyone.

Only the recipe is stored, in the world, and every client draws the tile from it (`web/js/texture-recipes.js`, whose `NODE_TYPES` lists the nodes). On a map it's the material `tex:<id>`:

```js
world.textures = { id: { id, name: 'Mossy flagstones', recipe: { v: 2, nodes: {
  a:   { type: 'texture', x: 10, y: 10,  p: { src: 'stone', squares: 2 }, in: {} },   // src: a built-in, or an uploaded picture's url
  b:   { type: 'texture', x: 10, y: 230, p: { src: 'grass', squares: 2 }, in: {} },
  n:   { type: 'noise',   x: 10, y: 450, p: { size: 2, detail: 3, seed: 1 }, in: {} },
  l:   { type: 'levels',  x: 170, y: 450, p: { cover: 50, soft: 40 }, in: { in: 'n' } },
  mix: { type: 'blend',   x: 330, y: 200, p: { mode: 'source-over', amount: 100 }, in: { a: 'a', b: 'b', mask: 'l' } },
  out: { type: 'output',  x: 490, y: 200, p: {}, in: { in: 'mix' } },
} } } }
hearth.op({ op: 'texture_set', texture: { id, name, recipe } })   // GM: add or replace
hearth.op({ op: 'texture_delete', id })
```

`in` names, for each input, the node that feeds it (x, y are where the node sits in the editor). Anything missing takes its default, so later versions can add to a recipe without breaking older ones. **Sketch settings** chooses what fills the scene around the floor (a texture, or nothing so a map shows through) whether rooms get walls, and how walls look: an ink line, or stone blocks, brick, wood, cave rock or hedge (any wall, round room or diagonal can have its own style).

A scene's sketch, with positions in grid squares so it follows the grid:

```js
scene.sketch = {
  cells:  { '3,4': 'stone' },                 // room squares: walls along the rooms' edges
  floor:  { '3,5': 'wood' },                  // floor without walls
  edges:  { 'h:3,5': 'door', 'v:7,2': 'open' }, // a square's top (h) or left (v) edge: wall, open, door, secret_door, window
  shapes: { id: { kind: 'circle', x: 12, y: 4, r: 3, material: 'stone', walled: true, wall_style: 'rock' } },
  lines:  { id: { a: [8, 8], b: [11, 11], kind: 'wall', style: 'brick' } },   // walls off the grid lines, corner to corner
  props:  { id: { kind: 'table', x: 4, y: 10.5, rot: 90, scale: 1.25, blocks: false,     // degrees; times its usual size
                  colors: { wood: '#5a3a22' } } },   // parts: a colour, or a texture ('stone', an upload's url, 'tex:<id>')
                                              // stairs, ladders, trapdoors: to: a level id ('' the ground) to lead there
  styles: { 'v:8,9': 'brick' },               // one edge's wall style
  wall_style: 'stone',                        // every other wall's (none: an ink line)
  roofs:  { id: { x: 2, y: 8, w: 6, h: 5, material: 'thatch', ridge: 'h' } },   // squares; ridge along h or v (default: the longer side)
  outside: 'rock', walls: true, size: 70,     // size: the grid size the walls were worked out for
}
```

A material is a built-in id or an image URL. The sketch is drawn over the scene's map and under the grid: floors, rugs and furniture, the walls (an ink line, or a band of texture edged in ink) with their shadow, doors and windows in their frames, then tree tops and light sources. The built-in textures are painted in code (`web/js/sketch-textures.js`), so they cost nothing to download.

Its walls and lights are ordinary walls and lights whose ids start with `sk-` (a prop that stands in the way gets walls round it), so vision, lighting, door icons and movement treat them like any others. Room walls follow the outline of all the rooms together: where a corridor meets a round room, both open into each other. `sketchWalls(sketch, gridSize)` and `sketchLights(sketch, gridSize, distance)` in `web/js/sketch.js` work them out, and one `sketch_update` op (GM only) sends a change with the new walls and lights:

```js
hearth.op({
  op: 'sketch_update', scene_id,
  patch: { cells: { '3,4': 'stone', '5,4': null }, size: 70 },   // null removes an entry; cells: null empties them all
  walls: { 'sk-w-0': { id: 'sk-w-0', a: [210, 280], b: [280, 280], kind: 'wall' } },   // optional
  lights: { 'sk-p-t1': { id: 'sk-p-t1', x: 245, y: 84, bright: 20, dim: 40, color: '#ff9a3c' } },   // optional
})
```

Each level has its own sketch (see Levels below): `level` on the op says which, and its walls, lights and links get ids ending `@level`. `links` (from the props that lead somewhere) work like `walls`.

`walls` and `lights`, when given, replace every `sk-` wall or light on that level (others are left alone). A door that already exists keeps whether it's open or locked, and a light keeps whether it's switched off. When the grid's size changes, the walls and lights are worked out again the next time the GM picks a sketch tool.

## Levels

A scene can have levels besides its ground: floors above it and cellars below. Everything on a scene is on one level: tokens, walls, lights and drawings carry `level` (a level id; missing means the ground), and each level has its own sketch. The background map is the ground's.

```js
scene.levels = [{ id: 'up', name: 'Upper floor', elevation: 1 }]   // > 0 above the ground, < 0 below
scene.ground_name = 'Courtyard'                                       // optional; else "Ground"
scene.level_sketches = { up: { … } }                                  // the ground's is scene.sketch
scene.links = { id: { level: '', poly: [[x, y], …], to: 'up', at: null } }   // scene px; at: where it arrives (else where it stands)
hearth.update.scene(sceneId, { levels: [...] })                       // add, rename, remove (the GM's Levels window does this)
hearth.update.token(sceneId, tokenId, { level: 'up' })                // GM: anywhere; players: only through a link (below)
```

**What you see.** The board shows one level: the GM picks it in the level bar (bottom left; **Levels…** adds, renames and removes them), a player sees the level of their token (the selected one, else any), and a player with tokens on several levels picks between them. `hearth.board.level` is the level shown; `hearth.board.setLevel(id)` (GM) changes it. New tokens, walls, lights and drawings go on the level shown. Walls, lights and vision work on one level at a time: a torch upstairs doesn't light the cellar.

**Looking down.** Where a level has no floor, the levels below show through, dimmed. A player's token looking down through an opening (a walkway round a hall) sees the level below clearly wherever its sight reaches, and the tokens down there. From above the ground, cellars don't show (the ground is in the way); from a cellar, only deeper cellars do.

**Looking up.** The level above's floor without walls (walkways and balconies, painted with Floor or Brush) overhangs the level below: it's drawn over the map there, under the tokens, and tokens standing on it are seen from below when they're in sight. Rooms upstairs (painted with Room) are ceilings and don't show from below.

**Stairs.** A token that ends a move inside a link (a stair, ladder or trapdoor that leads somewhere) goes to the level it leads to, and its owner's view follows. The server only lets players change level from inside a link that leads there, arriving where it leads (or where they stand); walls are checked on the token's own level.

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
