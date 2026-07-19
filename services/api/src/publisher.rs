use std::sync::Arc;

use comic_platform_domain::{Task, TaskEvent};
use tokio::sync::{RwLock, broadcast};

const EVENT_CHANNEL_CAPACITY: usize = 256;
const EVENT_HISTORY_LIMIT: usize = 500;

#[derive(Clone)]
pub struct TaskPublisher {
    events: Arc<RwLock<Vec<TaskEvent>>>,
    sender: broadcast::Sender<TaskEvent>,
}

impl Default for TaskPublisher {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            events: Arc::new(RwLock::new(Vec::new())),
            sender,
        }
    }
}

impl TaskPublisher {
    pub async fn publish_task_queued(&self, task: &Task) {
        let event = TaskEvent::queued(task);
        tracing::info!(task_id = %task.id, kind = ?task.kind, "task queued event published");
        self.publish(event).await;
    }

    pub async fn publish_task_started(&self, task: &Task) {
        let event = TaskEvent::started(task);
        tracing::info!(task_id = %task.id, kind = ?task.kind, "task started event published");
        self.publish(event).await;
    }

    pub async fn publish_task_progressed(&self, task: &Task) {
        let event = TaskEvent::progressed(task);
        tracing::info!(task_id = %task.id, kind = ?task.kind, "task progress event published");
        self.publish(event).await;
    }

    pub async fn publish_task_completed(&self, task: &Task) {
        let event = TaskEvent::completed(task);
        tracing::info!(task_id = %task.id, kind = ?task.kind, "task completed event published");
        self.publish(event).await;
    }

    pub async fn publish_task_failed(&self, task: &Task) {
        let event = TaskEvent::failed(task);
        tracing::info!(task_id = %task.id, kind = ?task.kind, "task failed event published");
        self.publish(event).await;
    }

    pub async fn publish_task_canceled(&self, task: &Task) {
        let event = TaskEvent::canceled(task);
        tracing::info!(task_id = %task.id, kind = ?task.kind, "task canceled event published");
        self.publish(event).await;
    }

    pub async fn publish_task_updated(&self, task: &Task) {
        let event = TaskEvent::updated(task);
        tracing::info!(task_id = %task.id, kind = ?task.kind, "task updated event published");
        self.publish(event).await;
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TaskEvent> {
        self.sender.subscribe()
    }

    async fn publish(&self, event: TaskEvent) {
        let mut events = self.events.write().await;
        events.push(event.clone());
        if events.len() > EVENT_HISTORY_LIMIT {
            let extra = events.len() - EVENT_HISTORY_LIMIT;
            events.drain(0..extra);
        }
        drop(events);

        let _ = self.sender.send(event);
    }

    pub async fn published_events(&self) -> Vec<TaskEvent> {
        self.events.read().await.clone()
    }
}
