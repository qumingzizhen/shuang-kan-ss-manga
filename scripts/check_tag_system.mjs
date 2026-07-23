import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanTagList, searchResultMatchesExcludedTags } from "../services/dev-api/search-filter.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const dictionary = JSON.parse(await readFile(resolve(projectRoot, "apps/web/src/lib/tag-translations.json"), "utf8"));
const metadata = JSON.parse(await readFile(resolve(projectRoot, "apps/web/src/lib/tag-translations.meta.json"), "utf8"));

assert.ok(dictionary.length >= 1000, `expected at least 1000 translated tags, received ${dictionary.length}`);
assert.equal(metadata.entry_count, dictionary.length);
assert.match(String(metadata.upstream_sha), /^[0-9a-f]{40}$/);

const canonical = new Set();
for (const item of dictionary) {
  assert.equal(typeof item.canonical, "string");
  assert.equal(typeof item.zh, "string");
  assert.ok(item.canonical.includes(":"), `missing namespace: ${item.canonical}`);
  assert.ok(item.zh.trim(), `missing Chinese display name: ${item.canonical}`);
  assert.ok(!canonical.has(item.canonical.toLowerCase()), `duplicate canonical tag: ${item.canonical}`);
  if (item.source_terms !== undefined) {
    assert.equal(typeof item.source_terms, "object");
    for (const terms of Object.values(item.source_terms)) {
      assert.ok(Array.isArray(terms) && terms.every((term) => typeof term === "string" && term.trim()));
    }
  }
  canonical.add(item.canonical.toLowerCase());
}

const bigBreasts = dictionary.find((item) => item.canonical === "female:big breasts");
assert.ok(bigBreasts, "female:big breasts mapping is required");
assert.ok([bigBreasts.zh, ...(bigBreasts.aliases || [])].some((value) => /巨乳|大胸/.test(value)), "Chinese big-breasts mapping is required");
assert.ok(bigBreasts.source_terms?.["18comic"]?.includes("巨乳"), "18comic big-breasts mapping is required");

assert.deepEqual(cleanTagList([" female:big breasts ", "Female:Big   Breasts", "", null]), ["female:big breasts"]);
assert.equal(
  searchResultMatchesExcludedTags({ title: "sample", tags: ["female:big breasts", "language:chinese"] }, ["female:big breasts"]),
  true,
);
assert.equal(searchResultMatchesExcludedTags({ title: "sample", tags: ["female:big breasts"] }, ["big breasts"]), true);
assert.equal(searchResultMatchesExcludedTags({ title: "sample", tags: ["female:huge breasts"] }, ["big breasts"]), false);
assert.equal(searchResultMatchesExcludedTags({ title: "Big Breasts Collection", tags: [] }, ["big breasts"]), true);
assert.equal(searchResultMatchesExcludedTags({ title: "Big Breasts Collection", tags: ["language:english"] }, ["big breasts"]), false);
assert.equal(
  searchResultMatchesExcludedTags({ title: "sample", tags: [bigBreasts.zh, "language:chinese"] }, [
    bigBreasts.canonical,
    bigBreasts.zh,
    ...(bigBreasts.aliases || []),
    ...Object.values(bigBreasts.source_terms || {}).flat(),
  ]),
  true,
);

console.log(
  JSON.stringify({ ok: true, dictionary_entries: dictionary.length, upstream_sha: metadata.upstream_sha, filtering_cases: 6 }),
);
