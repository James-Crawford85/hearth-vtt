//! Authoritative world state: permission checks, op application, rolls and
//! fan-out of events to connected clients.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock as StdRwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use hearth_core::patch::merge_patch;
use hearth_core::protocol::UserAdmin;
use hearth_core::{
    new_id, Access, Actor, ChatMessage, Combatant, FogMap, Id, MacroKind, Op, Role, Scoped, ServerMsg, Shared, User, WallKind, World,
};

use crate::credentials::{self, Credentials};
use crate::fog;
use hearth_packages::{Registry, ScriptHost};
use serde_json::Value;
use tokio::sync::{broadcast, RwLock};

/// Who receives an event.
#[derive(Debug, Clone)]
pub enum Audience {
    All,
    GmOnly,
    PlayersOnly,
    /// These users, plus every GM.
    Users(HashSet<Id>),
    /// Exactly these users.
    Exactly(HashSet<Id>),
}

#[derive(Debug)]
pub struct Event {
    pub msg: ServerMsg,
    pub audience: Audience,
}

impl Event {
    pub fn wants(&self, user: &User) -> bool {
        match &self.audience {
            Audience::All => true,
            Audience::GmOnly => user.role == Role::Gm,
            Audience::PlayersOnly => user.role != Role::Gm,
            Audience::Users(ids) => user.role == Role::Gm || ids.contains(&user.id),
            Audience::Exactly(ids) => ids.contains(&user.id),
        }
    }
}

pub struct AppState {
    pub world: RwLock<World>,
    /// Installed packages. Replaced as a whole when the system builder saves.
    registry: StdRwLock<Arc<Registry>>,
    pub scripts: StdRwLock<ScriptHost>,
    /// The system's declared rules (formulas, resources, actions…).
    rules: StdRwLock<Arc<hearth_core::rules::Rules>>,
    pub tx: broadcast::Sender<Arc<Event>>,
    /// connection id -> user id
    pub online: Mutex<HashMap<u64, Id>>,
    pub dirty: AtomicBool,
    pub world_dir: PathBuf,
    pub credentials: Mutex<Credentials>,
    /// session token -> user id. In memory only: a server restart logs everyone out.
    sessions: Mutex<HashMap<String, Id>>,
    gm_key: String,
    next_conn: AtomicU64,
}

/// Result of a successful join.
pub struct Joined {
    pub user: User,
    pub session: String,
    pub must_change_password: bool,
}

const USER_COLORS: &[&str] = &["#e0a040", "#5b8def", "#e05f5f", "#57c785", "#b07ce8", "#e87cc2", "#4cc9d6", "#c9d64c"];

/// An actor's calculated values: the system's declared rules first, then its
/// `prepare_actor` script on top. Formula problems go in `_errors` so system
/// authors can see them. `None` when the system calculates nothing.
fn compute_derived(rules: &hearth_core::rules::Rules, scripts: &ScriptHost, actor: &Actor) -> Option<Value> {
    let declared = rules.actor_types.contains_key(&actor.kind) || actor.items.iter().any(|i| rules.item_types.contains_key(&i.kind)) || !actor.effects.is_empty();
    let mut out = None;
    if declared {
        let d = hearth_core::rules::derive(actor, rules);
        let mut v = d.values;
        if !d.errors.is_empty() {
            if let Some(o) = v.as_object_mut() {
                o.insert("_errors".into(), serde_json::json!(d.errors.into_iter().take(20).collect::<Vec<_>>()));
            }
        }
        out = Some(v);
    }
    if let Some(script) = scripts.prepare_actor(actor) {
        let mut v = out.unwrap_or_else(|| Value::Object(Default::default()));
        merge_patch(&mut v, &script);
        out = Some(v);
    }
    out
}

/// What players could see of a per-player document before an op (see `scoped_events`).
struct ScopedBefore {
    kind: Scoped,
    id: Id,
    full: Option<Value>,
    views: HashMap<Id, Option<Value>>,
}

/// Longest macro command or table result list, in bytes / entries.
const MAX_MACRO_TEXT: usize = 64 * 1024;
const MAX_TABLE_RESULTS: usize = 1000;

