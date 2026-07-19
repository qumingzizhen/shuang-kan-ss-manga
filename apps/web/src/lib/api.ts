export type TaskStatus = "queued" | "running" | "paused" | "completed" | "failed" | "canceled";
export type TaskKind = "search" | "gallery" | "retry_folder";
export type SourceCapability = "search" | "gallery" | "download" | "retry_folder" | "page_list" | "page_image" | "online_read";

export type SourceAdapterDescriptor = {
  id: string;
  name: string;
  homepage?: string | null;
  version: string;
  capabilities: SourceCapability[];
  enabled: boolean;
  available_for_default?: boolean;
  unavailable_reason?: string | null;
  notes?: string | null;
};

export type SourceAuthStatus = {
  source_id: string;
  configured: boolean;
  local_cookie_file: string;
  local_headers_file: string;
  has_local_cookie_file: boolean;
  has_local_headers_file: boolean;
  effective_cookie_file?: string | null;
  effective_headers_file?: string | null;
  has_effective_cookie_file: boolean;
  has_effective_headers_file: boolean;
  available_for_default: boolean;
  unavailable_reason?: string | null;
};

export type SaveSourceAuthRequest = {
  cookie?: string;
  headers?: string;
};

export type TaskProgress = {
  total: number;
  done: number;
  failed: number;
  message: string;
};

export type TaskSearchResult = {
  source_id: string;
  gallery_url: string;
  title: string;
  tags: string[];
  thumbnail_url?: string | null;
};

export type TaskOutput =
  | {
      type: "search_results";
      source_ids?: string[];
      source_errors?: Array<{
        source_id: string;
        source_name: string;
        message: string;
      }>;
      excluded_tags?: string[];
      excluded_count?: number;
      results: TaskSearchResult[];
    }
  | {
      type: "gallery_download";
      source_id: string;
      gallery_url: string;
      title: string;
      output_folder: string;
      page_count?: number | null;
      done: number;
      skipped: number;
      failed: number;
      stopped: boolean;
    }
  | {
      type: "retry_plan";
      source_id: string;
      folder: string;
      page_indexes: number[];
    };

export type Task = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  title: string;
  payload?: unknown;
  progress: TaskProgress;
  output?: TaskOutput | null;
  created_at: string;
  updated_at: string;
};

export type LibraryReadingStatus = "unread" | "reading" | "finished" | "paused";

export type LibraryShelf = {
  favorite: boolean;
  reading_status: LibraryReadingStatus;
  note: string;
  last_page?: number | null;
  last_read_at?: string | null;
  updated_at?: string | null;
};

export type LibraryHealthIssue = {
  kind: "missing_pages" | "failed_pages" | "small_images" | "stopped_download" | string;
  severity: "warning" | "failed";
  message: string;
  count?: number;
  samples?: Array<{
    filename: string;
    size_bytes: number;
  }>;
};

export type LibraryHealth = {
  status: "ok" | "warning" | "failed";
  expected_count: number;
  image_count: number;
  missing_count: number;
  failed_count: number;
  suspicious_count: number;
  suspicious_min_bytes: number;
  stopped: boolean;
  last_done: number;
  last_skipped: number;
  last_failed: number;
  updated_at?: string | null;
  issues: LibraryHealthIssue[];
};

export type LibraryItem = {
  id: string;
  source_id: string;
  root: string;
  folder: string;
  title: string;
  gallery_url?: string | null;
  page_count: number;
  image_count: number;
  failed_count: number;
  size_bytes: number;
  metadata_path?: string | null;
  failure_log_path?: string | null;
  download_state_path?: string | null;
  cover_filename?: string | null;
  cover_url?: string | null;
  tags: string[];
  health: LibraryHealth;
  updated_at: string;
  shelf: LibraryShelf;
};

export type LibraryCompleteness = "all" | "complete" | "incomplete";
export type LibraryHealthFilter = "all" | "ok" | "warning" | "failed" | "needs_attention";
export type LibrarySort =
  | "updated_desc"
  | "last_read_desc"
  | "title_asc"
  | "images_desc"
  | "failed_desc"
  | "size_desc"
  | "completeness_asc";

