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

The local scaffold defaults to an in-memory task repository, event publisher, and queue, and the API starts an in-process worker. For cross-process deployment, both task state and queue transport can use PostgreSQL: the queue leases messages to independent workers, the worker reporter writes terminal state back to PostgreSQL, and retryable adapter errors are delayed and bounded by policy. NATS is an optional future `TaskQueue` implementation rather than a required missing link. Source-specific behavior remains behind `packages/source-adapter`, so new websites do not change task routes or the web console.

## Optimized Runtime Flows

The development API and the Rust worker now use the same multi-source search
contract: `source_ids`, partial `source_errors`, excluded-tag accounting, and
normalized results. The execution mechanics differ by runtime, but both keep
source order deterministic and bound concurrency through environment settings.

```text
Search request
  -> validate enabled source capabilities
  -> search sources with bounded concurrency
  -> enrich missing tags with bounded concurrency
  -> apply global excluded tags
  -> deduplicate by source + gallery URL
  -> return merged results plus partial source errors
```

The online reader separates viewport policy from transport work. The frontend's
`reader-model.ts` calculates the small priority window; the development API
deduplicates identical page requests, limits simultaneous bridge processes,
and writes each successfully fetched page into the cache. Continuous mode
eagerly warms only the nearest pages and leaves the rest to browser lazy loading.

```text
Visible page
  -> reader load plan
  -> single-flight page request
  -> global bounded page-fetch queue
  -> source bridge
  -> local page cache
  -> browser image response
```

Whole-gallery downloads keep source parsing inside each bridge while sharing
scheduling and file mechanics in `scripts/source_bridge_core.py`. The common
scheduler provides bounded workers, per-thread HTTP clients, atomic `.part`
writes, consistent failure logs, and throttled progress events. This reduces
duplicated code and avoids creating a new connection client for every page.

The development API remains a local composition root rather than the production
architecture. Reusable concurrency, search, source-registry, thumbnail-policy,
and reader-window logic are extracted into small modules; production task
execution continues to live behind Rust domain, adapter, queue, and runtime
boundaries.

## Source Adapter Boundary

Each website should be implemented behind a source adapter and registered with a descriptor exposed by `GET /v1/sources`:

```text
search(tags, name, query) -> galleries
read_gallery(url) -> gallery metadata
list_pages(gallery) -> page URLs
download_page(page) -> file artifact
```

Adapters must respect authentication, access controls, rate limits, and site-specific rules. Do not add captcha, paywall, or login bypass behavior.

Fangliding now uses `scripts/fangliding_bridge.py` only as an identity and environment wrapper over the shared E-Hentai-compatible bridge. Search, gallery parsing, page reading, retry planning, download scheduling, image validation, and atomic writes are project-internal shared implementations; no project-external downloader or runtime monkey patch is required.

## Public Deployment Notes

Public-facing deployment needs:

- user accounts and role-based permissions
- per-user and per-source rate limits
- audit logs for task creation and file access
- encrypted secret storage for cookies or headers
- abuse detection and suspension controls
- content complaint and takedown process
- worker isolation for plugins and untrusted inputs

## 2026-07-29 Boundary Update

- `TaskRepository` is a stable facade over a replaceable `TaskStore` trait.
- `TaskQueue` has in-memory and PostgreSQL implementations; `WorkerRuntime` owns retry policy while adapters return structured retry metadata.
- Rust and development API search paths both normalize URLs/titles, merge soft duplicates, preserve partial source errors, and sort the combined source timeline by newest upload time.
- The bridge error schema is versioned in `config/contracts/bridge-error.schema.json` and validated across Rust, Node.js, and Python.
- Source authentication is isolated from the development server and Dashboard into independently tested modules.

See `docs/抽象复用问题整改与验收-2026-07-29.md` for the file-by-file rationale, compatibility statement, and extension-cost measurement.

## 2026-07-29 Same-Origin Deployment Boundary

Cross-device deployments keep browser traffic same-origin. The web device owns
the public origin and forwards every `/v1/**` request to either the Python
development API or the Rust production API. The backend URL is a server-only
configuration value; source adapters, task contracts, API routes, and frontend
business code remain unchanged.

```text
Browser -> Web origin (/ and /v1/**) -> Next.js rewrite or Nginx -> API :8080
```

Local `scripts/dev.ps1` still starts both processes with no configuration. It
passes its dynamically selected API port to the Next.js rewrite, while remote
Python development deployments can opt into `DEV_API_BIND_HOST=0.0.0.0`.
Production Rust deployments continue to use `API_BIND`.

See `docs/跨设备反向代理部署-2026-07-29.md` for complete configuration,
verification commands, failure semantics, and the Next.js-versus-Nginx tradeoff.
