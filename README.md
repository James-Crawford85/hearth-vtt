# Hearth

[![CI](https://github.com/James-Crawford85/hearth-vtt/actions/workflows/ci.yml/badge.svg)](https://github.com/James-Crawford85/hearth-vtt/actions/workflows/ci.yml)

**A free, open-source virtual tabletop written in Rust.**
The desktop app hosts your world (or joins someone else's); players join from the app or any browser. Game systems, modules and themes are plain folders or zip files, with no paywall, no license key and no lock-in.

> Status: early prototype (v0.1). The core loop works: scenes, tokens, actors, sheets, chat, dice, packages. See the [roadmap](#roadmap).

**Download:** installers for Windows, macOS and Linux are on the [Releases page](https://github.com/James-Crawford85/hearth-vtt/releases). Builds aren't code-signed yet, so Windows SmartScreen will warn you: choose *More info → Run anyway*.

## Features

- **Fast Rust server** (Tokio + Axum) with real-time sync over WebSockets. The server is authoritative: it validates every change, rolls every die, and hides what players shouldn't see.
- **Browser client, no install for players.** Plain ES modules, no build step.
- **Board:** pan/zoom canvas, square grid with snapping, background images, tokens, hidden tokens, measuring ruler, pings.
- **Actors and items** with system-defined types and data templates.
- **Sheets:** HTML templates with two-way binding and roll buttons, or a fully custom JS renderer, or an auto-generated form if the system defines nothing.
- **Dice engine:** `4d6dl1`, `2d20kh1 + @abilities.dex.mod`, `3d6!`, `2d6r1`, `4dF`, `d%`, arithmetic, and variables pulled from actor data.
- **Chat:** `/r`, `/gmr` (private to GM), `/w name` whispers.
- **Walls, vision and fog of war:** the GM draws walls (solid, terrain, invisible, ethereal, windows) and doors (normal or secret) from the left controls. With vision on, players see only what their tokens can see; walls and closed doors block sight and movement (movement is checked on the server). With fog of war, explored areas stay visible but dimmed and are remembered per player. Doors open with a click; the GM can lock them.
- **Lighting and day/night:** each scene has a darkness level (scene settings, or the Day / Night button fades between day and night). The GM places lights (click for a torch, drag to set the reach; plain or coloured, switchable on/off), and tokens can carry light and have darkvision (right-click a token for its settings). At night, players see only lit areas and what their darkvision reaches, and light stops at walls.
- **Drawings:** rectangles, ellipses, polygons, freehand lines and text, from the Drawing tools on the left. Everyone can draw; players can move, restyle (line colour and width, fill, text and size) and delete their own drawings, the GM all of them.
- **Journal:** notes, handouts and lore in folders, written in Markdown with an optional image. Link entries with `[[Entry name]]` and add roll buttons with `[[/r 1d20 + 3]]`. The GM chooses who sees each entry (hidden, name only, read, or read and edit, for everyone or per player) and can pop an entry up on players' screens with **Show to players**. Players never receive entries they can't see.
- **Items directory:** a library of items built from the system's item types, in folders. Share them with players (all or per player) and drag one onto an actor's sheet to give them a copy.
- **Rollable tables:** results with weights (paste a list to fill one quickly). The server rolls and posts the result in chat. Players can roll on tables the GM shares, and the GM can roll privately.
- **Macros and hotbar:** chat macros (`/r 1d20 + 5 # Attack`) for everyone; script macros with the full client API for the GM, who can share them. Ten hotbar slots per player along the bottom: drag a macro onto a slot, then click it or press 1–0.
- **Collections:** content libraries. Systems and modules ship packs (d20 Lite comes with weapons, a small bestiary and a rules reference); the GM browses them, previews entries and imports copies into the world. The GM can also build world collections from their own actors, items, journal entries, tables and macros, and share them with players. Players can drag items from shared collections onto their characters.
- **Playlists and ambient sound:** the GM uploads audio into playlists (in order, shuffled, or all at once) and plays them for everyone, in sync, even for players who join late. Ambient sounds placed on the map loop and get louder as tokens approach; walls muffle them. The GM can preview what a spot sounds like. Every player sets their own music, ambience and map-sound volume.
- **Combat tracker:** start an encounter from the scene's tokens, roll initiative with the system's formula (GM for NPCs, players for their own characters), step through turns and rounds, mark combatants defeated or hidden. The active token glows on the board and players are told when it's their turn.
- **Player accounts:** the GM adds players (Settings → Players) with a temporary password. Players pick their name on the join page; on first login they choose their own password. Passwords are stored as Argon2 hashes, separately from the world data. The join page also shows the world description, the next session and who's online.
- **Packages:**
  - **System builder:** design a system inside Hearth as a tree of stats, resources, lists, rolls and item types, with formulas connecting them. It saves as you go and sheets update live. Start from a blank system or a copy of another (launcher → Game Systems). Classes, ancestries and backgrounds give features through grants (items, choices, ability points, hit-point rolls), with a level-up dialog that can also undo a level ([docs/builder.md](docs/builder.md)).
  - **Systems** define the rules: actor/item types, sheets, and declared rules worked out on the server: formulas, lookup tables, resources that reset on rests, actions (attack, then damage, with advantage and crits), item effects and conditions ([docs/rules.md](docs/rules.md)). Anything beyond that goes in sandboxed [Rhai](https://rhai.rs) scripts.
  - **Modules** add features through a hook-based client API and/or server scripts.
  - **Themes** are just CSS that override design tokens.
- **Plain-file worlds:** `worlds/<name>/world.json` plus an `assets/` folder. Easy to back up, diff or move.

## Two ways to run it

**Desktop app (recommended for GMs).** Like other desktop VTTs, the app *is* the server. Pick a world and press **Launch**: Hearth starts hosting it and opens it for you as GM. The launcher shows the address to give your players. Players can join with the same app (**Join a game**) or from any browser. Press ⌂ in a game to go back to the launcher; a hosted world keeps running until you press **Stop** or quit.

The launcher has four tabs:

| Tab | What it does |
|---|---|
| **Game Worlds** | Your worlds (Launch, Edit name/description/modules/theme, Backups, Delete) and games you've joined (saved so you can rejoin in one click). |
| **Game Systems** | Installed systems. Install more from a link to a `.zip` or from a file. |
| **Add-on Modules** | Installed modules and themes, installed the same way. Turn them on per world with **Edit**. |
| **Settings** | Your name, hosting port, network access, automatic backups, update checks, data folders. |

**Backups:** each world can be backed up on demand, and automatically on every launch (the last 5 automatic ones are kept by default). Restoring first backs up the current state. Deleting a world keeps a final backup, so a deleted world can be brought back.

**Standalone server (for always-on or headless hosting).** Run the `hearth` binary on a PC, home server or VPS; everyone joins from a browser or the app.

## Quick start

Requires [Rust](https://rustup.rs) 1.80+.

Desktop app (on Linux/WSL, first install the [Tauri system libraries](https://v2.tauri.app/start/prerequisites/)):

```bash
cargo run -p hearth-desktop
```

Worlds live in the app data folder (`%APPDATA%\org.hearthvtt.desktop\worlds` on Windows, `~/.local/share/org.hearthvtt.desktop/worlds` on Linux). Drop extra systems, modules and themes into the `packages` folder next to it. The launcher shows both paths.

Standalone server:

```bash
cargo run --release -p hearth-server -- --world worlds/my-campaign --system d20-lite
```

The server prints the URL and the **GM key**. Open `http://localhost:30080`, enter your name and the GM key. Players open `http://<your-ip>:30080` and join with just a name.

| Flag | Default | |
|---|---|---|
| `--world` | `worlds/default` | World folder (created if missing) |
| `--system` | `d20-lite` | System for a *new* world |
| `--packages` | `packages` | Package folder (repeatable; later folders win) |
| `--web` | `web` | Web client folder |
| `--host` / `--port` | `0.0.0.0` / `30080` | Use `--host 127.0.0.1` to keep it local |

To play over the internet, forward the port on your router, or use a tunnel (Tailscale, ZeroTier, Cloudflare Tunnel, etc.).

### Controls

| | |
|---|---|
| Drag token | Move (snaps to grid) |
| Drag empty space / right-drag | Pan |
| Wheel | Zoom |
| Ctrl-drag | Measure distance |
| Double-click token | Open sheet |
| Double-click empty | Ping everyone |
| Arrow keys | Nudge selected tokens |
| `H` / `Delete` (GM) | Hide/show / delete selected tokens |
| Drag actor from sidebar (GM) | Place a token (hold Alt for hidden) |
| Right-click token (GM) | Token settings: name, size, colour, image, hidden, darkvision, carried light |
| Lighting tools (GM) | Place light: click for a torch or drag to set its reach. Select lights: drag to move, double-click to configure, right-click to switch on/off, `Delete` removes |
| Sound tools (GM) | Place sound: click where it plays. Select sounds: drag to move, double-click to configure, right-click to switch on/off, `Delete` removes. Preview: hear from the mouse pointer |
| Drawing tools | Drag a rectangle, ellipse or freehand line; click polygon corners (Enter, double-click or the first corner finishes, Esc cancels); click to place text |
| Select drawings | Drag to move, double-click to restyle, `Delete` removes |

## Project layout

```
crates/
  hearth-dice       dice parser + roller (no deps beyond rand)
  hearth-core       world model, ops, merge-patch, wire protocol
  hearth-packages   package manifests, registry, Rhai script host
  hearth-server     server library + the `hearth` binary: HTTP, WebSocket, persistence
  hearth-desktop    Tauri desktop app: launcher, hosts worlds in-process, joins others
web/                browser client (vanilla ES modules), shared by browser and app
tools/              make-icons.mjs (regenerates the app icons)
packages/
  d20-lite          example system: abilities, derived mods, weapons, crit flags
  freeform          minimal system: manifest only, auto-generated sheet
  dice-tray         example module: quick-roll buttons
  hp-bars           example module: draws on the board
  theme-parchment   example theme
docs/
```

## Making things

- **A new game system:** copy `packages/freeform`, change the `id`, and edit the template. That's a working system. Then add a sheet and rules as needed. See [docs/packages.md](docs/packages.md) and [docs/sheets.md](docs/sheets.md).
- **A module:** see [docs/client-api.md](docs/client-api.md) and the two example modules.
- **A theme:** one CSS file overriding the variables in [web/css/core.css](web/css/core.css).

How it works under the hood: [docs/architecture.md](docs/architecture.md).

## Development

```bash
cargo test --workspace
cargo run -p hearth-server
```

The web client and packages are served straight from disk, so edit and refresh. No rebuild needed.

**Windows note:** if builds fail with *"An Application Control policy has blocked this file"*, Windows Smart App Control is blocking Cargo's build scripts. Build inside WSL, in a dev container, or turn Smart App Control off.

## Roadmap

- [x] Desktop app that hosts or joins a world
- [ ] Signed Windows/macOS/Linux installers built by GitHub Actions
- [x] Player accounts with their own passwords; per-player access (limited/observer/owner) for journal, items, tables and collections
- [ ] Invite links
- [x] Walls, vision and fog of war
- [x] Dynamic lighting and day/night
- [x] Drawings
- [ ] Hex grids, templates (cones, circles)
- [x] Combat tracker / initiative
- [x] Journals
- [x] Items directory, roll tables, macros and hotbar
- [x] Collections (content packs)
- [x] Audio playlists and ambient sound
- [ ] WebAssembly plugins for heavier server-side logic
- [ ] Package browser: install systems/modules from a git URL
- [x] Multi-world launcher and world backups

## License

MIT. See [LICENSE](LICENSE). Example packages carry their own license field.

## Releasing

On Windows, double-click **`release.bat`** (or run it from a terminal). It checks that you're on an up-to-date, clean `main` branch, asks for the version, sets it in `Cargo.toml` and `tauri.conf.json`, then commits, tags `vX.Y.Z` and pushes.

By hand on any OS:

1. Set the version: `powershell -File tools/set-version.ps1 0.2.0` (or edit `Cargo.toml` `[workspace.package]` and `crates/hearth-desktop/tauri.conf.json`), then run `cargo update --workspace`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. The **Release** workflow builds installers and server bundles for every platform into a draft release. Review it on GitHub and press **Publish**. Desktop apps then see the update.

### In-app updates

The desktop app updates itself: **Update now** downloads the right installer for the user's system from the latest published release, verifies it, installs it and restarts. This relies on:

- an **updater signing key**, created once with `cargo tauri signer generate -w ~/.tauri/hearth-updater.key`. Its public half is `plugins.updater.pubkey` in `crates/hearth-desktop/tauri.conf.json`;
- two **repository secrets** (Settings → Secrets and variables → Actions): `TAURI_SIGNING_PRIVATE_KEY` (the contents of the key file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The Release workflow refuses to run without them;
- the `latest.json` file the workflow attaches to each release, which tells apps which file to download.

Keep a backup of the key file and its password. If either is lost, installed apps can't verify new updates and everyone has to reinstall once by hand.

Building installers locally needs the key too: set `TAURI_SIGNING_PRIVATE_KEY` to the key file's path (and the password variable) before `cargo tauri build`.
