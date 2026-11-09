//! Listing and creating worlds inside a worlds folder (used by the desktop launcher).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Context;
use hearth_core::World;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct WorldSummary {
    /// Folder name inside the worlds folder.
    pub id: String,
    pub name: String,
    pub description: String,
    pub system: String,
    pub modules: Vec<String>,
    pub theme: Option<String>,
    pub next_session: Option<String>,
    pub players: usize,
    pub actors: usize,
    pub scenes: usize,
    /// Last saved, unix milliseconds.
    pub modified: u64,
}

fn summarize(dir: &Path) -> Option<WorldSummary> {
    let file = dir.join("world.json");
    let text = std::fs::read_to_string(&file).ok()?;
    let world: World = serde_json::from_str(&text).ok()?;
    let modified = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(WorldSummary {
        id: dir.file_name()?.to_string_lossy().into_owned(),
        name: world.name,
        description: world.description,
        system: world.system,
        modules: world.modules,
        theme: world.theme,
        next_session: world.next_session,
        players: world.users.values().filter(|u| u.role != hearth_core::Role::Gm).count(),
        actors: world.actors.len(),
        scenes: world.scenes.len(),
        modified,
    })
}

/// Worlds in `root`, most recently played first.
pub fn list(root: &Path) -> Vec<WorldSummary> {
    let Ok(entries) = std::fs::read_dir(root) else { return vec![] };
    let mut worlds: Vec<WorldSummary> = entries.filter_map(|e| e.ok()).filter_map(|e| summarize(&e.path())).collect();
    worlds.sort_by(|a, b| b.modified.cmp(&a.modified));
    worlds
}

/// A folder-safe id from a display name: "The Lost Mine!" -> "the-lost-mine".
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').chars().take(48).collect::<String>();
    if out.is_empty() { "world".into() } else { out }
}

/// The folder for a world id, refusing anything that isn't a plain folder name.
pub fn dir_for(root: &Path, id: &str) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
        "invalid world id"
    );
    Ok(root.join(id))
}

/// Create a new world and return its summary.
pub fn create(root: &Path, name: &str, system: &str) -> anyhow::Result<WorldSummary> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "world name is required");
    std::fs::create_dir_all(root).context("creating worlds folder")?;
    let base = slug(name);
    let mut id = base.clone();
    let mut n = 2;
    while root.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
    }
    let dir = root.join(&id);
    std::fs::create_dir_all(&dir)?;
    let world = World::new(name, system);
    std::fs::write(dir.join("world.json"), serde_json::to_vec_pretty(&world)?)?;
    summarize(&dir).context("reading new world")
}

/// Changes a GM can make from the launcher while the world isn't running.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct WorldEdit {
    pub name: String,
    pub description: String,
    pub modules: Vec<String>,
    pub theme: Option<String>,
    #[serde(default)]
    pub next_session: Option<String>,
}

/// Apply launcher edits to a stopped world's `world.json`.
pub fn update(dir: &Path, edit: WorldEdit) -> anyhow::Result<WorldSummary> {
    let name = edit.name.trim();
    anyhow::ensure!(!name.is_empty(), "world name is required");
    let file = dir.join("world.json");
    let mut world: World = serde_json::from_str(&std::fs::read_to_string(&file).context("world not found")?)?;
    world.name = name.chars().take(80).collect();
    world.description = edit.description.trim().chars().take(2000).collect();
    world.modules = edit.modules;
    world.theme = edit.theme.filter(|t| !t.is_empty());
    world.next_session = edit.next_session.filter(|s| !s.trim().is_empty());
    let tmp = dir.join("world.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&world)?)?;
    std::fs::rename(tmp, &file)?;
    summarize(dir).context("reading world")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slug("The Lost Mine!"), "the-lost-mine");
        assert_eq!(slug("  ##  "), "world");
        assert_eq!(slug("Ünïcode Örc"), "n-code-rc");
    }

    #[test]
    fn rejects_bad_ids() {
        let root = Path::new("w");
        assert!(dir_for(root, "../etc").is_err());
        assert!(dir_for(root, "a/b").is_err());
        assert!(dir_for(root, "ok-id_2").is_ok());
    }
}
