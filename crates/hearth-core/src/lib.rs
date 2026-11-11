//! Hearth core: the world document model, the operations that mutate it,
//! and the messages exchanged between server and clients.
//!
//! Everything that changes a world goes through an [`Op`]. The server applies
//! ops authoritatively and re-broadcasts them; clients apply the same ops to
//! their local mirror. Systems and modules never need new op types — they
//! store their data in the free-form `data` / `flags` JSON of entities.

pub mod advance;
pub mod formula;
pub mod geometry;
pub mod model;
pub mod ops;
pub mod creation;
pub mod patch;
pub mod protocol;
pub mod rules;
pub mod scoped;

pub use model::*;
pub use ops::{Op, OpError};
pub use protocol::{ClientMsg, ServerMsg};
pub use scoped::{Scoped, Shared};

/// Generate a short random id (12 hex chars).
pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}
