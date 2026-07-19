import tagTranslationsData from "@/lib/tag-translations.json";
import type { TaskSearchResult } from "@/lib/api";

export type TagTranslation = {
  canonical: string;
  zh: string;
  aliases: string[];
};

export const globalExcludedTagsStorageKey = "manga-platform.global-excluded-tags";

export const tagTranslations = tagTranslationsData as TagTranslation[];

const tagTranslationLookup = new Map<string, TagTranslation[]>();

for (const translation of tagTranslations) {
  for (const term of [translation.canonical, translation.zh, ...translation.aliases]) {
    const normalized = normalizeTag(term);
    const matches = tagTranslationLookup.get(normalized) ?? [];
    if (!matches.some((item) => item.canonical === translation.canonical)) {
      matches.push(translation);
      tagTranslationLookup.set(normalized, matches);
    }
  }
}

export function normalizeTag(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function uniqueTags(values: string[]) {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim().replace(/\s+/g, " "))
    .filter((value) => {
      const normalized = normalizeTag(value);
      if (!normalized || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    });
}

export function tagValue(value: string) {
  const normalized = normalizeTag(value);
  const separator = normalized.indexOf(":");
  return separator >= 0 ? normalized.slice(separator + 1).trim() : normalized;
}

export function translationsForTag(value: string) {
  return tagTranslationLookup.get(normalizeTag(value)) ?? [];
}

export function canonicalTag(value: string) {
  return translationsForTag(value)[0]?.canonical ?? value.trim().replace(/\s+/g, " ");
}

export function expandExcludedTags(values: string[]) {
  const expanded: string[] = [];
  for (const value of values) {
    const translations = translationsForTag(value);
    if (!translations.length) {
      expanded.push(value);
      continue;
    }
    for (const translation of translations) {
      expanded.push(translation.canonical, translation.zh, ...translation.aliases);
    }
  }
  return uniqueTags(expanded);
}

export function searchResultMatchesExcludedTag(result: Pick<TaskSearchResult, "tags" | "title">, excludedTag: string) {
  const excluded = normalizeTag(excludedTag);
  if (!excluded) {
    return false;
  }

  const excludedValue = tagValue(excluded);
  const tags = (result.tags ?? []).map(normalizeTag);
  const tagMatch = tags.some((tag) => tag === excluded || (!excluded.includes(":") && tagValue(tag) === excludedValue));
  if (tagMatch) {
    return true;
  }

  if (tags.length) {
    return false;
  }

  const title = normalizeTag(result.title);
  return excludedValue.length >= 2 && title.includes(excludedValue);
}

export function filterSearchResults(results: TaskSearchResult[], excludedTags: string[]) {
  if (!excludedTags.length) {
    return results;
  }
  const expandedExcludedTags = expandExcludedTags(excludedTags);
  return results.filter((result) => !expandedExcludedTags.some((excludedTag) => searchResultMatchesExcludedTag(result, excludedTag)));
}

function normalizedSuggestionTerms(item: TagTranslation) {
  return [item.zh, item.canonical, ...item.aliases].map(normalizeTag);
}

function suggestionScore(item: TagTranslation, query: string) {
  const terms = normalizedSuggestionTerms(item);
  if (terms.some((term) => term === query)) return 0;
  if (normalizeTag(item.zh).startsWith(query)) return 1;
  if (terms.some((term) => term.startsWith(query))) return 2;
  if (terms.some((term) => term.includes(query))) return 3;
  return Number.POSITIVE_INFINITY;
}

export function suggestTags(query: string, excludedCanonical: string[] = [], limit = 8) {
  const normalizedQuery = normalizeTag(query);
  if (!normalizedQuery) {
    return [];
  }
  const excluded = new Set(excludedCanonical.map(normalizeTag));
  return tagTranslations
    .map((item, index) => ({ item, index, score: suggestionScore(item, normalizedQuery) }))
    .filter(({ item, score }) => Number.isFinite(score) && !excluded.has(normalizeTag(item.canonical)))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

export function activeTagFragment(value: string) {
  const match = value.match(/([^\s,，;；\n]+)$/u);
  return match ? { text: match[1], start: value.length - match[1].length } : { text: "", start: value.length };
}

export function replaceActiveTagFragment(value: string, suggestion: TagTranslation) {
  const normalizedValue = normalizeTag(value);
  const matchingSuffix = normalizedSuggestionTerms(suggestion)
    .filter((term) => normalizedValue.endsWith(term))
    .sort((left, right) => right.length - left.length)[0];
  const fallback = activeTagFragment(value);
  const start = matchingSuffix ? value.length - matchingSuffix.length : fallback.start;
  return `${value.slice(0, start)}${suggestion.canonical} `;
}
