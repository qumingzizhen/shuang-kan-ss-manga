use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};
use uuid::Uuid;

pub type TaskId = String;
pub type SourceId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Canceled,
}

impl TaskStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

impl fmt::Display for TaskStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for TaskStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "queued" => Ok(Self::Queued),
            "running" => Ok(Self::Running),
            "paused" => Ok(Self::Paused),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            _ => Err(format!("unknown task status: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Search,
    Gallery,
    RetryFolder,
}

impl TaskKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Gallery => "gallery",
            Self::RetryFolder => "retry_folder",
        }
    }
}

impl fmt::Display for TaskKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for TaskKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "search" => Ok(Self::Search),
            "gallery" => Ok(Self::Gallery),
            "retry_folder" => Ok(Self::RetryFolder),
            _ => Err(format!("unknown task kind: {value}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SourceCapability {
    Search,
    Gallery,
    Download,
    RetryFolder,
}

impl SourceCapability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Gallery => "gallery",
            Self::Download => "download",
            Self::RetryFolder => "retry_folder",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceAdapterDescriptor {
    pub id: SourceId,
    pub name: String,
    pub homepage: Option<String>,
    pub version: String,
    pub capabilities: Vec<SourceCapability>,
    pub enabled: bool,
    pub notes: Option<String>,
}

impl SourceAdapterDescriptor {
    pub fn supports(&self, capability: &SourceCapability) -> bool {
        self.enabled && self.capabilities.iter().any(|item| item == capability)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProgress {
    pub total: u32,
    pub done: u32,
    pub failed: u32,
    pub message: String,
}

impl TaskProgress {
    pub fn validate(&self) -> Result<(), String> {
        if self.total > 0 && self.done.saturating_add(self.failed) > self.total {
            return Err("progress done plus failed cannot exceed total".to_string());
        }

        Ok(())
    }
}

impl Default for TaskProgress {
    fn default() -> Self {
        Self {
            total: 0,
            done: 0,
            failed: 0,
            message: "queued".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSearchResult {
    pub source_id: SourceId,
    pub gallery_url: String,
    pub title: String,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSearchError {
    pub source_id: SourceId,
    pub source_name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskOutput {
    SearchResults {
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        source_ids: Vec<SourceId>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        source_errors: Vec<SourceSearchError>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        excluded_tags: Vec<String>,
        #[serde(default, skip_serializing_if = "is_zero")]
        excluded_count: u32,
        results: Vec<TaskSearchResult>,
    },
    GalleryDownload {
        source_id: SourceId,
        gallery_url: String,
        title: String,
        output_folder: String,
        page_count: Option<u32>,
        done: u32,
        skipped: u32,
        failed: u32,
        stopped: bool,
    },
    RetryPlan {
        source_id: SourceId,
        folder: String,
        page_indexes: Vec<u32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub title: String,
    pub payload: TaskPayload,
    pub progress: TaskProgress,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<TaskOutput>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskQueuedEvent {
    pub task_id: TaskId,
    pub kind: TaskKind,
    pub queued_at: DateTime<Utc>,
}

impl From<&Task> for TaskQueuedEvent {
    fn from(task: &Task) -> Self {
        Self {
            task_id: task.id.clone(),
            kind: task.kind.clone(),
            queued_at: task.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskEventKind {
    TaskQueued,
    TaskStarted,
    TaskProgressed,
    TaskCompleted,
    TaskFailed,
    TaskCanceled,
    TaskUpdated,
}

impl TaskEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TaskQueued => "task_queued",
            Self::TaskStarted => "task_started",
            Self::TaskProgressed => "task_progressed",
            Self::TaskCompleted => "task_completed",
            Self::TaskFailed => "task_failed",
            Self::TaskCanceled => "task_canceled",
            Self::TaskUpdated => "task_updated",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEvent {
    pub event: TaskEventKind,
    pub task: Task,
    pub emitted_at: DateTime<Utc>,
}

impl TaskEvent {
    pub fn queued(task: &Task) -> Self {
        Self::new(TaskEventKind::TaskQueued, task)
    }

    pub fn started(task: &Task) -> Self {
        Self::new(TaskEventKind::TaskStarted, task)
    }

    pub fn progressed(task: &Task) -> Self {
        Self::new(TaskEventKind::TaskProgressed, task)
    }

    pub fn completed(task: &Task) -> Self {
        Self::new(TaskEventKind::TaskCompleted, task)
    }

    pub fn failed(task: &Task) -> Self {
        Self::new(TaskEventKind::TaskFailed, task)
    }

    pub fn canceled(task: &Task) -> Self {
        Self::new(TaskEventKind::TaskCanceled, task)
    }

    pub fn updated(task: &Task) -> Self {
        Self::new(TaskEventKind::TaskUpdated, task)
    }

    pub fn task_id(&self) -> &str {
        &self.task.id
    }

    fn new(event: TaskEventKind, task: &Task) -> Self {
        Self {
            event,
            task: task.clone(),
            emitted_at: Utc::now(),
        }
    }
}

impl Task {
    pub fn new(kind: TaskKind, title: impl Into<String>, payload: TaskPayload) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            kind,
            status: TaskStatus::Queued,
            title: title.into(),
            payload,
            progress: TaskProgress::default(),
            output: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn update_status(&mut self, status: TaskStatus) {
        self.status = status;
        self.touch();
    }

    pub fn update_progress(&mut self, progress: TaskProgress) -> Result<(), String> {
        progress.validate()?;
        self.progress = progress;
        self.touch();
        Ok(())
    }

    pub fn set_output(&mut self, output: TaskOutput) {
        self.output = Some(output);
        self.touch();
    }

    pub fn rename(&mut self, title: impl Into<String>) {
        let title = title.into();
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            self.title = trimmed.to_string();
            self.touch();
        }
    }

    pub fn cancel(&mut self) {
        self.status = TaskStatus::Canceled;
        self.progress.message = "canceled".to_string();
        self.touch();
    }

    fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskPayload {
    Search(CreateSearchTaskRequest),
    Gallery(CreateGalleryTaskRequest),
    RetryFolder(CreateRetryFolderTaskRequest),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSearchTaskRequest {
    pub source_id: Option<SourceId>,
    #[serde(default)]
    pub source_ids: Vec<SourceId>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub excluded_tags: Vec<String>,
    pub name: Option<String>,
    pub query: Option<String>,
    pub limit: u32,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGalleryTaskRequest {
    pub source_id: Option<SourceId>,
    pub gallery_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRetryFolderTaskRequest {
    pub source_id: Option<SourceId>,
    pub folder: String,
    pub missing_only: bool,
    pub start_page: Option<u32>,
    pub end_page: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTaskRequest {
    pub status: Option<TaskStatus>,
    pub progress: Option<TaskProgress>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
}
