//! The rules engine: what a system declares (formulas, tables, resources,
//! actions, conditions) and how it turns an actor's data into calculated
//! values, resets resources on a rest, and builds the dice for an action.
//!
//! Systems write these in their manifest:
//!
//! ```toml
//! [tables.proficiency]          # step tables: the highest key ≤ the lookup wins
//! 1 = 2
//! 5 = 3
//!
//! [actor_types.character.formulas]
//! "abilities.*.mod" = "floor((@this.value - 10) / 2)"   # * = every key in data.abilities
//! prof = "table('proficiency', @level)"
//! ac = "10 + @abilities.dex.mod"
//!
//! [actor_types.character.resources.hp]
//! max = "@hp.base + @abilities.con.mod * @level"
//! reset = { long = "max" }
//! bar = true
//!
//! [[item_types.weapon.actions]]
//! id = "attack"
//! label = "Attack"
//! kind = "attack"
//! roll = "1d20 + @item.attack"
//! then = ["damage"]
//! ```
//!
//! Effects (on actors, on items they carry, or from conditions) change values
//! after formulas. The base is picked first (`set`, then `upgrade` = at least,
//! `downgrade` = at most), then adjusted (`multiply`, then `add`).

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::formula::{self, Ast, Scope, Val};
use crate::model::{Actor, ChangeMode, Effect, Item};

/// A change waiting to apply: how, the formula, the item it comes from, and its
/// bonus type if it's one that doesn't stack.
type PendingChange = (ChangeMode, String, Option<usize>, Option<String>);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Rules {
    /// Lookup tables: name → `{ "1": 2, "5": 3 }` (step lookup) or a list.
    #[serde(default)]
    pub tables: BTreeMap<String, Value>,
    #[serde(default)]
    pub actor_types: BTreeMap<String, TypeRules>,
    #[serde(default)]
    pub item_types: BTreeMap<String, TypeRules>,
    /// Conditions players and the GM can toggle on actors (blinded, prone…).
    #[serde(default)]
    pub conditions: Vec<Effect>,
    /// Kinds of rest, e.g. `["short", "long"]`.
    #[serde(default)]
    pub rests: Vec<String>,
    /// Bonus types that stack with themselves (e.g. `["dodge", "circumstance"]`). Other
    /// typed bonuses on the same value don't: only the biggest of each type counts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stacking: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TypeRules {
    /// Calculated values: data path (may contain `*`) → formula.
    #[serde(default)]
    pub formulas: BTreeMap<String, String>,
    /// Tracked resources: data path → definition. Data holds `{ value, max }`.
    #[serde(default)]
    pub resources: BTreeMap<String, ResourceDef>,
    #[serde(default)]
    pub actions: Vec<ActionDef>,
    /// Item types: effects every item of the type gives its owner (with `@item` = that item).
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// Item types: the data key that counts the item's level (classes). Such items level up.
    #[serde(default)]
    pub levels: Option<String>,
    /// Item types with levels: they're counted apart from the character's total level (mythic
    /// tiers), so they bring only their own grants, never the actor type's.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub separate_levels: bool,
    /// Actor types: grants by total level across all classes (a feat at every odd
    /// level, +1 to an ability every 4). They come with the class level that reaches it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub advancement: Vec<crate::advance::Grant>,
    /// Item types: how the item forge prices, checks and crafts them (see `crate::forge`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge: Option<crate::forge::Forge>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ResourceDef {
    #[serde(default)]
    pub label: Option<String>,
    /// Formula for the maximum (otherwise `max` in data is used).
    #[serde(default)]
    pub max: Option<String>,
    /// Rest kind → new value: `"max"`, or a formula using `@value` and `@max`.
    #[serde(default)]
    pub reset: BTreeMap<String, String>,
    /// Show as a bar on tokens.
    #[serde(default)]
    pub bar: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ActionDef {
    pub id: String,
    pub label: String,
    /// `attack`, `check`, `save` (a d20 roll: advantage applies), `damage`
    /// (doubles dice on a crit), `heal`, or anything else.
    #[serde(default)]
    pub kind: String,
    /// Dice formula. `@paths` and `{formula}` blocks are filled in first.
    pub roll: String,
    /// Follow-up actions offered on the chat card (e.g. damage after an attack).
    #[serde(default)]
    pub then: Vec<String>,
    /// Spend from a resource: `path` (on the item, or `actor.<path>`) and `amount`.
    #[serde(default)]
    pub cost: Option<Cost>,
    /// Only offered when this formula is true.
    #[serde(default)]
    pub when: Option<String>,
    /// Attacks: the lowest natural d20 that threatens a critical, a formula (default 20;
    /// a 19–20 weapon is 19, keen makes it 17).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threat: Option<String>,
    /// Attacks: a threat must be confirmed with a second roll before it's a critical.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub confirm: bool,
    /// Damage: on a critical, roll the damage this many times (a formula, e.g. ×3) instead of
    /// doubling the dice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crit_mult: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Cost {
    pub path: String,
    #[serde(default = "one")]
    pub amount: String,
}

fn one() -> String {
    "1".into()
}

/// What the engine produced for an actor.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Derived {
    /// Calculated values, written into `actor.derived` (item values under `items.<id>`).
    pub values: Value,
    /// Formula problems, for the system author.
    pub errors: Vec<String>,
}

// ------------------------------------------------------------------ engine

const MAX_STEPS: usize = 20_000;

/// Evaluates formulas for one actor, with memoised values and loop detection.
pub struct Engine<'a> {
    actor: &'a Actor,
    rules: &'a Rules,
    actor_rules: Option<&'a TypeRules>,
    /// Active effect changes by target path, with the item they came from.
    changes: HashMap<String, Vec<PendingChange>>,
    /// Changes to an item's own values (`item.damage` from its flaming part), by item index.
    item_changes: HashMap<usize, HashMap<String, Vec<PendingChange>>>,
    cache: HashMap<String, Val>,
    busy: HashSet<String>,
    asts: HashMap<String, Result<Ast, String>>,
    /// The item formulas are being evaluated for (`@item`).
    item: Option<usize>,
    /// The object `@this` refers to (a wildcard formula's entry).
    this: Option<Vec<String>>,
    /// Extra values (`@value`, `@max`, `@cast_level`…).
    pub vars: HashMap<String, Val>,
    pub errors: Vec<String>,
    steps: usize,
}

