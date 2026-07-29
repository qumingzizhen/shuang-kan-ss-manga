use std::sync::Arc;

use comic_platform_source_adapter::SourceAdapterRegistry;
use comic_platform_task_queue::{TaskQueueBackend, task_queue_from_env};
use comic_platform_task_runtime::{
    TaskDispatcher, TaskReporter, TracingTaskReporter, WorkerRuntime,
};

mod reporter;

use reporter::PostgresTaskReporter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "comic_platform_download_worker=info".to_string()),
        )
        .init();

    let dispatcher = TaskDispatcher::new(SourceAdapterRegistry::try_with_builtin_adapters()?);
    let (queue_backend, queue) = task_queue_from_env(TaskQueueBackend::Postgres).await?;
    let reporter: Arc<dyn TaskReporter> = match queue_backend {
        TaskQueueBackend::Postgres => Arc::new(PostgresTaskReporter::connect_from_env().await?),
        TaskQueueBackend::Memory => Arc::new(TracingTaskReporter),
    };
    let runtime = WorkerRuntime::new(queue, dispatcher.clone(), reporter);

    tracing::info!(
        sources = dispatcher.source_count(),
        queue = queue_backend.as_str(),
        "download worker started"
    );

    runtime.run_forever().await
}
