//! JSON merge patch (RFC 7386) applied to typed entities.

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};

/// Apply `patch` onto `target`. `null` in the patch deletes a key.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(p) => {
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            let t = target.as_object_mut().unwrap();
            for (k, v) in p {
                if v.is_null() {
                    t.remove(k);
                } else {
                    merge_patch(t.entry(k.clone()).or_insert(Value::Null), v);
                }
            }
        }
        other => *target = other.clone(),
    }
}

/// Patch a typed entity. Keys listed in `protected` (always including `id`)
/// are ignored so that patches can't change identity or nested collections
/// that have their own ops.
pub fn patch_entity<T: Serialize + DeserializeOwned>(
    entity: &mut T,
    patch: &Value,
    protected: &[&str],
) -> Result<(), serde_json::Error> {
    let Value::Object(p) = patch else {
        return Ok(());
    };
    let mut p = p.clone();
    p.remove("id");
    for k in protected {
        p.remove(*k);
    }
    let mut v = serde_json::to_value(&*entity)?;
    merge_patch(&mut v, &Value::Object(p));
    *entity = serde_json::from_value(v)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rfc7386_basics() {
        let mut t = json!({"a": 1, "b": {"c": 2, "d": 3}});
        merge_patch(&mut t, &json!({"a": 5, "b": {"c": null, "e": 4}, "f": [1]}));
        assert_eq!(t, json!({"a": 5, "b": {"d": 3, "e": 4}, "f": [1]}));
    }
}
