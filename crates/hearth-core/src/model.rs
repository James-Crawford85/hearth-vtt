use std::collections::BTreeMap;

use hearth_dice::RollResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::scoped::Shared;

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
    /// The running encounter, if any.
    #[serde(default)]
    pub combat: Option<Combat>,
    /// Journal entries (notes, handouts, lore). Players receive only what they may see.
    #[serde(default)]
    pub journal: BTreeMap<Id, JournalEntry>,
    /// The Items directory.
    #[serde(default)]
    pub items: BTreeMap<Id, LibraryItem>,
    #[serde(default)]
    pub tables: BTreeMap<Id, RollTable>,
    #[serde(default)]
    pub macros: BTreeMap<Id, Macro>,
    /// Content libraries made in this world.
    #[serde(default)]
    pub collections: BTreeMap<Id, Collection>,
    /// Music and ambience playlists (the GM plays them for everyone).
    #[serde(default)]
    pub playlists: BTreeMap<Id, Playlist>,
    /// Each user's hotbar: user id → slot (1–10) → macro id.
    #[serde(default)]
    pub hotbars: BTreeMap<Id, BTreeMap<u8, Id>>,
    /// Explored areas: scene id → user id → bitmap. Players only receive their own.
    #[serde(default)]
    pub fog: BTreeMap<Id, BTreeMap<Id, FogMap>>,
    /// Free-form world settings, namespaced by package id.
    #[serde(default)]
    pub settings: Value,
    /// Textures made in the texture creator (used on sketched maps as `tex:<id>`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub textures: BTreeMap<Id, TextureRecipe>,
}

/// A texture made in the texture creator: a recipe (textures, masks, colour changes) that every
/// client draws into the same repeating tile. The recipe is the client's to read; the server
/// only keeps it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TextureRecipe {
    pub id: Id,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub recipe: Value,
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
    /// Where the background image sits and how big it is (set by aligning it to the grid). Without
    /// it, the image is stretched over the whole scene.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_fit: Option<BackgroundFit>,
    #[serde(default = "default_bg_color")]
    pub background_color: String,
    #[serde(default)]
    pub grid: Grid,
    #[serde(default)]
    pub tokens: BTreeMap<Id, Token>,
    /// Walls and doors that block sight and movement.
    #[serde(default)]
    pub walls: BTreeMap<Id, Wall>,
    /// Shapes, freehand lines and text drawn on the map (under tokens).
    #[serde(default)]
    pub drawings: BTreeMap<Id, Drawing>,
    /// A map the GM sketched on the scene: painted floor squares (drawn over the background).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch: Option<Sketch>,
    #[serde(default)]
    pub vision: Vision,
    /// Light sources placed on the map.
    #[serde(default)]
    pub lights: BTreeMap<Id, Light>,
    /// Sounds placed on the map, heard by tokens within their radius.
    #[serde(default)]
    pub sounds: BTreeMap<Id, AmbientSound>,
    /// 0 = full daylight, 1 = pitch dark. At half or more, tokens see only
    /// lit areas and what their own sight (darkvision) reaches.
    #[serde(default)]
    pub darkness: f64,
    /// Levels besides the ground level (floors above, cellars below). Tokens, walls, lights and
    /// drawings say which level they're on; the background map is the ground's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub levels: Vec<Level>,
    /// The ground level's name (none: "Ground").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ground_name: Option<String>,
    /// The sketches of the levels besides the ground (whose sketch is `sketch`), by level.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub level_sketches: BTreeMap<Id, Sketch>,
    /// Ways between levels (stairs, ladders…): stand in one to go to another level.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub links: BTreeMap<Id, Link>,
    #[serde(default)]
    pub flags: Value,
}

/// A level of a scene: a floor above the ground (`elevation` > 0) or below it (< 0).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Level {
    pub id: Id,
    pub name: String,
    pub elevation: f64,
}

/// A way from one level to another: a token whose middle is inside `poly` (scene px) on
/// `level` can go to level `to`, at `at` if given (else where it stands).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Link {
    pub id: Id,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub level: Id,
    pub poly: Vec<[f64; 2]>,
    #[serde(default)]
    pub to: Id,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<[f64; 2]>,
}

