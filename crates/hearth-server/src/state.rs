//! Authoritative world state: permission checks, op application, rolls and
//! fan-out of events to connected clients.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock as StdRwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use hearth_core::patch::merge_patch;
use hearth_core::protocol::UserAdmin;
use hearth_core::{new_id, Actor, ChatMessage, Id, Op, Role, ServerMsg, User, World};

use crate::credentials::{self, Credentials};
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
    pub registry: Registry,
    pub scripts: StdRwLock<ScriptHost>,
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
        // Scripts may have changed since the world was saved; refresh derived data.
        for actor in world.actors.values_mut() {
            if let Some(d) = scripts.prepare_actor(actor) {
                actor.derived = d;
            }
        }
        let (tx, _) = broadcast::channel(1024);
        AppState {
            world: RwLock::new(world),
            registry,
            scripts: StdRwLock::new(scripts),
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
        self.registry.client_index(&world.system, &world.modules, world.theme.as_deref())
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
                let token = world.scenes.get(scene_id).and_then(|s| s.tokens.get(id)).ok_or("token not found")?;
                let owned = token.actor_id.as_deref().is_some_and(|a| world.owns_actor(user, a));
                let movement_only = patch
                    .as_object()
                    .is_some_and(|p| p.keys().all(|k| matches!(k.as_str(), "x" | "y" | "rotation")));
                if owned && movement_only && !token.hidden {
                    Ok(())
                } else {
                    deny()
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
            _ => deny(),
        }
    }

    // ------------------------------------------------------------ ops

    /// Fill in ids and system templates for create ops.
    fn normalize(&self, world: &World, user: &User, op: &mut Op) {
        match op {
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
            Op::ActorCreate { actor } => {
                if actor.id.is_empty() {
                    actor.id = new_id();
                }
                let mut data = self.registry.actor_template(&world.system, &actor.kind);
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
            Op::ItemCreate { item, .. } => {
                if item.id.is_empty() {
                    item.id = new_id();
                }
                let mut data = self.registry.item_template(&world.system, &item.kind);
                merge_patch(&mut data, &item.data);
                item.data = data;
            }
            _ => {}
        }
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
            _ => all(op),
        }
    }

    /// Validate, apply and broadcast an op from a user.
    pub async fn submit(&self, user: &User, mut op: Op) -> Result<(), String> {
        let mut world = self.world.write().await;
        Self::permitted(&world, user, &op)?;
        self.normalize(&world, user, &mut op);

        let hidden_before = match &op {
            Op::TokenUpdate { scene_id, id, .. } | Op::TokenDelete { scene_id, id } => {
                Self::token_hidden(&world, scene_id, id)
            }
            _ => None,
        };
        let modules_changed = matches!(&op, Op::WorldUpdate { patch } if patch.get("modules").is_some());

        world.apply(&op).map_err(|e| e.to_string())?;
        let affected = op.affected_actor().map(str::to_string);

        for ev in Self::fan_out(&world, op, &user.id, hidden_before) {
            let _ = self.tx.send(Arc::new(ev));
        }

        if modules_changed {
            let (host, errors) = ScriptHost::load(&self.registry, &world.system, &world.modules);
            for e in errors {
                tracing::warn!("script error: {e}");
            }
            *self.scripts.write().unwrap() = host;
            let ids: Vec<Id> = world.actors.keys().cloned().collect();
            for id in ids {
                self.derive(&mut world, &id);
            }
        } else if let Some(id) = affected {
            self.derive(&mut world, &id);
        }

        self.dirty.store(true, Ordering::Release);
        Ok(())
    }

    /// Re-run `prepare_actor` and broadcast the result if it changed.
    fn derive(&self, world: &mut World, actor_id: &str) {
        let Some(actor) = world.actors.get(actor_id) else { return };
        let Some(derived) = self.scripts.read().unwrap().prepare_actor(actor) else { return };
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
