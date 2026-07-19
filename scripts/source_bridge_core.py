from __future__ import annotations

import argparse
import contextlib
import json
import mimetypes
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any


IMAGE_EXT_RE = re.compile(r"\.(?:avif|gif|jpe?g|png|webp)(?:[?#].*)?$", re.IGNORECASE)
IMAGE_URL_RE = re.compile(
    r"(?:https?:)?//[^\"'\\\s<>]+?\.(?:avif|gif|jpe?g|png|webp)(?:\?[^\"'\\\s<>]*)?",
    re.IGNORECASE,
)
IMAGE_ATTR_RE = re.compile(
    r"(?:src|data-original|data-src|data-lazy-src|data-url|srcset)\s*=\s*([\"'])(.*?)\1",
    re.IGNORECASE | re.DOTALL,
)
CSS_URL_RE = re.compile(r"url\(\s*([\"']?)(.*?)\1\s*\)", re.IGNORECASE | re.DOTALL)
BAD_THUMBNAIL_FILE_NAMES = {
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
}
BAD_THUMBNAIL_NAME_PARTS = (
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
)
BLOCKED_STATUSES = {401, 403, 429}
TRANSIENT_STATUSES = {408, 425, 500, 502, 503, 504}
ACCESS_CHALLENGE_RE = re.compile(
    r"(?:<title>\s*just a moment|checking your browser|verify you are human|cf_chl|cf-turnstile|turnstile|captcha|cloudflare)",
    re.IGNORECASE,
)


@dataclass
class DownloadStats:
    done: int = 0
    skipped: int = 0
    failed: int = 0
    stopped: bool = False


@dataclass
class ImageTarget:
    index: int
    page_url: str
    image_url: str
    referer: str


