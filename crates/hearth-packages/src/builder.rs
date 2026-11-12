//! The system builder's file (`builder.json` in a system's folder): a tree of
//! actor and item types made of groups, fields, formulas, resources, lists,
//! actions and effects. Hearth compiles it into data templates and rules
//! (the same things a hand-written `hearth.toml` declares), and the client
//! lays out sheets from it.
//!
//! ```json
//! { "actor_types": [ { "key": "character", "label": "Character", "kind": "type", "children": [
//!     { "key": "abilities", "label": "Abilities", "kind": "list",
//!       "entries": [ { "key": "str", "label": "Strength" } ],
//!       "children": [ { "key": "value", "kind": "number", "default": 10 },
//!                     { "key": "mod", "kind": "formula", "formula": "floor((@this.value - 10) / 2)" } ] },
//!     { "key": "hp", "label": "Hit points", "kind": "resource", "reset": { "long": "max" }, "bar": true } ] } ] }
//! ```

use std::collections::{BTreeMap, HashSet};

use hearth_core::rules::{ActionDef, Cost, ResourceDef};
use hearth_core::{Change, Effect};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::TypeDef;

/// The builder's file name inside a system's folder.
pub const FILE: &str = "builder.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Blueprint {
    #[serde(default)]
    pub version: u32,
    /// Kinds of rest, e.g. `["short", "long"]`.
    #[serde(default)]
    pub rests: Vec<String>,
    /// Lookup tables (see `hearth_core::rules`).
    #[serde(default)]
    pub tables: BTreeMap<String, Value>,
    #[serde(default)]
    pub conditions: Vec<Effect>,
    #[serde(default)]
    pub actor_types: Vec<Node>,
    #[serde(default)]
    pub item_types: Vec<Node>,
    /// Sheet look: colours, fonts, corner rounding and extra CSS (used by the client).
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub style: Value,
    /// Character creation steps (e.g. setting ability scores), with the methods offered.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub creation: Vec<hearth_core::creation::CreationStep>,
    /// Bonus types that stack with themselves (e.g. dodge); other typed bonuses don't.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stacking: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    /// An actor or item type (top level only).
    Type,
    /// A section that holds other nodes.
    #[default]
    Group,
    Number,
    Text,
    /// Several lines of text.
    Longtext,
    Checkbox,
    /// One of a set of options.
    Choice,
    /// Calculated from a formula; read-only.
    Formula,
    /// Current and max value that rests can restore (hit points, uses…).
    Resource,
    /// A repeating set of entries, each with the child fields (abilities, skills…).
    List,
    /// A roll button (attack, damage, cast…).
    Action,
    /// Item types: a change every item of the type gives its owner (e.g. armour's AC).
    Effect,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Node {
    /// Stable id for the editor.
    #[serde(default)]
    pub id: String,
    /// The data key (letters, digits and _).
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub kind: NodeKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub hint: String,
    /// Starting value (numbers, text, checkboxes, choices, resources).
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub default: Value,
    /// Formula nodes: the formula. Resources: an optional formula for the max.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub formula: String,
    /// Choices: the options.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<ChoiceOption>,
    /// Choices: take the options from a list's entries instead (its key, e.g. `abilities`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Resources: rest kind → new value (`max` or a formula with @value and @max).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub reset: BTreeMap<String, String>,
    /// Resources: show as a bar on tokens.
    #[serde(default, skip_serializing_if = "is_false")]
    pub bar: bool,
    /// Actions: the dice formula.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub roll: String,
    /// Actions: attack, check, save, damage, heal, other.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub roll_kind: String,
    /// Actions: follow-up action keys.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub then: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Cost>,
    /// Attack actions: the lowest natural d20 that threatens a critical (a formula; default 20).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub threat: String,
    /// Attack actions: threats need a confirmation roll.
    #[serde(default, skip_serializing_if = "is_false")]
    pub confirm: bool,
    /// Damage actions: on a critical, roll the damage this many times instead of doubling the dice.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub crit_mult: String,
    /// Actions: only offered when this is true. Effects: only apply when this is true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    /// Lists: the entries every new document starts with.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<Entry>,
    /// Lists: players can add and remove entries.
    #[serde(default, skip_serializing_if = "is_false")]
    pub open: bool,
    /// Effects: the changes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<Change>,
    /// Layout: don't show the label (the value or input still shows).
    #[serde(default, skip_serializing_if = "is_false")]
    pub hide_label: bool,
    /// Layout: columns this takes in its group's grid (0 = automatic, 99 = a whole row).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub span: u8,
    /// Layout: how a value shows: "" (normal), "big", "badge", "inline" or "plain".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub display: String,
    /// Groups: columns in the group's grid (0 = as many as fit).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub columns: u8,
    /// Groups: "" (a box), "plain" or "card".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub frame: String,
    /// Top-level groups: "" (a tab), "top" (above the tabs), "side" (a column beside them),
    /// "header" (small values under the name) or "vitals" (the header's right-hand side).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub place: String,
    /// Tabs (top-level groups, item types shown on their own tab): an icon name or an emoji.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub icon: String,
    /// Item types: where the actor sheet lists them: "" (the Items tab), "own" (a tab of
    /// their own) or the key of one of the actor's tabs.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tab: String,
    /// Item types: the heading of their list on the actor sheet (e.g. "Spellbook"; default: the type's name).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub list_title: String,
    /// Item types: a field to group the list by (spells by level).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub group_by: String,
    /// Item types: fields shown beside each item's name in the list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub summary: Vec<String>,
    /// Actor types: the sheet window's width in pixels (0 = default).
    #[serde(default, skip_serializing_if = "is_zero16")]
    pub width: u16,
    /// Types: a hand-made HTML sheet in the system folder (e.g. `sheets/player.html`) used instead of the generated one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    /// Types: which sheet it uses: "generated", "designed" (from `layouts`), "html" (`sheet`)
    /// or "none" (item types: no window; details open in place). Empty: "html" if `sheet`
    /// is set, otherwise "generated".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sheet_mode: String,
    /// Types: sheet layouts made in the sheet designer (the first is the default). Each
    /// places blocks that point at this type's fields, so arranging a sheet never changes
    /// the data. See docs/sheets.md.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub layouts: Vec<Value>,
    /// Item types that give features: the advancement a new item of the type starts with
    /// (a class's hit points every level, ability points every 4 levels…), as grants.
    /// Actor types: grants by total level across all classes (a feat every odd level).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub advancement: Vec<Value>,
    /// Types: the id of the layout sheets use unless an actor picks another (empty: the first).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub default_layout: String,
    /// Groups: only arranges the sheet; its fields keep their parent's path
    /// (a "Combat" tab whose Armour Class is still `@ac`).
    #[serde(default, skip_serializing_if = "is_false")]
    pub flat: bool,
    /// Item types: items of this type give features (classes, ancestries, backgrounds).
    #[serde(default, skip_serializing_if = "is_false")]
    pub grants: bool,
    /// Item types: the number field that counts levels (classes level up).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub levels: Option<String>,
    /// Item types: how the item forge prices, checks and crafts them (see `hearth_core::forge`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forge: Option<hearth_core::forge::Forge>,
    /// Not shown on the sheet (still in the data and formulas).
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ChoiceOption {
    pub value: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub key: String,
    #[serde(default)]
    pub label: String,
    /// Starting values for this entry's fields (field key → value).
    #[serde(default)]
    pub values: BTreeMap<String, Value>,
}

/// What a blueprint compiles to.
#[derive(Debug, Clone, Default)]
pub struct Compiled {
    pub actor_types: BTreeMap<String, TypeDef>,
    pub item_types: BTreeMap<String, TypeDef>,
    /// Problems, as "Type › Field: message".
    pub errors: Vec<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_zero(n: &u8) -> bool {
    *n == 0
}

fn is_zero16(n: &u16) -> bool {
    *n == 0
}

pub fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 40 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !k.starts_with(|c: char| c.is_ascii_digit())
}

pub fn compile(bp: &Blueprint) -> Compiled {
    let mut out = Compiled::default();
    for (types, is_item) in [(&bp.actor_types, false), (&bp.item_types, true)] {
        let mut seen = HashSet::new();
        for t in types {
            let name = if t.label.is_empty() { t.key.clone() } else { t.label.clone() };
            if !valid_key(&t.key) {
                out.errors.push(format!("{name}: the key \"{}\" needs letters, digits or _ only", t.key));
                continue;
            }
            if !seen.insert(t.key.clone()) {
                out.errors.push(format!("{name}: there are two types called {}", t.key));
                continue;
            }
            let mut c = TypeCompiler { def: TypeDef { label: Some(name.clone()), template: Value::Object(Map::new()), ..Default::default() }, errors: vec![], trail: vec![name.clone()], is_item };
            let mut template = Map::new();
            c.children(&t.children, &[], false, &mut template);
            // Which sheet: a hand-made HTML one replaces the generated one; a designed
            // one is laid out by the client from `layouts`.
            let html = t.sheet.as_deref().filter(|s| !s.is_empty());
            match t.sheet_mode.as_str() {
                "" | "html" => match html {
                    Some(sheet) if crate::safe_relative(sheet) && sheet.ends_with(".html") => c.def.sheet = Some(sheet.to_string()),
                    Some(_) => c.errors.push(format!("{name}: the sheet should be an .html file inside the system folder")),
                    None if t.sheet_mode == "html" => c.errors.push(format!("{name}: the sheet is set to custom HTML, but no file is chosen")),
                    None => {}
                },
                "designed" => {
                    if t.layouts.is_empty() {
                        c.errors.push(format!("{name}: the sheet is set to designed, but it has no layout yet"));
                    }
                    let mut ids = HashSet::new();
                    for (i, layout) in t.layouts.iter().enumerate() {
                        layout_errors(&mut c.errors, &name, i, layout, &t.children, bp);
                        let id = layout.get("id").and_then(Value::as_str).unwrap_or_default();
                        if id.is_empty() || !ids.insert(id.to_string()) {
                            c.errors.push(format!("{name}: each sheet layout needs its own id (\"{id}\" is missing or used twice)"));
                        }
                    }
                    if !t.default_layout.is_empty() && !ids.contains(&t.default_layout) {
                        c.errors.push(format!("{name}: the default layout \"{}\" doesn't exist", t.default_layout));
                    }
                }
                "generated" => {}
                "none" if is_item => {}
                "none" => c.errors.push(format!("{name}: actors always need a sheet")),
                other => c.errors.push(format!("{name}: unknown sheet setting \"{other}\"")),
            }
            // Actor types: grants by total level (a feat every odd level…).
            if !is_item {
                for (i, g) in t.advancement.iter().enumerate() {
                    match serde_json::from_value::<hearth_core::advance::Grant>(g.clone()) {
                        Ok(g) => c.def.advancement.push(g),
                        Err(e) => c.errors.push(format!("{name}: character advancement row {}: {e}", i + 1)),
                    }
                }
            }
            if is_item {
                c.def.forge = t.forge.clone();
            }
            // Levels: a number field directly in the type.
            if is_item && (t.grants || t.levels.is_some()) {
                c.def.grants = true;
                if let Some(k) = t.levels.as_deref().filter(|k| !k.is_empty()) {
                    if template.get(k).is_some_and(Value::is_number) {
                        c.def.levels = Some(k.to_string());
                    } else {
                        c.errors.push(format!("{name}: levels are counted by \"{k}\", which should be a number field directly in this type"));
                    }
                }
            }
            c.def.template = Value::Object(template);
            out.errors.append(&mut c.errors);
            if is_item {
                out.item_types.insert(t.key.clone(), c.def);
            } else {
                out.actor_types.insert(t.key.clone(), c.def);
            }
        }
    }
    for (name, t) in &bp.tables {
        if !valid_key(name) {
            out.errors.push(format!("Tables: \"{name}\" needs letters, digits or _ only"));
        }
        if !(t.is_object() || t.is_array()) {
            out.errors.push(format!("Tables › {name}: should be rows of key → value"));
        }
    }
    for c in &bp.conditions {
        for ch in &c.changes {
            check_formula(&mut out.errors, &format!("Conditions › {}", c.name), &ch.value);
        }
    }
    out
}

/// The `@paths` a sheet block can show: every field, list, resource and action, and
/// every (non layout-only) group.
fn bindable_paths(nodes: &[Node], prefix: &str, out: &mut HashSet<String>) {
    for n in nodes {
        let path = if prefix.is_empty() { n.key.clone() } else { format!("{prefix}.{}", n.key) };
        match n.kind {
            NodeKind::Effect | NodeKind::Type => {}
            NodeKind::Group if n.flat => bindable_paths(&n.children, prefix, out),
            NodeKind::Group => {
                out.insert(path.clone());
                bindable_paths(&n.children, &path, out);
            }
            _ => {
                out.insert(path);
            }
        }
    }
}

/// Problems in a designed layout: blocks showing fields that don't exist (renamed or
/// deleted since), or item lists of unknown item types.
fn layout_errors(errors: &mut Vec<String>, type_name: &str, i: usize, layout: &Value, children: &[Node], bp: &Blueprint) {
    let mut paths = HashSet::new();
    bindable_paths(children, "", &mut paths);
    let sheet = layout.get("name").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("sheet {}", i + 1));
    fn visit(v: &Value, f: &mut dyn FnMut(&Map<String, Value>)) {
        match v {
            Value::Object(o) => {
                if o.contains_key("kind") {
                    f(o);
                }
                o.values().for_each(|x| visit(x, f));
            }
            Value::Array(a) => a.iter().for_each(|x| visit(x, f)),
            _ => {}
        }
    }
    visit(layout, &mut |block| {
        let kind = block.get("kind").and_then(Value::as_str).unwrap_or_default();
        if kind == "field" {
            let bind = block.get("bind").and_then(Value::as_str).unwrap_or_default();
            if !paths.contains(bind) {
                errors.push(format!("{type_name} › {sheet}: a block shows @{bind}, which isn't a field of this type (renamed or deleted?)"));
            }
        } else if kind == "items" {
            let t = block.get("item_type").and_then(Value::as_str).unwrap_or_default();
            if !bp.item_types.iter().any(|x| x.key == t) {
                errors.push(format!("{type_name} › {sheet}: a list shows items of type \"{t}\", which doesn't exist"));
            }
        }
    });
}

