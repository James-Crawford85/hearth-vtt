use std::collections::BTreeMap;

use hearth_dice::RollResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Id = String;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Gm,
    #[default]
    Player,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct User {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub role: Role,
    #[serde(default = "default_color")]
    pub color: String,
}

fn default_color() -> String {
    "#e0a040".into()
}

/// A world is one campaign: its scenes, actors, chat log and settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct World {
    pub id: Id,
    pub name: String,
    /// Shown on the launcher and join screen.
    #[serde(default)]
    pub description: String,
    /// When the group next plays, as set by the GM (ISO `YYYY-MM-DDTHH:MM`, local time).
    #[serde(default)]
    pub next_session: Option<String>,
    /// Package id of the game system (e.g. `d20-lite`).
    pub system: String,
    /// Enabled module package ids, in load order.
    #[serde(default)]
    pub modules: Vec<String>,
    /// Theme package id, or none for the built-in theme.
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub active_scene: Option<Id>,
    #[serde(default)]
    pub scenes: BTreeMap<Id, Scene>,
    #[serde(default)]
    pub actors: BTreeMap<Id, Actor>,
    #[serde(default)]
    pub users: BTreeMap<Id, User>,
    #[serde(default)]
    pub chat: Vec<ChatMessage>,
    /// Free-form world settings, namespaced by package id.
    #[serde(default)]
    pub settings: Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GridKind {
    #[default]
    Square,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Grid {
    #[serde(default)]
    pub kind: GridKind,
    /// Pixels per grid cell.
    pub size: u32,
    /// In-game distance per cell (e.g. 5).
    #[serde(default = "default_distance")]
    pub distance: f64,
    #[serde(default = "default_units")]
    pub units: String,
    #[serde(default = "default_grid_color")]
    pub color: String,
}

fn default_distance() -> f64 {
    5.0
}
fn default_units() -> String {
    "ft".into()
}
fn default_grid_color() -> String {
    "rgba(255,255,255,0.15)".into()
}

impl Default for Grid {
    fn default() -> Self {
        Grid {
            kind: GridKind::Square,
            size: 70,
            distance: default_distance(),
            units: default_units(),
            color: default_grid_color(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Scene {
    pub id: Id,
    pub name: String,
    /// Width and height in pixels.
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default = "default_bg_color")]
    pub background_color: String,
    #[serde(default)]
    pub grid: Grid,
    #[serde(default)]
    pub tokens: BTreeMap<Id, Token>,
    #[serde(default)]
    pub flags: Value,
}

fn default_bg_color() -> String {
    "#1d1f24".into()
}

impl Scene {
    pub fn new(name: impl Into<String>, cols: u32, rows: u32) -> Scene {
        let grid = Grid::default();
        Scene {
            id: crate::new_id(),
            name: name.into(),
            width: cols * grid.size,
            height: rows * grid.size,
            background: None,
            background_color: default_bg_color(),
            grid,
            tokens: BTreeMap::new(),
            flags: Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Token {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub actor_id: Option<Id>,
    /// Top-left position in pixels.
    pub x: f64,
    pub y: f64,
    /// Size in grid cells.
    #[serde(default = "one")]
    pub w: f64,
    #[serde(default = "one")]
    pub h: f64,
    #[serde(default)]
    pub img: Option<String>,
    #[serde(default = "default_token_color")]
    pub color: String,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default = "default_true")]
    pub show_name: bool,
    #[serde(default)]
    pub flags: Value,
}

fn one() -> f64 {
    1.0
}
fn default_token_color() -> String {
    "#5b8def".into()
}

/// Characters, NPCs, vehicles… whatever the system defines in `actor_types`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Actor {
    pub id: Id,
    pub name: String,
    /// System-defined type, e.g. `character` or `npc`.
    pub kind: String,
    #[serde(default)]
    pub img: Option<String>,
    /// User ids that may edit this actor and move its tokens.
    #[serde(default)]
    pub owners: Vec<Id>,
    /// System data, seeded from the system's actor template.
    #[serde(default)]
    pub data: Value,
    /// Values computed by the system's `prepare_actor` script hook.
    /// Never written by clients.
    #[serde(default)]
    pub derived: Value,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub flags: Value,
}

impl Actor {
    pub fn item_mut(&mut self, id: &str) -> Option<&mut Item> {
        self.items.iter_mut().find(|i| i.id == id)
    }
}

/// Weapons, spells, features… owned by an actor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: Id,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub img: Option<String>,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub flags: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub id: Id,
    pub author: Id,
    pub author_name: String,
    /// Plain text; clients must escape it when rendering.
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub flavor: Option<String>,
    #[serde(default)]
    pub roll: Option<RollResult>,
    /// If non-empty, only these users (and GMs) can see the message.
    #[serde(default)]
    pub whisper: Vec<Id>,
    /// Unix milliseconds.
    pub ts: u64,
    #[serde(default)]
    pub speaker_actor: Option<Id>,
    #[serde(default)]
    pub flags: Value,
}

impl ChatMessage {
    pub fn visible_to(&self, user: &User) -> bool {
        user.role == Role::Gm || self.whisper.is_empty() || self.whisper.contains(&user.id) || self.author == user.id
    }
}

impl World {
    pub fn new(name: impl Into<String>, system: impl Into<String>) -> World {
        let scene = Scene::new("Starting Scene", 30, 20);
        let scene_id = scene.id.clone();
        World {
            id: crate::new_id(),
            name: name.into(),
            description: String::new(),
            next_session: None,
            system: system.into(),
            modules: vec![],
            theme: None,
            active_scene: Some(scene_id.clone()),
            scenes: BTreeMap::from([(scene_id, scene)]),
            actors: BTreeMap::new(),
            users: BTreeMap::new(),
            chat: vec![],
            settings: Value::Object(Default::default()),
        }
    }

    pub fn owns_actor(&self, user: &User, actor_id: &str) -> bool {
        user.role == Role::Gm
            || self.actors.get(actor_id).is_some_and(|a| a.owners.contains(&user.id))
    }

    /// The world as a given user is allowed to see it: hidden tokens and
    /// other people's whispers are removed for players.
    pub fn view_for(&self, user: &User) -> World {
        if user.role == Role::Gm {
            return self.clone();
        }
        let mut w = self.clone();
        for scene in w.scenes.values_mut() {
            scene.tokens.retain(|_, t| !t.hidden);
        }
        w.chat.retain(|m| m.visible_to(user));
        w
    }
}
