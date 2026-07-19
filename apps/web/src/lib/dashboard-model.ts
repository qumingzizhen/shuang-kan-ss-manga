import type {
  GalleryTaskRequest,
  LibraryItem,
  LibraryPage,
  LibraryReadingStatus,
  LibrarySort,
  RetryFolderTaskRequest,
  SearchTaskRequest,
  Task,
  TaskEventKind,
  TaskKind,
  TaskStatus,
} from "@/lib/api";

export type Mode = "search" | "gallery" | "retry";
export type View = "tasks" | "library";
export type ReaderFit = "width" | "height" | "original";
export type ReaderMode = "single" | "scroll";
export type LibraryViewMode = "table" | "grid";

export type LibraryReaderState = {
  item: LibraryItem;
  page: LibraryPage;
  total: number;
};

export const readerFitLabel: Record<ReaderFit, string> = {
  width: "适应宽度",
  height: "适应高度",
  original: "原始大小",
};

export const readerFitStorageKey = "manga-reader-fit";
export const readerModeStorageKey = "manga-reader-mode";

export const readerModeLabel: Record<ReaderMode, string> = {
  single: "单页",
  scroll: "连续",
};

export function isReaderFit(value: string | null): value is ReaderFit {
  return value === "width" || value === "height" || value === "original";
}

export function isReaderMode(value: string | null): value is ReaderMode {
  return value === "single" || value === "scroll";
}

export const statusLabel: Record<TaskStatus, string> = {
  queued: "排队",
  running: "运行",
  paused: "暂停",
  completed: "完成",
  failed: "失败",
  canceled: "取消",
};

export const kindLabel: Record<TaskKind, string> = {
  search: "搜索",
  gallery: "直链",
  retry_folder: "补缺",
};

export const readingStatusLabel: Record<LibraryReadingStatus, string> = {
  unread: "未读",
  reading: "在读",
  finished: "读完",
  paused: "搁置",
};

export const eventLabel: Record<TaskEventKind, string> = {
  task_queued: "任务入队",
  task_started: "任务开始",
  task_progressed: "进度更新",
  task_completed: "任务完成",
  task_failed: "任务失败",
  task_canceled: "任务取消",
  task_updated: "任务更新",
};

export const taskEventTypes: TaskEventKind[] = [
  "task_queued",
  "task_started",
  "task_progressed",
  "task_completed",
  "task_failed",
  "task_canceled",
  "task_updated",
];

export const cancelableStatuses = new Set<TaskStatus>(["queued", "running", "paused"]);

export function splitTags(input: string): string[] {
  const seen = new Set<string>();

  return input
    .split(/[，,；;\n]+/)
    .flatMap(splitTagChunk)
    .map((tag) => tag.trim())
    .filter((tag) => {
      if (!tag || seen.has(tag)) {
        return false;
      }
      seen.add(tag);
      return true;
    });
}

function splitTagChunk(chunk: string): string[] {
  const normalized = chunk.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return [];
  }

  const namespacedParts = normalized.match(/[A-Za-z][\w-]*:/g);
  if (namespacedParts && namespacedParts.length > 1) {
    return normalized.split(/\s+(?=[A-Za-z][\w-]*:)/);
  }

  if (/^[A-Za-z][\w-]*:/.test(normalized)) {
    return [normalized];
  }

  return normalized.split(/\s+/);
}

export function normalizeSearchText(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function normalizeLibrarySearch(value: string) {
  return normalizeSearchText(value);
}

export function searchableTaskText(task: Task) {
  return normalizeSearchText(
    [
      task.title,
      task.id,
      kindLabel[task.kind],
      statusLabel[task.status],
      task.progress.message,
      JSON.stringify(task.payload ?? {}),
      JSON.stringify(task.output ?? {}),
    ].join(" "),
  );
}

function taskPayloadRecord(task: Task): Record<string, unknown> | null {
  return task.payload && typeof task.payload === "object" && !Array.isArray(task.payload) ? (task.payload as Record<string, unknown>) : null;
}

function optionalPayloadText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function payloadInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function rerunSearchRequest(task: Task): SearchTaskRequest {
  const payload = taskPayloadRecord(task);
  if (!payload) {
    throw new Error("旧任务缺少 payload，无法重跑。");
  }
  const sourceId = optionalPayloadText(payload.source_id);
  const sourceIds = Array.isArray(payload.source_ids)
    ? payload.source_ids.filter((sourceId): sourceId is string => typeof sourceId === "string" && Boolean(sourceId.trim()))
    : [];
  const name = optionalPayloadText(payload.name);
  const query = optionalPayloadText(payload.query);

  return {
    ...(sourceIds.length ? { source_ids: sourceIds } : sourceId ? { source_id: sourceId } : {}),
    tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim())) : [],
    excluded_tags: Array.isArray(payload.excluded_tags)
      ? payload.excluded_tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
      : [],
    ...(name ? { name } : {}),
    ...(query ? { query } : {}),
    limit: payloadInteger(payload.limit) ?? 10,
  };
}