fn check_formula(errors: &mut Vec<String>, where_: &str, src: &str) {
    if let Err(e) = hearth_core::formula::parse(src) {
        errors.push(format!("{where_}: {e}"));
    }
}

struct TypeCompiler {
    def: TypeDef,
    errors: Vec<String>,
    trail: Vec<String>,
    is_item: bool,
}

impl TypeCompiler {
    fn err(&mut self, msg: impl std::fmt::Display) {
        self.errors.push(format!("{}: {msg}", self.trail.join(" › ")));
    }

    fn children(&mut self, nodes: &[Node], path: &[String], in_list: bool, template: &mut Map<String, Value>) {
        let mut seen = HashSet::new();
        for n in nodes {
            let label = if n.label.is_empty() { n.key.clone() } else { n.label.clone() };
            self.trail.push(label);
            if n.kind != NodeKind::Action && n.kind != NodeKind::Effect {
                if !valid_key(&n.key) {
                    self.err(format!("the key \"{}\" needs letters, digits or _ only", n.key));
                    self.trail.pop();
                    continue;
                }
                if !seen.insert(n.key.clone()) {
                    self.err(format!("two fields here are called {}", n.key));
                }
            }
            let mut p = path.to_vec();
            p.push(n.key.clone());
            self.node(n, &p, in_list, template);
            self.trail.pop();
        }
    }

