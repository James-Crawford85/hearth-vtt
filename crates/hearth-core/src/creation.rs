//! Character creation: steps a new character goes through before anything else,
//! such as setting ability scores.
//!
//! A system lists the steps and, for each, the methods it offers (in the system
//! builder; `creation` in `builder.json`):
//!
//! ```json
//! { "id": "abilities", "label": "Ability scores", "path": "abilities", "field": "value",
//!   "methods": [
//!     { "id": "array",  "kind": "array",    "label": "Standard array", "values": [15, 14, 13, 12, 10, 8] },
//!     { "id": "points", "kind": "pointbuy", "label": "Point buy", "points": 27, "min": 8, "max": 15,
//!       "costs": { "8": 0, "9": 1, "10": 2, "11": 3, "12": 4, "13": 5, "14": 7, "15": 9 } },
//!     { "id": "4d6",    "kind": "roll",     "label": "Roll 4d6, drop the lowest", "formula": "4d6kh3", "count": 6 },
//!     { "id": "manual", "kind": "manual",   "label": "Enter your own", "min": 3, "max": 18 } ] }
//! ```
//!
//! Each world picks which methods players may use and can change their numbers
//! (`settings.core.creation.<step>`: `allowed`, `default`, `methods.<id>` overrides
//! such as `{ "points": 32 }`, and `lock`). The server rolls and checks everything.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// A creation step (today: setting a list of scores, like the six abilities).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CreationStep {
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// The actor's list it fills (e.g. `abilities`).
    pub path: String,
    /// The field set in each entry (default `value`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub field: String,
    #[serde(default)]
    pub methods: Vec<ScoreMethod>,
    /// The actor types that go through this step (e.g. characters, not monsters). Empty: all.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actor_types: Vec<String>,
}

impl CreationStep {
    /// Whether actors of this type go through the step.
    pub fn applies_to(&self, kind: &str) -> bool {
        self.actor_types.is_empty() || self.actor_types.iter().any(|k| k == kind)
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MethodKind {
    /// Assign a fixed set of values, each once.
    #[default]
    Array,
    /// Spend a budget of points; each score costs what the table says.
    Pointbuy,
    /// Roll dice a number of times, then assign the results (or in order).
    Roll,
    /// Type them in, within limits.
    Manual,
}

/// One way to set the scores. Which numbers a world may change: `values`,
/// `points`, `min`, `max`, `formula`, `count`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ScoreMethod {
    pub id: String,
    #[serde(default)]
    pub kind: MethodKind,
    #[serde(default)]
    pub label: String,
    /// `array`: the values.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<i64>,
    /// `pointbuy`: the budget.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub points: i64,
    /// `pointbuy`: score → cost (scores missing from it can't be bought).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub costs: BTreeMap<String, i64>,
    /// `pointbuy`, `manual`: lowest and highest score.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<i64>,
    /// `roll`: the dice, e.g. `4d6kh3`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub formula: String,
    /// `roll`: how many rolls (default: one per entry).
    #[serde(default, skip_serializing_if = "is_zero_u")]
    pub count: u32,
    /// `roll`: results go to the entries in order, no rearranging.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub in_order: bool,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

fn is_zero_u(n: &u32) -> bool {
    *n == 0
}

/// A world's choices for one step (`settings.core.creation.<step id>`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WorldChoice {
    /// The methods players may use, with the world's numbers.
    pub methods: Vec<ScoreMethod>,
    /// Scores can't be set again once set (unless the GM resets them). Default on.
    pub lock: bool,
}

/// The methods a world allows for a step, with its changes applied (`settings` is
/// the step's object, or null for the system's defaults: everything allowed).
pub fn world_choice(step: &CreationStep, settings: &Value) -> WorldChoice {
    let allowed: Option<Vec<String>> = settings.get("allowed").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect());
    let methods = step
        .methods
        .iter()
        .filter(|m| allowed.as_ref().is_none_or(|a| a.contains(&m.id)))
        .map(|m| {
            // The world can change the numbers, not the kind or the id.
            let Some(over) = settings.pointer(&format!("/methods/{}", m.id)).filter(|v| v.is_object()) else { return m.clone() };
            let mut v = serde_json::to_value(m).unwrap_or(Value::Null);
            for key in ["values", "points", "min", "max", "formula", "count", "label"] {
                if let Some(x) = over.get(key) {
                    v[key] = x.clone();
                }
            }
            serde_json::from_value(v).unwrap_or_else(|_| m.clone())
        })
        .collect();
    WorldChoice { methods, lock: settings.get("lock").and_then(Value::as_bool).unwrap_or(true) }
}

