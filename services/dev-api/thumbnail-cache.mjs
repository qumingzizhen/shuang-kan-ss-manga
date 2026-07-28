import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isPrivateHostname, validateThumbnailUrl } from "./thumbnail-policy.mjs";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const retryableStatuses = new Set([404, 408, 425, 429, 500, 502, 503, 504]);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const avifBrands = new Set(["avif", "avis"]);

class RetryableThumbnailError extends Error {}

export function normalizeThumbnailInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const safeFallback = Math.max(minimum, Math.min(Number(fallback) || minimum, maximum));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : safeFallback;
}

export function isRetryableThumbnailStatus(status) {
  return retryableStatuses.has(Number(status));
}

export function detectImageMimeType(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(pngSignature)) {
    return "image/png";
  }
  const gifSignature = data.subarray(0, 6).toString("ascii");
  if (data.length >= 6 && (gifSignature === "GIF87a" || gifSignature === "GIF89a")) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") {
    const brandLimit = Math.min(data.length, 32);
    for (let offset = 8; offset + 4 <= brandLimit; offset += 4) {
      if (avifBrands.has(data.subarray(offset, offset + 4).toString("ascii").toLowerCase())) {
        return "image/avif";
      }
    }
  }
  return null;
}

export function thumbnailRetryDelayMs(attempt, baseDelayMs) {
  const safeAttempt = Math.max(0, Math.trunc(Number(attempt) || 0));
  const safeBase = Math.max(0, Math.trunc(Number(baseDelayMs) || 0));
  return Math.min(5000, safeBase * 2 ** safeAttempt);
}

