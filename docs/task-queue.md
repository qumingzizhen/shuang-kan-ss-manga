# Task Queue

Task queue code lives in `packages/task-queue`.

## Purpose

The queue layer separates task creation from task execution:

```text
API route -> task repository -> task queue -> worker dispatcher -> source adapter
```

The API should not know whether the queue is in-memory, NATS JetStream, Redis, or another transport. Workers should consume `TaskQueueMessage` through the worker runtime and dispatch the embedded task through the source adapter SDK.

## Current Implementation

| Implementation | Status | Use |
|---|---|---|
| `InMemoryTaskQueue` | Implemented | Local development, API route checks, and API local worker execution |
| NATS JetStream | Planned | Cross-process and production task transport |

`InMemoryTaskQueue` is intentionally not a production transport. It helps keep the API and worker code wired against a stable trait before NATS is installed. The API starts a local in-process worker by default in memory mode; set `API_LOCAL_WORKER=false` to keep tasks queued without local execution.

## Message Contract

`TaskQueueMessage` contains:

| Field | Purpose |
|---|---|
| `task_id` | Stable task id |
| `kind` | Task kind for routing and metrics |
| `task` | Full task snapshot |
| `attempt` | Delivery attempt number |
| `queued_at` | Queue enqueue timestamp |

For NATS JetStream, the same contract should be serialized as JSON first. Later it can be moved to a versioned binary format if needed.

## Worker Runtime

`packages/task-runtime` owns the shared `WorkerRuntime` that:

1. receives a `TaskQueueMessage`
2. calls `TaskReporter::task_started`
3. dispatches the embedded task through `TaskDispatcher`
4. calls `TaskReporter::task_completed` or `TaskReporter::task_failed`
5. acknowledges the message through `TaskQueue::ack`

The standalone download worker currently uses a tracing reporter. The API local worker uses a repository-backed reporter that updates task status and publishes lifecycle SSE events.

For direct gallery tasks, `TaskDispatcher` now calls the adapter's `download_gallery` operation. Completion reports can include total, done, and failed page counts, which the API local worker writes into `TaskProgress` before publishing `task_completed`. Dispatch reports can also include `TaskOutput`, so search results, download reports, and retry plans survive beyond the worker log line.

Lifecycle reporting should reuse the event names in `docs/task-lifecycle.md`. Workers should report `task_started` before adapter dispatch, `task_progressed` during page/file work, and one terminal event: `task_completed`, `task_failed`, or `task_canceled`.

## Future NATS Shape

Expected subjects:

```text
tasks.search.created
tasks.gallery.created
tasks.retry_folder.created
tasks.progress.updated
tasks.lifecycle.canceled
```

Workers should acknowledge messages only after the task state has been durably updated. Failed messages should be retried with attempt metadata and moved to a dead-letter stream after policy limits.
