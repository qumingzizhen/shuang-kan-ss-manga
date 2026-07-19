# Task Lifecycle

Task lifecycle events are the shared language between API routes, workers, the web console, and the future queue/event infrastructure.

## Statuses

| Status | Meaning |
|---|---|
| `queued` | Task has been accepted and queued for workers |
| `running` | Worker or operator has started processing |
| `paused` | Task is intentionally held |
| `completed` | Task finished successfully |
| `failed` | Task stopped with an error |
| `canceled` | User or operator canceled the task |

## Events

| Event | When to publish | UI behavior |
|---|---|---|
| `task_queued` | API creates and queues a task | Add the task to the list |
| `task_started` | Task transitions to `running` | Show active progress |
| `task_progressed` | Progress changes without a terminal status | Update progress bar and log |
| `task_completed` | Task transitions to `completed` | Mark finished and keep artifacts visible |
| `task_failed` | Task transitions to `failed` | Surface failure and keep retry options available |
| `task_canceled` | Task transitions to `canceled` | Disable cancel action |
| `task_updated` | Metadata, title, queued, or paused changes | Refresh the task snapshot |

Every event carries a full `Task` snapshot. This keeps clients simple: they do not patch local state field-by-field, they replace the task by id. Completed tasks can include `TaskOutput`, documented in `docs/task-output.md`, for durable results such as search hits, download reports, and retry plans.

`GET /v1/tasks` accepts optional `q`, `kind`, and `status` filters. The current
API applies these after reading the repository snapshot; later PostgreSQL and
search-index implementations should preserve the same query parameters while
pushing filtering into storage.

## Domain Helpers

`packages/domain` owns the small lifecycle helpers:

```text
Task::update_status(status)
Task::update_progress(progress)
Task::rename(title)
Task::cancel()
TaskProgress::validate()
```

API routes use these helpers now. Workers should use the same rules through a reporter implementation when durable progress reporting is wired.

The API local worker already uses a repository-backed reporter: it marks tasks as `running`, then publishes either `task_completed` or `task_failed` after adapter dispatch. Fine-grained `task_progressed` events still require page-level reporting from the download adapter.

Direct gallery tasks now set completion progress from the adapter report: `total`, `done`, and `failed` are written into the task snapshot before the `task_completed` event is published. The same completion step also attaches structured task output when the dispatcher returns one.

## Future Transport

The current API publisher is in-memory and serves SSE directly. NATS JetStream should use the same event names and task payload shape first, then add delivery metadata such as stream sequence, retry count, and producer id.
