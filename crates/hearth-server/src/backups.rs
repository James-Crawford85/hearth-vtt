//! World backups: each is a zip of the world folder (world.json, gm.key,
//! assets/…) stored as `<backups>/<world-id>/<YYYY-MM-DD_HH-MM-SS>[-label].zip`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context};
use serde::Serialize;
use zip::write::SimpleFileOptions;

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    /// File name, used as the backup's id.
    pub file: String,
    /// Unix milliseconds.
    pub created: u64,
    pub size: u64,
    /// e.g. "manual", "before-restore", "deleted".
    pub label: String,
}

/// `YYYY-MM-DD_HH-MM-SS` in UTC, without a date library.
fn timestamp(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}_{:02}-{:02}-{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn safe_label(label: &str) -> String {
    label.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect::<String>().to_lowercase()
}

fn valid_file(file: &str) -> bool {
    file.ends_with(".zip") && !file.contains(['/', '\\']) && !file.starts_with('.') && !file.contains("..")
}

fn add_dir(zip: &mut zip::ZipWriter<std::fs::File>, root: &Path, dir: &Path) -> anyhow::Result<()> {
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        // Skip in-progress temp files from autosave.
        if name.ends_with(".tmp") {
            continue;
        }
        let rel = path.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            zip.add_directory(format!("{rel}/"), opts)?;
            add_dir(zip, root, &path)?;
        } else {
            zip.start_file(rel, opts)?;
            let mut f = std::fs::File::open(&path)?;
            std::io::copy(&mut f, zip)?;
        }
    }
    Ok(())
}

/// Zip `world_dir` into `backups_dir`. Returns the new backup.
pub fn create(world_dir: &Path, backups_dir: &Path, label: &str) -> anyhow::Result<BackupInfo> {
    anyhow::ensure!(world_dir.join("world.json").is_file(), "world not found");
    std::fs::create_dir_all(backups_dir)?;
    let label = safe_label(label);
    let base = timestamp(SystemTime::now());
    let mut file = if label.is_empty() { format!("{base}.zip") } else { format!("{base}-{label}.zip") };
    let mut n = 2;
    while backups_dir.join(&file).exists() {
        file = format!("{base}-{label}-{n}.zip");
        n += 1;
    }
    let path = backups_dir.join(&file);
    let tmp = path.with_extension("zip.part");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&tmp)?);
    let res = add_dir(&mut zip, world_dir, world_dir).and_then(|_| {
        zip.finish()?.flush()?;
        Ok(())
    });
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, &path)?;
    info(&path).context("reading new backup")
}

fn info(path: &Path) -> Option<BackupInfo> {
    let meta = std::fs::metadata(path).ok()?;
    let file = path.file_name()?.to_string_lossy().into_owned();
    let created = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // "2026-11-09_10-30-00-before-restore.zip" -> "before-restore"
    let stem = file.trim_end_matches(".zip");
    let label = stem.get(20..).unwrap_or("").to_string();
    Some(BackupInfo { file, created, size: meta.len(), label: if label.is_empty() { "manual".into() } else { label } })
}

/// Backups for one world, newest first.
pub fn list(backups_dir: &Path) -> Vec<BackupInfo> {
    let Ok(entries) = std::fs::read_dir(backups_dir) else { return vec![] };
    let mut v: Vec<BackupInfo> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "zip"))
        .filter_map(|p| info(&p))
        .collect();
    v.sort_by(|a, b| b.file.cmp(&a.file));
    v
}

pub fn path_of(backups_dir: &Path, file: &str) -> anyhow::Result<PathBuf> {
    if !valid_file(file) {
        bail!("invalid backup name");
    }
    let p = backups_dir.join(file);
    anyhow::ensure!(p.is_file(), "backup not found");
    Ok(p)
}

pub fn delete(backups_dir: &Path, file: &str) -> anyhow::Result<()> {
    std::fs::remove_file(path_of(backups_dir, file)?)?;
    Ok(())
}

/// Replace `world_dir` with the contents of a backup. The world must not be
/// running. The current state is backed up first (label `before-restore`).
pub fn restore(world_dir: &Path, backups_dir: &Path, file: &str) -> anyhow::Result<()> {
    let zip_path = path_of(backups_dir, file)?;
    if world_dir.join("world.json").is_file() {
        create(world_dir, backups_dir, "before-restore")?;
    }
    let parent = world_dir.parent().context("world folder has no parent")?;
    let staging = parent.join(format!(".restoring-{}", hearth_core::new_id()));
    let res = (|| -> anyhow::Result<()> {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&zip_path)?)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let Some(rel) = entry.enclosed_name() else { bail!("backup contains an unsafe path") };
            let out = staging.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)?;
                continue;
            }
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p)?;
            }
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            std::fs::write(out, buf)?;
        }
        let text = std::fs::read_to_string(staging.join("world.json")).context("backup has no world.json")?;
        serde_json::from_str::<hearth_core::World>(&text).context("backup's world.json is invalid")?;
        // Swap folders: current -> .old, staging -> world, then drop .old.
        let old = parent.join(format!(".replaced-{}", hearth_core::new_id()));
        if world_dir.exists() {
            std::fs::rename(world_dir, &old)?;
        }
        if let Err(e) = std::fs::rename(&staging, world_dir) {
            let _ = std::fs::rename(&old, world_dir);
            return Err(e.into());
        }
        let _ = std::fs::remove_dir_all(old);
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps() {
        let t = UNIX_EPOCH + std::time::Duration::from_secs(1_794_239_725);
        assert_eq!(timestamp(t), "2026-11-09_15-55-25");
        // Leap day.
        assert_eq!(timestamp(UNIX_EPOCH + std::time::Duration::from_secs(1_709_208_000)), "2024-02-29_12-00-00");
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01_00-00-00");
    }

    #[test]
    fn backup_and_restore_roundtrip() {
        let root = std::env::temp_dir().join(format!("hearth-backup-{}", hearth_core::new_id()));
        let world = root.join("worlds/w");
        let backups = root.join("backups/w");
        std::fs::create_dir_all(world.join("assets")).unwrap();
        let w = hearth_core::World::new("Test", "freeform");
        std::fs::write(world.join("world.json"), serde_json::to_vec(&w).unwrap()).unwrap();
        std::fs::write(world.join("assets/map.png"), b"png").unwrap();

        let b = create(&world, &backups, "manual").unwrap();
        assert_eq!(b.label, "manual");

        // Change the world, then restore.
        std::fs::write(world.join("assets/map.png"), b"changed").unwrap();
        std::fs::write(world.join("assets/new.png"), b"new").unwrap();
        restore(&world, &backups, &b.file).unwrap();
        assert_eq!(std::fs::read(world.join("assets/map.png")).unwrap(), b"png");
        assert!(!world.join("assets/new.png").exists());

        // A safety backup was made before restoring.
        let all = list(&backups);
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|x| x.label == "before-restore"));

        assert!(path_of(&backups, "../x.zip").is_err());
        delete(&backups, &b.file).unwrap();
        assert_eq!(list(&backups).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
