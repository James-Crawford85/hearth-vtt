# Architecture

```
 Browser clients ──WebSocket JSON──▶ hearth-server ──▶ worlds/<w>/world.json
   (web/js)        ◀── applied ops ──   (Axum)        └─ assets/
        │                                 │
        └── GET /packages/<id>/… ◀────────┘  Registry + Rhai ScriptHost
```

## Desktop app

`hearth-desktop` is a [Tauri](https://tauri.app) app. It uses the system web view (WebView2 on Windows, WebKitGTK on Linux, WebKit on macOS), so it stays small and runs the exact same web client as browsers.

```
 ┌──────────── Hearth desktop app ─────────────┐
 │ launcher (ui/)  ──host_world──▶ hearth-server (in-process, :30080)
 │      │                                │      │◀── players: browser or app
 │      └── navigates the window to ─────┘      │
 │          http://127.0.0.1:30080/#join={name,key}
 └─────────────────────────────────────────────┘
```

- `hearth-server` is a library (`start(config) -> RunningServer`, `stop()`), and the `hearth` binary is a thin CLI on top of it. The app calls the same `start`.
- The launcher is the only page that can call app commands. Game pages are ordinary pages from a Hearth server (local or remote) and get no app permissions. An injected script only adds the ⌂ back-to-launcher button.
- The launcher hands the player name and GM key to the game page in the URL *fragment*, which browsers never send to the server. The page moves them to `sessionStorage` and clears the address.
- Packages load from the bundled folder and then the user's `packages` folder, so user copies override bundled ones by id.
- Quitting the app stops the hosted server, which saves the world.

## One world, one document

A `World` (crates/hearth-core/src/model.rs) holds scenes → tokens, actors → items, users, chat and settings. Systems never add Rust types. Their data lives in free-form JSON fields:

- `actor.data` / `item.data`: system data, seeded from the manifest `template`
- `actor.derived`: computed on the server by the system's `prepare_actor` script; clients can't write it
- `flags` on most entities: namespaced storage for modules (`flags["my-module"]`)
- `world.settings[packageId]`: per-package world settings

## Ops

Every change is an `Op` (crates/hearth-core/src/ops.rs), e.g.

```json
{"op": "token_update", "scene_id": "…", "id": "…", "patch": {"x": 140, "y": 210}}
```

Patches are [JSON merge patches](https://datatracker.ietf.org/doc/html/rfc7386): objects merge, `null` deletes. Protected keys (`id`, nested collections, `derived`) are ignored.

The flow for a client change:

1. Client sends `{"type":"op","op":{…},"req":7}`.
2. Server checks **permissions** (GM: anything; players: their own actors and items, and *moving* tokens of actors they own).
3. Server **normalises** it: assigns ids and merges the system template into new actors and items.
4. Server **applies** it to the world, then **fans it out**: each connection gets the op filtered for its user. Hiding a token sends players a `token_delete`; revealing it sends a `token_create`. Whispers only go to their recipients.
5. If an actor changed, its system scripts' `prepare_actor` runs and an `actor_derive` op follows.
6. The client applies the op to its mirror (web/js/store.js mirrors the Rust `apply`) and fires hooks.

On failure the client gets `{"type":"rejected","req":7,"reason":"…"}`.

Ordering: all writes broadcast while holding the world write lock, and a new connection subscribes while holding the read lock. So a snapshot and the op stream after it never miss or duplicate an op.

## Rolls

Rolls always happen on the server (`hearth-dice`), so players can't fake results. `@path` variables resolve against the rolling actor's `derived`, then `data`. Package `on_roll` hooks can attach flags (d20-lite flags crits).

## Persistence

The world is saved as pretty JSON to `world.json` (written to a temp file, then renamed) at most every 2 s when changed, and on Ctrl-C. Uploaded files go to `assets/`.

## Scripting sandbox

Server scripts are [Rhai](https://rhai.rs): pure Rust, no file, network or OS access, and operation, depth and size limits, so a buggy `loop {}` can't hang the server. Script errors are logged and that hook is skipped.

Client scripts are ES modules running in the browser with full page access. Only install client modules you trust, the same as browser extensions.

## Why these choices

- **Vanilla JS client, no bundler:** anyone can write a module with a text editor and hit refresh. A Rust/WASM renderer can replace `board.js` later behind the same API.
- **JSON + merge patch:** one generic op set covers any game system. Easy to debug, easy to mirror in any language.
- **Rhai, with WASM later:** Rhai is easy to write and safe by default. WASM plugins are on the roadmap for heavy logic.