impl Link {
    pub fn contains(&self, p: [f64; 2]) -> bool {
        let n = self.poly.len();
        let mut inside = false;
        let mut j = n.wrapping_sub(1);
        for i in 0..n {
            let (a, b) = (self.poly[i], self.poly[j]);
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
            j = i;
        }
        inside
    }
}

/// A background image's place on its scene: its top-left corner (scene pixels, may be negative
/// to crop) and its scale per image pixel on each axis.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct BackgroundFit {
    pub x: f64,
    pub y: f64,
    pub sx: f64,
    pub sy: f64,
}

/// A sketched map: floor painted onto grid squares and round rooms, with walls along the rooms'
/// edges, walls and openings the GM added, and light sources. Its walls and lights are ordinary
/// walls and lights whose ids start with `sk-` (see `Op::SketchUpdate`), so vision, lighting and
/// movement need nothing special. Positions are in grid squares, so the sketch follows the grid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Sketch {
    /// Room squares (walls along their edges), `"col,row"` → material: a built-in texture
    /// (`stone`, `wood`, …) or an uploaded image's URL.
    #[serde(default)]
    pub cells: BTreeMap<String, String>,
    /// Floor squares without walls (porches, paths, water), `"col,row"` → material.
    #[serde(default)]
    pub floor: BTreeMap<String, String>,
    /// Grid edges the GM set, `"h:col,row"` (a square's top) or `"v:col,row"` (its left) →
    /// `wall`, `open` (no wall), `door`, `secret_door` or `window`.
    #[serde(default)]
    pub edges: BTreeMap<String, String>,
    /// Round rooms and floors.
    #[serde(default)]
    pub shapes: BTreeMap<Id, SketchShape>,
    /// Walls off the grid lines (diagonals), from corner to corner in squares.
    #[serde(default)]
    pub lines: BTreeMap<Id, SketchLine>,
    /// Props drawn on the map: light sources (torch, brazier, …, each with its light) and
    /// furniture and nature (table, barrel, tree, …).
    #[serde(default)]
    pub props: BTreeMap<Id, SketchProp>,
    /// Roofs over buildings, seen from outside.
    #[serde(default)]
    pub roofs: BTreeMap<Id, SketchRoof>,
    /// Wall styles for single grid edges, edge key → style (overriding `wall_style`).
    #[serde(default)]
    pub styles: BTreeMap<String, String>,
    /// How walls are drawn: `ink` (a line, the default) or a texture (`stone`, `brick`, …).
    #[serde(default)]
    pub wall_style: Option<String>,
    /// What fills the scene around the floor (a material), or none to show the map underneath.
    #[serde(default)]
    pub outside: Option<String>,
    /// Draw walls along the rooms' edges.
    #[serde(default = "default_true")]
    pub walls: bool,
    /// The grid size (pixels) the walls and lights were last worked out for.
    #[serde(default)]
    pub size: u32,
}

impl Default for Sketch {
    fn default() -> Self {
        Self {
            cells: BTreeMap::new(),
            floor: BTreeMap::new(),
            edges: BTreeMap::new(),
            shapes: BTreeMap::new(),
            lines: BTreeMap::new(),
            props: BTreeMap::new(),
            roofs: BTreeMap::new(),
            styles: BTreeMap::new(),
            wall_style: None,
            outside: None,
            walls: true,
            size: 0,
        }
    }
}

/// A round room (walled) or round floor, centred at `x, y` with radius `r`, in squares.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SketchShape {
    #[serde(default = "circle")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub r: f64,
    pub material: String,
    #[serde(default = "default_true")]
    pub walled: bool,
    /// Its wall's style, if not the sketch's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wall_style: Option<String>,
}

fn circle() -> String {
    "circle".into()
}

/// A wall from corner `a` to corner `b`, in squares.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SketchLine {
    pub a: [f64; 2],
    pub b: [f64; 2],
    #[serde(default)]
    pub kind: WallKind,
    /// Its style, if not the sketch's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

