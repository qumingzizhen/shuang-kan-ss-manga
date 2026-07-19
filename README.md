# Manga Platform Newwork

This folder is the new architecture workspace for the manga platform.

## Architecture

```text
apps/web           Next.js web console
services/api       Rust Axum API service
services/dev-api   Temporary Node.js API shim for local runnable development
workers/download   Rust download worker
packages/domain    Shared Rust domain models
packages/source-adapter Shared source adapter SDK
packages/task-queue Shared task queue contract
packages/task-runtime Shared task dispatcher, worker runtime, and reporter contract
docs/task-lifecycle Shared lifecycle event taxonomy
docs/task-output Shared task result payload taxonomy
docs/file-library Local downloaded-gallery inventory notes
docs/代码结构与可复用性审查 Code structure and reusability review
infra              Local infrastructure for development
docs               Architecture, roadmap, and operating notes
```

The first target is a web platform, not a desktop app. Future app clients should reuse the same backend:

```text
Browser UI / Future App -> Rust API -> PostgreSQL/Redis/NATS/Object Storage -> Workers
```

## Local Development

Install Node.js first. Rust and PostgreSQL are kept project-local under this workspace by using `scripts/dev-env.ps1` and `scripts/postgres.ps1`.

```powershell
cd <project-root>
.\scripts\dev-env.ps1
python -m pip install --target .\.cache\python -r .\requirements.txt
npm --prefix .\apps\web install
.\scripts\dev.ps1
```

Run `.\scripts\dev-env.ps1` before dependency installation so npm, Cargo, Rustup, and temporary files stay under `<project-root>\.cache` instead of the Windows user profile on C drive.

On this Chinese-path Windows workspace, the dev scripts may use a temporary ASCII `subst` drive internally. The mapped path is only a compatibility view; files still live under `<project-root>`.

This workspace uses the `stable-x86_64-pc-windows-gnu` Rust toolchain with `rust-lld`, so it does not require Visual Studio Build Tools just to compile the current Rust services.

Run all current checks:

```powershell
.\scripts\check.ps1
```

Before publishing or pushing the repository, the same check also scans tracked
files, DOCX metadata, local paths, common secret formats, and commit identities.
It can be run separately with `python .\scripts\check_public_repo.py`. See
`docs/public-release.md` for the local-only data boundary.

`check.ps1` only validates the project and exits. It does not start the web UI.

Current Windows note: `cargo check` passes locally. Full `cargo build` still needs a reliable Windows linker environment; the GNU linker path hits a `dlltool` CreateProcess issue under this Chinese workspace path, while MSVC requires Visual Studio Build Tools. We are keeping validation on `cargo check` until the linker path is settled.

When you want to run the web UI before the Rust linker is fixed, use the development API shim:

```powershell
.\scripts\dev.ps1
```

This starts the API shim at `http://127.0.0.1:8080` and the web console at `http://127.0.0.1:3000` in one terminal. If those ports are already used by this local project, the script reuses the running services and prints the URL instead of failing.

To force-restart the local API and web console after code changes:

```powershell
.\scripts\dev.ps1 -Fresh
```

To fail fast instead of picking fallback ports when something else occupies a port:

```powershell
.\scripts\dev.ps1 -NoAutoPort
```

You can also run the two services manually:

```powershell
.\scripts\dev-env.ps1
npm run dev:api:shim
```

Then in another terminal:

```powershell
.\scripts\dev-env.ps1
$env:NEXT_PUBLIC_API_BASE="http://127.0.0.1:8080"
npm --prefix .\apps\web run dev -- --hostname 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000`. See `docs/dev-api-shim.md` for the boundary and routes.

PostgreSQL can be started without Docker:

```powershell
.\scripts\postgres.ps1 start
.\scripts\postgres.ps1 status
.\scripts\postgres.ps1 stop
```

PostgreSQL support in the API is behind an optional Rust feature:

```powershell
$env:TASK_REPOSITORY="postgres"
$env:API_AUTO_MIGRATE="true"
$env:DATABASE_URL="postgres://manga:manga@localhost:5432/manga?sslmode=disable"
.\.cache\cargo\bin\cargo.exe run -p comic-platform-api --features postgres
```