export function rerunGalleryRequest(task: Task): GalleryTaskRequest {
  const payload = taskPayloadRecord(task);
  const galleryUrl = optionalPayloadText(payload?.gallery_url);
  if (!payload || !galleryUrl) {
    throw new Error("旧任务缺少图库链接，无法重跑。");
  }
  const sourceId = optionalPayloadText(payload.source_id);

  return {
    ...(sourceId ? { source_id: sourceId } : {}),
    gallery_url: galleryUrl,
  };
}

export function rerunRetryFolderRequest(task: Task): RetryFolderTaskRequest {
  const payload = taskPayloadRecord(task);
  const folder = optionalPayloadText(payload?.folder);
  if (!payload || !folder) {
    throw new Error("旧任务缺少补缺目录，无法重跑。");
  }
  const sourceId = optionalPayloadText(payload.source_id);
  const startPage = payloadInteger(payload.start_page);
  const endPage = payloadInteger(payload.end_page);

  return {
    ...(sourceId ? { source_id: sourceId } : {}),
    folder,
    missing_only: typeof payload.missing_only === "boolean" ? payload.missing_only : true,
    ...(startPage ? { start_page: startPage } : {}),
    ...(endPage ? { end_page: endPage } : {}),
  };
}

export function libraryCompletionRatio(item: LibraryItem) {
  const expected = Math.max(item.page_count, item.image_count, 1);
  return Math.min(1, item.image_count / expected);
}

export function isLibraryComplete(item: LibraryItem) {
  if (item.health?.status && item.health.status !== "ok") {
    return false;
  }
  return item.failed_count === 0 && libraryCompletionRatio(item) >= 1;
}

export function libraryPageTotal(item: LibraryItem) {
  return Math.max(item.page_count, item.image_count, 1);
}

export function readingProgressPercent(item: LibraryItem) {
  const page = item.shelf.last_page ?? 0;
  return Math.min(100, Math.round((page / libraryPageTotal(item)) * 100));
}

export function libraryLastReadTimestamp(item: LibraryItem) {
  const timestamp = Date.parse(item.shelf.last_read_at ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function hasLibraryReadingHistory(item: LibraryItem) {
  return Boolean(item.shelf.last_read_at && item.shelf.last_page);
}

export function formatLastReadTime(value?: string | null) {
  if (!value) {
    return "暂无阅读记录";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "阅读时间未知";
  }

  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 60_000) {
    return "刚刚读过";
  }

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} 分钟前`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} 小时前`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays} 天前`;
  }

  return new Date(timestamp).toLocaleString();
}

export function clampPageNumber(page: number, total: number) {
  const safeTotal = Math.max(total, 1);
  const safePage = Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.min(Math.max(safePage, 1), safeTotal);
}

export function compareLibraryItems(sort: LibrarySort) {
  return (left: LibraryItem, right: LibraryItem) => {
    if (sort === "title_asc") {
      return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" });
    }
    if (sort === "last_read_desc") {
      return libraryLastReadTimestamp(right) - libraryLastReadTimestamp(left) || right.updated_at.localeCompare(left.updated_at);
    }
    if (sort === "images_desc") {
      return right.image_count - left.image_count || right.updated_at.localeCompare(left.updated_at);
    }
    if (sort === "failed_desc") {
      return right.failed_count - left.failed_count || right.updated_at.localeCompare(left.updated_at);
    }
    if (sort === "size_desc") {
      return right.size_bytes - left.size_bytes || right.updated_at.localeCompare(left.updated_at);
    }
    if (sort === "completeness_asc") {
      return libraryCompletionRatio(left) - libraryCompletionRatio(right) || right.updated_at.localeCompare(left.updated_at);
    }
    return right.updated_at.localeCompare(left.updated_at);
  };
}
