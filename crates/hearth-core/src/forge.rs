//! The item forge: making items from a base item plus attached parts (a weapon's
//! enhancement and flaming ability, armor's mithral), priced and checked by the
//! system's own formulas, and optionally crafted by a character (feat, skill check,
//! cost in money).
//!
//! An item type declares it in its rules (`forge`):
//!
//! ```json
//! { "price": "@item.value + 2000 * (@item.enhancement + sum_parts('bonus')) * (@item.enhancement + sum_parts('bonus'))",
//!   "parts": ["enchantment"], "fits": "@part.applies_to == 'weapon'",
//!   "checks": [ { "when": "@item.enhancement > 5", "message": "Enhancement goes up to +5" } ],
//!   "craft": { "feat": "'Craft Magic Arms and Armor'", "bonus": "@skills.spellcraft.total",
//!              "dc": "5 + @item.cl", "cost": "@item.price / 2", "days": "ceil(@item.price / 1000)",
//!              "currency": "gp" } }
//! ```
//!
//! Formulas see the item as `@item` (with its type's formulas, its parts' changes and
//! `sum_parts` / `max_parts` / `count_parts`) and the crafter's values as usual. `@price`
//! is the worked-out price. `fits` sees the part as `@part`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::formula::Val;
use crate::model::{Actor, Item};
use crate::rules::{Engine, Rules};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Forge {
    /// The item's price, a formula.
    #[serde(default)]
    pub price: String,
    /// Item types that can be attached as parts (abilities, materials).
    #[serde(default)]
    pub parts: Vec<String>,
    /// Whether a part fits this item (`@part` is the part, `@item` the item). Empty: any.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fits: String,
    /// Rules the item must keep; each is a problem when `when` is true.
    #[serde(default)]
    pub checks: Vec<ForgeCheck>,
    /// Crafting by a character.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub craft: Option<Craft>,
    /// A name for what's being made (e.g. `'Wand of ' + parts('name')[0]`); the forge uses it
    /// until the maker types their own.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ForgeCheck {
    pub when: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Craft {
    /// The feat it needs, a formula giving its name (`''`: none).
    #[serde(default)]
    pub feat: String,
    /// The crafter's check bonus (e.g. `@skills.spellcraft.total`).
    #[serde(default)]
    pub bonus: String,
    #[serde(default)]
    pub dc: String,
    /// What it costs to make.
    #[serde(default)]
    pub cost: String,
    /// How long it takes, in days.
    #[serde(default)]
    pub days: String,
    /// The crafter's money to spend from (a number in their data, e.g. `gp`).
    #[serde(default)]
    pub currency: String,
}

/// What the forge shows for an item: its price, the rules it breaks, the parts that fit,
/// and (for a crafter) the feat, check, cost and time.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Preview {
    pub price: f64,
    /// The suggested name, if the type has a name formula.
    pub name: Option<String>,
    pub problems: Vec<String>,
    /// For each candidate part offered (by index), whether it fits.
    pub fits: Vec<bool>,
    pub craft: Option<CraftPreview>,
    /// The item's calculated values (its type formulas, with parts applied).
    pub values: Value,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct CraftPreview {
    pub feat: String,
    pub has_feat: bool,
    pub bonus: f64,
    pub dc: f64,
    pub cost: f64,
    pub days: f64,
    pub currency: String,
    /// The crafter's money now.
    pub money: f64,
}

/// The forge rules for an item's type, if it has any.
pub fn forge_for<'r>(rules: &'r Rules, kind: &str) -> Option<&'r Forge> {
    rules.item_types.get(kind).and_then(|t| t.forge.as_ref())
}

fn part_val(p: &Item) -> Val {
    let mut v = Val::from_json(&p.data);
    if let Val::Map(m) = &mut v {
        m.insert("name".into(), Val::Str(p.name.clone()));
        m.insert("kind".into(), Val::Str(p.kind.clone()));
    }
    v
}