Default mode is `TASK_REPOSITORY=memory`, which keeps the API usable without Docker or PostgreSQL.

## Current Status

- Web UI scaffolded as an operational dashboard.
- Rust API scaffolded with in-memory task storage.
- Download worker scaffolded as a queue-consumer placeholder.
- Infrastructure compose file prepared for local services.
- Frontend build and Rust workspace check have passed locally.
- API route layer, task repository boundary, and task publisher boundary are split.
- Web console subscribes to task events through SSE.
- Task update and cancel endpoints are available for lifecycle control.
- Task lifecycle event names and domain helpers are available for queued, started, progressed, completed, failed, and canceled transitions.
- Source adapter descriptors and capability checks are available through `GET /v1/sources`.
- Shared source adapter SDK and worker dispatcher boundary are available.
- Shared task queue contract and in-memory queue implementation are available.
- Shared task runtime, download worker runtime, and task reporter boundary are available.
- API starts a local in-process worker by default for in-memory task execution; set `API_LOCAL_WORKER=false` to disable it.
- Built-in Fangliding adapter can call the legacy Python bridge for search, gallery metadata, retry-plan operations, and direct gallery downloads.
- Source adapters now use a generic Python bridge abstraction: built-in sources are declared in `config/source-adapters.json`, and website scripts share `scripts/source_bridge_core.py` for HTTP, retries, cookie/header loading, HTML extraction, image validation, filenames, and JSON writes.
- Development API source registration is now isolated in `services/dev-api/source-registry.mjs`, so adapter config loading and bridge materialization are reusable outside the temporary HTTP shim.
- Built-in `18comic` adapter is registered for `https://18comic.vip/` through `scripts/18comic_bridge.py`, with conservative public-page parsing, low-frequency downloads, failure logs, and explicit stops on login/captcha/rate-limit boundaries.
- The `18comic` adapter now uses the official JM mobile API first for search, gallery metadata, online reading, and downloads, with the public website retained as a conservative fallback when explicitly selected or when the API is unavailable.
- The local dev API can store user-provided `18comic` Cookie/Header files under `.data/source-auth` through `/v1/source-auth/18comic`, and the web console exposes this as an inline source settings panel. This only supports normal authorized sessions and does not bypass login, age gates, captchas, bans, or rate limits.
- The `18comic` bridge now follows the current browser search entry (`/meiman?f_search=...`), preserves namespace-style tags for that entry, uses a browser-like navigation header with the local Edge user agent when available, and detects Cloudflare/browser verification pages such as `Just a moment...` as a distinct hard stop instead of misreporting them as a missing Cookie.
- Built-in `e-hentai` adapter is registered for `https://e-hentai.org/` through `scripts/ehentai_bridge.py`, with public search parsing, gallery page-list extraction, page-image fetching, online reading support, and the same access-boundary stops.
- Online reader direct URLs now auto-detect the source by gallery host when possible, and failed page images expose a reader page status/diagnostic API so the UI can show the real failure reason; retrying a page evicts that single cached image and re-fetches it.
- Remote online reader windows now load page statuses in batches, mark thumbnails/page shortcuts as ready, loading, or failed, and offer failed-page retry plus skip-failed-page actions inside the reader.
- Remote reader history can now be filtered and expanded, individual sessions can be deleted, and reader caches can be cleared per page or per session from the web UI.
- Remote online reader sessions now support persistent page bookmarks, with add/remove controls in the reader, bookmark jumps, and bookmark counts in recent-reader history.
- Gallery download tasks now receive bridge progress events, have a bridge timeout, mark orphaned or stopped downloads as failed, reject tiny placeholder/blocked image responses, keep one target per page instead of deduping repeated image URLs, and the web UI polls active tasks as a fallback when SSE updates are missed.
- Gallery downloads for `18comic` and `e-hentai` now use bounded concurrency: selected page ranges are filtered before image-page resolution, page-image resolution and file saving run through a small worker window, and `DEV_API_GALLERY_DOWNLOAD_CONCURRENCY` can override the default concurrency for local development.
- Library scanning now exposes a `health` diagnostic summary for each downloaded gallery, including missing pages, failed page records, stopped download state, and suspicious tiny image files; the web library list and detail drawer show this status directly, and the library view can filter by normal, warning, failed, or all attention-needed items.
- Completed tasks can now store structured output for search results, gallery download reports, and retry plans.
- Web search tasks show returned galleries inline and can create direct download tasks from individual results.
- Search results now carry source thumbnail URLs when the adapter can extract them; parser/API/UI layers filter known source UI icons such as E-Hentai `t.png`/`td.png`, and the web task list and detail drawer render stable cover thumbnails through the local `/v1/search-thumbnails` proxy/cache with a placeholder fallback.
- Web task output now supports search-result selection, batch download-task creation, and a task detail drawer with payload/output JSON and output-path copying.
- Web task creation defaults to "all enabled sources"; choosing a single source is now an explicit opt-in.
- Web detail drawers now have an explicit 收回 button, click-outside dismissal, and animated slide-out closing.
- Web console visual style has been adjusted toward a softer manga/anime-inspired workspace while keeping dense operational controls.
- Web task list now supports keyword, task type, and status filters for quickly locating historical and running tasks.
- Web task metrics can be clicked as quick status filters for all, queued, running, and failed tasks.
- Web tasks can be rerun from the list or detail drawer by recreating the task from its stored payload.
- Web dashboard pure model helpers now live in `apps/web/src/lib/dashboard-model.ts`, including tag splitting, status labels, task rerun payload reconstruction, file-library sorting, and reader progress calculations.
- `GET /v1/tasks` now accepts `q`, `kind`, and `status` query parameters in the Rust API and development API shim.
- Web console now includes a read-only file library backed by `GET /v1/library` and `GET /v1/library/{id}`, scanning local downloaded-gallery folders for title, tags, image/page counts, failed-page logs, size, update time, metadata, page previews, and library search/filter controls.
- File library now exposes `GET /v1/library/tags` in the development API shim and shows a clickable popular-tag panel in the web console.
- File library previews load page metadata in batches through `GET /v1/library/{id}/pages?offset=0&limit=24`, so large galleries do not need to send every page entry when details open.
- File library items now have local shelf metadata for favorites, reading status, and notes, persisted under `.data\dev-api\library-shelf.json`.
- File library shelf metadata now tracks last read page and last read time, with continue-reading actions and page-level "read to here" markers in the preview grid.
- File library continue-reading and preview-thumbnail actions now open an in-app manga reader with page navigation, page jump, nearby-page shortcuts, adjacent-page thumbnail strip/preloading, remembered fit-width/fit-height/original display modes, keyboard navigation, and automatic reading-progress updates.
- File library metric cards now act as quick filters for all items, failed records, currently reading, favorites, and recently read items.
- File library now shows a recent-reading shelf ordered by last read time, with one-click continue-reading and detail actions.
- File library items now include safe cover-image URLs, and the web console supports both dense table view and cover-card view.
- File library now supports multi-select batch shelf operations for filtered results, including favorite/unfavorite and reading-status updates.
- File library multi-select now supports batch CBZ/PDF export by reusing the existing per-gallery export endpoints and export history cache.
- File library details can create a missing-only retry task for the current local gallery folder and jump back to the task console.
- File library details can export a local gallery to CBZ and PDF under `.data\exports` through the development API shim.
- File library export history is persisted in `.data\dev-api\library-exports.jsonl` and shown again when gallery details are reopened.
- Recorded CBZ/PDF exports can be downloaded through the web console without exposing arbitrary local file paths.
- Project-local PostgreSQL 17.10 is installed under `.tools` and stores data under `.data`.
- PostgreSQL connection and task-table migration have been verified with `psql`.
- API PostgreSQL runtime verification is pending a more reliable Windows linker or Linux/Docker build host.
- A temporary Node.js development API shim is available at `services/dev-api/server.mjs` so the web console can run against task creation, SSE, search, retry-plan, and direct-download routes while the Rust linker is unresolved. Dev shim task snapshots persist under `.data/dev-api/tasks.json`.

## Safety Boundary

The platform should not bypass authentication, paywalls, captchas, or access controls. Public-facing deployment must include user limits, audit logs, abuse controls, and content takedown flows.