/// A prop drawn on the map, centred at `x, y` in squares, turned `rot` degrees and sized `scale`
/// times its usual size: a light source (`torch`, `brazier`, `candles`, `campfire`, `lantern`,
/// `crystal`) or furniture and nature (`table`, `barrel`, `tree`, …). `blocks`: it stands in the
/// way (walls round it).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SketchProp {
    pub kind: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub rot: f64,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub blocks: bool,
    /// Stairs, ladders…: the level it leads to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Id>,
    /// Its parts' looks, by part id: a colour (`#rrggbb`) or a texture (a built-in, an uploaded
    /// picture or `tex:<id>`). Parts not listed keep their own look.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub colors: BTreeMap<String, String>,
    /// A light source's own light, in the scene's distance units, instead of its usual one (its
    /// colour comes from its `glow` part).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light: Option<TokenLight>,
}

/// A roof: a rectangle of `w` × `h` squares from `x, y`, its ridge along the longer side
/// unless `ridge` says (`h` or `v`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SketchRoof {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub material: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ridge: Option<String>,
}

/// Walls and lights drawn from a scene's sketch have ids with this prefix.
pub const SKETCH_WALL: &str = "sk-";

/// A light source on a scene. Radii are in the scene's distance units.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Light {
    pub id: Id,
    pub x: f64,
    pub y: f64,
    /// Fully lit out to here…
    #[serde(default)]
    pub bright: f64,
    /// …then dim light out to here.
    #[serde(default)]
    pub dim: f64,
    /// Tint colour, or none for plain light.
    #[serde(default)]
    pub color: Option<String>,
    /// How strongly the colour tints what it lights, 0–1 (none: 0.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<f64>,
    /// How it moves: a flicker, a pulse, swirling energy…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anim: Option<LightAnim>,
    /// Switched off.
    #[serde(default)]
    pub off: bool,
    /// The level it is on (empty: the scene's ground level).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub level: Id,
}

/// A looping sound placed on a scene. Tokens hear it louder the closer they
/// are, out to `radius` (in the scene's distance units).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AmbientSound {
    pub id: Id,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub radius: f64,
    /// Audio file URL.
    #[serde(default)]
    pub src: String,
    /// 0–1.
    #[serde(default = "one_f64")]
    pub volume: f64,
    #[serde(default)]
    pub off: bool,
    /// Walls that block sound muffle it.
    #[serde(default = "default_true")]
    pub walls: bool,
}

fn one_f64() -> f64 {
    1.0
}

/// How a playlist plays its tracks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PlaylistMode {
    /// One track after another, in order.
    #[default]
    Sequential,
    /// One track after another, in random order.
    Shuffle,
    /// All tracks at once (layered ambience).
    Simultaneous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Playlist {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub mode: PlaylistMode,
    /// Music or ambience: players set their own volume for each.
    #[serde(default)]
    pub ambience: bool,
    #[serde(default)]
    pub sounds: BTreeMap<Id, PlaylistSound>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlaylistSound {
    pub id: Id,
    pub name: String,
    pub src: String,
    /// 0–1.
    #[serde(default = "one_f64")]
    pub volume: f64,
    /// Loop this track.
    #[serde(default)]
    pub repeat: bool,
    #[serde(default)]
    pub playing: bool,
    /// When it started playing (server Unix ms), so late joiners hear the same moment.
    #[serde(default)]
    pub started: u64,
    /// Position in the playlist.
    #[serde(default)]
    pub sort: i64,
}

/// Light carried by a token (a torch, a lantern), in distance units.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TokenLight {
    #[serde(default)]
    pub bright: f64,
    #[serde(default)]
    pub dim: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anim: Option<LightAnim>,
}

/// A light's animation. `kind`: `candle`, `torch`, `campfire`, `pulse`, `swirl`, `smoke`,
/// `vortex`, `rays`, `fairy`, `chroma`, `storm`, `ghost` (an unknown kind is still light).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LightAnim {
    pub kind: String,
    /// 1 is its usual pace.
    #[serde(default = "one")]
    pub speed: f64,
    /// How much it moves, 0–1.
    #[serde(default = "half")]
    pub strength: f64,
}

