//! Packages are folders containing a `hearth.toml` manifest. There are three
//! kinds:
//!
//! * **system** – a game system: actor/item types, data templates, sheets,
//!   server rules (Rhai) and client scripts.
//! * **module** – optional add-ons layered on any (or specific) systems.
//! * **theme** – stylesheets that restyle the client.
//!
//! See `docs/packages.md` for the full manifest reference.

pub mod install;
mod scripting;

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

pub use scripting::ScriptHost;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageKind {
    System,
    Module,
    Theme,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ClientSection {
    /// ES modules, relative to the package folder. Each may export
    /// `default function init(hearth)`.
    #[serde(default)]
    pub scripts: Vec<String>,
    #[serde(default)]
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerSection {
    /// Rhai script run on the server, relative to the package folder.
    #[serde(default)]
    pub script: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CombatSection {
    /// Initiative roll, e.g. `1d20 + @initiative`. `@paths` resolve against the
    /// combatant's actor (derived values first, then data).
    #[serde(default)]
    pub initiative: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TypeDef {
    #[serde(default)]
    pub label: Option<String>,
    /// Default `data` for new documents of this type.
    #[serde(default)]
    pub template: Value,
    /// HTML sheet template, relative to the package folder.
    #[serde(default)]
    pub sheet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: PackageKind,
    pub name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub authors: Vec<String>,
    #[serde(default)]
    pub license: Option<String>,
    /// For modules: system ids this module works with. Empty = any system.
    #[serde(default)]
    pub systems: Vec<String>,
    #[serde(default)]
    pub client: ClientSection,
    #[serde(default)]
    pub server: ServerSection,
    /// Systems only: combat rules.
    #[serde(default)]
    pub combat: CombatSection,
    #[serde(default)]
    pub actor_types: BTreeMap<String, TypeDef>,
    #[serde(default)]
    pub item_types: BTreeMap<String, TypeDef>,
    /// Content collections shipped with the package (monsters, spells, handouts…).
    #[serde(default)]
    pub packs: Vec<PackDef>,
}

/// A collection of ready-made documents in a package: a JSON array in `path`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackDef {
    pub id: String,
    pub label: String,
    /// `actor`, `item`, `journal`, `table` or `macro`.
    pub kind: String,
    /// JSON file, relative to the package folder.
    pub path: String,
    /// Players can browse it too (otherwise GM only).
    #[serde(default)]
    pub public: bool,
}

fn default_version() -> String {
    "0.0.0".into()
}

#[derive(Debug, Clone)]
pub struct Package {
    pub manifest: Manifest,
    pub dir: PathBuf,
}

#[derive(Debug, Error)]
pub enum PackageError {
    #[error("{0}: {1}")]
    Io(PathBuf, std::io::Error),
    #[error("{0}: {1}")]
    Manifest(PathBuf, toml::de::Error),
    #[error("{0}: package id '{1}' must be lowercase letters, digits and '-'")]
    BadId(PathBuf, String),
    #[error("{0}: path '{1}' must be relative and stay inside the package")]
    BadPath(PathBuf, String),
}

fn safe_relative(p: &str) -> bool {
    // Manifests are shared between OSes, so use '/' only and reject anything
    // Windows would treat as a drive or separator, regardless of the host OS.
    let path = Path::new(p);
    !p.is_empty()
        && !p.contains(['\\', ':'])
        && path.components().all(|c| matches!(c, Component::Normal(_)))
}

impl Package {
    pub fn load(dir: &Path) -> Result<Package, PackageError> {
        let file = dir.join("hearth.toml");
        let text = std::fs::read_to_string(&file).map_err(|e| PackageError::Io(file.clone(), e))?;
        let manifest: Manifest = toml::from_str(&text).map_err(|e| PackageError::Manifest(file.clone(), e))?;
        if manifest.id.is_empty()
            || !manifest.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(PackageError::BadId(file, manifest.id));
        }
        let paths = manifest
            .client
            .scripts
            .iter()
            .chain(&manifest.client.styles)
            .chain(&manifest.server.script)
            .chain(manifest.actor_types.values().filter_map(|t| t.sheet.as_ref()))
            .chain(manifest.item_types.values().filter_map(|t| t.sheet.as_ref()));
        for p in paths {
            if !safe_relative(p) {
                return Err(PackageError::BadPath(file, p.clone()));
            }
        }
        Ok(Package { manifest, dir: dir.to_path_buf() })
    }

    fn url(&self, rel: &str) -> String {
        format!("/packages/{}/{}", self.manifest.id, rel.replace('\\', "/"))
    }

    /// What the browser client needs to know about this package.
    pub fn client_info(&self) -> Value {
        let m = &self.manifest;
        let types = |t: &BTreeMap<String, TypeDef>| -> Value {
            t.iter()
                .map(|(k, d)| {
                    (
                        k.clone(),
                        json!({
                            "label": d.label.clone().unwrap_or_else(|| k.clone()),
                            "template": d.template,
                            "sheet": d.sheet.as_deref().map(|s| self.url(s)),
                        }),
                    )
                })
                .collect::<serde_json::Map<_, _>>()
                .into()
        };
        json!({
            "id": m.id,
            "type": m.kind,
            "name": m.name,
            "version": m.version,
            "description": m.description,
            "authors": m.authors,
            "systems": m.systems,
            "scripts": m.client.scripts.iter().map(|s| self.url(s)).collect::<Vec<_>>(),
            "styles": m.client.styles.iter().map(|s| self.url(s)).collect::<Vec<_>>(),
            "actor_types": types(&m.actor_types),
            "item_types": types(&m.item_types),
            "packs": m.packs.iter().map(|p| json!({"id": p.id, "label": p.label, "kind": p.kind, "public": p.public})).collect::<Vec<_>>(),
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct Registry {
    pub packages: BTreeMap<String, Package>,
}

impl Package {
    /// The pack with this id, if the package has one.
    pub fn pack(&self, id: &str) -> Option<&PackDef> {
        self.manifest.packs.iter().find(|p| p.id == id)
    }

    /// Is `path` (relative to the package folder) one of its pack files?
    pub fn is_pack_file(&self, path: &str) -> bool {
        let norm = |p: &str| p.trim_start_matches("./").trim_start_matches('/').replace('\\', "/").to_ascii_lowercase();
        let path = norm(path);
        self.manifest.packs.iter().any(|p| norm(&p.path) == path)
    }
}

impl Registry {
    /// Load packages from several folders. A package in a later folder
    /// replaces one with the same id from an earlier folder, so user-installed
    /// packages can override bundled ones. Missing folders are ignored.
    pub fn load_all(roots: &[PathBuf]) -> (Registry, Vec<PackageError>) {
        let mut reg = Registry::default();
        let mut errors = vec![];
        for root in roots.iter().filter(|r| r.is_dir()) {
            let (r, e) = Registry::load(root);
            reg.packages.extend(r.packages);
            errors.extend(e);
        }
        (reg, errors)
    }

    /// Load every immediate subfolder of `root` that has a `hearth.toml`.
    /// Broken packages are skipped and reported in the returned error list.
    pub fn load(root: &Path) -> (Registry, Vec<PackageError>) {
        let mut reg = Registry::default();
        let mut errors = vec![];
        let entries = match std::fs::read_dir(root) {
            Ok(e) => e,
            Err(e) => return (reg, vec![PackageError::Io(root.to_path_buf(), e)]),
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.join("hearth.toml").is_file())
            .collect();
        dirs.sort();
        for dir in dirs {
            match Package::load(&dir) {
                Ok(p) => {
                    tracing::info!(id = %p.manifest.id, kind = ?p.manifest.kind, "loaded package");
                    reg.packages.insert(p.manifest.id.clone(), p);
                }
                Err(e) => errors.push(e),
            }
        }
        (reg, errors)
    }

    pub fn get(&self, id: &str) -> Option<&Package> {
        self.packages.get(id)
    }

    pub fn of_kind(&self, kind: PackageKind) -> impl Iterator<Item = &Package> {
        self.packages.values().filter(move |p| p.manifest.kind == kind)
    }

    /// The packages active for a world, in load order: system, modules, theme.
    pub fn active<'a>(&'a self, system: &str, modules: &[String], theme: Option<&str>) -> Vec<&'a Package> {
        let mut out = vec![];
        if let Some(p) = self.get(system).filter(|p| p.manifest.kind == PackageKind::System) {
            out.push(p);
        }
        for m in modules {
            if let Some(p) = self.get(m).filter(|p| p.manifest.kind == PackageKind::Module) {
                if p.manifest.systems.is_empty() || p.manifest.systems.iter().any(|s| s == system) {
                    out.push(p);
                }
            }
        }
        if let Some(p) = theme.and_then(|t| self.get(t)).filter(|p| p.manifest.kind == PackageKind::Theme) {
            out.push(p);
        }
        out
    }

    /// The `packages` blob sent to clients in `welcome`.
    pub fn client_index(&self, system: &str, modules: &[String], theme: Option<&str>) -> Value {
        let active: Vec<Value> = self.active(system, modules, theme).iter().map(|p| p.client_info()).collect();
        let available: Vec<Value> = self
            .packages
            .values()
            .map(|p| {
                let m = &p.manifest;
                json!({"id": m.id, "type": m.kind, "name": m.name, "version": m.version,
                       "description": m.description, "systems": m.systems})
            })
            .collect();
        json!({ "active": active, "available": available })
    }

    /// Default data for a new actor of `kind` under `system`.
    pub fn actor_template(&self, system: &str, kind: &str) -> Value {
        self.get(system)
            .and_then(|p| p.manifest.actor_types.get(kind))
            .map(|t| t.template.clone())
            .unwrap_or(Value::Null)
    }

    /// The system's initiative formula (`1d20` when it doesn't set one).
    pub fn initiative_formula(&self, system: &str) -> String {
        self.get(system)
            .and_then(|p| p.manifest.combat.initiative.clone())
            .filter(|f| !f.trim().is_empty())
            .unwrap_or_else(|| "1d20".into())
    }

    pub fn item_template(&self, system: &str, kind: &str) -> Value {
        self.get(system)
            .and_then(|p| p.manifest.item_types.get(kind))
            .map(|t| t.template.clone())
            .unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses() {
        let m: Manifest = toml::from_str(
            r#"
            id = "demo"
            type = "system"
            name = "Demo"
            [client]
            scripts = ["main.js"]
            [actor_types.character]
            label = "Character"
            sheet = "sheets/character.html"
            template = { hp = { value = 10, max = 10 }, tags = ["a"] }
            "#,
        )
        .unwrap();
        assert_eq!(m.kind, PackageKind::System);
        assert_eq!(m.actor_types["character"].template["hp"]["max"], 10);
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(safe_relative("scripts/a.js"));
        assert!(!safe_relative("../a.js"));
        assert!(!safe_relative("/etc/passwd"));
        assert!(!safe_relative("C:\\x"));
    }
}

#[cfg(test)]
mod pack_tests {
    use super::*;

    #[test]
    fn packs_parse_and_pack_files_are_recognised() {
        let m: Manifest = toml::from_str(
            r#"
            id = "x"
            type = "system"
            name = "X"
            [[packs]]
            id = "beasts"
            label = "Beasts"
            kind = "actor"
            path = "packs/beasts.json"
            "#,
        )
        .unwrap();
        assert_eq!(m.packs.len(), 1);
        assert!(!m.packs[0].public, "packs are GM-only unless marked public");
        let pkg = Package { manifest: m, dir: PathBuf::from(".") };
        assert!(pkg.is_pack_file("packs/beasts.json"));
        assert!(pkg.is_pack_file("./PACKS/beasts.json"));
        assert!(pkg.is_pack_file(r"packs\beasts.json"));
        assert!(!pkg.is_pack_file("packs/other.json"));
        assert_eq!(pkg.pack("beasts").unwrap().kind, "actor");
    }

    #[test]
    fn bundled_d20_lite_packs_are_valid() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/d20-lite");
        let m: Manifest = toml::from_str(&std::fs::read_to_string(dir.join("hearth.toml")).unwrap()).unwrap();
        assert!(m.packs.len() >= 3);
        for p in &m.packs {
            let text = std::fs::read_to_string(dir.join(&p.path)).unwrap();
            let docs: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
            assert!(!docs.is_empty(), "{} is empty", p.path);
            assert!(docs.iter().all(|d| d["name"].is_string()), "every entry in {} needs a name", p.path);
        }
    }
}
