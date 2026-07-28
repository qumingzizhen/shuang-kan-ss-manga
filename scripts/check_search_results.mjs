import assert from "node:assert/strict";
import {
  mergeSearchResults,
  normalizeGalleryUrl,
  normalizeUploadedAt,
} from "../services/dev-api/search-results.mjs";

assert.equal(normalizeUploadedAt("2026-07-28 10:00"), "2026-07-28T10:00:00.000Z");
assert.equal(normalizeUploadedAt("2026-07-28T10:00:00+08:00"), "2026-07-28T02:00:00.000Z");
assert.equal(
  normalizeGalleryUrl("HTTPS://Example.Test/g/1/?utm_source=test&b=2&a=1#top"),
  "https://example.test/g/1?a=1&b=2",
);

const merged = mergeSearchResults([
  {
    results: [
      {
        source_id: "one",
        gallery_url: "https://one.test/g/1/?utm_source=x",
        title: "[Circle] Shared work [翻译]",
        tags: ["language:chinese"],
        thumbnail_url: null,
        uploader: null,
        uploaded_at: "2026-07-27T00:00:00.000Z",
        category: null,
        page_count: 20,
        rating: null,
      },
      {
        source_id: "one",
        gallery_url: "https://one.test/g/1",
        title: "same URL",
        tags: [],
        thumbnail_url: "https://one.test/1.jpg",
        uploader: null,
        uploaded_at: null,
        category: null,
        page_count: 20,
        rating: null,
      },
    ],
  },
  {
    results: [
      {
        source_id: "two",
        gallery_url: "https://two.test/gallery/9",
        title: "[Circle] Shared work [translated]",
        tags: ["artist:fixture"],
        thumbnail_url: "https://two.test/9.jpg",
        uploader: "uploader",
        uploaded_at: "2026-07-28T00:00:00.000Z",
        category: "doujinshi",
        page_count: 20,
        rating: 4.5,
      },
      {
        source_id: "three",
        gallery_url: "https://three.test/gallery/10",
        title: "[Circle] Shared work [translated]",
        tags: [],
        thumbnail_url: null,
        uploader: null,
        uploaded_at: "2026-07-29T00:00:00.000Z",
        category: null,
        page_count: 21,
        rating: null,
      },
    ],
  },
]);

assert.equal(merged.results.length, 2, "same URL and cross-source soft duplicates should merge");
assert.equal(merged.results[0].page_count, 21, "different page counts must remain separate");
assert.equal(merged.results[1].source_id, "two", "the richer downloadable source should be retained");
assert.deepEqual(
  merged.results[1].tags,
  ["artist:fixture", "language:chinese"],
  "merged metadata should retain tags from both sources",
);
console.log(JSON.stringify({ ok: true, utc: true, normalized_urls: true, soft_dedupe: true }));