/// Work out an item at the forge, for a crafter (or a stand-in actor for the GM).
pub fn preview(actor: &Actor, rules: &Rules, item: &Item, candidates: &[Item]) -> Result<Preview, String> {
    let forge = forge_for(rules, &item.kind).ok_or_else(|| format!("{} items can't be made at the forge", item.kind))?;
    let mut view = actor.clone();
    view.items.push(item.clone());
    let idx = view.items.len() - 1;
    let mut eng = Engine::new(&view, rules);
    eng.set_item(Some(idx));
    let price = if forge.price.trim().is_empty() { 0.0 } else { eng.eval_src(&forge.price).num() };
    eng.vars.insert("price".into(), Val::Num(price));
    let mut problems = vec![];
    for c in &forge.checks {
        if eng.eval_src(&c.when).truthy() {
            problems.push(c.message.clone());
        }
    }
    let fits_one = |eng: &mut Engine, p: &Item| -> bool {
        if !forge.parts.is_empty() && !forge.parts.contains(&p.kind) {
            return false;
        }
        if forge.fits.trim().is_empty() {
            return true;
        }
        eng.vars.insert("part".into(), part_val(p));
        let ok = eng.eval_src(&forge.fits).truthy();
        eng.vars.remove("part");
        ok
    };
    for p in &item.parts {
        if !fits_one(&mut eng, p) {
            problems.push(format!("{} can't go on this", p.name));
        }
    }
    let fits = candidates.iter().map(|p| fits_one(&mut eng, p)).collect();
    let craft = forge.craft.as_ref().map(|c| {
        let text = |eng: &mut Engine, f: &str| if f.trim().is_empty() { String::new() } else { eng.eval_src(f).to_string() };
        let num = |eng: &mut Engine, f: &str| if f.trim().is_empty() { 0.0 } else { eng.eval_src(f).num() };
        let feat = text(&mut eng, &c.feat);
        let has_feat = feat.is_empty() || actor.items.iter().any(|i| i.name.eq_ignore_ascii_case(&feat));
        let money = actor.data.pointer(&format!("/{}", c.currency.replace('.', "/"))).and_then(Value::as_f64).unwrap_or(0.0);
        CraftPreview { bonus: num(&mut eng, &c.bonus), dc: num(&mut eng, &c.dc), cost: num(&mut eng, &c.cost), days: num(&mut eng, &c.days), feat, has_feat, currency: c.currency.clone(), money }
    });
    // The item's own calculated values, for the forge to show (damage with flaming…).
    let mut values = serde_json::Map::new();
    if let Some(t) = rules.item_types.get(&item.kind) {
        let mut keys: Vec<String> = t.formulas.keys().filter(|k| !k.contains('*')).cloned().collect();
        if let Some(o) = item.data.as_object() {
            keys.extend(o.keys().cloned());
        }
        keys.sort();
        keys.dedup();
        for k in keys {
            let v = eng.item_value(idx, &k.split('.').map(String::from).collect::<Vec<_>>());
            values.insert(k, v.to_json());
        }
    }
    let name = (!forge.name.trim().is_empty()).then(|| eng.eval_src(&forge.name).to_string()).filter(|n| !n.trim().is_empty());
    Ok(Preview { price, name, problems, fits, craft, values: Value::Object(values) })
}

/// The result of crafting: what was rolled and whether it worked, and what it cost.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Crafted {
    pub success: bool,
    pub total: i64,
    pub dc: f64,
    pub cost: f64,
    pub days: f64,
    pub currency: String,
}

/// Craft an item as a character: they need the feat and the money; the check is rolled
/// (`roll` rolls dice and returns the total). The money is spent either way; the item is
/// made only on a success. Returns the result and the money left.
pub fn craft(actor: &Actor, rules: &Rules, item: &Item, roll: &mut dyn FnMut(&str) -> Result<i64, String>) -> Result<(Crafted, f64), String> {
    let p = preview(actor, rules, item, &[])?;
    if !p.problems.is_empty() {
        return Err(format!("It can't be made like this: {}", p.problems.join("; ")));
    }
    let c = p.craft.ok_or("This system has no crafting rules for that")?;
    if !c.has_feat {
        return Err(format!("{} needs the {} feat", actor.name, c.feat));
    }
    if c.cost > c.money {
        return Err(format!("{} needs {} {} and has {}", actor.name, c.cost, c.currency, c.money));
    }
    let total = roll(&format!("1d20 + {}", c.bonus))?;
    let done = Crafted { success: total as f64 >= c.dc, total, dc: c.dc, cost: c.cost, days: c.days, currency: c.currency.clone() };
    Ok((done, c.money - c.cost))
}

