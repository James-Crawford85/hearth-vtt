//! WebSocket messages. JSON, tagged by `type`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{Id, Role, User, World};
use crate::ops::Op;

/// How a connection proves who it is. Exactly one way is used, checked in
/// this order: `session` (rejoin after a reload), `key` + `name` (the GM key),
/// `user_id` + `password` (a player account set up by the GM).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JoinRequest {
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub user_id: Option<Id>,
    #[serde(default)]
    pub password: Option<String>,
}

/// GM-only account management.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum UserAdmin {
    /// `password` may be empty: the player then picks one on first login.
    Create { name: String, #[serde(default)] role: Role, #[serde(default)] password: String },
    Update {
        id: Id,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        role: Option<Role>,
        #[serde(default)]
        color: Option<String>,
    },
    /// Set a temporary password; the player must change it on next login.
    ResetPassword { id: Id, password: String },
    Delete { id: Id },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Must be the first message.
    Join(JoinRequest),
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
    /// Change your own password. `current` is not needed right after a
    /// temporary password was used to log in.
    SetPassword { #[serde(default)] current: Option<String>, new: String },
    /// GM-only: manage player accounts.
    Admin(UserAdmin),
    /// End this session; the token stops working.
    Logout,
    /// Roll initiative for these combatants (GM: any; players: their own).
    RollInitiative { ids: Vec<Id> },
    /// Roll on a rollable table; the result goes to chat.
    DrawTable { id: Id, #[serde(default)] gm_only: bool },
    /// Areas this player has now seen on a scene (merged into their fog map).
    Explore { scene_id: Id, fog: crate::model::FogMap },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome {
        user: User,
        world: World,
        packages: Value,
        online: Vec<Id>,
        /// Store this (per tab) to rejoin after a reload without the password.
        session: String,
        /// The client must ask for a new password before play continues.
        must_change_password: bool,
    },
    Applied { op: Op, by: Option<Id> },
    Rejected { req: Option<u64>, reason: String },
    Presence { online: Vec<Id> },
    Emit { from: Id, channel: String, payload: Value },
    /// Something worth telling the user (e.g. "Password reset for Robin").
    Notice { message: String },
    PasswordChanged,
    Error { message: String },
}
