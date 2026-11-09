//! WebSocket messages. JSON, tagged by `type`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{Id, User, World};
use crate::ops::Op;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Must be the first message. `key` is the GM key; omit to join as a player.
    Join { name: String, #[serde(default)] key: Option<String> },
    /// Request a world change. `req` is echoed back in `rejected` on failure.
    Op { op: Op, #[serde(default)] req: Option<u64> },
    /// Chat text. Supports `/r <formula>`, `/gmr <formula>` and `/w <name> <text>`.
    Chat { content: String, #[serde(default)] speaker_actor: Option<Id> },
    /// A server-side roll. `@paths` resolve against the actor's derived and data values.
    Roll {
        formula: String,
        #[serde(default)]
        flavor: Option<String>,
        #[serde(default)]
        actor_id: Option<Id>,
        #[serde(default)]
        gm_only: bool,
    },
    /// Relay an arbitrary message for modules. `to` limits recipients (user ids).
    Emit { channel: String, payload: Value, #[serde(default)] to: Option<Vec<Id>> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome { user: User, world: World, packages: Value, online: Vec<Id> },
    Applied { op: Op, by: Option<Id> },
    Rejected { req: Option<u64>, reason: String },
    Presence { online: Vec<Id> },
    Emit { from: Id, channel: String, payload: Value },
    Error { message: String },
}
