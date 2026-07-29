const DEFAULT_BACKEND_API_URL = "http://127.0.0.1:8080";
const DEFAULT_PROXY_TIMEOUT_MS = 900_000;
const MIN_PROXY_TIMEOUT_MS = 1_000;
const MAX_PROXY_TIMEOUT_MS = 2_147_483_647;

export function resolveBackendApiUrl(value = process.env.BACKEND_API_URL): string {
  const candidate = value?.trim() || DEFAULT_BACKEND_API_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`BACKEND_API_URL must be an absolute HTTP(S) URL: ${candidate}`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("BACKEND_API_URL must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new Error("BACKEND_API_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("BACKEND_API_URL must not contain a query string or fragment");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

export function resolveBackendProxyTimeoutMs(
  value = process.env.BACKEND_PROXY_TIMEOUT_MS,
): number {
  if (!value?.trim()) {
    return DEFAULT_PROXY_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_PROXY_TIMEOUT_MS ||
    parsed > MAX_PROXY_TIMEOUT_MS
  ) {
    throw new Error(
      `BACKEND_PROXY_TIMEOUT_MS must be an integer between ${MIN_PROXY_TIMEOUT_MS} and ${MAX_PROXY_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

export function createApiRewrite(backendApiUrl = resolveBackendApiUrl()) {
  return {
    source: "/v1/:path*",
    destination: `${backendApiUrl}/v1/:path*`,
  };
}

export const backendProxyTimeoutMs = resolveBackendProxyTimeoutMs();
export const apiRewrite = createApiRewrite();
