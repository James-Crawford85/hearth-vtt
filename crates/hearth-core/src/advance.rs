//! Advancement: classes that give features as they level, and ancestries or
//! backgrounds that give features when added.
//!
//! An item's `advancement` lists grants, each at a level:
//!
//! | kind     | does                                                                |
//! |----------|---------------------------------------------------------------------|
//! | `items`  | adds copies of `items` to the actor                                 |
//! | `choice` | the player picks `count` of `items`                                 |
//! | `points` | the player spends `amount` points on entries of a list (`path`), e.g. +2 to abilities |
//! | `roll`   | rolls `formula` (or takes the average) and appends it to the item's `path` list, e.g. hit points |
//!
//! Item types with a `levels` field (classes) gain a level each time; their
//! grants for that level apply, plus the grants of items they gave that have
//! advancement of their own (subclasses), keyed by the same class level.
//! Other items (ancestries, backgrounds) apply all their grants when added.
//!
//! Everything a level gave is logged on the item (`flags.core.advancement`),
//! so a level can be taken back exactly.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::formula::Val;
use crate::model::{Actor, Item};
use crate::ops::Op;
use crate::rules::{fill, Engine, Rules};
use crate::{new_id, Id};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrantKind {
    #[default]
    Items,
    Choice,
    Points,
    Roll,
}

/// Something an item gives at a level (classes) or when added (others).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Grant {
    #[serde(default)]
    pub id: Id,
    /// The level it comes at (classes). 0 or 1: when the item is added.
    #[serde(default)]
    pub level: u32,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub kind: GrantKind,
    /// `items`: what's given. `choice`: what's picked from.
    #[serde(default)]
    pub items: Vec<Item>,
    /// `choice`: how many to pick (default 1).
    #[serde(default)]
    pub count: u32,
    /// `points`: the actor's list (e.g. `abilities`). `roll`: the item's list to record results in (e.g. `hp_rolls`).
    #[serde(default)]
    pub path: String,
    /// `points`: the field raised in each entry (e.g. `value`).
    #[serde(default)]
    pub field: String,
    /// `points`: how many points to spend.
    #[serde(default)]
    pub amount: i64,
    /// `points`: at most this many on one entry (0 = no limit).
    #[serde(default)]
    pub max_each: i64,
    /// `points`: no entry may go above this.
    #[serde(default)]
    pub cap: Option<i64>,
    /// `points`: only these entries may be raised (empty: any), e.g. the skills a class picks from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub only: Vec<String>,
    /// `roll`: the dice (e.g. `1d{@item.hit_die}`); `{}` blocks and `@paths` are filled in.
    #[serde(default)]
    pub formula: String,
    /// `roll`: the player may take the average instead.
    #[serde(default)]
    pub average: bool,
    /// Classes: comes again every this many levels after `level` (0: once), e.g. hit
    /// points from level 2 with every 1, or ability points from 4 with every 4.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub every: u32,
    /// Classes: a repeating grant stops after this level (0: no end).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub until: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl Grant {
    /// Whether this grant comes at a class level.
    pub fn comes_at(&self, level: u32) -> bool {
        let first = self.level.max(1);
        if level < first || (self.until > 0 && level > self.until) {
            return false;
        }
        if self.every == 0 {
            return level == first;
        }
        (level - first) % self.every == 0
    }

    /// Whether it comes at any level up to `level` (for a sub-item gained now).
    fn came_by(&self, level: u32) -> bool {
        (1..=level).any(|l| self.comes_at(l))
    }
}

/// What the player picked in the level-up dialog.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AdvanceRequest {
    /// Level up this item (a class the actor has)…
    #[serde(default)]
    pub item_id: Option<Id>,
    /// …or add this one (a new class, an ancestry, a background).
    #[serde(default)]
    pub add: Option<Item>,
    /// `choice` grants: grant id → indexes of the picked items.
    #[serde(default)]
    pub choices: BTreeMap<Id, Vec<usize>>,
    /// `points` grants: grant id → entry key → points.
    #[serde(default)]
    pub points: BTreeMap<Id, BTreeMap<String, i64>>,
    /// `roll` grants: grant id → `"average"` to take the average (otherwise rolled).
    #[serde(default)]
    pub rolls: BTreeMap<Id, String>,
}

/// The ops a level-up makes, and a summary for chat.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Advance {
    pub ops: Vec<Op>,
    pub level: u32,
    pub item_name: String,
    pub gained: Vec<String>,
}

