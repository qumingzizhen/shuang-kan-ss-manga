# Source Adapters

Source adapters isolate website-specific behavior from the API, workers, and web console.

The shared SDK lives in `packages/source-adapter`. The API uses it for source descriptors and capability checks; the download worker uses it for task dispatch.

## Descriptor

Every source must be registered with a descriptor:

| Field | Purpose |
|---|---|
| `id` | Stable machine-readable source id |
| `name` | Human-readable source name |
| `homepage` | Optional source homepage |
| `version` | Adapter contract version |
| `capabilities` | Supported task capabilities |
| `enabled` | Whether new tasks can use this source |
| `available_for_default` | Whether the source should join the default all-source search set in the current environment |
| `unavailable_reason` | Operator-facing reason when a source is enabled but not safe/reliable for default runs |
| `notes` | Operator-facing implementation notes |

The web console reads descriptors from `GET /v1/sources`. It must not hard-code source-specific behavior.
Search task creation defaults to enabled sources that are also
`available_for_default`, then produces one merged task with a `source_ids` list,
so users see a single combined result set without repeatedly hitting sources
known to be unavailable in the current environment.
Direct gallery downloads and retry-folder tasks still expand the selected
sources into one task per source because those operations need source-specific
download behavior. Users can still select a single source explicitly when they
only want to use one website.

## Capabilities

Current capability values:

| Capability | Meaning |
|---|---|
| `search` | Can search by tags, name, or query |
| `gallery` | Can read a direct gallery URL |
| `download` | Can download page artifacts |
| `retry_folder` | Can retry or repair an existing local folder |
| `page_list` | Can return a gallery's page descriptors without downloading the whole gallery |
| `page_image` | Can fetch or cache one readable page image on demand |
| `online_read` | Can be opened by the built-in online reader through page-level APIs |

The API validates task creation against source capabilities before queueing work.
The reader API validates `online_read` through `page_list` and `page_image`;
sources that only support whole-gallery downloads are not exposed as direct
reader choices in the web console.
Reader progress is an API/domain concern, not an adapter concern: adapters only
return page descriptors and page images. `PATCH /v1/reader/sessions/{id}/progress`
records the user's active page, and background prefetches must not update that
progress marker.
Direct reader sessions may omit `source_id`; the reader API then matches the
`gallery_url` host against registered online-readable source homepages. If a
client manually selects a source whose homepage clearly does not match the URL,
the API returns an explicit mismatch error instead of trying unrelated sources.
Likewise, neighbor-page preloading is owned by the reader UI and reader service:
the adapter still exposes only `list-pages` and `download-page`, while the web
reader decides which nearby pages to warm, whether to render single-page or
continuous-scroll mode, how to detect the currently visible scroll page, when to
persist reading progress, how to display preload/image-load status, and when to
retry a failed page image request.
The reader service records per-session page-image failures and exposes
`GET /v1/reader/sessions/{id}/pages/{index}/status` so clients can show the
actual failure reason instead of a generic broken image.
Clients can also call `GET /v1/reader/sessions/{id}/pages/status` with
`offset` and `limit` to fetch a window of page statuses for thumbnails,
continuous-scroll pages, and failed-page controls.
Retry is also owned by the reader service. A request with `reader_retry` or
`refresh=1` evicts only the current page's cached image before calling the
adapter again, so stale broken cache files do not survive a user retry.
Session maintenance is also source-neutral: `DELETE /v1/reader/sessions/{id}`
removes a saved online-reader session, and
`POST /v1/reader/sessions/{id}/cache/clear` clears either the whole session
cache or requested `page_index`/`page_indexes` without changing any adapter.
Reader bookmarks are source-neutral as well:
`POST /v1/reader/sessions/{id}/bookmarks` stores or updates a page bookmark,
and `DELETE /v1/reader/sessions/{id}/bookmarks/{page}` removes it. Adapters do
not store user reading metadata.

## Login-Protected Sources

Some sources are not public static websites. For sources that require an
account, cookie, age gate, regional entitlement, or other access boundary, the
adapter must follow these rules:

- use only credentials or cookies that the operator/user is authorized to use
- keep cookies in local secret configuration, never in source code or task logs
- do not bypass login checks, paywalls, CAPTCHAs, bans, or explicit access
  controls
