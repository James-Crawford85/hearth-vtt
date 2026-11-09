//! Installing packages from `.zip` archives.
//!
//! An archive may hold the package at its root (`hearth.toml`, …) or inside
//! one top-level folder (`my-system-1.2/hearth.toml`, …) as GitHub's
//! "Download ZIP" and release archives do. Extraction is guarded against
//! path traversal ("zip slip") and zip bombs, and the manifest is validated
//! before anything replaces an installed package.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::{Manifest, Package, PackageError};

/// Largest total unpacked size accepted.
pub const MAX_UNPACKED: u64 = 512 * 1024 * 1024;
const MAX_FILES: usize = 20_000;

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("not a valid zip archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("no hearth.toml found in the archive")]
    NoManifest,
    #[error("archive is too large to install")]
    TooLarge,
    #[error("archive contains an unsafe path: {0}")]
    UnsafePath(String),
    #[error(transparent)]
    Package(#[from] PackageError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// Install a package archive into `dest_root` (the user's packages folder).
/// An existing package with the same id there is replaced.
pub fn install_zip(bytes: &[u8], dest_root: &Path) -> Result<Manifest, InstallError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
    if zip.len() > MAX_FILES {
        return Err(InstallError::TooLarge);
    }

    // Find the shallowest hearth.toml; everything is extracted relative to it.
    let mut prefix: Option<PathBuf> = None;
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let Some(path) = entry.enclosed_name() else { continue };
        if path.file_name().is_some_and(|n| n == "hearth.toml") && path.components().count() <= 2 {
            let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
            if prefix.as_ref().is_none_or(|p| parent.components().count() < p.components().count()) {
                prefix = Some(parent);
            }
        }
    }
    let prefix = prefix.ok_or(InstallError::NoManifest)?;

    std::fs::create_dir_all(dest_root)?;
    let staging = dest_root.join(format!(".installing-{}", hearth_core::new_id()));
    let result = extract(&mut zip, &prefix, &staging).and_then(|_| {
        let pkg = Package::load(&staging)?;
        let target = dest_root.join(&pkg.manifest.id);
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        std::fs::rename(&staging, &target)?;
        Ok(pkg.manifest)
    });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

fn extract(zip: &mut zip::ZipArchive<Cursor<&[u8]>>, prefix: &Path, staging: &Path) -> Result<(), InstallError> {
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().to_string();
        let path = entry.enclosed_name().ok_or_else(|| InstallError::UnsafePath(name.clone()))?;
        let Ok(rel) = path.strip_prefix(prefix) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = staging.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        let declared = entry.size();
        total = total.saturating_add(declared);
        if total > MAX_UNPACKED {
            return Err(InstallError::TooLarge);
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Never trust the header's size: cap the bytes actually read too.
        let mut buf = Vec::new();
        (&mut entry).take(declared + 1).read_to_end(&mut buf)?;
        if buf.len() as u64 > declared {
            return Err(InstallError::TooLarge);
        }
        std::fs::write(&out, buf)?;
    }
    Ok(())
}

/// Remove an installed package folder. Only call this for user packages.
pub fn uninstall(dest_root: &Path, id: &str) -> Result<(), InstallError> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(InstallError::UnsafePath(id.to_string()));
    }
    let dir = dest_root.join(id);
    if dir.join("hearth.toml").is_file() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn make_zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in files {
            w.start_file(*name, SimpleFileOptions::default()).unwrap();
            w.write_all(body.as_bytes()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    const MANIFEST: &str = "id = \"cool-mod\"\ntype = \"module\"\nname = \"Cool\"\n";

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hearth-install-{tag}-{}", hearth_core::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn installs_from_nested_folder_and_replaces() {
        let root = temp_root("nested");
        let z = make_zip(&[("cool-mod-1.0/hearth.toml", MANIFEST), ("cool-mod-1.0/js/a.js", "x")]);
        let m = install_zip(&z, &root).unwrap();
        assert_eq!(m.id, "cool-mod");
        assert!(root.join("cool-mod/js/a.js").is_file());
        // Reinstall replaces cleanly.
        let z2 = make_zip(&[("hearth.toml", MANIFEST), ("b.js", "y")]);
        install_zip(&z2, &root).unwrap();
        assert!(root.join("cool-mod/b.js").is_file());
        assert!(!root.join("cool-mod/js/a.js").exists());
        uninstall(&root, "cool-mod").unwrap();
        assert!(!root.join("cool-mod").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_bad_archives() {
        let root = temp_root("bad");
        assert!(matches!(install_zip(b"not a zip", &root), Err(InstallError::Zip(_))));
        let no_manifest = make_zip(&[("readme.txt", "hi")]);
        assert!(matches!(install_zip(&no_manifest, &root), Err(InstallError::NoManifest)));
        // Traversal entries are skipped by enclosed_name(); the escape never lands.
        let evil = make_zip(&[("hearth.toml", MANIFEST), ("../../escape.txt", "x")]);
        let _ = install_zip(&evil, &root);
        assert!(!root.parent().unwrap().join("escape.txt").exists());
        // Failed installs leave no staging folders behind.
        let leftovers = std::fs::read_dir(&root).unwrap().filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".installing")).count();
        assert_eq!(leftovers, 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