/// The JSON patch putting `amount` at a data path (`gp`, `currency.gp`).
pub fn money_patch(path: &str, amount: f64) -> Value {
    let mut v = json!(amount);
    for seg in path.split('.').rev() {
        v = json!({ seg: v });
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        serde_json::from_value(json!({
            "item_types": {
                "weapon": {
                    "formulas": { "attack": "@abilities.str.mod + @item.enhancement" },
                    "forge": {
                        "price": "@item.value + (@item.enhancement > 0 ? 300 : 0) + 2000 * (@item.enhancement + sum_parts('bonus')) * (@item.enhancement + sum_parts('bonus'))",
                        "parts": ["ability"],
                        "fits": "@part.applies_to == 'weapon'",
                        "checks": [
                            { "when": "@item.enhancement > 5", "message": "Enhancement goes up to +5" },
                            { "when": "count_parts() > 0 && @item.enhancement < 1", "message": "Abilities need at least +1" }
                        ],
                        "craft": { "feat": "'Craft Magic Arms and Armor'", "bonus": "@skill", "dc": "5 + 3 * @item.enhancement",
                                   "cost": "@price / 2", "days": "ceil(@price / 1000)", "currency": "gp" }
                    }
                },
                "ability": {}, "feat": {}
            }
        })).unwrap()
    }

    fn sword(enh: i64, parts: Value) -> Item {
        serde_json::from_value(json!({ "id": "", "name": "Longsword", "kind": "weapon", "data": { "value": 15, "enhancement": enh, "damage": "1d8" }, "parts": parts })).unwrap()
    }

    fn flaming() -> Value {
        json!({ "id": "f", "name": "Flaming", "kind": "ability", "data": { "bonus": 1, "applies_to": "weapon" },
                "effects": [ { "changes": [ { "path": "item.damage", "mode": "add", "value": "'1d6'" } ] } ] })
    }

    fn smith(feat: bool) -> Actor {
        let items = if feat { json!([{ "id": "c", "name": "Craft Magic Arms and Armor", "kind": "feat", "data": {} }]) } else { json!([]) };
        serde_json::from_value(json!({ "id": "a", "name": "Smith", "kind": "character", "data": { "gp": 20000, "skill": 10, "abilities": { "str": { "mod": 3 } } }, "items": items })).unwrap()
    }

    #[test]
    fn prices_checks_parts_and_crafting() {
        let r = rules();
        // +1 flaming longsword: 15 + 300 + 2000 × 2² = 8315; flaming adds 1d6 to its damage.
        let p = preview(&smith(true), &r, &sword(1, json!([flaming()])), &[]).unwrap();
        assert_eq!(p.price, 8315.0);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.values["damage"], "1d8+1d6");
        let c = p.craft.unwrap();
        assert_eq!((c.cost, c.days, c.dc, c.has_feat), (4157.5, 9.0, 8.0, true));
        // Breaking the rules is reported.
        let p = preview(&smith(true), &r, &sword(0, json!([flaming()])), &[]).unwrap();
        assert_eq!(p.problems, vec!["Abilities need at least +1"]);
        // A part that doesn't fit is reported, and candidates are marked.
        let armorish: Item = serde_json::from_value(json!({ "id": "x", "name": "Shadow", "kind": "ability", "data": { "applies_to": "armor" } })).unwrap();
        let p = preview(&smith(true), &r, &sword(1, json!([])), &[armorish, serde_json::from_value(flaming()).unwrap()]).unwrap();
        assert_eq!(p.fits, vec![false, true]);
        // Crafting: needs the feat; a roll that meets the DC makes it, and the money is spent.
        assert!(craft(&smith(false), &r, &sword(1, json!([])), &mut |_| Ok(20)).unwrap_err().contains("feat"));
        let (done, left) = craft(&smith(true), &r, &sword(1, json!([])), &mut |f| { assert_eq!(f, "1d20 + 10"); Ok(12) }).unwrap();
        assert!(done.success);
        assert_eq!(left, 20000.0 - 1157.5, "a +1 sword is 2315 gp; crafting costs half");
        let (done, _) = craft(&smith(true), &r, &sword(1, json!([])), &mut |_| Ok(7)).unwrap();
        assert!(!done.success);
    }
}

#[cfg(test)]
mod consumable_tests {
    use super::*;

    #[test]
    fn a_wand_rolls_its_spell_at_its_own_caster_level() {
        let rules: Rules = serde_json::from_value(json!({
            "item_types": { "consumable": { "formulas": {
                "spell_roll": "replace(parts('roll')[0], '@spells.caster_level', text(@item.cl))"
            } } }
        })).unwrap();
        let actor: Actor = serde_json::from_value(json!({ "id": "a", "name": "Ann", "kind": "character", "data": { "spells": { "caster_level": 1 } },
            "items": [ { "id": "w", "name": "Wand of fireball", "kind": "consumable", "data": { "cl": 5 },
                "parts": [ { "id": "f", "name": "Fireball", "kind": "spell", "data": { "roll": "{min(10, 1 * @spells.caster_level)}d6" } } ] } ] })).unwrap();
        let mut eng = Engine::new(&actor, &rules);
        eng.set_item(Some(0));
        assert_eq!(crate::rules::fill(&mut eng, "@item.spell_roll").replace(' ', ""), "(5d6)", "the wand's CL 5, not Ann's 1");
    }
}

#[cfg(test)]
mod crit_tests {
    use super::*;
    use crate::rules::{plan_action, ActionOptions};