- start with read-only metadata and page-list extraction before enabling
  downloads
- keep per-source concurrency low, add delay/backoff, and expose a source-level
  kill switch
- document whether the source can be enabled for public users; many
  login-protected sources should remain personal/local only

For ExHentai-style targets, the safe implementation shape is an adapter that
accepts a user-provided authorized cookie jar from local configuration, fetches
gallery metadata and page URLs with conservative rate limits, and stores only
the fields needed by the task/library pipeline. Browser automation may be used
for local smoke testing when necessary, but it must not be used to evade
authentication or anti-abuse controls.

## Adapter Boundary

Worker-side adapter implementations follow this shape:

```text
search(request) -> gallery summaries
read_gallery(request) -> gallery metadata
list_pages(gallery) -> page descriptors
download_page(page) -> artifact descriptor
```

Source descriptors live in `config/source-adapters.json`. Rust and the
development API shim both read this registry, so source identity, capabilities,
bridge script paths, and bridge environment variables have one canonical home.
Set `SOURCE_ADAPTER_CONFIG` to point at another registry file when testing or
deploying a different source set.

The Rust SDK uses one generic subprocess-backed implementation:

```text
SourceAdapterRegistry
  -> PythonBridgeAdapter
      -> source descriptor config
      -> standard bridge command
      -> JSON result normalization
```

Built-in sources are data entries in the adapter config table, not separate Rust
adapter types. A new Python-backed website should add a descriptor and bridge
script configuration, then implement the standard commands below. API, worker,
and web code should remain source-neutral.

| Command | Purpose |
|---|---|
| `search --tags-json ... --limit ...` | Return `{ query, results[] }` |
| `gallery --gallery-url ...` | Return title, URL, tags, and page count |
| `download-gallery --gallery-url ...` | Download a gallery and return progress totals |
| `retry-plan --folder ...` | Return missing/selected page indexes for an existing folder |
| `list-pages --gallery-url ...` | Return page descriptors when a source supports page-level work |
| `download-page --gallery-url ... --page-url ... --page-index ...` | Return one downloaded artifact descriptor |

The current built-in `fangliding` source calls `scripts/fangliding_bridge.py`,
which imports the existing Python downloader outside `newwork` and returns JSON
to Rust. The bridge currently covers:

| Operation | Status |
|---|---|
| `search` | Calls the legacy search flow and returns gallery summaries |
| `read_gallery` | Loads title, tags, and page count metadata |
| `download_gallery` | Downloads a direct gallery URL through the legacy downloader and returns output/progress stats |
| `retry_folder` | Reads `metadata.json` and returns a retry page plan |
| `list_pages` | Pending |
| `download_page` | Pending |

This bridge lets the web/API/worker architecture use the proven Python crawler while the Rust adapter contract matures. Direct gallery tasks now call `download_gallery`, so API local-worker mode can run the download and mark the task completed or failed. It is not a captcha, login, paywall, or access-control bypass.

## Python Bridge Core

Website bridge scripts should share `scripts/source_bridge_core.py` for common
crawler mechanics:

- HTTP client with timeout, retry/backoff, cookie/header file loading, and
  explicit stops on `401`, `403`, and `429`
- lightweight HTML extraction for anchors, images, metadata, title, scripts,
  and text chunks
- image response validation, extension detection, safe filename handling, and
  atomic JSON writes
- common `DownloadStats` and `ImageTarget` structures

The bridge script itself should only contain source-specific rules: URL
patterns, search URL generation, selector/parser logic, gallery page inference,
and command argument defaults. Do not duplicate HTTP/session/retry/file logic in
every new source.

## 18comic.vip Adapter

The built-in `18comic` adapter is registered with:

| Field | Value |
|---|---|
| `id` | `18comic` |
| `name` | `18comic.vip` |
| `homepage` | `https://18comic.vip/` |
| `bridge` | `scripts/18comic_bridge.py`, reusing `scripts/source_bridge_core.py` |
| `capabilities` | `search`, `gallery`, `download`, `retry_folder`, `page_list`, `page_image`, `online_read` |