fn half() -> f64 {
    0.5
}

/// Per-scene vision rules. Everything is off by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Vision {
    /// Players only see what their tokens can see.
    #[serde(default)]
    pub enabled: bool,
    /// Remember (dimmed) the areas each player has explored.
    #[serde(default)]
    pub fog: bool,
    /// Sight range in the scene's distance units (e.g. 60 ft); 0 = unlimited.
    #[serde(default)]
    pub range: f64,
}

/// What a wall blocks:
///
/// | kind        | movement | sight            | sound            |
/// |-------------|----------|------------------|------------------|
/// | wall        | yes      | yes              | yes              |
/// | terrain     | yes      | past a 2nd one   | past a 2nd one   |
/// | invisible   | yes      | no               | no               |
/// | ethereal    | no       | yes              | yes              |
/// | door        | closed   | closed           | closed           |
/// | secret_door | closed   | closed           | closed           |  (looks like a wall to players)
/// | window      | yes      | no               | yes              |
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WallKind {
    #[default]
    Wall,
    Terrain,
    Invisible,
    Ethereal,
    Door,
    SecretDoor,
    Window,
}

/// How a wall affects sight (or sound) passing through it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sense {
    Pass,
    /// Terrain walls: you can see past one, but not past two.
    Limited,
    Block,
}

/// A wall segment from `a` to `b`, in scene pixels.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Wall {
    pub id: Id,
    pub a: [f64; 2],
    pub b: [f64; 2],
    #[serde(default)]
    pub kind: WallKind,
    /// Doors only.
    #[serde(default)]
    pub open: bool,
    /// Doors only: players can't open or close a locked door.
    #[serde(default)]
    pub locked: bool,
    /// The level it is on (empty: the scene's ground level).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub level: Id,
}

impl Wall {
    pub fn is_door(&self) -> bool {
        matches!(self.kind, WallKind::Door | WallKind::SecretDoor)
    }

    fn open_door(&self) -> bool {
        self.is_door() && self.open
    }

    pub fn blocks_movement(&self) -> bool {
        !self.open_door() && self.kind != WallKind::Ethereal
    }

    pub fn sight(&self) -> Sense {
        match self.kind {
            _ if self.open_door() => Sense::Pass,
            WallKind::Invisible | WallKind::Window => Sense::Pass,
            WallKind::Terrain => Sense::Limited,
            _ => Sense::Block,
        }
    }

