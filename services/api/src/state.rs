use comic_platform_source_adapter::SourceAdapterRegistry;
use comic_platform_task_queue::InMemoryTaskQueue;

use crate::{publisher::TaskPublisher, repository::TaskRepository};

#[derive(Clone)]
pub struct AppState {
    pub tasks: TaskRepository,
    pub publisher: TaskPublisher,
    pub sources: SourceAdapterRegistry,
    pub queue: InMemoryTaskQueue,
}

impl AppState {
    pub async fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            tasks: TaskRepository::from_env().await?,
            publisher: TaskPublisher::default(),
            sources: SourceAdapterRegistry::default(),
            queue: InMemoryTaskQueue::default(),
        })
    }
}