export type LibraryListParams = {
  query?: string;
  tag?: string;
  completeness?: LibraryCompleteness;
  health?: LibraryHealthFilter;
  failed_only?: boolean;
  favorite_only?: boolean;
  recent_only?: boolean;
  reading_status?: LibraryReadingStatus | "all";
  sort?: LibrarySort;
};

export type LibraryTagStat = {
  tag: string;
  item_count: number;
  image_count: number;
  failed_count: number;
};

export type LibraryTagListParams = LibraryListParams & {
  limit?: number;
};

export type TaskListParams = {
  query?: string;
  kind?: TaskKind | "all";
  status?: TaskStatus | "all";
};

export type LibraryPage = {
  index: number;
  filename: string;
  path: string;
  size_bytes: number;
  updated_at: string;
  url: string;
};

export type RemoteReaderPage = {
  index: number;
  page_url: string;
  filename: string;
  size_bytes: number;
  updated_at: string;
  url: string;
};

export type RemoteReaderPageBatch = {
  items: RemoteReaderPage[];
  total: number;
  offset: number;
  limit: number;
  next_offset?: number | null;
};

export type RemoteReaderPageStatus = {
  session_id: string;
  source_id: string;
  page_index: number;
  page_url: string;
  status: "pending" | "ready" | "failed";
  cached: boolean;
  size_bytes?: number | null;
  content_type?: string | null;
  error?: string | null;
  updated_at?: string | null;
};

export type RemoteReaderPageStatusBatch = {
  items: RemoteReaderPageStatus[];
  total: number;
  offset: number;
  limit: number;
  next_offset?: number | null;
};

export type RemoteReaderCacheResult = {
  mode: "session" | "pages";
  requested?: number;
};

export type RemoteReaderCacheClearResult = {
  session_id: string;
  cleared?: boolean;
  deleted?: boolean;
  page_indexes?: number[];
  cache: RemoteReaderCacheResult;
};

export type RemoteReaderBookmark = {
  page_index: number;
  label: string;
  created_at: string;
  updated_at: string;
};

export type RemoteReaderSession = {
  id: string;
  source_id: string;
  source_name: string;
  gallery_url: string;
  title: string;
  tags: string[];
  page_count: number;
  last_page?: number | null;
  last_read_at?: string | null;
  bookmarks: RemoteReaderBookmark[];
  created_at: string;
  updated_at: string;
  pages: RemoteReaderPageBatch;
};

export type RemoteReaderSessionSummary = Omit<RemoteReaderSession, "pages">;

export type LibraryMetadataSummary = {
  title?: string | null;
  url?: string | null;
  gid?: string | null;
  token?: string | null;
  length?: number | null;
  tags: string[];
};

export type LibraryDetail = LibraryItem & {
  metadata?: LibraryMetadataSummary | null;
  pages: LibraryPage[];
  pages_total: number;
  pages_offset: number;
  pages_limit: number;
  pages_next_offset?: number | null;
  failed_entries: unknown[];
};

export type LibraryPageBatch = {
  items: LibraryPage[];
  total: number;
  offset: number;
  limit: number;
  next_offset?: number | null;
};

export type LibraryExportFormat = "cbz" | "pdf";

export type LibraryExportResult = {
  id: string;
  format: LibraryExportFormat;
  type: "cbz_export" | "pdf_export";
  item_id: string;
  source_id: string;
  title: string;
  source_folder: string;
  output_file: string;
  page_count: number;
  size_bytes: number;
  created_at: string;
  included_metadata?: boolean;
  included_failure_log?: boolean;
  quality?: number;
  gallery_url?: string | null;
  exists: boolean;
};

export type TaskEventKind =
  | "task_queued"
  | "task_started"
  | "task_progressed"
  | "task_completed"
  | "task_failed"
  | "task_canceled"
  | "task_updated";

export type TaskEvent = {
  event: TaskEventKind;
  task: Task;
  emitted_at: string;
};

export type SearchTaskRequest = {
  source_id?: string;
  source_ids?: string[];
  tags: string[];
  excluded_tags?: string[];
  name?: string;
  query?: string;
  limit: number;
};