/// Longest journal entry text, in bytes.
const MAX_JOURNAL_TEXT: usize = 256 * 1024;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Look up `a.b.c` in a JSON value and coerce it to an integer.
fn lookup_int(v: &Value, path: &str) -> Option<i64> {
    let mut cur = v;
    for part in path.split('.') {
        cur = match cur {
            Value::Object(m) => m.get(part)?,
            Value::Array(a) => a.get(part.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    match cur {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.floor() as i64)),
        Value::Bool(b) => Some(*b as i64),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl AppState {
    pub fn new(mut world: World, registry: Registry, gm_key: String, world_dir: PathBuf) -> AppState {
        let (scripts, errors) = ScriptHost::load(&registry, &world.system, &world.modules);
        for e in errors {
            tracing::warn!("script error: {e}");
        }
        // Rules may have changed since the world was saved; refresh derived data.
        let rules = registry.rules(&world.system);
        for actor in world.actors.values_mut() {
            if let Some(d) = compute_derived(&rules, &scripts, actor) {
                actor.derived = d;
            }
        }
        let (tx, _) = broadcast::channel(1024);
        AppState {
            world: RwLock::new(world),
            registry: StdRwLock::new(Arc::new(registry)),
            scripts: StdRwLock::new(scripts),
            rules: StdRwLock::new(Arc::new(rules)),
            tx,
            online: Mutex::new(HashMap::new()),
            dirty: AtomicBool::new(true),
            credentials: Mutex::new(Credentials::load(&world_dir)),
            sessions: Mutex::new(HashMap::new()),
            world_dir,
            gm_key,
            next_conn: AtomicU64::new(1),
        }
    }

    pub fn registry(&self) -> Arc<Registry> {
        self.registry.read().unwrap().clone()
    }

    pub fn rules(&self) -> Arc<hearth_core::rules::Rules> {
        self.rules.read().unwrap().clone()
    }

    /// Reload the world's system from disk (after the builder saves it): new
    /// rules and templates, every actor recalculated, and clients told.
    /// Existing actors and items gain any fields the system added.
    pub async fn reload_system(&self) -> Result<(), String> {
        let mut world = self.world.write().await;
        let reg = self.registry();
        let old = reg.get(&world.system).ok_or("the world's system isn't installed")?;
        let pkg = hearth_packages::Package::load(&old.dir).map_err(|e| e.to_string())?;
        let mut next = (*reg).clone();
        next.packages.insert(pkg.manifest.id.clone(), pkg);
        let next = Arc::new(next);
        *self.registry.write().unwrap() = next.clone();
        *self.rules.write().unwrap() = Arc::new(next.rules(&world.system));
        let (host, errors) = ScriptHost::load(&next, &world.system, &world.modules);
        for e in errors {
            tracing::warn!("script error: {e}");
        }
        *self.scripts.write().unwrap() = host;
        // Fill in fields the system gained, then recalculate everyone.
        let system = world.system.clone();
        let ids: Vec<Id> = world.actors.keys().cloned().collect();
        for id in &ids {
            let Some(actor) = world.actors.get(id) else { continue };
            let mut fills = vec![];
            if let Some(p) = hearth_packages::builder::missing_from(&next.actor_template(&system, &actor.kind), &actor.data) {
                fills.push(Op::ActorUpdate { id: id.clone(), patch: serde_json::json!({ "data": p }) });
            }
            for item in &actor.items {
                if let Some(p) = hearth_packages::builder::missing_from(&next.item_template(&system, &item.kind), &item.data) {
                    fills.push(Op::ItemUpdate { actor_id: id.clone(), id: item.id.clone(), patch: serde_json::json!({ "data": p }) });
                }
            }
            for op in fills {
                self.commit(&mut world, &"system".to_string(), op, 0)?;
            }
            self.derive(&mut world, id);
        }
        self.dirty.store(true, Ordering::Release);
        let packages = self.packages_for(&world);
        drop(world);
        self.send(ServerMsg::Packages { packages }, Audience::All);
        Ok(())
    }

    pub fn check_gm_key(&self, key: &str) -> bool {
        !key.is_empty() && constant_time_eq(key.as_bytes(), self.gm_key.as_bytes())
    }

    pub fn next_conn_id(&self) -> u64 {
        self.next_conn.fetch_add(1, Ordering::Relaxed)
    }

    fn send(&self, msg: ServerMsg, audience: Audience) {
        let _ = self.tx.send(Arc::new(Event { msg, audience }));
    }

    pub fn online_ids(&self) -> Vec<Id> {
        let mut ids: Vec<Id> = self.online.lock().unwrap().values().cloned().collect();
        ids.sort();
        ids.dedup();
        ids
    }

    pub fn broadcast_presence(&self) {
        self.send(ServerMsg::Presence { online: self.online_ids() }, Audience::All);
    }

    pub fn packages_for(&self, world: &World) -> Value {
        self.registry().client_index(&world.system, &world.modules, world.theme.as_deref())
    }

    fn new_session(&self, user_id: &str) -> String {
        let token = format!("{}{}{}", new_id(), new_id(), new_id());
        self.sessions.lock().unwrap().insert(token.clone(), user_id.to_string());
        token
    }

    fn end_sessions_of(&self, user_id: &str) {
        self.sessions.lock().unwrap().retain(|_, id| id != user_id);
    }

    pub fn end_session(&self, token: &str) {
        self.sessions.lock().unwrap().remove(token);
    }

    /// The user a session token belongs to, if it's still valid.
    pub async fn session_user(&self, token: &str) -> Option<User> {
        let id = self.sessions.lock().unwrap().get(token).cloned()?;
        self.world.read().await.users.get(&id).cloned()
    }

    /// Check a join request: a session token, the GM key, or a player's password.
    pub async fn join(&self, req: hearth_core::protocol::JoinRequest) -> Result<Joined, String> {
        // 1. Rejoining with a session token (e.g. after a page reload).
        if let Some(token) = req.session.as_deref().filter(|t| !t.is_empty()) {
            if let Some(user) = self.session_user(token).await {
                let must_change_password = self.credentials.lock().unwrap().get(&user.id).must_change;
                return Ok(Joined { user, session: token.to_string(), must_change_password });
            }
            return Err("Your session has expired. Please log in again.".into());
        }

        // 2. The GM key (desktop app hand-off, or a GM on a standalone server).
        if let Some(key) = req.key.as_deref().filter(|k| !k.is_empty()) {
            if !self.check_gm_key(key) {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                return Err("Wrong GM key".into());
            }
            let name = req.name.as_deref().unwrap_or("").trim().to_string();
            if name.is_empty() || name.chars().count() > 40 {
                return Err("Name must be 1-40 characters".into());
            }
            let mut world = self.world.write().await;
            let user = match world.users.values().find(|u| u.name.eq_ignore_ascii_case(&name)).cloned() {
                Some(mut u) => {
                    u.role = Role::Gm;
                    u
                }
                None => User {
                    id: new_id(),
                    name,
                    role: Role::Gm,
                    color: USER_COLORS[world.users.len() % USER_COLORS.len()].to_string(),
                },
            };
            let op = Op::UserUpsert { user: user.clone() };
            world.apply(&op).map_err(|e| e.to_string())?;
            self.dirty.store(true, Ordering::Release);
            self.send(ServerMsg::Applied { op, by: None }, Audience::All);
            let session = self.new_session(&user.id);
            return Ok(Joined { user, session, must_change_password: false });
        }

        // 3. A player account set up by the GM.
        let id = req.user_id.as_deref().filter(|i| !i.is_empty()).ok_or("Choose your player name")?;
        let user = self.world.read().await.users.get(id).cloned().ok_or("That player no longer exists")?;
        let cred = self.credentials.lock().unwrap().get(id);
        if let Some(stored) = cred.hash.clone() {
            let password = req.password.clone().unwrap_or_default();
            let ok = tokio::task::spawn_blocking(move || credentials::verify(&stored, &password))
                .await
                .unwrap_or(false);
            if !ok {
                // Slow down guessing.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                return Err("Wrong password".into());
            }
        }
        let session = self.new_session(&user.id);
        // No password yet: they must pick one now.
        let must_change_password = cred.must_change || cred.hash.is_none();
        Ok(Joined { user, session, must_change_password })
    }

    /// A player changes their own password.
    pub async fn set_password(&self, user: &User, current: Option<String>, new: String) -> Result<(), String> {
        if new.chars().count() < credentials::MIN_LEN {
            return Err(format!("Password must be at least {} characters", credentials::MIN_LEN));
        }
        let cred = self.credentials.lock().unwrap().get(&user.id);
        // Right after logging in with a temporary password (or none), the old one isn't needed.
        if let (Some(stored), false) = (cred.hash.clone(), cred.must_change) {
            let cur = current.unwrap_or_default();
            let ok = tokio::task::spawn_blocking(move || credentials::verify(&stored, &cur)).await.unwrap_or(false);
            if !ok {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                return Err("Current password is wrong".into());
            }
        }
        let hashed = tokio::task::spawn_blocking(move || credentials::hash(&new)).await.map_err(|e| e.to_string())??;
        self.credentials.lock().unwrap().set(&user.id, Some(hashed), false)
    }

    /// GM account management. Replies with a notice for the GM.
    pub async fn admin(&self, gm: &User, action: UserAdmin) -> Result<String, String> {
        if gm.role != Role::Gm {
            return Err("Only a GM can manage players".into());
        }
        let clean_name = |n: &str| -> Result<String, String> {
            let n = n.trim();
            if n.is_empty() || n.chars().count() > 40 {
                Err("Name must be 1-40 characters".into())
            } else {
                Ok(n.to_string())
            }
        };
        let temp_hash = |p: String| async move {
            if p.chars().count() < credentials::MIN_TEMP_LEN {
                return Err(format!("Temporary password must be at least {} characters", credentials::MIN_TEMP_LEN));
            }
            tokio::task::spawn_blocking(move || credentials::hash(&p)).await.map_err(|e| e.to_string())?
        };

        match action {
            UserAdmin::Create { name, role, password } => {
                let name = clean_name(&name)?;
                let hash = if password.is_empty() { None } else { Some(temp_hash(password).await?) };
                let mut world = self.world.write().await;
                if world.users.values().any(|u| u.name.eq_ignore_ascii_case(&name)) {
                    return Err(format!("There is already a player called {name}"));
                }
                let user = User {
                    id: new_id(),
                    name: name.clone(),
                    role,
                    color: USER_COLORS[world.users.len() % USER_COLORS.len()].to_string(),
                };
                self.credentials.lock().unwrap().set(&user.id, hash, true)?;
                let op = Op::UserUpsert { user };
                world.apply(&op).map_err(|e| e.to_string())?;
                self.dirty.store(true, Ordering::Release);
                self.send(ServerMsg::Applied { op, by: Some(gm.id.clone()) }, Audience::All);
                Ok(format!("Added {name}"))
            }
            UserAdmin::Update { id, name, role, color } => {
                let mut world = self.world.write().await;
                let mut user = world.users.get(&id).cloned().ok_or("Player not found")?;
                if let Some(n) = name {
                    let n = clean_name(&n)?;
                    if world.users.values().any(|u| u.id != id && u.name.eq_ignore_ascii_case(&n)) {
                        return Err(format!("There is already a player called {n}"));
                    }
                    user.name = n;
                }
                if let Some(r) = role {
                    if id == gm.id && r != Role::Gm {
                        return Err("You can't remove your own GM role".into());
                    }
                    user.role = r;
                }
                if let Some(c) = color.filter(|c| c.starts_with('#') && c.len() <= 9) {
                    user.color = c;
                }
                let msg = format!("Updated {}", user.name);
                let op = Op::UserUpsert { user };
                world.apply(&op).map_err(|e| e.to_string())?;
                self.dirty.store(true, Ordering::Release);
                self.send(ServerMsg::Applied { op, by: Some(gm.id.clone()) }, Audience::All);
                Ok(msg)
            }
            UserAdmin::ResetPassword { id, password } => {
                let name = self.world.read().await.users.get(&id).map(|u| u.name.clone()).ok_or("Player not found")?;
                let hash = temp_hash(password).await?;
                self.credentials.lock().unwrap().set(&id, Some(hash), true)?;
                self.end_sessions_of(&id);
                Ok(format!("Password reset for {name}. They'll choose a new one when they next log in."))
            }
            UserAdmin::Delete { id } => {
                if id == gm.id {
                    return Err("You can't remove yourself".into());
                }
                let mut world = self.world.write().await;
                let name = world.users.get(&id).map(|u| u.name.clone()).ok_or("Player not found")?;
                let op = Op::UserDelete { id: id.clone() };
                world.apply(&op).map_err(|e| e.to_string())?;
                self.credentials.lock().unwrap().remove(&id)?;
                self.end_sessions_of(&id);
                self.dirty.store(true, Ordering::Release);
                self.send(ServerMsg::Applied { op, by: Some(gm.id.clone()) }, Audience::All);
                Ok(format!("Removed {name}"))
            }
        }
    }

    // ------------------------------------------------------------ permissions

    fn permitted(world: &World, user: &User, op: &Op) -> Result<(), String> {
        if op.is_server_only() {
            return Err("that operation is server-only".into());
        }
        if user.role == Role::Gm {
            return Ok(());
        }
        let deny = || Err("you don't have permission to do that".to_string());
        match op {
            Op::TokenUpdate { scene_id, id, patch } => {
                let scene = world.scenes.get(scene_id).ok_or("scene not found")?;
                let token = scene.tokens.get(id).ok_or("token not found")?;
                let owned = token.actor_id.as_deref().is_some_and(|a| world.owns_actor(user, a));
                let movement_only = patch
                    .as_object()
                    .is_some_and(|p| p.keys().all(|k| matches!(k.as_str(), "x" | "y" | "rotation" | "level")));
                if !(owned && movement_only && !token.hidden) {
                    return deny();
                }
                // Walls and closed doors stop players' tokens (checked here so
                // it can't be bypassed by a modified client).
                let mut moved = token.clone();
                if let Some(x) = patch.get("x").and_then(|v| v.as_f64()) {
                    moved.x = x;
                }
                if let Some(y) = patch.get("y").and_then(|v| v.as_f64()) {
                    moved.y = y;
                }
                let from = scene.token_center(token);
                let to_pos = scene.token_center(&moved);
                let to_level = patch.get("level").map(|l| l.as_str().unwrap_or_default().to_string()).filter(|l| *l != token.level);
                match to_level {
                    // On its level: walls there are in the way.
                    None => {
                        if scene.move_blocked_on(&token.level, from, to_pos) {
                            return Err("A wall is in the way".into());
                        }
                    }
                    // Another level: only by way of a link (stairs, a ladder…) where the token
                    // stands, arriving where the link leads (or staying put).
                    Some(to) => {
                        let link = scene.link_to(&token.level, from, &to).ok_or("There's no way to that level from here")?;
                        let arrive = link.at.unwrap_or(from);
                        let g = scene.grid.size as f64;
                        if !scene.has_level(&to) || (to_pos[0] - arrive[0]).hypot(to_pos[1] - arrive[1]) > g {
                            return Err("There's no way to that level from here".into());
                        }
                    }
                }
                Ok(())
            }
            // Anyone can draw; players may only change or delete their own drawings.
            Op::DrawingCreate { .. } => Ok(()),
            Op::DrawingUpdate { scene_id, id, .. } | Op::DrawingDelete { scene_id, id } => {
                let d = world.scenes.get(scene_id).and_then(|s| s.drawings.get(id)).ok_or("drawing not found")?;
                if d.author == user.id {
                    Ok(())
                } else {
                    Err("You can only change your own drawings".into())
                }
            }
            // Players can open and close unlocked doors.
            Op::WallUpdate { scene_id, id, patch } => {
                let wall = world.scenes.get(scene_id).and_then(|s| s.walls.get(id)).ok_or("wall not found")?;
                let open_only = patch.as_object().is_some_and(|p| p.keys().all(|k| k == "open"));
                if wall.kind != WallKind::Door || !open_only {
                    deny()
                } else if wall.locked {
                    Err("The door is locked".into())
                } else {
                    Ok(())
                }
            }
            Op::ActorUpdate { id, patch } => {
                // Players can't change who owns an actor.
                if world.owns_actor(user, id) && patch.get("owners").is_none() {
                    Ok(())
                } else {
                    deny()
                }
            }
            Op::ItemCreate { actor_id, .. } | Op::ItemUpdate { actor_id, .. } | Op::ItemDelete { actor_id, .. } => {
                if world.owns_actor(user, actor_id) {
                    Ok(())
                } else {
                    deny()
                }
            }
            // Players may type in initiative for their own combatants…
            Op::CombatantUpdate { id, patch } => {
                let owned = world
                    .combat
                    .as_ref()
                    .and_then(|c| c.combatant(id))
                    .and_then(|x| x.actor_id.as_deref())
                    .is_some_and(|a| world.owns_actor(user, a));
                let initiative_only = patch.as_object().is_some_and(|p| p.keys().all(|k| k == "initiative"));
                if owned && initiative_only {
                    Ok(())
                } else {
                    deny()
                }
            }
            // Owners of a journal entry may edit its text, but not who can see it.
            Op::JournalUpdate { id, patch } => {
                let entry = world.journal.get(id).ok_or("journal entry not found")?;
                let text_only = patch
                    .as_object()
                    .is_some_and(|p| p.keys().all(|k| matches!(k.as_str(), "name" | "folder" | "content" | "img")));
                if entry.access_for(user) == Access::Owner && text_only {
                    Ok(())
                } else {
                    deny()
                }
            }
            // Players make chat macros of their own and put macros on their hotbar.
            Op::MacroCreate { .. } => Ok(()),
            Op::MacroUpdate { id, patch } => {
                let m = world.macros.get(id).ok_or("macro not found")?;
                let simple = patch.as_object().is_some_and(|p| p.keys().all(|k| matches!(k.as_str(), "name" | "command" | "img")));
                if m.author == user.id && m.kind == MacroKind::Chat && simple {
                    Ok(())
                } else {
                    Err("You can only change your own chat macros".into())
                }
            }
            Op::MacroDelete { id } => {
                let m = world.macros.get(id).ok_or("macro not found")?;
                if m.author == user.id {
                    Ok(())
                } else {
                    Err("You can only delete your own macros".into())
                }
            }
            Op::HotbarSet { user_id, .. } => {
                if user_id == &user.id {
                    Ok(())
                } else {
                    deny()
                }
            }
            // …and end their own turn.
            Op::CombatNext => {
                let c = world.combat.as_ref().ok_or("There is no combat")?;
                let theirs = c
                    .current
                    .as_deref()
                    .and_then(|id| c.combatant(id))
                    .and_then(|x| x.actor_id.as_deref())
                    .is_some_and(|a| world.owns_actor(user, a));
                if theirs {
                    Ok(())
                } else {
                    Err("It isn't your turn".into())
                }
            }
            _ => deny(),
        }
    }

    /// Fill a combatant's name, image, actor and visibility from its token.
    fn fill_combatant(world: &World, scene_id: &str, x: &mut Combatant) {
        if x.id.is_empty() {
            x.id = new_id();
        }
        let Some(token) = x.token_id.as_deref().and_then(|t| world.scenes.get(scene_id)?.tokens.get(t)) else { return };
        if x.name.is_empty() {
            x.name = token.name.clone();
        }
        if x.actor_id.is_none() {
            x.actor_id = token.actor_id.clone();
        }
        if x.img.is_none() {
            x.img = token.img.clone().or_else(|| token.actor_id.as_deref().and_then(|a| world.actors.get(a)?.img.clone()));
        }
        x.hidden |= token.hidden;
    }

    // ------------------------------------------------------------ ops

    /// Fill in ids and system templates for create ops, and turn combat turn
    /// requests into concrete updates.
    fn normalize(&self, world: &World, user: &User, op: &mut Op) -> Result<(), String> {
        match op {
            Op::CombatCreate { combat } => {
                if combat.id.is_empty() {
                    combat.id = new_id();
                }
                if combat.scene_id.is_empty() {
                    combat.scene_id = world.active_scene.clone().ok_or("There is no scene to fight on")?;
                }
                world.scenes.get(&combat.scene_id).ok_or("Scene not found")?;
                combat.round = 0;
                combat.current = None;
                let scene_id = combat.scene_id.clone();
                for x in &mut combat.combatants {
                    Self::fill_combatant(world, &scene_id, x);
                }
                // One entry per token.
                let mut seen = HashSet::new();
                combat.combatants.retain(|x| x.token_id.as_ref().is_none_or(|t| seen.insert(t.clone())));
            }
            Op::CombatantAdd { combatant } => {
                let c = world.combat.as_ref().ok_or("Start a combat first")?;
                if let Some(t) = &combatant.token_id {
                    if c.combatants.iter().any(|x| x.token_id.as_ref() == Some(t)) {
                        return Err("That token is already in the combat".into());
                    }
                }
                Self::fill_combatant(world, &c.scene_id, combatant);
            }
            Op::CombatStart | Op::CombatNext | Op::CombatPrev => {
                let c = world.combat.as_ref().ok_or("There is no combat")?;
                let (round, current) = match op {
                    Op::CombatStart => c.start_turn(),
                    Op::CombatNext => c.next_turn(),
                    _ => c.prev_turn(),
                };
                *op = Op::CombatUpdate { patch: serde_json::json!({ "round": round, "current": current }) };
            }
            Op::SceneCreate { scene } => {
                if scene.id.is_empty() {
                    scene.id = new_id();
                }
                for t in scene.tokens.values_mut() {
                    if t.id.is_empty() {
                        t.id = new_id();
                    }
                }
            }
            Op::TokenCreate { token, .. } => {
                if token.id.is_empty() {
                    token.id = new_id();
                }
            }
            Op::SoundCreate { sound, .. } => {
                if sound.id.is_empty() {
                    sound.id = new_id();
                }
                sound.radius = sound.radius.max(0.0);
                sound.volume = sound.volume.clamp(0.0, 1.0);
            }
            Op::PlaylistCreate { playlist } => {
                if playlist.id.is_empty() {
                    playlist.id = new_id();
                }
                if playlist.name.trim().is_empty() {
                    playlist.name = "New playlist".into();
                }
                let now = now_ms();
                for x in playlist.sounds.values_mut() {
                    if x.playing {
                        x.started = now;
                    }
                }
            }
            // Tracks that start now are stamped with the server's clock, so
            // everyone (and anyone joining later) hears the same moment.
            Op::PlaylistUpdate { id, patch } => {
                let existing = world.playlists.get(id).ok_or("playlist not found")?;
                let now = now_ms();
                if let Some(sounds) = patch.get_mut("sounds").and_then(|v| v.as_object_mut()) {
                    for (sid, v) in sounds.iter_mut() {
                        let Some(o) = v.as_object_mut() else { continue };
                        if !existing.sounds.contains_key(sid) {
                            o.insert("id".into(), serde_json::json!(sid));
                        }
                        if o.get("playing").and_then(|p| p.as_bool()) == Some(true) {
                            o.insert("started".into(), serde_json::json!(now));
                        }
                    }
                }
            }
            Op::LightCreate { light, .. } => {
                if light.id.is_empty() {
                    light.id = new_id();
                }
                light.bright = light.bright.max(0.0);
                light.dim = light.dim.max(light.bright);
            }
            Op::DrawingCreate { drawing, .. } => {
                if drawing.id.is_empty() {
                    drawing.id = new_id();
                }
                drawing.author = user.id.clone();
                if drawing.points.len() > 5000 {
                    return Err("That drawing has too many points".into());
                }
                if drawing.text.chars().count() > 2000 {
                    return Err("That text is too long".into());
                }
            }
            Op::SketchUpdate { patch, walls, lights, .. } => {
                let count = |k: &str| patch.get(k).and_then(|c| c.as_object()).map_or(0, |c| c.len());
                if ["cells", "floor", "edges"].iter().any(|k| count(k) > 100_000) || ["shapes", "lines", "props"].iter().any(|k| count(k) > 5_000) {
                    return Err("That sketch is too big".into());
                }
                if walls.as_ref().is_some_and(|w| w.len() > 50_000) {
                    return Err("That sketch has too many walls".into());
                }
                if lights.as_ref().is_some_and(|l| l.len() > 5_000) {
                    return Err("That sketch has too many lights".into());
                }
            }
            Op::DrawingUpdate { patch, .. } => {
                if patch.get("points").and_then(|p| p.as_array()).is_some_and(|p| p.len() > 5000) {
                    return Err("That drawing has too many points".into());
                }
            }
            Op::WallCreate { wall, .. } => {
                if wall.id.is_empty() {
                    wall.id = new_id();
                }
                if wall.a == wall.b {
                    return Err("A wall needs two different ends".into());
                }
            }
            Op::JournalCreate { entry } => {
                if entry.id.is_empty() {
                    entry.id = new_id();
                }
                if entry.name.trim().is_empty() {
                    entry.name = "New entry".into();
                }
                if entry.content.len() > MAX_JOURNAL_TEXT {
                    return Err("That entry is too long".into());
                }
            }
            Op::JournalUpdate { patch, .. } => {
                if patch.get("content").and_then(|c| c.as_str()).is_some_and(|c| c.len() > MAX_JOURNAL_TEXT) {
                    return Err("That entry is too long".into());
                }
            }
            Op::ActorCreate { actor } => {
                if actor.id.is_empty() {
                    actor.id = new_id();
                }
                let mut data = self.registry().actor_template(&world.system, &actor.kind);
                merge_patch(&mut data, &actor.data);
                actor.data = data;
                actor.derived = Value::Null;
                for item in &mut actor.items {
                    if item.id.is_empty() {
                        item.id = new_id();
                    }
                }
                if user.role != Role::Gm && !actor.owners.contains(&user.id) {
                    actor.owners.push(user.id.clone());
                }
            }
            Op::LibraryItemCreate { item } => {
                let item = &mut item.item;
                if item.id.is_empty() {
                    item.id = new_id();
                }
                if item.name.trim().is_empty() {
                    item.name = "New item".into();
                }
                let mut data = self.registry().item_template(&world.system, &item.kind);
                merge_patch(&mut data, &item.data);
                item.data = data;
            }
            Op::CollectionCreate { collection } => {
                if collection.id.is_empty() {
                    collection.id = new_id();
                }
                if collection.name.trim().is_empty() {
                    collection.name = "New collection".into();
                }
                if !matches!(collection.kind.as_str(), "actor" | "item" | "journal" | "table" | "macro") {
                    return Err("Collections hold actors, items, journal entries, tables or macros".into());
                }
            }
            Op::TableCreate { table } => {
                if table.id.is_empty() {
                    table.id = new_id();
                }
                if table.name.trim().is_empty() {
                    table.name = "New table".into();
                }
                if table.results.len() > MAX_TABLE_RESULTS {
                    return Err("That table has too many results".into());
                }
            }
            Op::TableUpdate { patch, .. } => {
                if patch.get("results").and_then(|r| r.as_array()).is_some_and(|r| r.len() > MAX_TABLE_RESULTS) {
                    return Err("That table has too many results".into());
                }
            }
            Op::MacroCreate { r#macro } => {
                if r#macro.id.is_empty() {
                    r#macro.id = new_id();
                }
                if r#macro.name.trim().is_empty() {
                    r#macro.name = "New macro".into();
                }
                r#macro.author = user.id.clone();
                if user.role != Role::Gm {
                    // Only the GM writes script macros or shares macros.
                    r#macro.kind = MacroKind::Chat;
                    r#macro.shared = false;
                }
                if r#macro.command.len() > MAX_MACRO_TEXT {
                    return Err("That macro is too long".into());
                }
            }
            Op::MacroUpdate { patch, .. } => {
                if patch.get("command").and_then(|c| c.as_str()).is_some_and(|c| c.len() > MAX_MACRO_TEXT) {
                    return Err("That macro is too long".into());
                }
            }
            Op::HotbarSet { user_id, slot, macro_id } => {
                if !(1..=10).contains(slot) {
                    return Err("Hotbar slots are 1 to 10".into());
                }
                let owner = world.users.get(user_id).ok_or("user not found")?;
                if let Some(m) = macro_id {
                    let m = world.macros.get(m).ok_or("macro not found")?;
                    if !m.visible_to(owner) {
                        return Err("That macro isn't available to them".into());
                    }
                }
            }
            Op::ItemCreate { item, .. } => {
                if item.id.is_empty() {
                    item.id = new_id();
                }
                let mut data = self.registry().item_template(&world.system, &item.kind);
                merge_patch(&mut data, &item.data);
                item.data = data;
            }
            _ => {}
        }
        Ok(())
    }

    fn combatant_hidden(world: &World, id: &str) -> Option<bool> {
        world.combat.as_ref()?.combatant(id).map(|x| x.hidden)
    }

    fn token_hidden(world: &World, scene_id: &str, id: &str) -> Option<bool> {
        world.scenes.get(scene_id).and_then(|s| s.tokens.get(id)).map(|t| t.hidden)
    }

    /// Work out what each audience should see for an op that was just applied.
    fn fan_out(world: &World, op: Op, by: &Id, hidden_before: Option<bool>) -> Vec<Event> {
        let applied = |op: Op| ServerMsg::Applied { op, by: Some(by.clone()) };
        let all = |op: Op| vec![Event { msg: applied(op), audience: Audience::All }];
        let split = |gm: Op, players: Option<Op>| {
            let mut v = vec![Event { msg: applied(gm), audience: Audience::GmOnly }];
            if let Some(p) = players {
                v.push(Event { msg: applied(p), audience: Audience::PlayersOnly });
            }
            v
        };
        match &op {
            Op::HotbarSet { user_id, .. } => {
                let to = HashSet::from([user_id.clone()]);
                vec![Event { msg: applied(op), audience: Audience::Users(to) }]
            }
            Op::TokenCreate { token, .. } if token.hidden => split(op, None),
            Op::TokenDelete { .. } if hidden_before == Some(true) => split(op, None),
            Op::TokenUpdate { scene_id, id, .. } => {
                let now = Self::token_hidden(world, scene_id, id).unwrap_or(false);
                match (hidden_before.unwrap_or(false), now) {
                    (false, false) => all(op),
                    (true, true) => split(op, None),
                    (false, true) => {
                        let del = Op::TokenDelete { scene_id: scene_id.clone(), id: id.clone() };
                        split(op, Some(del))
                    }
                    (true, false) => {
                        let token = world.scenes[scene_id].tokens[id].clone();
                        let create = Op::TokenCreate { scene_id: scene_id.clone(), token };
                        split(op, Some(create))
                    }
                }
            }
            Op::SceneCreate { scene } if scene.tokens.values().any(|t| t.hidden) => {
                let mut public = scene.clone();
                public.tokens.retain(|_, t| !t.hidden);
                split(op, Some(Op::SceneCreate { scene: public }))
            }
            // Hidden combatants follow the same rules as hidden tokens.
            Op::CombatCreate { combat } if combat.combatants.iter().any(|x| x.hidden) => {
                let mut public = combat.clone();
                public.combatants.retain(|x| !x.hidden);
                split(op, Some(Op::CombatCreate { combat: public }))
            }
            Op::CombatantAdd { combatant } if combatant.hidden => split(op, None),
            Op::CombatantRemove { .. } if hidden_before == Some(true) => split(op, None),
            Op::CombatantUpdate { id, .. } => {
                let now = Self::combatant_hidden(world, id).unwrap_or(false);
                match (hidden_before.unwrap_or(false), now) {
                    (false, false) => all(op),
                    (true, true) => split(op, None),
                    (false, true) => {
                        let rm = Op::CombatantRemove { id: id.clone() };
                        split(op, Some(rm))
                    }
                    (true, false) => {
                        let combatant = world.combat.as_ref().and_then(|c| c.combatant(id)).cloned();
                        split(op, combatant.map(|combatant| Op::CombatantAdd { combatant }))
                    }
                }
            }
            _ => all(op),
        }
    }

    /// What every player could see of a per-player document before an op.
    fn scoped_before(world: &World, op: &Op) -> Option<ScopedBefore> {
        let (kind, id) = op.scoped()?;
        let views = world
            .users
            .values()
            .filter(|u| u.role != Role::Gm)
            .map(|u| (u.id.clone(), world.scoped_view(kind, id, u)))
            .collect();
        Some(ScopedBefore { kind, id: id.to_string(), full: world.scoped_full(kind, id), views })
    }

    /// Changes to per-player documents (journal, library items, tables,
    /// macros) go to each player as they may see them: the op itself if they
    /// saw the whole document before and after, otherwise a fresh copy of
    /// their view (create ops replace) or a delete.
    fn scoped_events(world: &World, op: Op, by: &Id, before: ScopedBefore) -> Vec<Event> {
        let ScopedBefore { kind, id, full, views } = before;
        let full_now = world.scoped_full(kind, &id);
        let applied = |op: Op| ServerMsg::Applied { op, by: Some(by.clone()) };
        let mut events = vec![Event { msg: applied(op.clone()), audience: Audience::GmOnly }];
        for user in world.users.values().filter(|u| u.role != Role::Gm) {
            let was = views.get(&user.id).cloned().flatten();
            let now = world.scoped_view(kind, &id, user);
            let msg = if op.is_scoped_update() && was.is_some() && was == full && now.is_some() && now == full_now {
                op.clone()
            } else if let Some(view) = now {
                if Some(&view) == was.as_ref() {
                    continue; // their view didn't change
                }
                match kind.create_op(view) {
                    Some(op) => op,
                    None => continue,
                }
            } else if was.is_some() {
                kind.delete_op(&id)
            } else {
                continue;
            };
            events.push(Event { msg: applied(msg), audience: Audience::Exactly(HashSet::from([user.id.clone()])) });
        }
        events
    }

    /// Validate, apply and broadcast an op from a user.
    pub async fn submit(&self, user: &User, mut op: Op) -> Result<(), String> {
        let mut world = self.world.write().await;
        Self::permitted(&world, user, &op)?;
        self.normalize(&world, user, &mut op)?;
        self.commit(&mut world, &user.id, op, 0)?;
        self.dirty.store(true, Ordering::Release);
        Ok(())
    }

    /// Apply an already-permitted op, broadcast it, and run its follow-ups
    /// (derived data, combat bookkeeping). `depth` stops runaway chains.
    fn commit(&self, world: &mut World, by: &Id, op: Op, depth: u8) -> Result<(), String> {
        let hidden_before = match &op {
            Op::TokenUpdate { scene_id, id, .. } | Op::TokenDelete { scene_id, id } => {
                Self::token_hidden(world, scene_id, id)
            }
            Op::CombatantUpdate { id, .. } | Op::CombatantRemove { id } => Self::combatant_hidden(world, id),
            _ => None,
        };
        let modules_changed = matches!(&op, Op::WorldUpdate { patch } if patch.get("modules").is_some());
        // If this removes whoever's turn it is, work out who's next beforehand.
        let next_if_current_removed = world.combat.as_ref().and_then(|c| {
            let cur = c.current.as_deref()?;
            let removes_current = match &op {
                Op::CombatantRemove { id } => id == cur,
                Op::TokenDelete { scene_id, id } => {
                    scene_id == &c.scene_id && c.combatant(cur).is_some_and(|x| x.token_id.as_deref() == Some(id))
                }
                _ => false,
            };
            removes_current.then(|| c.next_turn())
        });
        // Hiding or revealing a token hides or reveals its combatant too.
        let hide_sync = match &op {
            Op::TokenUpdate { scene_id, id, patch } => patch.get("hidden").and_then(|h| h.as_bool()).and_then(|h| {
                let c = world.combat.as_ref().filter(|c| &c.scene_id == scene_id)?;
                let x = c.combatants.iter().find(|x| x.token_id.as_deref() == Some(id))?;
                (x.hidden != h).then(|| Op::CombatantUpdate { id: x.id.clone(), patch: serde_json::json!({ "hidden": h }) })
            }),
            _ => None,
        };

        let scoped_before = Self::scoped_before(world, &op);

        world.apply(&op).map_err(|e| e.to_string())?;
        let affected = op.affected_actor().map(str::to_string);

        let events = match scoped_before {
            Some(before) => Self::scoped_events(world, op, by, before),
            None => Self::fan_out(world, op, by, hidden_before),
        };
        for ev in events {
            let _ = self.tx.send(Arc::new(ev));
        }

        if depth < 3 {
            if let (Some((round, next)), Some(c)) = (next_if_current_removed, world.combat.as_ref()) {
                let next = next.filter(|n| c.combatant(n).is_some());
                let fix = Op::CombatUpdate { patch: serde_json::json!({ "round": round, "current": next }) };
                self.commit(world, by, fix, depth + 1)?;
            }
            if let Some(sync) = hide_sync {
                self.commit(world, by, sync, depth + 1)?;
            }
        }

        if modules_changed {
            let (host, errors) = ScriptHost::load(&self.registry(), &world.system, &world.modules);
            for e in errors {
                tracing::warn!("script error: {e}");
            }
            *self.scripts.write().unwrap() = host;
            let ids: Vec<Id> = world.actors.keys().cloned().collect();
            for id in ids {
                self.derive(world, &id);
            }
        } else if let Some(id) = affected {
            self.derive(world, &id);
        }
        Ok(())
    }

    /// Re-run `prepare_actor` and broadcast the result if it changed.
    fn derive(&self, world: &mut World, actor_id: &str) {
        let Some(actor) = world.actors.get(actor_id) else { return };
        let Some(derived) = compute_derived(&self.rules(), &self.scripts.read().unwrap(), actor) else { return };
        if derived == actor.derived {
            return;
        }
        let op = Op::ActorDerive { id: actor_id.to_string(), derived };
        if world.apply(&op).is_ok() {
            self.send(ServerMsg::Applied { op, by: None }, Audience::All);
        }
    }

    // ------------------------------------------------------------ chat & rolls

    async fn post_chat(&self, message: ChatMessage) {
        let audience = if message.whisper.is_empty() {
            Audience::All
        } else {
            let mut ids: HashSet<Id> = message.whisper.iter().cloned().collect();
            ids.insert(message.author.clone());
            Audience::Users(ids)
        };
        let op = Op::ChatCreate { message };
        let mut world = self.world.write().await;
        if world.apply(&op).is_ok() {
            self.dirty.store(true, Ordering::Release);
            self.send(ServerMsg::Applied { op, by: None }, audience);
        }
    }

    /// Use an actor's action (an item's attack, a feature's use…): spend its
    /// cost, roll it on the server, and post the result with follow-up buttons.
    pub async fn use_action(
        &self,
        user: &User,
        actor_id: &str,
        item_id: Option<Id>,
        action: &str,
        options: hearth_core::rules::ActionOptions,
        gm_only: bool,
    ) -> Result<(), String> {
        let (plan, actor, item_name, gm_ids) = {
            let mut world = self.world.write().await;
            let actor = world.actors.get(actor_id).ok_or("actor not found")?.clone();
            if !world.owns_actor(user, actor_id) {
                return Err("you can only act for actors you own".into());
            }
            let plan = hearth_core::rules::plan_action(&actor, &self.rules(), item_id.as_deref(), action, &options)?;
            if let Some((target, patch)) = &plan.spend {
                let op = match target {
                    Some(iid) => Op::ItemUpdate { actor_id: actor_id.to_string(), id: iid.clone(), patch: patch.clone() },
                    None => Op::ActorUpdate { id: actor_id.to_string(), patch: patch.clone() },
                };
                self.commit(&mut world, &user.id, op, 0)?;
                self.dirty.store(true, Ordering::Release);
            }
            let item_name = item_id.as_deref().and_then(|i| actor.items.iter().find(|x| x.id == i)).map(|i| i.name.clone());
            let gms: Vec<Id> = world.users.values().filter(|u| u.role == Role::Gm).map(|u| u.id.clone()).collect();
            (plan, actor, item_name, gms)
        };
        // An action with no dice (e.g. Action Surge) is just announced.
        let result = if plan.formula.trim().is_empty() {
            None
        } else {
            Some(hearth_dice::roll_with(&plan.formula, &|_| None, &mut rand_rng()).map_err(|e| format!("{}: {e}", plan.formula))?)
        };
        // A natural roll in the threat range (20, or 19–20…) threatens a critical. Systems that
        // confirm get a "Confirm critical" roll whose follow-ups are critical; others crit outright.
        let threatens = plan.kind == "attack" && !options.confirming && result.as_ref().is_some_and(|r| (plan.threat..=20).any(|n| r.has_natural(20, n)));
        let threat = threatens && plan.confirm;
        let crit = (threatens && !plan.confirm) || (plan.kind == "attack" && options.confirming);
        let fumble = plan.kind == "attack" && result.as_ref().is_some_and(|r| r.has_natural(20, 1));
        let mut flags = match &result {
            Some(r) => self.scripts.read().unwrap().on_roll(r, Some(&actor)),
            None => Value::Object(Default::default()),
        };
        let then: Vec<Value> = plan.then.iter().map(|(id, label)| serde_json::json!({ "id": id, "label": label })).collect();
        merge_patch(&mut flags, &serde_json::json!({ "core": { "action": {
            "actor_id": actor_id, "item_id": item_id, "kind": plan.kind, "then": then, "action": action,
            "crit": crit || options.crit, "threat": threat, "level": options.level,
        } } }));
        if (crit && !options.confirming) || fumble {
            merge_patch(&mut flags, &serde_json::json!({ "crit": crit, "fumble": fumble }));
        }
        let mut msg = Self::message(user, Some(actor_id.to_string()));
        let mut flavor = match item_name {
            Some(n) if n != plan.label => format!("{n}: {}", plan.label),
            _ => plan.label.clone(),
        };
        if let Some(m) = &plan.mode {
            flavor.push_str(&format!(" ({m})"));
        }
        if options.crit && plan.kind == "damage" {
            flavor.push_str(" (critical)");
        }
        if options.confirming {
            flavor.push_str(" (confirming a critical)");
        } else if threat {
            flavor.push_str(" (critical threat)");
        }
        if result.is_none() {
            msg.content = format!("{} uses {flavor}.", actor.name);
        }
        msg.flavor = Some(flavor);
        msg.roll = result;
        msg.flags = flags;
        if gm_only {
            msg.whisper = gm_ids;
        }
        self.post_chat(msg).await;
        Ok(())
    }

    /// Level up (or add a class, ancestry, background) with the player's picks.
    pub async fn advance(&self, user: &User, actor_id: &str, req: hearth_core::advance::AdvanceRequest) -> Result<(), String> {
        let (adv, name) = {
            let mut world = self.world.write().await;
            let actor = world.actors.get(actor_id).ok_or("actor not found")?.clone();
            if !world.owns_actor(user, actor_id) {
                return Err("you can only level up characters you own".into());
            }
            // Players can't add or pick anything from a book the GM has switched off.
            if user.role != Role::Gm {
                hearth_core::books::check_advance(&req, &hearth_core::books::off(&world.settings))?;
            }
            let mut rng = rand_rng();
            let adv = hearth_core::advance::advance(&actor, &self.rules(), &req, &mut |f: &str| {
                hearth_dice::roll_with(f, &|_| None, &mut rng).map(|r| r.total).map_err(|e| format!("{f}: {e}"))
            })?;
            let before = self.resource_maxes(&world, actor_id);
            for op in &adv.ops {
                let mut op = op.clone();
                self.normalize(&world, user, &mut op)?;
                self.commit(&mut world, &user.id, op, 0)?;
            }
            self.follow_maxes(&mut world, &user.id, actor_id, &before)?;
            self.dirty.store(true, Ordering::Release);
            (adv, actor.name)
        };
        let mut msg = Self::message(user, Some(actor_id.to_string()));
        msg.content = if req.item_id.is_some() || adv.level > 1 {
            format!("{name} reaches level {} in {}.", adv.level, adv.item_name)
        } else {
            format!("{name} gains {}.", adv.item_name)
        };
        if !adv.gained.is_empty() {
            msg.content.push_str(&format!(" Gains: {}.", adv.gained.join(", ")));
        }
        self.post_chat(msg).await;
        Ok(())
    }

    // ------------------------------------------------------------------ item forge

    /// Who besides the GM may use the forge in this world: `off`, `craft` (by the
    /// crafting rules: feat, check, money) or `free` (make anything).
    fn forge_players(world: &World) -> String {
        world.settings.pointer("/core/forge/players").and_then(Value::as_str).unwrap_or("off").to_string()
    }

    /// The forge's request: the item, the actor making or receiving it (if any), and
    /// candidate parts to check. Checks the user may use the forge for that actor.
    fn forge_request(world: &World, user: &User, body: &Value) -> Result<(Option<hearth_core::Actor>, hearth_core::Item, Vec<hearth_core::Item>), String> {
        let gm = user.role == hearth_core::Role::Gm;
        if !gm && Self::forge_players(world) == "off" {
            return Err("Only the GM can use the forge in this world".into());
        }
        let actor = match body.get("actor_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(id) => {
                if !world.owns_actor(user, id) {
                    return Err("You can only forge for characters you own".into());
                }
                Some(world.actors.get(id).ok_or("actor not found")?.clone())
            }
            None if gm => None,
            None => return Err("Pick the character who makes it".into()),
        };
        let mut item: hearth_core::Item = serde_json::from_value(body.get("item").cloned().unwrap_or_default()).map_err(|e| format!("item: {e}"))?;
        if item.name.trim().is_empty() {
            item.name = "New item".into();
        }
        let candidates: Vec<hearth_core::Item> = body.get("candidates").cloned().map(serde_json::from_value).transpose().map_err(|e| format!("candidates: {e}"))?.unwrap_or_default();
        Ok((actor, item, candidates))
    }

    fn stand_in() -> hearth_core::Actor {
        serde_json::from_value(serde_json::json!({ "id": "", "name": "The forge", "kind": "", "data": {} })).expect("a stand-in actor")
    }

    /// Price, rule problems, fitting parts and crafting numbers for an item at the forge.
    pub async fn forge_preview(&self, user: &User, body: &Value) -> Result<Value, String> {
        let world = self.world.read().await;
        let (actor, item, candidates) = Self::forge_request(&world, user, body)?;
        let p = hearth_core::forge::preview(&actor.unwrap_or_else(Self::stand_in), &self.rules(), &item, &candidates)?;
        let mut out = serde_json::to_value(&p).map_err(|e| e.to_string())?;
        out["players"] = Value::from(Self::forge_players(&world));
        Ok(out)
    }

    /// Make an item: `create` (the GM, or anyone where the world allows it freely) puts it on
    /// the actor or, without one, in the Items directory; `craft` makes it as the actor by the
    /// crafting rules, spending their money and rolling the check.
    pub async fn forge_make(&self, user: &User, body: &Value) -> Result<Value, String> {
        let gm = user.role == hearth_core::Role::Gm;
        let craft = body.get("mode").and_then(Value::as_str) == Some("craft");
        let (msg, result) = {
            let mut world = self.world.write().await;
            let (actor, mut item, _) = Self::forge_request(&world, user, body)?;
            if !craft && !gm && Self::forge_players(&world) != "free" {
                return Err("In this world, players make items by crafting them".into());
            }
            let rules = self.rules();
            item.id = hearth_core::new_id();
            let speaker = actor.as_ref().map(|a| a.id.clone());
            let mut msg = Self::message(user, speaker);
            let mut result = serde_json::json!({ "made": false });
            match (&actor, craft) {
                (Some(a), true) => {
                    let mut rng = rand_rng();
                    let (done, left) = hearth_core::forge::craft(a, &rules, &item, &mut |f: &str| {
                        hearth_dice::roll_with(f, &|_| None, &mut rng).map(|r| r.total).map_err(|e| format!("{f}: {e}"))
                    })?;
                    let mut ops = vec![hearth_core::ops::Op::ActorUpdate { id: a.id.clone(), patch: serde_json::json!({ "data": hearth_core::forge::money_patch(&done.currency, left) }) }];
                    if done.success {
                        ops.push(hearth_core::ops::Op::ItemCreate { actor_id: a.id.clone(), item: item.clone() });
                    }
                    for mut op in ops {
                        self.normalize(&world, user, &mut op)?;
                        self.commit(&mut world, &user.id, op, 0)?;
                    }
                    msg.content = format!(
                        "{} crafts {} ({} {} over {} day{}): check {} vs DC {} — {}.",
                        a.name, item.name, done.cost, done.currency.rsplit('.').next().unwrap_or_default(), done.days, if done.days == 1.0 { "" } else { "s" }, done.total, done.dc,
                        if done.success { "success" } else { "failed; the materials are spent" }
                    );
                    result = serde_json::json!({ "made": done.success, "result": done });
                }
                (None, true) => return Err("Pick the character who crafts it".into()),
                (Some(a), false) => {
                    let mut op = hearth_core::ops::Op::ItemCreate { actor_id: a.id.clone(), item: item.clone() };
                    self.normalize(&world, user, &mut op)?;
                    self.commit(&mut world, &user.id, op, 0)?;
                    msg.content = format!("{} forges {} for {}.", user.name, item.name, a.name);
                    result["made"] = Value::Bool(true);
                }
                (None, false) => {
                    let mut doc = serde_json::to_value(&item).map_err(|e| e.to_string())?;
                    doc["folder"] = Value::from("Forged");
                    let lib: hearth_core::LibraryItem = serde_json::from_value(doc).map_err(|e| e.to_string())?;
                    self.commit(&mut world, &user.id, hearth_core::ops::Op::LibraryItemCreate { item: lib }, 0)?;
                    msg.content = format!("{} forges {} (in the Items directory, folder Forged).", user.name, item.name);
                    result["made"] = Value::Bool(true);
                }
            }
            self.dirty.store(true, Ordering::Release);
            (msg, result)
        };
        self.post_chat(msg).await;
        Ok(result)
    }

    // ------------------------------------------------------------------ character creation

    /// A creation step of the world's system, the world's choices for it, and the
    /// actor's entries to fill (in the system's order: Strength, Dexterity…).
    fn creation_context(
        &self,
        world: &World,
        actor: &Actor,
        step_id: &str,
        method_id: &str,
    ) -> Result<(hearth_core::creation::CreationStep, hearth_core::creation::ScoreMethod, bool, Vec<String>, BTreeMap<String, String>), String> {
        use hearth_core::creation::world_choice;
        let reg = self.registry();
        let bp = reg.get(&world.system).and_then(|p| p.blueprint.as_ref()).ok_or("This system has no character creation")?;
        let step = bp.creation.iter().find(|s| s.id == step_id).cloned().ok_or_else(|| format!("No creation step \"{step_id}\""))?;
        if !step.applies_to(&actor.kind) {
            return Err(format!("{} doesn't go through {}", actor.name, if step.label.is_empty() { &step.id } else { &step.label }));
        }
        let choice = world_choice(&step, world.settings.pointer(&format!("/core/creation/{step_id}")).unwrap_or(&Value::Null));
        let method = choice.methods.iter().find(|m| m.id == method_id).cloned().ok_or("The GM doesn't allow that method in this world")?;
        // The list's entries, ordered as the system builder lists them.
        let ptr = format!("/{}", step.path.replace('.', "/"));
        let mut keys: Vec<String> = actor.data.pointer(&ptr).and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default();
        fn node_at<'a>(nodes: &'a [hearth_packages::builder::Node], segs: &[&str]) -> Option<&'a hearth_packages::builder::Node> {
            use hearth_packages::builder::NodeKind;
            for n in nodes {
                if n.kind == NodeKind::Group && n.flat {
                    if let Some(x) = node_at(&n.children, segs) {
                        return Some(x);
                    }
                    continue;
                }
                if n.key == segs[0] {
                    return if segs.len() == 1 { Some(n) } else if n.kind == NodeKind::Group { node_at(&n.children, &segs[1..]) } else { None };
                }
            }
            None
        }
        let segs: Vec<&str> = step.path.split('.').collect();
        let list = bp.actor_types.iter().find(|t| t.key == actor.kind).and_then(|t| node_at(&t.children, &segs));
        let order: Vec<String> = list.map(|n| n.entries.iter().map(|e| e.key.clone()).collect()).unwrap_or_default();
        // Their names (Strength, Dexterity…) for chat.
        let names: BTreeMap<String, String> = list
            .map(|n| n.entries.iter().map(|e| (e.key.clone(), if e.label.is_empty() { e.key.clone() } else { e.label.clone() })).collect())
            .unwrap_or_default();
        keys.sort_by_key(|k| (order.iter().position(|o| o == k).unwrap_or(usize::MAX), k.clone()));
        Ok((step, method, choice.lock, keys, names))
    }

    /// Roll for a creation step's roll method (once; the results are kept on the actor and posted to chat).
    pub async fn creation_roll(&self, user: &User, actor_id: &str, step_id: &str, method_id: &str) -> Result<(), String> {
        let (name, rolls, method) = {
            let mut world = self.world.write().await;
            let actor = world.actors.get(actor_id).ok_or("actor not found")?.clone();
            if !world.owns_actor(user, actor_id) {
                return Err("you can only set up characters you own".into());
            }
            let (_, method, _, entries, _) = self.creation_context(&world, &actor, step_id, method_id)?;
            let done = actor.flags.pointer(&format!("/core/creation/{step_id}")).cloned().unwrap_or(Value::Null);
            if done.get("rolls").is_some() || done.get("done").and_then(Value::as_bool) == Some(true) {
                return Err("These have been rolled already. The GM can let you start again.".into());
            }
            let mut rng = rand_rng();
            let rolls = hearth_core::creation::roll_scores(&method, entries.len(), &mut |f: &str| {
                hearth_dice::roll_with(f, &|_| None, &mut rng).map(|r| r.total).map_err(|e| format!("{f}: {e}"))
            })?;
            let patch = serde_json::json!({ "flags": { "core": { "creation": { step_id: { "method": method_id, "rolls": rolls } } } } });
            self.commit(&mut world, &user.id, Op::ActorUpdate { id: actor_id.to_string(), patch }, 0)?;
            self.dirty.store(true, Ordering::Release);
            (actor.name, rolls, method)
        };
        let mut msg = Self::message(user, Some(actor_id.to_string()));
        let list: Vec<String> = rolls.iter().map(i64::to_string).collect();
        msg.content = format!("{name} rolls for ability scores ({}, {}): {}.", method.label, method.formula, list.join(", "));
        self.post_chat(msg).await;
        Ok(())
    }

    /// Set a creation step's scores with the chosen method (checked here), then lock them.
    pub async fn creation_apply(&self, user: &User, actor_id: &str, step_id: &str, method_id: &str, assign: &hearth_core::creation::Assign) -> Result<(), String> {
        let (name, scores, label) = {
            let mut world = self.world.write().await;
            let actor = world.actors.get(actor_id).ok_or("actor not found")?.clone();
            if !world.owns_actor(user, actor_id) {
                return Err("you can only set up characters you own".into());
            }
            let (step, method, lock, entries, names) = self.creation_context(&world, &actor, step_id, method_id)?;
            let done = actor.flags.pointer(&format!("/core/creation/{step_id}")).cloned().unwrap_or(Value::Null);
            if lock && done.get("done").and_then(Value::as_bool) == Some(true) && user.role != Role::Gm {
                return Err("These are set. The GM can let you set them again.".into());
            }
            // Rolls must be the ones rolled for this method.
            let rolls: Vec<i64> = if done.get("method").and_then(Value::as_str) == Some(method_id) {
                done.get("rolls").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default()
            } else {
                vec![]
            };
            let scores = hearth_core::creation::scores(&method, &entries, assign, &rolls)?;
            let mut patch = serde_json::json!({ "data": hearth_core::creation::scores_patch(&step, &scores) });
            patch["flags"] = serde_json::json!({ "core": { "creation": { step_id: { "method": method_id, "done": true } } } });
            let before = self.resource_maxes(&world, actor_id);
            self.commit(&mut world, &user.id, Op::ActorUpdate { id: actor_id.to_string(), patch }, 0)?;
            self.follow_maxes(&mut world, &user.id, actor_id, &before)?;
            self.dirty.store(true, Ordering::Release);
            // In the system's order, by name: Strength 15, Dexterity 14…
            let shown: Vec<String> = entries.iter().filter_map(|k| scores.get(k).map(|v| format!("{} {v}", names.get(k).unwrap_or(k)))).collect();
            (actor.name, shown, if method.label.is_empty() { method.id.clone() } else { method.label.clone() })
        };
        let mut msg = Self::message(user, Some(actor_id.to_string()));
        let list = scores;
        msg.content = format!("{name} sets ability scores ({label}): {}.", list.join(", "));
        self.post_chat(msg).await;
        Ok(())
    }

    /// Current and max of each of an actor's calculated-max resources (hit points…).
    /// The actor's resources with a calculated max (its own, and its items': a class's spell
    /// slots, a feature's uses): (item id or None, path, value, max).
    fn resource_maxes(&self, world: &World, actor_id: &str) -> Vec<(Option<Id>, String, f64, f64)> {
        let Some(actor) = world.actors.get(actor_id) else { return vec![] };
        let rules = self.rules();
        let at = |v: &Value, path: &str| path.split('.').fold(v, |v, k| &v[k]).as_f64();
        let mut out = vec![];
        if let Some(tr) = rules.actor_types.get(&actor.kind) {
            for (path, _) in tr.resources.iter().filter(|(_, r)| r.max.is_some()) {
                out.push((None, path.clone(), at(&actor.data, &format!("{path}.value")).unwrap_or(0.0), at(&actor.derived, &format!("{path}.max")).unwrap_or(0.0)));
            }
        }
        for item in &actor.items {
            let Some(tr) = rules.item_types.get(&item.kind) else { continue };
            for path in tr.resources.keys() {
                let derived = &actor.derived["items"][&item.id];
                if let Some(max) = at(derived, &format!("{path}.max")) {
                    out.push((Some(item.id.clone()), path.clone(), at(&item.data, &format!("{path}.value")).unwrap_or(0.0), max));
                }
            }
        }
        out
    }

    /// After a level up or down, a resource whose max changed moves its current value by
    /// the same amount (never below 0 or above the new max). An item that's new (a class just
    /// added) counts as having had a max of 0, so its slots start full.
    fn follow_maxes(&self, world: &mut World, by: &Id, actor_id: &str, before: &[(Option<Id>, String, f64, f64)]) -> Result<(), String> {
        let after = self.resource_maxes(world, actor_id);
        let had_item = |id: &Id| before.iter().any(|(i, _, _, _)| i.as_ref() == Some(id));
        let mut patches: BTreeMap<Option<Id>, Value> = BTreeMap::new();
        for (item, path, value, max) in &after {
            let old_max = match before.iter().find(|(i, p, _, _)| i == item && p == path) {
                Some((_, _, _, m)) => *m,
                None if item.as_ref().is_some_and(|id| !had_item(id)) => 0.0,
                None => continue,
            };
            if (max - old_max).abs() < f64::EPSILON {
                continue;
            }
            let new = (value + (max - old_max)).clamp(0.0, max.max(0.0));
            let mut v = serde_json::json!({ "value": new });
            for k in path.rsplit('.') {
                v = serde_json::json!({ k: v });
            }
            // Merge, so two resources under one parent (slot levels) both land.
            merge_patch(patches.entry(item.clone()).or_insert_with(|| Value::Object(serde_json::Map::new())), &v);
        }
        for (item, patch) in patches {
            let op = match item {
                None => Op::ActorUpdate { id: actor_id.to_string(), patch: serde_json::json!({ "data": patch }) },
                Some(id) => Op::ItemUpdate { actor_id: actor_id.to_string(), id, patch: serde_json::json!({ "data": patch }) },
            };
            self.commit(world, by, op, 0)?;
        }
        Ok(())
    }

    /// Take back an item's last level, and what it gave.
    pub async fn regress(&self, user: &User, actor_id: &str, item_id: &str, all: bool) -> Result<(), String> {
        let mut world = self.world.write().await;
        if !world.actors.contains_key(actor_id) {
            return Err("actor not found".into());
        }
        if !world.owns_actor(user, actor_id) {
            return Err("you can only change characters you own".into());
        }
        let before = self.resource_maxes(&world, actor_id);
        // One level, or (all) level after level until the item is gone.
        for _ in 0..if all { 200 } else { 1 } {
            let actor = world.actors.get(actor_id).ok_or("actor not found")?.clone();
            if !actor.items.iter().any(|i| i.id == item_id) {
                break;
            }
            let adv = hearth_core::advance::regress(&actor, &self.rules(), item_id)?;
            for op in adv.ops {
                self.commit(&mut world, &user.id, op, 0)?;
            }
        }
        self.follow_maxes(&mut world, &user.id, actor_id, &before)?;
        self.dirty.store(true, Ordering::Release);
        Ok(())
    }

    /// Take a rest: resources with a reset for this kind of rest are restored.
    pub async fn rest(&self, user: &User, actor_id: &str, kind: &str) -> Result<(), String> {
        let name = {
            let mut world = self.world.write().await;
            let rules = self.rules();
            if !rules.rests.is_empty() && !rules.rests.iter().any(|r| r == kind) {
                return Err(format!("This system has no {kind} rest"));
            }
            let actor = world.actors.get(actor_id).ok_or("actor not found")?.clone();
            if !world.owns_actor(user, actor_id) {
                return Err("you can only rest actors you own".into());
            }
            let (patch, items) = hearth_core::rules::rest(&actor, &self.rules(), kind);
            if !patch.is_null() {
                self.commit(&mut world, &user.id, Op::ActorUpdate { id: actor_id.to_string(), patch }, 0)?;
            }
            for (iid, patch) in items {
                self.commit(&mut world, &user.id, Op::ItemUpdate { actor_id: actor_id.to_string(), id: iid, patch }, 0)?;
            }
            self.dirty.store(true, Ordering::Release);
            actor.name
        };
        let mut msg = Self::message(user, Some(actor_id.to_string()));
        msg.content = format!("{name} takes a {kind} rest.");
        self.post_chat(msg).await;
        Ok(())
    }

    fn message(user: &User, speaker_actor: Option<Id>) -> ChatMessage {
        ChatMessage {
            id: new_id(),
            author: user.id.clone(),
            author_name: user.name.clone(),
            content: String::new(),
            flavor: None,
            roll: None,
            whisper: vec![],
            ts: now_ms(),
            speaker_actor,
            flags: Value::Null,
        }
    }

    pub async fn roll(
        &self,
        user: &User,
        formula: &str,
        flavor: Option<String>,
        actor_id: Option<Id>,
        gm_only: bool,
    ) -> Result<(), String> {
        let (actor, gm_ids): (Option<Actor>, Vec<Id>) = {
            let world = self.world.read().await;
            let actor = match &actor_id {
                Some(id) => {
                    let a = world.actors.get(id).ok_or("actor not found")?;
                    if !world.owns_actor(user, id) {
                        return Err("you can only roll for actors you own".into());
                    }
                    Some(a.clone())
                }
                None => None,
            };
            let gms = world.users.values().filter(|u| u.role == Role::Gm).map(|u| u.id.clone()).collect();
            (actor, gms)
        };

        let resolve = |path: &str| -> Option<i64> {
            let a = actor.as_ref()?;
            lookup_int(&a.derived, path).or_else(|| lookup_int(&a.data, path))
        };
        let result = hearth_dice::roll_with(formula, &resolve, &mut rand_rng()).map_err(|e| e.to_string())?;
        let flags = self.scripts.read().unwrap().on_roll(&result, actor.as_ref());

        let mut msg = Self::message(user, actor_id);
        msg.flavor = flavor;
        msg.roll = Some(result);
        msg.flags = flags;
        if gm_only {
            msg.whisper = gm_ids;
        }
        self.post_chat(msg).await;
        Ok(())
    }

    /// Merge a player's newly explored areas into what's stored for them.
    /// Not broadcast: only that player needs it, and their client already has it.
    pub async fn explore(&self, user: &User, scene_id: &str, fog: FogMap) -> Result<(), String> {
        let mut world = self.world.write().await;
        let scene = world.scenes.get(scene_id).ok_or("scene not found")?;
        if !scene.vision.fog {
            return Ok(());
        }
        let incoming = fog::decode(&fog)?;
        let merged = match world.fog.get(scene_id).and_then(|m| m.get(&user.id)) {
            Some(old) if old.cols == fog.cols && old.rows == fog.rows => {
                let mut bits = fog::decode(old)?;
                bits.iter_mut().zip(&incoming).for_each(|(a, b)| *a |= b);
                bits
            }
            // First visit, or the scene's size/grid changed: start over.
            _ => incoming,
        };
        let op = Op::FogExplore {
            scene_id: scene_id.to_string(),
            user_id: user.id.clone(),
            fog: FogMap { cols: fog.cols, rows: fog.rows, data: fog::encode(&merged) },
        };
        world.apply(&op).map_err(|e| e.to_string())?;
        self.dirty.store(true, Ordering::Release);
        Ok(())
    }

    /// Roll initiative for combatants using the system's formula
    /// (`[combat] initiative` in its hearth.toml, default `1d20`). Each roll is
    /// posted to chat (privately to GMs for hidden combatants).
    /// Roll on a table (players: tables they can read) and post the result to chat.
    pub async fn draw_table(&self, user: &User, id: &str, gm_only: bool) -> Result<(), String> {
        let (table, gm_ids) = {
            let world = self.world.read().await;
            let t = world.tables.get(id).ok_or("table not found")?;
            if t.access_for(user) < Access::Observer {
                return Err("you can't roll on that table".into());
            }
            let gms: Vec<Id> = world.users.values().filter(|u| u.role == Role::Gm).map(|u| u.id.clone()).collect();
            (t.clone(), gms)
        };
        let total = table.total_weight();
        if total == 0 {
            return Err(format!("{} has no results to roll", table.name));
        }
        let result = hearth_dice::roll_with(&format!("1d{total}"), &|_| None, &mut rand_rng()).map_err(|e| e.to_string())?;
        let n = u32::try_from(result.total).unwrap_or(1).clamp(1, total);
        let text = table.pick(n).map(|r| r.text.clone()).unwrap_or_default();
        let mut msg = Self::message(user, None);
        msg.flavor = Some(table.name.clone());
        msg.content = text;
        msg.roll = Some(result);
        msg.flags = serde_json::json!({ "core": { "table": table.id } });
        if gm_only {
            msg.whisper = gm_ids;
        }
        self.post_chat(msg).await;
        Ok(())
    }

    pub async fn roll_initiative(&self, user: &User, ids: Vec<Id>) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let (formula, todo, gm_ids) = {
            let world = self.world.read().await;
            let c = world.combat.as_ref().ok_or("There is no combat")?;
            let formula = self.registry().initiative_formula(&world.system);
            let mut todo = vec![];
            for id in &ids {
                let x = c.combatant(id).ok_or("Combatant not found")?.clone();
                let owned = user.role == Role::Gm || x.actor_id.as_deref().is_some_and(|a| world.owns_actor(user, a));
                if !owned {
                    return Err(format!("You can't roll initiative for {}", x.name));
                }
                let actor = x.actor_id.as_deref().and_then(|a| world.actors.get(a)).cloned();
                todo.push((x, actor));
            }
            let gms: Vec<Id> = world.users.values().filter(|u| u.role == Role::Gm).map(|u| u.id.clone()).collect();
            (formula, todo, gms)
        };

        for (x, actor) in todo {
            let resolve = |path: &str| -> Option<i64> {
                let a = actor.as_ref()?;
                lookup_int(&a.derived, path).or_else(|| lookup_int(&a.data, path))
            };
            // A formula referencing missing data (e.g. an NPC without the
            // stat) falls back to a plain d20 rather than failing the batch.
            let result = hearth_dice::roll_with(&formula, &resolve, &mut rand_rng())
                .or_else(|_| hearth_dice::roll("1d20"))
                .map_err(|e| e.to_string())?;
            let total = result.total;
            let mut msg = Self::message(user, x.actor_id.clone());
            msg.flavor = Some(format!("{} rolls initiative", x.name));
            msg.roll = Some(result);
            if x.hidden {
                msg.whisper = gm_ids.clone();
            }
            self.post_chat(msg).await;

            let mut world = self.world.write().await;
            // The combatant may have been removed while we rolled.
            if Self::combatant_hidden(&world, &x.id).is_some() {
                let op = Op::CombatantUpdate { id: x.id.clone(), patch: serde_json::json!({ "initiative": total }) };
                self.commit(&mut world, &user.id, op, 0)?;
                self.dirty.store(true, Ordering::Release);
            }
        }
        Ok(())
    }

    /// Handle a chat line, including `/r`, `/gmr`, `/w` and `/clear`.
    pub async fn chat(&self, user: &User, content: &str, speaker_actor: Option<Id>) -> Result<(), String> {
        let content = content.trim();
        if content.is_empty() {
            return Ok(());
        }
        if content.len() > 4000 {
            return Err("message too long".into());
        }
        let (cmd, rest) = content.split_once(char::is_whitespace).unwrap_or((content, ""));
        let rest = rest.trim();
        match cmd.to_ascii_lowercase().as_str() {
            "/r" | "/roll" | "/gmr" => {
                // `/r 1d20+5 # Perception`
                let (formula, flavor) = match rest.split_once('#') {
                    Some((f, fl)) => (f.trim(), Some(fl.trim().to_string()).filter(|s| !s.is_empty())),
                    None => (rest, None),
                };
                self.roll(user, formula, flavor, speaker_actor, cmd.eq_ignore_ascii_case("/gmr")).await
            }
            "/w" | "/whisper" => {
                let (target, text) = rest.split_once(char::is_whitespace).ok_or("usage: /w <name> <message>")?;
                let target_id = {
                    let world = self.world.read().await;
                    world
                        .users
                        .values()
                        .find(|u| u.name.eq_ignore_ascii_case(target))
                        .map(|u| u.id.clone())
                        .ok_or_else(|| format!("no user named '{target}'"))?
                };
                let mut msg = Self::message(user, speaker_actor);
                msg.content = text.trim().to_string();
                msg.whisper = vec![target_id];
                self.post_chat(msg).await;
                Ok(())
            }
            "/clear" if user.role == Role::Gm => self.submit(user, Op::ChatClear).await,
            c if c.starts_with('/') => Err(format!("unknown command {c}")),
            _ => {
                let mut msg = Self::message(user, speaker_actor);
                msg.content = content.to_string();
                self.post_chat(msg).await;
                Ok(())
            }
        }
    }

    pub fn emit(&self, user: &User, channel: String, payload: Value, to: Option<Vec<Id>>) {
        let audience = match to {
            Some(ids) => Audience::Exactly(ids.into_iter().collect()),
            None => Audience::All,
        };
        self.send(ServerMsg::Emit { from: user.id.clone(), channel, payload }, audience);
    }
}

