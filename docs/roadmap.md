# Roadmap

## Phase 0 - Skeleton

- [x] Create monorepo workspace.
- [x] Create web console scaffold.
- [x] Create Rust API scaffold.
- [x] Create Rust worker scaffold.
- [x] Create local infrastructure compose file.
- [x] Add repeatable local check script.

## Phase 1 - Runnable MVP

- [x] Install Rust toolchain and Node dependencies.
- [x] Add initial database migration.
- [x] Add PostgreSQL task repository implementation behind an optional feature.
- [ ] Verify PostgreSQL task persistence against a live database.
- [x] Add task publisher boundary.
- [x] Add in-memory task event stream for the web console.
- [x] Add task lifecycle update and cancel endpoints.
- [x] Add task lifecycle event taxonomy and domain helpers.
- [x] Add source adapter descriptor registry and capability checks.
- [x] Add shared source adapter SDK and worker dispatcher boundary.
- [x] Add shared task queue contract and in-memory queue implementation.
- [x] Add worker runtime and task reporter boundary.
- [x] Extract shared task runtime package.
- [x] Add API local worker for in-memory task execution.
- [x] Add Fangliding Python bridge for search, gallery metadata, and retry-plan operations.
- [x] Run direct gallery tasks through the Fangliding bridge downloader.
- [x] Persist structured task outputs and show searchable gallery results in the web console.
- [x] Add a temporary Node.js development API shim for local runnable web testing while Windows Rust linking is unresolved.
- [x] Add one-command local dev startup and task persistence for the development API shim.
- [x] Add web task detail drawer and batch download creation from selected search results.
- [x] Add a responsive cover gallery with compact task previews, incremental rendering, and source-backed infinite pagination.
- [x] Add a second built-in source adapter for `18comic.vip` with a conservative Python bridge and source-aware development shim dispatch.
- [x] Refactor built-in sources onto one generic Python bridge adapter and shared crawler core.
- [x] Move built-in source descriptors and bridge settings into a shared source registry config.
- [x] Extract development API source registry loading and bridge materialization into a reusable module.
- [x] Extract reusable web dashboard model helpers from the monolithic Dashboard component.
- [x] Add explicit drawer dismissal controls and click-outside close behavior.
- [x] Add animated drawer close behavior for detail sidebars.
- [x] Default web task creation to all enabled sources, with explicit single-source selection.
- [x] Adjust the web console toward a manga/anime-inspired visual style.
- [x] Add web task list filters for keyword, task type, and task status.
- [x] Add clickable task metric shortcuts for status filtering.
- [x] Add task rerun controls that recreate tasks from stored payloads.
- [x] Add task-list query filters to the Rust API and development API shim.
- [x] Add a read-only local file library inventory in the development API shim and web console.
- [x] Add per-gallery file library detail and local image preview streaming.
- [x] Add paginated page metadata loading for gallery previews.
- [x] Add file library search, filters, and sorting controls.
- [x] Add CBZ export for local file library items.
- [x] Add PDF export for local file library items.
- [x] Add persistent local export history for file library items.
- [x] Add web download endpoint for recorded exports.
- [x] Add retry-task creation from local file library details.
- [ ] Replace in-memory publisher with NATS JetStream.
- [ ] Consume tasks in the standalone download worker through a cross-process queue.
- [ ] Stream task progress through SSE.
- [ ] Complete the Fangliding full-download adapter path with page progress updates.

## Phase 2 - File Library

- [x] Add local downloaded-gallery inventory view.
- [x] Add local gallery detail drawer and first-page preview grid.
- [x] Load preview page metadata in backend batches.
- [x] Add local library search, completion filters, failed-only filters, and sorting.
- [x] Add popular local tag stats and a clickable tag panel.
- [x] Add local shelf metadata for favorites, reading status, notes, and shelf filters.
- [x] Add shelf reading progress, continue-reading shortcuts, and per-page read markers.
- [x] Add an in-app manga reader with navigation, fit modes, keyboard controls, and progress sync.
- [x] Add reader page jump, nearby-page shortcuts, and adjacent-page preloading.
- [x] Add reader thumbnail strip and remembered fit-mode preference.
- [x] Add clickable file-library metric shortcuts for common shelf and health filters.
- [x] Add recently-read shelf shortcuts, filters, and last-read sorting.
- [x] Add local gallery cover URLs and a cover-card library view.
- [x] Add multi-select batch shelf operations for local library results.
- [x] Add batch CBZ/PDF export actions for selected local library results.
- [x] Generate CBZ exports.
- [x] Generate PDF exports.
- [x] Show local export history.
- [x] Download recorded CBZ/PDF exports from the web console.
- [x] Add failure logs and retry controls.
- [ ] Store image artifacts in MinIO/S3.
- [ ] Index galleries, tags, and files in Meilisearch.

## Phase 3 - Public Platform

- [ ] Add user accounts and sessions.
- [ ] Add RBAC for users, operators, and admins.
- [ ] Encrypt cookies/headers/secrets.
- [ ] Add global and per-source rate limits.
- [ ] Add audit logs and admin review screens.
- [ ] Add content complaint and takedown workflow.

## Phase 4 - Plugin System

- [x] Define first source adapter descriptor contract.
- [x] Define worker-side source adapter SDK.
- [x] Add a subprocess-backed adapter for a second source (`18comic`).
- [x] Replace per-source Rust adapter duplication with a generic Python bridge adapter config.
- [x] Add a shared Python crawler core for bridge scripts.
- [x] Add a shared `config/source-adapters.json` registry consumed by Rust and the development API shim.
- [x] Add a reusable development API source registry module for config validation and adapter materialization.
- [ ] Add executable subprocess or WASM adapter SDK.
- [ ] Add subprocess-based plugin runner.
- [ ] Add WASM plugin runtime for safer third-party adapters.
- [ ] Add adapter versioning and capability checks.
