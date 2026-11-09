use std::path::PathBuf;

use clap::Parser;
use hearth_server::{start, ServerConfig};

/// Hearth — an open-source virtual tabletop server.
#[derive(Parser, Debug)]
#[command(version, about)]
struct Args {
    /// World folder. Created if it doesn't exist.
    #[arg(long, default_value = "worlds/default")]
    world: PathBuf,
    /// Package folder. Repeat to use several; later ones win on id clashes.
    #[arg(long, default_value = "packages")]
    packages: Vec<PathBuf>,
    /// Folder containing the web client.
    #[arg(long, default_value = "web")]
    web: PathBuf,
    /// Address to listen on. Use 127.0.0.1 to only allow this machine.
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    #[arg(long, default_value_t = 30080)]
    port: u16,
    /// Game system for a new world.
    #[arg(long, default_value = "d20-lite")]
    system: String,
    /// Display name for a new world (defaults to the folder name).
    #[arg(long)]
    name: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,hearth=debug".into()),
        )
        .init();
    let args = Args::parse();

    let server = start(ServerConfig {
        world_dir: args.world.clone(),
        package_dirs: args.packages,
        web_dir: args.web,
        host: args.host,
        port: args.port,
        new_world_system: args.system,
        new_world_name: args.name,
    })
    .await?;

    let port = server.addr.port();
    println!();
    println!("  Hearth is running.");
    println!("  World:    {} ({})", server.world_name, args.world.display());
    println!("  Open:     http://localhost:{port}");
    if let Some(ip) = hearth_server::lan_ip() {
        println!("  Players:  http://{ip}:{port}");
    }
    println!("  GM key:   {}   (keep this secret; players join without it)", server.gm_key);
    println!();

    tokio::signal::ctrl_c().await?;
    server.stop().await
}
