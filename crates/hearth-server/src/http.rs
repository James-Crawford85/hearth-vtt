use std::sync::Arc;

use axum::extract::{Multipart, Path, Request, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::state::AppState;

const ALLOWED_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif", "mp3", "ogg", "oga", "opus", "m4a", "flac", "wav", "webm", "mp4"];

/// Public information shown on the join page (no secrets: names, roles and
/// colours of accounts, world description, who's online).
pub async fn info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let w = state.world.read().await;
    let online: std::collections::HashSet<_> = state.online_ids().into_iter().collect();
    let mut users: Vec<&hearth_core::User> = w.users.values().collect();
    users.sort_by(|a, b| (a.role != hearth_core::Role::Gm, a.name.to_lowercase()).cmp(&(b.role != hearth_core::Role::Gm, b.name.to_lowercase())));
    let players: Vec<_> = users.iter().filter(|u| u.role != hearth_core::Role::Gm).collect();
    let system_name = state.registry().get(&w.system).map(|p| p.manifest.name.clone()).unwrap_or_else(|| w.system.clone());
    Json(json!({
        "name": "hearth",
        "version": env!("CARGO_PKG_VERSION"),
        "world": w.name,
        "description": w.description,
        "next_session": w.next_session,
        "system": w.system,
        "system_name": system_name,
        "users": users.iter().map(|u| json!({
            "id": u.id, "name": u.name, "role": u.role, "color": u.color, "online": online.contains(&u.id),
        })).collect::<Vec<_>>(),
        "players_online": players.iter().filter(|u| online.contains(&u.id)).count(),
        "players_total": players.len(),
    }))
}

/// `GET /packages/<id>/<path>`: serve a file from whichever folder the
/// package was loaded from. ServeDir rejects `..` and absolute paths.
pub async fn package_file(
    State(state): State<Arc<AppState>>,
    Path((id, path)): Path<(String, String)>,
    mut req: Request,
) -> Response {
    let reg = state.registry();
    let Some(pkg) = reg.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Pack files go through /api/collections, which checks who may read them.
    let decoded = percent_decode(&path);
    if pkg.is_pack_file(&decoded) || pkg.is_pack_file(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(uri) = format!("/{path}").parse::<Uri>() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    *req.uri_mut() = uri;
    match ServeDir::new(&pkg.dir).oneshot(req).await {
        Ok(res) => res.into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

fn sanitize(name: &str) -> Option<(String, String)> {
    let (stem, ext) = name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        return None;
    }
    let stem: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(60)
        .collect();
    let stem = if stem.trim_matches('-').is_empty() { "file".to_string() } else { stem };
    Some((stem, ext))
}

/// `POST /api/upload` (multipart field `file`). GM only: send either header
/// `x-hearth-session` (a GM's session token) or `x-hearth-key` (the GM key).
/// Returns `{ "url": "/assets/<name>" }`.
pub async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut form: Multipart,
) -> Result<Json<Value>, (StatusCode, String)> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let by_session = match header("x-hearth-session") {
        s if s.is_empty() => false,
        s => state.session_user(&s).await.is_some_and(|u| u.role == hearth_core::Role::Gm),
    };
    if !by_session && !state.check_gm_key(&header("x-hearth-key")) {
        return Err((StatusCode::FORBIDDEN, "Only a GM can upload files".into()));
    }
    while let Some(field) = form.next_field().await.map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))? {
        if field.name() != Some("file") {
            continue;
        }
        let original = field.file_name().unwrap_or("upload").to_string();
        let (stem, ext) =
            sanitize(&original).ok_or((StatusCode::UNSUPPORTED_MEDIA_TYPE, "file type not allowed".into()))?;
        let bytes = field.bytes().await.map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
        let name = format!("{stem}-{}.{ext}", &hearth_core::new_id()[..6]);
        let path = state.world_dir.join("assets").join(&name);
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        tracing::info!(file = %name, bytes = bytes.len(), "asset uploaded");
        return Ok(Json(json!({ "url": format!("/assets/{name}") })));
    }
    Err((StatusCode::BAD_REQUEST, "missing 'file' field".into()))
}

