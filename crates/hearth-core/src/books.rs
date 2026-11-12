//! Books a world leaves out. A system's content can name the book it comes from in its
//! `data.source` field ("Advanced Player's Guide"); the GM can switch books off for a world
//! (`settings.core.books.off`, a list of book names). Players aren't offered anything from a
//! book that's off: collections leave it out and a level up can't pick it. The GM still sees
//! everything. Content without a book is always on.

use serde_json::Value;

use crate::advance::AdvanceRequest;

/// The books switched off in a world, from its settings.
pub fn off(settings: &Value) -> Vec<String> {
    settings
        .pointer("/core/books/off")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

/// The book a document's data names, if any.
pub fn source_of(data: &Value) -> Option<&str> {
    data.get("source").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// Whether a document (its `data`) comes from a book that's off.
pub fn is_off(data: &Value, off: &[String]) -> bool {
    source_of(data).is_some_and(|s| off.iter().any(|o| o.eq_ignore_ascii_case(s)))
}

/// A collection without the documents from books that are off.
pub fn filter_docs(docs: &mut Vec<Value>, off: &[String]) {
    if !off.is_empty() {
        docs.retain(|d| !is_off(d.get("data").unwrap_or(&Value::Null), off));
    }
}

/// Why a level up can't go ahead: it adds or picks something from a book that's off.
pub fn check_advance(req: &AdvanceRequest, off: &[String]) -> Result<(), String> {
    if off.is_empty() {
        return Ok(());
    }
    let items = req.add.iter().chain(req.picks.values().flatten());
    for it in items {
        if is_off(&it.data, off) {
            let book = source_of(&it.data).unwrap_or_default();
            return Err(format!("{} is from {book}, which isn't used in this world", it.name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Item;
    use serde_json::json;

    fn item(name: &str, source: &str) -> Item {
        serde_json::from_value(json!({ "id": name, "name": name, "kind": "feat", "data": { "source": source } })).unwrap()
    }

    #[test]
    fn books_that_are_off_are_left_out() {
        let settings = json!({ "core": { "books": { "off": ["Mythic Adventures", " "] } } });
        let off = off(&settings);
        assert_eq!(off, vec!["Mythic Adventures".to_string()]);
        let mut docs = vec![
            json!({ "name": "Power Attack", "data": { "source": "Core Rulebook" } }),
            json!({ "name": "Power Attack (Mythic)", "data": { "source": "mythic adventures" } }),
            json!({ "name": "Homebrew", "data": {} }),
        ];
        filter_docs(&mut docs, &off);
        let names: Vec<_> = docs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Power Attack", "Homebrew"], "no book named: always on");
        // A level up can't pick from it, or add it.
        let mut req = AdvanceRequest::default();
        req.picks.insert("feat".into(), vec![item("Dodge", "Core Rulebook")]);
        assert!(check_advance(&req, &off).is_ok());
        req.picks.insert("feat".into(), vec![item("Power Attack (Mythic)", "Mythic Adventures")]);
        assert!(check_advance(&req, &off).unwrap_err().contains("isn't used in this world"));
        let req = AdvanceRequest { add: Some(item("Champion", "Mythic Adventures")), ..Default::default() };
        assert!(check_advance(&req, &off).is_err());
        assert!(check_advance(&req, &[]).is_ok(), "nothing off: anything goes");
    }
}
