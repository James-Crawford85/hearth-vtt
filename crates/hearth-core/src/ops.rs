use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::model::*;
use crate::patch::patch_entity;

/// Max chat messages retained in a world.
pub const CHAT_HISTORY: usize = 500;

/// Every mutation of a world. Serialized as `{"op": "token_update", ...}`.
///
/// `patch` fields are JSON merge patches (RFC 7386).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    WorldUpdate { patch: Value },

    SceneCreate { scene: Scene },
    SceneUpdate { id: Id, patch: Value },
    SceneDelete { id: Id },
    SceneActivate { id: Id },

    TokenCreate { scene_id: Id, token: Token },
    TokenUpdate { scene_id: Id, id: Id, patch: Value },
    TokenDelete { scene_id: Id, id: Id },

    WallCreate { scene_id: Id, wall: Wall },
    WallUpdate { scene_id: Id, id: Id, patch: Value },
    WallDelete { scene_id: Id, id: Id },

    LightCreate { scene_id: Id, light: Light },
    LightUpdate { scene_id: Id, id: Id, patch: Value },
    LightDelete { scene_id: Id, id: Id },

    SoundCreate { scene_id: Id, sound: AmbientSound },
    SoundUpdate { scene_id: Id, id: Id, patch: Value },
    SoundDelete { scene_id: Id, id: Id },

    /// Playlists. Start or stop a track by patching `sounds.<id>.playing`;
    /// the server stamps `started`.
    PlaylistCreate { playlist: Playlist },
    PlaylistUpdate { id: Id, patch: Value },
    PlaylistDelete { id: Id },

    DrawingCreate { scene_id: Id, drawing: Drawing },
    DrawingUpdate { scene_id: Id, id: Id, patch: Value },
    DrawingDelete { scene_id: Id, id: Id },

    /// Forget what everyone has explored on a scene.
    FogReset { scene_id: Id },
    /// Server-only: store one player's merged explored map.
    FogExplore { scene_id: Id, user_id: Id, fog: FogMap },

    ActorCreate { actor: Actor },
    ActorUpdate { id: Id, patch: Value },
    ActorDelete { id: Id },
    /// Server-only: replaces an actor's derived data after scripts run.
    ActorDerive { id: Id, derived: Value },

    ItemCreate { actor_id: Id, item: Item },
    ItemUpdate { actor_id: Id, id: Id, patch: Value },
    ItemDelete { actor_id: Id, id: Id },

    /// Adds a journal entry, or replaces it if the id exists (the server also
    /// uses this to send a player a changed view of an entry).
    JournalCreate { entry: JournalEntry },
    JournalUpdate { id: Id, patch: Value },
    JournalDelete { id: Id },

    /// The Items directory. Create replaces an existing id (as journal_create does).
    LibraryItemCreate { item: LibraryItem },
    LibraryItemUpdate { id: Id, patch: Value },
    LibraryItemDelete { id: Id },

    /// World collections (create replaces an existing id).
    CollectionCreate { collection: Collection },
    CollectionUpdate { id: Id, patch: Value },
    CollectionDelete { id: Id },

    TableCreate { table: RollTable },
    TableUpdate { id: Id, patch: Value },
    TableDelete { id: Id },

    MacroCreate { r#macro: Macro },
    MacroUpdate { id: Id, patch: Value },
    MacroDelete { id: Id },
    /// Put a macro in (or, with none, clear) a slot of a user's hotbar.
    HotbarSet { user_id: Id, slot: u8, macro_id: Option<Id> },

    ChatCreate { message: ChatMessage },
    ChatDelete { id: Id },
    ChatClear,

    /// Server-only: add or update a user.
    UserUpsert { user: User },
    /// Server-only: remove a user (and their actor ownership).
    UserDelete { id: Id },

    /// Begin an encounter (replaces any existing one).
    CombatCreate { combat: Combat },
    /// Merge-patch the encounter (`round`, `current`, `flags`).
    CombatUpdate { patch: Value },
    CombatEnd,
    /// Clients may send just `token_id`; the server fills in name, image,
    /// actor and hidden from the token.
    CombatantAdd { combatant: Combatant },
    CombatantUpdate { id: Id, patch: Value },
    CombatantRemove { id: Id },
    /// Requests the server turns into a `combat_update` with the new round
    /// and current combatant, so every client agrees on the turn order.
    CombatStart,
    CombatNext,
    CombatPrev,
}

