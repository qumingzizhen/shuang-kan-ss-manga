import assert from "node:assert/strict";
import { executeSearchPipeline } from "../services/dev-api/search-pipeline.mjs";

const sources = [
  { id: "one", name: "One" },
  { id: "two", name: "Two" },
  { id: "three", name: "Three" },
];
let activeSources = 0;
let maxActiveSources = 0;

const report = await executeSearchPipeline({
  sources,
  request: { excluded_tags: ["blocked"] },
  sourceConcurrency: 2,
  enrichConcurrency: 2,
  async searchSource(source) {
    activeSources += 1;
    maxActiveSources = Math.max(maxActiveSources, activeSources);
    await new Promise((resolve) => setTimeout(resolve, 40));
    activeSources -= 1;
    if (source.id === "three") {
      throw new Error("offline");
    }
    return {
      results: [
        { url: `https://${source.id}.test/keep`, title: `${source.name} keep`, tags: ["safe"] },
        { url: `https://${source.id}.test/drop`, title: `${source.name} drop`, tags: [] },
        { url: `https://${source.id}.test/keep`, title: "duplicate", tags: ["safe"] },
      ],
    };
  },
  async enrichResult(_source, item) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { tags: item.gallery_url.endsWith("/drop") ? ["blocked"] : ["safe"] };
  },
});

assert.equal(maxActiveSources, 2, "source searches should respect bounded concurrency");
assert.deepEqual(
  report.results.map((item) => item.gallery_url),
  ["https://one.test/keep", "https://two.test/keep"],
  "results should preserve source order, exclude blocked items, and remove duplicates",
);
assert.equal(report.excludedCount, 2);
assert.deepEqual(report.sourceErrors, [{ source_id: "three", source_name: "Three", message: "offline" }]);

console.log(JSON.stringify({ ok: true, max_active_sources: maxActiveSources, results: report.results.length }));