    pub fn sound(&self) -> Sense {
        match self.kind {
            _ if self.open_door() => Sense::Pass,
            WallKind::Invisible => Sense::Pass,
            WallKind::Terrain => Sense::Limited,
            _ => Sense::Block,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DrawingKind {
    #[default]
    Rect,
    Ellipse,
    Polygon,
    Freehand,
    Text,
}

/// A drawing on a scene. Rectangles, ellipses and text fill the box at
/// (`x`, `y`) sized `w` × `h`; polygons and freehand lines use `points`,
/// relative to (`x`, `y`). All in scene pixels.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Drawing {
    pub id: Id,
    /// The level it is on (empty: the scene's ground level).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub level: Id,

    #[serde(default)]
    pub kind: DrawingKind,
    /// Who drew it; players may only change their own drawings.
    #[serde(default)]
    pub author: Id,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
    #[serde(default)]
    pub points: Vec<[f64; 2]>,
    #[serde(default = "default_stroke")]
    pub stroke: String,
    #[serde(default = "default_stroke_width")]
    pub stroke_width: f64,
    /// Fill colour, or none.
    #[serde(default)]
    pub fill: Option<String>,
    #[serde(default = "default_fill_alpha")]
    pub fill_alpha: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
}

fn default_stroke() -> String {
    "#e0a040".into()
}
fn default_stroke_width() -> f64 {
    4.0
}
fn default_fill_alpha() -> f64 {
    0.2
}
fn default_font_size() -> f64 {
    32.0
}

/// Which parts of a scene one player has explored: a bitmap at half-grid
/// resolution (`cols` × `rows`, row-major, LSB first), base64-encoded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FogMap {
    pub cols: u32,
    pub rows: u32,
    pub data: String,
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
            background_fit: None,
            background_color: default_bg_color(),
            grid,
            tokens: BTreeMap::new(),
            walls: BTreeMap::new(),
            drawings: BTreeMap::new(),
            sketch: None,
            vision: Vision::default(),
            lights: BTreeMap::new(),
            sounds: BTreeMap::new(),
            darkness: 0.0,
            levels: Vec::new(),
            ground_name: None,
            level_sketches: BTreeMap::new(),
            links: BTreeMap::new(),
            flags: Value::Null,
        }
    }

    /// Pixel centre of a token.
    pub fn token_center(&self, t: &Token) -> [f64; 2] {
        let g = self.grid.size as f64;
        [t.x + t.w * g / 2.0, t.y + t.h * g / 2.0]
    }

    /// Would moving in a straight line from `from` to `to` pass through a
    /// wall or closed door?
    pub fn move_blocked(&self, from: [f64; 2], to: [f64; 2]) -> bool {
        self.move_blocked_on("", from, to)
    }

    /// Would a move on `level` cross a wall there?
    pub fn move_blocked_on(&self, level: &str, from: [f64; 2], to: [f64; 2]) -> bool {
        self.walls.values().filter(|w| w.level == level && w.blocks_movement()).any(|w| crate::geometry::segments_cross(from, to, w.a, w.b))
    }

    /// Is `level` one of this scene's levels (empty: the ground)?
    pub fn has_level(&self, level: &str) -> bool {
        level.is_empty() || self.levels.iter().any(|l| l.id == level)
    }

    /// A link on `level` at a point that leads to `to`.
    pub fn link_to(&self, level: &str, at: [f64; 2], to: &str) -> Option<&Link> {
        self.links.values().find(|l| l.level == level && l.to == to && l.contains(at))
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
    /// How far this token sees without light (darkvision), in distance units.
    #[serde(default)]
    pub sight: f64,
    /// Light this token gives off, if any.
    #[serde(default)]
    pub light: Option<TokenLight>,
    /// The level the token is on (empty: the scene's ground level).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub level: Id,
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
    /// Effects on this actor: conditions, spells, temporary bonuses.
    #[serde(default)]
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub flags: Value,
}

impl Actor {
    pub fn item_mut(&mut self, id: &str) -> Option<&mut Item> {
        self.items.iter_mut().find(|i| i.id == id)
    }
}

/// Weapons, spells, features… owned by an actor.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub id: Id,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub img: Option<String>,
    #[serde(default)]
    pub data: Value,
    /// Effects this item gives whoever carries it (while `requires` holds).
    #[serde(default)]
    pub effects: Vec<Effect>,
    /// What the item gives as it levels (classes) or when added (ancestries,
    /// backgrounds). See `crate::advance`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub advancement: Vec<crate::advance::Grant>,
    /// Items attached to this one (a weapon's flaming ability, armor's mithral). Their
    /// effects' changes to `item.<field>` change this item; others change its owner.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<Item>,
    #[serde(default)]
    pub flags: Value,
}

/// A change to an actor's values: from a condition, an item, a spell…
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Effect {
    #[serde(default)]
    pub id: Id,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub disabled: bool,
    /// For item effects: only while this formula is true (e.g. `@item.equipped`).
    #[serde(default)]
    pub requires: Option<String>,
    /// A condition id from the system (its changes are added to these).
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub changes: Vec<Change>,
    /// Rounds left, if it runs out.
    #[serde(default)]
    pub rounds: Option<u32>,
    /// What it does, in words (markdown). Conditions show this on hover and in the lookup.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Change {
    /// The value it changes, e.g. `abilities.str.value` or `ac`.
    pub path: String,
    #[serde(default)]
    pub mode: ChangeMode,
    /// A formula.
    pub value: String,
    /// The kind of bonus (`enhancement`, `morale`, `armor`…). Added bonuses of the
    /// same type don't stack: only the biggest counts (penalties always stack, and so
    /// do types the system lists in `stacking`). None: untyped, always stacks.
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub bonus_type: Option<String>,
}

