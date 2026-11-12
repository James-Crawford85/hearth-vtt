//! Snapshot of what the rules engine works out for every actor a system has, to diff
//! before and after an engine change ("did this break another system?").
//!
//!   cargo run -p hearth-packages --example derive_snapshot -- <packages dir>... --worlds <world dir>... > snap.json
//!
//! For each world: its system's rules, every actor in it. For each system package: every actor
//! in its actor packs (monsters, NPCs). Prints one JSON object, keys sorted, values rounded,
//! so two runs can be diffed line by line.

use std::collections::BTreeMap;
use std::path::PathBuf;

use hearth_core::model::{Actor, World};
use hearth_core::rules::derive;
use hearth_packages::{PackageKind, Registry};
use serde_json::{Map, Value};

fn tidy(v: &Value) -> Value {
    match v {
        Value::Number(n) => n.as_f64().map(|f| serde_json::json!((f * 1000.0).round() / 1000.0)).unwrap_or(v.clone()),
        Value::Array(a) => Value::Array(a.iter().map(tidy).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), tidy(v))).collect::<BTreeMap<_, _>>().into_iter().collect::<Map<_, _>>()),
        _ => v.clone(),
    }
}

fn main() {
    let mut roots = vec![];
    let mut worlds = vec![];
    let mut into_worlds = false;
    for a in std::env::args().skip(1) {
        if a == "--worlds" {
            into_worlds = true;
        } else if into_worlds {
            worlds.push(PathBuf::from(a));
        } else {
            roots.push(PathBuf::from(a));
        }
    }
    let (reg, errs) = Registry::load_all(&roots);
    for e in errs {
        eprintln!("package error: {e}");
    }
    let mut out = BTreeMap::new();
    let mut snap = |key: String, actor: &Actor, rules: &hearth_core::rules::Rules| {
        let d = derive(actor, rules);
        out.insert(key, serde_json::json!({ "values": tidy(&d.values), "errors": d.errors }));
    };
    for w in &worlds {
        let Ok(text) = std::fs::read_to_string(w.join("world.json")) else { eprintln!("no world.json in {}", w.display()); continue };
        let world: World = match serde_json::from_str(&text) { Ok(w) => w, Err(e) => { eprintln!("{}: {e}", w.display()); continue } };
        let rules = reg.rules(&world.system);
        for (id, a) in &world.actors {
            snap(format!("world {} / {} / {} ({id})", w.file_name().unwrap_or_default().to_string_lossy(), world.system, a.name), a, &rules);
        }
    }
    for pkg in reg.of_kind(PackageKind::System) {
        let rules = pkg.rules();
        for p in pkg.manifest.packs.iter().filter(|p| p.kind == "actor") {
            let Ok(text) = std::fs::read_to_string(pkg.dir.join(&p.path)) else { continue };
            let Ok(docs) = serde_json::from_str::<Vec<Value>>(&text) else { continue };
            for (i, d) in docs.iter().enumerate() {
                let mut d = d.clone();
                if let Some(o) = d.as_object_mut() {
                    o.entry("id").or_insert_with(|| Value::String(format!("{i}")));
                    o.entry("kind").or_insert_with(|| Value::String("npc".into()));
                }
                match serde_json::from_value::<Actor>(d.clone()) {
                    Ok(a) => snap(format!("pack {} / {} / {} #{i}", pkg.manifest.id, p.id, a.name), &a, &rules),
                    Err(e) => eprintln!("{}/{} #{i}: {e}", pkg.manifest.id, p.id),
                }
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
