import { mapWithConcurrency, normalizeConcurrency } from "./async-pool.mjs";
import { cleanTagList, searchResultMatchesExcludedTags } from "./search-filter.mjs";

export class SearchPipelineCanceledError extends Error {
  constructor() {
    super("search canceled");
    this.name = "SearchPipelineCanceledError";
  }
}

export async function executeSearchPipeline(options) {
  const sources = Array.from(options.sources || []);
  const request = options.request || {};
  const excludedTags = cleanTagList(request.excluded_tags);
  const sourceConcurrency = normalizeConcurrency(options.sourceConcurrency, 2, 8);
  const enrichConcurrency = normalizeConcurrency(options.enrichConcurrency, 4, 12);
  const isCanceled = options.isCanceled || (() => false);
  const onProgress = options.onProgress || (() => undefined);
  const onWarning = options.onWarning || (() => undefined);
  let completedSources = 0;

  assertActive(isCanceled);
  const sourceRuns = await mapWithConcurrency(sources, sourceConcurrency, async (source, sourceIndex) => {
    assertActive(isCanceled);
    onProgress({
      phase: "source_started",
      source,
      sourceIndex,
      completedSources,
      totalSources: sources.length,
    });

    try {
      const response = await options.searchSource(source, request);
      assertActive(isCanceled);
      const normalizedResults = (response?.results || [])
        .map((item) => normalizeSearchResult(item, source))
        .filter(Boolean);
      let excludedCount = 0;

      const results = await mapWithConcurrency(normalizedResults, enrichConcurrency, async (item) => {
        assertActive(isCanceled);
        if (excludedTags.length && !item.tags.length && options.enrichResult) {
          try {
            const enriched = await options.enrichResult(source, item);
            item.tags = cleanTagList(enriched?.tags);
          } catch (error) {
            onWarning({
              source,
              item,
              error,
              message: `Could not enrich search tags for ${item.source_id} ${item.gallery_url}`,
            });
          }
        }
        if (searchResultMatchesExcludedTags(item, excludedTags)) {
          excludedCount += 1;
          return null;
        }
        return item;
      });

      return {
        source,
        sourceIndex,
        results: results.filter(Boolean),
        excludedCount,
        error: null,
      };
    } catch (error) {
      if (error instanceof SearchPipelineCanceledError) {
        throw error;
      }
      return {
        source,
        sourceIndex,
        results: [],
        excludedCount: 0,
        error: {
          source_id: source.id,
          source_name: source.name,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      completedSources += 1;
      onProgress({
        phase: "source_completed",
        source,
        sourceIndex,
        completedSources,
        totalSources: sources.length,
      });
    }
  });

  assertActive(isCanceled);
  const results = [];
  const seenResults = new Set();
  const sourceErrors = [];
  let excludedCount = 0;

  for (const sourceRun of sourceRuns) {
    excludedCount += sourceRun.excludedCount;
    if (sourceRun.error) {
      sourceErrors.push(sourceRun.error);
    }
    for (const item of sourceRun.results) {
      const key = `${item.source_id}|${item.gallery_url}`;
      if (seenResults.has(key)) {
        continue;
      }
      seenResults.add(key);
      results.push(item);
    }
  }

  return {
    sourceIds: sources.map((source) => source.id),
    sourceErrors,
    excludedTags,
    excludedCount,
    results: sortSearchResultsByNewest(results),
  };
}

function normalizeSearchResult(item, source) {
  const galleryUrl = String(item?.gallery_url || item?.url || "").trim();
  if (!galleryUrl) {
    return null;
  }
  return {
    source_id: String(item?.source_id || source.id),
    gallery_url: galleryUrl,
    title: String(item?.title || galleryUrl).trim() || galleryUrl,
    tags: cleanTagList(item?.tags),
    thumbnail_url: textOrNull(item?.thumbnail_url),
    uploader: textOrNull(item?.uploader),
    uploaded_at: normalizeUploadedAt(item?.uploaded_at),
    category: textOrNull(item?.category),
    page_count: positiveIntegerOrNull(item?.page_count),
    rating: ratingOrNull(item?.rating),
  };
}

export function sortSearchResultsByNewest(results) {
  const indexed = Array.from(results || [], (result, index) => ({
    result,
    index,
    timestamp: uploadedAtTimestamp(result?.uploaded_at),
  }));
  const knownByTime = indexed
    .filter((item) => item.timestamp !== null)
    .sort((left, right) => right.timestamp - left.timestamp || left.index - right.index);
  const known = interleaveEqualTimestamps(knownByTime);
  const unknown = interleaveBySource(
    indexed.filter((item) => item.timestamp === null).map((item) => item.result),
  );
  return [...known, ...unknown];
}

function interleaveEqualTimestamps(indexedResults) {
  const results = [];
  let start = 0;
  while (start < indexedResults.length) {
    let end = start + 1;
    while (end < indexedResults.length && indexedResults[end].timestamp === indexedResults[start].timestamp) {
      end += 1;
    }
    results.push(...interleaveBySource(indexedResults.slice(start, end).map((item) => item.result)));
    start = end;
  }
  return results;
}

function interleaveBySource(results) {
  const queues = new Map();
  for (const result of results) {
    const sourceId = String(result?.source_id || "");
    const queue = queues.get(sourceId);
    if (queue) {
      queue.push(result);
    } else {
      queues.set(sourceId, [result]);
    }
  }

  const interleaved = [];
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

function normalizeUploadedAt(value) {
  const timestamp = uploadedAtTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function uploadedAtTimestamp(value) {
  const text = textOrNull(value);
  if (!text) {
    return null;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10000 ? parsed : null;
}

function ratingOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 5 ? parsed : null;
}

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function assertActive(isCanceled) {
  if (isCanceled()) {
    throw new SearchPipelineCanceledError();
  }
}
