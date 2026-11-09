//! Player passwords, kept apart from the world document so they can never be
//! sent to clients. Stored as Argon2 hashes in `<world>/credentials.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use hearth_core::Id;
use serde::{Deserialize, Serialize};

pub const FILE: &str = "credentials.json";
/// Minimum length for a password a player chooses.
pub const MIN_LEN: usize = 6;
/// Minimum length for a temporary password set by the GM.
pub const MIN_TEMP_LEN: usize = 4;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Credential {
    /// Argon2 PHC string; `None` = no password set yet.
    #[serde(default)]
    pub hash: Option<String>,
    /// The player must choose a new password on next login.
    #[serde(default)]
    pub must_change: bool,
}

#[derive(Debug)]
pub struct Credentials {
    path: PathBuf,
    map: HashMap<Id, Credential>,
}

pub fn hash(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string()).map_err(|e| e.to_string())
}

/// Constant-time check of a password against a stored hash. Slow on purpose:
/// call from a blocking thread.
pub fn verify(stored: &str, password: &str) -> bool {
    PasswordHash::new(stored).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

impl Credentials {
    pub fn load(world_dir: &Path) -> Credentials {
        let path = world_dir.join(FILE);
        let map = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Credentials { path, map }
    }

    fn save(&self) -> Result<(), String> {
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.map).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Credential {
        self.map.get(id).cloned().unwrap_or_default()
    }

    /// Store an already-hashed password.
    pub fn set(&mut self, id: &str, hash: Option<String>, must_change: bool) -> Result<(), String> {
        self.map.insert(id.to_string(), Credential { hash, must_change });
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if self.map.remove(id).is_some() {
            self.save()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash("correct horse").unwrap();
        assert!(h.starts_with("$argon2"));
        assert!(verify(&h, "correct horse"));
        assert!(!verify(&h, "wrong"));
        assert!(!verify("not a hash", "correct horse"));
    }

    #[test]
    fn persists() {
        let dir = std::env::temp_dir().join(format!("hearth-cred-{}", hearth_core::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = Credentials::load(&dir);
        c.set("u1", Some(hash("pw1234").unwrap()), true).unwrap();
        let c2 = Credentials::load(&dir);
        assert!(c2.get("u1").must_change);
        assert!(verify(c2.get("u1").hash.as_deref().unwrap(), "pw1234"));
        assert!(c2.get("nobody").hash.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
