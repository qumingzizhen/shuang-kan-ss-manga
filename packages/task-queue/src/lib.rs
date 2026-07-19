use std::{error::Error, fmt, future::Future, pin::Pin, sync::Arc};

use chrono::{DateTime, Utc};
use comic_platform_domain::{Task, TaskId, TaskKind};
use tokio::sync::{Mutex, mpsc};

pub type QueueResult<T> = Result<T, QueueError>;
pub type QueueFuture<'a, T> = Pin<Box<dyn Future<Output = QueueResult<T>> + Send + 'a>>;

const DEFAULT_IN_MEMORY_CAPACITY: usize = 1024;

#[derive(Debug, Clone)]
pub struct TaskQueueMessage {
    pub task_id: TaskId,
    pub kind: TaskKind,
    pub task: Task,
    pub attempt: u32,
    pub queued_at: DateTime<Utc>,
}

impl TaskQueueMessage {
    pub fn new(task: Task) -> Self {
        Self {
            task_id: task.id.clone(),
            kind: task.kind.clone(),
            task,
            attempt: 1,
            queued_at: Utc::now(),
        }
    }

    pub fn next_attempt(mut self) -> Self {
        self.attempt += 1;
        self.queued_at = Utc::now();
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueErrorKind {
    Closed,
    PublishFailed,
    ReceiveFailed,
}

#[derive(Debug, Clone)]
pub struct QueueError {
    pub kind: QueueErrorKind,
    pub message: String,
}

impl QueueError {
    pub fn closed() -> Self {
        Self {
            kind: QueueErrorKind::Closed,
            message: "task queue is closed".to_string(),
        }
    }

    pub fn publish_failed(message: impl Into<String>) -> Self {
        Self {
            kind: QueueErrorKind::PublishFailed,
            message: message.into(),
        }
    }

    pub fn receive_failed(message: impl Into<String>) -> Self {
        Self {
            kind: QueueErrorKind::ReceiveFailed,
            message: message.into(),
        }
    }
}

impl fmt::Display for QueueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for QueueError {}

pub trait TaskQueue: Send + Sync {
    fn enqueue<'a>(&'a self, task: Task) -> QueueFuture<'a, TaskQueueMessage>;

    fn receive<'a>(&'a self) -> QueueFuture<'a, Option<TaskQueueMessage>>;

    fn ack<'a>(&'a self, message: &'a TaskQueueMessage) -> QueueFuture<'a, ()>;

    fn retry<'a>(&'a self, message: TaskQueueMessage, reason: String) -> QueueFuture<'a, ()>;
}

#[derive(Clone)]
pub struct InMemoryTaskQueue {
    sender: mpsc::Sender<TaskQueueMessage>,
    receiver: Arc<Mutex<mpsc::Receiver<TaskQueueMessage>>>,
}

impl Default for InMemoryTaskQueue {
    fn default() -> Self {
        Self::new(DEFAULT_IN_MEMORY_CAPACITY)
    }
}

impl InMemoryTaskQueue {
    pub fn new(capacity: usize) -> Self {
        let (sender, receiver) = mpsc::channel(capacity);
        Self {
            sender,
            receiver: Arc::new(Mutex::new(receiver)),
        }
    }
}

impl TaskQueue for InMemoryTaskQueue {
    fn enqueue<'a>(&'a self, task: Task) -> QueueFuture<'a, TaskQueueMessage> {
        Box::pin(async move {
            let message = TaskQueueMessage::new(task);
            self.sender
                .send(message.clone())
                .await
                .map_err(|error| QueueError::publish_failed(error.to_string()))?;
            Ok(message)
        })
    }

    fn receive<'a>(&'a self) -> QueueFuture<'a, Option<TaskQueueMessage>> {
        Box::pin(async move {
            let mut receiver = self.receiver.lock().await;
            Ok(receiver.recv().await)
        })
    }

    fn ack<'a>(&'a self, _message: &'a TaskQueueMessage) -> QueueFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn retry<'a>(&'a self, message: TaskQueueMessage, reason: String) -> QueueFuture<'a, ()> {
        Box::pin(async move {
            let message = message.next_attempt();
            self.sender
                .send(message)
                .await
                .map_err(|error| QueueError::publish_failed(format!("{reason}: {error}")))?;
            Ok(())
        })
    }
}