    #[test]
    fn threat_ranges_and_multiplied_criticals() {
        let rules: Rules = serde_json::from_value(json!({ "item_types": { "weapon": { "actions": [
            { "id": "hit", "label": "Attack", "kind": "attack", "roll": "1d20 + 5", "threat": "21 - (21 - @item.threat) * (@item.keen ? 2 : 1)", "confirm": true },
            { "id": "dmg", "label": "Damage", "kind": "damage", "roll": "1d12 + 3", "crit_mult": "@item.mult" }
        ] } } })).unwrap();
        let axe = |keen: bool| -> Actor {
            serde_json::from_value(json!({ "id": "a", "name": "A", "kind": "c", "data": {},
                "items": [ { "id": "x", "name": "Greataxe", "kind": "weapon", "data": { "threat": 19, "keen": keen, "mult": 3 } } ] })).unwrap()
        };
        let p = plan_action(&axe(false), &rules, Some("x"), "hit", &ActionOptions::default()).unwrap();
        assert_eq!((p.threat, p.confirm), (19, true));
        assert_eq!(plan_action(&axe(true), &rules, Some("x"), "hit", &ActionOptions::default()).unwrap().threat, 17, "keen doubles 19–20 to 17–20");
        let crit = ActionOptions { crit: true, ..Default::default() };
        assert_eq!(plan_action(&axe(false), &rules, Some("x"), "dmg", &crit).unwrap().formula, "(1d12 + 3) + (1d12 + 3) + (1d12 + 3)", "×3 rolls the damage three times");
    }

    #[test]
    fn has_item_finds_a_known_spell() {
        let rules = Rules::default();
        let a: Actor = serde_json::from_value(json!({ "id": "a", "name": "A", "kind": "c", "data": {}, "items": [ { "id": "s", "name": "Fireball", "kind": "spell", "data": {} } ] })).unwrap();
        let mut eng = Engine::new(&a, &rules);
        assert!(eng.eval_src("has_item('spell', 'fireball')").truthy());
        assert!(!eng.eval_src("has_item('spell', 'Wish')").truthy());
    }
}

#[cfg(test)]
mod more_tests {
    use super::*;
    use crate::rules::{plan_action, ActionOptions};

    #[test]
    fn spells_spend_from_their_class_and_staves_rank_their_spells() {
        let rules: Rules = serde_json::from_value(json!({ "item_types": {
            "class": {}, "spell": { "actions": [ { "id": "cast", "label": "Cast", "kind": "other", "roll": "",
                "cost": { "path": "item[class:{@item.caster_class}].slots.l{@item.level}", "amount": "1" } } ] } } })).unwrap();
        let actor = |caster: &str| -> Actor {
            serde_json::from_value(json!({ "id": "a", "name": "Ann", "kind": "c", "data": {}, "items": [
                { "id": "w", "name": "Wizard", "kind": "class", "data": { "slots": { "l1": { "value": 0, "max": 2 } } } },
                { "id": "c", "name": "Cleric", "kind": "class", "data": { "slots": { "l1": { "value": 1, "max": 2 } } } },
                { "id": "s", "name": "Bless", "kind": "spell", "data": { "level": 1, "caster_class": caster } } ] })).unwrap()
        };
        let opts = ActionOptions::default();
        let p = plan_action(&actor("Cleric"), &rules, Some("s"), "cast", &opts).unwrap();
        assert_eq!(p.spend.as_ref().unwrap().0.as_deref(), Some("c"), "spent from the cleric");
        assert!(plan_action(&actor("Wizard"), &rules, Some("s"), "cast", &opts).unwrap_err().contains("Not enough"));
        let p = plan_action(&actor(""), &rules, Some("s"), "cast", &opts).unwrap();
        assert_eq!(p.spend.unwrap().0.as_deref(), Some("c"), "no class named: the first with a slot left");

        // nth_parts: highest, second highest.
        let staff: Actor = serde_json::from_value(json!({ "id": "a", "name": "A", "kind": "c", "data": {}, "items": [ { "id": "x", "name": "Staff", "kind": "staff", "data": {},
            "parts": [ { "id": "1", "name": "A", "kind": "spell", "data": { "level": 2 } }, { "id": "2", "name": "B", "kind": "spell", "data": { "level": 4 } }, { "id": "3", "name": "C", "kind": "spell", "data": { "level": 3 } } ] } ] })).unwrap();
        let r = Rules::default();
        let mut eng = Engine::new(&staff, &r);
        eng.set_item(Some(0));
        assert_eq!((eng.eval_src("nth_parts('level', 1)").num(), eng.eval_src("nth_parts('level', 2)").num(), eng.eval_src("nth_parts('level', 4)").num()), (4.0, 3.0, 0.0));
    }
}
