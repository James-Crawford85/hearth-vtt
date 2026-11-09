use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use hearth_core::World;

use crate::state::AppState;

const WORLD_FILE: &str = "world.json";
const KEY_FILE: &str = "gm.key";

pub fn load_or_create(dir: &Path, system: &str, name: Option<&str>) -> anyhow::Result<World> {
    let file = dir.join(WORLD_FILE);
    if file.is_file() {
        let text = std::fs::read_to_string(&file).with_context(|| format!("reading {}", file.display()))?;
        let world: World = serde_json::from_str(&text).with_context(|| format!("parsing {}", file.display()))?;
        tracing::info!(name = %world.name, system = %world.system, "loaded world");
        return Ok(world);
    }
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let name = name
        .map(str::to_string)
        .or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "New World".into());
    let world = World::new(name, system);
    write_atomic(&file, &serde_json::to_vec_pretty(&world)?)?;
    tracing::info!(name = %world.name, system, "created new world");
    Ok(world)
}

/// Read the GM key, generating one on first run.
pub fn gm_key(dir: &Path) -> anyhow::Result<String> {
    let file = dir.join(KEY_FILE);
    if let Ok(k) = std::fs::read_to_string(&file) {
        let k = k.trim().to_string();
        if !k.is_empty() {
            return Ok(k);
        }
    }
    let key = format!("{}{}", hearth_core::new_id(), hearth_core::new_id());
    std::fs::write(&file, &key).context("writing gm.key")?;
    Ok(key)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub async fn save_now(state: &AppState) -> anyhow::Result<()> {
    let bytes = {
        let world = state.world.read().await;
        serde_json::to_vec_pretty(&*world)?
    };
    let path = state.world_dir.join(WORLD_FILE);
    tokio::task::spawn_blocking(move || write_atomic(&path, &bytes)).await??;
    Ok(())
}

pub async fn autosave(state: Arc<AppState>, every: Duration) {
    let mut tick = tokio::time::interval(every);
    loop {
        tick.tick().await;
        if state.dirty.swap(false, Ordering::AcqRel) {
            if let Err(e) = save_now(&state).await {
                state.dirty.store(true, Ordering::Release);
                tracing::error!("autosave failed: {e:#}");
            }
        }
    }
}