/// The data key holding an item type's level (classes), if it has one.
pub fn levels_key<'r>(rules: &'r Rules, kind: &str) -> Option<&'r str> {
    rules.item_types.get(kind).and_then(|t| t.levels.as_deref()).filter(|k| !k.is_empty())
}

fn level_of(item: &Item, key: &str) -> u32 {
    item.data.get(key).and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as u32
}

/// The grants that come at `level` from `item` (and its sub-items), in order.
pub fn grants_at<'a>(item: &'a Item, level: u32, leveled: bool) -> Vec<&'a Grant> {
    item.advancement
        .iter()
        .filter(|g| if leveled { g.comes_at(level) } else { g.level <= 1 })
        .collect()
}

/// Work out a level-up (or adding an item with grants). `roll` rolls a dice
/// formula and returns the total.
pub fn advance(
    actor: &Actor,
    rules: &Rules,
    req: &AdvanceRequest,
    roll: &mut dyn FnMut(&str) -> Result<i64, String>,
) -> Result<Advance, String> {
    // The item that's advancing: an existing one, or a fresh copy being added.
    let (mut target, is_new) = match (&req.item_id, &req.add) {
        (Some(id), _) => (actor.items.iter().find(|i| &i.id == id).cloned().ok_or("That item isn't on this character")?, false),
        (None, Some(add)) => {
            let mut it = add.clone();
            it.id = new_id();
            (it, true)
        }
        (None, None) => return Err("Pick something to level up or add".into()),
    };
    let lkey = levels_key(rules, &target.kind).map(String::from);
    let level = match &lkey {
        Some(k) => level_of(&target, k) + 1,
        None if is_new => 1,
        None => return Err(format!("{} doesn't have levels", target.name)),
    };
    if level > 100 {
        return Err("That's as high as levels go".into());
    }
    if is_new && lkey.is_none() && actor.items.iter().any(|i| i.kind == target.kind && i.name == target.name) {
        return Err(format!("{} already has {}", actor.name, target.name));
    }

    // An actor with the new item on it, so formulas (e.g. @item.hit_die) see it.
    let mut view = actor.clone();
    if is_new {
        view.items.push(target.clone());
    }
    let target_idx = view.items.iter().position(|i| i.id == target.id).unwrap();

    let mut out = Advance { level, item_name: target.name.clone(), ..Default::default() };
    let mut creates: Vec<Item> = vec![];
    let mut actor_data = actor.data.clone();
    let mut log_items: Vec<Id> = vec![];
    let mut log_points: Map<String, Value> = Map::new();
    let mut log_rolls: Vec<Value> = vec![];

    // This item's grants, then those of items it gave that advance with it (subclasses).
    let mut sources: Vec<(Item, bool)> = vec![(target.clone(), lkey.is_some())];
    for it in &actor.items {
        if it.flags.pointer("/core/granted_by/item").and_then(Value::as_str) == Some(target.id.as_str()) && !it.advancement.is_empty() {
            sources.push((it.clone(), true));
        }
    }
    let mut i = 0;
    while i < sources.len() {
        let (src, leveled) = sources[i].clone();
        i += 1;
        // A sub-item gained just now applies everything up to this level.
        let fresh = i > 1 && !actor.items.iter().any(|x| x.id == src.id);
        let grants: Vec<&Grant> = if fresh { src.advancement.iter().filter(|g| g.came_by(level)).collect() } else { grants_at(&src, level, leveled) };
        for g in grants {
            let name = if g.label.is_empty() { src.name.clone() } else { g.label.clone() };
            match g.kind {
                GrantKind::Items | GrantKind::Choice => {
                    let picked: Vec<&Item> = if g.kind == GrantKind::Items {
                        g.items.iter().collect()
                    } else {
                        let want = g.count.max(1) as usize;
                        let idx = req.choices.get(&g.id).cloned().unwrap_or_default();
                        let mut seen = idx.clone();
                        seen.sort_unstable();
                        seen.dedup();
                        if seen.len() != want.min(g.items.len()) || seen.iter().any(|&n| n >= g.items.len()) {
                            return Err(format!("{name}: pick {want}"));
                        }
                        seen.iter().map(|&n| &g.items[n]).collect()
                    };
                    for it in picked {
                        let mut copy = it.clone();
                        copy.id = new_id();
                        let mut flags = if copy.flags.is_object() { copy.flags.clone() } else { json!({}) };
                        crate::patch::merge_patch(&mut flags, &json!({ "core": { "granted_by": { "item": target.id, "level": level, "grant": g.id } } }));
                        copy.flags = flags;
                        out.gained.push(copy.name.clone());
                        log_items.push(copy.id.clone());
                        // A granted item with advancement of its own (a subclass) joins in.
                        if !copy.advancement.is_empty() {
                            sources.push((copy.clone(), true));
                        }
                        creates.push(copy);
                    }
                }
                GrantKind::Points => {
                    let field = if g.field.is_empty() { "value" } else { g.field.as_str() };
                    // What can be raised: the actor's entries in the list (only the allowed ones), up to the caps.
                    let list_ptr = format!("/{}", g.path.replace('.', "/"));
                    let entries: Vec<String> = actor_data.pointer(&list_ptr).and_then(Value::as_object)
                        .map(|o| o.keys().filter(|k| g.only.is_empty() || g.only.contains(k)).cloned().collect())
                        .unwrap_or_default();
                    let room: i64 = entries.iter().map(|k| {
                        let cur = actor_data.pointer(&format!("{list_ptr}/{k}/{field}")).and_then(Value::as_f64).unwrap_or(0.0) as i64;
                        let by_cap = g.cap.map_or(i64::MAX, |c| (c - cur).max(0));
                        let by_each = if g.max_each > 0 { g.max_each } else { i64::MAX };
                        by_cap.min(by_each).min(g.amount.max(0))
                    }).sum();
                    let want = g.amount.min(room).max(0);
                    if want == 0 {
                        // Nothing this actor can raise (e.g. a monster has no skills list): skip it.
                        out.gained.push(format!("{name}: nothing to choose here"));
                        continue;
                    }
                    let spent = req.points.get(&g.id).cloned().unwrap_or_default();
                    let total: i64 = spent.values().sum();
                    if spent.values().any(|&n| n < 0) || total != want {
                        return Err(format!("{name}: spend {} point{}", want, if want == 1 { "" } else { "s" }));
                    }
                    if let Some(bad) = spent.iter().find(|(k, n)| **n > 0 && !entries.contains(k)) {
                        return Err(format!("{name}: {} isn't one of the choices", bad.0));
                    }
                    let mut changed = Map::new();
                    for (entry, n) in &spent {
                        if *n == 0 {
                            continue;
                        }
                        if g.max_each > 0 && *n > g.max_each {
                            return Err(format!("{name}: at most {} on one", g.max_each));
                        }
                        let ptr = format!("/{}/{entry}/{field}", g.path.replace('.', "/"));
                        let cur = actor_data.pointer(&ptr).and_then(Value::as_f64).ok_or_else(|| format!("{name}: there's no {entry}"))?;
                        let new = cur as i64 + n;
                        if g.cap.is_some_and(|c| new > c) {
                            return Err(format!("{name}: {entry} can't go above {}", g.cap.unwrap()));
                        }
                        *actor_data.pointer_mut(&ptr).unwrap() = json!(new);
                        changed.insert(entry.clone(), json!(n));
                        out.gained.push(format!("+{n} {entry}"));
                    }
                    log_points.insert(format!("{}.{}", g.path, field), Value::Object(changed));
                }
                GrantKind::Roll => {
                    let mut eng = Engine::new(&view, rules);
                    eng.set_item(Some(target_idx));
                    let dice = fill(&mut eng, &g.formula);
                    // No dice (e.g. a full hit die at level 1): just work it out.
                    let value = if !dice.contains('d') {
                        average(&dice).ok_or_else(|| format!("{name}: {dice} isn't a number"))?
                    } else if g.average && req.rolls.get(&g.id).map(String::as_str) == Some("average") {
                        average(&dice).ok_or_else(|| format!("{name}: can't average {dice}"))?
                    } else {
                        roll(&dice)?
                    };
                    let mut list = target.data.get(&g.path).and_then(Value::as_array).cloned().unwrap_or_default();
                    list.push(json!(value));
                    set_data(&mut target, &g.path, Value::Array(list));
                    log_rolls.push(json!({ "path": g.path, "value": value }));
                    out.gained.push(format!("{name}: {value}"));
                }
            }
        }
    }

    // The level itself, and the log for taking it back.
    if let Some(k) = &lkey {
        set_data(&mut target, k, json!(level));
    }
    let mut flags = if target.flags.is_object() { target.flags.clone() } else { json!({}) };
    let mut at_level = Map::new();
    at_level.insert(level.to_string(), json!({ "items": log_items, "points": log_points, "rolls": log_rolls }));
    crate::patch::merge_patch(&mut flags, &json!({ "core": { "advancement": Value::Object(at_level) } }));
    target.flags = flags;

    if actor_data != actor.data {
        out.ops.push(Op::ActorUpdate { id: actor.id.clone(), patch: json!({ "data": diff(&actor.data, &actor_data) }) });
    }
    if is_new {
        out.ops.push(Op::ItemCreate { actor_id: actor.id.clone(), item: target.clone() });
    } else {
        out.ops.push(Op::ItemUpdate { actor_id: actor.id.clone(), id: target.id.clone(), patch: json!({ "data": target.data, "flags": target.flags }) });
    }
    for it in creates {
        out.ops.push(Op::ItemCreate { actor_id: actor.id.clone(), item: it });
    }
    Ok(out)
}