impl<'a> Engine<'a> {
    pub fn new(actor: &'a Actor, rules: &'a Rules) -> Engine<'a> {
        let mut e = Engine {
            actor,
            rules,
            actor_rules: rules.actor_types.get(&actor.kind),
            changes: HashMap::new(),
            item_changes: HashMap::new(),
            cache: HashMap::new(),
            busy: HashSet::new(),
            asts: HashMap::new(),
            item: None,
            this: None,
            vars: HashMap::new(),
            errors: vec![],
            steps: 0,
        };
        e.collect_changes();
        e
    }

    /// Effects that apply now: the actor's own (plus their condition's changes)
    /// and those of items whose `requires` holds. `requires` sees values
    /// before effects, so effects can't switch each other on and off.
    fn collect_changes(&mut self) {
        let actor = self.actor;
        let mut active: Vec<(&Effect, Option<usize>)> = vec![];
        for fx in &actor.effects {
            if !fx.disabled {
                active.push((fx, None));
            }
        }
        let all = self.rules;
        for (i, item) in actor.items.iter().enumerate() {
            // The item's effects, its type's, and those of its parts (and their types'); a
            // part's `requires` sees the item it's attached to as @item.
            let type_fx = |kind: &str| all.item_types.get(kind).map(|t| t.effects.as_slice()).unwrap_or_default();
            let parts = item.parts.iter().flat_map(|p| p.effects.iter().chain(type_fx(&p.kind)));
            for fx in item.effects.iter().chain(type_fx(&item.kind)).chain(parts) {
                if fx.disabled {
                    continue;
                }
                if let Some(req) = fx.requires.as_deref().filter(|r| !r.trim().is_empty()) {
                    let prev = self.item.replace(i);
                    let ok = self.eval_src(req).truthy();
                    self.item = prev;
                    if !ok {
                        continue;
                    }
                }
                active.push((fx, Some(i)));
            }
        }
        let mut changes: HashMap<String, Vec<PendingChange>> = HashMap::new();
        let mut item_changes: HashMap<usize, HashMap<String, Vec<PendingChange>>> = HashMap::new();
        for (fx, item) in active {
            let rules = self.rules;
            let cond = fx.status.as_deref().and_then(|s| rules.conditions.iter().find(|c| c.id == s));
            for c in fx.changes.iter().chain(cond.map(|c| c.changes.iter()).into_iter().flatten()) {
                // A typed bonus of a stacking type is as good as untyped.
                let ty = c.bonus_type.as_deref().map(str::trim).filter(|t| !t.is_empty() && !rules.stacking.iter().any(|s| s.eq_ignore_ascii_case(t)));
                let pending = (c.mode, c.value.clone(), item, ty.map(str::to_lowercase));
                // `item.<field>` changes the item the effect belongs to (flaming: item.damage).
                match (c.path.strip_prefix("item."), item) {
                    (Some(field), Some(i)) => item_changes.entry(i).or_default().entry(field.to_string()).or_default().push(pending),
                    _ => changes.entry(c.path.clone()).or_default().push(pending),
                }
            }
        }
        // Apply in a fixed order: set, upgrade, downgrade, multiply, add.
        for list in changes.values_mut().chain(item_changes.values_mut().flat_map(|m| m.values_mut())) {
            list.sort_by_key(|(m, _, _, _)| *m as u8);
        }
        self.cache.clear();
        self.changes = changes;
        self.item_changes = item_changes;
    }

    fn ast(&mut self, src: &str) -> Result<Ast, String> {
        self.asts.entry(src.to_string()).or_insert_with(|| formula::parse(src)).clone()
    }

    /// Set which of the actor's items `@item` means.
    pub fn set_item(&mut self, idx: Option<usize>) {
        self.item = idx;
    }

    /// Evaluate formula source in the current context.
    pub fn eval_src(&mut self, src: &str) -> Val {
        match self.ast(src) {
            Ok(ast) => match formula::eval(&ast, self) {
                Ok(v) => v,
                Err(e) => {
                    self.errors.push(format!("{src}: {e}"));
                    Val::Null
                }
            },
            Err(e) => {
                self.errors.push(format!("{src}: {e}"));
                Val::Null
            }
        }
    }

    /// Formula for a data path, matching `*` wildcards; returns it and the `@this` path.
    fn formula_for(rules: Option<&TypeRules>, path: &[String]) -> Option<(String, Option<Vec<String>>)> {
        let rules = rules?;
        let key = path.join(".");
        if let Some(f) = rules.formulas.get(&key) {
            return Some((f.clone(), None));
        }
        for (pat, f) in &rules.formulas {
            let segs: Vec<&str> = pat.split('.').collect();
            if segs.len() != path.len() || !segs.contains(&"*") {
                continue;
            }
            if segs.iter().zip(path).all(|(s, p)| *s == "*" || *s == p) {
                let star = segs.iter().rposition(|s| *s == "*").unwrap();
                return Some((f.clone(), Some(path[..=star].to_vec())));
            }
        }
        // A resource's max is a formula too.
        if path.last().map(String::as_str) == Some("max") {
            let base = path[..path.len() - 1].join(".");
            if let Some(m) = rules.resources.get(&base).and_then(|r| r.max.clone()) {
                return Some((m, None));
            }
        }
        None
    }

    /// The actor's value at a data path: data or formula, then effects.
    pub fn resolve(&mut self, path: &[String]) -> Val {
        let key = path.join(".");
        if let Some(v) = self.cache.get(&key) {
            return v.clone();
        }
        self.steps += 1;
        if self.steps > MAX_STEPS {
            self.errors.push("too many steps: is a formula very large or recursive?".into());
            return Val::Null;
        }
        if !self.busy.insert(key.clone()) {
            self.errors.push(format!("{key} depends on itself"));
            return Val::from_json(&json_at(&self.actor.data, path));
        }
        // A `*` formula covers only entries that exist (no modifier for an ability the actor lacks).
        let formula = Self::formula_for(self.actor_rules, path)
            .filter(|(_, this)| this.as_ref().is_none_or(|t| !json_at(&self.actor.data, t).is_null()));
        let base = match formula {
            Some((f, this)) => {
                // In a `*` formula, @key is the entry's key (e.g. "str" for abilities.str.save).
                let key = this.as_ref().and_then(|t| t.last()).map(|k| Val::Str(k.clone()));
                let prev_key = match key {
                    Some(k) => self.vars.insert("key".into(), k),
                    None => self.vars.remove("key"),
                };
                let (prev_this, prev_item) = (std::mem::replace(&mut self.this, this), self.item.take());
                let v = self.eval_src(&f);
                self.this = prev_this;
                self.item = prev_item;
                match prev_key {
                    Some(k) => self.vars.insert("key".into(), k),
                    None => self.vars.remove("key"),
                };
                v
            }
            None => {
                let data = Val::from_json(&json_at(&self.actor.data, path));
                // An object read whole picks up calculated children (e.g. @abilities.str → { value, mod }).
                self.with_calculated_children(path, data)
            }
        };
        let v = self.apply_changes(&key, base);
        self.busy.remove(&key);
        self.cache.insert(key, v.clone());
        v
    }

    fn with_calculated_children(&mut self, path: &[String], data: Val) -> Val {
        let Val::Map(mut m) = data else { return data };
        let Some(rules) = self.actor_rules else { return Val::Map(m) };
        let mut kids: Vec<String> = vec![];
        for pat in rules.formulas.keys() {
            let segs: Vec<&str> = pat.split('.').collect();
            if segs.len() == path.len() + 1 && segs.iter().zip(path).all(|(s, p)| *s == "*" || *s == p) {
                kids.push(segs[path.len()].to_string());
            }
        }
        for k in kids.into_iter().filter(|k| k != "*") {
            let mut p = path.to_vec();
            p.push(k.clone());
            let v = self.resolve(&p);
            m.insert(k, v);
        }
        Val::Map(m)
    }

    fn apply_changes(&mut self, key: &str, v: Val) -> Val {
        let Some(list) = self.changes.get(key).cloned() else { return v };
        self.apply_list(list, v)
    }

    /// Apply changes (already in order) to a value.
    fn apply_list(&mut self, list: Vec<PendingChange>, mut v: Val) -> Val {
        // Typed bonuses: only the biggest of each type is added (penalties all count).
        let mut best: BTreeMap<String, f64> = BTreeMap::new();
        for (mode, src, item, ty) in list {
            let prev = std::mem::replace(&mut self.item, item);
            let x = self.eval_src(&src);
            self.item = prev;
            if let (ChangeMode::Add, Some(ty), Val::Num(n)) = (mode, &ty, &x) {
                if *n > 0.0 {
                    let b = best.entry(ty.clone()).or_insert(0.0);
                    *b = b.max(*n);
                    continue;
                }
            }
            v = match mode {
                ChangeMode::Set => x,
                ChangeMode::Add => match (&v, &x) {
                    (Val::Str(_), _) | (_, Val::Str(_)) => Val::Str(format!("{v}+{x}")),
                    _ => Val::Num(v.num() + x.num()),
                },
                ChangeMode::Multiply => Val::Num(v.num() * x.num()),
                ChangeMode::Upgrade => Val::Num(v.num().max(x.num())),
                ChangeMode::Downgrade => Val::Num(v.num().min(x.num())),
            };
        }
        if !best.is_empty() {
            v = Val::Num(v.num() + best.values().sum::<f64>());
        }
        v
    }

    /// An item's value: its type's formula, or its data, or a top-level field.
    pub fn item_value(&mut self, idx: usize, path: &[String]) -> Val {
        let actor = self.actor;
        let Some(item) = actor.items.get(idx) else { return Val::Null };
        let key = format!("\u{1}item:{}:{}", item.id, path.join("."));
        if let Some(v) = self.cache.get(&key) {
            return v.clone();
        }
        if !self.busy.insert(key.clone()) {
            self.errors.push(format!("{}: {} depends on itself", item.name, path.join(".")));
            return Val::Null;
        }
        let all = self.rules;
        let rules = all.item_types.get(&item.kind);
        // A resource's max can be a formula on the item itself (`uses.formula`: "@abilities.cha.mod",
        // "table('rage', @level)"…), so each feature can carry its own rule.
        let own = (path.last().map(String::as_str) == Some("max"))
            .then(|| json_at(&item.data, &[&path[..path.len() - 1], &["formula".to_string()]].concat()))
            .and_then(|f| f.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from));
        let formula = own.map(|f| (f, ())).or_else(|| Self::formula_for(rules, path).map(|(f, _)| (f, ())));
        let v = match formula {
            Some((f, _)) => {
                let (prev_item, prev_this) = (self.item.replace(idx), self.this.take());
                let v = self.eval_src(&f);
                self.item = prev_item;
                self.this = prev_this;
                v
            }
            None => {
                let d = json_at(&item.data, path);
                if d.is_null() && path.len() == 1 {
                    match path[0].as_str() {
                        "name" => Val::Str(item.name.clone()),
                        "kind" => Val::Str(item.kind.clone()),
                        "id" => Val::Str(item.id.clone()),
                        _ => Val::Null,
                    }
                } else {
                    Val::from_json(&d)
                }
            }
        };
        // Changes from the item's own effects and its parts (flaming: +1d6 on item.damage).
        let v = match self.item_changes.get(&idx).and_then(|m| m.get(&path.join("."))).cloned() {
            Some(list) => self.apply_list(list, v),
            None => v,
        };
        self.busy.remove(&key);
        self.cache.insert(key, v.clone());
        v
    }

    fn items_of(&self, kind: &str) -> Vec<usize> {
        self.actor.items.iter().enumerate().filter(|(_, i)| i.kind == kind).map(|(n, _)| n).collect()
    }

    /// The ids of actions whose `when` is false (for an item, or the actor with `None`).
    fn actions_off(&mut self, actions: &[ActionDef], item: Option<usize>) -> Vec<String> {
        let saved = self.item;
        self.item = item;
        let off = actions
            .iter()
            .filter(|a| a.when.as_deref().is_some_and(|w| !self.eval_src(w).truthy()))
            .map(|a| a.id.clone())
            .collect();
        self.item = saved;
        off
    }

    /// Everything the system calculates for this actor, ready for `actor.derived`.
    pub fn derive(&mut self) -> Derived {
        let (actor, all) = (self.actor, self.rules);
        let mut out = Value::Object(Map::new());
        let mut targets: Vec<Vec<String>> = vec![];
        if let Some(rules) = self.actor_rules {
            for pat in rules.formulas.keys() {
                targets.extend(expand(&actor.data, &pat.split('.').map(String::from).collect::<Vec<_>>()));
            }
            for (path, r) in &rules.resources {
                if r.max.is_some() {
                    let mut p: Vec<String> = path.split('.').map(String::from).collect();
                    p.push("max".into());
                    targets.push(p);
                }
            }
        }
        // Values effects change (e.g. a belt setting Strength) are calculated too.
        let mut changed: Vec<String> = self.changes.keys().cloned().collect();
        changed.sort();
        targets.extend(changed.into_iter().map(|k| k.split('.').map(String::from).collect()));
        for t in targets {
            let v = self.resolve(&t);
            set_at(&mut out, &t, v.to_json(), &mut self.errors);
        }
        // Item values: each item's type formulas, under items.<id>.
        for idx in 0..actor.items.len() {
            let item = &actor.items[idx];
            let Some(rules) = all.item_types.get(&item.kind) else { continue };
            let mut keys: Vec<Vec<String>> = vec![];
            for pat in rules.formulas.keys() {
                keys.extend(expand(&item.data, &pat.split('.').map(String::from).collect::<Vec<_>>()));
            }
            for (path, r) in &rules.resources {
                let own = item.data.pointer(&format!("/{}/formula", path.replace('.', "/"))).and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty());
                if r.max.is_some() || own {
                    let mut p: Vec<String> = path.split('.').map(String::from).collect();
                    p.push("max".into());
                    keys.push(p);
                }
            }
            let id = item.id.clone();
            for k in keys {
                let v = self.item_value(idx, &k);
                let mut p = vec!["items".to_string(), id.clone()];
                p.extend(k);
                set_at(&mut out, &p, v.to_json(), &mut self.errors);
            }
            // Actions whose `when` is false right now, so sheets can hide their buttons.
            let off = self.actions_off(&rules.actions, Some(idx));
            if !off.is_empty() {
                set_at(&mut out, &["items".to_string(), id, "_off".to_string()], Value::from(off), &mut self.errors);
            }
        }
        if let Some(rules) = self.actor_rules {
            let off = self.actions_off(&rules.actions, None);
            if !off.is_empty() {
                set_at(&mut out, &["_off".to_string()], Value::from(off), &mut self.errors);
            }
        }
        let mut errors = std::mem::take(&mut self.errors);
        errors.sort();
        errors.dedup();
        Derived { values: out, errors }
    }
}