export function createSearchThumbnailCache({
  cacheDir,
  singleFlight,
  timeoutMs = 10000,
  maxBytes = 5 * 1024 * 1024,
  maxAttempts = 3,
  retryBaseDelayMs = 350,
  minimumImageBytes = 64,
  fetchImpl = fetch,
  lookupImpl = lookup,
} = {}) {
  if (!cacheDir || typeof cacheDir !== "string") {
    throw new TypeError("thumbnail cacheDir is required");
  }
  if (!singleFlight || typeof singleFlight.run !== "function") {
    throw new TypeError("thumbnail singleFlight runner is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("thumbnail fetchImpl must be a function");
  }
  if (typeof lookupImpl !== "function") {
    throw new TypeError("thumbnail lookupImpl must be a function");
  }

  const root = resolve(cacheDir);
  const requestTimeoutMs = normalizeThumbnailInteger(timeoutMs, 10000, 1000, 60000);
  const responseLimitBytes = normalizeThumbnailInteger(maxBytes, 5 * 1024 * 1024, 1024, 50 * 1024 * 1024);
  const attemptLimit = normalizeThumbnailInteger(maxAttempts, 3, 1, 5);
  const retryDelayMs = normalizeThumbnailInteger(retryBaseDelayMs, 350, 0, 5000);
  const usableImageBytes = normalizeThumbnailInteger(minimumImageBytes, 64, 16, 4096);
  const metrics = {
    requests: 0,
    hits: 0,
    misses: 0,
    shared: 0,
    downloads: 0,
    retries: 0,
  };

  async function getEntry(source, thumbnailUrl, referer) {
    metrics.requests += 1;
    if (!source || typeof source.id !== "string" || !source.id.trim()) {
      throw new TypeError("thumbnail source with a stable id is required");
    }
    const parsed = validateThumbnailUrl(source, thumbnailUrl);
    const cacheFile = cacheFileFor(root, source.id, parsed.href);
    if (!isPathInside(cacheFile, root)) {
      throw new Error("thumbnail cache path is outside the configured cache root");
    }

    if (singleFlight.has(cacheFile)) {
      metrics.shared += 1;
    }

    const metadata = await singleFlight.run(cacheFile, async () => {
      const cached = await inspectCachedImage(cacheFile, usableImageBytes);
      if (cached) {
        metrics.hits += 1;
        return { ...cached, cacheStatus: "hit" };
      }
      metrics.misses += 1;
      await fetchAndCacheWithRetry({
        source,
        thumbnailUrl: parsed.href,
        referer,
        cacheFile,
        timeoutMs: requestTimeoutMs,
        maxBytes: responseLimitBytes,
        maxAttempts: attemptLimit,
        retryBaseDelayMs: retryDelayMs,
        minimumImageBytes: usableImageBytes,
        onRetry: () => {
          metrics.retries += 1;
        },
        fetchImpl,
        lookupImpl,
      });
      metrics.downloads += 1;
      const downloaded = await inspectCachedImage(cacheFile, usableImageBytes);
      if (!downloaded) {
        throw new Error("thumbnail cache file failed post-write validation");
      }
      return { ...downloaded, cacheStatus: "miss" };
    });
    return { filePath: cacheFile, ...metadata };
  }

  async function get(source, thumbnailUrl, referer) {
    return (await getEntry(source, thumbnailUrl, referer)).filePath;
  }

  function stats() {
    return { ...metrics, in_flight: Array.from(singleFlight.entries()).length };
  }

  return { get, getEntry, stats };
}

async function inspectCachedImage(cacheFile, minimumImageBytes) {
  try {
    const cached = await stat(cacheFile);
    if (!cached.isFile() || cached.size < minimumImageBytes) {
      if (cached.isFile()) {
        await unlink(cacheFile);
      }
      return null;
    }

    const file = await open(cacheFile, "r");
    let bytesRead = 0;
    const header = Buffer.alloc(32);
    try {
      ({ bytesRead } = await file.read(header, 0, header.length, 0));
    } finally {
      await file.close();
    }
    const mimeType = detectImageMimeType(header.subarray(0, bytesRead));
    if (!mimeType) {
      await unlink(cacheFile);
      return null;
    }
    return { size: cached.size, mimeType };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fetchAndCacheWithRetry(options) {
  await mkdir(dirname(options.cacheFile), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    try {
      await fetchAndCacheAttempt(options);
      return;
    } catch (error) {
      lastError = error;
      if (!(error instanceof RetryableThumbnailError) || attempt + 1 >= options.maxAttempts) {
        throw error;
      }
      options.onRetry?.(attempt + 1, error);
      await delay(thumbnailRetryDelayMs(attempt, options.retryBaseDelayMs));
    }
  }
  throw lastError || new Error("thumbnail fetch failed");
}

async function fetchAndCacheAttempt(options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers = {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8",
      "user-agent": "comic-platform-dev-api/0.1 (+local thumbnail cache)",
    };
    const referer = safeThumbnailReferer(options.source, options.referer);
    if (referer) {
      headers.referer = referer;
    }

    const remote = await fetchThumbnailResponse({
      source: options.source,
      thumbnailUrl: options.thumbnailUrl,
      headers,
      signal: controller.signal,
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
    });
    if (!remote.ok) {
      await remote.body?.cancel().catch(() => undefined);
      const message = `thumbnail fetch failed with HTTP ${remote.status}`;
      if (isRetryableThumbnailStatus(remote.status)) {
        throw new RetryableThumbnailError(message);
      }
      throw new Error(message);
    }

    const contentType = String(remote.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      await remote.body?.cancel().catch(() => undefined);
      throw new RetryableThumbnailError(`thumbnail fetch returned non-image content-type: ${contentType}`);
    }

    let body;
    try {
      body = await readResponseBodyLimited(remote, options.maxBytes);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new RetryableThumbnailError(`thumbnail fetch timed out after ${options.timeoutMs}ms`);
      }
      throw error;
    }
    if (body.length < options.minimumImageBytes) {
      throw new RetryableThumbnailError("thumbnail response is too small to be a usable image");
    }
    if (!detectImageMimeType(body)) {
      throw new RetryableThumbnailError("thumbnail response does not have a supported image signature");
    }

    const temporary = `${options.cacheFile}.${process.pid}.${Date.now()}.part`;
    try {
      await writeFile(temporary, body);
      await rename(temporary, options.cacheFile);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchThumbnailResponse(options, redirectCount = 0) {
  const parsed = validateThumbnailUrl(options.source, options.thumbnailUrl);
  await assertPublicHostname(parsed.hostname, options.lookupImpl);
  let remote;
  try {
    remote = await options.fetchImpl(parsed, { headers: options.headers, redirect: "manual", signal: options.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new RetryableThumbnailError("thumbnail fetch timed out");
    }
    if (error instanceof TypeError) {
      throw new RetryableThumbnailError(`thumbnail network request failed: ${error.message}`);
    }
    throw error;
  }

  if (!redirectStatuses.has(remote.status)) {
    return remote;
  }
  await remote.body?.cancel().catch(() => undefined);
  if (redirectCount >= 3) {
    throw new Error("thumbnail fetch exceeded the redirect limit");
  }
  const location = remote.headers.get("location");
  if (!location) {
    throw new Error("thumbnail redirect did not include a location");
  }
  return fetchThumbnailResponse(
    { ...options, thumbnailUrl: new URL(location, parsed).href },
    redirectCount + 1,
  );
}

async function assertPublicHostname(hostname, lookupImpl) {
  let addresses;
  try {
    addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new RetryableThumbnailError(`thumbnail DNS lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!addresses.length || addresses.some((entry) => isPrivateHostname(entry.address))) {
    throw new Error("thumbnail host resolves to a private or local address");
  }
}

async function readResponseBodyLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`thumbnail response is too large: ${declaredLength} bytes`);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`thumbnail response is too large: more than ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function cacheFileFor(cacheDir, sourceId, thumbnailUrl) {
  const hash = createHash("sha256").update(`${sourceId}|${thumbnailUrl}`).digest("hex");
  const pathname = new URL(thumbnailUrl).pathname.toLowerCase();
  const match = pathname.match(/\.(avif|gif|jpe?g|png|webp)$/i);
  const extension = match ? match[0].replace(".jpeg", ".jpg") : ".img";
  return resolve(cacheDir, String(sourceId), `${hash}${extension}`);
}

function isPathInside(candidate, root) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

function safeThumbnailReferer(source, referer) {
  const candidates = [referer, source?.homepage];
  for (const candidate of candidates) {
    try {
      if (candidate) {
        return validateThumbnailUrl(source, String(candidate)).href;
      }
    } catch {
      // Invalid or unrelated referers are ignored rather than forwarded to a remote CDN.
    }
  }
  return null;
}

function delay(milliseconds) {
  return milliseconds > 0 ? new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)) : Promise.resolve();
}