/// Take back an item's last level (or remove an item without levels), undoing what it gave.
pub fn regress(actor: &Actor, rules: &Rules, item_id: &str) -> Result<Advance, String> {
    let target = actor.items.iter().find(|i| i.id == item_id).ok_or("That item isn't on this character")?;
    let lkey = levels_key(rules, &target.kind);
    let level = match lkey {
        Some(k) => level_of(target, k),
        None => 1,
    };
    let log = target.flags.pointer(&format!("/core/advancement/{level}")).cloned().unwrap_or(Value::Null);
    let mut out = Advance { level, item_name: target.name.clone(), ..Default::default() };
    // Items it gave at this level (by log, or by their own note).
    let mut remove: Vec<Id> = log.get("items").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    let removing_all = lkey.is_none() || level <= 1;
    for it in &actor.items {
        let by = it.flags.pointer("/core/granted_by/item").and_then(Value::as_str);
        let at = it.flags.pointer("/core/granted_by/level").and_then(Value::as_u64).unwrap_or(0) as u32;
        if by == Some(item_id) && (removing_all || at == level) && !remove.contains(&it.id) {
            remove.push(it.id.clone());
        }
    }
    // Points back.
    let mut data = actor.data.clone();
    if let Some(points) = log.get("points").and_then(Value::as_object) {
        for (path, entries) in points {
            let (list, field) = path.rsplit_once('.').unwrap_or((path, "value"));
            for (entry, n) in entries.as_object().into_iter().flatten() {
                let ptr = format!("/{}/{entry}/{field}", list.replace('.', "/"));
                if let Some(v) = data.pointer_mut(&ptr) {
                    *v = json!(v.as_f64().unwrap_or(0.0) as i64 - n.as_i64().unwrap_or(0));
                }
            }
        }
    }
    if data != actor.data {
        out.ops.push(Op::ActorUpdate { id: actor.id.clone(), patch: json!({ "data": diff(&actor.data, &data) }) });
    }
    if removing_all {
        out.ops.push(Op::ItemDelete { actor_id: actor.id.clone(), id: item_id.to_string() });
    } else {
        let mut t = target.clone();
        for r in log.get("rolls").and_then(Value::as_array).into_iter().flatten() {
            let path = r.get("path").and_then(Value::as_str).unwrap_or_default();
            if let Some(mut list) = t.data.get(path).and_then(Value::as_array).cloned() {
                list.pop();
                set_data(&mut t, path, Value::Array(list));
            }
        }
        set_data(&mut t, lkey.unwrap(), json!(level - 1));
        let mut gone = Map::new();
        gone.insert(level.to_string(), Value::Null);
        out.ops.push(Op::ItemUpdate {
            actor_id: actor.id.clone(),
            id: item_id.to_string(),
            patch: json!({ "data": t.data, "flags": { "core": { "advancement": Value::Object(gone) } } }),
        });
    }
    for id in remove {
        if actor.items.iter().any(|i| i.id == id) {
            out.gained.push(actor.items.iter().find(|i| i.id == id).map(|i| i.name.clone()).unwrap_or_default());
            out.ops.push(Op::ItemDelete { actor_id: actor.id.clone(), id });
        }
    }
    Ok(out)
}

