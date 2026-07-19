use std::{convert::Infallible, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
};
use comic_platform_domain::{
    CreateGalleryTaskRequest, CreateRetryFolderTaskRequest, CreateSearchTaskRequest,
    HealthResponse, SourceAdapterDescriptor, SourceCapability, Task, TaskEvent, TaskEventKind,
    TaskId, TaskKind, TaskPayload, TaskProgress, TaskStatus, UpdateTaskRequest,
};
use comic_platform_task_queue::TaskQueue;
use futures_util::{
    Stream, StreamExt,
    stream::{self},
};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::{error::ApiError, state::AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/v1/sources", get(list_sources))
        .route("/v1/tasks", get(list_tasks))
        .route("/v1/tasks/events", get(all_task_events))
        .route("/v1/tasks/search", post(create_search_task))
        .route("/v1/tasks/gallery", post(create_gallery_task))
        .route("/v1/tasks/retry-folder", post(create_retry_folder_task))
        .route("/v1/tasks/{id}", get(get_task).patch(update_task))
        .route("/v1/tasks/{id}/cancel", post(cancel_task))
        .route("/v1/tasks/{id}/events", get(task_events))
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: "comic-platform-api".to_string(),
    })
}

#[derive(Debug, Default, Deserialize)]
struct TaskListQuery {
    q: Option<String>,
    kind: Option<String>,
    status: Option<String>,
}

async fn list_tasks(
    State(state): State<AppState>,
    Query(query): Query<TaskListQuery>,
) -> Result<Json<Vec<Task>>, ApiError> {
    let tasks = state
        .tasks
        .list()
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(filter_tasks(tasks, query)?))
}

async fn list_sources(
    State(state): State<AppState>,
) -> Result<Json<Vec<SourceAdapterDescriptor>>, ApiError> {
    Ok(Json(state.sources.list()))
}

fn filter_tasks(tasks: Vec<Task>, query: TaskListQuery) -> Result<Vec<Task>, ApiError> {
    let kind = query
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse::<TaskKind>()
                .map_err(|error| ApiError::bad_request(error.to_string()))
        })
        .transpose()?;
    let status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse::<TaskStatus>()
                .map_err(|error| ApiError::bad_request(error.to_string()))
        })
        .transpose()?;
    let q = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);

    Ok(tasks
        .into_iter()
        .filter(|task| kind.as_ref().map_or(true, |kind| &task.kind == kind))
        .filter(|task| {
            status
                .as_ref()
                .map_or(true, |status| &task.status == status)
        })
        .filter(|task| {
            q.as_ref()
                .map_or(true, |query| task_matches_query(task, query))
        })
        .collect())
}

fn task_matches_query(task: &Task, query: &str) -> bool {
    let payload = serde_json::to_string(&task.payload).unwrap_or_default();
    let output = task
        .output
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .unwrap_or_default()
        .unwrap_or_default();
    [
        task.id.as_str(),
        task.title.as_str(),
        task.kind.as_str(),
        task.status.as_str(),
        task.progress.message.as_str(),
        payload.as_str(),
        output.as_str(),
    ]
    .join(" ")
    .to_lowercase()
    .contains(query)
}

async fn create_search_task(
    State(state): State<AppState>,
    Json(mut request): Json<CreateSearchTaskRequest>,
) -> Result<Json<Task>, ApiError> {
    if request.tags.is_empty()
        && request.name.as_deref().unwrap_or_default().is_empty()
        && request.query.as_deref().unwrap_or_default().is_empty()
    {
        return Err(ApiError::bad_request(
            "search task requires tags, name, or query",
        ));
    }

    let source_id = state
        .sources
        .resolve_source_id(request.source_id.as_deref());
    state
        .sources
        .require_capability(&source_id, SourceCapability::Search)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    request.source_id = Some(source_id);

    let title = if request.tags.is_empty() {
        request
            .name
            .clone()
            .or_else(|| request.query.clone())
            .unwrap_or_else(|| "search".to_string())
    } else {
        request.tags.join(" ")
    };
    let task = Task::new(TaskKind::Search, title, TaskPayload::Search(request));
    insert_task(&state, task).await
}