#[derive(Debug, Error)]
pub enum OpError {
    #[error("{0} '{1}' not found")]
    NotFound(&'static str, Id),
    #[error("{0} '{1}' already exists")]
    Exists(&'static str, Id),
    #[error("invalid patch: {0}")]
    BadPatch(#[from] serde_json::Error),
}

impl Op {
    /// Ops only the server itself may originate.
    pub fn is_server_only(&self) -> bool {
        matches!(
            self,
            Op::ActorDerive { .. } | Op::UserUpsert { .. } | Op::UserDelete { .. } | Op::ChatCreate { .. } | Op::FogExplore { .. }
        )
    }

    /// The actor an op touches, if any (used to re-run `prepare_actor`).
    pub fn affected_actor(&self) -> Option<&str> {
        match self {
            Op::ActorCreate { actor } => Some(&actor.id),
            Op::ActorUpdate { id, .. } => Some(id),
            Op::ItemCreate { actor_id, .. } | Op::ItemUpdate { actor_id, .. } | Op::ItemDelete { actor_id, .. } => {
                Some(actor_id)
            }
            _ => None,
        }
    }
}

fn scene_mut<'a>(w: &'a mut World, id: &str) -> Result<&'a mut Scene, OpError> {
    w.scenes.get_mut(id).ok_or_else(|| OpError::NotFound("scene", id.into()))
}

fn actor_mut<'a>(w: &'a mut World, id: &str) -> Result<&'a mut Actor, OpError> {
    w.actors.get_mut(id).ok_or_else(|| OpError::NotFound("actor", id.into()))
}

fn combat_mut(w: &mut World) -> Result<&mut Combat, OpError> {
    w.combat.as_mut().ok_or_else(|| OpError::NotFound("combat", "current".into()))
}

