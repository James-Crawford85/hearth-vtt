//! Documents that each player sees differently: journal entries, library
//! items, rollable tables and macros. The server uses this to send every
//! player only their own view of a change (see `hearth-server`'s commit).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::model::*;
use crate::ops::Op;
use crate::Id;

/// Documents with GM-set access levels (`access` for all players, `players` per player).
pub trait Shared: Clone {
    fn base_access(&self) -> Access;
    fn player_access(&self) -> &BTreeMap<Id, Access>;
    /// What a player with `limited` access receives.
    fn limited(&self) -> Self;

    fn access_for(&self, user: &User) -> Access {
        if user.role == Role::Gm {
            return Access::Owner;
        }
        self.base_access().max(self.player_access().get(&user.id).copied().unwrap_or_default())
    }

    /// The document as this user may see it, or `None` if they can't.
    fn view_for(&self, user: &User) -> Option<Self> {
        match self.access_for(user) {
            Access::None => None,
            Access::Limited => Some(self.limited()),
            _ => Some(self.clone()),
        }
    }
}

impl Shared for JournalEntry {
    fn base_access(&self) -> Access { self.access }
    fn player_access(&self) -> &BTreeMap<Id, Access> { &self.players }
    fn limited(&self) -> Self { JournalEntry { content: String::new(), ..self.clone() } }
}

impl Shared for LibraryItem {
    fn base_access(&self) -> Access { self.access }
    fn player_access(&self) -> &BTreeMap<Id, Access> { &self.players }
    fn limited(&self) -> Self {
        let mut x = self.clone();
        x.item.data = Value::Null;
        x.item.flags = Value::Null;
        x
    }
}

impl Shared for RollTable {
    fn base_access(&self) -> Access { self.access }
    fn player_access(&self) -> &BTreeMap<Id, Access> { &self.players }
    fn limited(&self) -> Self { RollTable { results: vec![], description: String::new(), ..self.clone() } }
}

impl Shared for Collection {
    fn base_access(&self) -> Access { self.access }
    fn player_access(&self) -> &BTreeMap<Id, Access> { &self.players }
    fn limited(&self) -> Self { Collection { entries: BTreeMap::new(), ..self.clone() } }
}

impl Macro {
    /// Players see their own macros and the ones the GM shares.
    pub fn visible_to(&self, user: &User) -> bool {
        user.role == Role::Gm || self.shared || self.author == user.id
    }
}

/// Which kind of per-player document an op touches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scoped {
    Journal,
    Item,
    Table,
    Macro,
    Collection,
}

impl Op {
    /// The per-player document this op creates, changes or removes.
    pub fn scoped(&self) -> Option<(Scoped, &str)> {
        Some(match self {
            Op::JournalCreate { entry } => (Scoped::Journal, &entry.id),
            Op::JournalUpdate { id, .. } | Op::JournalDelete { id } => (Scoped::Journal, id),
            Op::LibraryItemCreate { item } => (Scoped::Item, &item.item.id),
            Op::LibraryItemUpdate { id, .. } | Op::LibraryItemDelete { id } => (Scoped::Item, id),
            Op::TableCreate { table } => (Scoped::Table, &table.id),
            Op::TableUpdate { id, .. } | Op::TableDelete { id } => (Scoped::Table, id),
            Op::MacroCreate { r#macro } => (Scoped::Macro, &r#macro.id),
            Op::MacroUpdate { id, .. } | Op::MacroDelete { id } => (Scoped::Macro, id),
            Op::CollectionCreate { collection } => (Scoped::Collection, &collection.id),
            Op::CollectionUpdate { id, .. } | Op::CollectionDelete { id } => (Scoped::Collection, id),
            _ => return None,
        })
    }

    pub fn is_scoped_update(&self) -> bool {
        matches!(self, Op::JournalUpdate { .. } | Op::LibraryItemUpdate { .. } | Op::TableUpdate { .. } | Op::MacroUpdate { .. } | Op::CollectionUpdate { .. })
    }
}

impl Scoped {
    /// An op that adds (or replaces) this document on a client.
    pub fn create_op(self, doc: Value) -> Option<Op> {
        Some(match self {
            Scoped::Journal => Op::JournalCreate { entry: serde_json::from_value(doc).ok()? },
            Scoped::Item => Op::LibraryItemCreate { item: serde_json::from_value(doc).ok()? },
            Scoped::Table => Op::TableCreate { table: serde_json::from_value(doc).ok()? },
            Scoped::Macro => Op::MacroCreate { r#macro: serde_json::from_value(doc).ok()? },
            Scoped::Collection => Op::CollectionCreate { collection: serde_json::from_value(doc).ok()? },
        })
    }

    pub fn delete_op(self, id: &str) -> Op {
        let id = id.to_string();
        match self {
            Scoped::Journal => Op::JournalDelete { id },
            Scoped::Item => Op::LibraryItemDelete { id },
            Scoped::Table => Op::TableDelete { id },
            Scoped::Macro => Op::MacroDelete { id },
            Scoped::Collection => Op::CollectionDelete { id },
        }
    }
}

impl World {
    /// The whole document, as the GM sees it.
    pub fn scoped_full(&self, kind: Scoped, id: &str) -> Option<Value> {
        match kind {
            Scoped::Journal => self.journal.get(id).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Item => self.items.get(id).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Table => self.tables.get(id).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Macro => self.macros.get(id).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Collection => self.collections.get(id).and_then(|x| serde_json::to_value(x).ok()),
        }
    }

    /// The document as this user may see it.
    pub fn scoped_view(&self, kind: Scoped, id: &str, user: &User) -> Option<Value> {
        match kind {
            Scoped::Journal => self.journal.get(id)?.view_for(user).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Item => self.items.get(id)?.view_for(user).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Table => self.tables.get(id)?.view_for(user).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Collection => self.collections.get(id)?.view_for(user).and_then(|x| serde_json::to_value(x).ok()),
            Scoped::Macro => {
                let m = self.macros.get(id)?;
                m.visible_to(user).then(|| serde_json::to_value(m).ok()).flatten()
            }
        }
    }
}
