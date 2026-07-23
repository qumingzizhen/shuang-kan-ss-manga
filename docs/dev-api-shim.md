# Development API Shim

`services/dev-api/server.mjs` is a temporary Node.js API for local development
when the Rust API cannot be linked on the current Windows machine.

It mirrors the Rust API surface used by the web console:

| Route | Purpose |
|---|---|
| `GET /health` | Health check |
| `GET /v1/sources` | Source descriptor list |
| `GET /v1/library` | Read-only local downloaded-gallery inventory |
| `GET /v1/library/tags?limit=40` | Popular local library tag stats |
| `GET /v1/library/{id}` | Read-only gallery detail with pages, metadata, and failure entries |
| `GET /v1/library/{id}/pages?offset=0&limit=24` | Paginated local page metadata for previews |
| `GET /v1/library/{id}/pages/{filename}` | Read-only local image stream for web previews |
| `GET /v1/library/{id}/exports` | Project-local CBZ/PDF export history |
| `GET /v1/library/{id}/exports/{exportId}/file` | Download a recorded project-local CBZ/PDF export |
| `PATCH /v1/library/{id}/shelf` | Update local shelf metadata for a gallery |
| `POST /v1/library/{id}/exports/cbz` | Export a local gallery folder to a project-local CBZ archive |
| `POST /v1/library/{id}/exports/pdf` | Export a local gallery folder to a project-local PDF |
| `GET /v1/tasks?q=&kind=&status=` | In-memory task list with optional filters |
| `GET /v1/tasks/events` | SSE task events |
| `POST /v1/tasks/search` | Search task |
| `POST /v1/tasks/{id}/search-more` | Load and append the next page for a completed search task |
| `POST /v1/tasks/gallery` | Direct gallery download task |
| `POST /v1/tasks/retry-folder` | Existing-folder retry plan task |
| `PATCH /v1/tasks/{id}` | Task metadata/progress update |
| `POST /v1/tasks/{id}/cancel` | Cancel queued or running task |

The shim dispatches by `source_id` through `config/source-adapters.json`. Each
entry owns the public descriptor, the bridge script, and the Python runtime
selection, so new sources do not need parallel hard-coded lists in Node and
Rust. The Node-side registry loading, validation, and bridge materialization are
kept in `services/dev-api/source-registry.mjs`; keep future source-registration
rules there instead of growing `server.mjs`. Set `SOURCE_ADAPTER_CONFIG` to test
another registry file.

| Source | Bridge |
|---|---|
| `fangliding` | `scripts/fangliding_bridge.py` |
| `18comic` | `scripts/18comic_bridge.py`, using `scripts/source_bridge_core.py` |

The `18comic` bridge uses the official JM mobile API first for search, gallery
metadata, online reading, and downloads. The Cloudflare-protected public website
remains a conservative fallback. Downloads stay under the project
`.data\downloads` folder, and both transports stop on login, captcha, ban, or
rate-limit responses instead of trying to bypass them. Install the project-local
Python dependency with `python -m pip install --target .\.cache\python -r
.\requirements.txt`. Optional local configuration:

```text
MANGA_BRIDGE_PYTHON=...
SOURCE_ADAPTER_CONFIG=...
COMIC18_BASE_URL=https://18comic.vip/
COMIC18_TRANSPORT=auto
COMIC18_BRIDGE_SCRIPT=...
COMIC18_PYTHON=...
COMIC18_COOKIE_FILE=...
COMIC18_HEADERS_FILE=...
COMIC18_OUTPUT=.data\downloads
COMIC18_PAGE_OUTPUT=.data\page-artifacts\18comic
COMIC18_DELAY=2.5
COMIC18_RETRIES=2
COMIC18_RETRY_BACKOFF=1.5
COMIC18_MAX_SEARCH_PAGES=2
COMIC18_MAX_PAGES_PER_RUN=0
COMIC18_MAX_FAILURES=10
COMIC18_FORBIDDEN_STOP_AFTER=2
```

`GET /v1/library` scans downloaded-gallery folders without deleting, moving, or
rewriting files. `GET /v1/library/{id}` returns a single gallery with the first
page metadata batch, a metadata summary, and failure-log entries. More page
metadata can be loaded with `GET /v1/library/{id}/pages?offset=0&limit=24`.
Page preview URLs are served through `GET /v1/library/{id}/pages/{filename}` and
are restricted to image files directly inside scanned gallery folders.

