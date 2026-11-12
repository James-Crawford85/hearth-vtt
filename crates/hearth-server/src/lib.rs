//! The Hearth server as a library, so it can run standalone (`hearth` binary)
//! or embedded inside the desktop app, which hosts a world in-process.

pub mod backups;
pub mod credentials;
mod fog;
mod http;
mod persist;
mod state;
pub mod worlds;
mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue};
use axum::routing::{get, post};
use axum::Router;
use hearth_packages::{PackageKind, Registry};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

use crate::state::AppState;

pub use hearth_packages;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// World folder. Created if it doesn't exist.
    pub world_dir: PathBuf,
    /// Package folders. Later folders override packages with the same id.
    pub package_dirs: Vec<PathBuf>,
    /// The web client folder.
    pub web_dir: PathBuf,
    /// Address to listen on, e.g. `0.0.0.0` (LAN) or `127.0.0.1` (this machine only).
    pub host: String,
    /// 0 picks a free port.
    pub port: u16,
    /// System for a new world.
    pub new_world_system: String,
    /// Name for a new world (defaults to the folder name).
    pub new_world_name: Option<String>,
}

/// A running server. Call [`RunningServer::stop`] to shut it down and save.
pub struct RunningServer {
    pub addr: SocketAddr,
    pub gm_key: String,
    pub world_name: String,
    pub world_dir: PathBuf,
    state: Arc<AppState>,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<anyhow::Result<()>>,
}

impl RunningServer {
    /// Write the world to disk now (e.g. before taking a backup).
    pub async fn save(&self) -> anyhow::Result<()> {
        persist::save_now(&self.state).await
    }

    /// Stop accepting connections, save the world and wait for shutdown.
    pub async fn stop(mut self) -> anyhow::Result<()> {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.task.await.context("server task panicked")?
    }

    /// Resolves when the server exits on its own (e.g. a fatal error).
    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
    }
}

/// Load packages, open (or create) the world and start serving.
/// Must be called from inside a Tokio runtime.
pub async fn start(cfg: ServerConfig) -> anyhow::Result<RunningServer> {
    let (registry, errors) = Registry::load_all(&cfg.package_dirs);
    for e in errors {
        tracing::warn!("package skipped: {e}");
    }
    if registry.of_kind(PackageKind::System).next().is_none() {
        tracing::warn!("no game systems found in {:?}", cfg.package_dirs);
    }

    let world = persist::load_or_create(&cfg.world_dir, &cfg.new_world_system, cfg.new_world_name.as_deref())?;
    if registry.get(&world.system).is_none() {
        tracing::warn!("world uses system '{}' which is not installed", world.system);
    }
    let world_name = world.name.clone();
    let gm_key = persist::gm_key(&cfg.world_dir)?;
    let assets = cfg.world_dir.join("assets");
    std::fs::create_dir_all(&assets).context("creating assets folder")?;

    let state = Arc::new(AppState::new(world, registry, gm_key.clone(), cfg.world_dir.clone()));
    let autosave = tokio::spawn(persist::autosave(state.clone(), Duration::from_secs(2)));

    let app = Router::new()
        .route("/ws", get(ws::handler))
        .route("/api/info", get(http::info))
        .route("/api/upload", post(http::upload).layer(DefaultBodyLimit::max(64 * 1024 * 1024)))
        .route("/packages/{id}/{*path}", get(http::package_file))
        .route("/api/collections/{pkg}/{pack}", get(http::collection).put(http::collection_put))
        .route("/api/builder", get(http::builder_get).put(http::builder_put))
        .route("/api/builder/sheet", axum::routing::put(http::builder_sheet_put))
        .route("/api/advance/plan", post(http::advance_plan))
        .route("/api/books", get(http::books))
        .route("/api/forge/preview", post(http::forge_preview))
        .route("/api/forge/make", post(http::forge_make))
        // Uploaded files get unique names, so they can be cached for good.
        .nest_service(
            "/assets",
            tower::ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                ))
                .service(ServeDir::new(&assets)),
        )
        .fallback_service(ServeDir::new(&cfg.web_dir))
        // The web client and packages are always sent fresh. Revalidating by
        // date isn't safe: different Hearth versions (an installed app, a dev
        // build, a standalone server) serve the same address and share one
        // browser cache, and an older file can carry a *newer* date.
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-store")))
        .layer(axum::middleware::map_request(strip_conditional_headers))
        .with_state(state.clone());

    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse().context("bad host/port")?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("could not listen on {addr} (is another Hearth already running?)"))?;
    let addr = listener.local_addr()?;
    tracing::info!(%addr, world = %world_name, "serving");

    let (tx, rx) = oneshot::channel::<()>();
    let server_state = state.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await?;
        autosave.abort();
        tracing::info!("server stopped, saving world");
        persist::save_now(&state).await
    });

    Ok(RunningServer { addr, gm_key, world_name, world_dir: cfg.world_dir, state: server_state, shutdown: Some(tx), task })
}

/// Drop "has it changed since…?" headers so file requests always get the
/// current file rather than a 304 that would keep a stale cached copy.
/// Uploaded assets are unaffected in practice: they're cached as immutable.
async fn strip_conditional_headers(mut req: axum::extract::Request) -> axum::extract::Request {
    let h = req.headers_mut();
    h.remove(header::IF_MODIFIED_SINCE);
    h.remove(header::IF_NONE_MATCH);
    h.remove(header::IF_UNMODIFIED_SINCE);
    req
}

/// Best guess at this machine's LAN address (no packets are sent).
pub fn lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:9").ok()?;
    sock.local_addr().ok().map(|a| a.ip()).filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
}