The bridge is API-first. It uses the official JM mobile API for the normal
search, gallery, page-list, online-reader, and download path:

- API search returns album IDs, titles, tags, and cover URLs without depending
  on the Cloudflare-protected website search page
- gallery metadata and chapter image lists come from the API and are normalized
  into the existing source-neutral bridge contract
- `list-pages` emits stable `jmapi://photo/{photo_id}/{index}` descriptors and
  `download-page` resolves, downloads, and decodes the corresponding image
- full-gallery downloads keep bounded concurrency, progress events, failure
  logs, page-range selection, retry plans, and the existing file-library format

The previous public-HTML implementation remains a conservative compatibility
fallback:

- search pages are requested through the current `/meiman?f_search=...` entry
  first, then older search URLs only as compatibility fallbacks
- search pages are scanned for both `/album/{id}` and `/photo/{id}` links,
  with nearby thumbnail extraction for result cards
- gallery pages are scanned for title, tags, page count, and `/photo/{id}` or
  direct image links
- photo pages are scanned for common image URLs in `img` elements and scripts
- downloads run with bounded, configurable concurrency, configurable delay,
  failure logs, and a hard stop on repeated `401`, `403`, or `429` responses
- online reading uses `list-pages` to build a remote reader session and
  `download-page` to cache one page at a time under `.data/page-cache`
- the reader UI/service owns page preloading, image load state, failed image
  prompts, and per-image retry; adapters only provide page descriptors and
  fetch page images through the standard commands
- reader sessions are persisted by the development API shim under
  `.data/dev-api/reader-sessions.json` with `last_page` and `last_read_at`;
  this is a development repository implementation and should become a
  PostgreSQL-backed repository in the production API

Neither transport bypasses login checks, age gates, CAPTCHAs, Cloudflare
browser checks, bans, rate limits, or other access boundaries. If the web fallback
returns an access-control status or a browser verification page such as
`Just a moment...`, the task fails with an explicit message. Operators may
provide their own authorized local cookies or headers for the web fallback:

```text
COMIC18_COOKIE_FILE=...
COMIC18_HEADERS_FILE=...
COMIC18_BASE_URL=https://18comic.vip/
COMIC18_TRANSPORT=auto
COMIC18_DELAY=2.5
COMIC18_HTTP_BACKEND=auto
COMIC18_IMPERSONATE=chrome146
COMIC18_MAX_PAGES_PER_RUN=0
```

Search terms are normalized inside the 18comic bridge before requests are sent.
Namespace tags from other ecosystems, such as `female:big breasts` or
`language:chinese`, become plain API search terms such as `big breasts chinese`.
The original namespace form is preserved only for the web fallback's current
`f_search` request.

If one public search endpoint returns `401`, `403`, or `429`, the bridge tries
the next known public search URL for the same query. If the response body is a
browser verification/challenge page, the bridge fast-fails because trying the
old URLs will only repeat the same domain-level challenge. If every public
candidate is blocked, the bridge fails with a clear message and still does not
bypass login, age gates, captchas, Cloudflare challenges, bans, or rate limits.

Because the target layout and access rules can change, the adapter includes an
offline `self-test` parser fixture and explicit challenge-page detection. Live
smoke tests should report whether the failure is a parser miss, an ordinary
HTTP block, or a browser verification page.

In the bundled development config, 18comic is `enabled` and
`available_for_default` because the API transport does not require a web Cookie.
Cookie/Header configuration in the web console is now explicitly labeled as an
optional web-fallback session.

The dispatcher normalizes adapter results into `TaskOutput` before the API local
worker saves the completed task. This keeps frontend features source-neutral:
the web console can render search results and start direct download tasks
without knowing the source website's internal response shape.

For whole-gallery downloads, bridge scripts emit progress lines to stderr with
the `__COMIC_PLATFORM_PROGRESS__` prefix. The development API shim strips those
lines from error logs, updates `TaskProgress` in real time, and still treats the
final stdout JSON as the authoritative completion report. Long-running bridge
processes are bounded by a timeout, and stale `running` tasks without a child
bridge process are failed automatically so users can rerun them. If a bridge
report says the download stopped early, or no usable page was saved, the task is
marked `failed` even when the bridge returned structured JSON.

