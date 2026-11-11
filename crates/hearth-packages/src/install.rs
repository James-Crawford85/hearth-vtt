//! Installing packages from `.zip` archives.
//!
//! An archive may hold the package at its root (`hearth.toml`, â€¦) or inside
//! one top-level folder (`my-system-1.2/hearth.toml`, â€¦) as GitHub's
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
    #[error("{0}")]
    Invalid(String),
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

/// A package id from a name ("My Game!" â†’ "my-game"), not already `taken`.
pub fn id_for(name: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let mut base: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while base.contains("--") {
        base = base.replace("--", "-");
    }
    let base = base.trim_matches('-').chars().take(40).collect::<String>();
    let base = if base.is_empty() { "my-system".to_string() } else { base };
    let mut id = base.clone();
    let mut n = 2;
    while taken(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

fn toml_string(s: &str) -> String {
    toml::Value::String(s.to_string()).to_string()
}

/// Make a new, empty game system in `dest_root` (the user's packages folder),
/// ready to design in the system builder. `taken` says which ids are in use.
pub fn create_system(dest_root: &Path, name: &str, description: &str, taken: &dyn Fn(&str) -> bool) -> Result<Manifest, InstallError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(InstallError::Invalid("Give the system a name".into()));
    }
    let id = id_for(name, &|id| taken(id) || dest_root.join(id).exists());
    let dir = dest_root.join(&id);
    std::fs::create_dir_all(&dir)?;
    let manifest = format!(
        "id = \"{id}\"\ntype = \"system\"\nname = {}\nversion = \"0.1.0\"\ndescription = {}\n\n# Designed in Hearth's system builder (builder.json). Anything written\n# here by hand is merged over what the builder makes; see docs/rules.md.\n",
        toml_string(name),
        toml_string(description.trim()),
    );
    std::fs::write(dir.join("hearth.toml"), manifest)?;
    std::fs::write(dir.join(crate::builder::FILE), "{\n  \"version\": 1\n}\n")?;
    Ok(Package::load(&dir)?.manifest)
}

/// Copy a package to `dest_root` under a new name (and id), e.g. to edit a
/// built-in system. Returns the copy's manifest.
pub fn copy_package(src: &Package, dest_root: &Path, name: &str, taken: &dyn Fn(&str) -> bool) -> Result<Manifest, InstallError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(InstallError::Invalid("Give the copy a name".into()));
    }
    let id = id_for(name, &|id| taken(id) || dest_root.join(id).exists());
    let dir = dest_root.join(&id);
    let mut total = 0u64;
    let mut files = 0usize;
    copy_dir(&src.dir, &dir, &mut total, &mut files)?;
    // Point the manifest at the new id and name.
    let file = dir.join("hearth.toml");
    let text = std::fs::read_to_string(&file)?;
    let mut table: toml::Table = text.parse().map_err(|e: toml::de::Error| InstallError::Invalid(e.to_string()))?;
    table.insert("id".into(), toml::Value::String(id.clone()));
    table.insert("name".into(), toml::Value::String(name.to_string()));
    let out = toml::to_string_pretty(&table).map_err(|e| InstallError::Invalid(e.to_string()))?;
    std::fs::write(&file, format!("# Copied from {} ({}).\n{out}", src.manifest.name, src.manifest.id))?;
    match Package::load(&dir) {
        Ok(p) => Ok(p.manifest),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            Err(e.into())
        }
    }
}

fn copy_dir(from: &Path, to: &Path, total: &mut u64, files: &mut usize) -> Result<(), InstallError> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &dest, total, files)?;
        } else if kind.is_file() {
            *files += 1;
            *total += entry.metadata()?.len();
            if *files > MAX_FILES || *total > MAX_UNPACKED {
                return Err(InstallError::TooLarge);
            }
            std::fs::copy(entry.path(), dest)?;
        }
        // Symlinks are skipped.
    }
    Ok(())
}

#[cfg(test)]
mod new_system_tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hearth-newsys-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ids_from_names() {
        let none = |_: &str| false;
        assert_eq!(id_for("My Game!", &none), "my-game");
        assert_eq!(id_for("  ", &none), "my-system");
        assert_eq!(id_for("D&D 5e SRD", &none), "d-d-5e-srd");
        assert_eq!(id_for("x", &|id| id == "x" || id == "x-2"), "x-3");
    }

    #[test]
    fn creates_a_blank_system_and_copies_one() {
        let root = tmp("create");
        let m = create_system(&root, "Ember \"Saga\"", "Mine.", &|_| false).unwrap();
        assert_eq!((m.id.as_str(), m.name.as_str()), ("ember-saga", "Ember \"Saga\""));
        let pkg = Package::load(&root.join("ember-saga")).unwrap();
        assert!(pkg.blueprint.is_some(), "starts with an empty builder file");
        // A second one with the same name gets its own folder.
        assert_eq!(create_system(&root, "Ember Saga", "", &|_| false).unwrap().id, "ember-saga-2");
        // Copy d20 Lite under a new name.
        let d20 = Package::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/d20-lite")).unwrap();
        let c = copy_package(&d20, &root, "My d20", &|id| id == "d20-lite").unwrap();
        assert_eq!((c.id.as_str(), c.name.as_str()), ("my-d20", "My d20"));
        let copy = Package::load(&root.join("my-d20")).unwrap();
        assert_eq!(copy.manifest.packs.len(), d20.manifest.packs.len(), "packs come along");
        assert!(copy.dir.join("sheets/character.html").is_file());
        assert_eq!(copy.rules().conditions.len(), d20.rules().conditions.len(), "rules survive the rewrite");
        let _ = std::fs::remove_dir_all(&root);
    }
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