impl Scope for Engine<'_> {
    fn path(&mut self, segs: &[String]) -> Val {
        let Some(first) = segs.first() else { return Val::Null };
        if let Some(v) = self.vars.get(first) {
            let v = v.clone();
            return segs[1..].iter().fold(v, |v, k| v.get(k));
        }
        match first.as_str() {
            "item" => match self.item {
                Some(i) if segs.len() > 1 => self.item_value(i, &segs[1..]),
                _ => Val::Null,
            },
            "this" => match self.this.clone() {
                Some(mut base) => {
                    if segs.len() == 1 {
                        return self.resolve(&base);
                    }
                    base.extend_from_slice(&segs[1..]);
                    self.resolve(&base)
                }
                None => Val::Null,
            },
            // The level of the class that gave this item (a feature → its class; a subclass
            // feature → subclass → class), so multiclassed characters count the right levels.
            // Without one: the character's level.
            "class_level" if segs.len() == 1 => {
                let mut at = self.item;
                for _ in 0..8 {
                    let Some(i) = at else { break };
                    let it = &self.actor.items[i];
                    if let Some(key) = self.rules.item_types.get(&it.kind).and_then(|t| t.levels.as_deref()).filter(|k| !k.is_empty()) {
                        return Val::Num(it.data.get(key).and_then(Value::as_f64).unwrap_or(0.0));
                    }
                    let by = it.flags.pointer("/core/granted_by/item").and_then(Value::as_str);
                    at = by.and_then(|id| self.actor.items.iter().position(|x| x.id == id));
                }
                self.resolve(&["level".to_string()])
            }
            "actor" if segs.len() > 1 && matches!(segs[1].as_str(), "name" | "kind" | "id") => Val::Str(match segs[1].as_str() {
                "name" => self.actor.name.clone(),
                "kind" => self.actor.kind.clone(),
                _ => self.actor.id.clone(),
            }),
            _ => self.resolve(segs),
        }
    }

    fn call(&mut self, name: &str, args: &[Val]) -> Option<Val> {
        let key = |i: usize| args.get(i).map(Val::key).unwrap_or_default();
        Some(match name {
            "table" => {
                let rules = self.rules;
                let t = rules.tables.get(&key(0))?;
                lookup_table(t, args.get(1).unwrap_or(&Val::Null))
            }
            // count_items('spell'), or only those whose field has a value: count_items('spell', 'level', 3).
            "count_items" if args.len() >= 3 => {
                let path: Vec<String> = key(1).split('.').filter(|s| !s.is_empty()).map(String::from).collect();
                let want = key(2);
                let idx = self.items_of(&key(0));
                Val::Num(idx.into_iter().filter(|&i| self.item_value(i, &path).key() == want).count() as f64)
            }
            "count_items" => Val::Num(self.items_of(&key(0)).len() as f64),
            // sum_items('class', 'levels'), or only those whose field has a value:
            // sum_items('class', 'levels', 'name', 'Fighter') (compared ignoring case).
            "sum_items" | "max_items" | "items" => {
                let path: Vec<String> = key(1).split('.').filter(|s| !s.is_empty()).map(String::from).collect();
                let mut idx = self.items_of(&key(0));
                if args.len() >= 4 {
                    let field: Vec<String> = key(2).split('.').filter(|s| !s.is_empty()).map(String::from).collect();
                    let want = key(3).to_lowercase();
                    idx.retain(|&i| self.item_value(i, &field).key().to_lowercase() == want);
                }
                let vals: Vec<Val> = idx.into_iter().map(|i| if path.is_empty() { Val::Null } else { self.item_value(i, &path) }).collect();
                match name {
                    "sum_items" => Val::Num(vals.iter().map(Val::num).sum()),
                    "max_items" => Val::Num(vals.iter().map(Val::num).fold(0.0, f64::max)),
                    _ => Val::List(vals),
                }
            }
            // has_item('spell', 'Fireball'): whether the actor has an item of that kind and name
            // (any kind with ''), e.g. a crafter knowing the spell they put in a wand. A name
            // also matches the same name with something in brackets after it: 'Weapon Focus'
            // is met by "Weapon Focus (longsword)".
            //
            // has_item('feat', 'Weapon Focus', 'Longsword'): one taken for that choice, its
            // data.choice or data.choice_key (an item that asked "which weapon?" when added).
            "has_item" => {
                let (kind, name) = (key(0), key(1).trim().to_lowercase());
                let named = |n: &str| {
                    let n = n.trim().to_lowercase();
                    n == name || n.strip_prefix(name.as_str()).is_some_and(|rest| rest.starts_with(" ("))
                };
                let choice = (args.len() >= 3).then(|| key(2).trim().to_lowercase());
                // The choice it stored, or what its name says in brackets ("Weapon Focus (longsword)").
                let chosen = |i: &crate::model::Item| match &choice {
                    None => true,
                    Some(want) => {
                        ["choice", "choice_key"].iter().any(|k| i.data.get(*k).and_then(Value::as_str).is_some_and(|v| !v.is_empty() && v.trim().to_lowercase() == *want))
                            || i.name.trim().to_lowercase() == format!("{name} ({want})")
                    }
                };
                Val::Bool(!name.is_empty() && self.actor.items.iter().any(|i| (kind.is_empty() || i.kind == kind) && named(&i.name) && chosen(i)))
            }
            // replace(text, from, to): every `from` in the text becomes `to` (e.g. a scroll's
            // spell roll at the scroll's own caster level).
            "replace" => {
                let text = args.first().map(|v| match v { Val::Null => String::new(), v => v.to_string() }).unwrap_or_default();
                let from = key(1);
                if from.is_empty() { Val::Str(text) } else { Val::Str(text.replace(&from, &key(2))) }
            }
            "has_status" => Val::Bool(self.actor.effects.iter().any(|e| !e.disabled && e.status.as_deref() == Some(key(0).as_str()))),
            // Over the current item's parts (a weapon's abilities): sum_parts('bonus'),
            // max_parts('cl'), count_parts(), or count_parts('kind', 'material').
            "sum_parts" | "max_parts" | "count_parts" | "nth_parts" | "parts" => {
                let Some(item) = self.item.and_then(|i| self.actor.items.get(i)) else { return Some(Val::Num(0.0)) };
                let path: Vec<String> = key(0).split('.').filter(|s| !s.is_empty()).map(String::from).collect();
                let value_of = |p: &Item| -> Val {
                    match path.as_slice() {
                        [one] if one == "name" => Val::Str(p.name.clone()),
                        [one] if one == "kind" => Val::Str(p.kind.clone()),
                        _ => Val::from_json(&json_at(&p.data, &path)),
                    }
                };
                let vals: Vec<Val> = item.parts.iter().map(value_of).collect();
                match name {
                    "sum_parts" => Val::Num(vals.iter().map(Val::num).sum()),
                    "max_parts" => Val::Num(vals.iter().map(Val::num).fold(0.0, f64::max)),
                    "count_parts" if args.len() >= 2 => Val::Num(vals.iter().filter(|v| v.key() == key(1)).count() as f64),
                    "count_parts" => Val::Num(item.parts.len() as f64),
                    // nth_parts('level', 2): the second-highest value (0 when there's none).
                    "nth_parts" => {
                        let mut nums: Vec<f64> = vals.iter().map(Val::num).collect();
                        nums.sort_by(|a, b| b.total_cmp(a));
                        let n = args.get(1).map(Val::num).unwrap_or(1.0).max(1.0) as usize;
                        Val::Num(nums.get(n - 1).copied().unwrap_or(0.0))
                    }
                    _ => Val::List(vals),
                }
            }
            _ => return None,
        })
    }
}

