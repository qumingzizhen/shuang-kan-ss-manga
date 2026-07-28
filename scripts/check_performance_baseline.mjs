import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compareNaturalPageNames, inspectImageBytes } from "../services/dev-api/library-index.mjs";
import { mergeSearchResults } from "../services/dev-api/search-results.mjs";

const searchInputs = Array.from({ length: 4 }, (_, sourceIndex) => ({
  results: Array.from({ length: 300 }, (_, index) => ({
    source_id: `source-${sourceIndex}`,
    gallery_url: `https://source-${sourceIndex}.test/g/${index}`,
    title: `作品 ${index}`,
    tags: ["language:chinese", `source:${sourceIndex}`],
    uploaded_at: new Date(Date.UTC(2026, 6, 28, 12, 0, 0) - index * 60_000).toISOString(),
    page_count: 20 + (index % 10),
  })),
  excludedCount: 0,
  error: null,
}));

const searchStarted = performance.now();
const merged = mergeSearchResults(searchInputs);
const searchMilliseconds = performance.now() - searchStarted;
assert.equal(merged.results.length, 1_200);

const pageNames = Array.from({ length: 20_000 }, (_, index) => `${20_000 - index}.jpg`);
const sortStarted = performance.now();
pageNames.sort(compareNaturalPageNames);
const sortMilliseconds = performance.now() - sortStarted;
assert.equal(pageNames[0], "1.jpg");
assert.equal(pageNames.at(-1), "20000.jpg");

const invalidPayload = Buffer.alloc(2_048, 0x20);
const validationStarted = performance.now();
for (let index = 0; index < 10_000; index += 1) {
  inspectImageBytes(invalidPayload);
}
const validationMilliseconds = performance.now() - validationStarted;

const limits = {
  searchMilliseconds: Number(process.env.PERF_SEARCH_LIMIT_MS || 2_500),
  sortMilliseconds: Number(process.env.PERF_SORT_LIMIT_MS || 2_000),
  validationMilliseconds: Number(process.env.PERF_VALIDATION_LIMIT_MS || 1_000),
};
assert.ok(searchMilliseconds <= limits.searchMilliseconds, `search merge took ${searchMilliseconds.toFixed(1)} ms`);
assert.ok(sortMilliseconds <= limits.sortMilliseconds, `natural sort took ${sortMilliseconds.toFixed(1)} ms`);
assert.ok(validationMilliseconds <= limits.validationMilliseconds, `image validation took ${validationMilliseconds.toFixed(1)} ms`);

console.log(
  JSON.stringify({
    ok: true,
    search_results: merged.results.length,
    page_names: pageNames.length,
    validations: 10_000,
    milliseconds: {
      search_merge: Number(searchMilliseconds.toFixed(2)),
      natural_sort: Number(sortMilliseconds.toFixed(2)),
      image_validation: Number(validationMilliseconds.toFixed(2)),
    },
    limits,
  }),
);
