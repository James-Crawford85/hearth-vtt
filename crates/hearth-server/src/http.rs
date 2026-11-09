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
    let system_name = state.registry.get(&w.system).map(|p| p.manifest.name.clone()).unwrap_or_else(|| w.system.clone());
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
    let Some(pkg) = state.registry.get(&id) else {
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
        state.registry.active(&world.system, &world.modules, world.theme.as_deref()).iter().any(|p| p.manifest.id == pkg_id)
    };
    let pkg = state.registry.get(&pkg_id).filter(|_| active).ok_or((StatusCode::NOT_FOUND, "No such package in this world".into()))?;
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