/// Minimal %XX decoding, so `packs%2Fx.json` can't sneak past the pack check.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `POST /api/advance/plan` `{ actor_id, item_id?, add? }`: what a level up (or adding a
/// class, ancestry…) will ask for, worked out on the server: the level, the total level,
/// the character's own grants at that total, and points grants' amounts and caps.
pub async fn advance_plan(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let token = headers.get("x-hearth-session").and_then(|v| v.to_str().ok()).unwrap_or("");
    let user = state.session_user(token).await.ok_or((StatusCode::UNAUTHORIZED, "Join the game first".into()))?;
    let actor_id = body.get("actor_id").and_then(Value::as_str).unwrap_or_default();
    let world = state.world.read().await;
    let actor = world.actors.get(actor_id).ok_or((StatusCode::NOT_FOUND, "No such actor".into()))?;
    if !world.owns_actor(&user, actor_id) {
        return Err((StatusCode::FORBIDDEN, "You can only level up characters you own".into()));
    }
    let add: Option<hearth_core::Item> = match body.get("add").filter(|v| !v.is_null()) {
        Some(v) => Some(serde_json::from_value(v.clone()).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?),
        None => None,
    };
    let item_id = body.get("item_id").and_then(Value::as_str);
    hearth_core::advance::plan(actor, &state.rules(), item_id, add.as_ref()).map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// `POST /api/forge/preview` `{ actor_id?, item, candidates? }`: the item's price, the
/// rules it breaks, which candidate parts fit, and crafting numbers for the actor.
pub async fn forge_preview(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let user = session_of(&state, &headers).await?;
    state.forge_preview(&user, &body).await.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// `POST /api/forge/make` `{ actor_id?, item, mode: "create" | "craft" }`: make the item.
pub async fn forge_make(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Result<Json<Value>, (StatusCode, String)> {
    let user = session_of(&state, &headers).await?;
    state.forge_make(&user, &body).await.map(Json).map_err(|e| (StatusCode::BAD_REQUEST, e))
}

/// The user behind a request's `x-hearth-session` header, or an error.
async fn session_of(state: &AppState, headers: &HeaderMap) -> Result<hearth_core::User, (StatusCode, String)> {
    let token = headers.get("x-hearth-session").and_then(|v| v.to_str().ok()).unwrap_or("");
    state.session_user(token).await.ok_or((StatusCode::UNAUTHORIZED, "Join the game first".into()))
}

/// The GM behind a request's `x-hearth-session` header, or an error.
async fn gm_of(state: &AppState, headers: &HeaderMap) -> Result<hearth_core::User, (StatusCode, String)> {
    let token = headers.get("x-hearth-session").and_then(|v| v.to_str().ok()).unwrap_or("");
    let user = state.session_user(token).await.ok_or((StatusCode::UNAUTHORIZED, "Join the game first".into()))?;
    if user.role != hearth_core::Role::Gm {
        return Err((StatusCode::FORBIDDEN, "Only the GM can edit the system".into()));
    }
    Ok(user)
}

/// `GET /api/builder` (GM): the world's system as the builder sees it.
pub async fn builder_get(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<Value>, (StatusCode, String)> {
    gm_of(&state, &headers).await?;
    let system = state.world.read().await.system.clone();
    let reg = state.registry();
    let pkg = reg.get(&system).ok_or((StatusCode::NOT_FOUND, "The world's system isn't installed".into()))?;
    let m = &pkg.manifest;
    // Types written by hand in hearth.toml (not from the builder), so the editor can mention them.
    let built: std::collections::HashSet<String> = pkg
        .blueprint
        .iter()
        .flat_map(|b| b.actor_types.iter().chain(&b.item_types).map(|n| n.key.clone()))
        .collect();
    let hand: Vec<String> = m.actor_types.keys().chain(m.item_types.keys()).filter(|k| !built.contains(*k)).cloned().collect();
    Ok(Json(json!({
        "package": m.id, "name": m.name, "version": m.version,
        "blueprint": pkg.blueprint.clone().unwrap_or_default(),
        "errors": pkg.blueprint_errors,
        "hand_written_types": hand,
        "has_script": m.server.script.is_some(),
    })))
}

/// `PUT /api/builder` (GM): save the builder's tree and reload the system live.
pub async fn builder_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(bp): Json<hearth_packages::builder::Blueprint>,
) -> Result<Json<Value>, (StatusCode, String)> {
    gm_of(&state, &headers).await?;
    let errors = hearth_packages::builder::compile(&bp).errors;
    let system = state.world.read().await.system.clone();
    let dir = state.registry().get(&system).map(|p| p.dir.clone()).ok_or((StatusCode::NOT_FOUND, "The world's system isn't installed".into()))?;
    let text = serde_json::to_string_pretty(&bp).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    if text.len() > 4 * 1024 * 1024 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "That system is too big".into()));
    }
    let file = dir.join(hearth_packages::builder::FILE);
    tokio::fs::write(&file, text).await.map_err(|e| {
        (StatusCode::FORBIDDEN, format!("Couldn't save to {}: {e}. Systems that came with Hearth can't be changed: in the launcher, open Game Systems and use Copy to edit, then make a world with the copy.", file.display()))
    })?;
    tracing::info!(system = %system, "system builder saved");
    state.reload_system().await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(json!({ "saved": true, "errors": errors })))
}