/// Step lookup: the entry with the highest numeric key not above `at`
/// (or, for a list, the item at that index).
fn lookup_table(t: &Value, at: &Val) -> Val {
    match t {
        Value::Array(a) => a.get(at.num().max(0.0) as usize).map(Val::from_json).unwrap_or_default(),
        Value::Object(o) => {
            if let Some(v) = o.get(&at.key()) {
                if at.key().parse::<f64>().is_err() {
                    return Val::from_json(v);
                }
            }
            let x = at.num();
            let mut best: Option<(f64, &Value)> = None;
            for (k, v) in o {
                if let Ok(n) = k.parse::<f64>() {
                    if n <= x && best.is_none_or(|(b, _)| n > b) {
                        best = Some((n, v));
                    }
                }
            }
            best.map(|(_, v)| Val::from_json(v)).unwrap_or_default()
        }
        other => Val::from_json(other),
    }
}

fn json_at(v: &Value, path: &[String]) -> Value {
    let mut cur = v;
    for k in path {
        cur = match cur {
            Value::Object(o) => match o.get(k) {
                Some(x) => x,
                None => return Value::Null,
            },
            Value::Array(a) => match k.parse::<usize>().ok().and_then(|i| a.get(i)) {
                Some(x) => x,
                None => return Value::Null,
            },
            _ => return Value::Null,
        };
    }
    cur.clone()
}