fn rand_rng() -> rand::rngs::ThreadRng {
    rand::thread_rng()
}

#[cfg(test)]
mod tests {
    use super::lookup_int;
    use serde_json::json;

    #[test]
    fn lookup_paths() {
        let v = json!({"abilities": {"str": {"mod": 3}}, "lvl": 2.7, "list": [5, 6], "s": " 4 "});
        assert_eq!(lookup_int(&v, "abilities.str.mod"), Some(3));
        assert_eq!(lookup_int(&v, "lvl"), Some(2));
        assert_eq!(lookup_int(&v, "list.1"), Some(6));
        assert_eq!(lookup_int(&v, "s"), Some(4));
        assert_eq!(lookup_int(&v, "abilities.dex.mod"), None);
    }
}

#[cfg(test)]
mod journal_tests {
    use super::*;
    use hearth_core::JournalEntry;
    use std::collections::BTreeMap;
    use serde_json::json;

    fn user(id: &str, role: Role) -> User {
        User { id: id.into(), name: id.into(), role, color: "#fff".into() }
    }

    /// What each player is sent: (user id, op name, content if any).
    fn sent(events: &[Event], world: &World) -> Vec<(String, String, Option<String>)> {
        let mut out = vec![];
        for u in world.users.values().filter(|u| u.role != Role::Gm) {
            for ev in events.iter().filter(|e| e.wants(u)) {
                let ServerMsg::Applied { op, .. } = &ev.msg else { continue };
                let v = serde_json::to_value(op).unwrap();
                let content = v.pointer("/entry/content").and_then(|c| c.as_str()).map(str::to_string);
                out.push((u.id.clone(), v["op"].as_str().unwrap().to_string(), content));
            }
        }
        out
    }

