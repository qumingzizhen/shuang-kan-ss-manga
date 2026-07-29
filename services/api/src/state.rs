use comic_platform_source_adapter::SourceAdapterRegistry;
use comic_platform_task_queue::{TaskQueue, TaskQueueBackend, task_queue_from_env};
use std::sync::Arc;

use crate::{publisher::TaskPublisher, repository::TaskRepository};

#[derive(Clone)]
pub struct AppState {
    pub tasks: TaskRepository,
    pub publisher: TaskPublisher,
    pub sources: SourceAdapterRegistry,
    pub queue_backend: TaskQueueBackend,
    pub queue: Arc<dyn TaskQueue>,
}

impl AppState {
    pub async fn from_env() -> anyhow::Result<Self> {
        let (queue_backend, queue) = task_queue_from_env(TaskQueueBackend::Memory).await?;
        let repository_backend = std::env::var("TASK_REPOSITORY")
            .unwrap_or_else(|_| "memory".to_string())
            .to_ascii_lowercase();
        if queue_backend == TaskQueueBackend::Postgres
            && !matches!(repository_backend.as_str(), "postgres" | "postgresql")
        {
            anyhow::bail!(
                "TASK_QUEUE_BACKEND=postgres requires TASK_REPOSITORY=postgres so workers can persist task state"
            );
        }
        Ok(Self {
            tasks: TaskRepository::from_env().await?,
            publisher: TaskPublisher::default(),
            sources: SourceAdapterRegistry::try_with_builtin_adapters()?,
            queue_backend,
            queue,
        })
    }
}