/// How a change applies. Changes run in this order: first the base is
/// picked (`set`, then `upgrade` / `downgrade`, e.g. armour: "at least 13 + Dex"),
/// then it is adjusted (`multiply`, then `add`, e.g. a shield's +2).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeMode {
    /// Replace the value.
    Set = 0,
    /// At least this much.
    Upgrade = 1,
    /// At most this much.
    Downgrade = 2,
    Multiply = 3,
    #[default]
    Add = 4,
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

/// One encounter. Turn order is derived from initiative (see [`Combat::order`]).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Combat {
    pub id: Id,
    pub scene_id: Id,
    /// 0 until the GM starts the combat.
    #[serde(default)]
    pub round: u32,
    /// Combatant whose turn it is.
    #[serde(default)]
    pub current: Option<Id>,
    #[serde(default)]
    pub combatants: Vec<Combatant>,
    #[serde(default)]
    pub flags: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Combatant {
    pub id: Id,
    #[serde(default)]
    pub token_id: Option<Id>,
    #[serde(default)]
    pub actor_id: Option<Id>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub img: Option<String>,
    #[serde(default)]
    pub initiative: Option<f64>,
    /// Hidden from players (e.g. an ambush).
    #[serde(default)]
    pub hidden: bool,
    /// Skipped in the turn order.
    #[serde(default)]
    pub defeated: bool,
}

impl Combat {
    /// Turn order: highest initiative first; unrolled last; ties by name, then id.
    pub fn order(&self) -> Vec<&Combatant> {
        let mut v: Vec<&Combatant> = self.combatants.iter().collect();
        v.sort_by(|a, b| {
            let ia = a.initiative.unwrap_or(f64::NEG_INFINITY);
            let ib = b.initiative.unwrap_or(f64::NEG_INFINITY);
            ib.partial_cmp(&ia)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id))
        });
        v
    }

    fn active_ids(&self) -> Vec<Id> {
        self.order().into_iter().filter(|c| !c.defeated).map(|c| c.id.clone()).collect()
    }

    /// (round, current) for beginning the combat.
    pub fn start_turn(&self) -> (u32, Option<Id>) {
        (1, self.active_ids().into_iter().next())
    }

    /// (round, current) after the current combatant's turn ends.
    pub fn next_turn(&self) -> (u32, Option<Id>) {
        let ids = self.active_ids();
        if ids.is_empty() {
            return (self.round.max(1), None);
        }
        // Position of the current combatant in the full order, so a defeated
        // or removed current still advances to whoever comes after it.
        let order = self.order();
        let pos = self.current.as_ref().and_then(|cur| order.iter().position(|c| &c.id == cur));
        let Some(pos) = pos else { return (self.round.max(1), Some(ids[0].clone())) };
        match order.iter().skip(pos + 1).find(|c| !c.defeated) {
            Some(c) => (self.round.max(1), Some(c.id.clone())),
            None => (self.round.max(1) + 1, Some(ids[0].clone())),
        }
    }

    /// (round, current) going back one turn.
    pub fn prev_turn(&self) -> (u32, Option<Id>) {
        let ids = self.active_ids();
        if ids.is_empty() {
            return (self.round.max(1), None);
        }
        let order = self.order();
        let pos = self.current.as_ref().and_then(|cur| order.iter().position(|c| &c.id == cur));
        let Some(pos) = pos else { return (self.round.max(1), Some(ids[0].clone())) };
        match order.iter().take(pos).rev().find(|c| !c.defeated) {
            Some(c) => (self.round.max(1), Some(c.id.clone())),
            None if self.round > 1 => (self.round - 1, ids.last().cloned()),
            None => (1, Some(ids[0].clone())),
        }
    }

    pub fn combatant(&self, id: &str) -> Option<&Combatant> {
        self.combatants.iter().find(|c| c.id == id)
    }
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
            combat: None,
            journal: BTreeMap::new(),
            items: BTreeMap::new(),
            tables: BTreeMap::new(),
            macros: BTreeMap::new(),
            hotbars: BTreeMap::new(),
            playlists: BTreeMap::new(),
            collections: BTreeMap::new(),
            fog: BTreeMap::new(),
            settings: Value::Object(Default::default()),
            textures: BTreeMap::new(),
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
        if let Some(c) = &mut w.combat {
            c.combatants.retain(|x| !x.hidden);
        }
        w.journal = self.journal.values().filter_map(|e| e.view_for(user)).map(|e| (e.id.clone(), e)).collect();
        w.items = self.items.values().filter_map(|e| e.view_for(user)).map(|e| (e.item.id.clone(), e)).collect();
        w.tables = self.tables.values().filter_map(|e| e.view_for(user)).map(|e| (e.id.clone(), e)).collect();
        w.collections = self.collections.values().filter_map(|e| e.view_for(user)).map(|e| (e.id.clone(), e)).collect();
        w.macros.retain(|_, m| m.visible_to(user));
        w.hotbars.retain(|uid, _| uid == &user.id);
        for per_user in w.fog.values_mut() {
            per_user.retain(|uid, _| uid == &user.id);
        }
        w
    }
}