Download targets are tracked by page index, not by image URL. Some sources may
temporarily return the same small placeholder image for many pages when access
is blocked or throttled; the bridge must not collapse those pages into one
successful download. Built-in page downloaders therefore keep one target per
page and reject image responses smaller than the configured minimum byte size
(`EHENTAI_MIN_IMAGE_BYTES` or `COMIC18_MIN_IMAGE_BYTES`, default 2048 bytes).
This makes blocked placeholder responses fail visibly instead of producing a
fake completed task.

## E-Hentai Adapter

The built-in `e-hentai` adapter is registered with:

| Field | Value |
|---|---|
| `id` | `e-hentai` |
| `name` | `E-Hentai` |
| `homepage` | `https://e-hentai.org/` |
| `bridge` | `scripts/ehentai_bridge.py`, reusing `scripts/source_bridge_core.py` |
| `capabilities` | `search`, `gallery`, `download`, `retry_folder`, `page_list`, `page_image`, `online_read` |

The bridge parses public HTML pages conservatively:

- search pages are scanned for `/g/{gid}/{token}/` gallery links
- gallery index pages are scanned for title, namespace tags, page count, and
  `/s/{page_token}/{gid}-{index}` readable page links
- multi-page gallery indexes are followed through the normal `?p={n}`
  pagination until the declared page count is collected, no more page links are
  found, or `EHENTAI_MAX_GALLERY_INDEX_PAGES` is reached
- page pages are scanned for the main `img#img` image first, then other
  plausible image URLs from `img` elements and scripts
- downloads run with one request stream, configurable delay, failure logs, and
  a hard stop on repeated `401`, `403`, or `429` responses
- online reading uses the same `list-pages` and `download-page` contract as
  other page-level sources, so the frontend does not need an E-Hentai-specific
  reader component

It intentionally does not bypass login checks, age gates, CAPTCHAs, bans,
rate limits, or other access boundaries. Operators may provide their own
authorized cookies or headers for normal access:

```text
EHENTAI_COOKIE_FILE=...
EHENTAI_HEADERS_FILE=...
EHENTAI_BASE_URL=https://e-hentai.org/
EHENTAI_DELAY=2.0
EHENTAI_MAX_GALLERY_INDEX_PAGES=0
EHENTAI_MAX_PAGES_PER_RUN=0
```

Unlike 18comic, E-Hentai search understands namespace-style tags such as
`female:big breasts`, `language:chinese`, and `artist:name`, so the bridge keeps
those prefixes when building `f_search`. This preserves source-neutral tag
input while still giving E-Hentai the search syntax it expects.

The adapter includes an offline `self-test` fixture for parser behavior. Live
smoke testing should still be performed from the user's own network and with
authorized credentials if the selected galleries require them.

## Adding A New Source

To add another site without breaking the architecture:

1. Add one source entry in `config/source-adapters.json`.
2. Implement a bridge script that supports the standard command names and JSON
   shapes.
3. Reuse `scripts/source_bridge_core.py` for HTTP, retries, cookies, image
   validation, filenames, and JSON writes.
4. Add an offline `self-test` fixture for parser behavior.
5. Run `python scripts/check_source_adapters.py` or `scripts/check.ps1` to
   validate the registry.
6. Document source-specific environment variables and safety boundaries.
7. Keep the frontend pointed at `/v1/sources` and task outputs; do not add
   website-specific components unless the UI truly needs a generic capability
   surfaced first.

## Worker Dispatch

The download worker owns a `TaskDispatcher` that:

1. resolves the task's `source_id`
2. checks source capability compatibility
3. loads the matching adapter from `SourceAdapterRegistry`
4. calls the adapter operation matching the task payload

Queue integration feeds tasks into this dispatcher through `packages/task-runtime`. In local memory mode, the API can run an in-process worker. In production, the standalone download worker should consume from NATS JetStream or another cross-process transport. This keeps queue code, task orchestration, and source-specific website logic separate.

Adapters must not bypass authentication, paywalls, captchas, or access controls. Public deployment must add rate limits, audit logs, source-level circuit breakers, and takedown workflows before enabling broad access.
