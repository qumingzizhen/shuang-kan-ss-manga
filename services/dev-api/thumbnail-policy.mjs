const badThumbnailFileNames = new Set([
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
const badThumbnailNameParts = [
  "arrow",
  "blank",
  "button",
  "download",
  "favicon",
  "icon",
  "loader",
  "loading",
  "placeholder",
  "pixel",
  "sprite",
];

export function cleanSearchThumbnailUrl(value) {
  const thumbnailUrl = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return thumbnailUrl && !isBadSearchThumbnailUrl(thumbnailUrl) ? thumbnailUrl : null;
}

export function isBadSearchThumbnailUrl(value) {
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
  if (!filename || badThumbnailFileNames.has(filename)) {
    return true;
  }
  if (host.endsWith("ehgt.org") && (path === "/g/t.png" || path === "/g/td.png")) {
    return true;
  }
  if (host.endsWith("ehgt.org") && path.startsWith("/g/") && stem.length <= 2) {
    return true;
  }
  return badThumbnailNameParts.some((part) => filename.includes(part));
}
export function validateThumbnailUrl(source, thumbnailUrl) {
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

export function isAllowedThumbnailHost(source, hostname) {
  const host = String(hostname || "").toLowerCase();
  const configuredHosts = Array.isArray(source?.thumbnail_hosts) ? source.thumbnail_hosts : [];
  for (const configuredHost of configuredHosts) {
    const allowed = String(configuredHost || "").trim().toLowerCase();
    if (allowed && (host === allowed || host.endsWith(`.${allowed}`))) {
      return true;
    }
  }

  const homepageHost = hostForUrl(source?.homepage);
  return Boolean(homepageHost && (host === homepageHost || host.endsWith(`.${homepageHost}`)));
}

export function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::" || host === "::1") {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
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

  if (!host.includes(":")) {
    return false;
  }
  if (host.startsWith("::ffff:")) {
    return isPrivateHostname(host.slice("::ffff:".length));
  }
  const firstGroup = host.split(":", 1)[0];
  return host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(firstGroup);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hostForUrl(value) {
  try {
    return value ? new URL(value).hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}
