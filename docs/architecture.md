# Architecture

## Product Shape

The new platform is a web-first system. The browser is only a control surface; long-running work is executed by backend workers.

```text
Browser
  -> Next.js Web Console
  -> Rust Axum API
  -> PostgreSQL / Redis / NATS / Object Storage / Search
  -> Rust Workers
  -> Plugin Runner
```

## Responsibilities

| Area | Owner | Responsibility |
|---|---|---|
| Web console | `apps/web` | Task creation, task history, progress, file library, admin screens |
| API service | `services/api` | Auth, task CRUD, API contracts, event streams, rate limits |
| Domain models | `packages/domain` | Shared task types, lifecycle helpers, event names, and request/response contracts |
| Download worker | `workers/download` | Queue consumption, source adapter execution, downloads, retries |
| Storage | `infra` | Local PostgreSQL, Redis, NATS, MinIO, Meilisearch |
| Source adapter SDK | `packages/source-adapter` | Source descriptors, capabilities, adapter trait, and worker dispatch registry |
| Task queue SDK | `packages/task-queue` | Queue message contract and swappable queue implementations |
| Task runtime | `packages/task-runtime` | Shared dispatcher, worker loop, and reporter contract used by API local worker and download worker |

## Planned Flow

1. User creates a search/gallery/retry task in the web console.
2. API validates the request and stores a task row.
3. API publishes a queue message through the task queue boundary.
4. Worker runtime consumes the message, reports lifecycle progress, and dispatches to the source adapter.
5. Files are stored in object storage and indexed for search.
6. Browser receives progress through SSE or WebSocket.

The current default scaffold uses an in-memory task repository, in-memory event publisher, and in-memory task queue. PostgreSQL is already implemented behind the API service's `postgres` feature. SSE task events are exposed from the publisher boundary, with explicit lifecycle events such as `task_started`, `task_progressed`, `task_completed`, `task_failed`, and `task_canceled`. The API starts a local in-process worker by default so memory-mode tasks can be consumed before NATS is installed. NATS JetStream will replace the in-memory queue/publisher later without changing route handlers. Source-specific behavior is kept behind `packages/source-adapter` so new websites can be added without changing task routes or the web console.

## Source Adapter Boundary

Each website should be implemented behind a source adapter and registered with a descriptor exposed by `GET /v1/sources`:

```text
search(tags, name, query) -> galleries
read_gallery(url) -> gallery metadata
list_pages(gallery) -> page URLs
download_page(page) -> file artifact
```

Adapters must respect authentication, access controls, rate limits, and site-specific rules. Do not add captcha, paywall, or login bypass behavior.

The built-in Fangliding adapter currently uses `scripts/fangliding_bridge.py` to call the existing Python downloader for search, gallery metadata, and retry-plan operations. Full page download progress reporting still needs a richer adapter/runtime contract.

## Public Deployment Notes

Public-facing deployment needs:

- user accounts and role-based permissions
- per-user and per-source rate limits
- audit logs for task creation and file access
- encrypted secret storage for cookies or headers
- abuse detection and suspension controls
- content complaint and takedown process
- worker isolation for plugins and untrusted inputs
