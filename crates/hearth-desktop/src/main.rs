//! Hearth desktop app.
//!
//! One window, two modes:
//! * **Host** – runs a Hearth server in-process for one of your worlds, then
//!   opens it as GM. Players join from their browser or their own app.
//! * **Join** – opens someone else's Hearth server; joined games are saved so
//!   they can be rejoined later.
//!
//! The launcher (`ui/`) is the only page with access to the app's commands.
//! Game pages are ordinary web pages served by a Hearth server; an injected
//! script just adds a "back to launcher" button to them.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod store;

use std::path::PathBuf;

use hearth_server::RunningServer;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;

use crate::store::Settings;

pub struct Hosted {
    pub world_id: String,
    pub server: RunningServer,
}

pub struct Desktop {
    pub data_dir: PathBuf,
    pub worlds_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub user_packages: PathBuf,
    pub bundled_packages: PathBuf,
    pub web_dir: PathBuf,
    pub settings: std::sync::Mutex<Settings>,
    pub hosted: Mutex<Option<Hosted>>,
    /// Update found by the last check, ready to install.
    pub pending_update: std::sync::Mutex<Option<tauri_plugin_updater::Update>>,
}

impl Desktop {
    pub fn package_dirs(&self) -> Vec<PathBuf> {
        vec![self.bundled_packages.clone(), self.user_packages.clone()]
    }

    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn joined_file(&self) -> PathBuf {
        self.data_dir.join("joined.json")
    }

    pub fn backups_for(&self, world_id: &str) -> Result<PathBuf, String> {
        hearth_server::worlds::dir_for(&self.backups_dir, world_id).map_err(|e| e.to_string())
    }

    pub async fn stop(&self) -> Result<(), String> {
        if let Some(h) = self.hosted.lock().await.take() {
            h.server.stop().await.map_err(|e| format!("{e:#}"))?;
        }
        Ok(())
    }

    /// Fail with a clear message if `world_id` is the world being hosted.
    pub async fn ensure_stopped(&self, world_id: &str, action: &str) -> Result<(), String> {
        let hosted = self.hosted.lock().await;
        if hosted.as_ref().is_some_and(|h| h.world_id == world_id && !h.server.is_finished()) {
            return Err(format!("Stop the world before you {action}."));
        }
        Ok(())
    }
}

/// Injected into every page. On game pages it adds a button back to the launcher.
fn home_button_script(launcher: &str) -> String {
    format!(
        r#"(function () {{
  var LAUNCHER = {launcher:?};
  if (location.href.indexOf(LAUNCHER) === 0) return;
  window.__HEARTH_DESKTOP__ = {{ launcher: LAUNCHER }};
  function add() {{
    if (document.getElementById('hearth-desktop-home')) return;
    var b = document.createElement('button');
    b.id = 'hearth-desktop-home';
    b.textContent = '⌂';
    b.title = 'Back to the Hearth launcher (the world keeps running)';
    b.setAttribute('aria-label', b.title);
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;width:40px;height:40px;' +
      'border-radius:8px;border:1px solid #3a3e4a;background:#1f2127;color:#e8e6e1;font-size:20px;' +
      'cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.4)';
    b.onclick = function () {{ location.href = LAUNCHER; }};
    document.body.appendChild(b);
  }}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
}})();"#
    )
}

/// Bundled web client and packages: next to the executable in an installed
/// build, or straight from the source tree when running with `cargo run`.
fn resource(app: &tauri::App, name: &str) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(name);
        if p.is_dir() {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(name)
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,hearth=debug".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let settings: Settings = store::load(&data.join("settings.json"));
            let desktop = Desktop {
                worlds_dir: data.join("worlds"),
                backups_dir: data.join("backups"),
                user_packages: data.join("packages"),
                bundled_packages: resource(app, "packages"),
                web_dir: resource(app, "web"),
                settings: std::sync::Mutex::new(settings),
                hosted: Mutex::new(None),
                pending_update: std::sync::Mutex::new(None),
                data_dir: data.clone(),
            };
            for d in [&desktop.worlds_dir, &desktop.backups_dir, &desktop.user_packages] {
                std::fs::create_dir_all(d)?;
            }
            tracing::info!(data = %data.display(), web = %desktop.web_dir.display(), "desktop paths");
            app.manage(desktop);

            // Same origin the app serves `ui/` from on each platform.
            let launcher = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Hearth")
                .inner_size(1360.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .initialization_script(&home_button_script(launcher))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::save_settings,
            commands::open_folder,
            commands::open_url,
            commands::check_update,
            commands::install_update,
            commands::list_worlds,
            commands::create_world,
            commands::update_world,
            commands::delete_world,
            commands::host_world,
            commands::stop_world,
            commands::hosting,
            commands::join_game,
            commands::forget_joined,
            commands::list_backups,
            commands::create_backup,
            commands::restore_backup,
            commands::delete_backup,
            commands::deleted_worlds,
            commands::list_packages,
            commands::install_package_url,
            commands::install_package_file,
            commands::uninstall_package,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Hearth");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Save the hosted world before the process exits.
            let state = handle.state::<Desktop>();
            if let Err(e) = tauri::async_runtime::block_on(state.stop()) {
                tracing::error!("failed to stop world cleanly: {e}");
            }
        }
    });
}