/// Concrete paths for a pattern: each `*` becomes every key present in the data there.
fn expand(data: &Value, pat: &[String]) -> Vec<Vec<String>> {
    let mut out = vec![vec![]];
    for seg in pat {
        let mut next = vec![];
        for prefix in out {
            if seg == "*" {
                if let Value::Object(o) = json_at(data, &prefix) {
                    for k in o.keys() {
                        let mut p = prefix.clone();
                        p.push(k.clone());
                        next.push(p);
                    }
                }
            } else {
                let mut p = prefix;
                p.push(seg.clone());
                next.push(p);
            }
        }
        out = next;
    }
    out
}

fn set_at(root: &mut Value, path: &[String], v: Value, errors: &mut Vec<String>) {
    let mut cur = root;
    for (i, k) in path.iter().enumerate() {
        if !cur.is_object() {
            errors.push(format!("{} is a value, so it can't also hold {}", path[..i].join("."), path.join(".")));
            return;
        }
        let obj = cur.as_object_mut().unwrap();
        if i == path.len() - 1 {
            // Don't flatten an object that calculated children already live in.
            if obj.get(k).is_some_and(Value::is_object) && !v.is_object() {
                errors.push(format!("{} is a group, so it can't also be a value", path.join(".")));
                return;
            }
            obj.insert(k.clone(), v);
            return;
        }
        cur = obj.entry(k.clone()).or_insert_with(|| Value::Object(Map::new()));
    }
}

// ------------------------------------------------------------------ resources and rests

/// The data patch a rest makes: each resource with a reset for this rest kind
/// gets its new value. Returns (actor patch, [(item id, item patch)]).
pub fn rest(actor: &Actor, rules: &Rules, kind: &str) -> (Value, Vec<(String, Value)>) {
    let mut eng = Engine::new(actor, rules);
    let mut actor_patch = Value::Object(Map::new());
    if let Some(tr) = rules.actor_types.get(&actor.kind) {
        for (path, def) in &tr.resources {
            let Some(src) = def.reset.get(kind) else { continue };
            let p: Vec<String> = path.split('.').map(String::from).collect();
            let value = eng.resolve(&[p.clone(), vec!["value".into()]].concat());
            let max = eng.resolve(&[p.clone(), vec!["max".into()]].concat());
            let new = reset_value(&mut eng, src, value, max);
            let mut errs = vec![];
            set_at(&mut actor_patch, &[p, vec!["value".into()]].concat(), new.to_json(), &mut errs);
        }
    }
    let mut item_patches = vec![];
    for (idx, item) in actor.items.iter().enumerate() {
        let Some(tr) = rules.item_types.get(&item.kind) else { continue };
        let mut patch = Value::Object(Map::new());
        for (path, def) in &tr.resources {
            let Some(src) = def.reset.get(kind) else { continue };
            let p: Vec<String> = path.split('.').map(String::from).collect();
            let value = eng.item_value(idx, &[p.clone(), vec!["value".into()]].concat());
            let max = eng.item_value(idx, &[p.clone(), vec!["max".into()]].concat());
            let prev = eng.item.replace(idx);
            let new = reset_value(&mut eng, src, value, max);
            eng.item = prev;
            let mut errs = vec![];
            set_at(&mut patch, &[p, vec!["value".into()]].concat(), new.to_json(), &mut errs);
        }
        if patch.as_object().is_some_and(|o| !o.is_empty()) {
            item_patches.push((item.id.clone(), json_obj("data", patch)));
        }
    }
    let actor_patch = if actor_patch.as_object().is_some_and(|o| !o.is_empty()) { json_obj("data", actor_patch) } else { Value::Null };
    (actor_patch, item_patches)
}

fn reset_value(eng: &mut Engine, src: &str, value: Val, max: Val) -> Val {
    if src.trim() == "max" {
        return Val::Num(max.num());
    }
    eng.vars.insert("value".into(), value);
    eng.vars.insert("max".into(), max.clone());
    let v = eng.eval_src(src);
    eng.vars.remove("value");
    eng.vars.remove("max");
    // Never above the maximum, never below zero.
    Val::Num(v.num().max(0.0).min(if max == Val::Null { f64::INFINITY } else { max.num() }))
}

fn json_obj(k: &str, v: Value) -> Value {
    let mut m = Map::new();
    m.insert(k.into(), v);
    Value::Object(m)
}

// ------------------------------------------------------------------ actions

/// How the player wants an action rolled.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ActionOptions {
    /// `advantage`, `disadvantage` or `normal` (default: from the actor's `mods`).
    #[serde(default)]
    pub mode: Option<String>,
    /// Double the dice (damage after a critical hit).
    #[serde(default)]
    pub crit: bool,
    /// Cast or use at a higher level: `@cast_level` in formulas.
    #[serde(default)]
    pub level: Option<i64>,
    /// This attack roll confirms a critical threat: its follow-ups are critical.
    #[serde(default)]
    pub confirming: bool,
}

/// An action ready to roll.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedAction {
    pub label: String,
    pub kind: String,
    /// Plain dice, no variables left.
    pub formula: String,
    /// `advantage` / `disadvantage` if one applied.
    pub mode: Option<String>,
    pub then: Vec<(String, String)>,
    /// Where to spend from, and the new value: (item id or None for the actor, data patch).
    pub spend: Option<(Option<String>, Value)>,
    /// Attacks: the lowest natural d20 that threatens a critical.
    pub threat: i64,
    /// Attacks: threats need confirming.
    pub confirm: bool,
}

/// The actions an item (or the actor itself, with `None`) offers right now.
pub fn actions_for<'r>(actor: &Actor, rules: &'r Rules, item: Option<&Item>) -> Vec<&'r ActionDef> {
    let tr = match item {
        Some(i) => rules.item_types.get(&i.kind),
        None => rules.actor_types.get(&actor.kind),
    };
    let Some(tr) = tr else { return vec![] };
    let mut eng = Engine::new(actor, rules);
    eng.item = item.and_then(|i| actor.items.iter().position(|x| x.id == i.id));
    tr.actions.iter().filter(|a| a.when.as_deref().is_none_or(|w| eng.eval_src(w).truthy())).collect()
}