impl World {
    /// Apply an op. On error the world is unchanged.
    pub fn apply(&mut self, op: &Op) -> Result<(), OpError> {
        match op {
            Op::WorldUpdate { patch } => {
                patch_entity(self, patch, &["system", "scenes", "actors", "users", "chat", "active_scene", "combat", "journal", "fog", "items", "tables", "macros", "hotbars", "playlists", "collections"])?
            }

            Op::SceneCreate { scene } => {
                if self.scenes.contains_key(&scene.id) {
                    return Err(OpError::Exists("scene", scene.id.clone()));
                }
                self.scenes.insert(scene.id.clone(), scene.clone());
                if self.active_scene.is_none() {
                    self.active_scene = Some(scene.id.clone());
                }
            }
            Op::SceneUpdate { id, patch } => patch_entity(scene_mut(self, id)?, patch, &["tokens", "walls", "drawings", "lights", "sounds"])?,
            Op::SceneDelete { id } => {
                self.scenes.remove(id).ok_or_else(|| OpError::NotFound("scene", id.clone()))?;
                if self.active_scene.as_deref() == Some(id) {
                    self.active_scene = self.scenes.keys().next().cloned();
                }
                if self.combat.as_ref().is_some_and(|c| &c.scene_id == id) {
                    self.combat = None;
                }
                self.fog.remove(id);
            }

            Op::WallCreate { scene_id, wall } => {
                let s = scene_mut(self, scene_id)?;
                if s.walls.contains_key(&wall.id) {
                    return Err(OpError::Exists("wall", wall.id.clone()));
                }
                s.walls.insert(wall.id.clone(), wall.clone());
            }
            Op::WallUpdate { scene_id, id, patch } => {
                let w = scene_mut(self, scene_id)?.walls.get_mut(id).ok_or_else(|| OpError::NotFound("wall", id.clone()))?;
                patch_entity(w, patch, &[])?
            }
            Op::WallDelete { scene_id, id } => {
                scene_mut(self, scene_id)?.walls.remove(id).ok_or_else(|| OpError::NotFound("wall", id.clone()))?;
            }
            Op::LightCreate { scene_id, light } => {
                let s = scene_mut(self, scene_id)?;
                if s.lights.contains_key(&light.id) {
                    return Err(OpError::Exists("light", light.id.clone()));
                }
                s.lights.insert(light.id.clone(), light.clone());
            }
            Op::LightUpdate { scene_id, id, patch } => {
                let l = scene_mut(self, scene_id)?.lights.get_mut(id).ok_or_else(|| OpError::NotFound("light", id.clone()))?;
                patch_entity(l, patch, &[])?
            }
            Op::LightDelete { scene_id, id } => {
                scene_mut(self, scene_id)?.lights.remove(id).ok_or_else(|| OpError::NotFound("light", id.clone()))?;
            }
            Op::SoundCreate { scene_id, sound } => {
                let s = scene_mut(self, scene_id)?;
                if s.sounds.contains_key(&sound.id) {
                    return Err(OpError::Exists("sound", sound.id.clone()));
                }
                s.sounds.insert(sound.id.clone(), sound.clone());
            }
            Op::SoundUpdate { scene_id, id, patch } => {
                let x = scene_mut(self, scene_id)?.sounds.get_mut(id).ok_or_else(|| OpError::NotFound("sound", id.clone()))?;
                patch_entity(x, patch, &[])?
            }
            Op::SoundDelete { scene_id, id } => {
                scene_mut(self, scene_id)?.sounds.remove(id).ok_or_else(|| OpError::NotFound("sound", id.clone()))?;
            }
            Op::PlaylistCreate { playlist } => {
                if self.playlists.contains_key(&playlist.id) {
                    return Err(OpError::Exists("playlist", playlist.id.clone()));
                }
                self.playlists.insert(playlist.id.clone(), playlist.clone());
            }
            Op::PlaylistUpdate { id, patch } => {
                let x = self.playlists.get_mut(id).ok_or_else(|| OpError::NotFound("playlist", id.clone()))?;
                patch_entity(x, patch, &[])?
            }
            Op::PlaylistDelete { id } => {
                self.playlists.remove(id).ok_or_else(|| OpError::NotFound("playlist", id.clone()))?;
            }
            Op::DrawingCreate { scene_id, drawing } => {
                let s = scene_mut(self, scene_id)?;
                if s.drawings.contains_key(&drawing.id) {
                    return Err(OpError::Exists("drawing", drawing.id.clone()));
                }
                s.drawings.insert(drawing.id.clone(), drawing.clone());
            }
            Op::DrawingUpdate { scene_id, id, patch } => {
                let d = scene_mut(self, scene_id)?.drawings.get_mut(id).ok_or_else(|| OpError::NotFound("drawing", id.clone()))?;
                patch_entity(d, patch, &["author"])?
            }
            Op::DrawingDelete { scene_id, id } => {
                scene_mut(self, scene_id)?.drawings.remove(id).ok_or_else(|| OpError::NotFound("drawing", id.clone()))?;
            }
            Op::FogReset { scene_id } => {
                scene_mut(self, scene_id)?;
                self.fog.remove(scene_id);
            }
            Op::FogExplore { scene_id, user_id, fog } => {
                scene_mut(self, scene_id)?;
                self.fog.entry(scene_id.clone()).or_default().insert(user_id.clone(), fog.clone());
            }
            Op::SceneActivate { id } => {
                scene_mut(self, id)?;
                self.active_scene = Some(id.clone());
            }

            Op::TokenCreate { scene_id, token } => {
                let s = scene_mut(self, scene_id)?;
                if s.tokens.contains_key(&token.id) {
                    return Err(OpError::Exists("token", token.id.clone()));
                }
                s.tokens.insert(token.id.clone(), token.clone());
            }
            Op::TokenUpdate { scene_id, id, patch } => {
                let t = scene_mut(self, scene_id)?
                    .tokens
                    .get_mut(id)
                    .ok_or_else(|| OpError::NotFound("token", id.clone()))?;
                patch_entity(t, patch, &[])?
            }
            Op::TokenDelete { scene_id, id } => {
                scene_mut(self, scene_id)?
                    .tokens
                    .remove(id)
                    .ok_or_else(|| OpError::NotFound("token", id.clone()))?;
                // A deleted token leaves the fight too.
                if let Some(c) = self.combat.as_mut().filter(|c| &c.scene_id == scene_id) {
                    c.combatants.retain(|x| x.token_id.as_deref() != Some(id));
                }
            }

            Op::JournalCreate { entry } => {
                self.journal.insert(entry.id.clone(), entry.clone());
            }
            Op::JournalUpdate { id, patch } => {
                let e = self.journal.get_mut(id).ok_or_else(|| OpError::NotFound("journal entry", id.clone()))?;
                patch_entity(e, patch, &["id"])?
            }
            Op::JournalDelete { id } => {
                self.journal.remove(id).ok_or_else(|| OpError::NotFound("journal entry", id.clone()))?;
            }

            Op::LibraryItemCreate { item } => {
                self.items.insert(item.item.id.clone(), item.clone());
            }
            Op::LibraryItemUpdate { id, patch } => {
                let x = self.items.get_mut(id).ok_or_else(|| OpError::NotFound("item", id.clone()))?;
                patch_entity(x, patch, &["id"])?
            }
            Op::LibraryItemDelete { id } => {
                self.items.remove(id).ok_or_else(|| OpError::NotFound("item", id.clone()))?;
            }
            Op::CollectionCreate { collection } => {
                self.collections.insert(collection.id.clone(), collection.clone());
            }
            Op::CollectionUpdate { id, patch } => {
                let x = self.collections.get_mut(id).ok_or_else(|| OpError::NotFound("collection", id.clone()))?;
                patch_entity(x, patch, &["id"])?
            }
            Op::CollectionDelete { id } => {
                self.collections.remove(id).ok_or_else(|| OpError::NotFound("collection", id.clone()))?;
            }
            Op::TableCreate { table } => {
                self.tables.insert(table.id.clone(), table.clone());
            }
            Op::TableUpdate { id, patch } => {
                let x = self.tables.get_mut(id).ok_or_else(|| OpError::NotFound("table", id.clone()))?;
                patch_entity(x, patch, &["id"])?
            }
            Op::TableDelete { id } => {
                self.tables.remove(id).ok_or_else(|| OpError::NotFound("table", id.clone()))?;
            }
            Op::MacroCreate { r#macro } => {
                self.macros.insert(r#macro.id.clone(), r#macro.clone());
            }
            Op::MacroUpdate { id, patch } => {
                let x = self.macros.get_mut(id).ok_or_else(|| OpError::NotFound("macro", id.clone()))?;
                patch_entity(x, patch, &["id", "author"])?
            }
            Op::MacroDelete { id } => {
                self.macros.remove(id).ok_or_else(|| OpError::NotFound("macro", id.clone()))?;
                for bar in self.hotbars.values_mut() {
                    bar.retain(|_, m| m != id);
                }
            }
            Op::HotbarSet { user_id, slot, macro_id } => {
                let bar = self.hotbars.entry(user_id.clone()).or_default();
                match macro_id {
                    Some(m) => {
                        bar.insert(*slot, m.clone());
                    }
                    None => {
                        bar.remove(slot);
                    }
                }
            }

            Op::ActorCreate { actor } => {
                if self.actors.contains_key(&actor.id) {
                    return Err(OpError::Exists("actor", actor.id.clone()));
                }
                self.actors.insert(actor.id.clone(), actor.clone());
            }
            Op::ActorUpdate { id, patch } => patch_entity(actor_mut(self, id)?, patch, &["items", "derived"])?,
            Op::ActorDelete { id } => {
                self.actors.remove(id).ok_or_else(|| OpError::NotFound("actor", id.clone()))?;
                if let Some(c) = &mut self.combat {
                    for x in c.combatants.iter_mut().filter(|x| x.actor_id.as_deref() == Some(id)) {
                        x.actor_id = None;
                    }
                }
                for s in self.scenes.values_mut() {
                    for t in s.tokens.values_mut() {
                        if t.actor_id.as_deref() == Some(id) {
                            t.actor_id = None;
                        }
                    }
                }
            }
            Op::ActorDerive { id, derived } => actor_mut(self, id)?.derived = derived.clone(),

            Op::ItemCreate { actor_id, item } => {
                let a = actor_mut(self, actor_id)?;
                if a.items.iter().any(|i| i.id == item.id) {
                    return Err(OpError::Exists("item", item.id.clone()));
                }
                a.items.push(item.clone());
            }
            Op::ItemUpdate { actor_id, id, patch } => {
                let item = actor_mut(self, actor_id)?
                    .item_mut(id)
                    .ok_or_else(|| OpError::NotFound("item", id.clone()))?;
                patch_entity(item, patch, &[])?
            }
            Op::ItemDelete { actor_id, id } => {
                let a = actor_mut(self, actor_id)?;
                let before = a.items.len();
                a.items.retain(|i| &i.id != id);
                if a.items.len() == before {
                    return Err(OpError::NotFound("item", id.clone()));
                }
            }

            Op::ChatCreate { message } => {
                self.chat.push(message.clone());
                if self.chat.len() > CHAT_HISTORY {
                    let excess = self.chat.len() - CHAT_HISTORY;
                    self.chat.drain(..excess);
                }
            }
            Op::ChatDelete { id } => self.chat.retain(|m| &m.id != id),
            Op::ChatClear => self.chat.clear(),

            Op::UserUpsert { user } => {
                self.users.insert(user.id.clone(), user.clone());
            }
            Op::UserDelete { id } => {
                self.users.remove(id).ok_or_else(|| OpError::NotFound("user", id.clone()))?;
                for a in self.actors.values_mut() {
                    a.owners.retain(|o| o != id);
                }
            }

            Op::CombatCreate { combat } => self.combat = Some(combat.clone()),
            Op::CombatUpdate { patch } => patch_entity(combat_mut(self)?, patch, &["combatants", "scene_id"])?,
            Op::CombatEnd => {
                self.combat.take().ok_or_else(|| OpError::NotFound("combat", "current".into()))?;
            }
            Op::CombatantAdd { combatant } => {
                let c = combat_mut(self)?;
                if c.combatant(&combatant.id).is_some() {
                    return Err(OpError::Exists("combatant", combatant.id.clone()));
                }
                c.combatants.push(combatant.clone());
            }
            Op::CombatantUpdate { id, patch } => {
                let x = combat_mut(self)?
                    .combatants
                    .iter_mut()
                    .find(|x| &x.id == id)
                    .ok_or_else(|| OpError::NotFound("combatant", id.clone()))?;
                patch_entity(x, patch, &["token_id", "actor_id"])?
            }
            Op::CombatantRemove { id } => {
                let c = combat_mut(self)?;
                let before = c.combatants.len();
                c.combatants.retain(|x| &x.id != id);
                if c.combatants.len() == before {
                    return Err(OpError::NotFound("combatant", id.clone()));
                }
            }
            Op::CombatStart | Op::CombatNext | Op::CombatPrev => {
                let c = combat_mut(self)?;
                let (round, current) = match op {
                    Op::CombatStart => c.start_turn(),
                    Op::CombatNext => c.next_turn(),
                    _ => c.prev_turn(),
                };
                c.round = round;
                c.current = current;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn token_lifecycle_and_patch() {
        let mut w = World::new("Test", "freeform");
        let sid = w.active_scene.clone().unwrap();
        let token = Token {
            id: "t1".into(),
            name: "Goblin".into(),
            actor_id: None,
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            img: None,
            color: "#fff".into(),
            rotation: 0.0,
            hidden: false,
            show_name: true,
            sight: 0.0,
            light: None,
            flags: Value::Null,
        };
        w.apply(&Op::TokenCreate { scene_id: sid.clone(), token }).unwrap();
        w.apply(&Op::TokenUpdate { scene_id: sid.clone(), id: "t1".into(), patch: json!({"x": 140, "id": "evil"}) })
            .unwrap();
        let t = &w.scenes[&sid].tokens["t1"];
        assert_eq!(t.x, 140.0);
        assert_eq!(t.id, "t1");
        assert!(w.apply(&Op::TokenDelete { scene_id: sid.clone(), id: "nope".into() }).is_err());
    }

    #[test]
    fn op_json_shape() {
        let op: Op = serde_json::from_value(json!({"op": "actor_update", "id": "a", "patch": {"name": "X"}})).unwrap();
        assert!(matches!(op, Op::ActorUpdate { .. }));
        assert_eq!(serde_json::to_value(Op::ChatClear).unwrap(), json!({"op": "chat_clear"}));
    }

    #[test]
    fn actor_patch_cannot_touch_items_or_derived() {
        let mut w = World::new("Test", "freeform");
        let actor = Actor {
            id: "a".into(),
            name: "Hero".into(),
            kind: "character".into(),
            img: None,
            owners: vec![],
            data: json!({"hp": {"value": 5, "max": 10}}),
            derived: json!({"x": 1}),
            items: vec![],
            effects: vec![],
            flags: Value::Null,
        };
        w.apply(&Op::ActorCreate { actor }).unwrap();
        w.apply(&Op::ActorUpdate {
            id: "a".into(),
            patch: json!({"data": {"hp": {"value": 7}}, "derived": {"x": 99}, "items": [{"bad": 1}]}),
        })
        .unwrap();
        let a = &w.actors["a"];
        assert_eq!(a.data, json!({"hp": {"value": 7, "max": 10}}));
        assert_eq!(a.derived, json!({"x": 1}));
        assert!(a.items.is_empty());
    }
}

#[cfg(test)]
mod combat_tests {
    use super::*;
    use serde_json::json;

    fn cb(id: &str, name: &str, init: Option<f64>) -> Combatant {
        Combatant {
            id: id.into(),
            token_id: None,
            actor_id: None,
            name: name.into(),
            img: None,
            initiative: init,
            hidden: false,
            defeated: false,
        }
    }

    fn world_with_combat() -> World {
        let mut w = World::new("T", "freeform");
        let scene_id = w.active_scene.clone().unwrap();
        w.apply(&Op::CombatCreate {
            combat: Combat {
                id: "c".into(),
                scene_id,
                round: 0,
                current: None,
                combatants: vec![cb("a", "Ann", Some(12.0)), cb("b", "Bo", Some(18.0)), cb("c", "Cy", None), cb("d", "Di", Some(12.0))],
                flags: Value::Null,
            },
        })
        .unwrap();
        w
    }

    fn turn(w: &World) -> (u32, Option<String>) {
        let c = w.combat.as_ref().unwrap();
        (c.round, c.current.clone())
    }

    #[test]
    fn order_by_initiative_then_name_unrolled_last() {
        let w = world_with_combat();
        let names: Vec<_> = w.combat.as_ref().unwrap().order().iter().map(|c| c.name.clone()).collect();
        assert_eq!(names, ["Bo", "Ann", "Di", "Cy"]);
    }

    #[test]
    fn turns_rounds_and_defeated() {
        let mut w = world_with_combat();
        w.apply(&Op::CombatStart).unwrap();
        assert_eq!(turn(&w), (1, Some("b".into())));
        w.apply(&Op::CombatNext).unwrap();
        assert_eq!(turn(&w), (1, Some("a".into())));
        // Di is defeated: skipped.
        w.apply(&Op::CombatantUpdate { id: "d".into(), patch: json!({"defeated": true}) }).unwrap();
        w.apply(&Op::CombatNext).unwrap();
        assert_eq!(turn(&w), (1, Some("c".into())));
        w.apply(&Op::CombatNext).unwrap();
        assert_eq!(turn(&w), (2, Some("b".into())), "wraps to a new round");
        w.apply(&Op::CombatPrev).unwrap();
        assert_eq!(turn(&w), (1, Some("c".into())), "back into the previous round");
    }

    #[test]
    fn removed_current_still_advances() {
        let mut w = world_with_combat();
        w.apply(&Op::CombatStart).unwrap();
        w.apply(&Op::CombatNext).unwrap(); // Ann
        let next = w.combat.as_ref().unwrap().next_turn();
        assert_eq!(next, (1, Some("d".into())));
        w.apply(&Op::CombatantRemove { id: "a".into() }).unwrap();
        // current now points at a missing combatant; next_turn restarts sensibly.
        assert_eq!(w.combat.as_ref().unwrap().next_turn().1, Some("b".into()));
    }

    #[test]
    fn deleting_token_or_scene_cleans_up() {
        let mut w = world_with_combat();
        let sid = w.active_scene.clone().unwrap();
        w.combat.as_mut().unwrap().combatants[0].token_id = Some("t1".into());
        w.scenes.get_mut(&sid).unwrap().tokens.insert(
            "t1".into(),
            serde_json::from_value(json!({"id": "t1", "name": "Ann", "x": 0, "y": 0})).unwrap(),
        );
        w.apply(&Op::TokenDelete { scene_id: sid.clone(), id: "t1".into() }).unwrap();
        assert!(w.combat.as_ref().unwrap().combatant("a").is_none());
        w.apply(&Op::SceneDelete { id: sid }).unwrap();
        assert!(w.combat.is_none());
    }
}

#[cfg(test)]
mod light_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn background_fit_is_set_changed_and_cleared() {
        let mut w = World::new("T", "freeform");
        let sid = w.active_scene.clone().unwrap();
        assert!(w.scenes[&sid].background_fit.is_none(), "a new scene stretches its map, as before");
        w.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"background_fit": {"x": -12.5, "y": 3, "sx": 0.71, "sy": 0.7}, "grid": {"size": 70}}) }).unwrap();
        let s = &w.scenes[&sid];
        assert_eq!(s.background_fit, Some(BackgroundFit { x: -12.5, y: 3.0, sx: 0.71, sy: 0.7 }));
        assert_eq!(s.grid.size, 70);
        w.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"background_fit": {"x": 0}}) }).unwrap();
        assert_eq!(w.scenes[&sid].background_fit.unwrap().x, 0.0, "a partial patch merges");
        w.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"background_fit": null}) }).unwrap();
        assert!(w.scenes[&sid].background_fit.is_none());
        // Saved worlds from before have no such field and load as before; it isn't written when unset.
        let json = serde_json::to_value(&w.scenes[&sid]).unwrap();
        assert!(json.get("background_fit").is_none());
    }

    #[test]
    fn lights_darkness_and_token_light() {
        let mut w = World::new("T", "freeform");
        let sid = w.active_scene.clone().unwrap();
        let l: Light = serde_json::from_value(json!({"id": "l1", "x": 70, "y": 70, "bright": 10, "dim": 20})).unwrap();
        w.apply(&Op::LightCreate { scene_id: sid.clone(), light: l }).unwrap();
        w.apply(&Op::LightUpdate { scene_id: sid.clone(), id: "l1".into(), patch: json!({"off": true, "color": "#ff8800"}) }).unwrap();
        assert!(w.scenes[&sid].lights["l1"].off);
        // Lights can't be replaced through a scene patch; darkness can be set.
        w.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"lights": {}, "darkness": 0.8}) }).unwrap();
        assert_eq!(w.scenes[&sid].lights.len(), 1);
        assert_eq!(w.scenes[&sid].darkness, 0.8);
        w.apply(&Op::LightDelete { scene_id: sid.clone(), id: "l1".into() }).unwrap();
        assert!(w.scenes[&sid].lights.is_empty());
        // A partial patch gives a token a light; null takes it away.
        let t: Token = serde_json::from_value(json!({"id": "t1", "name": "A", "x": 0, "y": 0})).unwrap();
        w.apply(&Op::TokenCreate { scene_id: sid.clone(), token: t }).unwrap();
        w.apply(&Op::TokenUpdate { scene_id: sid.clone(), id: "t1".into(), patch: json!({"light": {"dim": 40}, "sight": 60}) }).unwrap();
        let t = &w.scenes[&sid].tokens["t1"];
        assert_eq!((t.light.as_ref().unwrap().dim, t.sight), (40.0, 60.0));
        w.apply(&Op::TokenUpdate { scene_id: sid.clone(), id: "t1".into(), patch: json!({"light": null}) }).unwrap();
        assert!(w.scenes[&sid].tokens["t1"].light.is_none());
    }
}

