//! Requirements: whether an actor qualifies for something (a feat, a prestige class).
//!
//! An item can say what it needs in its data: `requires`, a formula worked out against the
//! actor (`@abilities.str.value >= 13 && has_item('feat', 'Power Attack')`), and
//! `requires_note`, what the formula doesn't cover, in words ("a deity"). The answer is one of:
//!
//! - `yes`: the formula holds and nothing is left to check (or the item asks for nothing);
//! - `no`: the formula doesn't hold;
//! - `check`: the formula holds (or there's none) but the note asks for something only a
//!   person can judge, or the formula couldn't be worked out.

use serde::Serialize;
use serde_json::Value;

use crate::model::Actor;
use crate::rules::{Engine, Rules};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Met {
    Yes,
    No,
    Check,
}

/// One thing to check: its formula and the note beside it.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct Requirement {
    #[serde(default)]
    pub requires: String,
    #[serde(default)]
    pub note: String,
}

impl Requirement {
    /// The requirement an item's data states (`requires`, `requires_note`).
    pub fn of(data: &Value) -> Requirement {
        let s = |k: &str| data.get(k).and_then(Value::as_str).unwrap_or_default().trim().to_string();
        Requirement { requires: s("requires"), note: s("requires_note") }
    }
}

/// Whether the actor meets each requirement, in order.
pub fn check(actor: &Actor, rules: &Rules, list: &[Requirement]) -> Vec<Met> {
    let mut eng = Engine::new(actor, rules);
    list.iter()
        .map(|r| {
            let formula = r.requires.trim();
            let open = !r.note.trim().is_empty();
            if formula.is_empty() {
                return if open { Met::Check } else { Met::Yes };
            }
            let errors = eng.errors.len();
            let v = eng.eval_src(formula);
            if eng.errors.len() > errors {
                return Met::Check;
            }
            match (v.truthy(), open) {
                (false, _) => Met::No,
                (true, true) => Met::Check,
                (true, false) => Met::Yes,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requirements_are_met_failed_or_left_to_check() {
        let actor: Actor = serde_json::from_value(json!({
            "id": "a", "name": "Tara", "kind": "character",
            "data": { "str": 14, "bab": 1 },
            "items": [ { "id": "f", "name": "Power Attack", "kind": "feat", "data": {} },
                       { "id": "i", "name": "Improved Critical (Rapier)", "kind": "feat", "data": {} },
                       { "id": "t", "name": "Finesse Training (Ex)", "kind": "feature", "data": { "choose": "Weapon", "choice": "Dagger, Rapier" } },
                       { "id": "c", "name": "Fighter", "kind": "class", "data": { "levels": 4 } },
                       { "id": "d", "name": "Rogue", "kind": "class", "data": { "levels": 2 } },
                       { "id": "w", "name": "Weapon Focus (Longsword)", "kind": "feat", "data": { "choice": "Longsword" } },
                       { "id": "s", "name": "Skill Focus (Knowledge (arcana))", "kind": "feat", "data": { "choice": "Knowledge (arcana)", "choice_key": "knowledge_arcana" } } ]
        })).unwrap();
        let rules = Rules::default();
        let r = |f: &str, n: &str| Requirement { requires: f.into(), note: n.into() };
        let got = check(&actor, &rules, &[
            r("", ""),
            r("@str >= 13 && has_item('feat', 'Power Attack')", ""),
            r("@str >= 15", ""),
            r("@bab >= 1", "a deity"),
            r("@bab >= 5", "a deity"),
            r("", "Wis 13"),
            r("@str >=", ""),
            // "Weapon Focus" is met by any Weapon Focus (…).
            r("has_item('feat', 'Weapon Focus')", ""),
            // A class's own levels: "fighter level 4th".
            r("sum_items('class', 'levels', 'name', 'fighter') >= 4", ""),
            r("sum_items('class', 'levels', 'name', 'Rogue') >= 3", ""),
            // Taken for a choice: by its label or its key, and not for another one.
            r("has_item('feat', 'Weapon Focus', 'longsword')", ""),
            r("has_item('feat', 'Weapon Focus', 'Dagger')", ""),
            r("has_item('feat', 'Skill Focus', 'knowledge_arcana')", ""),
            r("has_item('feat', 'Power Attack', 'Longsword')", ""),
            // Named by hand, with no stored choice.
            r("has_item('feat', 'Improved Critical', 'rapier')", ""),
            // A feature taken for several weapons, any kind of item.
            r("has_item('', 'Finesse Training', 'Rapier')", ""),
            r("has_item('', 'Finesse Training', 'Whip')", ""),
        ]);
        assert_eq!(got, vec![Met::Yes, Met::Yes, Met::No, Met::Check, Met::No, Met::Check, Met::Check, Met::Yes, Met::Yes, Met::No, Met::Yes, Met::No, Met::Yes, Met::No, Met::Yes, Met::Yes, Met::No]);
        assert_eq!(Requirement::of(&json!({ "requires": " @str > 1 ", "requires_note": "x" })).requires, "@str > 1");
    }
}
