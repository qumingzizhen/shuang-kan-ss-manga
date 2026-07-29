import { mkdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export function createSourceAuthManager({ authDir, specs, describeSources, environment = process.env }) {
  if (!authDir || !specs || typeof describeSources !== "function") {
    throw new Error("source auth manager requires authDir, specs, and describeSources");
  }

  function requireSpec(sourceId) {
    const spec = specs[sourceId];
    if (!spec) {
      throw new Error(`source auth is not configurable for ${sourceId}`);
    }
    return spec;
  }

  async function refreshManagedEnv() {
    await Promise.all(
      Object.values(specs).map(async (spec) => {
        if (spec.cookieEnv && spec.cookieFile) {
          await applyManagedEnv(spec.cookieEnv, spec.cookieFile);
        }
        if (spec.headersEnv && spec.headersFile) {
          await applyManagedEnv(spec.headersEnv, spec.headersFile);
        }
      }),
    );
  }

  async function applyManagedEnv(envKey, filePath) {
    if (environment[envKey] && environment[envKey] !== filePath) {
      return;
    }
    if (await fileExists(filePath)) {
      environment[envKey] = filePath;
    } else if (environment[envKey] === filePath) {
      delete environment[envKey];
    }
  }

  async function status(sourceId) {
    const spec = requireSpec(sourceId);
    await refreshManagedEnv();
    const effectiveCookieFile = spec.cookieEnv ? environment[spec.cookieEnv] || null : null;
    const effectiveHeadersFile = spec.headersEnv ? environment[spec.headersEnv] || null : null;
    const [localCookieExists, localHeadersExists, effectiveCookieExists, effectiveHeadersExists] =
      await Promise.all([
        fileExists(spec.cookieFile),
        fileExists(spec.headersFile),
        fileExists(effectiveCookieFile),
        fileExists(effectiveHeadersFile),
      ]);
    const source = describeSources().find((item) => item.id === sourceId);
    return {
      source_id: sourceId,
      configured: effectiveCookieExists || effectiveHeadersExists,
      local_cookie_file: spec.cookieFile,
      local_headers_file: spec.headersFile,
      has_local_cookie_file: localCookieExists,
      has_local_headers_file: localHeadersExists,
      effective_cookie_file: effectiveCookieFile,
      effective_headers_file: effectiveHeadersFile,
      has_effective_cookie_file: effectiveCookieExists,
      has_effective_headers_file: effectiveHeadersExists,
      available_for_default: source?.available_for_default === true,
      unavailable_reason: source?.unavailable_reason || null,
    };
  }

  async function save(sourceId, payload) {
    const spec = requireSpec(sourceId);
    const { cookie, headers } = normalizePayload(payload);
    if (!cookie && !headers) {
      throw new Error("cookie or headers is required");
    }
    if (cookie && !spec.cookieFile) {
      throw new Error(`source auth cookie is not supported for ${sourceId}`);
    }
    if (headers && !spec.headersFile) {
      throw new Error(`source auth headers are not supported for ${sourceId}`);
    }

    await mkdir(authDir, { recursive: true });
    await Promise.all([
      cookie ? writeFile(spec.cookieFile, `${cookie}\n`, "utf8") : null,
      headers ? writeFile(spec.headersFile, `${headers}\n`, "utf8") : null,
    ]);
    await refreshManagedEnv();
    return status(sourceId);
  }

  async function remove(sourceId) {
    const spec = requireSpec(sourceId);
    await Promise.all(
      [spec.cookieFile, spec.headersFile]
        .filter(Boolean)
        .map((filePath) => rm(filePath, { force: true })),
    );
    await refreshManagedEnv();
    return status(sourceId);
  }

  function bridgeEnv(sourceAdapter) {
    const env = { ...environment, PYTHONIOENCODING: "utf-8" };
    const spec = specs[sourceAdapter?.id];
    if (!spec) {
      return env;
    }
    for (const key of [spec.cookieEnv, spec.headersEnv].filter(Boolean)) {
      if (!env[key] && environment[key]) {
        env[key] = environment[key];
      }
    }
    return env;
  }

  return { bridgeEnv, refreshManagedEnv, remove, save, status };
}

function normalizePayload(payload) {
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
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf(":");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!key || !value) continue;
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
      if (!headerKey || !headerValue) continue;
      if (headerKey.toLowerCase() === "cookie") {
        cookieParts.push(cleanCookieHeader(headerValue));
      } else {
        headerLines.push(`${headerKey}: ${headerValue}`);
      }
    }
  }

  const cookie = Array.from(
    new Set(
      cookieParts
        .filter(Boolean)
        .flatMap((item) => item.split(";").map((part) => part.trim()).filter(Boolean)),
    ),
  ).join("; ");
  return { cookie, headers: Array.from(new Set(headerLines)).join("\n") };
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

function textOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

async function writePrivateText(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}