#[cfg(test)]
mod drawing_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn drawings_lifecycle_and_author_is_protected() {
        let mut w = World::new("T", "freeform");
        let sid = w.active_scene.clone().unwrap();
        let d: Drawing = serde_json::from_value(json!({"id": "d1", "kind": "freehand", "author": "u1", "x": 10, "y": 20, "points": [[0, 0], [5, 5]]})).unwrap();
        assert_eq!(d.stroke_width, 4.0, "defaults fill in");
        w.apply(&Op::DrawingCreate { scene_id: sid.clone(), drawing: d }).unwrap();
        w.apply(&Op::DrawingUpdate { scene_id: sid.clone(), id: "d1".into(), patch: json!({"x": 99, "author": "thief", "stroke": "#fff"}) }).unwrap();
        let d = &w.scenes[&sid].drawings["d1"];
        assert_eq!((d.x, d.author.as_str(), d.stroke.as_str()), (99.0, "u1", "#fff"));
        // A scene patch can't overwrite drawings wholesale.
        w.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"drawings": {}}) }).unwrap();
        assert_eq!(w.scenes[&sid].drawings.len(), 1);
        w.apply(&Op::DrawingDelete { scene_id: sid.clone(), id: "d1".into() }).unwrap();
        assert!(w.scenes[&sid].drawings.is_empty());
    }
}

