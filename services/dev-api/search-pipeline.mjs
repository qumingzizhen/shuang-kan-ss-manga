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
    results,
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
  };
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