/// What the player chose: entry → a score (point buy, manual) or an index into the
/// values or rolls (array, roll).
pub type Assign = BTreeMap<String, i64>;

/// Roll for a roll method: `count` results (default: one per entry).
pub fn roll_scores(method: &ScoreMethod, entries: usize, roll: &mut dyn FnMut(&str) -> Result<i64, String>) -> Result<Vec<i64>, String> {
    if method.kind != MethodKind::Roll {
        return Err("That method doesn't roll".into());
    }
    let n = if method.count > 0 { method.count as usize } else { entries };
    if n == 0 || n > 20 {
        return Err("Roll between 1 and 20 times".into());
    }
    (0..n).map(|_| roll(&method.formula)).collect()
}

/// Check a choice and work out the scores: entry → score. `entries` are the
/// list's entries in the system's order; `rolls` are the results rolled earlier.
pub fn scores(method: &ScoreMethod, entries: &[String], assign: &Assign, rolls: &[i64]) -> Result<BTreeMap<String, i64>, String> {
    if entries.is_empty() {
        return Err("This character has nothing to set here".into());
    }
    if let Some(k) = assign.keys().find(|k| !entries.contains(k)) {
        return Err(format!("{k} isn't one of the scores"));
    }
    // Each value (or roll) used at most once, every entry given one.
    let pick = |pool: &[i64]| -> Result<BTreeMap<String, i64>, String> {
        let mut used = vec![false; pool.len()];
        let mut out = BTreeMap::new();
        for e in entries {
            let i = *assign.get(e).ok_or_else(|| format!("Give {e} a score"))?;
            let i = usize::try_from(i).ok().filter(|&i| i < pool.len()).ok_or_else(|| format!("{e}: that isn't one of the values"))?;
            if std::mem::replace(&mut used[i], true) {
                return Err("Use each value once".into());
            }
            out.insert(e.clone(), pool[i]);
        }
        Ok(out)
    };
    let within = |e: &str, v: i64| -> Result<(), String> {
        if method.min.is_some_and(|m| v < m) || method.max.is_some_and(|m| v > m) {
            return Err(format!("{e} must be between {} and {}", method.min.map_or("any".into(), |m| m.to_string()), method.max.map_or("any".into(), |m| m.to_string())));
        }
        Ok(())
    };
    match method.kind {
        MethodKind::Array => {
            if method.values.len() < entries.len() {
                return Err("There aren't enough values for every score".into());
            }
            pick(&method.values)
        }
        MethodKind::Roll => {
            if rolls.len() < entries.len() {
                return Err("Roll first".into());
            }
            if method.in_order {
                return Ok(entries.iter().cloned().zip(rolls.iter().copied()).collect());
            }
            pick(rolls)
        }
        MethodKind::Pointbuy => {
            let mut spent = 0;
            let mut out = BTreeMap::new();
            for e in entries {
                let v = *assign.get(e).ok_or_else(|| format!("Give {e} a score"))?;
                within(e, v)?;
                let cost = method.costs.get(&v.to_string()).copied().ok_or_else(|| format!("{e}: a score of {v} can't be bought"))?;
                spent += cost;
                out.insert(e.clone(), v);
            }
            if spent > method.points {
                return Err(format!("That costs {spent} points; you have {}", method.points));
            }
            Ok(out)
        }
        MethodKind::Manual => {
            let mut out = BTreeMap::new();
            for e in entries {
                let v = *assign.get(e).ok_or_else(|| format!("Give {e} a score"))?;
                within(e, v)?;
                out.insert(e.clone(), v);
            }
            Ok(out)
        }
    }
}

