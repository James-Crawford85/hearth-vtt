//! Small JSON files in the app data folder: settings and joined games.

use std::path::Path;

use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Name used when hosting or joining.
    pub player_name: String,
    /// Port used when hosting a world.
    pub port: u16,
    /// Let other devices on the network join hosted worlds (bind 0.0.0.0)
    /// instead of only this computer (127.0.0.1).
    pub allow_network: bool,
    /// Check GitHub for a newer version when the launcher opens.
    pub check_updates: bool,
    /// Make a backup automatically each time a world is launched.
    pub backup_on_launch: bool,
    /// Automatic backups kept per world (older automatic ones are pruned).
    pub keep_auto_backups: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            player_name: String::new(),
            port: 30080,
            allow_network: true,
            check_updates: true,
            backup_on_launch: true,
            keep_auto_backups: 5,
        }
    }
}

/// A game hosted by someone else, saved so it can be rejoined in one click.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinedGame {
    pub id: String,
    /// Display name (the world's name when we could read it, else the host).
    pub name: String,
    pub address: String,
    pub player_name: String,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub last_joined: u64,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