/// `PUT /api/builder/sheet` (GM): save a hand-made HTML sheet for a type as
/// `sheets/<type>.html` in the world's system folder. Returns its path.
pub async fn builder_sheet_put(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    gm_of(&state, &headers).await?;
    let kind = body.get("type").and_then(Value::as_str).unwrap_or_default();
    let html = body.get("html").and_then(Value::as_str).unwrap_or_default();
    if !hearth_packages::builder::valid_key(kind) {
        return Err((StatusCode::BAD_REQUEST, "That isn't a type key".into()));
    }
    if html.len() > 512 * 1024 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "That sheet is too big".into()));
    }
    let system = state.world.read().await.system.clone();
    let dir = state.registry().get(&system).map(|p| p.dir.clone()).ok_or((StatusCode::NOT_FOUND, "The world's system isn't installed".into()))?;
    // Item types get their own names, so an item type and an actor type can share a key.
    let item = body.get("item").and_then(Value::as_bool).unwrap_or(false);
    let name = if item { format!("item-{kind}.html") } else { format!("{kind}.html") };
    let rel = format!("sheets/{name}");
    let file = dir.join("sheets").join(&name);
    tokio::fs::create_dir_all(dir.join("sheets")).await.map_err(|e| (StatusCode::FORBIDDEN, e.to_string()))?;
    tokio::fs::write(&file, html).await.map_err(|e| (StatusCode::FORBIDDEN, format!("Couldn't save {}: {e}", file.display())))?;
    Ok(Json(json!({ "path": rel })))
}

/// `PUT /api/collections/{package}/{pack}` with `{ "doc": {…} }` (GM): add a document
/// to one of the world system's own collections, or replace the one with the same
/// name and type. Added documents are marked `flags.core.user_added`, so tools that
/// regenerate a system can keep them. Everyone's clients reload the system after.
pub async fn collection_put(
    State(state): State<Arc<AppState>>,
    Path((pkg_id, pack_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, String)> {
    gm_of(&state, &headers).await?;
    let system = state.world.read().await.system.clone();
    if pkg_id != system {
        return Err((StatusCode::FORBIDDEN, "Only the world's own system's collections can be changed here".into()));
    }
    let mut doc = body.get("doc").cloned().filter(Value::is_object).ok_or((StatusCode::BAD_REQUEST, "Send { \"doc\": {…} }".into()))?;
    let name = doc.get("name").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    if name.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "The document needs a name".into()));
    }
    let (file, pack_kind) = {
        let reg = state.registry();
        let pkg = reg.get(&pkg_id).ok_or((StatusCode::NOT_FOUND, "The world's system isn't installed".into()))?;
        let pack = pkg.pack(&pack_id).ok_or((StatusCode::NOT_FOUND, "No such collection".into()))?;
        if !hearth_packages::safe_relative_path(&pack.path) {
            return Err((StatusCode::FORBIDDEN, "Collection file outside its package".into()));
        }
        (pkg.dir.join(&pack.path), pack.kind.clone())
    };
    let kind = doc.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
    let text = match tokio::fs::read_to_string(&file).await {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "[]".into(),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    };
    let mut docs: Vec<Value> = serde_json::from_str(&text).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("The collection file isn't a JSON list: {e}")))?;
    // Same name (and, for items and actors, same type): replace it, keeping its id.
    let same = |d: &Value| {
        d.get("name").and_then(Value::as_str).is_some_and(|n| n.trim().eq_ignore_ascii_case(&name))
            && (kind.is_empty() || d.get("kind").and_then(Value::as_str).unwrap_or_default() == kind)
    };
    let replaced = docs.iter().position(same);
    let id = match replaced {
        Some(i) => docs[i].get("id").and_then(Value::as_str).map(String::from),
        None => None,
    }
    .unwrap_or_else(|| {
        let base: String = name.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        let taken = |id: &str| docs.iter().any(|d| d.get("id").and_then(Value::as_str) == Some(id));
        let mut id = format!("{}_user", base.trim_matches('_'));
        let mut n = 2;
        while taken(&id) {
            id = format!("{}_user{n}", base.trim_matches('_'));
            n += 1;
        }
        id
    });
    let o = doc.as_object_mut().unwrap();
    o.insert("id".into(), json!(id));
    for k in ["folder", "access", "players", "owners", "derived"] {
        o.remove(k);
    }
    let flags = o.entry("flags").or_insert_with(|| json!({}));
    if !flags.is_object() {
        *flags = json!({});
    }
    hearth_core::patch::merge_patch(flags, &json!({ "core": { "user_added": true } }));
    match replaced {
        Some(i) => docs[i] = doc,
        None => docs.push(doc),
    }
    let out = serde_json::to_string_pretty(&docs).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if out.len() as u64 > MAX_PACK_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "That collection would be too large".into()));
    }
    tokio::fs::write(&file, out + "\n").await.map_err(|e| (StatusCode::FORBIDDEN, format!("Couldn't save {}: {e}", file.display())))?;
    state.reload_system().await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    tracing::info!(pack = %pack_id, %name, replaced = replaced.is_some(), kind = %pack_kind, "added to a system collection");
    Ok(Json(json!({ "id": id, "replaced": replaced.is_some() })))
}

