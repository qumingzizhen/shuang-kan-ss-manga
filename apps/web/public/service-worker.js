/* Reader image cache: serve online-reader page images from the browser cache
   first and refresh them in the background (stale-while-revalidate). Only
   same-origin reader page requests are intercepted; everything else passes
   through untouched. */
const READER_CACHE_NAME = "reader-images-v1";
const READER_CACHE_MAX_ENTRIES = 600;
const READER_PAGE_PATH_PATTERN = /^\/v1\/reader\/sessions\/[^/]+\/pages\/\d+$/;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== READER_CACHE_NAME).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "clear-reader-cache") {
    return;
  }
  event.waitUntil(
    caches
      .delete(READER_CACHE_NAME)
      .then(() => caches.open(READER_CACHE_NAME))
      .catch((error) => {
        console.error(`reader cache clear failed in service worker: ${error instanceof Error ? error.message : String(error)}`);
      }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !READER_PAGE_PATH_PATTERN.test(url.pathname)) {
    return;
  }
  event.respondWith(handleReaderImageRequest(event, request, url));
});

async function handleReaderImageRequest(event, request, url) {
  const cache = await caches.open(READER_CACHE_NAME);
  const forceRefresh = url.searchParams.has("reader_retry") || url.searchParams.get("refresh") === "1";
  if (forceRefresh) {
    await cache.delete(request);
    return fetchAndCacheReaderImage(request, cache);
  }

  const cached = await cache.match(request);
  if (cached) {
    event.waitUntil(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            await cache.put(request, fresh.clone());
          }
        } catch (error) {
          console.error(
            `reader cache background refresh failed for ${request.url}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })(),
    );
    return cached;
  }

  try {
    return await fetchAndCacheReaderImage(request, cache);
  } catch (error) {
    const fallback = await cache.match(request);
    if (fallback) {
      return fallback;
    }
    console.error(`reader image fetch failed for ${request.url}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function fetchAndCacheReaderImage(request, cache) {
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimReaderCache(cache);
  }
  return response;
}

async function trimReaderCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= READER_CACHE_MAX_ENTRIES) {
    return;
  }
  await cache.delete(keys[0]);
}