async fn create_gallery_task(
    State(state): State<AppState>,
    Json(mut request): Json<CreateGalleryTaskRequest>,
) -> Result<Json<Task>, ApiError> {
    if request.gallery_url.trim().is_empty() {
        return Err(ApiError::bad_request("gallery_url is required"));
    }

    let source_id = state
        .sources
        .resolve_source_id(request.source_id.as_deref());
    state
        .sources
        .require_capability(&source_id, SourceCapability::Gallery)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    request.source_id = Some(source_id);

    let task = Task::new(
        TaskKind::Gallery,
        request.gallery_url.clone(),
        TaskPayload::Gallery(request),
    );
    insert_task(&state, task).await
}

async fn create_retry_folder_task(
    State(state): State<AppState>,
    Json(mut request): Json<CreateRetryFolderTaskRequest>,
) -> Result<Json<Task>, ApiError> {
    if request.folder.trim().is_empty() {
        return Err(ApiError::bad_request("folder is required"));
    }

    let source_id = state
        .sources
        .resolve_source_id(request.source_id.as_deref());
    state
        .sources
        .require_capability(&source_id, SourceCapability::RetryFolder)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    request.source_id = Some(source_id);

    let task = Task::new(
        TaskKind::RetryFolder,
        request.folder.clone(),
        TaskPayload::RetryFolder(request),
    );
    insert_task(&state, task).await
}

async fn get_task(
    Path(id): Path<TaskId>,
    State(state): State<AppState>,
) -> Result<Json<Task>, ApiError> {
    let task = state
        .tasks
        .get(&id)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("task not found"))?;
    Ok(Json(task))
}

async fn update_task(
    Path(id): Path<TaskId>,
    State(state): State<AppState>,
    Json(request): Json<UpdateTaskRequest>,
) -> Result<Json<Task>, ApiError> {
    if request.status.is_none()
        && request.progress.is_none()
        && request
            .title
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Err(ApiError::bad_request(
            "task update requires status, progress, or title",
        ));
    }

    if let Some(progress) = &request.progress {
        validate_progress(progress)?;
    }

    let event_kind = classify_task_update(&request);
    let mut task = state
        .tasks
        .get(&id)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("task not found"))?;

    if let Some(status) = request.status {
        task.update_status(status);
    }

    if let Some(progress) = request.progress {
        task.update_progress(progress)
            .map_err(ApiError::bad_request)?;
    }

    if let Some(title) = request.title {
        task.rename(title);
    }

    update_task_state(&state, task, event_kind).await
}

async fn cancel_task(
    Path(id): Path<TaskId>,
    State(state): State<AppState>,
) -> Result<Json<Task>, ApiError> {
    let mut task = state
        .tasks
        .get(&id)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("task not found"))?;

    match task.status {
        TaskStatus::Completed | TaskStatus::Failed => {
            return Err(ApiError::bad_request(
                "completed or failed tasks cannot be canceled",
            ));
        }
        TaskStatus::Canceled => return Ok(Json(task)),
        TaskStatus::Queued | TaskStatus::Running | TaskStatus::Paused => {}
    }

    task.cancel();
    update_task_state(&state, task, TaskEventKind::TaskCanceled).await
}