fn set_data(item: &mut Item, key: &str, v: Value) {
    if !item.data.is_object() {
        item.data = json!({});
    }
    item.data.as_object_mut().unwrap().insert(key.to_string(), v);
}

/// A merge patch turning `a` into `b` (objects only; enough for data changes).
fn diff(a: &Value, b: &Value) -> Value {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let mut out = Map::new();
            for (k, bv) in y {
                match x.get(k) {
                    Some(av) if av == bv => {}
                    Some(av) if av.is_object() && bv.is_object() => {
                        out.insert(k.clone(), diff(av, bv));
                    }
                    _ => {
                        out.insert(k.clone(), bv.clone());
                    }
                }
            }
            Value::Object(out)
        }
        _ => b.clone(),
    }
}

/// The average of a dice formula, rounded up (`1d10` → 6, `2d6 + 1` → 8).
pub fn average(dice: &str) -> Option<i64> {
    // Replace each NdX with its average, then work out the arithmetic.
    let b = dice.as_bytes();
    let mut s = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'd' && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
            let mut start = s.len();
            while start > 0 && s.as_bytes()[start - 1].is_ascii_digit() {
                start -= 1;
            }
            let n: f64 = if start == s.len() { 1.0 } else { s[start..].parse().ok()? };
            s.truncate(start);
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let sides: f64 = dice[i + 1..j].parse().ok()?;
            s.push_str(&format!("({})", n * (sides + 1.0) / 2.0));
            i = j;
            continue;
        }
        s.push(b[i] as char);
        i += 1;
    }
    let ast = crate::formula::parse(&s).ok()?;
    struct Nothing;
    impl crate::formula::Scope for Nothing {
        fn path(&mut self, _: &[String]) -> Val {
            Val::Null
        }
    }
    let v = crate::formula::eval(&ast, &mut Nothing).ok()?.num();
    Some(v.ceil() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::World;

    fn rules() -> Rules {
        serde_json::from_value(json!({
            "item_types": { "class": { "levels": "levels" }, "ancestry": {}, "feature": {}, "subclass": {} }
        }))
        .unwrap()
    }

    fn feature(name: &str) -> Value {
        json!({ "id": name.to_lowercase().replace(' ', "_"), "name": name, "kind": "feature", "data": {} })
    }

    fn fighter() -> Item {
        serde_json::from_value(json!({
            "id": "fighter", "name": "Fighter", "kind": "class", "data": { "levels": 0, "hit_die": 10 },
            "advancement": [
                { "id": "f1", "level": 1, "kind": "items", "items": [feature("Second Wind")] },
                { "id": "hp1", "level": 1, "kind": "roll", "label": "Hit points", "formula": "@item.hit_die", "path": "hp_rolls" },
                { "id": "style", "level": 1, "kind": "choice", "label": "Fighting style", "count": 1, "items": [feature("Archery"), feature("Defense")] },
                { "id": "f2", "level": 2, "kind": "items", "items": [feature("Action Surge")] },
                { "id": "hp", "level": 2, "kind": "roll", "label": "Hit points", "formula": "1d{@item.hit_die}", "path": "hp_rolls", "average": true },
                { "id": "hp3", "level": 3, "kind": "roll", "label": "Hit points", "formula": "1d{@item.hit_die}", "path": "hp_rolls", "average": true },
                { "id": "sub", "level": 3, "kind": "choice", "label": "Subclass", "items": [
                    { "id": "champion", "name": "Champion", "kind": "subclass", "data": {}, "advancement": [
                        { "id": "c3", "level": 3, "kind": "items", "items": [feature("Improved Critical")] },
                        { "id": "c7", "level": 7, "kind": "items", "items": [feature("Remarkable Athlete")] } ] } ] },
                { "id": "asi", "level": 4, "kind": "points", "label": "Ability scores", "path": "abilities", "field": "value", "amount": 2, "max_each": 2, "cap": 20 }
            ]
        }))
        .unwrap()
    }

    fn world() -> World {
        let mut w = World::new("T", "x");
        let a: Actor = serde_json::from_value(json!({ "id": "a", "name": "Ann", "kind": "character",
            "data": { "abilities": { "str": { "value": 15 }, "dex": { "value": 19 } } } })).unwrap();
        w.actors.insert("a".into(), a);
        w
    }

    fn run(w: &mut World, req: AdvanceRequest, roll: i64) -> Result<Advance, String> {
        let a = w.actors["a"].clone();
        let adv = advance(&a, &rules(), &req, &mut |_| Ok(roll))?;
        for op in &adv.ops {
            w.apply(op).unwrap();
        }
        Ok(adv)
    }

    fn names(w: &World) -> Vec<String> {
        let mut n: Vec<String> = w.actors["a"].items.iter().map(|i| i.name.clone()).collect();
        n.sort();
        n
    }

    fn fighter_item(w: &World) -> Item {
        w.actors["a"].items.iter().find(|i| i.kind == "class").unwrap().clone()
    }

    fn fighter_id(w: &World) -> String {
        w.actors["a"].items.iter().find(|i| i.kind == "class").unwrap().id.clone()
    }

    #[test]
    fn levels_a_fighter_up_and_back_down() {
        let r = rules();
        let mut w = world();
        // Level 1: add the class; a fighting style must be picked.
        let add = AdvanceRequest { add: Some(fighter()), ..Default::default() };
        assert!(run(&mut w, add.clone(), 0).unwrap_err().contains("Fighting style"), "the choice is required");
        let mut req = add;
        req.choices.insert("style".into(), vec![1]);
        let adv = run(&mut w, req, 0).unwrap();
        assert_eq!(adv.level, 1);
        assert_eq!(names(&w), ["Defense", "Fighter", "Second Wind"]);
        let f = fighter_id(&w);
        assert_eq!(w.actors["a"].items.iter().find(|i| i.id == f).unwrap().data["hp_rolls"], json!([10]), "level 1 takes the full hit die");

        // Level 2: take the average hit points.
        let mut req = AdvanceRequest { item_id: Some(f.clone()), ..Default::default() };
        req.rolls.insert("hp".into(), "average".into());
        run(&mut w, req, 1).unwrap();
        // Level 3: roll (a 4), and pick the subclass, which brings its level-3 feature.
        let mut req = AdvanceRequest { item_id: Some(f.clone()), ..Default::default() };
        req.choices.insert("sub".into(), vec![0]);
        run(&mut w, req, 4).unwrap();
        assert_eq!(fighter_item(&w).data["levels"], 3);
        assert_eq!(fighter_item(&w).data["hp_rolls"], json!([10, 6, 4]));
        assert_eq!(names(&w), ["Action Surge", "Champion", "Defense", "Fighter", "Improved Critical", "Second Wind"]);

        // Level 4: spend 2 points; not over the cap, not wrong totals.
        let pts = |m: &[(&str, i64)]| {
            let mut req = AdvanceRequest { item_id: Some(f.clone()), ..Default::default() };
            req.points.insert("asi".into(), m.iter().map(|(k, v)| (k.to_string(), *v)).collect());
            req
        };
        assert!(run(&mut w, pts(&[("str", 1)]), 0).unwrap_err().contains("spend 2"));
        assert!(run(&mut w, pts(&[("dex", 2)]), 0).unwrap_err().contains("above 20"));
        run(&mut w, pts(&[("str", 1), ("dex", 1)]), 0).unwrap();
        assert_eq!(w.actors["a"].data["abilities"]["str"]["value"], 16);
        assert_eq!(w.actors["a"].data["abilities"]["dex"]["value"], 20);

        // And back down: level 4 returns the pointsâ€¦
        let a = w.actors["a"].clone();
        for op in regress(&a, &r, &f).unwrap().ops {
            w.apply(&op).unwrap();
        }
        assert_eq!(w.actors["a"].data["abilities"]["str"]["value"], 15);
        assert_eq!(fighter_item(&w).data["levels"], 3);
        // â€¦level 3 takes the subclass and its feature and the hit points.
        let a = w.actors["a"].clone();
        for op in regress(&a, &r, &f).unwrap().ops {
            w.apply(&op).unwrap();
        }
        assert_eq!(names(&w), ["Action Surge", "Defense", "Fighter", "Second Wind"]);
        assert_eq!(fighter_item(&w).data["hp_rolls"], json!([10, 6]));
        // â€¦and removing level 2 and 1 leaves nothing of the class.
        for _ in 0..2 {
            let a = w.actors["a"].clone();
            for op in regress(&a, &r, &f).unwrap().ops {
                w.apply(&op).unwrap();
            }
        }
        assert!(w.actors["a"].items.is_empty(), "{:?}", names(&w));
    }

    #[test]
    fn ancestries_apply_their_grants_once() {
        let r = rules();
        let mut w = world();
        let elf: Item = serde_json::from_value(json!({ "id": "elf", "name": "Elf", "kind": "ancestry", "data": {},
            "advancement": [ { "id": "dv", "kind": "items", "items": [feature("Darkvision"), feature("Trance")] } ] })).unwrap();
        run(&mut w, AdvanceRequest { add: Some(elf.clone()), ..Default::default() }, 0).unwrap();
        assert_eq!(names(&w), ["Darkvision", "Elf", "Trance"]);
        assert!(run(&mut w, AdvanceRequest { add: Some(elf), ..Default::default() }, 0).unwrap_err().contains("already has"));
        let id = w.actors["a"].items.iter().find(|i| i.name == "Elf").unwrap().id.clone();
        assert!(run(&mut w, AdvanceRequest { item_id: Some(id.clone()), ..Default::default() }, 0).unwrap_err().contains("doesn't have levels"));
        let a = w.actors["a"].clone();
        for op in regress(&a, &r, &id).unwrap().ops {
            w.apply(&op).unwrap();
        }
        assert!(w.actors["a"].items.is_empty());
    }

    #[test]
    fn points_only_where_they_can_go() {
        // A background giving skill points to an actor with no skills list: skipped, not an error.
        let mut w = world();
        let bg = |only: serde_json::Value| -> Item {
            serde_json::from_value(json!({ "id": "bg", "name": "Soldier", "kind": "ancestry", "data": {},
                "advancement": [ { "id": "sk", "kind": "points", "path": "skills", "field": "prof", "amount": 2, "max_each": 1, "cap": 1, "only": only } ] })).unwrap()
        };
        let adv = run(&mut w, AdvanceRequest { add: Some(bg(json!([]))), ..Default::default() }, 0).unwrap();
        assert!(adv.gained.iter().any(|g| g.contains("nothing to choose")), "{:?}", adv.gained);
        // With skills, only the allowed ones; and never more points than there's room for.
        let mut w = world();
        w.actors.get_mut("a").unwrap().data["skills"] = json!({ "athletics": { "prof": 0 }, "arcana": { "prof": 0 }, "stealth": { "prof": 1 } });
        let pick = |m: &[(&str, i64)]| AdvanceRequest {
            add: Some(bg(json!(["athletics", "stealth"]))),
            points: [("sk".to_string(), m.iter().map(|(k, n)| (k.to_string(), *n)).collect())].into_iter().collect(),
            ..Default::default()
        };
        assert!(run(&mut w, pick(&[("athletics", 1), ("arcana", 1)]), 0).unwrap_err().contains("spend 1 point"), "stealth is already at its cap, so 1 point");
        assert!(run(&mut w, pick(&[("arcana", 1)]), 0).unwrap_err().contains("arcana isn't one of the choices"));
        run(&mut w, pick(&[("athletics", 1)]), 0).unwrap();
        assert_eq!(w.actors["a"].data["skills"]["athletics"]["prof"], 1);
    }

    #[test]
    fn repeating_grants() {
        let g = |level, every, until| Grant { level, every, until, ..Default::default() };
        let at = |gr: &Grant| (1..=20).filter(|&l| gr.comes_at(l)).collect::<Vec<_>>();
        assert_eq!(at(&g(1, 0, 0)), vec![1], "once");
        assert_eq!(at(&g(0, 0, 0)), vec![1], "level 0 means when added");
        assert_eq!(at(&g(2, 1, 0)), (2..=20).collect::<Vec<_>>(), "hit points every level from 2");
        assert_eq!(at(&g(4, 4, 16)), vec![4, 8, 12, 16], "ability points every 4 levels up to 16");
        let item: Item = serde_json::from_value(json!({ "id": "c", "name": "Warden", "kind": "class", "data": {},
            "advancement": [ { "id": "hp", "level": 2, "every": 1, "kind": "roll" }, { "id": "asi", "level": 4, "every": 4, "until": 16, "kind": "points" } ] })).unwrap();
        let ids = |l| grants_at(&item, l, true).iter().map(|g| g.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(1), Vec::<String>::new());
        assert_eq!(ids(8), vec!["hp", "asi"]);
        assert_eq!(ids(19), vec!["hp"], "the ability points stopped at 16");
    }

    #[test]
    fn averages() {
        assert_eq!(average("1d10"), Some(6));
        assert_eq!(average("d8"), Some(5));
        assert_eq!(average("2d6 + 1"), Some(8));
        assert_eq!(average("(1d12)"), Some(7));
        assert_eq!(average("10"), Some(10));
    }
}