    #[test]
    fn players_get_only_what_they_may_see() {
        let mut w = World::new("T", "freeform");
        for u in [user("gm", Role::Gm), user("ann", Role::Player), user("bob", Role::Player)] {
            w.users.insert(u.id.clone(), u);
        }
        let entry = JournalEntry {
            id: "j1".into(), name: "Secret".into(), folder: String::new(), content: "the butler".into(),
            img: None, access: Access::None, players: BTreeMap::new(),
        };
        let gm: Id = "gm".into();
        let step = |w: &mut World, op: Op| {
            let before = AppState::scoped_before(w, &op).unwrap();
            w.apply(&op).unwrap();
            let evs = AppState::scoped_events(w, op, &gm, before);
            assert!(evs.iter().any(|e| e.wants(&w.users["gm"])), "the GM always hears");
            sent(&evs, w)
        };

        // Hidden from players: nobody but the GM hears about it.
        assert!(step(&mut w, Op::JournalCreate { entry }).is_empty());
        // Ann may observe: she gets the whole entry; Bob nothing.
        let s = step(&mut w, Op::JournalUpdate { id: "j1".into(), patch: json!({"players": {"ann": "observer"}}) });
        assert_eq!(s, vec![("ann".into(), "journal_create".into(), Some("the butler".into()))]);
        // Everyone limited: Bob gets name only; Ann keeps observer and gets the op.
        let s = step(&mut w, Op::JournalUpdate { id: "j1".into(), patch: json!({"access": "limited"}) });
        assert_eq!(s, vec![
            ("ann".into(), "journal_update".into(), None),
            ("bob".into(), "journal_create".into(), Some(String::new())),
        ]);
        // A text edit: Ann sees it; Bob's limited view hasn't changed, so he hears nothing.
        let s = step(&mut w, Op::JournalUpdate { id: "j1".into(), patch: json!({"content": "the gardener"}) });
        assert_eq!(s, vec![("ann".into(), "journal_update".into(), None)]);
        // Hide it from Ann again: she's told to delete it.
        let s = step(&mut w, Op::JournalUpdate { id: "j1".into(), patch: json!({"players": {"ann": null}, "access": "none"}) });
        assert_eq!(s, vec![("ann".into(), "journal_delete".into(), None), ("bob".into(), "journal_delete".into(), None)]);
        // Deleting a hidden entry tells no player.
        assert!(step(&mut w, Op::JournalDelete { id: "j1".into() }).is_empty());
        assert!(w.journal.is_empty());
    }