async fn task_events(
    Path(id): Path<TaskId>,
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let task = state
        .tasks
        .get(&id)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("task not found"))?;

    let snapshot = task_snapshot_event(&task)?;
    let task_id = id.clone();
    let history = state
        .publisher
        .published_events()
        .await
        .into_iter()
        .filter(move |event| event.task_id() == task_id)
        .filter_map(|event| task_event_to_sse(event).ok())
        .map(Ok);
    let live = live_task_events(state.publisher.subscribe(), Some(id));
    let events = stream::iter(std::iter::once(Ok(snapshot)).chain(history))
        .chain(live)
        .boxed();

    Ok(Sse::new(events).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

async fn all_task_events(
    State(state): State<AppState>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let history = state
        .publisher
        .published_events()
        .await
        .into_iter()
        .filter_map(|event| task_event_to_sse(event).ok())
        .map(Ok);
    let live = live_task_events(state.publisher.subscribe(), None);
    let events = stream::iter(history).chain(live).boxed();

    Ok(Sse::new(events).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

fn live_task_events(
    receiver: broadcast::Receiver<TaskEvent>,
    task_id: Option<TaskId>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    stream::unfold(receiver, move |mut receiver| {
        let task_id = task_id.clone();
        async move {
            loop {
                match receiver.recv().await {
                    Ok(event) if task_id.as_deref().is_none_or(|id| event.task_id() == id) => {
                        let sse = task_event_to_sse(event).unwrap_or_else(|message| {
                            Event::default().event("error").data(message)
                        });
                        return Some((Ok(sse), receiver));
                    }
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        }
    })
}

fn task_snapshot_event(task: &Task) -> Result<Event, ApiError> {
    let data =
        serde_json::to_string(task).map_err(|_| ApiError::internal("failed to serialize task"))?;
    Ok(Event::default().event("snapshot").data(data))
}

fn task_event_to_sse(event: TaskEvent) -> Result<Event, String> {
    let name = event.event.as_str();
    let data = serde_json::to_string(&event).map_err(|error| error.to_string())?;
    Ok(Event::default().event(name).data(data))
}

async fn insert_task(state: &AppState, task: Task) -> Result<Json<Task>, ApiError> {
    let task = state
        .tasks
        .insert(task)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let queue_message = state
        .queue
        .enqueue(task.clone())
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    state.publisher.publish_task_queued(&task).await;
    tracing::info!(
        task_id = %task.id,
        kind = ?task.kind,
        attempt = queue_message.attempt,
        "task queued"
    );
    Ok(Json(task))
}

async fn update_task_state(
    state: &AppState,
    task: Task,
    event_kind: TaskEventKind,
) -> Result<Json<Task>, ApiError> {
    let task = state
        .tasks
        .update(task)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    publish_task_event(state, &task, event_kind).await;
    tracing::info!(task_id = %task.id, status = ?task.status, "task updated");
    Ok(Json(task))
}

fn validate_progress(progress: &TaskProgress) -> Result<(), ApiError> {
    progress.validate().map_err(ApiError::bad_request)
}

fn classify_task_update(request: &UpdateTaskRequest) -> TaskEventKind {
    match request.status.as_ref() {
        Some(TaskStatus::Running) => TaskEventKind::TaskStarted,
        Some(TaskStatus::Completed) => TaskEventKind::TaskCompleted,
        Some(TaskStatus::Failed) => TaskEventKind::TaskFailed,
        Some(TaskStatus::Canceled) => TaskEventKind::TaskCanceled,
        Some(TaskStatus::Queued | TaskStatus::Paused) => TaskEventKind::TaskUpdated,
        None if request.progress.is_some() => TaskEventKind::TaskProgressed,
        None => TaskEventKind::TaskUpdated,
    }
}

async fn publish_task_event(state: &AppState, task: &Task, event_kind: TaskEventKind) {
    match event_kind {
        TaskEventKind::TaskQueued => state.publisher.publish_task_queued(task).await,
        TaskEventKind::TaskStarted => state.publisher.publish_task_started(task).await,
        TaskEventKind::TaskProgressed => state.publisher.publish_task_progressed(task).await,
        TaskEventKind::TaskCompleted => state.publisher.publish_task_completed(task).await,
        TaskEventKind::TaskFailed => state.publisher.publish_task_failed(task).await,
        TaskEventKind::TaskCanceled => state.publisher.publish_task_canceled(task).await,
        TaskEventKind::TaskUpdated => state.publisher.publish_task_updated(task).await,
    }
}
