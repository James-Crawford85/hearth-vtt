//! Commands the launcher calls. Every command returns `Result<_, String>` so
//! errors show up as readable messages in the UI.

use std::io::Read;
use std::net::ToSocketAddrs;
use std::time::Duration;

use hearth_server::backups::{self, BackupInfo};
use hearth_server::hearth_packages::install;
use hearth_server::hearth_packages::{PackageKind, Registry};
use hearth_server::worlds::{self, WorldEdit, WorldSummary};
use hearth_server::ServerConfig;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

use crate::store::{self, now_ms, JoinedGame, Settings};
use crate::{Desktop, Hosted};

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn errs(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// GitHub "owner/repo" whose published releases the update check looks at.
const UPDATE_REPO: Option<&str> = Some("James-Crawford85/hearth-vtt");
const MAX_DOWNLOAD: u64 = 256 * 1024 * 1024;

// ------------------------------------------------------------------ app & settings

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    worlds_dir: String,
    packages_dir: String,
    backups_dir: String,
    updates_configured: bool,
}

#[tauri::command]
pub fn app_info(state: State<'_, Desktop>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        worlds_dir: state.worlds_dir.display().to_string(),
        packages_dir: state.user_packages.display().to_string(),
        backups_dir: state.backups_dir.display().to_string(),
        updates_configured: UPDATE_REPO.is_some(),
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, Desktop>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(state: State<'_, Desktop>, settings: Settings) -> R<Settings> {
    let mut s = settings;
    s.player_name = s.player_name.trim().chars().take(40).collect();
    if s.port < 1024 {
        return Err("Port must be between 1024 and 65535".into());
    }
    s.keep_auto_backups = s.keep_auto_backups.clamp(1, 100);
    store::save(&state.settings_file(), &s)?;
    *state.settings.lock().unwrap() = s.clone();
    Ok(s)
}

#[tauri::command]
pub fn open_folder(app: AppHandle, state: State<'_, Desktop>, which: String, world_id: Option<String>) -> R<()> {
    let path = match which.as_str() {
        "worlds" => state.worlds_dir.clone(),
        "packages" => state.user_packages.clone(),
        "backups" => match world_id {
            Some(id) => state.backups_for(&id)?,
            None => state.backups_dir.clone(),
        },
        _ => return Err("unknown folder".into()),
    };
    std::fs::create_dir_all(&path).map_err(err)?;
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(err)
}

#[derive(Serialize)]
pub struct UpdateInfo {
    configured: bool,
    current: String,
    latest: Option<String>,
    url: Option<String>,
    available: bool,
    /// The update can be downloaded and installed from inside the app.
    can_install: bool,
    /// Release notes, when the updater provides them.
    notes: Option<String>,
}

/// Compare `1.2.3` style versions (ignores a leading `v` and pre-release tags).
fn newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v').split(['-', '+']).next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
    };
    parse(latest) > parse(current)
}

/// Check for an update. Prefers Tauri's signed updater (one-click install,
/// picks the right file for this OS); falls back to the GitHub releases API,
/// which can only point the user at the release page.
#[tauri::command]
pub async fn check_update(app: AppHandle, state: State<'_, Desktop>) -> R<UpdateInfo> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let release_page = |v: &str| UPDATE_REPO.map(|r| format!("https://github.com/{r}/releases/tag/v{}", v.trim_start_matches('v')));
    match app.updater().map_err(err) {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => {
                let info = UpdateInfo {
                    configured: true,
                    current,
                    latest: Some(update.version.clone()),
                    url: release_page(&update.version),
                    available: true,
                    can_install: true,
                    notes: update.body.clone().filter(|b| !b.trim().is_empty()),
                };
                *state.pending_update.lock().unwrap() = Some(update);
                return Ok(info);
            }
            Ok(None) => {
                *state.pending_update.lock().unwrap() = None;
                let url = release_page(&current);
                return Ok(UpdateInfo { configured: true, latest: Some(current.clone()), current, url, available: false, can_install: false, notes: None });
            }
            // e.g. the latest release predates the updater and has no latest.json
            Err(e) => tracing::info!("updater check failed, falling back to GitHub API: {e}"),
        },
        Err(e) => tracing::warn!("updater unavailable: {e}"),
    }
    github_latest(current).await
}