export type CreateRemoteReaderSessionRequest = {
  source_id?: string;
  gallery_url: string;
  title?: string;
};

export type UpdateRemoteReaderProgressRequest = {
  last_page: number;
};

export type ClearRemoteReaderCacheRequest = {
  page_index?: number;
  page_indexes?: number[];
};

export type CreateRemoteReaderBookmarkRequest = {
  page_index: number;
  label?: string;
};

export type GalleryTaskRequest = {
  source_id?: string;
  gallery_url: string;
};

export type RetryFolderTaskRequest = {
  source_id?: string;
  folder: string;
  missing_only: boolean;
  start_page?: number;
  end_page?: number;
};

export type UpdateLibraryShelfRequest = Partial<Pick<LibraryShelf, "favorite" | "reading_status" | "note" | "last_page">>;

export type UpdateTaskRequest = {
  status?: TaskStatus;
  progress?: TaskProgress;
  title?: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) {
        message = payload.error.trim();
      }
    } catch {
      // Keep the raw response text when the server did not return JSON.
    }
    throw new Error(message || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function listTasks(params: TaskListParams = {}): Promise<Task[]> {
  const search = new URLSearchParams();
  if (params.query) search.set("q", params.query);
  if (params.kind && params.kind !== "all") search.set("kind", params.kind);
  if (params.status && params.status !== "all") search.set("status", params.status);
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return request<Task[]>(`/v1/tasks${suffix}`);
}

export function listSources(): Promise<SourceAdapterDescriptor[]> {
  return request<SourceAdapterDescriptor[]>("/v1/sources");
}

export function getSourceAuth(sourceId: string): Promise<SourceAuthStatus> {
  return request<SourceAuthStatus>(`/v1/source-auth/${encodeURIComponent(sourceId)}`);
}

export function saveSourceAuth(sourceId: string, payload: SaveSourceAuthRequest): Promise<SourceAuthStatus> {
  return request<SourceAuthStatus>(`/v1/source-auth/${encodeURIComponent(sourceId)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteSourceAuth(sourceId: string): Promise<SourceAuthStatus> {
  return request<SourceAuthStatus>(`/v1/source-auth/${encodeURIComponent(sourceId)}`, {
    method: "DELETE",
  });
}

export function listLibrary(params: LibraryListParams = {}): Promise<LibraryItem[]> {
  const search = librarySearchParams(params);
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return request<LibraryItem[]>(`/v1/library${suffix}`);
}

export function listLibraryTags(params: LibraryTagListParams = {}): Promise<LibraryTagStat[]> {
  const search = librarySearchParams(params);
  if (params.limit) search.set("limit", String(params.limit));
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return request<LibraryTagStat[]>(`/v1/library/tags${suffix}`);
}

function librarySearchParams(params: LibraryListParams = {}): URLSearchParams {
  const search = new URLSearchParams();
  if (params.query) search.set("q", params.query);
  if (params.tag) search.set("tag", params.tag);
  if (params.completeness && params.completeness !== "all") search.set("completeness", params.completeness);
  if (params.health && params.health !== "all") search.set("health", params.health);
  if (params.failed_only) search.set("failed_only", "true");
  if (params.favorite_only) search.set("favorite_only", "true");
  if (params.recent_only) search.set("recent_only", "true");
  if (params.reading_status && params.reading_status !== "all") search.set("reading_status", params.reading_status);
  if (params.sort) search.set("sort", params.sort);
  return search;
}

export function getLibraryDetail(id: string): Promise<LibraryDetail> {
  return request<LibraryDetail>(`/v1/library/${encodeURIComponent(id)}`);
}

export function listLibraryPages(id: string, offset = 0, limit = 24): Promise<LibraryPageBatch> {
  const search = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return request<LibraryPageBatch>(`/v1/library/${encodeURIComponent(id)}/pages?${search.toString()}`);
}

export function createRemoteReaderSession(payload: CreateRemoteReaderSessionRequest): Promise<RemoteReaderSession> {
  return request<RemoteReaderSession>("/v1/reader/sessions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listRemoteReaderSessions(): Promise<RemoteReaderSessionSummary[]> {
  return request<RemoteReaderSessionSummary[]>("/v1/reader/sessions");
}

export function getRemoteReaderSession(sessionId: string): Promise<RemoteReaderSession> {
  return request<RemoteReaderSession>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}`);
}

export function updateRemoteReaderProgress(sessionId: string, payload: UpdateRemoteReaderProgressRequest): Promise<RemoteReaderSessionSummary> {
  return request<RemoteReaderSessionSummary>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}/progress`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function listRemoteReaderPages(sessionId: string, offset = 0, limit = 24): Promise<RemoteReaderPageBatch> {
  const search = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return request<RemoteReaderPageBatch>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}/pages?${search.toString()}`);
}

