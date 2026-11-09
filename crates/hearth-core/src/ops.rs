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

    ActorCreate { actor: Actor },
    ActorUpdate { id: Id, patch: Value },
    ActorDelete { id: Id },
    /// Server-only: replaces an actor's derived data after scripts run.
    ActorDerive { id: Id, derived: Value },

    ItemCreate { actor_id: Id, item: Item },
    ItemUpdate { actor_id: Id, id: Id, patch: Value },
    ItemDelete { actor_id: Id, id: Id },

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
        matches!(self, Op::ActorDerive { .. } | Op::UserUpsert { .. } | Op::UserDelete { .. } | Op::ChatCreate { .. })
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
                patch_entity(self, patch, &["system", "scenes", "actors", "users", "chat", "active_scene", "combat"])?
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
            Op::SceneUpdate { id, patch } => patch_entity(scene_mut(self, id)?, patch, &["tokens"])?,
            Op::SceneDelete { id } => {
                self.scenes.remove(id).ok_or_else(|| OpError::NotFound("scene", id.clone()))?;
                if self.active_scene.as_deref() == Some(id) {
                    self.active_scene = self.scenes.keys().next().cloned();
                }
                if self.combat.as_ref().is_some_and(|c| &c.scene_id == id) {
                    self.combat = None;
                }
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
