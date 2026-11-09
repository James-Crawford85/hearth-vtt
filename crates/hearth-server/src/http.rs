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

pub async fn info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let w = state.world.read().await;
    Json(json!({
        "name": "hearth",
        "version": env!("CARGO_PKG_VERSION"),
        "world": w.name,
        "description": w.description,
        "system": w.system,
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

/// `POST /api/upload` (multipart field `file`, header `x-hearth-key`: GM key).
/// Returns `{ "url": "/assets/<name>" }`.
pub async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    mut form: Multipart,
) -> Result<Json<Value>, (StatusCode, String)> {
    let key = headers.get("x-hearth-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !state.check_gm_key(key) {
        return Err((StatusCode::FORBIDDEN, "GM key required".into()));
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