/// Largest pack file we'll send, in bytes.
const MAX_PACK_BYTES: u64 = 32 * 1024 * 1024;

/// `GET /api/collections/{package}/{pack}`: a package's content pack as a
/// JSON array. Needs `x-hearth-session`; players only get packs marked public,
/// and only from packages active in this world.
pub async fn collection(
    State(state): State<Arc<AppState>>,
    Path((pkg_id, pack_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    let token = headers.get("x-hearth-session").and_then(|v| v.to_str().ok()).unwrap_or("");
    let user = state.session_user(token).await.ok_or((StatusCode::UNAUTHORIZED, "Join the game first".into()))?;
    let active = {
        let world = state.world.read().await;
        state.registry().active(&world.system, &world.modules, world.theme.as_deref()).iter().any(|p| p.manifest.id == pkg_id)
    };
    let reg = state.registry();
    let pkg = reg.get(&pkg_id).filter(|_| active).ok_or((StatusCode::NOT_FOUND, "No such package in this world".into()))?;
    let pack = pkg.pack(&pack_id).ok_or((StatusCode::NOT_FOUND, "No such collection".into()))?;
    if !pack.public && user.role != hearth_core::Role::Gm {
        return Err((StatusCode::FORBIDDEN, "Only the GM can open that collection".into()));
    }
    let path = pkg.dir.join(&pack.path);
    // Stay inside the package folder.
    let dir = pkg.dir.canonicalize().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let file = path.canonicalize().map_err(|_| (StatusCode::NOT_FOUND, "Collection file missing".into()))?;
    if !file.starts_with(&dir) {
        return Err((StatusCode::FORBIDDEN, "Collection file outside its package".into()));
    }
    let meta = tokio::fs::metadata(&file).await.map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    if meta.len() > MAX_PACK_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "Collection file too large".into()));
    }
    let text = tokio::fs::read_to_string(&file).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let docs: Value = serde_json::from_str(&text).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{}: {e}", pack.path)))?;
    if !docs.is_array() {
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("{} should be a JSON array", pack.path)));
    }
    let mut res = Json(docs).into_response();
    res.headers_mut().insert("cache-control", "no-store".parse().unwrap());
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::{percent_decode, sanitize};

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("packs%2Fbeasts.json"), "packs/beasts.json");
        assert_eq!(percent_decode("a%zz"), "a%zz");
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize("My Map.PNG"), Some(("My-Map".into(), "png".into())));
        assert_eq!(sanitize("../../evil.png"), Some(("------evil".into(), "png".into())));
        assert_eq!(sanitize("x.svg"), None);
        assert_eq!(sanitize("noext"), None);
    }
}