`GET /v1/library/{id}/exports` reads export history from
`<project-root>\.data\dev-api\library-exports.jsonl` by default. The history is
append-only in the development shim and records format, output path, page count,
size, creation time, and whether the output file still exists.

`GET /v1/library/{id}/exports/{exportId}/file` streams a recorded export as an
attachment. The shim only serves files whose manifest record belongs to the
requested library item and whose output path is still inside the configured
export directories.

`POST /v1/library/{id}/exports/cbz` calls `scripts/library_export.py` and writes
archives to `<project-root>\.data\exports\cbz` by default. It keeps images in
natural filename order and includes `metadata.json` plus `failed_pages.jsonl`
when they exist.

`POST /v1/library/{id}/exports/pdf` calls `scripts/library_pdf_export.py` and
writes PDFs to `<project-root>\.data\exports\pdf` by default. It uses Pillow and
ReportLab from the project Python environment.

`PATCH /v1/library/{id}/shelf` stores local shelf metadata in
`<project-root>\.data\dev-api\library-shelf.json`. The patch body can include
`favorite`, `reading_status`, `note`, and `last_page`. `reading_status` accepts
`unread`, `reading`, `finished`, or `paused`. When `last_page` is set, the shim
also records `last_read_at`; clearing `last_page` clears the read timestamp.

Task list queries can use:

| Query | Values |
|---|---|
| `q` | task title, id, kind, status, progress, payload, or output text |
| `kind` | `search`, `gallery`, `retry_folder` |
| `status` | `queued`, `running`, `paused`, `completed`, `failed`, `canceled` |

Search-task JSON accepts an optional `excluded_tags` string array. The web
console stores the user's global disabled-tag list in browser local storage and
expands each standard English tag to its Chinese display name and known aliases
before creating or rerunning a search task. The shim enriches results that do
not include tags by reading gallery metadata, removes matching results before
persisting the output, and records both `excluded_tags` and `excluded_count` in
`search_results`. This keeps excluded comics out of later batch-download and
rerun flows rather than only hiding them visually.

Inventory queries can use:

| Query | Values |
|---|---|
| `q` | title, folder, root, URL, or tag text |
| `tag` | tag text |
| `completeness` | `complete`, `incomplete` |
| `failed_only` | `true`, `1` |
| `favorite_only` | `true`, `1` |
| `reading_status` | `unread`, `reading`, `finished`, `paused` |
| `sort` | `updated_desc`, `title_asc`, `images_desc`, `failed_desc`, `size_desc`, `completeness_asc` |

By default it reads:

```text
<project-root>\.data\downloads
<legacy-download-root>
```

Extra roots can be added with `DEV_API_LIBRARY_ROOTS` as a semicolon-separated
list. Each returned item includes folder path, title, gallery URL, image count,
page count, failed-page count, file size, metadata path, failure-log path, tags,
last updated time, and local shelf metadata.

## Run

Recommended one-terminal startup:

```powershell
cd <project-root>
.\scripts\dev.ps1
```

This starts the API shim in the background and runs the Next.js web console in
the foreground. Press `Ctrl+C` to stop both.

Manual startup is still available when you want separate terminals:

```powershell
cd <project-root>
.\scripts\dev-env.ps1
npm run dev:api:shim
```

In another terminal:

```powershell
cd <project-root>
.\scripts\dev-env.ps1
$env:NEXT_PUBLIC_API_BASE="http://127.0.0.1:8080"
npm --prefix .\apps\web run dev -- --hostname 127.0.0.1 --port 3000
```

Then open:

```text
http://127.0.0.1:3000
```

## Persistence

Task snapshots are persisted locally at:

```text
<project-root>\.data\dev-api\tasks.json
```

Completed task outputs survive API shim restarts. Tasks that were queued,
running, or paused during a restart are marked failed on the next startup with
an interruption message, because the temporary in-process worker cannot resume
an already-killed Python bridge process.

Local shelf metadata is persisted separately at:

```text
<project-root>\.data\dev-api\library-shelf.json
```

## Boundary

This is not the production backend. It keeps the web UI and task flow usable
while the Windows Rust linker environment is unresolved. The production path
remains:

```text
Next.js web -> Rust Axum API -> PostgreSQL/NATS/workers
```

The current blocker for `cargo run -p comic-platform-api` is the local
`x86_64-pc-windows-gnu` toolchain's `dlltool.exe`, which needs a real GNU
assembler for import library generation. The machine also lacks Visual Studio
Build Tools and Windows SDK libraries, so the MSVC target cannot link yet.