class ParsedHtml(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.anchors: list[dict[str, str]] = []
        self.images: list[dict[str, str]] = []
        self.meta: dict[str, str] = {}
        self.scripts: list[str] = []
        self.text_chunks: list[str] = []
        self.title = ""
        self._current_anchor: dict[str, Any] | None = None
        self._in_title = False
        self._in_script = False
        self._script_chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = {key.lower(): value or "" for key, value in attrs}
        tag = tag.lower()
        if tag == "a":
            self._current_anchor = {
                "href": absolute_url(attrs_map.get("href", ""), self.base_url),
                "title": clean_text(attrs_map.get("title", "")),
                "text": "",
            }
        elif tag == "img":
            source = first_present(
                attrs_map,
                "data-original",
                "data-src",
                "data-lazy-src",
                "data-url",
                "src",
                "srcset",
            )
            image = {
                "src": absolute_url(first_srcset_url(source), self.base_url),
                "alt": clean_text(attrs_map.get("alt", "")),
                "id": attrs_map.get("id", ""),
                "class": attrs_map.get("class", ""),
            }
            if image["src"]:
                self.images.append(image)
        elif tag == "meta":
            key = (attrs_map.get("property") or attrs_map.get("name") or "").lower()
            content = clean_text(attrs_map.get("content", ""))
            if key and content:
                self.meta[key] = content
        elif tag == "title":
            self._in_title = True
        elif tag == "script":
            self._in_script = True
            self._script_chunks = []

    def handle_data(self, data: str) -> None:
        if self._in_script:
            self._script_chunks.append(data)
            return
        if self._in_title:
            self.title += data
        if self._current_anchor is not None:
            self._current_anchor["text"] += data
        self.text_chunks.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "a" and self._current_anchor is not None:
            self._current_anchor["text"] = clean_text(self._current_anchor["text"])
            if self._current_anchor.get("href"):
                self.anchors.append(self._current_anchor)
            self._current_anchor = None
        elif tag == "title":
            self._in_title = False
            self.title = clean_text(self.title)
        elif tag == "script":
            self._in_script = False
            script = "\n".join(self._script_chunks).strip()
            if script:
                self.scripts.append(script)
            self._script_chunks = []


class HttpStatusError(RuntimeError):
    def __init__(self, status: int, url: str, message: str, *, kind: str = "http_status") -> None:
        super().__init__(message)
        self.status = status
        self.url = url
        self.kind = kind


class HttpClient:
    def __init__(self, parsed: argparse.Namespace, *, source_label: str = "source adapter") -> None:
        self.source_label = source_label
        self.timeout = parsed.timeout
        self.delay = max(float(parsed.delay), 0.0)
        self.retries = max(int(parsed.retries), 0)
        self.retry_backoff = max(float(parsed.retry_backoff), 0.0)
        self.http_backend = getattr(parsed, "http_backend", "urllib")
        self.impersonate = getattr(parsed, "impersonate", "chrome124")
        self.curl_requests = self.load_curl_requests(self.http_backend)
        self.headers = {
            "user-agent": parsed.user_agent,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
        }
        if getattr(parsed, "browser_navigation_headers", False):
            self.headers.update(browser_navigation_headers(parsed.user_agent))
        self.headers.update(read_headers_file(parsed.headers_file))
        cookie_header = load_cookie_header(parsed.cookies_file)
        if cookie_header:
            self.headers["cookie"] = cookie_header
        self.opener = urllib.request.build_opener()

    def fetch_text(self, url: str, referer: str | None = None) -> str:
        _status, headers, body = self.fetch(url, referer=referer)
        content_type = header_value(headers, "content-type")
        charset = charset_from_content_type(content_type) or "utf-8"
        try:
            return body.decode(charset, errors="replace")
        except LookupError:
            return body.decode("utf-8", errors="replace")

    def fetch_binary(self, url: str, referer: str | None = None) -> tuple[bytes, str | None]:
        _status, headers, body = self.fetch(url, referer=referer)
        content_type = header_value(headers, "content-type")
        if not looks_like_image(url, content_type, body):
            raise RuntimeError(f"Expected image response for {url}, got content-type={content_type or 'unknown'}")
        return body, content_type

    def fetch(self, url: str, referer: str | None = None) -> tuple[int, dict[str, str], bytes]:
        parsed_url = urllib.parse.urlparse(url)
        if parsed_url.scheme not in {"http", "https"}:
            raise RuntimeError(f"Unsupported URL scheme: {url}")

        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            headers = dict(self.headers)
            if referer:
                headers["referer"] = referer
            try:
                if self.curl_requests is not None:
                    return self.fetch_with_curl(url, headers)
                request = urllib.request.Request(url, headers=headers)
                with self.opener.open(request, timeout=self.timeout) as response:
                    return response.status, dict(response.headers.items()), response.read()
            except HttpStatusError as error:
                if error.status in BLOCKED_STATUSES:
                    raise
                last_error = error
                if error.status not in TRANSIENT_STATUSES or attempt >= self.retries:
                    break
            except urllib.error.HTTPError as error:
                response_headers = dict(error.headers.items()) if error.headers else {}
                body = read_error_body(error)
                if error.code in BLOCKED_STATUSES:
                    raise http_status_error(error.code, url, self.source_label, response_headers, body) from error
                last_error = http_status_error(error.code, url, self.source_label, response_headers, body)
                if error.code not in TRANSIENT_STATUSES or attempt >= self.retries:
                    break
            except urllib.error.URLError as error:
                last_error = RuntimeError(f"Request failed for {url}: {error.reason}")
                if attempt >= self.retries:
                    break
            except Exception as error:
                if self.curl_requests is None:
                    raise
                last_error = RuntimeError(f"Request failed for {url}: {error}")
                if attempt >= self.retries:
                    break

            self.wait_for_retry(attempt)

        if last_error is not None:
            raise last_error
        raise RuntimeError(f"Request failed for {url}")

    @staticmethod
    def load_curl_requests(http_backend: str | None) -> Any | None:
        backend = (http_backend or "urllib").strip().lower()
        if backend not in {"curl_cffi", "auto"}:
            return None
        try:
            from curl_cffi import requests as curl_requests  # type: ignore
        except Exception:
            if backend == "curl_cffi":
                raise RuntimeError("curl_cffi backend requested, but curl_cffi is not installed")
            return None
        return curl_requests

    def fetch_with_curl(self, url: str, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
        response = self.curl_requests.get(
            url,
            headers=headers,
            timeout=self.timeout,
            allow_redirects=True,
            impersonate=self.impersonate,
        )
        status = int(response.status_code)
        response_headers = dict(response.headers.items())
        body = bytes(response.content)
        if status in BLOCKED_STATUSES:
            raise http_status_error(status, url, self.source_label, response_headers, body)
        if status >= 400:
            raise http_status_error(status, url, self.source_label, response_headers, body)
        return status, response_headers, body

    def wait_for_retry(self, attempt: int) -> None:
        if self.retry_backoff > 0:
            time.sleep(self.retry_backoff * (2**attempt))

    def polite_wait(self) -> None:
        if self.delay > 0:
            time.sleep(self.delay)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    value = unescape(value)
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def first_present(attrs: dict[str, str], *names: str) -> str:
    for name in names:
        value = attrs.get(name)
        if value:
            return value
    return ""


def first_srcset_url(value: str) -> str:
    value = clean_text(value)
    if "," in value:
        value = value.split(",", 1)[0]
    if " " in value:
        value = value.split(" ", 1)[0]
    return value


def absolute_url(value: str, base_url: str) -> str:
    value = clean_text(value)
    if not value or value.startswith(("javascript:", "mailto:", "#")):
        return ""
    if value.startswith("//"):
        return f"https:{value}"
    return urllib.parse.urljoin(base_url, value)


def strip_fragment(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return urllib.parse.urlunparse(parsed._replace(fragment=""))


def image_url_candidates_from_html(text: str, base_url: str) -> list[tuple[int, str]]:
    candidates: list[tuple[int, str]] = []
    seen: set[str] = set()

    def add(position: int, value: str) -> None:
        url = strip_fragment(absolute_url(first_srcset_url(unescape(value)), base_url))
        if not url or url in seen or not is_likely_search_thumbnail_url(url):
            return
        seen.add(url)
        candidates.append((position, url))

    for match in IMAGE_ATTR_RE.finditer(text):
        add(match.start(2), match.group(2))
    for match in CSS_URL_RE.finditer(text):
        add(match.start(2), match.group(2))
    for match in IMAGE_URL_RE.finditer(text):
        add(match.start(0), match.group(0))

    return candidates


def is_likely_search_thumbnail_url(url: str) -> bool:
    if not IMAGE_EXT_RE.search(url):
        return False

    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    path = urllib.parse.unquote(parsed.path).lower()
    filename = path.rsplit("/", 1)[-1]
    stem = filename.rsplit(".", 1)[0]

    if not filename or filename in BAD_THUMBNAIL_FILE_NAMES:
        return False
    if host.endswith("ehgt.org") and path in {"/g/t.png", "/g/td.png"}:
        return False
    if len(stem) <= 2 and host.endswith("ehgt.org") and path.startswith("/g/"):
        return False
    if any(part in filename for part in BAD_THUMBNAIL_NAME_PARTS):
        return False

    return True


def find_nearby_image_url(text: str, page_url: str, markers: list[str], *, before: int = 2600, after: int = 2600) -> str:
    marker_positions: list[int] = []
    for marker in markers:
        marker = clean_text(marker)
        if not marker:
            continue
        variants = {marker, unescape(marker)}
        for variant in variants:
            start = 0
            while True:
                index = text.find(variant, start)
                if index < 0:
                    break
                marker_positions.append(index)
                start = index + max(len(variant), 1)

    for marker_position in sorted(set(marker_positions)):
        window_start = max(0, marker_position - before)
        window = text[window_start : marker_position + after]
        candidates = image_url_candidates_from_html(window, page_url)
        candidates.sort(key=lambda item: abs(window_start + item[0] - marker_position))
        if candidates:
            return candidates[0][1]

    return ""


def header_value(headers: dict[str, str], key: str) -> str | None:
    key = key.lower()
    for header_key, value in headers.items():
        if header_key.lower() == key:
            return value
    return None


def parse_html(text: str, base_url: str) -> ParsedHtml:
    parser = ParsedHtml(base_url)
    parser.feed(text)
    parser.close()
    return parser


def browser_navigation_headers(user_agent: str) -> dict[str, str]:
    browser_major = browser_major_version(user_agent) or "146"
    if "Edg/" in user_agent:
        sec_ch_ua = f'"Microsoft Edge";v="{browser_major}", "Chromium";v="{browser_major}", "Not_A Brand";v="99"'
    else:
        sec_ch_ua = f'"Chromium";v="{browser_major}", "Not_A Brand";v="99"'
    return {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "cache-control": "max-age=0",
        "priority": "u=0, i",
        "sec-ch-ua": sec_ch_ua,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
    }


def browser_major_version(user_agent: str) -> str | None:
    match = re.search(r"(?:Edg|Chrome)/(\d+)", user_agent or "")
    return match.group(1) if match else None


def read_error_body(error: urllib.error.HTTPError, limit: int = 16384) -> bytes:
    try:
        return error.read(limit)
    except Exception:
        return b""


def http_status_error(
    status: int,
    url: str,
    source_label: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> HttpStatusError:
    kind = "access_challenge" if looks_like_access_challenge(body or b"", header_value(headers or {}, "content-type")) else "http_status"
    return HttpStatusError(status, url, status_message(status, url, source_label, headers, body), kind=kind)


def status_message(
    status: int,
    url: str,
    source_label: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> str:
    if status in BLOCKED_STATUSES:
        if looks_like_access_challenge(body or b"", header_value(headers or {}, "content-type")):
            return (
                f"{source_label} returned a browser verification/challenge page (HTTP {status}) for {url}. "
                "The adapter cannot use that page as comic data and will not solve or bypass Cloudflare, "
                "captchas, login, age gates, bans, or rate limits."
            )
        return (
            f"{source_label} returned HTTP {status} for {url}. "
            "The adapter stops here and does not bypass login, age gates, captchas, bans, or rate limits."
        )
    return f"HTTP {status} for {url}"


def looks_like_access_challenge(body: bytes, content_type: str | None = None) -> bool:
    if not body:
        return False
    if content_type:
        normalized = content_type.split(";", 1)[0].strip().lower()
        if normalized and normalized not in {"text/html", "application/xhtml+xml", "text/plain"}:
            return False
    sample = body[:16384].decode("utf-8", errors="ignore")
    return bool(ACCESS_CHALLENGE_RE.search(sample))


def charset_from_content_type(content_type: str | None) -> str | None:
    if not content_type:
        return None
    match = re.search(r"charset=([^;\s]+)", content_type, re.IGNORECASE)
    return match.group(1).strip("\"'") if match else None


def looks_like_image(url: str, content_type: str | None, body: bytes) -> bool:
    if content_type:
        normalized = content_type.split(";", 1)[0].strip().lower()
        if normalized.startswith("image/") or normalized == "application/octet-stream":
            return True
        if normalized.startswith("text/html"):
            return False
    if IMAGE_EXT_RE.search(url):
        return True
    return body.startswith((b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"RIFF")) or body[:12] == b"\x00\x00\x00\x0cjP  "


def read_headers_file(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise RuntimeError(f"Headers file not found: {file_path}")
    text = file_path.read_text(encoding="utf-8")
    with contextlib.suppress(json.JSONDecodeError):
        payload = json.loads(text)
        if isinstance(payload, dict):
            return {str(key).lower(): str(value) for key, value in payload.items()}
    headers: dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        value = value.strip()
        if key and value:
            headers[key] = value
    return headers


def load_cookie_header(path: str | None) -> str:
    if not path:
        return ""
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise RuntimeError(f"Cookie file not found: {file_path}")
    text = file_path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return ""
    if "=" in text and "\t" not in text and "\n" not in text:
        return text
    jar = MozillaCookieJar(str(file_path))
    jar.load(ignore_discard=True, ignore_expires=True)
    return "; ".join(f"{cookie.name}={cookie.value}" for cookie in jar)


def sanitize_filename(value: str, fallback: str = "comic", limit: int = 120) -> str:
    value = clean_text(value)
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    if not value:
        value = fallback
    return value[:limit].rstrip(" .")


def image_extension(url: str, content_type: str | None) -> str:
    if content_type:
        normalized = content_type.split(";", 1)[0].strip().lower()
        guessed = mimetypes.guess_extension(normalized)
        if guessed == ".jpe":
            return ".jpg"
        if guessed in {".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"}:
            return guessed
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in {".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"} else ".jpg"


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def content_type_from_suffix(suffix: str) -> str | None:
    return mimetypes.types_map.get(suffix.lower())
