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
- **Packages:**
  - **Systems** define the rules: actor/item types, sheets, server-side rules in sandboxed [Rhai](https://rhai.rs) scripts.
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
- [ ] Per-player passwords / invite links; finer permissions (limited/observer)
- [ ] Walls, dynamic lighting and fog of war
- [ ] Hex grids, drawings, templates (cones, circles)
- [ ] Combat tracker / initiative
- [ ] Journals, roll tables, compendium packs
- [ ] Audio playlists
- [ ] WebAssembly plugins for heavier server-side logic
- [ ] Package browser: install systems/modules from a git URL
- [ ] Multi-world launcher and world backups

## License

MIT. See [LICENSE](LICENSE). Example packages carry their own license field.

## Releasing

On Windows, double-click **`release.bat`** (or run it from a terminal). It checks that you're on an up-to-date, clean `main` branch, asks for the version, sets it in `Cargo.toml` and `tauri.conf.json`, then commits, tags `vX.Y.Z` and pushes.

By hand on any OS:

1. Set the version: `powershell -File tools/set-version.ps1 0.2.0` (or edit `Cargo.toml` `[workspace.package]` and `crates/hearth-desktop/tauri.conf.json`), then run `cargo update --workspace`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. The **Release** workflow builds installers and server bundles for every platform into a draft release. Review it on GitHub and press **Publish**. Desktop apps then see the update.
