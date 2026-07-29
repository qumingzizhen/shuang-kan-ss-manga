import { cleanTagList } from "./search-filter.mjs";

export function normalizeSearchResult(item, source) {
  const galleryUrl = textOrNull(item?.gallery_url || item?.url);
  if (!galleryUrl) {
    return null;
  }
  return {
    source_id: textOrNull(item?.source_id) || source.id,
    gallery_url: galleryUrl,
    title: textOrNull(item?.title) || galleryUrl,
    tags: cleanTagList(item?.tags),
    thumbnail_url: textOrNull(item?.thumbnail_url),
    uploader: textOrNull(item?.uploader),
    uploaded_at: normalizeUploadedAt(item?.uploaded_at),
    category: textOrNull(item?.category),
    page_count: positiveIntegerOrNull(item?.page_count),
    rating: ratingOrNull(item?.rating),
  };
}

export function mergeSearchResults(sourceRuns) {
  const results = [];
  const exactIndexes = new Map();
  const softDuplicateIndex = new SoftDuplicateIndex();
  let excludedCount = 0;
  const sourceErrors = [];

  for (const sourceRun of sourceRuns || []) {
    excludedCount += Number(sourceRun.excludedCount || 0);
    if (sourceRun.error) {
      sourceErrors.push(sourceRun.error);
    }
    for (const candidate of sourceRun.results || []) {
      const exactKey = `${candidate.source_id}|${normalizeGalleryUrl(candidate.gallery_url)}`;
      const exactIndex = exactIndexes.get(exactKey);
      if (exactIndex !== undefined) {
        results[exactIndex] = mergeResultMetadata(results[exactIndex], candidate);
        continue;
      }

      const duplicateIndex = softDuplicateIndex.find(results, candidate);
      if (duplicateIndex >= 0) {
        const merged = mergeResultMetadata(results[duplicateIndex], candidate);
        results[duplicateIndex] = merged;
        softDuplicateIndex.add(merged, duplicateIndex);
        exactIndexes.set(exactKey, duplicateIndex);
        exactIndexes.set(
          `${merged.source_id}|${normalizeGalleryUrl(merged.gallery_url)}`,
          duplicateIndex,
        );
        continue;
      }

      const resultIndex = results.length;
      exactIndexes.set(exactKey, resultIndex);
      results.push(candidate);
      softDuplicateIndex.add(candidate, resultIndex);
    }
  }

  return {
    results: sortSearchResultsByNewest(results),
    sourceErrors,
    excludedCount,
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

export function normalizeUploadedAt(value) {
  const timestamp = uploadedAtTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

export function normalizeGalleryUrl(value) {
  const text = textOrNull(value);
  if (!text) {
    return "";
  }
  try {
    const url = new URL(text);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(?:utm_.+|ref|referrer|source|spm)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return text.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

class SoftDuplicateIndex {
  constructor() {
    this.exactTitles = new Map();
    this.bigramPostings = new Map();
    this.titleLengths = new Map();
  }

  add(result, resultIndex) {
    const title = normalizedTitle(result?.title);
    if (title.length < 8) {
      return;
    }
    addPosting(this.exactTitles, title, resultIndex);
    this.titleLengths.set(resultIndex, title.length);
    if (title.length < 12) {
      return;
    }
    for (const [pair, count] of bigramCounts(title)) {
      let postings = this.bigramPostings.get(pair);
      if (!postings) {
        postings = new Map();
        this.bigramPostings.set(pair, postings);
      }
      postings.set(resultIndex, count);
    }
  }

  find(results, candidate) {
    const title = normalizedTitle(candidate?.title);
    if (title.length < 8) {
      return -1;
    }

    const candidates = new Set(this.exactTitles.get(title) || []);
    if (title.length >= 12) {
      const overlaps = new Map();
      for (const [pair, candidateCount] of bigramCounts(title)) {
        for (const [resultIndex, existingCount] of this.bigramPostings.get(pair) || []) {
          overlaps.set(
            resultIndex,
            (overlaps.get(resultIndex) || 0) + Math.min(candidateCount, existingCount),
          );
        }
      }
      const candidatePairs = title.length - 1;
      for (const [resultIndex, overlap] of overlaps) {
        const existingLength = this.titleLengths.get(resultIndex) || 0;
        if (existingLength < 12) {
          continue;
        }
        const requiredOverlap = Math.ceil((0.94 * (candidatePairs + existingLength - 1)) / 2);
        if (overlap >= requiredOverlap) {
          candidates.add(resultIndex);
        }
      }
    }

    for (const resultIndex of Array.from(candidates).sort((left, right) => left - right)) {
      if (isSoftDuplicate(results[resultIndex], candidate)) {
        return resultIndex;
      }
    }
    return -1;
  }
}

function addPosting(index, key, resultIndex) {
  const postings = index.get(key);
  if (postings) {
    postings.add(resultIndex);
  } else {
    index.set(key, new Set([resultIndex]));
  }
}
function isSoftDuplicate(left, right) {
  if (left.source_id === right.source_id) {
    return false;
  }
  if (!compatiblePageCounts(left.page_count, right.page_count)) {
    return false;
  }
  const leftTitle = normalizedTitle(left.title);
  const rightTitle = normalizedTitle(right.title);
  if (leftTitle.length < 8 || rightTitle.length < 8) {
    return false;
  }
  if (leftTitle === rightTitle) {
    return true;
  }
  if (Math.min(leftTitle.length, rightTitle.length) < 12) {
    return false;
  }
  return diceSimilarity(leftTitle, rightTitle) >= 0.94;
}

function mergeResultMetadata(left, right) {
  const [primary, secondary] =
    completenessScore(right) > completenessScore(left) ? [right, left] : [left, right];
  return {
    ...primary,
    tags: cleanTagList([...(primary.tags || []), ...(secondary.tags || [])]),
    thumbnail_url: primary.thumbnail_url || secondary.thumbnail_url || null,
    uploader: primary.uploader || secondary.uploader || null,
    uploaded_at: newestDate(primary.uploaded_at, secondary.uploaded_at),
    category: primary.category || secondary.category || null,
    page_count: primary.page_count || secondary.page_count || null,
    rating: primary.rating ?? secondary.rating ?? null,
  };
}

function completenessScore(item) {
  return (
    (item.thumbnail_url ? 3 : 0) +
    (item.uploader ? 1 : 0) +
    (item.uploaded_at ? 2 : 0) +
    (item.category ? 1 : 0) +
    (item.page_count ? 2 : 0) +
    (item.rating !== null ? 1 : 0) +
    Math.min(item.tags?.length || 0, 5)
  );
}

function newestDate(left, right) {
  const leftTimestamp = uploadedAtTimestamp(left);
  const rightTimestamp = uploadedAtTimestamp(right);
  if (leftTimestamp === null) return right || null;
  if (rightTimestamp === null) return left || null;
  return leftTimestamp >= rightTimestamp ? left : right;
}

function compatiblePageCounts(left, right) {
  return !left || !right || left === right;
}

function normalizedTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\[[^\]]{0,40}(?:translated|翻译|漢化|汉化)[^\]]*\]/giu, " ")
    .replace(/[\p{P}\p{S}\s_]+/gu, "")
    .trim();
}

function diceSimilarity(left, right) {
  const leftPairs = bigramCounts(left);
  const rightPairs = bigramCounts(right);
  let overlap = 0;
  for (const [pair, count] of leftPairs) {
    overlap += Math.min(count, rightPairs.get(pair) || 0);
  }
  const total = Math.max(left.length - 1, 0) + Math.max(right.length - 1, 0);
  return total ? (2 * overlap) / total : 0;
}

function bigramCounts(value) {
  const counts = new Map();
  for (let index = 0; index + 1 < value.length; index += 1) {
    const pair = value.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) || 0) + 1);
  }
  return counts;
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
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = hasTimeZone
    ? text
    : /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(text)
      ? `${text.replace(" ", "T")}Z`
      : text;
  const timestamp = Date.parse(normalized);
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
