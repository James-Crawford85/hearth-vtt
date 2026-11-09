use std::sync::Arc;

use axum::extract::{Multipart, Path, Request, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::state::AppState;

const ALLOWED_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif", "mp3", "ogg", "wav", "webm", "mp4"];

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

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize("My Map.PNG"), Some(("My-Map".into(), "png".into())));
        assert_eq!(sanitize("../../evil.png"), Some(("------evil".into(), "png".into())));
        assert_eq!(sanitize("x.svg"), None);
        assert_eq!(sanitize("noext"), None);
    }
}