    #[test]
    fn view_for_strips_hidden_and_limited_entries() {
        let mut w = World::new("T", "freeform");
        let mk = |id: &str, access| JournalEntry {
            id: id.into(), name: id.into(), folder: String::new(), content: "text".into(), img: None, access, players: BTreeMap::new(),
        };
        for e in [mk("hidden", Access::None), mk("limited", Access::Limited), mk("open", Access::Observer)] {
            w.journal.insert(e.id.clone(), e);
        }
        let v = w.view_for(&user("p", Role::Player));
        assert!(!v.journal.contains_key("hidden"));
        assert_eq!(v.journal["limited"].content, "");
        assert_eq!(v.journal["open"].content, "text");
        assert_eq!(w.view_for(&user("g", Role::Gm)).journal.len(), 3);
    }
}

#[cfg(test)]
mod library_tests {
    use super::*;
    use hearth_core::{Macro, MacroKind, RollTable, TableResult};
    use serde_json::json;

    fn user(id: &str, role: Role) -> User {
        User { id: id.into(), name: id.into(), role, color: "#fff".into() }
    }

    fn world() -> World {
        let mut w = World::new("T", "freeform");
        for u in [user("gm", Role::Gm), user("ann", Role::Player), user("bob", Role::Player)] {
            w.users.insert(u.id.clone(), u);
        }
        w
    }

