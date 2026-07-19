use std::net::SocketAddr;

use axum::Router;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

mod error;
mod local_worker;
mod publisher;
mod repository;
mod routes;
mod state;

use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "comic_platform_api=info,tower_http=info".to_string()),
        )
        .init();

    let state = AppState::from_env().await?;
    local_worker::start_local_worker_if_enabled(state.clone());
    let app = Router::new()
        .merge(routes::router())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let bind = std::env::var("API_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let addr: SocketAddr = bind.parse()?;
    tracing::info!(%addr, "starting API service");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