#[cfg(test)]
mod table_tests {
    use crate::model::{RollTable, TableResult};

    #[test]
    fn weights_decide_which_result_a_roll_picks() {
        let r = |text: &str, weight| TableResult { text: text.into(), weight };
        let t = RollTable {
            id: "t".into(), name: "t".into(), folder: String::new(), description: String::new(),
            results: vec![r("rat", 3), r("never", 0), r("wolf", 2), r("dragon", 1)],
            access: Default::default(), players: Default::default(),
        };
        assert_eq!(t.total_weight(), 6);
        let picks: Vec<_> = (1..=6).map(|n| t.pick(n).unwrap().text.as_str()).collect();
        assert_eq!(picks, ["rat", "rat", "rat", "wolf", "wolf", "dragon"]);
        assert!(t.pick(7).is_none());
    }
}

#[cfg(test)]
mod sound_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ambient_sounds_and_playlists() {
        let mut w = World::new("T", "freeform");
        let sid = w.active_scene.clone().unwrap();
        let s: AmbientSound = serde_json::from_value(json!({"id": "s1", "x": 0, "y": 0, "radius": 30, "src": "/assets/rain.ogg"})).unwrap();
        assert!(s.walls && s.volume == 1.0, "defaults: muffled by walls, full volume");
        w.apply(&Op::SoundCreate { scene_id: sid.clone(), sound: s }).unwrap();
        w.apply(&Op::SceneUpdate { id: sid.clone(), patch: json!({"sounds": {}}) }).unwrap();
        assert_eq!(w.scenes[&sid].sounds.len(), 1, "scene patches can't wipe sounds");
        w.apply(&Op::SoundUpdate { scene_id: sid.clone(), id: "s1".into(), patch: json!({"off": true}) }).unwrap();
        assert!(w.scenes[&sid].sounds["s1"].off);

