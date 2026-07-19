import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectPythonEnvKeys,
  loadSourceAdapterRegistry,
  materializeSourceAdapters,
  publicSourceDescriptors,
} from "./source-registry.mjs";
import { cleanTagList, searchResultMatchesExcludedTags } from "./search-filter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const port = Number(process.env.DEV_API_PORT || process.env.PORT || 8080);
const sourceAdapterConfigFile = process.env.SOURCE_ADAPTER_CONFIG || join(projectRoot, "config", "source-adapters.json");
const sourceAdapterRegistry = loadSourceAdapterRegistry(sourceAdapterConfigFile);
const defaultSourceId = String(sourceAdapterRegistry.default_source_id || "fangliding").trim() || "fangliding";
const defaultPython = resolvePython(collectPythonEnvKeys(sourceAdapterRegistry));
const libraryExportScript = process.env.LIBRARY_EXPORT_SCRIPT || join(projectRoot, "scripts", "library_export.py");
const libraryPdfExportScript = process.env.LIBRARY_PDF_EXPORT_SCRIPT || join(projectRoot, "scripts", "library_pdf_export.py");
const dataDir = process.env.DEV_API_DATA_DIR || join(projectRoot, ".data", "dev-api");
const libraryCbzExportsDir = process.env.DEV_API_LIBRARY_EXPORT_DIR || join(projectRoot, ".data", "exports", "cbz");
const libraryPdfExportsDir = process.env.DEV_API_LIBRARY_PDF_EXPORT_DIR || join(projectRoot, ".data", "exports", "pdf");
const tasksFile = join(dataDir, "tasks.json");
const libraryExportsFile = join(dataDir, "library-exports.jsonl");
const libraryShelfFile = join(dataDir, "library-shelf.json");
const readerSessionsFile = join(dataDir, "reader-sessions.json");
const readerPageCacheDir = process.env.DEV_API_READER_PAGE_CACHE_DIR || join(projectRoot, ".data", "page-cache");
const searchThumbnailCacheDir = process.env.DEV_API_SEARCH_THUMBNAIL_CACHE_DIR || join(projectRoot, ".data", "thumbnail-cache");
const sourceAuthDir = process.env.DEV_API_SOURCE_AUTH_DIR || join(projectRoot, ".data", "source-auth");
const libraryRoots = resolveLibraryRoots();
const bridgeProgressPrefix = "__COMIC_PLATFORM_PROGRESS__";
const defaultBridgeTimeoutMs = Number(process.env.DEV_API_BRIDGE_TIMEOUT_MS || 30 * 60 * 1000);
const orphanedRunningTaskMs = Number(process.env.DEV_API_ORPHANED_RUNNING_TASK_MS || 5 * 60 * 1000);
const librarySuspiciousImageBytes = Number(process.env.DEV_API_LIBRARY_SUSPICIOUS_IMAGE_BYTES || 2048);
const searchThumbnailTimeoutMs = Number(process.env.DEV_API_SEARCH_THUMBNAIL_TIMEOUT_MS || 10000);
const searchThumbnailMaxBytes = Number(process.env.DEV_API_SEARCH_THUMBNAIL_MAX_BYTES || 5 * 1024 * 1024);
const galleryDownloadConcurrency = Number(process.env.DEV_API_GALLERY_DOWNLOAD_CONCURRENCY || 0);

const tasks = new Map();
const libraryShelf = new Map();
const readerSessions = new Map();
const readerPageFailures = new Map();
const history = [];
const subscribers = new Set();
const runningChildren = new Map();
let saveChain = Promise.resolve();
let readerSessionSaveChain = Promise.resolve();

const sourceAuthSpecs = {
  "18comic": {
    cookieEnv: "COMIC18_COOKIE_FILE",
    headersEnv: "COMIC18_HEADERS_FILE",
    cookieFile: join(sourceAuthDir, "18comic.cookies.txt"),
    headersFile: join(sourceAuthDir, "18comic.headers.txt"),
  },
};

const sourceAdapters = materializeSourceAdapters(sourceAdapterRegistry, projectRoot, resolvePython);
await refreshManagedSourceAuthEnv();
let sources = publicSourceDescriptors(sourceAdapters);
const sourceById = new Map(sourceAdapters.map((item) => [item.id, item]));
if (!sourceById.has(defaultSourceId)) {
  throw new Error(`default source adapter is not registered: ${defaultSourceId}`);
}

await loadPersistedTasks();
await loadLibraryShelf();
await loadReaderSessions();