/// How much of a journal entry a player may see. Ordered: each level includes the ones before it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// Not listed at all.
    #[default]
    None,
    /// Name and image only.
    Limited,
    /// Can read it.
    Observer,
    /// Can read and edit it.
    Owner,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalEntry {
    pub id: Id,
    pub name: String,
    /// Folder name for grouping in the sidebar ("" = none).
    #[serde(default)]
    pub folder: String,
    /// The text, in Markdown.
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub img: Option<String>,
    /// Access for every player.
    #[serde(default)]
    pub access: Access,
    /// Per-player access; a player gets the higher of this and `access`.
    #[serde(default)]
    pub players: BTreeMap<Id, Access>,
}

/// An item in the world's Items directory (not owned by an actor). Drag it
/// onto an actor to give them a copy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LibraryItem {
    #[serde(flatten)]
    pub item: Item,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub access: Access,
    #[serde(default)]
    pub players: BTreeMap<Id, Access>,
}

/// A world collection: a library of ready-made documents of one kind (copies,
/// not the live ones) that the GM can import into the world.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Collection {
    pub id: Id,
    pub name: String,
    /// `actor`, `item`, `journal`, `table` or `macro`.
    pub kind: String,
    /// Entry id → the document as JSON.
    #[serde(default)]
    pub entries: BTreeMap<Id, Value>,
    #[serde(default)]
    pub access: Access,
    #[serde(default)]
    pub players: BTreeMap<Id, Access>,
}

/// A table to roll on: each result's chance is its weight out of the total.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RollTable {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub results: Vec<TableResult>,
    #[serde(default)]
    pub access: Access,
    #[serde(default)]
    pub players: BTreeMap<Id, Access>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TableResult {
    pub text: String,
    #[serde(default = "one_u32")]
    pub weight: u32,
}

fn one_u32() -> u32 {
    1
}

impl RollTable {
    /// The result for a roll of `n` (1-based) on a die the size of the total weight.
    pub fn pick(&self, n: u32) -> Option<&TableResult> {
        let mut acc = 0;
        for r in &self.results {
            acc += r.weight;
            if n <= acc {
                return Some(r);
            }
        }
        None
    }

    pub fn total_weight(&self) -> u32 {
        self.results.iter().map(|r| r.weight).sum()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum MacroKind {
    /// Sent as chat (so `/r 1d20` rolls).
    #[default]
    Chat,
    /// JavaScript run in the clicking user's browser with the client API. GM-only.
    Script,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Macro {
    pub id: Id,
    pub name: String,
    #[serde(default)]
    pub kind: MacroKind,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub img: Option<String>,
    /// Who made it; players see their own macros and shared ones.
    #[serde(default)]
    pub author: Id,
    /// Shared with every player (set by the GM).
    #[serde(default)]
    pub shared: bool,
}
