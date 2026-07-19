# File Library

The current file library is a read-only inventory layer for downloaded manga
folders. It is intentionally small, but the returned shape is designed to
survive the later move to PostgreSQL, Meilisearch, and object storage.

## Development API

The temporary Node.js API shim exposes:

```text
GET /v1/library
GET /v1/library/tags
GET /v1/library/{id}
GET /v1/library/{id}/pages/{filename}
GET /v1/library/{id}/exports
GET /v1/library/{id}/exports/{exportId}/file
PATCH /v1/library/{id}/shelf
POST /v1/library/{id}/exports/cbz
POST /v1/library/{id}/exports/pdf
```

`GET /v1/library` accepts query parameters for the current development shim and
the later database-backed implementation:

- `q`: match title, folder, root, gallery URL, or tags.
- `tag`: match tag text.
- `completeness`: `complete` or `incomplete`.
- `failed_only`: `true` or `1`.
- `favorite_only`: `true` or `1`.
- `recent_only`: `true` or `1`, requiring local reading history.
- `reading_status`: `unread`, `reading`, `finished`, or `paused`.
- `sort`: `updated_desc`, `last_read_desc`, `title_asc`, `images_desc`,
  `failed_desc`, `size_desc`, or `completeness_asc`.

`GET /v1/library/tags` accepts the same filter parameters plus `limit`. It
returns popular tag stats for the matched library set:

- `tag`: tag text as stored in metadata.
- `item_count`: number of local gallery items containing the tag.
- `image_count`: total image count across those gallery items.
- `failed_count`: total failed-page count across those gallery items.

Default scanned roots:

```text
<project-root>\.data\downloads
<legacy-download-root>
```

Additional roots can be appended through `DEV_API_LIBRARY_ROOTS` with a
semicolon-separated list.

## Returned Item

Each item currently contains:

- `id`: stable ID derived from root and folder name.
- `source_id`: source adapter ID from `metadata.json`, falling back to the
  default local source when older folders do not record it.
- `root`: scanned root directory.
- `folder`: full gallery folder path.
- `title`: metadata title or folder name fallback.
- `gallery_url`: source gallery URL when `metadata.json` provides it.
- `page_count`: expected page count from metadata, falling back to image count.
- `image_count`: local image file count.
- `failed_count`: non-empty line count in `failed_pages.jsonl`.
- `size_bytes`: top-level file size total.
- `metadata_path`: `metadata.json` path when present.
- `failure_log_path`: failure log path when present.
- `cover_filename`: first local image filename in natural page order.
- `cover_url`: safe image stream URL for the first local image, intended for
  library covers and preview cards.
- `tags`: flattened metadata tags.
- `updated_at`: newest top-level file update time.
- `shelf`: local shelf metadata with `favorite`, `reading_status`, `note`,
  `last_page`, `last_read_at`, and `updated_at`.

## Returned Detail

`GET /v1/library/{id}` returns the same inventory item plus:

- `metadata`: compact metadata summary from `metadata.json`.
- `pages`: first page batch with page index, filename, size, update time, and
  preview URL.
- `pages_total`, `pages_offset`, `pages_limit`, `pages_next_offset`: pagination
  metadata for the page preview list.
- `failed_entries`: up to 100 parsed entries from `failed_pages.jsonl`.

`GET /v1/library/{id}/pages?offset=0&limit=24` returns a paginated page list:

- `items`: page entries for the requested batch.
- `total`: total image page count.
- `offset`, `limit`, `next_offset`: pagination state.

`GET /v1/library/{id}/pages/{filename}` streams an image file for the web
preview grid. The development API validates that the ID points to a configured
library root and that the filename is a single image-file path segment.

`PATCH /v1/library/{id}/shelf` updates local shelf metadata stored in:

```text
<project-root>\.data\dev-api\library-shelf.json
```

This file is development-only for now. The shape is intentionally close to a
future per-user library table: favorite flag, reading status, note, last read
page, last read time, and update time.

`GET /v1/library/{id}/exports` returns project-local export history recorded in:

```text
<project-root>\.data\dev-api\library-exports.jsonl
```

Each export record includes the format, output path, page count, size, created
time, and whether the output file still exists.

`GET /v1/library/{id}/exports/{exportId}/file` streams a previously recorded
CBZ/PDF as a download. The development API checks that the export record belongs
to the requested library item and that the file is still under the configured
project-local export directories.

`POST /v1/library/{id}/exports/cbz` creates a CBZ archive under:

```text
<project-root>\.data\exports\cbz
```

The exporter keeps image files in natural filename order and includes
`metadata.json` and `failed_pages.jsonl` when present. It uses Python's standard
`zipfile` module, so it does not add a dependency outside the project.

`POST /v1/library/{id}/exports/pdf` creates a PDF under:

```text
<project-root>\.data\exports\pdf
```

The PDF exporter keeps the same natural image order, converts pages through
Pillow, and writes each page at the source image size through ReportLab.

## Web Console

The sidebar has a `文件库` view. It shows:

- local gallery count
- image count
- failed-page record count
- favorite count
- recently read count and a continue-reading shelf strip
- popular local tags with gallery and image counts, clickable into the tag
  filter
- cover thumbnails for local galleries, streamed through the existing safe
  page-image endpoint
- per-gallery title, tags, path, size, page/image count, update time
- title/path/tag search, tag-only filter, completeness filter, failed-only
  filter, favorite-only filter, recent-history filter, reading-status filter,
  and sort controls
- favorite toggle and reading status badge in the gallery list
- multi-select and batch shelf actions for filtered library results, including
  favorite/unfavorite and reading-status updates
- batch CBZ/PDF export for selected library results, currently implemented by
  sequencing the existing per-gallery export endpoints and updating the local
  export history cache
- shelf controls in the detail drawer for favorite, reading status, and notes
- reading progress display, continue-reading actions, and per-page "read to
  here" markers in the detail preview grid
- built-in manga reader opened from continue-reading actions or preview
  thumbnails, with previous/next navigation, page jump, nearby-page shortcuts,
  adjacent-page thumbnail strip and preloading, remembered fit-width,
  fit-height, original display modes, keyboard navigation, and automatic shelf
  progress updates
- clickable file-library metric cards for all items, failed records, currently
  reading, favorites, and recently read items
- a recent-reading shelf ordered by `last_read_at`, with continue and detail
  actions for each item
- table and cover-card view modes for the local file library
- clickable library tags that fill the tag filter directly
- copy buttons for gallery folder and metadata path
- one-click retry-task creation from the gallery list
- per-gallery detail drawer with metadata, failure entries, and the first 24
  page previews
- clickable preview thumbnails that open the in-app manga reader through the
  same safe image stream endpoint
- expandable preview grid that loads more page metadata in backend batches
- retry task creation from a gallery detail drawer, using the existing
  `retry-folder` task flow with `missing_only=true`
- CBZ and PDF export from the detail drawer, with generated file paths and copy
  action after export completes
- persistent export history in the detail drawer, loaded from the development
  API manifest after page refresh
- download buttons for existing CBZ/PDF export records
- copyable download links for existing export records
- export history timestamps and manual refresh from the detail drawer

## Safety Boundary

This view does not delete, move, rename, or rewrite manga files. It only reads
directory entries, image files, `metadata.json`, and `failed_pages.jsonl`.
Exports write new files only under configured project-local export directories.

## Future Path

Next likely expansions:

- Persist library rows in PostgreSQL.
- Index title, tags, and paths in Meilisearch.
- Store binary artifacts in MinIO/S3-compatible object storage.
- Add user ownership, visibility, and audit records before public deployment.