const server = createServer(async (request, response) => {
  try {
    setCors(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { status: "ok", service: "comic-platform-dev-api" });
      return;
    }

    if (request.method === "GET" && path === "/v1/sources") {
      await refreshManagedSourceAuthEnv();
      sources = publicSourceDescriptors(sourceAdapters);
      sendJson(response, 200, sources);
      return;
    }

    const sourceAuthMatch = path.match(/^\/v1\/source-auth\/([^/]+)$/);
    if (sourceAuthMatch && request.method === "GET") {
      sendJson(response, 200, await sourceAuthStatus(decodeURIComponent(sourceAuthMatch[1])));
      return;
    }

    if (sourceAuthMatch && request.method === "PUT") {
      try {
        sendJson(response, 200, await saveSourceAuth(decodeURIComponent(sourceAuthMatch[1]), await readJson(request)));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (sourceAuthMatch && request.method === "DELETE") {
      try {
        sendJson(response, 200, await deleteSourceAuth(decodeURIComponent(sourceAuthMatch[1])));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "GET" && path === "/v1/search-thumbnails") {
      await sendSearchThumbnail(response, url.searchParams);
      return;
    }

    if (request.method === "POST" && path === "/v1/reader/sessions") {
      try {
        const session = await createReaderSession(await readJson(request));
        sendJson(response, 200, session);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "GET" && path === "/v1/reader/sessions") {
      sendJson(response, 200, listReaderSessions());
      return;
    }

    const readerSessionMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)$/);
    if (readerSessionMatch && request.method === "GET") {
      const session = readerSessions.get(readerSessionMatch[1]);
      sendJson(response, session ? 200 : 404, session ? readerSessionResponse(session, 0, 24) : { error: "reader session not found" });
      return;
    }

    if (readerSessionMatch && request.method === "DELETE") {
      const result = await deleteReaderSession(readerSessionMatch[1]);
      sendJson(response, result ? 200 : 404, result || { error: "reader session not found" });
      return;
    }

    const readerSessionBookmarkMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/bookmarks$/);
    if (readerSessionBookmarkMatch && request.method === "POST") {
      try {
        const result = upsertReaderBookmark(readerSessionBookmarkMatch[1], await readJson(request));
        sendJson(response, result ? 200 : 404, result || { error: "reader session not found" });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const readerSessionBookmarkDeleteMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/bookmarks\/(\d+)$/);
    if (readerSessionBookmarkDeleteMatch && request.method === "DELETE") {
      const result = deleteReaderBookmark(readerSessionBookmarkDeleteMatch[1], Number(readerSessionBookmarkDeleteMatch[2]));
      sendJson(response, result ? 200 : 404, result || { error: "reader session or bookmark not found" });
      return;
    }

    const readerSessionCacheClearMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/cache\/clear$/);
    if (readerSessionCacheClearMatch && request.method === "POST") {
      try {
        const result = await clearReaderSessionCache(readerSessionCacheClearMatch[1], await readJson(request, { optional: true }));
        sendJson(response, result ? 200 : 404, result || { error: "reader session not found" });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const readerSessionProgressMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/progress$/);
    if (readerSessionProgressMatch && request.method === "PATCH") {
      try {
        const result = updateReaderSessionProgress(readerSessionProgressMatch[1], await readJson(request));
        sendJson(response, result ? 200 : 404, result || { error: "reader session not found" });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const readerSessionPagesMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/pages$/);
    if (readerSessionPagesMatch && request.method === "GET") {
      const pages = getReaderSessionPageBatch(readerSessionPagesMatch[1], url.searchParams);
      sendJson(response, pages ? 200 : 404, pages || { error: "reader session not found" });
      return;
    }

    const readerSessionPageStatusesMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/pages\/status$/);
    if (readerSessionPageStatusesMatch && request.method === "GET") {
      const pageStatuses = await getReaderPageStatusBatch(readerSessionPageStatusesMatch[1], url.searchParams);
      sendJson(response, pageStatuses ? 200 : 404, pageStatuses || { error: "reader session not found" });
      return;
    }

    const readerSessionPageStatusMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/pages\/(\d+)\/status$/);
    if (readerSessionPageStatusMatch && request.method === "GET") {
      const pageStatus = await getReaderPageStatus(readerSessionPageStatusMatch[1], Number(readerSessionPageStatusMatch[2]));
      sendJson(response, pageStatus ? 200 : 404, pageStatus || { error: "reader page not found" });
      return;
    }

    const readerSessionPageMatch = path.match(/^\/v1\/reader\/sessions\/([^/]+)\/pages\/(\d+)$/);
    if (readerSessionPageMatch && request.method === "GET") {
      const sessionId = readerSessionPageMatch[1];
      const pageIndex = Number(readerSessionPageMatch[2]);
      const forceRefresh = url.searchParams.has("reader_retry") || url.searchParams.get("refresh") === "1";
      try {
        const page = await resolveReaderPageFile(sessionId, pageIndex, { forceRefresh });
        if (!page) {
          recordReaderPageFailure(sessionId, pageIndex, "reader page not found");
          sendJson(response, 404, { error: "reader page not found" });
          return;
        }
        clearReaderPageFailure(sessionId, pageIndex);
        sendFile(response, page.filePath, page.mimeType, page.fileStat, {
          "cache-control": "private, max-age=3600",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordReaderPageFailure(sessionId, pageIndex, message);
        sendJson(response, 502, { error: message });
      }
      return;
    }

    if (request.method === "GET" && path === "/v1/library") {
      sendJson(response, 200, await listLibrary(parseLibraryFilters(url.searchParams)));
      return;
    }

    if (request.method === "GET" && path === "/v1/library/tags") {
      sendJson(response, 200, await listLibraryTags(url.searchParams));
      return;
    }

    const libraryPagesListMatch = path.match(/^\/v1\/library\/([^/]+)\/pages$/);
    if (libraryPagesListMatch && request.method === "GET") {
      const pages = await getLibraryPages(libraryPagesListMatch[1], url.searchParams);
      sendJson(response, pages ? 200 : 404, pages || { error: "library item not found" });
      return;
    }

    const libraryPageMatch = path.match(/^\/v1\/library\/([^/]+)\/pages\/([^/]+)$/);
    if (libraryPageMatch && request.method === "GET") {
      const page = await resolveLibraryPageFile(libraryPageMatch[1], libraryPageMatch[2]);
      if (!page) {
        sendJson(response, 404, { error: "library page not found" });
        return;
      }
      sendFile(response, page.filePath, page.mimeType, page.fileStat);
      return;
    }

    const libraryExportsMatch = path.match(/^\/v1\/library\/([^/]+)\/exports$/);
    if (libraryExportsMatch && request.method === "GET") {
      const exports = await listLibraryExports(libraryExportsMatch[1]);
      sendJson(response, exports ? 200 : 404, exports || { error: "library item not found" });
      return;
    }

    const libraryExportFileMatch = path.match(/^\/v1\/library\/([^/]+)\/exports\/([^/]+)\/file$/);
    if (libraryExportFileMatch && request.method === "GET") {
      const exportFile = await resolveLibraryExportFile(libraryExportFileMatch[1], libraryExportFileMatch[2]);
      if (!exportFile) {
        sendJson(response, 404, { error: "library export file not found" });
        return;
      }
      sendFile(response, exportFile.filePath, exportFile.mimeType, exportFile.fileStat, {
        "content-disposition": contentDispositionForDownload(exportFile.filename),
        "cache-control": "private, max-age=60",
      });
      return;
    }

    const libraryCbzExportMatch = path.match(/^\/v1\/library\/([^/]+)\/exports\/cbz$/);
    if (libraryCbzExportMatch && request.method === "POST") {
      const result = await createLibraryCbzExport(libraryCbzExportMatch[1]);
      sendJson(response, result ? 200 : 404, result || { error: "library item not found" });
      return;
    }

    const libraryPdfExportMatch = path.match(/^\/v1\/library\/([^/]+)\/exports\/pdf$/);
    if (libraryPdfExportMatch && request.method === "POST") {
      const result = await createLibraryPdfExport(libraryPdfExportMatch[1]);
      sendJson(response, result ? 200 : 404, result || { error: "library item not found" });
      return;
    }

    const libraryShelfMatch = path.match(/^\/v1\/library\/([^/]+)\/shelf$/);
    if (libraryShelfMatch && request.method === "PATCH") {
      try {
        const result = await updateLibraryShelf(libraryShelfMatch[1], await readJson(request));
        sendJson(response, result ? 200 : 404, result || { error: "library item not found" });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const libraryDetailMatch = path.match(/^\/v1\/library\/([^/]+)$/);
    if (libraryDetailMatch && request.method === "GET") {
      const detail = await getLibraryDetail(libraryDetailMatch[1]);
      sendJson(response, detail ? 200 : 404, detail || { error: "library item not found" });
      return;
    }

    if (request.method === "GET" && path === "/v1/tasks") {
      const filters = parseTaskFilters(url.searchParams);
      if (filters.error) {
        sendJson(response, 400, { error: filters.error });
        return;
      }
      sendJson(response, 200, listTasks(filters));
      return;
    }

    if (request.method === "GET" && path === "/v1/tasks/events") {
      openEventStream(response);
      return;
    }

    if (request.method === "POST" && path === "/v1/tasks/search") {
      const payload = await readJson(request);
      try {
        sendJson(response, 200, createTask("search", titleForSearch(payload), payload));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "POST" && path === "/v1/tasks/gallery") {
      const payload = await readJson(request);
      if (!payload.gallery_url || !String(payload.gallery_url).trim()) {
        sendJson(response, 400, { error: "gallery_url is required" });
        return;
      }
      try {
        sendJson(response, 200, createTask("gallery", String(payload.gallery_url), payload));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (request.method === "POST" && path === "/v1/tasks/retry-folder") {
      const payload = await readJson(request);
      if (!payload.folder || !String(payload.folder).trim()) {
        sendJson(response, 400, { error: "folder is required" });
        return;
      }
      try {
        sendJson(response, 200, createTask("retry_folder", String(payload.folder), payload));
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === "GET") {
      const task = tasks.get(taskMatch[1]);
      sendJson(response, task ? 200 : 404, task ? publicTask(task) : { error: "task not found" });
      return;
    }

    if (taskMatch && request.method === "PATCH") {
      const task = tasks.get(taskMatch[1]);
      if (!task) {
        sendJson(response, 404, { error: "task not found" });
        return;
      }
      const payload = await readJson(request);
      if (payload.title) {
        task.title = String(payload.title).trim() || task.title;
      }
      if (payload.status) {
        task.status = payload.status;
      }
      if (payload.progress) {
        task.progress = payload.progress;
      }
      touch(task);
      publish(classifyUpdateEvent(payload), task);
      sendJson(response, 200, publicTask(task));
      return;
    }

    const cancelMatch = path.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      const task = tasks.get(cancelMatch[1]);
      if (!task) {
        sendJson(response, 404, { error: "task not found" });
        return;
      }
      cancelTask(task);
      sendJson(response, 200, publicTask(task));
      return;
    }

    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`comic-platform-dev-api listening on http://127.0.0.1:${port}`);
  console.log(`Source adapter config: ${sourceAdapterConfigFile}`);
  console.log(`Default python: ${defaultPython}`);
  console.log(`Source bridges: ${sourceAdapters.map((adapter) => `${adapter.id}=${adapter.bridgeScript}`).join("; ")}`);
  console.log(`Task data file: ${tasksFile}`);
  console.log(`Reader session file: ${readerSessionsFile}`);
  console.log(`Reader page cache: ${readerPageCacheDir}`);
  console.log(`Source auth dir: ${sourceAuthDir}`);
  console.log(`Library roots: ${libraryRoots.join("; ")}`);
});

async function sourceAuthStatus(sourceId) {
  const spec = requireSourceAuthSpec(sourceId);
  await refreshManagedSourceAuthEnv();
  sources = publicSourceDescriptors(sourceAdapters);
  const [localCookieExists, localHeadersExists, effectiveCookieExists, effectiveHeadersExists] = await Promise.all([
    fileExists(spec.cookieFile),
    fileExists(spec.headersFile),
    fileExists(process.env[spec.cookieEnv]),
    fileExists(process.env[spec.headersEnv]),
  ]);
  const source = sources.find((item) => item.id === sourceId);
  return {
    source_id: sourceId,
    configured: effectiveCookieExists || effectiveHeadersExists,
    local_cookie_file: spec.cookieFile,
    local_headers_file: spec.headersFile,
    has_local_cookie_file: localCookieExists,
    has_local_headers_file: localHeadersExists,
    effective_cookie_file: process.env[spec.cookieEnv] || null,
    effective_headers_file: process.env[spec.headersEnv] || null,
    has_effective_cookie_file: effectiveCookieExists,
    has_effective_headers_file: effectiveHeadersExists,
    available_for_default: source?.available_for_default === true,
    unavailable_reason: source?.unavailable_reason || null,
  };
}

async function saveSourceAuth(sourceId, payload) {
  const spec = requireSourceAuthSpec(sourceId);
  const { cookie, headers } = normalizeSourceAuthPayload(payload);
  if (!cookie && !headers) {
    throw new Error("cookie or headers is required");
  }

  await mkdir(sourceAuthDir, { recursive: true });
  if (cookie) {
    await writeFile(spec.cookieFile, `${cookie}\n`, "utf8");
  }
  if (headers) {
    await writeFile(spec.headersFile, `${headers}\n`, "utf8");
  }
  await refreshManagedSourceAuthEnv();
  sources = publicSourceDescriptors(sourceAdapters);
  return sourceAuthStatus(sourceId);
}

async function deleteSourceAuth(sourceId) {
  const spec = requireSourceAuthSpec(sourceId);
  await Promise.all([rm(spec.cookieFile, { force: true }), rm(spec.headersFile, { force: true })]);
  await refreshManagedSourceAuthEnv();
  sources = publicSourceDescriptors(sourceAdapters);
  return sourceAuthStatus(sourceId);
}

function requireSourceAuthSpec(sourceId) {
  const spec = sourceAuthSpecs[sourceId];
  if (!spec) {
    throw new Error(`source auth is not configurable for ${sourceId}`);
  }
  return spec;
}

function normalizeSourceAuthPayload(payload) {
  const cookieParts = [];
  const headerLines = [];
  const rawCookie = textOrNull(payload?.cookie || payload?.cookie_header || payload?.cookies);
  const rawHeaders = textOrNull(payload?.headers || payload?.headers_text || payload?.request_headers);

  if (rawCookie) {
    cookieParts.push(cleanCookieHeader(rawCookie));
  }

  if (rawHeaders) {
    for (const line of rawHeaders.replace(/\r\n/g, "\n").split("\n")) {
      const trimmed = cleanHeaderLine(line);
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!key || !value) {
        continue;
      }
      if (key.toLowerCase() === "cookie") {
        cookieParts.push(cleanCookieHeader(value));
      } else {
        headerLines.push(`${key}: ${value}`);
      }
    }
  }

  if (payload?.headers_json && typeof payload.headers_json === "object" && !Array.isArray(payload.headers_json)) {
    for (const [key, value] of Object.entries(payload.headers_json)) {
      const headerKey = cleanHeaderName(key);
      const headerValue = cleanHeaderValue(value);
      if (!headerKey || !headerValue) {
        continue;
      }
      if (headerKey.toLowerCase() === "cookie") {
        cookieParts.push(cleanCookieHeader(headerValue));
      } else {
        headerLines.push(`${headerKey}: ${headerValue}`);
      }
    }
  }

  const cookie = Array.from(new Set(cookieParts.filter(Boolean).flatMap((item) => item.split(";").map((part) => part.trim()).filter(Boolean)))).join("; ");
  const headers = Array.from(new Set(headerLines)).join("\n");
  return { cookie, headers };
}

function cleanCookieHeader(value) {
  return String(value || "")
    .replace(/^\s*cookie\s*:/i, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s*;\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHeaderLine(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, "")
    .trim();
}

function cleanHeaderName(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(text) ? text : "";
}

function cleanHeaderValue(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function refreshManagedSourceAuthEnv() {
  await Promise.all(
    Object.values(sourceAuthSpecs).map(async (spec) => {
      await applyManagedSourceAuthEnv(spec.cookieEnv, spec.cookieFile);
      await applyManagedSourceAuthEnv(spec.headersEnv, spec.headersFile);
    }),
  );
}

async function applyManagedSourceAuthEnv(envKey, filePath) {
  if (process.env[envKey] && process.env[envKey] !== filePath) {
    return;
  }
  if (await fileExists(filePath)) {
    process.env[envKey] = filePath;
    return;
  }
  if (process.env[envKey] === filePath) {
    delete process.env[envKey];
  }
}

function bridgeEnvForSource(sourceAdapter) {
  const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
  const spec = sourceAuthSpecs[sourceAdapter?.id];
  if (spec) {
    if (!env[spec.cookieEnv] && process.env[spec.cookieEnv]) {
      env[spec.cookieEnv] = process.env[spec.cookieEnv];
    }
    if (!env[spec.headersEnv] && process.env[spec.headersEnv]) {
      env[spec.headersEnv] = process.env[spec.headersEnv];
    }
  }
  return env;
}

async function fileExists(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

setInterval(sweepOrphanedRunningTasks, 60000);

export { server };

function createTask(kind, title, payload) {
  const taskSources = requireTaskSources(payload, kind);
  if (kind === "search") {
    payload.tags = cleanTagList(payload.tags);
    payload.excluded_tags = cleanTagList(payload.excluded_tags);
    payload.source_ids = taskSources.map((source) => source.id);
    if (taskSources.length === 1) {
      payload.source_id = taskSources[0].id;
    } else {
      delete payload.source_id;
    }
  } else {
    payload.source_id = taskSources[0].id;
  }
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    kind,
    status: "queued",
    title,
    payload: { type: kind, ...payload },
    progress: { total: 0, done: 0, failed: 0, message: "queued" },
    output: null,
    created_at: now,
    updated_at: now,
  };
  tasks.set(task.id, task);
  publish("task_queued", task);
  setTimeout(() => runTask(task), 0);
  return task;
}

function requireTaskSources(payload, kind) {
  if (kind !== "search") {
    return [requireTaskSource(payload.source_id, kind)];
  }

  const explicitSourceIds = Array.isArray(payload.source_ids)
    ? payload.source_ids
    : payload.source_id
      ? [payload.source_id]
      : [defaultSourceId];
  const sourceIds = Array.from(new Set(explicitSourceIds.map((sourceId) => String(sourceId || "").trim()).filter(Boolean)));
  if (!sourceIds.length) {
    throw new Error("search requires at least one source adapter");
  }
  return sourceIds.map((sourceId) => requireTaskSource(sourceId, kind));
}

function requireTaskSource(sourceId, kind) {
  const resolvedSourceId = String(sourceId || defaultSourceId).trim() || defaultSourceId;
  const source = sourceById.get(resolvedSourceId);
  if (!source || source.enabled === false) {
    throw new Error(`unknown or disabled source adapter: ${resolvedSourceId}`);
  }

  const requiredCapabilities = {
    search: ["search"],
    gallery: ["gallery", "download"],
    retry_folder: ["retry_folder"],
  }[kind] || [];
  const missing = requiredCapabilities.filter((capability) => !source.capabilities.includes(capability));
  if (missing.length) {
    throw new Error(`source adapter ${source.id} does not support ${missing.join(", ")}`);
  }
  return source;
}

function requireReaderSource(sourceId) {
  const source = requireTaskSource(sourceId, "reader");
  if (!sourceSupportsOnlineRead(source)) {
    throw new Error(`source adapter ${source.id} does not support online reading`);
  }
  return source;
}

function requireReaderSourceForGallery(sourceId, galleryUrl) {
  const requestedSourceId = textOrNull(sourceId);
  const inferredSource = inferReaderSourceFromUrl(galleryUrl);
  if (requestedSourceId) {
    const source = requireReaderSource(requestedSourceId);
    if (inferredSource && inferredSource.id !== source.id && sourceHomepageHost(source)) {
      throw new Error(
        `gallery_url looks like ${inferredSource.name}, but the selected source is ${source.name}. ` +
          "Choose the matching source or select all sources so the reader can auto-detect it.",
      );
    }
    return source;
  }

  if (inferredSource) {
    return inferredSource;
  }

  const readableSources = sourceAdapters.filter(sourceSupportsOnlineRead);
  if (readableSources.length === 1) {
    return readableSources[0];
  }

  throw new Error(`Unable to auto-detect an online reader source for gallery_url: ${galleryUrl}`);
}

function sourceSupportsOnlineRead(source) {
  if (!source || source.enabled === false) {
    return false;
  }
  const capabilities = new Set(source.capabilities || []);
  return (
    capabilities.has("online_read") ||
    (capabilities.has("page_list") && capabilities.has("page_image")) ||
    source.bridge?.page_commands === true
  );
}

function inferReaderSourceFromUrl(galleryUrl) {
  const galleryHost = hostForUrl(galleryUrl);
  if (!galleryHost) {
    return null;
  }

  return sourceAdapters.find((source) => {
    if (!sourceSupportsOnlineRead(source)) {
      return false;
    }
    const sourceHost = sourceHomepageHost(source);
    return Boolean(sourceHost && hostsMatch(galleryHost, sourceHost));
  });
}

function sourceHomepageHost(source) {
  return hostForUrl(source?.homepage);
}

function hostForUrl(value) {
  const text = textOrNull(value);
  if (!text) {
    return null;
  }
  try {
    return new URL(text).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostsMatch(candidateHost, sourceHost) {
  return candidateHost === sourceHost || candidateHost.endsWith(`.${sourceHost}`);
}

async function runTask(task) {
  if (task.status === "canceled") {
    return;
  }

  const source = sourceById.get(task.payload.source_id || defaultSourceId) || sourceById.get(defaultSourceId);
  task.status = "running";
  task.progress.message = "running attempt 1";
  touch(task);
  publish("task_started", task);

  try {
    if (task.kind === "search") {
      const searchSources = taskSearchSources(task);
      const results = [];
      const seenResults = new Set();
      const sourceErrors = [];
      const excludedTags = cleanTagList(task.payload.excluded_tags);
      let excludedCount = 0;

      for (const [index, searchSource] of searchSources.entries()) {
        if (task.status === "canceled") {
          return;
        }
        task.progress = {
          total: searchSources.length,
          done: index,
          failed: sourceErrors.length,
          message: `searching ${searchSource.name}`,
        };
        touch(task);
        publish("task_progressed", task);

        try {
          const result = await runBridge(
            task,
            [
              "search",
              "--tags-json",
              JSON.stringify(task.payload.tags || []),
              "--limit",
              String(task.payload.limit || 10),
              ...optionalArg("--name", task.payload.name),
              ...optionalArg("--query", task.payload.query),
            ],
            searchSource.id,
          );
          for (const item of result.results || []) {
            const normalized = {
              source_id: item.source_id || searchSource.id,
              gallery_url: item.url,
              title: item.title,
              tags: cleanTagList(item.tags),
              thumbnail_url: textOrNull(item.thumbnail_url),
            };
            if (excludedTags.length && !normalized.tags.length) {
              try {
                const gallery = await runBridge(
                  task,
                  ["gallery", "--gallery-url", normalized.gallery_url],
                  searchSource.id,
                );
                normalized.tags = cleanTagList(gallery.tags);
              } catch (error) {
                console.warn(
                  `Could not enrich search tags for ${normalized.source_id} ${normalized.gallery_url}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            if (searchResultMatchesExcludedTags(normalized, excludedTags)) {
              excludedCount += 1;
              continue;
            }
            const key = `${normalized.source_id}|${normalized.gallery_url}`;
            if (seenResults.has(key)) {
              continue;
            }
            seenResults.add(key);
            results.push(normalized);
          }
        } catch (error) {
          sourceErrors.push({
            source_id: searchSource.id,
            source_name: searchSource.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!results.length && sourceErrors.length === searchSources.length) {
        throw new Error(`all source searches failed: ${sourceErrors.map((error) => `${error.source_name}: ${error.message}`).join("; ")}`);
      }

      const failureSuffix = sourceErrors.length ? `, ${sourceErrors.length} source(s) failed` : "";
      const excludedSuffix = excludedCount ? `, ${excludedCount} excluded` : "";
      completeTask(task, `search completed with ${results.length} merged result(s)${excludedSuffix}${failureSuffix}`, {
        total: results.length,
        done: results.length,
        failed: sourceErrors.length,
        output: {
          type: "search_results",
          source_ids: searchSources.map((item) => item.id),
          source_errors: sourceErrors,
          excluded_tags: excludedTags,
          excluded_count: excludedCount,
          results,
        },
      });
      return;
    }

    if (task.kind === "gallery") {
      task.progress = { total: 1, done: 0, failed: 0, message: `preparing ${source.name} download` };
      touch(task);
      publish("task_progressed", task);

      const report = await runBridge(task, galleryDownloadArgs(task.payload.gallery_url), null, {
        timeoutMs: galleryBridgeTimeoutMs(),
        onProgress: (progress) => applyGalleryDownloadProgress(task, progress),
      });
      finishGalleryDownloadTask(task, source, report);
      return;
    }

    const plan = await runBridge(task, [
      "retry-plan",
      "--folder",
      task.payload.folder,
      ...(task.payload.missing_only ? ["--missing-only"] : []),
      ...optionalArg("--start-page", task.payload.start_page),
      ...optionalArg("--end-page", task.payload.end_page),
    ]);
    completeTask(task, `retry plan completed with ${plan.page_indexes.length} page(s)`, {
      total: plan.page_indexes.length,
      done: plan.page_indexes.length,
      failed: 0,
      output: {
        type: "retry_plan",
        source_id: plan.source_id || source.id,
        folder: plan.folder,
        page_indexes: plan.page_indexes,
      },
    });
  } catch (error) {
    if (task.status === "canceled") {
      return;
    }

    failTask(task, error instanceof Error ? error.message : String(error), {
      total: task.progress.total || 1,
      done: task.progress.done || 0,
      failed: task.progress.failed || 1,
    });
  } finally {
    runningChildren.delete(task.id);
  }
}

function applyGalleryDownloadProgress(task, progress) {
  if (task.status !== "running") {
    return;
  }
  const total = Number(progress.total || 0);
  const done = Number(progress.done || 0) + Number(progress.skipped || 0);
  const failed = Number(progress.failed || 0);
  const lastIndex = Number(progress.last_index || 0);
  task.progress = {
    total: total || Math.max(done + failed, task.progress.total || 1),
    done,
    failed,
    message: lastIndex
      ? `downloading p${lastIndex}: ${done}/${total || "?"} done, ${failed} failed`
      : `downloading: ${done}/${total || "?"} done, ${failed} failed`,
  };
  touch(task);
  publish("task_progressed", task);
}

function galleryBridgeTimeoutMs() {
  const value = Number(process.env.DEV_API_GALLERY_BRIDGE_TIMEOUT_MS || defaultBridgeTimeoutMs);
  return Number.isFinite(value) && value > 0 ? value : 30 * 60 * 1000;
}

function galleryDownloadArgs(galleryUrl) {
  const args = ["download-gallery", "--gallery-url", galleryUrl];
  if (Number.isFinite(galleryDownloadConcurrency) && galleryDownloadConcurrency > 0) {
    args.push("--download-concurrency", String(Math.min(Math.max(Math.floor(galleryDownloadConcurrency), 1), 8)));
  }
  return args;
}

function taskSearchSources(task) {
  const sourceIds = Array.isArray(task.payload?.source_ids)
    ? task.payload.source_ids
    : task.payload?.source_id
      ? [task.payload.source_id]
      : [defaultSourceId];
  const sources = Array.from(new Set(sourceIds.map((sourceId) => String(sourceId || "").trim()).filter(Boolean)))
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source) => source && source.enabled !== false && source.capabilities.includes("search"));
  return sources.length ? sources : [sourceById.get(defaultSourceId)].filter(Boolean);
}

function completeTask(task, message, report) {
  if (task.status === "canceled") {
    return;
  }

  task.status = "completed";
  task.progress = {
    total: Number(report.total || 0),
    done: Number(report.done || 0),
    failed: Number(report.failed || 0),
    message,
  };
  task.output = report.output;
  touch(task);
  publish("task_completed", task);
}

function failTask(task, message, report = {}) {
  if (task.status === "canceled") {
    return;
  }

  task.status = "failed";
  task.progress = {
    total: Number(report.total || 0) || 1,
    done: Number(report.done || 0),
    failed: Number(report.failed || 0) || 1,
    message,
  };
  if (Object.prototype.hasOwnProperty.call(report, "output")) {
    task.output = report.output;
  }
  touch(task);
  publish("task_failed", task);
}

function finishGalleryDownloadTask(task, source, report) {
  const done = Number(report.done || 0);
  const skipped = Number(report.skipped || 0);
  const failed = Number(report.failed || 0);
  const total = Number(report.page_count ?? done + skipped + failed);
  const output = {
    type: "gallery_download",
    source_id: report.source_id || source.id,
    gallery_url: report.url,
    title: report.title,
    output_folder: report.output_folder,
    page_count: report.page_count,
    done,
    skipped,
    failed,
    stopped: Boolean(report.stopped),
  };
  const progressReport = {
    total: Number.isFinite(total) && total > 0 ? total : done + skipped + failed || 1,
    done: done + skipped,
    failed,
    output,
  };
  const summary = `downloaded ${done} page(s), skipped ${skipped}, failed ${failed} -> ${report.output_folder}`;

  if (output.stopped || (failed > 0 && done + skipped === 0)) {
    failTask(task, `${summary}. Download stopped before a usable complete result was produced; rerun after fixing source access or blocked image responses.`, progressReport);
    return;
  }

  completeTask(task, summary, progressReport);
}

function runBridge(task, args, sourceIdOverride = null, bridgeOptions = {}) {
  const sourceId = String(sourceIdOverride || task.payload?.source_id || defaultSourceId);
  return runSourceBridge(sourceId, args, {
    childKey: task.id,
    isCanceled: () => task.status === "canceled",
    ...bridgeOptions,
  });
}

function runSourceBridge(sourceId, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const sourceAdapter = sourceById.get(String(sourceId || defaultSourceId));
    if (!sourceAdapter?.bridgeScript) {
      rejectPromise(new Error(`unknown source bridge: ${sourceId}`));
      return;
    }
    const child = spawn(sourceAdapter.python || defaultPython, [sourceAdapter.bridgeScript, ...args], {
      cwd: projectRoot,
      env: bridgeEnvForSource(sourceAdapter),
      windowsHide: true,
    });
    if (options.childKey) {
      runningChildren.set(options.childKey, child);
    }

    let stdout = "";
    let stderr = "";
    let stderrBuffer = "";
    let settled = false;
    const timeoutMs = Number(options.timeoutMs || defaultBridgeTimeoutMs);
    const timeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            withIgnoredProcessError(child, () => child.kill("SIGTERM"));
            rejectPromise(new Error(`source bridge timed out after ${Math.round(timeoutMs / 1000)}s: ${args.join(" ")}`));
          }, timeoutMs)
        : null;

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      callback();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const handled = handleBridgeProgressLine(line, options.onProgress);
        if (!handled) {
          stderr += `${line}\n`;
        }
      }
    });
    child.on("error", (error) => {
      finish(() => rejectPromise(error));
    });
    child.on("close", (code) => {
      if (stderrBuffer) {
        const handled = handleBridgeProgressLine(stderrBuffer, options.onProgress);
        if (!handled) {
          stderr += stderrBuffer;
        }
        stderrBuffer = "";
      }
      finish(() => {
        if (options.isCanceled?.()) {
          resolvePromise({});
          return;
        }
        if (code !== 0) {
          rejectPromise(new Error((stderr || stdout || `bridge exited with code ${code}`).trim()));
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout));
        } catch (error) {
          rejectPromise(new Error(`failed to parse bridge output: ${error.message}`));
        }
      });
    });
  });
}

function handleBridgeProgressLine(line, onProgress) {
  if (!line.startsWith(bridgeProgressPrefix)) {
    return false;
  }
  if (!onProgress) {
    return true;
  }
  try {
    onProgress(JSON.parse(line.slice(bridgeProgressPrefix.length)));
  } catch {
    // Ignore malformed progress events; the final bridge JSON remains authoritative.
  }
  return true;
}

function withIgnoredProcessError(child, callback) {
  const ignoreError = () => undefined;
  child.once("error", ignoreError);
  try {
    callback();
  } finally {
    setTimeout(() => child.off("error", ignoreError), 0);
  }
}

function runJsonScript(scriptPath, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(defaultPython, [scriptPath, ...args], {
      cwd: projectRoot,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error((stderr || stdout || `script exited with code ${code}`).trim()));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        rejectPromise(new Error(`failed to parse script output: ${error.message}`));
      }
    });
  });
}

function cancelTask(task) {
  if (task.status === "completed" || task.status === "failed" || task.status === "canceled") {
    return;
  }
  const child = runningChildren.get(task.id);
  if (child && !child.killed) {
    child.kill();
  }
  task.status = "canceled";
  task.progress.message = "canceled";
  touch(task);
  publish("task_canceled", task);
}

function sweepOrphanedRunningTasks() {
  const maxAgeMs = Number.isFinite(orphanedRunningTaskMs) && orphanedRunningTaskMs > 0 ? orphanedRunningTaskMs : 5 * 60 * 1000;
  const now = Date.now();
  for (const task of tasks.values()) {
    if (task.status !== "running" || runningChildren.has(task.id)) {
      continue;
    }
    const updatedAt = Date.parse(task.updated_at || task.created_at || "");
    if (!Number.isFinite(updatedAt) || now - updatedAt < maxAgeMs) {
      continue;
    }
    task.status = "failed";
    task.progress = {
      total: task.progress.total || 1,
      done: task.progress.done || 0,
      failed: Math.max(task.progress.failed || 0, 1),
      message: "download worker lost its bridge process; rerun the task",
    };
    touch(task);
    publish("task_failed", task);
  }
}

function publish(event, task) {
  const payload = {
    event,
    task: structuredClone(publicTask(task)),
    emitted_at: new Date().toISOString(),
  };
  history.push(payload);
  while (history.length > 200) {
    history.shift();
  }
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const subscriber of subscribers) {
    subscriber.write(frame);
  }
  persistTasksSoon();
}

function openEventStream(response) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  for (const event of history) {
    response.write(`event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15000);
  subscribers.add(response);
  response.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(response);
  });
}

function listTasks(filters = {}) {
  return Array.from(tasks.values())
    .filter((task) => matchesTaskFilters(task, filters))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map(publicTask);
}

function publicTask(task) {
  return {
    ...task,
    output: publicTaskOutput(task.output),
  };
}

function publicTaskOutput(output) {
  if (!output || output.type !== "search_results" || !Array.isArray(output.results)) {
    return output ?? null;
  }

  return {
    ...output,
    results: output.results.map((result) => ({
      ...result,
      thumbnail_url: cleanSearchThumbnailUrl(result?.thumbnail_url),
    })),
  };
}

function cleanSearchThumbnailUrl(value) {
  const thumbnailUrl = textOrNull(value);
  if (!thumbnailUrl || isBadSearchThumbnailUrl(thumbnailUrl)) {
    return null;
  }
  return thumbnailUrl;
}

function isBadSearchThumbnailUrl(value) {
  let parsed;
  try {
    parsed = new URL(value, "http://local.invalid");
  } catch {
    return true;
  }

  const host = parsed.hostname.toLowerCase();
  const path = safeDecodeURIComponent(parsed.pathname).toLowerCase();
  const filename = path.split("/").pop() || "";
  const stem = filename.split(".")[0] || "";
  const badFileNames = new Set([
    "blank.gif",
    "blank.png",
    "favicon.ico",
    "loading.gif",
    "loading.png",
    "noimage.gif",
    "noimage.png",
    "pixel.gif",
    "spacer.gif",
    "t.png",
    "td.png",
    "transparent.gif",
  ]);
  const badNameParts = ["arrow", "blank", "button", "download", "favicon", "icon", "loader", "loading", "placeholder", "pixel", "sprite"];

  if (!filename || badFileNames.has(filename)) {
    return true;
  }
  if (host.endsWith("ehgt.org") && (path === "/g/t.png" || path === "/g/td.png")) {
    return true;
  }
  if (host.endsWith("ehgt.org") && path.startsWith("/g/") && stem.length <= 2) {
    return true;
  }
  return badNameParts.some((part) => filename.includes(part));
}

async function sendSearchThumbnail(response, searchParams) {
  try {
    const sourceId = textOrNull(searchParams.get("source_id")) || defaultSourceId;
    const source = sourceById.get(sourceId);
    if (!source) {
      sendJson(response, 404, { error: `unknown source_id: ${sourceId}` });
      return;
    }

    const thumbnailUrl = cleanSearchThumbnailUrl(searchParams.get("url"));
    if (!thumbnailUrl) {
      sendJson(response, 400, { error: "valid thumbnail url is required" });
      return;
    }

    const parsed = validateSearchThumbnailUrl(source, thumbnailUrl);
    const cacheFile = searchThumbnailCacheFile(source.id, parsed.href);
    await ensureSearchThumbnailCached(source, parsed.href, textOrNull(searchParams.get("referer")), cacheFile);
    const fileStat = await stat(cacheFile);
    sendFile(response, cacheFile, mimeTypeForImage(cacheFile), fileStat, {
      "cache-control": "private, max-age=86400",
    });
  } catch (error) {
    sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) });
  }
}

function validateSearchThumbnailUrl(source, thumbnailUrl) {
  const parsed = new URL(thumbnailUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("thumbnail url must use http or https");
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error("thumbnail url points to a private or local host");
  }
  if (!isAllowedThumbnailHost(source, parsed.hostname)) {
    throw new Error(`thumbnail host is not allowed for source ${source.id}: ${parsed.hostname}`);
  }
  return parsed;
}

function isAllowedThumbnailHost(source, hostname) {
  const host = hostname.toLowerCase();
  if (source.id === "e-hentai" && (host === "ehgt.org" || host.endsWith(".ehgt.org"))) {
    return true;
  }

  const homepageHost = sourceHomepageHost(source);
  if (homepageHost && (host === homepageHost || host.endsWith(`.${homepageHost}`))) {
    return true;
  }

  return source.id !== "fangliding";
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || host === "[::1]") {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }

  const octets = ipv4.slice(1).map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function searchThumbnailCacheFile(sourceId, thumbnailUrl) {
  const hash = createHash("sha256").update(`${sourceId}|${thumbnailUrl}`).digest("hex");
  const extension = searchThumbnailExtension(thumbnailUrl);
  return resolve(searchThumbnailCacheDir, sourceId, `${hash}${extension}`);
}

function searchThumbnailExtension(thumbnailUrl) {
  const pathname = new URL(thumbnailUrl).pathname.toLowerCase();
  const match = pathname.match(/\.(avif|gif|jpe?g|png|webp)$/i);
  if (!match) {
    return ".img";
  }
  return match[0].replace(".jpeg", ".jpg");
}

async function ensureSearchThumbnailCached(source, thumbnailUrl, referer, cacheFile) {
  if (!isPathInside(cacheFile, searchThumbnailCacheDir)) {
    throw new Error("thumbnail cache path is outside the configured cache root");
  }

  try {
    const cached = await stat(cacheFile);
    if (cached.isFile() && cached.size > 0) {
      return;
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(dirname(cacheFile), { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), searchThumbnailTimeoutMs);
  try {
    const headers = {
      accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8",
      "user-agent": "comic-platform-dev-api/0.1 (+local thumbnail cache)",
    };
    const safeReferer = safeThumbnailReferer(source, referer);
    if (safeReferer) {
      headers.referer = safeReferer;
    }

    const remote = await fetch(thumbnailUrl, { headers, redirect: "follow", signal: controller.signal });
    if (!remote.ok) {
      throw new Error(`thumbnail fetch failed with HTTP ${remote.status}`);
    }

    const contentType = String(remote.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      throw new Error(`thumbnail fetch returned non-image content-type: ${contentType}`);
    }

    const body = Buffer.from(await remote.arrayBuffer());
    if (body.length < 64) {
      throw new Error("thumbnail response is too small to be a usable image");
    }
    if (body.length > searchThumbnailMaxBytes) {
      throw new Error(`thumbnail response is too large: ${body.length} bytes`);
    }

    await writeFile(cacheFile, body);
  } finally {
    clearTimeout(timeout);
  }
}

function safeThumbnailReferer(source, referer) {
  const value = textOrNull(referer);
  if (!value) {
    return source.homepage || null;
  }
  try {
    const parsed = new URL(value);
    if (isPrivateHostname(parsed.hostname)) {
      return source.homepage || null;
    }
    return parsed.href;
  } catch {
    return source.homepage || null;
  }
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseTaskFilters(searchParams) {
  const kind = textOrNull(searchParams.get("kind"));
  const status = textOrNull(searchParams.get("status"));
  if (kind && !["search", "gallery", "retry_folder"].includes(kind)) {
    return { error: `unknown task kind: ${kind}` };
  }
  if (status && !["queued", "running", "paused", "completed", "failed", "canceled"].includes(status)) {
    return { error: `unknown task status: ${status}` };
  }

  return {
    query: textOrNull(searchParams.get("q")),
    kind,
    status,
  };
}

function matchesTaskFilters(task, filters) {
  if (filters.kind && task.kind !== filters.kind) {
    return false;
  }
  if (filters.status && task.status !== filters.status) {
    return false;
  }

  const query = normalizeSearchText(filters.query);
  if (!query) {
    return true;
  }

  const searchable = normalizeSearchText(
    [
      task.id,
      task.title,
      task.kind,
      task.status,
      task.progress?.message || "",
      JSON.stringify(task.payload || {}),
      JSON.stringify(task.output || {}),
    ].join(" "),
  );
  return searchable.includes(query);
}

async function createReaderSession(payload) {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const galleryUrl = textOrNull(body.gallery_url);
  if (!galleryUrl) {
    throw new Error("gallery_url is required");
  }
  const source = requireReaderSourceForGallery(body.source_id, galleryUrl);

  const report = await runSourceBridge(source.id, ["list-pages", "--gallery-url", galleryUrl]);
  const pages = normalizeReaderPages(report.pages || [], report.gallery_url || galleryUrl);
  if (!pages.length) {
    throw new Error(`source adapter ${source.id} returned no readable pages`);
  }

  const sessionId = readerSessionId(source.id, report.gallery_url || galleryUrl);
  const existingSession = readerSessions.get(sessionId);
  const now = new Date().toISOString();
  const session = {
    id: sessionId,
    source_id: source.id,
    source_name: source.name,
    gallery_url: report.gallery_url || galleryUrl,
    title: textOrNull(report.title) || textOrNull(body.title) || report.gallery_url || galleryUrl,
    tags: Array.isArray(report.tags) ? report.tags.filter((tag) => textOrNull(tag)) : [],
    page_count: Number(report.page_count || pages.length),
    pages,
    last_page: existingSession?.last_page || null,
    last_read_at: existingSession?.last_read_at || null,
    bookmarks: normalizeReaderBookmarks(existingSession?.bookmarks || [], pages.length),
    created_at: existingSession?.created_at || now,
    updated_at: now,
  };
  readerSessions.set(session.id, session);
  persistReaderSessionsSoon();

  return readerSessionResponse(session, 0, 24);
}

function listReaderSessions() {
  return Array.from(readerSessions.values())
    .sort((left, right) => readerSessionSortTime(right).localeCompare(readerSessionSortTime(left)))
    .map(readerSessionSummary);
}

function readerSessionSortTime(session) {
  return String(session.last_read_at || session.updated_at || session.created_at || "");
}

function readerSessionSummary(session) {
  const { pages: _pages, ...publicSession } = session;
  return {
    ...publicSession,
    page_count: Number(publicSession.page_count || session.pages.length),
    last_page: session.last_page || null,
    last_read_at: session.last_read_at || null,
  };
}

function updateReaderSessionProgress(sessionId, payload) {
  const session = readerSessions.get(sessionId);
  if (!session) {
    return null;
  }

  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const page = Number.parseInt(String(body.last_page ?? ""), 10);
  const total = Math.max(Number(session.page_count || 0), session.pages.length, 1);
  if (!Number.isFinite(page) || page < 1 || page > total) {
    throw new Error(`last_page must be between 1 and ${total}`);
  }

  const now = new Date().toISOString();
  session.last_page = page;
  session.last_read_at = now;
  session.updated_at = now;
  persistReaderSessionsSoon();
  return readerSessionSummary(session);
}

function upsertReaderBookmark(sessionId, payload) {
  const session = readerSessions.get(sessionId);
  if (!session) {
    return null;
  }

  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const total = Math.max(Number(session.page_count || 0), session.pages.length, 1);
  const pageIndex = Number.parseInt(String(body.page_index ?? ""), 10);
  if (!Number.isFinite(pageIndex) || pageIndex < 1 || pageIndex > total) {
    throw new Error(`page_index must be between 1 and ${total}`);
  }

  const now = new Date().toISOString();
  const existingBookmarks = normalizeReaderBookmarks(session.bookmarks || [], total);
  const existing = existingBookmarks.find((bookmark) => bookmark.page_index === pageIndex);
  const nextBookmark = {
    page_index: pageIndex,
    label: sanitizeBookmarkLabel(body.label) || existing?.label || `p${pageIndex}`,
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  session.bookmarks = [...existingBookmarks.filter((bookmark) => bookmark.page_index !== pageIndex), nextBookmark].sort(
    (left, right) => left.page_index - right.page_index,
  );
  session.updated_at = now;
  persistReaderSessionsSoon();
  return readerSessionSummary(session);
}

function deleteReaderBookmark(sessionId, pageIndex) {
  const session = readerSessions.get(sessionId);
  if (!session || !Number.isFinite(pageIndex) || pageIndex <= 0) {
    return null;
  }

  const total = Math.max(Number(session.page_count || 0), session.pages.length, 1);
  const existingBookmarks = normalizeReaderBookmarks(session.bookmarks || [], total);
  if (!existingBookmarks.some((bookmark) => bookmark.page_index === pageIndex)) {
    return null;
  }

  session.bookmarks = existingBookmarks.filter((bookmark) => bookmark.page_index !== pageIndex);
  session.updated_at = new Date().toISOString();
  persistReaderSessionsSoon();
  return readerSessionSummary(session);
}

function sanitizeBookmarkLabel(value) {
  const label = textOrNull(value);
  if (!label) {
    return null;
  }
  return label.replace(/\s+/g, " ").slice(0, 80);
}

function normalizeReaderBookmarks(rawBookmarks, totalPages) {
  if (!Array.isArray(rawBookmarks)) {
    return [];
  }

  const bookmarks = new Map();
  const total = Math.max(Number(totalPages || 0), 1);
  for (const rawBookmark of rawBookmarks) {
    if (!rawBookmark || typeof rawBookmark !== "object" || Array.isArray(rawBookmark)) {
      continue;
    }
    const pageIndex = Number.parseInt(String(rawBookmark.page_index ?? rawBookmark.page ?? ""), 10);
    if (!Number.isFinite(pageIndex) || pageIndex < 1 || pageIndex > total) {
      continue;
    }
    const now = new Date().toISOString();
    bookmarks.set(pageIndex, {
      page_index: pageIndex,
      label: sanitizeBookmarkLabel(rawBookmark.label) || `p${pageIndex}`,
      created_at: textOrNull(rawBookmark.created_at) || now,
      updated_at: textOrNull(rawBookmark.updated_at) || textOrNull(rawBookmark.created_at) || now,
    });
  }

  return Array.from(bookmarks.values()).sort((left, right) => left.page_index - right.page_index);
}

function readerSessionId(sourceId, galleryUrl) {
  return createHash("sha256").update(`${sourceId}\0${galleryUrl}`).digest("base64url");
}

function normalizeReaderPages(rawPages, galleryUrl) {
  const pages = [];
  const seenIndexes = new Set();
  for (const [fallbackIndex, rawPage] of rawPages.entries()) {
    if (!rawPage || typeof rawPage !== "object") {
      continue;
    }
    const index = Number(rawPage.index || fallbackIndex + 1);
    const pageUrl = textOrNull(rawPage.page_url) || textOrNull(rawPage.image_url);
    if (!Number.isFinite(index) || index <= 0 || !pageUrl || seenIndexes.has(index)) {
      continue;
    }
    seenIndexes.add(index);
    pages.push({
      index: Math.floor(index),
      page_url: pageUrl,
      gallery_url: textOrNull(rawPage.gallery_url) || galleryUrl,
    });
  }
  return pages.sort((left, right) => left.index - right.index);
}

function readerSessionResponse(session, offset, limit) {
  const { pages: _pages, ...publicSession } = session;
  return {
    ...publicSession,
    pages: readerPageBatch(session, offset, limit),
  };
}

function getReaderSessionPageBatch(sessionId, searchParams) {
  const session = readerSessions.get(sessionId);
  if (!session) {
    return null;
  }
  return readerPageBatch(
    session,
    parseIntegerParam(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
    parseIntegerParam(searchParams.get("limit"), 24, 1, 100),
  );
}

function readerPageBatch(session, offset, limit) {
  const safeOffset = Math.min(Math.max(Number(offset || 0), 0), session.pages.length);
  const safeLimit = Math.min(Math.max(Number(limit || 24), 1), 100);
  const selectedPages = session.pages.slice(safeOffset, safeOffset + safeLimit).map((page) => publicReaderPage(session, page));
  const nextOffset = safeOffset + selectedPages.length;
  return {
    items: selectedPages,
    total: session.pages.length,
    offset: safeOffset,
    limit: safeLimit,
    next_offset: nextOffset < session.pages.length ? nextOffset : null,
  };
}

function publicReaderPage(session, page) {
  return {
    index: page.index,
    page_url: page.page_url,
    filename: `remote-${String(page.index).padStart(4, "0")}`,
    size_bytes: 0,
    updated_at: session.updated_at,
    url: `/v1/reader/sessions/${encodeURIComponent(session.id)}/pages/${page.index}`,
  };
}

async function resolveReaderPageFile(sessionId, pageIndex, options = {}) {
  const session = readerSessions.get(sessionId);
  if (!session || !Number.isFinite(pageIndex) || pageIndex <= 0) {
    return null;
  }
  const page = session.pages.find((candidate) => candidate.index === pageIndex);
  if (!page) {
    return null;
  }

  const cacheRoot = resolve(readerPageCacheDir, session.source_id, session.id);
  if (options.forceRefresh) {
    await removeCachedReaderPages(cacheRoot, page.index);
  } else {
    const cached = await findCachedReaderPage(cacheRoot, page.index);
    if (cached) {
      return cached;
    }
  }

  await mkdir(cacheRoot, { recursive: true });
  const report = await runSourceBridge(session.source_id, [
    "download-page",
    "--gallery-url",
    session.gallery_url,
    "--page-url",
    page.page_url,
    "--page-index",
    String(page.index),
    "--page-output",
    cacheRoot,
  ]);
  const filePath = resolve(String(report.storage_key || ""));
  if (!isPathInside(filePath, cacheRoot) || !isImageFile(basename(filePath))) {
    throw new Error("source adapter returned an unsafe reader cache path");
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    return null;
  }
  session.updated_at = new Date().toISOString();
  persistReaderSessionsSoon();
  return {
    filePath,
    fileStat,
    mimeType: textOrNull(report.content_type) || mimeTypeForImage(filePath),
  };
}

async function removeCachedReaderPages(cacheRoot, pageIndex) {
  const entries = await safeReadDir(cacheRoot);
  const prefix = String(pageIndex).padStart(4, "0");
  await Promise.all(
    entries
      .filter((candidate) => candidate.isFile() && candidate.name.startsWith(prefix) && isImageFile(candidate.name))
      .map(async (entry) => {
        const filePath = resolve(cacheRoot, entry.name);
        if (!isPathInside(filePath, cacheRoot)) {
          return;
        }
        try {
          await unlink(filePath);
        } catch (error) {
          if (!error || error.code !== "ENOENT") {
            throw error;
          }
        }
      }),
  );
}

async function findCachedReaderPage(cacheRoot, pageIndex) {
  const entries = await safeReadDir(cacheRoot);
  const prefix = String(pageIndex).padStart(4, "0");
  const entry = entries.find((candidate) => candidate.isFile() && candidate.name.startsWith(prefix) && isImageFile(candidate.name));
  if (!entry) {
    return null;
  }
  const filePath = resolve(cacheRoot, entry.name);
  if (!isPathInside(filePath, cacheRoot)) {
    return null;
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    return null;
  }
  return {
    filePath,
    fileStat,
    mimeType: mimeTypeForImage(entry.name),
  };
}

async function getReaderPageStatus(sessionId, pageIndex) {
  const session = readerSessions.get(sessionId);
  if (!session || !Number.isFinite(pageIndex) || pageIndex <= 0) {
    return null;
  }
  const page = session.pages.find((candidate) => candidate.index === pageIndex);
  if (!page) {
    return null;
  }

  const cacheRoot = resolve(readerPageCacheDir, session.source_id, session.id);
  const cached = await findCachedReaderPage(cacheRoot, page.index);
  if (cached) {
    clearReaderPageFailure(sessionId, pageIndex);
    return {
      session_id: session.id,
      source_id: session.source_id,
      page_index: page.index,
      page_url: page.page_url,
      status: "ready",
      cached: true,
      size_bytes: cached.fileStat.size,
      content_type: cached.mimeType,
      updated_at: session.updated_at,
    };
  }

  const failure = readerPageFailures.get(readerPageFailureKey(sessionId, pageIndex));
  if (failure) {
    return {
      session_id: session.id,
      source_id: session.source_id,
      page_index: page.index,
      page_url: page.page_url,
      status: "failed",
      cached: false,
      error: failure.message,
      updated_at: failure.updated_at,
    };
  }

  return {
    session_id: session.id,
    source_id: session.source_id,
    page_index: page.index,
    page_url: page.page_url,
    status: "pending",
    cached: false,
    updated_at: session.updated_at,
  };
}

async function getReaderPageStatusBatch(sessionId, searchParams) {
  const session = readerSessions.get(sessionId);
  if (!session) {
    return null;
  }

  const offset = parseIntegerParam(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parseIntegerParam(searchParams.get("limit"), 24, 1, 100);
  const safeOffset = Math.min(offset, session.pages.length);
  const safeLimit = Math.min(limit, 100);
  const pages = session.pages.slice(safeOffset, safeOffset + safeLimit);
  const items = await Promise.all(pages.map((page) => getReaderPageStatus(sessionId, page.index)));
  const selectedItems = items.filter(Boolean);
  const nextOffset = safeOffset + selectedItems.length;

  return {
    items: selectedItems,
    total: session.pages.length,
    offset: safeOffset,
    limit: safeLimit,
    next_offset: nextOffset < session.pages.length ? nextOffset : null,
  };
}

async function deleteReaderSession(sessionId) {
  const session = readerSessions.get(sessionId);
  if (!session) {
    return null;
  }

  readerSessions.delete(sessionId);
  clearReaderSessionFailures(sessionId);
  const cacheResult = await clearReaderSessionCacheFiles(session);
  persistReaderSessionsSoon();

  return {
    deleted: true,
    session_id: sessionId,
    cache: cacheResult,
  };
}

async function clearReaderSessionCache(sessionId, payload = {}) {
  const session = readerSessions.get(sessionId);
  if (!session) {
    return null;
  }

  const pageIndexes = normalizeCacheClearPageIndexes(payload, session.pages.length);
  const cacheResult = pageIndexes.length
    ? await clearReaderSessionCacheFiles(session, pageIndexes)
    : await clearReaderSessionCacheFiles(session);

  if (pageIndexes.length) {
    pageIndexes.forEach((pageIndex) => clearReaderPageFailure(sessionId, pageIndex));
  } else {
    clearReaderSessionFailures(sessionId);
  }

  return {
    session_id: sessionId,
    cleared: true,
    page_indexes: pageIndexes,
    cache: cacheResult,
  };
}

function normalizeCacheClearPageIndexes(payload, totalPages) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }

  const rawIndexes = Array.isArray(payload.page_indexes)
    ? payload.page_indexes
    : Number.isFinite(Number(payload.page_index))
      ? [payload.page_index]
      : [];
  const indexes = new Set();

  for (const value of rawIndexes) {
    const index = Number.parseInt(String(value), 10);
    if (Number.isFinite(index) && index >= 1 && index <= Math.max(totalPages, 1)) {
      indexes.add(index);
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}

async function clearReaderSessionCacheFiles(session, pageIndexes = []) {
  const cacheRoot = resolve(readerPageCacheDir, session.source_id, session.id);
  if (!isPathInside(cacheRoot, readerPageCacheDir)) {
    throw new Error("reader cache path is outside the configured cache root");
  }

  if (pageIndexes.length) {
    for (const pageIndex of pageIndexes) {
      await removeCachedReaderPages(cacheRoot, pageIndex);
    }
    return {
      mode: "pages",
      requested: pageIndexes.length,
    };
  }

  try {
    await rm(cacheRoot, { recursive: true, force: true });
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    mode: "session",
  };
}

function readerPageFailureKey(sessionId, pageIndex) {
  return `${sessionId}\0${pageIndex}`;
}

function recordReaderPageFailure(sessionId, pageIndex, error) {
  readerPageFailures.set(readerPageFailureKey(sessionId, pageIndex), {
    message: error instanceof Error ? error.message : String(error || "reader page failed"),
    updated_at: new Date().toISOString(),
  });
}

function clearReaderPageFailure(sessionId, pageIndex) {
  readerPageFailures.delete(readerPageFailureKey(sessionId, pageIndex));
}

function clearReaderSessionFailures(sessionId) {
  const prefix = `${sessionId}\0`;
  for (const key of Array.from(readerPageFailures.keys())) {
    if (key.startsWith(prefix)) {
      readerPageFailures.delete(key);
    }
  }
}

async function listLibrary(filters = {}) {
  const items = [];

  for (const root of libraryRoots) {
    const rootEntries = await safeReadDir(root);
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const folder = join(root, entry.name);
      const item = await inspectLibraryFolder(root, folder, entry.name);
      if (item) {
        items.push(item);
      }
    }
  }

  return sortLibraryItems(items.filter((item) => matchesLibraryFilters(item, filters)), filters.sort);
}

async function listLibraryTags(searchParams) {
  const filters = parseLibraryFilters(searchParams);
  const limit = parseIntegerParam(searchParams.get("limit"), 40, 1, 200);
  const items = await listLibrary(filters);
  const stats = new Map();

  for (const item of items) {
    const seenTags = new Set();
    for (const rawTag of item.tags) {
      const tag = textOrNull(rawTag);
      if (!tag) {
        continue;
      }

      const key = tag.toLocaleLowerCase();
      if (seenTags.has(key)) {
        continue;
      }
      seenTags.add(key);

      const current = stats.get(key) || {
        tag,
        item_count: 0,
        image_count: 0,
        failed_count: 0,
      };
      current.item_count += 1;
      current.image_count += item.image_count;
      current.failed_count += item.failed_count;
      stats.set(key, current);
    }
  }

  return Array.from(stats.values())
    .sort(
      (left, right) =>
        right.item_count - left.item_count ||
        right.image_count - left.image_count ||
        left.tag.localeCompare(right.tag, undefined, { numeric: true, sensitivity: "base" }),
    )
    .slice(0, limit);
}

function parseLibraryFilters(searchParams) {
  const readingStatus = textOrNull(searchParams.get("reading_status"));
  const health = textOrNull(searchParams.get("health"));
  return {
    query: textOrNull(searchParams.get("q")),
    tag: textOrNull(searchParams.get("tag")),
    completeness: ["complete", "incomplete"].includes(searchParams.get("completeness")) ? searchParams.get("completeness") : "all",
    health: ["ok", "warning", "failed", "needs_attention"].includes(health) ? health : "all",
    failedOnly: searchParams.get("failed_only") === "true" || searchParams.get("failed_only") === "1",
    favoriteOnly: searchParams.get("favorite_only") === "true" || searchParams.get("favorite_only") === "1",
    recentOnly: searchParams.get("recent_only") === "true" || searchParams.get("recent_only") === "1",
    readingStatus: ["unread", "reading", "finished", "paused"].includes(readingStatus) ? readingStatus : "all",
    sort: textOrNull(searchParams.get("sort")) || "updated_desc",
  };
}

function matchesLibraryFilters(item, filters) {
  const query = normalizeSearchText(filters.query);
  if (query) {
    const searchable = normalizeSearchText([item.title, item.folder, item.root, item.gallery_url || "", ...item.tags].join(" "));
    if (!searchable.includes(query)) {
      return false;
    }
  }

  const tag = normalizeSearchText(filters.tag);
  if (tag && !item.tags.some((itemTag) => normalizeSearchText(itemTag).includes(tag))) {
    return false;
  }

  if (filters.failedOnly && item.failed_count <= 0) {
    return false;
  }

  if (filters.favoriteOnly && !item.shelf.favorite) {
    return false;
  }

  if (filters.recentOnly && !item.shelf.last_read_at) {
    return false;
  }

  if (filters.readingStatus !== "all" && item.shelf.reading_status !== filters.readingStatus) {
    return false;
  }

  if (filters.completeness === "complete" && !isLibraryItemComplete(item)) {
    return false;
  }
  if (filters.completeness === "incomplete" && isLibraryItemComplete(item)) {
    return false;
  }

  if (filters.health !== "all") {
    const status = item.health?.status || "ok";
    if (filters.health === "needs_attention") {
      if (status === "ok") {
        return false;
      }
    } else if (status !== filters.health) {
      return false;
    }
  }

  return true;
}

function sortLibraryItems(items, sort = "updated_desc") {
  const sorted = [...items];
  if (sort === "title_asc") {
    return sorted.sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" }));
  }
  if (sort === "last_read_desc") {
    return sorted.sort((left, right) => {
      const leftTime = Date.parse(left.shelf.last_read_at || "") || 0;
      const rightTime = Date.parse(right.shelf.last_read_at || "") || 0;
      return rightTime - leftTime || right.updated_at.localeCompare(left.updated_at);
    });
  }
  if (sort === "images_desc") {
    return sorted.sort((left, right) => right.image_count - left.image_count || right.updated_at.localeCompare(left.updated_at));
  }
  if (sort === "failed_desc") {
    return sorted.sort((left, right) => right.failed_count - left.failed_count || right.updated_at.localeCompare(left.updated_at));
  }
  if (sort === "size_desc") {
    return sorted.sort((left, right) => right.size_bytes - left.size_bytes || right.updated_at.localeCompare(left.updated_at));
  }
  if (sort === "completeness_asc") {
    return sorted.sort((left, right) => libraryCompletionRatio(left) - libraryCompletionRatio(right) || right.updated_at.localeCompare(left.updated_at));
  }
  return sorted.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

async function inspectLibraryFolder(root, folder, folderName) {
  const entries = await safeReadDir(folder);
  if (!entries.length) {
    return null;
  }

  let folderStat;
  try {
    folderStat = await stat(folder);
  } catch {
    return null;
  }

  const metadataPath = join(folder, "metadata.json");
  const failureLogPath = join(folder, "failed_pages.jsonl");
  const downloadStatePath = join(folder, "download_state.json");
  const metadata = await readOptionalJson(metadataPath);
  const downloadState = await readOptionalJson(downloadStatePath);
  const itemId = toStableId(root, folderName);
  const imageEntries = entries.filter((entry) => entry.isFile() && isImageFile(entry.name)).sort((left, right) => comparePageNames(left.name, right.name));
  const coverEntry = imageEntries[0] || null;

  let sizeBytes = 0;
  let updatedAt = folderStat.mtime.toISOString();
  const imageStats = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = join(folder, entry.name);
    try {
      const fileStat = await stat(filePath);
      sizeBytes += fileStat.size;
      if (fileStat.mtime.toISOString() > updatedAt) {
        updatedAt = fileStat.mtime.toISOString();
      }
      if (isImageFile(entry.name)) {
        imageStats.push({
          filename: entry.name,
          size_bytes: fileStat.size,
        });
      }
    } catch {
      continue;
    }
  }

  const failedCount = await countFailedPages(failureLogPath);
  const metadataPageCount = pageCountFromMetadata(metadata);
  const tags = tagsFromMetadata(metadata);
  const health = buildLibraryHealth({
    expectedCount: metadataPageCount ?? imageEntries.length,
    imageCount: imageEntries.length,
    failedCount,
    imageStats: imageStats.sort((left, right) => comparePageNames(left.filename, right.filename)),
    downloadState,
  });

  return {
    id: itemId,
    source_id: textOrNull(metadata?.source_id) || defaultSourceId,
    root,
    folder,
    title: textOrNull(metadata?.title) || folderName,
    gallery_url: textOrNull(metadata?.url) || textOrNull(metadata?.gallery_url),
    page_count: metadataPageCount ?? imageEntries.length,
    image_count: imageEntries.length,
    failed_count: failedCount,
    size_bytes: sizeBytes,
    metadata_path: metadata ? metadataPath : null,
    failure_log_path: failedCount > 0 || hasEntry(entries, "failed_pages.jsonl") ? failureLogPath : null,
    download_state_path: downloadState ? downloadStatePath : null,
    cover_filename: coverEntry?.name || null,
    cover_url: coverEntry ? `/v1/library/${encodeURIComponent(itemId)}/pages/${encodeURIComponent(coverEntry.name)}` : null,
    tags,
    health,
    updated_at: updatedAt,
    shelf: shelfForItem(itemId),
  };
}

async function getLibraryDetail(id) {
  const resolved = resolveLibraryFolderFromId(id);
  if (!resolved) {
    return null;
  }

  const item = await inspectLibraryFolder(resolved.root, resolved.folder, resolved.folderName);
  if (!item) {
    return null;
  }

  const metadata = await readOptionalJson(join(resolved.folder, "metadata.json"));
  const pageBatch = await listLibraryPageBatch(id, resolved.folder, { offset: 0, limit: 24 });
  const failed_entries = await readFailureEntries(join(resolved.folder, "failed_pages.jsonl"));

  return {
    ...item,
    metadata: metadataSummary(metadata),
    pages: pageBatch.items,
    pages_total: pageBatch.total,
    pages_offset: pageBatch.offset,
    pages_limit: pageBatch.limit,
    pages_next_offset: pageBatch.next_offset,
    failed_entries,
  };
}

async function getLibraryPages(id, searchParams) {
  const resolved = resolveLibraryFolderFromId(id);
  if (!resolved) {
    return null;
  }

  return listLibraryPageBatch(id, resolved.folder, {
    offset: parseIntegerParam(searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
    limit: parseIntegerParam(searchParams.get("limit"), 24, 1, 100),
  });
}

async function updateLibraryShelf(id, payload) {
  const resolved = resolveLibraryFolderFromId(id);
  if (!resolved) {
    return null;
  }

  const item = await inspectLibraryFolder(resolved.root, resolved.folder, resolved.folderName);
  if (!item) {
    return null;
  }

  const current = shelfForItem(id);
  const patch = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const next = {
    ...current,
    updated_at: new Date().toISOString(),
  };

  if (Object.prototype.hasOwnProperty.call(patch, "favorite")) {
    next.favorite = Boolean(patch.favorite);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "reading_status")) {
    const status = textOrNull(patch.reading_status) || "unread";
    if (!["unread", "reading", "finished", "paused"].includes(status)) {
      throw new Error(`unknown reading_status: ${status}`);
    }
    next.reading_status = status;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "note")) {
    next.note = String(patch.note ?? "").trim().slice(0, 1000);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "last_page")) {
    const page = Number.parseInt(String(patch.last_page ?? ""), 10);
    next.last_page = Number.isFinite(page) && page > 0 ? page : null;
    next.last_read_at = next.last_page ? next.updated_at : null;
  }

  libraryShelf.set(id, next);
  await persistLibraryShelf();
  return next;
}

async function createLibraryCbzExport(id) {
  return createLibraryExport(id, {
    scriptPath: libraryExportScript,
    exportDir: libraryCbzExportsDir,
    extension: "cbz",
    extraArgs: [],
  });
}

async function createLibraryPdfExport(id) {
  return createLibraryExport(id, {
    scriptPath: libraryPdfExportScript,
    exportDir: libraryPdfExportsDir,
    extension: "pdf",
    extraArgs: ["--quality", "90"],
  });
}

async function createLibraryExport(id, options) {
  const resolved = resolveLibraryFolderFromId(id);
  if (!resolved) {
    return null;
  }

  const item = await inspectLibraryFolder(resolved.root, resolved.folder, resolved.folderName);
  if (!item) {
    return null;
  }
  if (item.image_count <= 0) {
    throw new Error(`library item has no image files: ${item.folder}`);
  }

  const exportRoot = resolve(options.exportDir);
  await mkdir(exportRoot, { recursive: true });
  const filename = createLibraryExportFilename(item, resolved.folderName, options.extension);
  const outputFile = resolve(exportRoot, filename);
  if (dirname(outputFile).toLocaleLowerCase() !== exportRoot.toLocaleLowerCase()) {
    throw new Error("refusing to write export outside library export directory");
  }

  const report = await runJsonScript(options.scriptPath, [
    "--folder",
    resolved.folder,
    "--output",
    outputFile,
    "--title",
    item.title,
    ...options.extraArgs,
  ]);

  const record = await appendLibraryExportRecord({
    id: randomUUID(),
    format: options.extension,
    ...report,
    item_id: id,
    source_id: item.source_id,
    gallery_url: item.gallery_url,
    exists: true,
  });

  return record;
}

async function listLibraryExports(id) {
  const resolved = resolveLibraryFolderFromId(id);
  if (!resolved) {
    return null;
  }

  const records = await readLibraryExportRecords();
  const filtered = [];
  for (const record of records) {
    if (record.item_id !== id || !isAllowedExportFile(record.output_file)) {
      continue;
    }
    filtered.push(await withExportFileStatus(record));
  }

  return filtered.sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
}

async function resolveLibraryExportFile(id, exportId) {
  const resolved = resolveLibraryFolderFromId(id);
  if (!resolved || !isSafeSinglePathSegment(exportId)) {
    return null;
  }

  const records = await readLibraryExportRecords();
  const record = records.find((item) => item.item_id === id && item.id === exportId);
  if (!record || !isAllowedExportFile(record.output_file)) {
    return null;
  }

  const filePath = resolve(record.output_file);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return null;
    }
    return {
      filePath,
      fileStat,
      filename: basename(filePath),
      mimeType: mimeTypeForExport(record),
    };
  } catch {
    return null;
  }
}

async function appendLibraryExportRecord(record) {
  await mkdir(dataDir, { recursive: true });
  await appendFile(libraryExportsFile, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

async function readLibraryExportRecords() {
  let text;
  try {
    text = await readFile(libraryExportsFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function withExportFileStatus(record) {
  try {
    const fileStat = await stat(record.output_file);
    return {
      ...record,
      exists: fileStat.isFile(),
      size_bytes: fileStat.isFile() ? fileStat.size : record.size_bytes,
    };
  } catch {
    return {
      ...record,
      exists: false,
    };
  }
}

function isAllowedExportFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }
  const resolvedFile = resolve(filePath);
  return [libraryCbzExportsDir, libraryPdfExportsDir].some((exportRoot) => dirname(resolvedFile).toLocaleLowerCase() === resolve(exportRoot).toLocaleLowerCase());
}

async function listLibraryPageBatch(id, folder, options = {}) {
  const entries = await safeReadDir(folder);
  const imageEntries = entries.filter((entry) => entry.isFile() && isImageFile(entry.name)).sort((left, right) => comparePageNames(left.name, right.name));
  const offset = Math.min(Math.max(Number(options.offset || 0), 0), imageEntries.length);
  const limit = Math.min(Math.max(Number(options.limit || 24), 1), 100);
  const selectedEntries = imageEntries.slice(offset, offset + limit);
  const pages = [];

  for (const [localIndex, entry] of selectedEntries.entries()) {
    const filePath = join(folder, entry.name);
    const index = offset + localIndex;
    try {
      const fileStat = await stat(filePath);
      pages.push({
        index: index + 1,
        filename: entry.name,
        path: filePath,
        size_bytes: fileStat.size,
        updated_at: fileStat.mtime.toISOString(),
        url: `/v1/library/${encodeURIComponent(id)}/pages/${encodeURIComponent(entry.name)}`,
      });
    } catch {
      continue;
    }
  }

  const nextOffset = offset + selectedEntries.length;
  return {
    items: pages,
    total: imageEntries.length,
    offset,
    limit,
    next_offset: nextOffset < imageEntries.length ? nextOffset : null,
  };
}

async function resolveLibraryPageFile(id, encodedFilename) {
  const resolved = resolveLibraryFolderFromId(id);
  if (!resolved) {
    return null;
  }

  let filename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return null;
  }
  if (!isSafeSinglePathSegment(filename) || !isImageFile(filename)) {
    return null;
  }

  const filePath = resolve(resolved.folder, filename);
  if (dirname(filePath).toLocaleLowerCase() !== resolved.folder.toLocaleLowerCase()) {
    return null;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return null;
    }
    return {
      filePath,
      fileStat,
      mimeType: mimeTypeForImage(filename),
    };
  } catch {
    return null;
  }
}

function resolveLibraryFolderFromId(id) {
  let decoded;
  try {
    decoded = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const parts = decoded.split("\0");
  if (parts.length !== 2) {
    return null;
  }

  const root = resolve(parts[0]);
  const folderName = parts[1];
  const allowedRoot = libraryRoots.find((candidate) => candidate.toLocaleLowerCase() === root.toLocaleLowerCase());
  if (!allowedRoot || !isSafeSinglePathSegment(folderName)) {
    return null;
  }

  const folder = resolve(allowedRoot, folderName);
  if (dirname(folder).toLocaleLowerCase() !== allowedRoot.toLocaleLowerCase()) {
    return null;
  }

  return {
    root: allowedRoot,
    folder,
    folderName,
  };
}

async function readFailureEntries(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 100)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { message: line };
        }
      });
  } catch {
    return [];
  }
}

function metadataSummary(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  return {
    title: textOrNull(metadata.title),
    url: textOrNull(metadata.url) || textOrNull(metadata.gallery_url),
    gid: textOrNull(metadata.gid),
    token: textOrNull(metadata.token),
    length: pageCountFromMetadata(metadata),
    tags: tagsFromMetadata(metadata),
  };
}

function resolveLibraryRoots() {
  const candidates = [
    join(projectRoot, ".data", "downloads"),
    resolve(projectRoot, "..", "downloads"),
    ...String(process.env.DEV_API_LIBRARY_ROOTS || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean),
  ];
  const seen = new Set();
  return candidates
    .map((root) => resolve(root))
    .filter((root) => {
      const key = root.toLocaleLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

async function safeReadDir(folder) {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES")) {
      return [];
    }
    throw error;
  }
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function countFailedPages(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function pageCountFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  if (Number.isFinite(metadata.length)) {
    return Number(metadata.length);
  }
  if (Number.isFinite(metadata.page_count)) {
    return Number(metadata.page_count);
  }
  if (Array.isArray(metadata.image_pages)) {
    return metadata.image_pages.length;
  }
  return null;
}

function tagsFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || !metadata.tags) {
    return [];
  }
  if (Array.isArray(metadata.tags)) {
    return metadata.tags.map(String).slice(0, 40);
  }
  if (typeof metadata.tags !== "object") {
    return [];
  }

  const tags = [];
  for (const [namespace, values] of Object.entries(metadata.tags)) {
    if (!Array.isArray(values)) {
      continue;
    }
    for (const value of values) {
      tags.push(`${namespace}:${value}`);
      if (tags.length >= 40) {
        return tags;
      }
    }
  }
  return tags;
}

function hasEntry(entries, name) {
  return entries.some((entry) => entry.name.toLocaleLowerCase() === name);
}

function isImageFile(name) {
  return /\.(avif|gif|jpe?g|png|webp)$/i.test(name);
}

function isLibraryItemComplete(item) {
  if (item.health?.status && item.health.status !== "ok") {
    return false;
  }
  const expected = Math.max(Number(item.page_count || 0), Number(item.image_count || 0), 1);
  return item.failed_count === 0 && item.image_count >= expected;
}

function libraryCompletionRatio(item) {
  const expected = Math.max(Number(item.page_count || 0), Number(item.image_count || 0), 1);
  return Math.min(1, item.image_count / expected);
}

function buildLibraryHealth({ expectedCount, imageCount, failedCount, imageStats, downloadState }) {
  const minBytes = Number.isFinite(librarySuspiciousImageBytes) && librarySuspiciousImageBytes > 0 ? librarySuspiciousImageBytes : 2048;
  const expected = Math.max(Number(expectedCount || 0), 0);
  const missingCount = expected > imageCount ? expected - imageCount : 0;
  const suspiciousImages = imageStats.filter((image) => Number(image.size_bytes || 0) > 0 && Number(image.size_bytes || 0) < minBytes);
  const stateFailed = Number(downloadState?.failed || 0);
  const stopped = Boolean(downloadState?.stopped);
  const issues = [];

  if (missingCount > 0) {
    issues.push({
      kind: "missing_pages",
      severity: imageCount > 0 ? "warning" : "failed",
      message: `metadata declares ${expected} page(s), but only ${imageCount} image file(s) exist`,
      count: missingCount,
    });
  }
  if (failedCount > 0 || stateFailed > 0) {
    issues.push({
      kind: "failed_pages",
      severity: imageCount > 0 ? "warning" : "failed",
      message: `${Math.max(failedCount, stateFailed)} failed page record(s) were found`,
      count: Math.max(failedCount, stateFailed),
    });
  }
  if (suspiciousImages.length > 0) {
    issues.push({
      kind: "small_images",
      severity: suspiciousImages.length >= imageCount ? "failed" : "warning",
      message: `${suspiciousImages.length} image file(s) are smaller than ${minBytes} bytes and may be placeholders`,
      count: suspiciousImages.length,
      samples: suspiciousImages.slice(0, 8),
    });
  }
  if (stopped) {
    issues.push({
      kind: "stopped_download",
      severity: "failed",
      message: "the last download_state.json says the download stopped before finishing",
      count: 1,
    });
  }

  const status = issues.some((issue) => issue.severity === "failed") ? "failed" : issues.length ? "warning" : "ok";
  return {
    status,
    expected_count: expected || imageCount,
    image_count: imageCount,
    missing_count: missingCount,
    failed_count: failedCount,
    suspicious_count: suspiciousImages.length,
    suspicious_min_bytes: minBytes,
    stopped,
    last_done: Number(downloadState?.done || 0),
    last_skipped: Number(downloadState?.skipped || 0),
    last_failed: stateFailed,
    updated_at: textOrNull(downloadState?.updated_at),
    issues,
  };
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function parseIntegerParam(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function mimeTypeForImage(name) {
  const lower = name.toLocaleLowerCase();
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function mimeTypeForExport(record) {
  if (record.format === "pdf" || String(record.output_file || "").toLocaleLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }
  if (record.format === "cbz" || String(record.output_file || "").toLocaleLowerCase().endsWith(".cbz")) {
    return "application/vnd.comicbook+zip";
  }
  return "application/octet-stream";
}

function comparePageNames(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function createLibraryExportFilename(item, fallbackName, extension) {
  const base = sanitizeFilename(item.title || fallbackName || "library-export").slice(0, 100) || "library-export";
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${base}-${stamp}.${extension}`;
}

function sanitizeFilename(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

function contentDispositionForDownload(filename) {
  const fallback = sanitizeFilename(filename).replace(/[^\x20-\x7e]/g, "_") || "download";
  const quotedFallback = fallback.replace(/(["\\])/g, "\\$1");
  return `attachment; filename="${quotedFallback}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(value)
    .replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

function isSafeSinglePathSegment(value) {
  return Boolean(value && value !== "." && value !== ".." && !/[\\/]/.test(value) && !value.includes("\0"));
}

function isPathInside(child, parent) {
  const resolvedChild = resolve(child).toLocaleLowerCase();
  const resolvedParent = resolve(parent).toLocaleLowerCase();
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}\\`) || resolvedChild.startsWith(`${resolvedParent}/`);
}

function textOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function shelfForItem(id) {
  return normalizeLibraryShelf(libraryShelf.get(id) || {});
}

function normalizeLibraryShelf(value) {
  const readingStatus = ["unread", "reading", "finished", "paused"].includes(value?.reading_status) ? value.reading_status : "unread";
  const lastPage = Number.parseInt(String(value?.last_page ?? ""), 10);
  return {
    favorite: Boolean(value?.favorite),
    reading_status: readingStatus,
    note: typeof value?.note === "string" ? value.note : "",
    last_page: Number.isFinite(lastPage) && lastPage > 0 ? lastPage : null,
    last_read_at: typeof value?.last_read_at === "string" ? value.last_read_at : null,
    updated_at: typeof value?.updated_at === "string" ? value.updated_at : null,
  };
}

function toStableId(root, folderName) {
  return Buffer.from(`${root}\0${folderName}`, "utf8").toString("base64url");
}

async function loadLibraryShelf() {
  try {
    const text = await readFile(libraryShelfFile, "utf8");
    const savedShelf = JSON.parse(text);
    if (!savedShelf || typeof savedShelf !== "object" || Array.isArray(savedShelf)) {
      console.warn(`Ignoring invalid library shelf file: ${libraryShelfFile}`);
      return;
    }

    for (const [id, value] of Object.entries(savedShelf)) {
      if (typeof id === "string" && id) {
        libraryShelf.set(id, normalizeLibraryShelf(value));
      }
    }
    console.log(`Loaded ${libraryShelf.size} library shelf item(s) from ${libraryShelfFile}`);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    console.warn(`Failed to load library shelf file ${libraryShelfFile}: ${error.message}`);
  }
}

async function persistLibraryShelf() {
  await mkdir(dataDir, { recursive: true });
  const sortedEntries = Array.from(libraryShelf.entries()).sort(([left], [right]) => left.localeCompare(right));
  await writeFile(libraryShelfFile, JSON.stringify(Object.fromEntries(sortedEntries), null, 2), "utf8");
}

async function loadPersistedTasks() {
  try {
    const text = await readFile(tasksFile, "utf8");
    const savedTasks = JSON.parse(text);
    if (!Array.isArray(savedTasks)) {
      console.warn(`Ignoring invalid task data file: ${tasksFile}`);
      return;
    }

    let changed = false;
    for (const savedTask of savedTasks) {
      if (!savedTask || typeof savedTask.id !== "string") {
        continue;
      }
      const { task, normalized } = normalizeLoadedTask(savedTask);
      tasks.set(task.id, task);
      changed = changed || normalized;
    }

    console.log(`Loaded ${tasks.size} task(s) from ${tasksFile}`);
    if (changed) {
      persistTasksSoon();
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    console.warn(`Failed to load task data file ${tasksFile}: ${error.message}`);
  }
}

async function loadReaderSessions() {
  try {
    const text = await readFile(readerSessionsFile, "utf8");
    const savedSessions = JSON.parse(text);
    if (!Array.isArray(savedSessions)) {
      console.warn(`Ignoring invalid reader session file: ${readerSessionsFile}`);
      return;
    }

    for (const savedSession of savedSessions) {
      const session = normalizeLoadedReaderSession(savedSession);
      if (session) {
        readerSessions.set(session.id, session);
      }
    }
    console.log(`Loaded ${readerSessions.size} reader session(s) from ${readerSessionsFile}`);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    console.warn(`Failed to load reader session file ${readerSessionsFile}: ${error.message}`);
  }
}

function normalizeLoadedReaderSession(savedSession) {
  if (!savedSession || typeof savedSession !== "object" || Array.isArray(savedSession)) {
    return null;
  }
  const source = sourceById.get(textOrNull(savedSession.source_id));
  if (!source || !sourceSupportsOnlineRead(source)) {
    return null;
  }
  const galleryUrl = textOrNull(savedSession.gallery_url);
  const rawPages = Array.isArray(savedSession.pages) ? savedSession.pages : [];
  const pages = normalizeReaderPages(rawPages, galleryUrl || "");
  if (!galleryUrl || !pages.length) {
    return null;
  }
  const id = textOrNull(savedSession.id) || readerSessionId(source.id, galleryUrl);
  const now = new Date().toISOString();
  return {
    id,
    source_id: source.id,
    source_name: source.name,
    gallery_url: galleryUrl,
    title: textOrNull(savedSession.title) || galleryUrl,
    tags: Array.isArray(savedSession.tags) ? savedSession.tags.map((tag) => textOrNull(tag)).filter(Boolean) : [],
    page_count: Number(savedSession.page_count || pages.length),
    pages,
    last_page: normalizeReaderLastPage(savedSession.last_page, pages.length),
    last_read_at: textOrNull(savedSession.last_read_at),
    bookmarks: normalizeReaderBookmarks(savedSession.bookmarks || [], pages.length),
    created_at: textOrNull(savedSession.created_at) || now,
    updated_at: textOrNull(savedSession.updated_at) || now,
  };
}

function normalizeReaderLastPage(value, totalPages) {
  const page = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(page) || page < 1) {
    return null;
  }
  return Math.min(page, Math.max(totalPages, 1));
}

function persistReaderSessionsSoon() {
  readerSessionSaveChain = readerSessionSaveChain
    .then(async () => {
      await mkdir(dataDir, { recursive: true });
      const sessions = Array.from(readerSessions.values())
        .sort((left, right) => readerSessionSortTime(right).localeCompare(readerSessionSortTime(left)))
        .slice(0, 100)
        .map((session) => ({
          id: session.id,
          source_id: session.source_id,
          source_name: session.source_name,
          gallery_url: session.gallery_url,
          title: session.title,
          tags: session.tags,
          page_count: session.page_count,
          pages: session.pages,
          last_page: session.last_page || null,
          last_read_at: session.last_read_at || null,
          bookmarks: normalizeReaderBookmarks(session.bookmarks || [], session.pages.length),
          created_at: session.created_at,
          updated_at: session.updated_at,
        }));
      await writeFile(readerSessionsFile, JSON.stringify(sessions, null, 2), "utf8");
    })
    .catch((error) => {
      console.error(`Failed to persist reader sessions: ${error.message}`);
    });
}

function normalizeLoadedTask(savedTask) {
  const now = new Date().toISOString();
  const task = {
    id: savedTask.id,
    kind: savedTask.kind || "search",
    status: savedTask.status || "failed",
    title: savedTask.title || savedTask.id,
    payload: savedTask.payload || {},
    progress: savedTask.progress || { total: 1, done: 0, failed: 1, message: "loaded from invalid snapshot" },
    output: savedTask.output ?? null,
    created_at: savedTask.created_at || now,
    updated_at: savedTask.updated_at || now,
  };

  const interrupted = task.status === "queued" || task.status === "running" || task.status === "paused";
  if (interrupted) {
    task.status = "failed";
    task.progress = {
      total: task.progress.total || 1,
      done: task.progress.done || 0,
      failed: task.progress.failed || 1,
      message: "interrupted by dev API restart; create a new task to rerun",
    };
    task.updated_at = now;
  }

  return { task, normalized: interrupted };
}

function persistTasksSoon() {
  saveChain = saveChain
    .then(async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(tasksFile, JSON.stringify(listTasks(), null, 2), "utf8");
    })
    .catch((error) => {
      console.error(`Failed to persist dev API tasks: ${error.message}`);
    });
}

function titleForSearch(payload) {
  if (Array.isArray(payload.tags) && payload.tags.length) {
    return payload.tags.join(" ");
  }
  return payload.name || payload.query || "search";
}

function optionalArg(name, value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return [];
  }
  return [name, String(value)];
}

function classifyUpdateEvent(payload) {
  if (payload.status === "running") return "task_started";
  if (payload.status === "completed") return "task_completed";
  if (payload.status === "failed") return "task_failed";
  if (payload.status === "canceled") return "task_canceled";
  if (payload.progress) return "task_progressed";
  return "task_updated";
}

function touch(task) {
  task.updated_at = new Date().toISOString();
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath, mimeType, fileStat, extraHeaders = {}) {
  response.writeHead(200, {
    "content-type": mimeType,
    "content-length": fileStat.size,
    "cache-control": "private, max-age=300",
    ...extraHeaders,
  });
  const stream = createReadStream(filePath);
  stream.on("error", (error) => response.destroy(error));
  stream.pipe(response);
}

function readJson(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(body));
      } catch (error) {
        rejectPromise(error);
      }
    });
    request.on("error", rejectPromise);
  });
}

function resolvePython(envKeys = []) {
  for (const envKey of envKeys) {
    if (process.env[envKey]) {
      return process.env[envKey];
    }
  }
  const legacyPython = resolve(projectRoot, "..", ".venv", "Scripts", "python.exe");
  return legacyPython;
}
