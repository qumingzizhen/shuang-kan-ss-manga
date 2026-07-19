# Task Output

`TaskOutput` is the durable result payload attached to a task after execution.
It is separate from `TaskProgress`: progress answers "how far did the task go",
while output answers "what did the task produce".

## Current Variants

| Variant | Produced by | Purpose |
|---|---|---|
| `search_results` | Search tasks | Stores gallery summaries returned by the source adapter |
| `gallery_download` | Direct gallery tasks | Stores output folder and page counters for a completed download |
| `retry_plan` | Retry-folder tasks | Stores the page indexes selected for repair |

Every task event carries the full `Task` snapshot, so web clients receive the
latest output through the same SSE stream used for status updates.

## Extension Rules

- Add new variants to `packages/domain::TaskOutput` before wiring UI-specific state.
- Keep adapter-native payloads normalized into platform fields such as
  `source_id`, `gallery_url`, `title`, `output_folder`, and `page_indexes`.
- Store large files, previews, and logs by reference instead of embedding them in
  task JSON.
- Treat output as append-or-replace task state; fine-grained live progress still
  belongs in `TaskProgress` and `task_progressed` events.

This lets future features such as batch download selection, gallery detail
pages, file-library imports, and per-page retry reports reuse the same task
contract.

## Web Console Usage

The current web console renders `TaskOutput` directly in the task list and a
detail drawer:

- `search_results` can be selected individually or in batches to create direct
  gallery download tasks.
- `gallery_download` exposes the output folder and page counters.
- `retry_plan` exposes the folder and selected page indexes.
- Payload and output JSON can be copied from the detail drawer for debugging.
- The task list can be filtered by keyword, task type, and lifecycle status.
- Task metric cards act as shortcuts for common status filters.
- Existing tasks can be rerun from the list or detail drawer by recreating the
  original create-task request from the stored payload.
- Search tasks may carry `excluded_tags`. Their `search_results` output records
  the applied terms and `excluded_count`; excluded galleries are removed before
  the result is offered for single or batch download. The web console also
  applies the current global disabled-tag list to older stored tasks.