        let p: Playlist = serde_json::from_value(json!({"id": "p1", "name": "Tavern", "sounds": {
            "a": {"id": "a", "name": "Lute", "src": "/assets/lute.mp3"}
        }})).unwrap();
        w.apply(&Op::PlaylistCreate { playlist: p }).unwrap();
        // Add a track and start the first through merge patches.
        w.apply(&Op::PlaylistUpdate { id: "p1".into(), patch: json!({"sounds": {
            "b": {"id": "b", "name": "Crowd", "src": "/assets/crowd.ogg", "sort": 1},
            "a": {"playing": true, "started": 1234}
        }}) }).unwrap();
        let pl = &w.playlists["p1"];
        assert_eq!(pl.sounds.len(), 2);
        assert!(pl.sounds["a"].playing && pl.sounds["a"].started == 1234);
        // Removing a track.
        w.apply(&Op::PlaylistUpdate { id: "p1".into(), patch: json!({"sounds": {"b": null}}) }).unwrap();
        assert_eq!(w.playlists["p1"].sounds.len(), 1);
    }
}

#[cfg(test)]
mod collection_tests {
    use crate::model::*;
    use serde_json::json;

    #[test]
    fn limited_collections_hide_their_entries() {
        let c: Collection = serde_json::from_value(json!({
            "id": "c", "name": "Spells", "kind": "item", "access": "limited",
            "entries": { "e1": { "name": "Fireball", "kind": "spell" } }
        })).unwrap();
        let mut w = World::new("T", "freeform");
        w.collections.insert("c".into(), c);
        let p = User { id: "p".into(), name: "P".into(), role: Role::Player, color: "#fff".into() };
        let v = w.view_for(&p);
        assert!(v.collections["c"].entries.is_empty());
        w.collections.get_mut("c").unwrap().access = Access::None;
        assert!(w.view_for(&p).collections.is_empty());
    }
}
