import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanSearchThumbnailUrl,
  isAllowedThumbnailHost,
  isBadSearchThumbnailUrl,
  isPrivateHostname,
  validateThumbnailUrl,
} from "../services/dev-api/thumbnail-policy.mjs";
import {
  createSearchThumbnailCache,
  isRetryableThumbnailStatus,
  normalizeThumbnailInteger,
  thumbnailRetryDelayMs,
} from "../services/dev-api/thumbnail-cache.mjs";
import { createSingleFlight } from "../services/dev-api/async-pool.mjs";

const source = {
  id: "fixture",
  homepage: "https://example.org/",
  thumbnail_hosts: ["cdn.example.net"],
};

for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
  assert.equal(isPrivateHostname(host), true, `${host} should be private`);
}
assert.equal(isPrivateHostname("1.1.1.1"), false);
assert.equal(isAllowedThumbnailHost(source, "cdn.example.net"), true);
assert.equal(isAllowedThumbnailHost(source, "img.cdn.example.net"), true);
assert.equal(isAllowedThumbnailHost(source, "example.org"), true);
assert.equal(isAllowedThumbnailHost(source, "attacker.test"), false);
assert.equal(validateThumbnailUrl(source, "https://cdn.example.net/image.jpg").hostname, "cdn.example.net");
assert.throws(() => validateThumbnailUrl(source, "http://127.0.0.1/image.jpg"), /private or local/);
assert.throws(() => validateThumbnailUrl(source, "https://attacker.test/image.jpg"), /not allowed/);
assert.equal(cleanSearchThumbnailUrl(" https://cdn.example.net/cover.jpg "), "https://cdn.example.net/cover.jpg");
assert.equal(cleanSearchThumbnailUrl("https://cdn.example.net/loading.gif"), null);
assert.equal(isBadSearchThumbnailUrl("https://cdn.example.net/cover.jpg"), false);
assert.equal(isRetryableThumbnailStatus(503), true);
assert.equal(isRetryableThumbnailStatus(404), false);
assert.equal(normalizeThumbnailInteger("99", 3, 1, 5), 5);
assert.equal(thumbnailRetryDelayMs(2, 100), 400);

const cacheRoot = await mkdtemp(join(tmpdir(), "manga-thumbnail-test-"));
let fetchCalls = 0;
try {
  const singleFlight = createSingleFlight();
  const cache = createSearchThumbnailCache({
    cacheDir: cacheRoot,
    singleFlight,
    timeoutMs: 1000,
    maxAttempts: 3,
    retryBaseDelayMs: 0,
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response(null, { status: 503 });
      }
      return new Response(Buffer.alloc(128, 1), { status: 200, headers: { "content-type": "image/jpeg" } });
    },
    lookupImpl: async () => [{ address: "1.1.1.1", family: 4 }],
  });
  const requests = [
    cache.get(source, "https://cdn.example.net/cover.jpg", "https://example.org/gallery/1"),
    cache.get(source, "https://cdn.example.net/cover.jpg", "https://example.org/gallery/1"),
  ];
  const [firstFile, secondFile] = await Promise.all(requests);
  assert.equal(firstFile, secondFile);
  assert.equal(fetchCalls, 2, "one retry should be shared by both concurrent callers");
  assert.equal((await readFile(firstFile)).length, 128);
  assert.equal(singleFlight.has(firstFile), false, "single-flight entry should be released after completion");
} finally {
  await rm(cacheRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, private_host_cases: 9, thumbnail_fetch_calls: fetchCalls }));
