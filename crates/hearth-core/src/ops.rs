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

impl World {
    /// Apply an op. On error the world is unchanged.
    pub fn apply(&mut self, op: &Op) -> Result<(), OpError> {
        match op {
            Op::WorldUpdate { patch } => {
                patch_entity(self, patch, &["system", "scenes", "actors", "users", "chat", "active_scene"])?
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
