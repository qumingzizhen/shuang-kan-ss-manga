export function normalizeTag(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function cleanTagList(values) {
  const seen = new Set();
  const tags = [];
  for (const value of Array.isArray(values) ? values : []) {
    const tag = String(value || "").trim().replace(/\s+/g, " ");
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tags.push(tag);
  }
  return tags;
}

export function normalizedTagValue(value) {
  const normalized = normalizeTag(value);
  const separator = normalized.indexOf(":");
  return separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
}

export function searchResultMatchesExcludedTags(result, excludedTags) {
  if (!excludedTags.length) {
    return false;
  }
  const resultTags = cleanTagList(result.tags).map(normalizeTag);
  const title = normalizeTag(result.title);
  return excludedTags.some((excludedTag) => {
    const excluded = normalizeTag(excludedTag);
    const excludedValue = normalizedTagValue(excluded);
    const tagMatch = resultTags.some((tag) => tag === excluded || (!excluded.includes(":") && normalizedTagValue(tag) === excludedValue));
    if (tagMatch) {
      return true;
    }
    return !resultTags.length && excludedValue.length >= 2 && title.includes(excludedValue);
  });
}
