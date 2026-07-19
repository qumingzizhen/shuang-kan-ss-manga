use std::sync::Arc;

use comic_platform_source_adapter::SourceAdapterRegistry;
use comic_platform_task_queue::InMemoryTaskQueue;
use comic_platform_task_runtime::{TaskDispatcher, TracingTaskReporter, WorkerRuntime};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "comic_platform_download_worker=info".to_string()),
        )
        .init();

    let dispatcher = TaskDispatcher::new(SourceAdapterRegistry::default());
    let queue = Arc::new(InMemoryTaskQueue::default());
    let reporter = Arc::new(TracingTaskReporter);
    let runtime = WorkerRuntime::new(queue, dispatcher.clone(), reporter);

    tracing::info!(
        sources = dispatcher.source_count(),
        queue = "memory",
        "download worker started"
    );
    tracing::info!("cross-process queue transport is not wired yet; waiting for queue messages");

    runtime.run_forever().await
}