    fn node(&mut self, n: &Node, path: &[String], in_list: bool, template: &mut Map<String, Value>) {
        let key = n.key.clone();
        match n.kind {
            NodeKind::Type => self.err("types can only be at the top"),
            NodeKind::Group => {
                if in_list {
                    self.err("groups can't go inside a list entry");
                    return;
                }
                if n.flat {
                    // Layout only: the fields live where the group is.
                    self.children(&n.children, &path[..path.len() - 1], false, template);
                    return;
                }
                let mut sub = Map::new();
                self.children(&n.children, path, false, &mut sub);
                template.insert(key, Value::Object(sub));
            }
            NodeKind::Number => {
                let d = n.default.as_f64().map(Value::from).unwrap_or(Value::from(0));
                template.insert(key, if n.default.is_i64() { n.default.clone() } else { d });
            }
            NodeKind::Text | NodeKind::Longtext => {
                template.insert(key, Value::String(n.default.as_str().unwrap_or_default().to_string()));
            }
            NodeKind::Checkbox => {
                template.insert(key, Value::Bool(n.default.as_bool().unwrap_or(false)));
            }
            NodeKind::Choice => {
                let d = n.default.as_str().map(String::from).or_else(|| n.options.first().map(|o| o.value.clone())).unwrap_or_default();
                template.insert(key, Value::String(d));
            }
            NodeKind::Formula => {
                if n.formula.trim().is_empty() {
                    self.err("needs a formula");
                    return;
                }
                check_formula(&mut self.errors, &self.trail.join(" › "), &n.formula);
                self.def.formulas.insert(path.join("."), n.formula.clone());
            }
            NodeKind::Resource => {
                if in_list {
                    self.err("resources can't go inside a list entry");
                    return;
                }
                let d = n.default.as_f64().unwrap_or(0.0);
                let num = |x: f64| if x.fract() == 0.0 { Value::from(x as i64) } else { Value::from(x) };
                let mut obj = Map::new();
                obj.insert("value".into(), num(d));
                obj.insert("max".into(), num(d));
                template.insert(key, Value::Object(obj));
                let max = (!n.formula.trim().is_empty()).then(|| n.formula.clone());
                if let Some(m) = &max {
                    check_formula(&mut self.errors, &self.trail.join(" › "), m);
                }
                for (rest, f) in &n.reset {
                    if f.trim() != "max" {
                        check_formula(&mut self.errors, &format!("{} › {rest} rest", self.trail.join(" › ")), f);
                    }
                }
                self.def.resources.insert(path.join("."), ResourceDef { label: Some(if n.label.is_empty() { n.key.clone() } else { n.label.clone() }), max, reset: n.reset.clone(), bar: n.bar });
            }
            NodeKind::List => {
                if in_list {
                    self.err("lists can't go inside a list entry");
                    return;
                }
                // The entry shape, then the starting entries.
                let mut field_path = path.to_vec();
                field_path.push("*".into());
                let mut shape = Map::new();
                self.children(&n.children, &field_path, true, &mut shape);
                let mut entries = Map::new();
                let mut seen = HashSet::new();
                for e in &n.entries {
                    if !valid_key(&e.key) {
                        self.err(format!("the entry key \"{}\" needs letters, digits or _ only", e.key));
                        continue;
                    }
                    if !seen.insert(e.key.clone()) {
                        self.err(format!("two entries are called {}", e.key));
                    }
                    let mut entry = shape.clone();
                    for (k, v) in &e.values {
                        if entry.contains_key(k) {
                            entry.insert(k.clone(), v.clone());
                        }
                    }
                    entries.insert(e.key.clone(), Value::Object(entry));
                }
                template.insert(key, Value::Object(entries));
            }
            NodeKind::Action => {
                if in_list {
                    self.err("actions can't go inside a list entry");
                    return;
                }
                if !valid_key(&n.key) {
                    self.err(format!("the action key \"{}\" needs letters, digits or _ only", n.key));
                    return;
                }
                if self.def.actions.iter().any(|a| a.id == n.key) {
                    self.err(format!("two actions are called {}", n.key));
                    return;
                }
                if let Some(w) = &n.when {
                    if !w.trim().is_empty() {
                        check_formula(&mut self.errors, &self.trail.join(" › "), w);
                    }
                }
                self.def.actions.push(ActionDef {
                    id: n.key.clone(),
                    label: if n.label.is_empty() { n.key.clone() } else { n.label.clone() },
                    kind: if n.roll_kind.is_empty() { "other".into() } else { n.roll_kind.clone() },
                    roll: n.roll.clone(),
                    then: n.then.clone(),
                    cost: n.cost.clone().filter(|c| !c.path.trim().is_empty()),
                    when: n.when.clone().filter(|w| !w.trim().is_empty()),
                    threat: (!n.threat.trim().is_empty()).then(|| n.threat.clone()),
                    confirm: n.confirm,
                    crit_mult: (!n.crit_mult.trim().is_empty()).then(|| n.crit_mult.clone()),
                });
            }
            NodeKind::Effect => {
                if !self.is_item {
                    self.err("effects belong on item types (conditions cover actors)");
                    return;
                }
                for c in &n.changes {
                    check_formula(&mut self.errors, &self.trail.join(" › "), &c.value);
                }
                self.def.effects.push(Effect {
                    id: n.key.clone(),
                    name: if n.label.is_empty() { n.key.clone() } else { n.label.clone() },
                    requires: n.when.clone().filter(|w| !w.trim().is_empty()),
                    changes: n.changes.clone(),
                    ..Default::default()
                });
            }
        }
    }
}