pub fn plan_action(actor: &Actor, rules: &Rules, item_id: Option<&str>, action: &str, opts: &ActionOptions) -> Result<PlannedAction, String> {
    let idx = match item_id {
        Some(id) => Some(actor.items.iter().position(|i| i.id == id).ok_or("That item isn't on this actor")?),
        None => None,
    };
    let tr = match idx {
        Some(i) => rules.item_types.get(&actor.items[i].kind),
        None => rules.actor_types.get(&actor.kind),
    }
    .ok_or("This has no actions")?;
    let def = tr.actions.iter().find(|a| a.id == action).ok_or_else(|| format!("No action called {action}"))?;
    let mut eng = Engine::new(actor, rules);
    eng.item = idx;
    if let Some(l) = opts.level {
        eng.vars.insert("cast_level".into(), Val::Num(l as f64));
    }
    if let Some(w) = &def.when {
        if !eng.eval_src(w).truthy() {
            return Err(format!("{} isn't available right now", def.label));
        }
    }
    let mut formula = fill(&mut eng, &def.roll);
    // Advantage: the caller's choice, else the actor's mods for this kind of roll.
    let mut mode = None;
    if matches!(def.kind.as_str(), "attack" | "check" | "save") {
        let m = match opts.mode.as_deref() {
            Some("advantage") => 1,
            Some("disadvantage") => -1,
            Some("normal") => 0,
            _ => {
                let adv = eng.resolve(&["mods".into(), def.kind.clone(), "advantage".into()]).truthy();
                let dis = eng.resolve(&["mods".into(), def.kind.clone(), "disadvantage".into()]).truthy();
                i32::from(adv) - i32::from(dis)
            }
        };
        if m != 0 {
            if let Some(f) = replace_first_d20(&formula, if m > 0 { "2d20kh1" } else { "2d20kl1" }) {
                formula = f;
                mode = Some(if m > 0 { "advantage" } else { "disadvantage" }.to_string());
            }
        }
    }
    if opts.crit && def.kind == "damage" {
        // A multiplier rolls the damage again (×3: three times); otherwise the dice double.
        formula = match def.crit_mult.as_deref().filter(|m| !m.trim().is_empty()) {
            Some(m) => {
                let n = eng.eval_src(m).num().round().clamp(1.0, 10.0) as usize;
                vec![format!("({formula})"); n].join(" + ")
            }
            None => double_dice(&formula),
        };
    }
    let threat = def.threat.as_deref().filter(|t| !t.trim().is_empty()).map_or(20, |t| (eng.eval_src(t).num().round() as i64).clamp(2, 20));
    // Spending: check there's enough, and work out the new value.
    let spend = match &def.cost {
        None => None,
        Some(c) => {
            let amount = eng.eval_src(&c.amount).num();
            let path = fill(&mut eng, &c.path);
            // Where it's spent from: the actor (`actor.…`), another of the actor's items
            // (`item[class:Wizard].…`, or `item[class:].…` for the first with enough), or this item.
            enum From {
                Actor,
                Item(usize),
            }
            let (from, rel) = if let Some(p) = path.strip_prefix("actor.") {
                (From::Actor, p.to_string())
            } else if let Some(rest) = path.strip_prefix("item[") {
                let (sel, after) = rest.split_once("].").ok_or_else(|| format!("{path}: write item[kind:name].path"))?;
                let (kind, name) = sel.split_once(':').unwrap_or((sel, ""));
                let (kind, name) = (kind.trim(), name.trim());
                let segs: Vec<String> = after.split('.').map(String::from).chain(["value".to_string()]).collect();
                let pick = actor.items.iter().enumerate().find(|(i, it)| {
                    it.kind == kind && (if name.is_empty() { eng.item_value(*i, &segs).num() >= amount } else { it.name.eq_ignore_ascii_case(name) })
                });
                match pick {
                    Some((i, _)) => (From::Item(i), after.to_string()),
                    None if name.is_empty() => return Err(format!("No {kind} has {} left", after.replace('.', " "))),
                    None => return Err(format!("{} has no {name} {kind}", actor.name)),
                }
            } else {
                (match idx { Some(i) => From::Item(i), None => From::Actor }, path.clone())
            };
            let segs: Vec<String> = rel.split('.').map(String::from).collect();
            let value_path = [segs.clone(), vec!["value".into()]].concat();
            let have = match from { From::Actor => eng.resolve(&value_path), From::Item(i) => eng.item_value(i, &value_path) };
            if have.num() < amount {
                return Err(format!("Not enough {} left", rel.replace('.', " ")));
            }
            let mut patch = Value::Object(Map::new());
            let mut errs = vec![];
            set_at(&mut patch, &value_path, Val::Num(have.num() - amount).to_json(), &mut errs);
            Some((match from { From::Actor => None, From::Item(i) => Some(actor.items[i].id.clone()) }, json_obj("data", patch)))
        }
    };
    let then = def
        .then
        .iter()
        .filter_map(|id| tr.actions.iter().find(|a| &a.id == id).map(|a| (a.id.clone(), a.label.clone())))
        .collect();
    Ok(PlannedAction { label: def.label.clone(), kind: def.kind.clone(), formula, mode, then, spend, threat, confirm: def.confirm })
}

/// Fill a roll formula: `{formula}` blocks are evaluated, then `@paths` replaced
/// by their values (dice text like "1d8" is kept, wrapped in brackets).
pub fn fill(eng: &mut Engine, src: &str) -> String {
    fill_depth(eng, src, 0)
}