/// Download, verify and install the update found by `check_update`, then
/// relaunch. Progress is sent to the launcher as `update-progress` events.
#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, Desktop>) -> R<()> {
    let update = state.pending_update.lock().unwrap().take().ok_or("Check for updates first")?;
    // The installer replaces the running app; save and stop any hosted world first.
    state.stop().await?;
    let progress = app.clone();
    let finished = app.clone();
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update-progress", serde_json::json!({ "downloaded": downloaded, "total": total }));
            },
            move || {
                let _ = finished.emit("update-progress", serde_json::json!({ "installing": true }));
            },
        )
        .await;
    if let Err(e) = result {
        return Err(format!("Update failed: {e}"));
    }
    // Windows: the installer has already taken over and restarts Hearth itself.
    // macOS/Linux: the new files are in place; start them.
    app.restart();
}

async fn github_latest(current: String) -> R<UpdateInfo> {
    let none = |current: String, configured: bool| UpdateInfo {
        configured,
        current,
        latest: None,
        url: None,
        available: false,
        can_install: false,
        notes: None,
    };
    let Some(repo) = UPDATE_REPO else {
        return Ok(none(current, false));
    };
    let api = format!("https://api.github.com/repos/{repo}/releases/latest");
    let body: Option<serde_json::Value> = tokio::task::spawn_blocking(move || {
        let resp = ureq::get(&api)
            .set("User-Agent", "hearth-desktop")
            .set("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(10))
            .call();
        match resp {
            Ok(r) => r.into_json::<serde_json::Value>().map(Some).map_err(err),
            // GitHub answers 404 until a release is *published* (drafts don't count).
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(ureq::Error::Status(403 | 429, _)) => {
                Err("GitHub is rate-limiting update checks; try again in a few minutes".to_string())
            }
            Err(ureq::Error::Status(code, _)) => Err(format!("GitHub answered with status {code}")),
            Err(ureq::Error::Transport(_)) => Err("Couldn't reach GitHub. Are you online?".to_string()),
        }
    })
    .await
    .map_err(err)??;
    let Some(body) = body else {
        return Ok(none(current, true));
    };
    let latest = body["tag_name"].as_str().map(str::to_string);
    let url = body["html_url"].as_str().map(str::to_string);
    let available = latest.as_deref().is_some_and(|l| newer(l, &current));
    Ok(UpdateInfo { configured: true, current, latest, url, available, can_install: false, notes: None })
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> R<()> {
    if !url.starts_with("https://") {
        return Err("only https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

// ------------------------------------------------------------------ worlds

#[derive(Serialize)]
pub struct WorldsView {
    hosted: Vec<WorldSummary>,
    joined: Vec<JoinedGame>,
}

#[tauri::command]
pub fn list_worlds(state: State<'_, Desktop>) -> WorldsView {
    let mut joined: Vec<JoinedGame> = store::load(&state.joined_file());
    joined.sort_by(|a, b| b.last_joined.cmp(&a.last_joined));
    WorldsView { hosted: worlds::list(&state.worlds_dir), joined }
}

#[tauri::command]
pub fn create_world(state: State<'_, Desktop>, name: String, system: String, description: String) -> R<WorldSummary> {
    let w = worlds::create(&state.worlds_dir, &name, &system).map_err(errs)?;
    if description.trim().is_empty() {
        return Ok(w);
    }
    let dir = worlds::dir_for(&state.worlds_dir, &w.id).map_err(errs)?;
    worlds::update(&dir, WorldEdit { name: w.name, description, modules: vec![], theme: None, next_session: None })
        .map_err(errs)
}

#[tauri::command]
pub async fn update_world(state: State<'_, Desktop>, id: String, edit: WorldEdit) -> R<WorldSummary> {
    state.ensure_stopped(&id, "change its settings").await?;
    let dir = worlds::dir_for(&state.worlds_dir, &id).map_err(errs)?;
    worlds::update(&dir, edit).map_err(errs)
}

/// Delete a world. A final backup is kept so it can be restored.
#[tauri::command]
pub async fn delete_world(state: State<'_, Desktop>, id: String) -> R<()> {
    state.ensure_stopped(&id, "delete it").await?;
    let dir = worlds::dir_for(&state.worlds_dir, &id).map_err(errs)?;
    backups::create(&dir, &state.backups_for(&id)?, "deleted").map_err(errs)?;
    std::fs::remove_dir_all(dir).map_err(err)
}

#[derive(Serialize)]
pub struct HostInfo {
    world_id: String,
    world_name: String,
    port: u16,
    local_url: String,
    lan_url: Option<String>,
    gm_key: String,
}

pub fn host_info(h: &Hosted, lan: bool) -> HostInfo {
    let port = h.server.addr.port();
    HostInfo {
        world_id: h.world_id.clone(),
        world_name: h.server.world_name.clone(),
        port,
        local_url: format!("http://127.0.0.1:{port}/"),
        lan_url: if lan { hearth_server::lan_ip().map(|ip| format!("http://{ip}:{port}/")) } else { None },
        gm_key: h.server.gm_key.clone(),
    }
}

/// Drop automatic backups beyond the configured number.
fn prune_auto(dir: &std::path::Path, keep: usize) {
    for b in backups::list(dir).into_iter().filter(|b| b.label == "auto").skip(keep) {
        let _ = backups::delete(dir, &b.file);
    }
}

#[tauri::command]
pub async fn host_world(state: State<'_, Desktop>, id: String) -> R<HostInfo> {
    let settings = state.settings.lock().unwrap().clone();
    let mut hosted = state.hosted.lock().await;
    if let Some(h) = hosted.as_ref() {
        if h.world_id == id && !h.server.is_finished() {
            return Ok(host_info(h, settings.allow_network));
        }
    }
    // One world at a time: stop whatever was running first.
    if let Some(h) = hosted.take() {
        h.server.stop().await.map_err(errs)?;
    }
    let world_dir = worlds::dir_for(&state.worlds_dir, &id).map_err(errs)?;
    if !world_dir.join("world.json").is_file() {
        return Err(format!("world '{id}' not found"));
    }
    if settings.backup_on_launch {
        let dir = state.backups_for(&id)?;
        match backups::create(&world_dir, &dir, "auto") {
            Ok(_) => prune_auto(&dir, settings.keep_auto_backups),
            Err(e) => tracing::warn!("automatic backup failed: {e:#}"),
        }
    }
    let server = hearth_server::start(ServerConfig {
        world_dir,
        package_dirs: state.package_dirs(),
        web_dir: state.web_dir.clone(),
        host: if settings.allow_network { "0.0.0.0".into() } else { "127.0.0.1".into() },
        port: settings.port,
        new_world_system: String::new(),
        new_world_name: None,
    })
    .await
    .map_err(errs)?;
    let h = Hosted { world_id: id, server };
    let info = host_info(&h, settings.allow_network);
    *hosted = Some(h);
    Ok(info)
}

#[tauri::command]
pub async fn stop_world(state: State<'_, Desktop>) -> R<()> {
    state.stop().await
}

#[tauri::command]
pub async fn hosting(state: State<'_, Desktop>) -> R<Option<HostInfo>> {
    let lan = state.settings.lock().unwrap().allow_network;
    let mut hosted = state.hosted.lock().await;
    if hosted.as_ref().is_some_and(|h| h.server.is_finished()) {
        *hosted = None;
    }
    Ok(hosted.as_ref().map(|h| host_info(h, lan)))
}

// ------------------------------------------------------------------ joined games

fn normalize_address(raw: &str) -> R<tauri::Url> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let mut url: tauri::Url = with_scheme.parse().map_err(|_| "That doesn't look like an address".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Address must start with http:// or https://".into());
    }
    if url.host_str().is_none() {
        return Err("Missing host name".into());
    }
    // An http address typed without a port means Hearth's default port, not 80.
    let authority = with_scheme.split("://").nth(1).unwrap_or("").split(['/', '?', '#']).next().unwrap_or("");
    let host_end = authority.rfind(']').map_or(0, |i| i + 1); // skip IPv6 brackets
    let has_port = authority[host_end..].contains(':');
    if url.scheme() == "http" && !has_port {
        let _ = url.set_port(Some(30080));
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// Ask the server what world it's running (best effort).
fn fetch_info(url: &tauri::Url) -> Option<serde_json::Value> {
    ureq::get(url.join("api/info").ok()?.as_str())
        .timeout(Duration::from_secs(4))
        .call()
        .ok()?
        .into_json()
        .ok()
}

#[derive(Serialize)]
pub struct JoinTarget {
    url: String,
    game: JoinedGame,
}

/// Check the server answers, remember it in the joined list and return where to go.
#[tauri::command]
pub async fn join_game(state: State<'_, Desktop>, address: String, player_name: String) -> R<JoinTarget> {
    let player_name = player_name.trim().to_string();
    if player_name.is_empty() {
        return Err("Enter your name first".into());
    }
    let url = normalize_address(&address)?;
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(30080);

    let probe_url = url.clone();
    let info = tokio::task::spawn_blocking(move || -> R<Option<serde_json::Value>> {
        let addrs: Vec<_> = format!("{host}:{port}")
            .to_socket_addrs()
            .map_err(|_| format!("Couldn't find '{host}'"))?
            .collect();
        let reachable = addrs.iter().any(|a| std::net::TcpStream::connect_timeout(a, Duration::from_secs(4)).is_ok());
        if !reachable {
            return Err(format!("No Hearth server answered at {host}:{port}"));
        }
        Ok(fetch_info(&probe_url))
    })
    .await
    .map_err(err)??;

    let file = state.joined_file();
    let mut list: Vec<JoinedGame> = store::load(&file);
    let address = url.to_string();
    let world_name = info.as_ref().and_then(|i| i["world"].as_str()).map(str::to_string);
    let system = info.as_ref().and_then(|i| i["system"].as_str()).unwrap_or_default().to_string();
    let game = match list.iter_mut().find(|g| g.address == address) {
        Some(g) => {
            g.player_name = player_name;
            g.last_joined = now_ms();
            if let Some(n) = world_name {
                g.name = n;
            }
            if !system.is_empty() {
                g.system = system;
            }
            g.clone()
        }
        None => {
            let g = JoinedGame {
                id: hearth_server::worlds::slug(&address),
                name: world_name.unwrap_or_else(|| url.host_str().unwrap_or("Game").to_string()),
                address: address.clone(),
                player_name,
                system,
                last_joined: now_ms(),
            };
            list.push(g.clone());
            g
        }
    };
    store::save(&file, &list)?;
    Ok(JoinTarget { url: address, game })
}

#[tauri::command]
pub fn forget_joined(state: State<'_, Desktop>, id: String) -> R<()> {
    let file = state.joined_file();
    let mut list: Vec<JoinedGame> = store::load(&file);
    list.retain(|g| g.id != id);
    store::save(&file, &list)
}

// ------------------------------------------------------------------ backups

#[tauri::command]
pub fn list_backups(state: State<'_, Desktop>, world_id: String) -> R<Vec<BackupInfo>> {
    Ok(backups::list(&state.backups_for(&world_id)?))
}

#[tauri::command]
pub async fn create_backup(state: State<'_, Desktop>, world_id: String) -> R<BackupInfo> {
    // If the world is live, flush it to disk first so the backup is current.
    if let Some(h) = state.hosted.lock().await.as_ref().filter(|h| h.world_id == world_id) {
        h.server.save().await.map_err(errs)?;
    }
    let dir = worlds::dir_for(&state.worlds_dir, &world_id).map_err(errs)?;
    let out = state.backups_for(&world_id)?;
    tokio::task::spawn_blocking(move || backups::create(&dir, &out, "manual")).await.map_err(err)?.map_err(errs)
}

#[tauri::command]
pub async fn restore_backup(state: State<'_, Desktop>, world_id: String, file: String) -> R<()> {
    state.ensure_stopped(&world_id, "restore a backup").await?;
    let dir = worlds::dir_for(&state.worlds_dir, &world_id).map_err(errs)?;
    let out = state.backups_for(&world_id)?;
    tokio::task::spawn_blocking(move || backups::restore(&dir, &out, &file)).await.map_err(err)?.map_err(errs)
}

#[tauri::command]
pub fn delete_backup(state: State<'_, Desktop>, world_id: String, file: String) -> R<()> {
    backups::delete(&state.backups_for(&world_id)?, &file).map_err(errs)
}

/// Worlds that were deleted but still have backups (so they can be brought back).
#[tauri::command]
pub fn deleted_worlds(state: State<'_, Desktop>) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(&state.backups_dir) else { return vec![] };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|id| !state.worlds_dir.join(id).join("world.json").is_file())
        .collect();
    out.sort();
    out
}

// ------------------------------------------------------------------ packages

#[derive(Serialize)]
pub struct PackageCard {
    id: String,
    kind: PackageKind,
    name: String,
    version: String,
    description: String,
    authors: Vec<String>,
    license: Option<String>,
    systems: Vec<String>,
    /// "bundled" ships with Hearth; "installed" was added by the user.
    source: &'static str,
    /// Names of hosted worlds using this package.
    used_by: Vec<String>,
}

#[tauri::command]
pub fn list_packages(state: State<'_, Desktop>) -> Vec<PackageCard> {
    let (reg, errors) = Registry::load_all(&state.package_dirs());
    for e in errors {
        tracing::warn!("package skipped: {e}");
    }
    let worlds = worlds::list(&state.worlds_dir);
    reg.packages
        .values()
        .map(|p| {
            let m = &p.manifest;
            let used_by = worlds
                .iter()
                .filter(|w| w.system == m.id || w.modules.contains(&m.id) || w.theme.as_deref() == Some(&m.id))
                .map(|w| w.name.clone())
                .collect();
            PackageCard {
                id: m.id.clone(),
                kind: m.kind,
                name: m.name.clone(),
                version: m.version.clone(),
                description: m.description.clone(),
                authors: m.authors.clone(),
                license: m.license.clone(),
                systems: m.systems.clone(),
                source: if p.dir.starts_with(&state.user_packages) { "installed" } else { "bundled" },
                used_by,
            }
        })
        .collect()
}

#[derive(Serialize)]
pub struct Installed {
    id: String,
    name: String,
    kind: PackageKind,
    version: String,
}

fn installed(m: hearth_server::hearth_packages::Manifest) -> Installed {
    Installed { id: m.id, name: m.name, kind: m.kind, version: m.version }
}

/// Download a package `.zip` from a URL and install it.
#[tauri::command]
pub async fn install_package_url(state: State<'_, Desktop>, url: String) -> R<Installed> {
    let url = url.trim().to_string();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Enter a link to a .zip file (https://…)".into());
    }
    let dest = state.user_packages.clone();
    tokio::task::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .set("User-Agent", "hearth-desktop")
            .timeout(Duration::from_secs(120))
            .call()
            .map_err(|e| format!("Download failed: {e}"))?;
        let mut bytes = Vec::new();
        resp.into_reader().take(MAX_DOWNLOAD + 1).read_to_end(&mut bytes).map_err(err)?;
        if bytes.len() as u64 > MAX_DOWNLOAD {
            return Err("That download is too large".to_string());
        }
        install::install_zip(&bytes, &dest).map(installed).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Pick a package `.zip` from disk and install it.
#[tauri::command]
pub async fn install_package_file(app: AppHandle, state: State<'_, Desktop>) -> R<Option<Installed>> {
    let dest = state.user_packages.clone();
    tokio::task::spawn_blocking(move || {
        let Some(picked) = app.dialog().file().set_title("Install a Hearth package").add_filter("Hearth package", &["zip"]).blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(err)?;
        let bytes = std::fs::read(&path).map_err(err)?;
        install::install_zip(&bytes, &dest).map(|m| Some(installed(m))).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn uninstall_package(state: State<'_, Desktop>, id: String) -> R<()> {
    if !state.user_packages.join(&id).join("hearth.toml").is_file() {
        return Err("Only packages you installed can be removed; built-in ones ship with Hearth".into());
    }
    install::uninstall(&state.user_packages, &id).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        let n = |s: &str| normalize_address(s).unwrap().to_string();
        assert_eq!(n("192.168.1.20"), "http://192.168.1.20:30080/");
        assert_eq!(n("192.168.1.20:4000"), "http://192.168.1.20:4000/");
        assert_eq!(n("http://example.com:30080/game?x#y"), "http://example.com:30080/");
        assert_eq!(n("https://dnd.example.com"), "https://dnd.example.com/");
        assert_eq!(n("http://host:80"), "http://host/");
        assert_eq!(n("[::1]"), "http://[::1]:30080/");
        assert!(normalize_address("ftp://x").is_err());
    }

    #[test]
    fn versions() {
        assert!(newer("v0.2.0", "0.1.9"));
        assert!(newer("1.0.0", "0.9.9"));
        assert!(!newer("v0.1.0", "0.1.0"));
        assert!(!newer("0.1.0-beta", "0.1.0"));
    }
}