/// Merge what the builder made with what `hearth.toml` declares by hand:
/// the hand-written parts win where both say something.
pub fn merge_type(built: TypeDef, hand: Option<&TypeDef>) -> TypeDef {
    let Some(hand) = hand else { return built };
    let mut out = built;
    if hand.label.is_some() {
        out.label = hand.label.clone();
    }
    if hand.sheet.is_some() {
        out.sheet = hand.sheet.clone();
    }
    if !hand.template.is_null() {
        hearth_core::patch::merge_patch(&mut out.template, &hand.template);
    }
    out.formulas.extend(hand.formulas.clone());
    out.resources.extend(hand.resources.clone());
    for a in &hand.actions {
        out.actions.retain(|x| x.id != a.id);
        out.actions.push(a.clone());
    }
    out.effects.extend(hand.effects.clone());
    if hand.levels.is_some() {
        out.levels = hand.levels.clone();
    }
    out.grants |= hand.grants;
    if !hand.advancement.is_empty() {
        out.advancement = hand.advancement.clone();
    }
    if hand.forge.is_some() {
        out.forge = hand.forge.clone();
    }
    out
}

/// Keys present in `template` but missing from `data` (recursively), as a merge patch.
pub fn missing_from(template: &Value, data: &Value) -> Option<Value> {
    let Value::Object(t) = template else { return None };
    let d = data.as_object();
    let mut patch = Map::new();
    for (k, tv) in t {
        match d.and_then(|d| d.get(k)) {
            None | Some(Value::Null) => {
                patch.insert(k.clone(), tv.clone());
            }
            Some(dv) => {
                if tv.is_object() && dv.is_object() {
                    if let Some(p) = missing_from(tv, dv) {
                        patch.insert(k.clone(), p);
                    }
                }
            }
        }
    }
    (!patch.is_empty()).then_some(Value::Object(patch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Blueprint {
        serde_json::from_value(json!({
            "rests": ["short", "long"],
            "tables": { "proficiency": { "1": 2, "5": 3 } },
            "actor_types": [ { "key": "character", "label": "Character", "kind": "type", "children": [
                { "key": "level", "kind": "number", "default": 1 },
                { "key": "abilities", "label": "Abilities", "kind": "list",
                  "entries": [ { "key": "str", "label": "Strength", "values": { "value": 15 } }, { "key": "dex", "label": "Dexterity" } ],
                  "children": [
                    { "key": "value", "kind": "number", "default": 10 },
                    { "key": "mod", "kind": "formula", "formula": "floor((@this.value - 10) / 2)" } ] },
                { "key": "combat", "label": "Combat", "kind": "group", "children": [
                    { "key": "hp", "label": "Hit points", "kind": "resource", "default": 10, "reset": { "long": "max" }, "bar": true },
                    { "key": "ac", "label": "Armour class", "kind": "formula", "formula": "10 + @abilities.dex.mod" },
                    { "key": "init", "label": "Initiative", "kind": "action", "roll_kind": "check", "roll": "1d20 + @abilities.dex.mod" } ] },
                { "key": "notes", "kind": "longtext" },
                { "key": "alignment", "kind": "choice", "options": [ { "value": "good" }, { "value": "evil" } ] }
            ] } ],
            "item_types": [ { "key": "armour", "label": "Armour", "kind": "type", "children": [
                { "key": "base", "kind": "number", "default": 11 },
                { "key": "equipped", "kind": "checkbox" },
                { "key": "ac", "kind": "effect", "when": "@item.equipped",
                  "changes": [ { "path": "combat.ac", "mode": "upgrade", "value": "@item.base + @abilities.dex.mod" } ] }
            ] } ]
        }))
        .unwrap()
    }

    #[test]
    fn compiles_templates_and_rules() {
        let c = compile(&sample());
        assert!(c.errors.is_empty(), "{:?}", c.errors);
        let ch = &c.actor_types["character"];
        assert_eq!(ch.template, json!({
            "level": 1,
            "abilities": { "str": { "value": 15 }, "dex": { "value": 10 } },
            "combat": { "hp": { "value": 10, "max": 10 } },
            "notes": "",
            "alignment": "good"
        }));
        assert_eq!(ch.formulas["abilities.*.mod"], "floor((@this.value - 10) / 2)");
        assert_eq!(ch.formulas["combat.ac"], "10 + @abilities.dex.mod");
        assert!(ch.resources["combat.hp"].bar);
        assert_eq!(ch.actions[0].id, "init");
        assert_eq!(ch.actions[0].kind, "check");
        let ar = &c.item_types["armour"];
        assert_eq!(ar.template, json!({ "base": 11, "equipped": false }));
        assert_eq!(ar.effects[0].requires.as_deref(), Some("@item.equipped"));
    }

    #[test]
    fn layout_only_groups_keep_their_parents_paths() {
        let mut bp = sample();
        let ch = &mut bp.actor_types[0];
        ch.children.push(Node {
            key: "combat_tab".into(),
            kind: NodeKind::Group,
            flat: true,
            children: vec![
                Node { key: "speed".into(), kind: NodeKind::Number, default: serde_json::json!(30), ..Default::default() },
                Node { key: "fast".into(), kind: NodeKind::Formula, formula: "@speed * 2".into(), ..Default::default() },
            ],
            ..Default::default()
        });
        let c = compile(&bp);
        assert!(c.errors.is_empty(), "{:?}", c.errors);
        let t = &c.actor_types["character"];
        assert_eq!(t.template["speed"], 30);
        assert!(t.template.get("combat_tab").is_none());
        assert_eq!(t.formulas["fast"], "@speed * 2");
    }

    #[test]
    fn sheet_settings_and_designed_layouts() {
        let mut bp = sample();
        // A hand-made HTML sheet only counts while the type is set to use it.
        bp.item_types[0].sheet = Some("sheets/item-armour.html".into());
        assert_eq!(compile(&bp).item_types["armour"].sheet.as_deref(), Some("sheets/item-armour.html"), "legacy: a file means HTML");
        bp.item_types[0].sheet_mode = "none".into();
        let c = compile(&bp);
        assert!(c.errors.is_empty(), "{:?}", c.errors);
        assert!(c.item_types["armour"].sheet.is_none(), "the file is kept but not used");
        // Actors always need a sheet; designed ones need a layout whose blocks show real fields.
        bp.actor_types[0].sheet_mode = "none".into();
        assert!(compile(&bp).errors.join("\n").contains("actors always need a sheet"));
        bp.actor_types[0].sheet_mode = "designed".into();
        assert!(compile(&bp).errors.join("\n").contains("has no layout yet"));
        bp.actor_types[0].layouts = vec![json!({ "id": "main", "name": "Main", "tabs": [ { "key": "main", "blocks": [
            { "kind": "field", "bind": "combat.ac" },
            { "kind": "field", "bind": "abilities" },
            { "kind": "group", "title": "Box", "blocks": [ { "kind": "field", "bind": "combat.hp" }, { "kind": "items", "item_type": "armour" } ] }
        ] } ] })];
        let c = compile(&bp);
        assert!(c.errors.is_empty(), "{:?}", c.errors);
        // Several layouts: ids must differ, and the default must be one of them.
        bp.actor_types[0].layouts.push(json!({ "id": "main", "name": "Play", "tabs": [] }));
        assert!(compile(&bp).errors.join("\n").contains("used twice"));
        bp.actor_types[0].layouts[1]["id"] = json!("play");
        bp.actor_types[0].default_layout = "play".into();
        assert!(compile(&bp).errors.is_empty());
        bp.actor_types[0].default_layout = "gone".into();
        assert!(compile(&bp).errors.join("\n").contains("default layout \"gone\" doesn't exist"));
        bp.actor_types[0].default_layout.clear();
        bp.actor_types[0].layouts.pop();
        bp.actor_types[0].layouts[0]["tabs"][0]["blocks"][0]["bind"] = json!("combat.armor_class");
        bp.actor_types[0].layouts[0]["tabs"][0]["blocks"][2]["blocks"][1]["item_type"] = json!("shield");
        let errs = compile(&bp).errors.join("\n");
        assert!(errs.contains("Character › Main: a block shows @combat.armor_class"), "{errs}");
        assert!(errs.contains("items of type \"shield\""), "{errs}");
    }

    #[test]
    fn reports_problems() {
        let mut bp = sample();
        let ch = &mut bp.actor_types[0];
        ch.children.push(Node { key: "bad key".into(), kind: NodeKind::Number, ..Default::default() });
        ch.children.push(Node { key: "level".into(), kind: NodeKind::Number, ..Default::default() });
        ch.children.push(Node { key: "broken".into(), kind: NodeKind::Formula, formula: "1 +".into(), ..Default::default() });
        ch.children.push(Node { key: "fx".into(), kind: NodeKind::Effect, ..Default::default() });
        let errs = compile(&bp).errors.join("\n");
        assert!(errs.contains("bad key"), "{errs}");
        assert!(errs.contains("two fields here are called level"), "{errs}");
        assert!(errs.contains("Character › broken"), "{errs}");
        assert!(errs.contains("effects belong on item types"), "{errs}");
    }

    #[test]
    fn hand_written_rules_win_and_missing_keys_are_found() {
        let built = compile(&sample()).actor_types["character"].clone();
        let hand = TypeDef { formulas: BTreeMap::from([("combat.ac".to_string(), "99".to_string())]), ..Default::default() };
        assert_eq!(merge_type(built.clone(), Some(&hand)).formulas["combat.ac"], "99");
        let data = json!({ "level": 3, "abilities": { "str": { "value": 18 } } });
        let patch = missing_from(&built.template, &data).unwrap();
        assert_eq!(patch["abilities"], json!({ "dex": { "value": 10 } }), "only what's missing");
        assert!(patch.get("level").is_none());
        assert!(patch["combat"].is_object());
    }
}