/// `fill`, also filling in text values that are formulas themselves (an
/// item's "1d10 + @level"), a few levels deep.
fn fill_depth(eng: &mut Engine, src: &str, nest: u8) -> String {
    let mut s = String::new();
    let mut rest = src;
    while let Some(start) = rest.find('{') {
        s.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else {
            s.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let v = eng.eval_src(&rest[start + 1..start + end]);
        s.push_str(&v.to_string());
        rest = &rest[start + end + 1..];
    }
    s.push_str(rest);
    // Now @paths.
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'@' {
            // A path, including [..] parts like @abilities[@item.ability].mod.
            let mut j = i + 1;
            let mut depth = 0usize;
            while j < b.len() {
                let c = b[j];
                if c == b'[' {
                    depth += 1;
                } else if c == b']' {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                } else if !(depth > 0 || c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b'@') {
                    break;
                }
                j += 1;
            }
            let expr = s[i..j].trim_end_matches('.');
            let v = eng.eval_src(expr);
            match &v {
                Val::Str(t) if nest < 3 && (t.contains('@') || t.contains('{')) => {
                    out.push('(');
                    out.push_str(&fill_depth(eng, t, nest + 1));
                    out.push(')');
                }
                _ => out.push_str(&dice_text(&v)),
            }
            i += expr.len();
            continue;
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

fn dice_text(v: &Val) -> String {
    match v {
        // An empty text field adds nothing (an action whose roll is empty has no dice).
        Val::Str(s) if s.trim().is_empty() => String::new(),
        Val::Num(n) if *n < 0.0 => format!("({v})"),
        Val::Num(_) => v.to_string(),
        Val::Bool(b) => u8::from(*b).to_string(),
        Val::Str(s) if !s.trim().is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || b" +-*/()%!".contains(&c)) => format!("({s})"),
        _ => "0".into(),
    }
}

fn replace_first_d20(f: &str, with: &str) -> Option<String> {
    let b = f.as_bytes();
    let mut i = 0;
    while let Some(off) = f[i..].find("d20") {
        let at = i + off;
        // Count digits before the d (none means 1).
        let mut s = at;
        while s > 0 && b[s - 1].is_ascii_digit() {
            s -= 1;
        }
        let count = &f[s..at];
        let after = at + 3;
        let next_is_digit = b.get(after).is_some_and(u8::is_ascii_digit);
        let prev_ok = s == 0 || !b[s - 1].is_ascii_alphanumeric();
        if (count.is_empty() || count == "1") && !next_is_digit && prev_ok {
            return Some(format!("{}{}{}", &f[..s], with, &f[after..]));
        }
        i = after;
    }
    None
}

/// `2d6 + 1d8 + 3` → `4d6 + 2d8 + 3` (critical hits roll the dice twice).
pub fn double_dice(f: &str) -> String {
    let b = f.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'd' && b.get(i + 1).is_some_and(|c| c.is_ascii_digit() || *c == b'%') && (i == 0 || !b[i - 1].is_ascii_alphabetic()) {
            // Find the count we already copied.
            let mut s = out.len();
            while s > 0 && out.as_bytes()[s - 1].is_ascii_digit() {
                s -= 1;
            }
            let n: u64 = if s == out.len() { 1 } else { out[s..].parse().unwrap_or(1) };
            out.truncate(s);
            out.push_str(&(n * 2).to_string());
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

/// Run the engine for an actor.
pub fn derive(actor: &Actor, rules: &Rules) -> Derived {
    Engine::new(actor, rules).derive()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules() -> Rules {
        serde_json::from_value(json!({
            "tables": { "proficiency": { "1": 2, "5": 3, "9": 4, "13": 5, "17": 6 } },
            "rests": ["short", "long"],
            "conditions": [
                { "id": "poisoned", "name": "Poisoned", "changes": [
                    { "path": "mods.attack.disadvantage", "mode": "set", "value": "1" },
                    { "path": "mods.check.disadvantage", "mode": "set", "value": "1" } ] }
            ],
            "actor_types": { "character": {
                "formulas": {
                    "abilities.*.mod": "floor((@this.value - 10) / 2)",
                    "prof": "table('proficiency', @level)",
                    "ac": "10 + @abilities.dex.mod",
                    "skills.*.bonus": "@abilities[@this.ability].mod + @this.prof * @prof",
                    "class_levels": "sum_items('class', 'levels')",
                    "loop_a": "@loop_b + 1",
                    "loop_b": "@loop_a + 1"
                },
                "resources": {
                    "hp": { "max": "@hp.base + @abilities.con.mod * @level", "reset": { "long": "max" }, "bar": true },
                    "hit_dice": { "max": "@level", "reset": { "long": "@value + max(1, floor(@max / 2))" } }
                },
                "actions": [ { "id": "init", "label": "Initiative", "kind": "check", "roll": "1d20 + @abilities.dex.mod" } ]
            } },
            "item_types": {
                "weapon": {
                    "formulas": {
                        "attack": "@item.bonus + max(@abilities.str.mod, @item.finesse ? @abilities.dex.mod : -99) + @prof",
                        "dmg_mod": "@item.finesse ? max(@abilities.str.mod, @abilities.dex.mod) : @abilities.str.mod"
                    },
                    "actions": [
                        { "id": "attack", "label": "Attack", "kind": "attack", "roll": "1d20 + @item.attack", "then": ["damage"] },
                        { "id": "damage", "label": "Damage", "kind": "damage", "roll": "@item.damage + @item.dmg_mod" }
                    ]
                },
                "feature": {
                    "resources": { "uses": { "max": "@prof", "reset": { "short": "max", "long": "max" } } },
                    "actions": [ { "id": "use", "label": "Second Wind", "kind": "heal", "roll": "1d10 + @level", "cost": { "path": "uses" } } ]
                },
                "spell": {
                    "actions": [ { "id": "cast", "label": "Cast", "kind": "damage", "roll": "{@cast_level + 2}d6",
                                   "cost": { "path": "actor.spell_slots.l{@cast_level}" }, "when": "@item.prepared" } ]
                },
                "class": {}
            }
        })).unwrap()
    }

    fn hero() -> Actor {
        serde_json::from_value(json!({
            "id": "a1", "name": "Ann", "kind": "character",
            "data": {
                "level": 5,
                "abilities": { "str": { "value": 16 }, "dex": { "value": 14 }, "con": { "value": 12 } },
                "hp": { "base": 30, "value": 10 },
                "hit_dice": { "value": 1 },
                "skills": { "athletics": { "ability": "str", "prof": 1 }, "stealth": { "ability": "dex", "prof": 2 } },
                "spell_slots": { "l2": { "value": 1, "max": 3 } }
            },
            "items": [
                { "id": "rapier", "name": "Rapier", "kind": "weapon", "data": { "bonus": 0, "finesse": true, "damage": "1d8" } },
                { "id": "armor", "name": "Chain shirt", "kind": "armor", "data": { "equipped": true },
                  "effects": [ { "requires": "@item.equipped", "changes": [ { "path": "ac", "mode": "upgrade", "value": "13 + min(@abilities.dex.mod, 2)" } ] } ] },
                { "id": "sw", "name": "Second Wind", "kind": "feature", "data": { "uses": { "value": 1 } } },
                { "id": "fb", "name": "Scorching Ray", "kind": "spell", "data": { "prepared": true } },
                { "id": "c1", "name": "Fighter", "kind": "class", "data": { "levels": 3 } },
                { "id": "c2", "name": "Rogue", "kind": "class", "data": { "levels": 2 } }
            ]
        })).unwrap()
    }

    fn at<'v>(v: &'v Value, p: &str) -> &'v Value {
        p.split('.').fold(v, |v, k| &v[k])
    }

    #[test]
    fn formulas_tables_lists_and_item_values() {
        let d = derive(&hero(), &rules());
        let v = &d.values;
        assert_eq!(at(v, "abilities.str.mod"), 3);
        assert_eq!(at(v, "abilities.dex.mod"), 2);
        assert_eq!(at(v, "prof"), 3, "step table: level 5 gives 3");
        assert_eq!(at(v, "skills.athletics.bonus"), 6);
        assert_eq!(at(v, "skills.stealth.bonus"), 8, "expertise: 2 x prof");
        assert_eq!(at(v, "hp.max"), 35);
        assert_eq!(at(v, "class_levels"), 5);
        assert_eq!(at(v, "ac"), 15, "chain shirt beats 10 + dex");
        assert_eq!(at(v, "items.rapier.attack"), 6, "finesse uses the better of str and dex");
        assert!(d.errors.iter().any(|e| e.contains("depends on itself")), "loops are reported: {:?}", d.errors);
        // A wildcard formula doesn't invent entries: there's no "wis" in this actor's abilities.
        let (h, r) = (hero(), rules());
        let mut eng = Engine::new(&h, &r);
        assert_eq!(eng.resolve(&["abilities".into(), "wis".into(), "mod".into()]), Val::Null);
        assert_eq!(eng.resolve(&["abilities".into(), "".into(), "mod".into()]), Val::Null);
    }

    #[test]
    fn effects_stack_in_order_and_follow_requires() {
        let mut a = hero();
        a.items.push(serde_json::from_value(json!({ "id": "sh", "name": "Shield", "kind": "armor", "data": {},
            "effects": [ { "changes": [ { "path": "ac", "mode": "add", "value": "2" } ] } ] })).unwrap());
        a.items.push(serde_json::from_value(json!({ "id": "belt", "name": "Belt", "kind": "gear", "data": {},
            "effects": [ { "changes": [ { "path": "abilities.str.value", "mode": "set", "value": "21" } ] } ] })).unwrap());
        let d = derive(&a, &rules());
        assert_eq!(at(&d.values, "ac"), 17, "the shield adds to the armour");
        assert_eq!(at(&d.values, "abilities.str.mod"), 5, "the belt's Strength feeds the modifier");
        assert_eq!(at(&d.values, "items.rapier.attack"), 8);
        a.items[1].data["equipped"] = json!(false);
        assert_eq!(at(&derive(&a, &rules()).values, "ac"), 14, "unequipped armour stops counting");
    }

    #[test]
    fn bonuses_of_one_type_dont_stack() {
        let mut a = hero();
        a.items.truncate(1);
        let base = at(&derive(&a, &rules()).values, "ac").as_f64().unwrap();
        let add = |ty: Option<&str>, v: &str| json!({ "path": "ac", "mode": "add", "value": v, "type": ty });
        a.effects.push(serde_json::from_value(json!({ "name": "Spells", "changes": [
            add(Some("deflection"), "2"), add(Some("deflection"), "1"),   // only the +2
            add(Some("dodge"), "1"), add(Some("dodge"), "1"),             // dodge stacks (listed in `stacking`)
            add(None, "1"), add(None, "1"),                                // untyped stacks
            add(Some("deflection"), "-1"),                                 // penalties always count
        ] })).unwrap());
        let mut r = rules();
        r.stacking = vec!["dodge".into()];
        assert_eq!(at(&derive(&a, &r).values, "ac").as_f64().unwrap() - base, 5.0);
    }

    #[test]
    fn actions_advantage_crits_and_costs() {
        let r = rules();
        let mut a = hero();
        let p = plan_action(&a, &r, Some("rapier"), "attack", &ActionOptions::default()).unwrap();
        assert_eq!(p.formula, "1d20 + 6");
        assert_eq!(p.then, vec![("damage".to_string(), "Damage".to_string())]);
        a.effects.push(Effect { status: Some("poisoned".into()), ..Default::default() });
        let p = plan_action(&a, &r, Some("rapier"), "attack", &ActionOptions::default()).unwrap();
        assert_eq!((p.formula.as_str(), p.mode.as_deref()), ("2d20kl1 + 6", Some("disadvantage")));
        let adv = ActionOptions { mode: Some("advantage".into()), ..Default::default() };
        assert_eq!(plan_action(&a, &r, Some("rapier"), "attack", &adv).unwrap().formula, "2d20kh1 + 6");
        let crit = ActionOptions { crit: true, ..Default::default() };
        assert_eq!(plan_action(&a, &r, Some("rapier"), "damage", &crit).unwrap().formula, "(2d8) + 3");
        // Paths with [..] parts work in rolls too.
        let mut eng = Engine::new(&a, &r);
        eng.item = Some(0);
        eng.vars.insert("pick".into(), Val::Str("dex".into()));
        assert_eq!(fill(&mut eng, "@item.damage + @abilities[@pick].mod."), "(1d8) + 2.");
        // A text value holding a formula is filled in too.
        eng.vars.insert("heal".into(), Val::Str("1d10 + @level".into()));
        assert_eq!(fill(&mut eng, "@heal"), "(1d10 + 5)");
        // @key in a * formula is the entry's key.
        let r2: Rules = serde_json::from_value(json!({ "actor_types": { "character": { "formulas": { "saves.*.bonus": "@abilities[@key].value" } } } })).unwrap();
        let mut a2 = hero();
        a2.data["saves"] = json!({ "str": {}, "dex": {} });
        let d2 = derive(&a2, &r2);
        assert_eq!((d2.values["saves"]["str"]["bonus"].clone(), d2.values["saves"]["dex"]["bonus"].clone()), (json!(16), json!(14)));
        let p = plan_action(&a, &r, Some("sw"), "use", &ActionOptions::default()).unwrap();
        assert_eq!(p.formula, "1d10 + 5");
        assert_eq!(p.spend, Some((Some("sw".into()), json!({ "data": { "uses": { "value": 0 } } }))));
        a.items[2].data["uses"]["value"] = json!(0);
        assert!(plan_action(&a, &r, Some("sw"), "use", &ActionOptions::default()).is_err());
        let l2 = ActionOptions { level: Some(2), ..Default::default() };
        let p = plan_action(&a, &r, Some("fb"), "cast", &l2).unwrap();
        assert_eq!(p.formula, "4d6");
        assert_eq!(p.spend, Some((None, json!({ "data": { "spell_slots": { "l2": { "value": 0 } } } }))));
        let l3 = ActionOptions { level: Some(3), ..Default::default() };
        assert!(plan_action(&a, &r, Some("fb"), "cast", &l3).is_err(), "no 3rd-level slots");
        a.items[3].data["prepared"] = json!(false);
        assert!(plan_action(&a, &r, Some("fb"), "cast", &l2).is_err());
        assert!(actions_for(&a, &r, Some(&a.items[3])).is_empty());
        // Sheets learn which actions are off from derived values.
        assert_eq!(at(&derive(&a, &r).values, "items.fb._off"), &json!(["cast"]));
        a.items[3].data["prepared"] = json!(true);
        assert!(at(&derive(&a, &r).values, "items.fb._off").is_null(), "nothing off, no list");
    }

    #[test]
    fn rests_reset_resources() {
        let mut a = hero();
        a.items[2].data["uses"]["value"] = json!(0);
        let (patch, items) = rest(&a, &rules(), "long");
        assert_eq!(patch, json!({ "data": { "hp": { "value": 35 }, "hit_dice": { "value": 3 } } }));
        assert_eq!(items, vec![("sw".to_string(), json!({ "data": { "uses": { "value": 3 } } }))]);
        let (patch, items) = rest(&a, &rules(), "short");
        assert_eq!(patch, Value::Null, "nothing on the character resets on a short rest");
        assert_eq!(items.len(), 1);
        // An item can carry its own max formula, which beats the type's.
        a.items[2].data["uses"]["formula"] = json!("@level + 1");
        assert_eq!(at(&derive(&a, &rules()).values, "items.sw.uses.max"), 6);
        let (_, items) = rest(&a, &rules(), "long");
        assert_eq!(items, vec![("sw".to_string(), json!({ "data": { "uses": { "value": 6 } } }))]);
        // @class_level: the level of the class that gave it (Fighter 3 / Rogue 2 here), else the character's.
        let mut r = rules();
        r.item_types.get_mut("class").unwrap().levels = Some("levels".into());
        a.items[2].data["uses"]["formula"] = json!("@class_level");
        assert_eq!(at(&derive(&a, &r).values, "items.sw.uses.max"), 5, "not from a class: character level");
        a.items[2].flags = json!({ "core": { "granted_by": { "item": "c2", "level": 1 } } });
        assert_eq!(at(&derive(&a, &r).values, "items.sw.uses.max"), 2, "Rogue 2");
    }

    #[test]
    fn dice_helpers() {
        assert_eq!(double_dice("2d6 + 1d8 + 3"), "4d6 + 2d8 + 3");
        assert_eq!(double_dice("d8+1"), "2d8+1");
        assert_eq!(replace_first_d20("1d20 + 5", "2d20kh1").as_deref(), Some("2d20kh1 + 5"));
        assert_eq!(replace_first_d20("d20+1", "2d20kl1").as_deref(), Some("2d20kl1+1"));
        assert_eq!(replace_first_d20("2d20 + 1d200", "x"), None, "only a single d20 gets advantage");
    }
}
