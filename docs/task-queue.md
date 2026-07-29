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
| `InMemoryTaskQueue` | Implemented | Local development and the API in-process worker |
| `PostgresTaskQueue` | Implemented | Cross-process API/worker delivery with leases, acknowledgements, and delayed retries |
| NATS JetStream | Optional future implementation | High-throughput deployments that outgrow the PostgreSQL transport |

The API defaults to the in-memory queue and starts its local worker for a zero-service development workflow. The standalone download worker defaults to PostgreSQL because a process-local queue cannot receive messages created by the API process. Select the backend with `TASK_QUEUE_BACKEND`. Set `API_LOCAL_WORKER=false` when only standalone workers should consume the durable queue; leaving it enabled intentionally allows the API process to join the worker pool.

When `TASK_QUEUE_BACKEND=postgres`, the API also requires `TASK_REPOSITORY=postgres`. This keeps durable messages and durable task state in the same deployment mode. PostgreSQL queue settings are documented in `.env.example`: connection pool size, poll interval, lease duration, consumer id, and worker retry limit.
## Message Contract

`TaskQueueMessage` contains:

| Field | Purpose |
|---|---|
| `task_id` | Stable task id |
| `kind` | Task kind for routing and metrics |
| `task` | Full task snapshot |
| `attempt` | Delivery attempt number |
| `queued_at` | Queue enqueue timestamp |

Every queue transport must preserve this logical contract. A transport-specific envelope may be versioned later without changing API routes or dispatcher behavior.

## Worker Runtime

`packages/task-runtime` owns the shared `WorkerRuntime` that:

1. receives a `TaskQueueMessage`
2. calls `TaskReporter::task_started`
3. dispatches the embedded task through `TaskDispatcher`
4. calls `TaskReporter::task_completed` or `TaskReporter::task_failed`
5. acknowledges the message through `TaskQueue::ack`

The standalone download worker uses `PostgresTaskReporter` with the PostgreSQL backend so lifecycle state is visible to the API process; memory mode falls back to `TracingTaskReporter`. The API local worker uses a repository-backed reporter that updates task status and publishes lifecycle SSE events.

For direct gallery tasks, `TaskDispatcher` now calls the adapter's `download_gallery` operation. Completion reports can include total, done, and failed page counts, which the API local worker writes into `TaskProgress` before publishing `task_completed`. Dispatch reports can also include `TaskOutput`, so search results, download reports, and retry plans survive beyond the worker log line.

Lifecycle reporting should reuse the event names in `docs/task-lifecycle.md`. Workers should report `task_started` before adapter dispatch, `task_progressed` during page/file work, and one terminal event: `task_completed`, `task_failed`, or `task_canceled`.

## Optional NATS Extension

NATS JetStream remains a possible additional `TaskQueue` implementation, not a missing prerequisite. If introduced, it must preserve `TaskQueueMessage`, delayed retry semantics, durable task-state reporting, and acknowledge only after the terminal state is persisted. API routes and `WorkerRuntime` must continue to depend on the `TaskQueue` trait rather than NATS subjects.
