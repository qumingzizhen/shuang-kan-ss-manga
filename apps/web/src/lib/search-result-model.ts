import type { TaskSearchResult } from "@/lib/api";

export type SearchResultSort = "newest" | "oldest" | "title";

const categoryLabels: Record<string, string> = {
  doujinshi: "同人志",
  manga: "漫画",
  "artist cg": "画师 CG",
  "game cg": "游戏 CG",
  western: "西方作品",
  "non-h": "非成人",
  "image set": "图集",
  cosplay: "Cosplay",
  "asian porn": "亚洲作品",
  misc: "其他",
};

export function searchResultKey(result: Pick<TaskSearchResult, "source_id" | "gallery_url">) {
  return `${result.source_id}|${result.gallery_url}`;
}

export function searchResultTimestamp(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function formatSearchResultTime(value: string | null | undefined, locale = "zh-CN") {
  const timestamp = searchResultTimestamp(value);
  if (timestamp === null) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatSearchResultCategory(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized ? categoryLabels[normalized] ?? value?.trim() ?? null : null;
}

export function sortSearchResults(results: readonly TaskSearchResult[], sort: SearchResultSort = "newest") {
  const indexed = results.map((result, index) => ({ result, index }));
  if (sort === "title") {
    return indexed
      .sort(
        (left, right) =>
          left.result.title.localeCompare(right.result.title, "zh-CN", { sensitivity: "base" }) ||
          left.index - right.index,
      )
      .map(({ result }) => result);
  }

  const known = indexed.filter(({ result }) => searchResultTimestamp(result.uploaded_at) !== null);
  const unknown = indexed.filter(({ result }) => searchResultTimestamp(result.uploaded_at) === null);
  const direction = sort === "oldest" ? 1 : -1;
  known.sort((left, right) => {
    const leftTime = searchResultTimestamp(left.result.uploaded_at) ?? 0;
    const rightTime = searchResultTimestamp(right.result.uploaded_at) ?? 0;
    return (leftTime - rightTime) * direction || left.index - right.index;
  });

  return [...known.map(({ result }) => result), ...interleaveBySource(unknown.map(({ result }) => result))];
}

function interleaveBySource(results: readonly TaskSearchResult[]) {
  const queues = new Map<string, TaskSearchResult[]>();
  for (const result of results) {
    const queue = queues.get(result.source_id);
    if (queue) {
      queue.push(result);
    } else {
      queues.set(result.source_id, [result]);
    }
  }

  const interleaved: TaskSearchResult[] = [];
  while (interleaved.length < results.length) {
    for (const queue of queues.values()) {
      const result = queue.shift();
      if (result) {
        interleaved.push(result);
      }
    }
  }
  return interleaved;
}