/// The data patch that sets the scores (`{ abilities: { str: { value: 15 } … } }`).
pub fn scores_patch(step: &CreationStep, scores: &BTreeMap<String, i64>) -> Value {
    let field = if step.field.is_empty() { "value" } else { step.field.as_str() };
    let mut list = serde_json::Map::new();
    for (k, v) in scores {
        list.insert(k.clone(), json!({ field: v }));
    }
    let mut out = Value::Object(list);
    for seg in step.path.split('.').rev() {
        out = json!({ seg: out });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step() -> CreationStep {
        serde_json::from_value(json!({ "id": "abilities", "path": "abilities", "methods": [
            { "id": "array", "kind": "array", "values": [15, 14, 13] },
            { "id": "points", "kind": "pointbuy", "points": 27, "min": 8, "max": 15, "costs": { "8": 0, "13": 5, "14": 7, "15": 9 } },
            { "id": "roll", "kind": "roll", "formula": "4d6kh3" },
            { "id": "order", "kind": "roll", "formula": "3d6", "in_order": true },
            { "id": "manual", "kind": "manual", "min": 3, "max": 18 } ] }))
        .unwrap()
    }

    fn entries() -> Vec<String> {
        vec!["str".into(), "dex".into(), "con".into()]
    }

    fn assign(pairs: &[(&str, i64)]) -> Assign {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn worlds_choose_and_adjust_methods() {
        let s = step();
        assert_eq!(world_choice(&s, &Value::Null).methods.len(), 5, "everything, by default");
        let w = world_choice(&s, &json!({ "allowed": ["points", "roll"], "methods": { "points": { "points": 32, "kind": "manual" } }, "lock": false }));
        assert_eq!(w.methods.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["points", "roll"]);
        assert_eq!(w.methods[0].points, 32, "the world's budget");
        assert_eq!(w.methods[0].kind, MethodKind::Pointbuy, "but not its kind");
        assert!(!w.lock);
    }

    #[test]
    fn each_method_checks_its_choices() {
        let s = step();
        let m = |id: &str| s.methods.iter().find(|m| m.id == id).unwrap().clone();
        let e = entries();
        // Array: each value once, every score given one.
        assert_eq!(scores(&m("array"), &e, &assign(&[("str", 0), ("dex", 2), ("con", 1)]), &[]).unwrap()["dex"], 13);
        assert!(scores(&m("array"), &e, &assign(&[("str", 0), ("dex", 0), ("con", 1)]), &[]).unwrap_err().contains("once"));
        assert!(scores(&m("array"), &e, &assign(&[("str", 0), ("dex", 1)]), &[]).unwrap_err().contains("Give con"));
        // Point buy: limits, the cost table and the budget.
        assert!(scores(&m("points"), &e, &assign(&[("str", 15), ("dex", 15), ("con", 15)]), &[]).is_ok(), "9 + 9 + 9 = 27");
        let mut rich = m("points");
        rich.points = 20;
        assert!(scores(&rich, &e, &assign(&[("str", 15), ("dex", 15), ("con", 15)]), &[]).unwrap_err().contains("you have 20"));
        assert!(scores(&m("points"), &e, &assign(&[("str", 16), ("dex", 8), ("con", 8)]), &[]).unwrap_err().contains("between 8 and 15"));
        assert!(scores(&m("points"), &e, &assign(&[("str", 10), ("dex", 8), ("con", 8)]), &[]).unwrap_err().contains("can't be bought"));
        // Rolls: assign freely, or in order.
        assert!(scores(&m("roll"), &e, &assign(&[]), &[]).unwrap_err().contains("Roll first"));
        assert_eq!(scores(&m("roll"), &e, &assign(&[("str", 2), ("dex", 0), ("con", 1)]), &[12, 9, 17]).unwrap()["str"], 17);
        assert_eq!(scores(&m("order"), &e, &assign(&[]), &[12, 9, 17]).unwrap(), [("str".into(), 12), ("dex".into(), 9), ("con".into(), 17)].into_iter().collect());
        // Manual: limits only.
        assert!(scores(&m("manual"), &e, &assign(&[("str", 19), ("dex", 3), ("con", 3)]), &[]).is_err());
        assert!(scores(&m("manual"), &e, &assign(&[("str", 18), ("dex", 3), ("con", 3), ("wis", 9)]), &[]).unwrap_err().contains("wis isn't"));
        // Rolling uses the formula, once per score unless the method says.
        let mut seen = vec![];
        let r = roll_scores(&m("roll"), 3, &mut |f| { seen.push(f.to_string()); Ok(10) }).unwrap();
        assert_eq!((r.len(), seen[0].as_str()), (3, "4d6kh3"));
        assert_eq!(scores_patch(&s, &[("str".to_string(), 15)].into_iter().collect()), json!({ "abilities": { "str": { "value": 15 } } }));
    }
}
