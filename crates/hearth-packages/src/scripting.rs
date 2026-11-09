//! Server-side package scripts, written in Rhai and run in a sandbox with
//! operation limits. A script defines any of these functions:
//!
//! ```rhai
//! // Return a map merged into `actor.derived`. Runs after every actor/item change.
//! fn prepare_actor(actor) { #{ ... } }
//!
//! // Inspect or alter a finished roll before it is posted to chat.
//! // Return a map merged into the chat message's `flags` (or () for nothing).
//! fn on_roll(roll, actor) { ... }
//! ```
//!
//! Available helpers: `roll(formula) -> int`, `floor_div(a, b) -> int`.

use hearth_core::patch::merge_patch;
use hearth_core::Actor;
use rhai::{Dynamic, Engine, Scope, AST};
use serde_json::Value;

use crate::Registry;

pub struct ScriptHost {
    engine: Engine,
    scripts: Vec<(String, AST)>,
}

fn floor_div(a: i64, b: i64) -> i64 {
    if b == 0 {
        return 0;
    }
    let q = a / b;
    if a % b != 0 && ((a < 0) != (b < 0)) {
        q - 1
    } else {
        q
    }
}

impl ScriptHost {
    pub fn empty() -> ScriptHost {
        ScriptHost { engine: Self::engine(), scripts: vec![] }
    }

    fn engine() -> Engine {
        let mut e = Engine::new();
        e.set_max_operations(500_000);
        e.set_max_call_levels(64);
        e.set_max_expr_depths(64, 32);
        e.set_max_string_size(64 * 1024);
        e.set_max_array_size(10_000);
        e.set_max_map_size(10_000);
        e.register_fn("roll", |f: &str| hearth_dice::roll(f).map(|r| r.total).unwrap_or(0));
        e.register_fn("floor_div", floor_div);
        e.on_print(|s| tracing::info!(target: "script", "{s}"));
        e
    }

    /// Compile the server scripts of the system and enabled modules.
    pub fn load(reg: &Registry, system: &str, modules: &[String]) -> (ScriptHost, Vec<String>) {
        let mut host = Self::empty();
        let mut errors = vec![];
        for pkg in reg.active(system, modules, None) {
            let Some(rel) = &pkg.manifest.server.script else { continue };
            let path = pkg.dir.join(rel);
            let compiled = std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|src| host.engine.compile(src).map_err(|e| e.to_string()));
            match compiled {
                Ok(ast) => host.scripts.push((pkg.manifest.id.clone(), ast)),
                Err(e) => errors.push(format!("{}: {e}", path.display())),
            }
        }
        (host, errors)
    }

    fn has_fn(ast: &AST, name: &str, arity: usize) -> bool {
        ast.iter_functions().any(|f| f.name == name && f.params.len() == arity)
    }

    fn call(&self, pkg: &str, ast: &AST, name: &str, args: impl rhai::FuncArgs) -> Option<Value> {
        match self.engine.call_fn::<Dynamic>(&mut Scope::new(), ast, name, args) {
            Ok(d) if d.is_unit() => None,
            Ok(d) => match rhai::serde::from_dynamic::<Value>(&d) {
                Ok(v) => Some(v),
                Err(e) => {
                    tracing::warn!(package = pkg, "{name} returned unconvertible value: {e}");
                    None
                }
            },
            Err(e) => {
                tracing::warn!(package = pkg, "{name} failed: {e}");
                None
            }
        }
    }

    /// Compute derived data for an actor from every script's `prepare_actor`.
    /// Returns `None` when no script defines the hook.
    pub fn prepare_actor(&self, actor: &Actor) -> Option<Value> {
        let mut any = false;
        let mut derived = Value::Object(Default::default());
        let Ok(dyn_actor) = rhai::serde::to_dynamic(actor) else { return None };
        for (pkg, ast) in &self.scripts {
            if !Self::has_fn(ast, "prepare_actor", 1) {
                continue;
            }
            any = true;
            if let Some(v) = self.call(pkg, ast, "prepare_actor", (dyn_actor.clone(),)) {
                merge_patch(&mut derived, &v);
            }
        }
        any.then_some(derived)
    }

    /// Run `on_roll(roll, actor)` hooks; returns flags to attach to the message.
    pub fn on_roll(&self, roll: &hearth_dice::RollResult, actor: Option<&Actor>) -> Value {
        let mut flags = Value::Object(Default::default());
        let (Ok(r), Ok(a)) = (rhai::serde::to_dynamic(roll), rhai::serde::to_dynamic(actor)) else {
            return flags;
        };
        for (pkg, ast) in &self.scripts {
            if Self::has_fn(ast, "on_roll", 2) {
                if let Some(v) = self.call(pkg, ast, "on_roll", (r.clone(), a.clone())) {
                    merge_patch(&mut flags, &serde_json::json!({ pkg.as_str(): v }));
                }
            }
        }
        flags
    }

    pub fn is_empty(&self) -> bool {
        self.scripts.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prepare_actor_runs() {
        let host = ScriptHost::empty();
        let ast = host
            .engine
            .compile(
                r#"
                fn prepare_actor(actor) {
                    let s = actor.data.str;
                    #{ str_mod: floor_div(s - 10, 2), name_len: actor.name.len() }
                }
                fn spin() { loop { } }
                "#,
            )
            .unwrap();
        let host = ScriptHost { scripts: vec![("t".into(), ast)], ..host };
        let actor = Actor {
            id: "a".into(),
            name: "Mira".into(),
            kind: "character".into(),
            img: None,
            owners: vec![],
            data: json!({"str": 7}),
            derived: Value::Null,
            items: vec![],
            flags: Value::Null,
        };
        assert_eq!(host.prepare_actor(&actor), Some(json!({"str_mod": -2, "name_len": 4})));
        // Runaway scripts are stopped by the operation limit instead of hanging the server.
        let (_, ast) = &host.scripts[0];
        assert!(host.engine.call_fn::<Dynamic>(&mut Scope::new(), ast, "spin", ()).is_err());
    }
}