export function getRemoteReaderPageStatus(sessionId: string, pageIndex: number): Promise<RemoteReaderPageStatus> {
  return request<RemoteReaderPageStatus>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}/pages/${pageIndex}/status`);
}

export function listRemoteReaderPageStatuses(sessionId: string, offset = 0, limit = 24): Promise<RemoteReaderPageStatusBatch> {
  const search = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return request<RemoteReaderPageStatusBatch>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}/pages/status?${search.toString()}`);
}

export function clearRemoteReaderSessionCache(
  sessionId: string,
  payload: ClearRemoteReaderCacheRequest = {},
): Promise<RemoteReaderCacheClearResult> {
  return request<RemoteReaderCacheClearResult>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}/cache/clear`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteRemoteReaderSession(sessionId: string): Promise<RemoteReaderCacheClearResult> {
  return request<RemoteReaderCacheClearResult>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function createRemoteReaderBookmark(
  sessionId: string,
  payload: CreateRemoteReaderBookmarkRequest,
): Promise<RemoteReaderSessionSummary> {
  return request<RemoteReaderSessionSummary>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}/bookmarks`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteRemoteReaderBookmark(sessionId: string, pageIndex: number): Promise<RemoteReaderSessionSummary> {
  return request<RemoteReaderSessionSummary>(`/v1/reader/sessions/${encodeURIComponent(sessionId)}/bookmarks/${pageIndex}`, {
    method: "DELETE",
  });
}

export function listLibraryExports(id: string): Promise<LibraryExportResult[]> {
  return request<LibraryExportResult[]>(`/v1/library/${encodeURIComponent(id)}/exports`);
}

export function updateLibraryShelf(id: string, payload: UpdateLibraryShelfRequest): Promise<LibraryShelf> {
  return request<LibraryShelf>(`/v1/library/${encodeURIComponent(id)}/shelf`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function createLibraryCbzExport(id: string): Promise<LibraryExportResult> {
  return request<LibraryExportResult>(`/v1/library/${encodeURIComponent(id)}/exports/cbz`, {
    method: "POST",
  });
}

export function createLibraryPdfExport(id: string): Promise<LibraryExportResult> {
  return request<LibraryExportResult>(`/v1/library/${encodeURIComponent(id)}/exports/pdf`, {
    method: "POST",
  });
}

export function libraryExportDownloadUrl(itemId: string, exportId: string): string {
  return apiUrl(`/v1/library/${encodeURIComponent(itemId)}/exports/${encodeURIComponent(exportId)}/file`);
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${API_BASE}${path}`;
}

export function createSearchTask(payload: SearchTaskRequest): Promise<Task> {
  return request<Task>("/v1/tasks/search", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createGalleryTask(payload: GalleryTaskRequest): Promise<Task> {
  return request<Task>("/v1/tasks/gallery", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createRetryFolderTask(payload: RetryFolderTaskRequest): Promise<Task> {
  return request<Task>("/v1/tasks/retry-folder", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateTask(id: string, payload: UpdateTaskRequest): Promise<Task> {
  return request<Task>(`/v1/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function cancelTask(id: string): Promise<Task> {
  return request<Task>(`/v1/tasks/${id}/cancel`, {
    method: "POST",
  });
}

export function createTaskEventsSource(): EventSource {
  return new EventSource(`${API_BASE}/v1/tasks/events`);
}

export function parseTaskEvent(message: MessageEvent): TaskEvent {
  return JSON.parse(message.data) as TaskEvent;
}