    fn mac(id: &str, author: &str, kind: MacroKind, shared: bool) -> Macro {
        Macro { id: id.into(), name: id.into(), kind, command: "/r 1d20".into(), img: None, author: author.into(), shared }
    }

    /// Ops each player receives for `op`.
    fn receivers(w: &mut World, op: Op) -> Vec<(String, String)> {
        let before = AppState::scoped_before(w, &op).unwrap();
        w.apply(&op).unwrap();
        let evs = AppState::scoped_events(w, op, &"gm".to_string(), before);
        let mut out = vec![];
        for u in w.users.values().filter(|u| u.role != Role::Gm) {
            for ev in evs.iter().filter(|e| e.wants(u)) {
                let ServerMsg::Applied { op, .. } = &ev.msg else { continue };
                out.push((u.id.clone(), serde_json::to_value(op).unwrap()["op"].as_str().unwrap().to_string()));
            }
        }
        out
    }

    #[test]
    fn macros_reach_their_author_and_shared_ones_reach_everyone() {
        let mut w = world();
        let r = receivers(&mut w, Op::MacroCreate { r#macro: mac("m1", "ann", MacroKind::Chat, false) });
        assert_eq!(r, vec![("ann".into(), "macro_create".into())]);
        let r = receivers(&mut w, Op::MacroUpdate { id: "m1".into(), patch: json!({"command": "/r 2d6"}) });
        assert_eq!(r, vec![("ann".into(), "macro_update".into())]);
        let r = receivers(&mut w, Op::MacroCreate { r#macro: mac("m2", "gm", MacroKind::Script, false) });
        assert!(r.is_empty(), "an unshared GM macro stays with the GM");
        let r = receivers(&mut w, Op::MacroUpdate { id: "m2".into(), patch: json!({"shared": true}) });
        assert_eq!(r, vec![("ann".into(), "macro_create".into()), ("bob".into(), "macro_create".into())]);
        let v = w.view_for(&w.users["bob"].clone());
        assert_eq!(v.macros.keys().collect::<Vec<_>>(), vec!["m2"]);
    }

    #[test]
    fn players_only_touch_their_own_chat_macros_and_hotbar() {
        let mut w = world();
        let ann = w.users["ann"].clone();
        w.apply(&Op::MacroCreate { r#macro: mac("mine", "ann", MacroKind::Chat, false) }).unwrap();
        w.apply(&Op::MacroCreate { r#macro: mac("gms", "gm", MacroKind::Script, true) }).unwrap();
        let ok = |op: Op| AppState::permitted(&w, &ann, &op).is_ok();
        assert!(ok(Op::MacroUpdate { id: "mine".into(), patch: json!({"command": "hi"}) }));
        assert!(!ok(Op::MacroUpdate { id: "mine".into(), patch: json!({"kind": "script"}) }), "can't make it a script");
        assert!(!ok(Op::MacroUpdate { id: "mine".into(), patch: json!({"shared": true}) }), "can't share it");
        assert!(!ok(Op::MacroUpdate { id: "gms".into(), patch: json!({"command": "evil()"}) }), "can't edit the GM's");
        assert!(!ok(Op::MacroDelete { id: "gms".into() }));
        assert!(ok(Op::HotbarSet { user_id: "ann".into(), slot: 1, macro_id: Some("gms".into()) }));
        assert!(!ok(Op::HotbarSet { user_id: "bob".into(), slot: 1, macro_id: None }), "not someone else's hotbar");
        assert!(!ok(Op::TableCreate { table: RollTable {
            id: "t".into(), name: "t".into(), folder: String::new(), description: String::new(), results: vec![],
            access: Access::None, players: Default::default(),
        } }));
    }

    #[test]
    fn deleting_a_macro_clears_hotbar_slots() {
        let mut w = world();
        w.apply(&Op::MacroCreate { r#macro: mac("m", "ann", MacroKind::Chat, false) }).unwrap();
        w.apply(&Op::HotbarSet { user_id: "ann".into(), slot: 3, macro_id: Some("m".into()) }).unwrap();
        assert_eq!(w.hotbars["ann"][&3], "m");
        w.apply(&Op::MacroDelete { id: "m".into() }).unwrap();
        assert!(w.hotbars["ann"].is_empty());
        let _ = TableResult { text: String::new(), weight: 1 };
    }
}

#[cfg(test)]
mod level_tests {
    use super::*;
    use serde_json::json;

    /// A scene with an upper floor, stairs up at (2, 2)–(3, 4) on the ground, a wall upstairs at
    /// x = 5, and ann's token at (1, 1).
    fn setup() -> (World, User, Id) {
        let mut w = World::new("T", "freeform");
        let ann = User { id: "ann".into(), name: "ann".into(), role: Role::Player, color: "#fff".into() };
        w.users.insert(ann.id.clone(), ann.clone());
        let sid = w.active_scene.clone().unwrap();
        w.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"levels": [{"id": "up", "name": "Upper floor", "elevation": 1}]}) }).unwrap();
        let actor: Actor = serde_json::from_value(json!({"id": "a1", "name": "Ann", "kind": "character", "owners": ["ann"]})).unwrap();
        w.apply(&Op::ActorCreate { actor }).unwrap();
        let token: hearth_core::Token = serde_json::from_value(json!({"id": "t1", "name": "Ann", "actor_id": "a1", "x": 70, "y": 70})).unwrap();
        w.apply(&Op::TokenCreate { scene_id: sid.clone(), token }).unwrap();
        let links = serde_json::from_value(json!({"sk-l-s": {"id": "sk-l-s", "poly": [[140, 140], [210, 140], [210, 280], [140, 280]], "to": "up"}})).unwrap();
        let walls = serde_json::from_value(json!({"sk-e-0": {"id": "sk-e-0", "a": [350, 0], "b": [350, 700]}})).unwrap();
        w.apply(&Op::SketchUpdate { scene_id: sid.clone(), level: String::new(), patch: json!({}), walls: None, lights: None, links: Some(links) }).unwrap();
        w.apply(&Op::SketchUpdate { scene_id: sid.clone(), level: "up".into(), patch: json!({"floor": {"0,0": "wood"}}), walls: Some(walls), lights: None, links: None }).unwrap();
        (w, ann, sid)
    }

    #[test]
    fn sketch_levels_keep_their_own_walls_and_sketch() {
        let (w, _, sid) = setup();
        let s = &w.scenes[&sid];
        assert_eq!(s.walls["sk-e-0"].level, "up", "the wall is put on the level its sketch is");
        assert_eq!(s.links["sk-l-s"].level, "", "the stairs are on the ground");
        assert!(s.sketch.as_ref().is_some_and(|k| k.floor.is_empty()) && s.level_sketches["up"].floor.len() == 1);
        // A scene patch can't overwrite the levels' sketches or links.
        let mut w2 = w.clone();
        w2.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"level_sketches": {}, "links": {}}) }).unwrap();
        assert_eq!(w2.scenes[&sid].level_sketches.len(), 1);
        assert_eq!(w2.scenes[&sid].links.len(), 1);
        // A sketch for a level that doesn't exist is refused.
        assert!(w2.apply(&Op::SketchUpdate { scene_id: sid, level: "nope".into(), patch: json!({}), walls: None, lights: None, links: None }).is_err());
    }

    #[test]
    fn players_change_level_only_by_way_of_a_link() {
        let (mut w, ann, sid) = setup();
        let ok = |w: &World, patch: serde_json::Value| AppState::permitted(w, &ann, &Op::TokenUpdate { scene_id: sid.clone(), id: "t1".into(), patch });
        assert!(ok(&w, json!({"level": "up"})).is_err(), "not standing on the stairs");
        // Onto the stairs (ground walls only; the upstairs wall at x = 350 isn't in the way).
        assert!(ok(&w, json!({"x": 140, "y": 175})).is_ok());
        w.apply(&Op::TokenUpdate { scene_id: sid.clone(), id: "t1".into(), patch: json!({"x": 140, "y": 175}) }).unwrap();
        assert!(ok(&w, json!({"level": "nowhere"})).is_err(), "the stairs don't lead there");
        assert!(ok(&w, json!({"level": "up", "x": 700, "y": 700})).is_err(), "no arriving somewhere else");
        assert!(ok(&w, json!({"level": "up"})).is_ok());
        w.apply(&Op::TokenUpdate { scene_id: sid.clone(), id: "t1".into(), patch: json!({"level": "up"}) }).unwrap();
        // Upstairs, the wall at x = 350 is in the way; there are no stairs back down here.
        assert!(ok(&w, json!({"x": 420})).is_err());
        assert!(ok(&w, json!({"x": 210})).is_ok());
        assert!(ok(&w, json!({"level": null})).is_err());
    }
}
