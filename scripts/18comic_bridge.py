from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import sys
import urllib.parse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import jmcomic_api_adapter

from source_bridge_core import (
    BLOCKED_STATUSES,
    DownloadStats,
    HttpClient,
    HttpStatusError,
    IMAGE_EXT_RE,
    IMAGE_URL_RE,
    ImageTarget,
    ParsedHtml,
    absolute_url,
    clean_text,
    content_type_from_suffix,
    find_nearby_image_url,
    image_extension,
    looks_like_access_challenge,
    now_iso,
    parse_html,
    sanitize_filename,
    status_message,
    strip_fragment,
    write_json_atomic,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = "18comic"
DEFAULT_BASE_URL = "https://18comic.vip/"
DEFAULT_OUTPUT = PROJECT_ROOT / ".data" / "downloads"
PAGE_ARTIFACT_ROOT = PROJECT_ROOT / ".data" / "page-artifacts" / SOURCE_ID
PROGRESS_PREFIX = "__COMIC_PLATFORM_PROGRESS__"
DEFAULT_MIN_IMAGE_BYTES = 2048
FALLBACK_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0"
)

ALBUM_RE = re.compile(r"/album/(\d+)(?:[/?#]|$)")
PHOTO_RE = re.compile(r"/photo/(\d+)(?:/(\d+))?(?:[/?#]|$)")
TAG_NAMESPACE_RE = re.compile(r"^([A-Za-z][\w-]{0,31})\s*[:：]\s*(.+)$")


def default_user_agent() -> str:
    configured = os.environ.get("COMIC18_USER_AGENT")
    if configured:
        return configured
    edge_version = detect_windows_edge_version()
    if edge_version:
        edge_major = edge_version.split(".", 1)[0]
        return (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            f"(KHTML, like Gecko) Chrome/{edge_major}.0.0.0 Safari/537.36 Edg/{edge_version}"
        )
    return FALLBACK_USER_AGENT


def detect_windows_edge_version() -> str:
    if os.name != "nt":
        return ""
    roots = [
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application"),
        Path(r"C:\Program Files\Microsoft\Edge\Application"),
    ]
    versions: list[tuple[tuple[int, ...], str]] = []
    for root in roots:
        with contextlib.suppress(OSError):
            for child in root.iterdir():
                if not child.is_dir() or not re.fullmatch(r"\d+(?:\.\d+){1,4}", child.name):
                    continue
                versions.append((tuple(int(part) for part in child.name.split(".")), child.name))
    if not versions:
        return ""
    versions.sort(key=lambda item: item[0])
    return versions[-1][1]


@dataclass
class GalleryMeta:
    source_id: str
    title: str
    url: str
    gid: str
    token: str
    length: int | None
    tags: dict[str, list[str]]
    image_pages: list[str]


def normalize_base_url(value: str) -> str:
    value = (value or DEFAULT_BASE_URL).strip()
    if not value.endswith("/"):
        value += "/"
    return value


def ensure_18comic_url(url: str, base_url: str) -> str:
    normalized = absolute_url(url, base_url)
    base_host = urllib.parse.urlparse(base_url).hostname or ""
    url_host = urllib.parse.urlparse(normalized).hostname or ""
    if not ALBUM_RE.search(normalized) and not PHOTO_RE.search(normalized):
        raise RuntimeError(f"Unrecognized 18comic gallery URL: {url}")
    if url_host and base_host and url_host != base_host and not url_host.endswith(f".{base_host}"):
        raise RuntimeError(f"Gallery URL host must match configured 18comic host: {url}")
    return normalized


def album_id_from_url(url: str) -> str:
    match = ALBUM_RE.search(url)
    if match:
        return match.group(1)
    photo_match = PHOTO_RE.search(url)
    if photo_match:
        return photo_match.group(1)
    raise RuntimeError(f"Missing album id in URL: {url}")


def normalize_search_part(value: str) -> str:
    value = clean_text(value)
    if not value:
        return ""
    match = TAG_NAMESPACE_RE.match(value)
    if match:
        value = match.group(2)
    value = value.replace(":", " ").replace("：", " ")
    return re.sub(r"\s+", " ", value).strip()


def build_query(tags: list[str], name: str | None, query: str | None) -> str:
    parts: list[str] = []
    for item in tags:
        normalized = normalize_search_part(item)
        if normalized:
            parts.append(normalized)
    if name and name.strip():
        normalized = normalize_search_part(name)
        if normalized:
            parts.append(normalized)
    if query and query.strip():
        normalized = normalize_search_part(query)
        if normalized:
            parts.append(normalized)
    return " ".join(parts).strip()


def build_site_query(tags: list[str], name: str | None, query: str | None) -> str:
    parts: list[str] = []
    for item in tags:
        text = clean_text(item)
        if text:
            parts.append(text)
    for item in (name, query):
        text = clean_text(item)
        if text:
            parts.append(text)
    return " ".join(parts).strip()


def search_page_urls(base_url: str, site_query: str, legacy_query: str, page: int) -> list[str]:
    site_encoded = urllib.parse.quote_plus(site_query)
    legacy_encoded = urllib.parse.quote_plus(legacy_query or site_query)
    urls: list[str] = []

    def add(path: str) -> None:
        url = urllib.parse.urljoin(base_url, path)
        if url not in urls:
            urls.append(url)

    # Current 18comic search pages use f_search. The first path mirrors the
    # document request visible in the browser Network panel.
    if page == 1:
        add(f"/meiman?f_search={site_encoded}")
        add(f"/search?f_search={site_encoded}")
        add(f"/?f_search={site_encoded}")
    add(f"/meiman?f_search={site_encoded}&page={page}")
    add(f"/search?f_search={site_encoded}&page={page}")
    add(f"/?f_search={site_encoded}&page={page}")

    # Keep older endpoints as fallbacks for mirrors that still expose them.
    add(f"/search/photos?search_query={legacy_encoded}&main_tag=0&page={page}")
    add(f"/search/photos?search_query={legacy_encoded}&page={page}")
    add(f"/search/albums?search_query={legacy_encoded}&page={page}")
    add(f"/search?search_query={legacy_encoded}&page={page}")
    add(f"/albums?search_query={legacy_encoded}&page={page}")
    return urls


def gallery_match_from_url(url: str) -> re.Match[str] | None:
    return ALBUM_RE.search(url) or PHOTO_RE.search(url)


def gallery_marker_from_match(match: re.Match[str]) -> str:
    prefix = "album" if match.re is ALBUM_RE else "photo"
    return f"/{prefix}/{match.group(1)}"


def parse_search_results(text: str, page_url: str) -> list[dict[str, Any]]:
    parser = parse_html(text, page_url)
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for anchor in parser.anchors:
        href = anchor.get("href", "")
        match = gallery_match_from_url(href)
        if not match:
            continue
        url = strip_fragment(href)
        if url in seen:
            continue
        seen.add(url)
        title = clean_search_title(anchor.get("title") or anchor.get("text") or f"album-{match.group(1)}")
        thumbnail_url = find_nearby_image_url(text, page_url, [href, url, gallery_marker_from_match(match)])
        result = {"source_id": SOURCE_ID, "title": title, "url": url, "gid": match.group(1), "tags": []}
        if thumbnail_url:
            result["thumbnail_url"] = thumbnail_url
        results.append(result)

    if results:
        return results

    for match in re.finditer(r"href=[\"']([^\"']*/(?:album|photo)/(\d+)[^\"']*)[\"'][^>]*>(.*?)</a>", text, re.I | re.S):
        url = strip_fragment(absolute_url(match.group(1), page_url))
        if url in seen:
            continue
        seen.add(url)
        title = clean_search_title(match.group(3) or f"album-{match.group(2)}")
        thumbnail_url = find_nearby_image_url(text, page_url, [match.group(1), url, f"/album/{match.group(2)}", f"/photo/{match.group(2)}"])
        result = {"source_id": SOURCE_ID, "title": title, "url": url, "gid": match.group(2), "tags": []}
        if thumbnail_url:
            result["thumbnail_url"] = thumbnail_url
        results.append(result)
    return results


def clean_search_title(value: str) -> str:
    value = clean_text(value)
    value = re.sub(r"^(?:read|view|detail|reading)\s*", "", value, flags=re.I)
    return value or "untitled"


def parse_gallery_meta(text: str, url: str, base_url: str) -> GalleryMeta:
    parser = parse_html(text, url)
    gid = album_id_from_url(url)
    title = pick_title(parser, gid)
    tags = {"tag": extract_tags(parser)}
    image_pages = extract_photo_pages(parser, url)
    length = extract_page_count(parser, text)
    if length is None and image_pages:
        length = len(image_pages)
    if not image_pages and length and length <= 2000:
        image_pages = infer_photo_pages(base_url, gid, length)

    return GalleryMeta(
        source_id=SOURCE_ID,
        title=title,
        url=url,
        gid=gid,
        token="",
        length=length,
        tags=tags,
        image_pages=image_pages,
    )


def pick_title(parser: ParsedHtml, gid: str) -> str:
    blocked_suffixes = f"(?:18comic|jmcomic|{re.escape(chr(0x7981) + chr(0x6f2b) + chr(0x5929) + chr(0x5802))})"
    candidates = [
        parser.meta.get("og:title", ""),
        parser.meta.get("twitter:title", ""),
        parser.title,
    ]
    for candidate in candidates:
        candidate = clean_text(candidate)
        candidate = re.sub(rf"\s*[-|_]\s*{blocked_suffixes}.*$", "", candidate, flags=re.I)
        if candidate:
            return candidate
    return f"18comic-{gid}"


def extract_tags(parser: ParsedHtml) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    for anchor in parser.anchors:
        href = anchor.get("href", "")
        if "/tag" not in href and "/tags" not in href and "search_query" not in href:
            continue
        text = clean_text(anchor.get("text") or anchor.get("title"))
        if not text or len(text) > 60:
            continue
        key = text.lower()
        if key not in seen:
            seen.add(key)
            tags.append(text)
    return tags[:80]


def extract_photo_pages(parser: ParsedHtml, page_url: str) -> list[str]:
    pages: list[str] = []
    seen: set[str] = set()
    for anchor in parser.anchors:
        href = anchor.get("href", "")
        if not PHOTO_RE.search(href) and not IMAGE_EXT_RE.search(href):
            continue
        url = strip_fragment(absolute_url(href, page_url))
        if url and url not in seen:
            seen.add(url)
            pages.append(url)
    return pages


def extract_page_count(parser: ParsedHtml, raw_html: str) -> int | None:
    text = clean_text(" ".join(parser.text_chunks))
    candidates: list[int] = []
    labels = [
        "pages?",
        "page count",
        "total pages?",
        chr(0x9801) + chr(0x6578),
        chr(0x9875) + chr(0x6570),
        chr(0x7e3d) + chr(0x9801) + chr(0x6578),
        chr(0x603b) + chr(0x9875) + chr(0x6570),
        chr(0x5716) + chr(0x7247) + chr(0x6578),
        chr(0x56fe) + chr(0x7247) + chr(0x6570),
    ]
    label_pattern = "|".join(labels)
    patterns = [
        rf"(?:{label_pattern})\D{{0,16}}(\d{{1,4}})",
        r"(\d{1,4})\s*(?:pages?|p)\b",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            value = int(match.group(1))
            if 0 < value <= 2000:
                candidates.append(value)
    for pattern in [
        r"page_count[\"']?\s*[:=]\s*[\"']?(\d{1,4})",
        r"total[\"']?\s*[:=]\s*[\"']?(\d{1,4})",
        r"total_photo[\"']?\s*[:=]\s*[\"']?(\d{1,4})",
    ]:
        for match in re.finditer(pattern, raw_html, re.I):
            value = int(match.group(1))
            if 0 < value <= 2000:
                candidates.append(value)
    return max(candidates) if candidates else None


def infer_photo_pages(base_url: str, gid: str, length: int) -> list[str]:
    return [urllib.parse.urljoin(base_url, f"/photo/{gid}/{index}") for index in range(1, length + 1)]


def parse_photo_images(text: str, page_url: str) -> list[str]:
    parser = parse_html(text, page_url)
    images: list[str] = []
    seen: set[str] = set()
    for image in parser.images:
        url = strip_fragment(absolute_url(image.get("src", ""), page_url))
        if usable_page_image(url, image) and url not in seen:
            seen.add(url)
            images.append(url)
    script_text = "\n".join(parser.scripts).replace("\\/", "/")
    for match in IMAGE_URL_RE.finditer(script_text):
        url = strip_fragment(absolute_url(match.group(0), page_url))
        if url and url not in seen and usable_page_image(url, {}):
            seen.add(url)
            images.append(url)
    return images


def usable_page_image(url: str, image: dict[str, str]) -> bool:
    if not url or not IMAGE_EXT_RE.search(url):
        return False
    lowered = url.lower()
    blocked_tokens = ["avatar", "banner", "blank", "icon", "loading", "logo", "sprite", "/ads/"]
    if any(token in lowered for token in blocked_tokens):
        return False
    label = f"{image.get('id', '')} {image.get('class', '')}".lower()
    if label and any(token in label for token in ["avatar", "banner", "logo", "placeholder"]):
        return False
    return True


def gallery_folder(output: Path, meta: GalleryMeta) -> Path:
    return output.expanduser() / sanitize_filename(f"{meta.title} [{meta.gid}]")


def metadata_to_json(meta: GalleryMeta, base_url: str) -> dict[str, Any]:
    payload = asdict(meta)
    payload["site"] = base_url
    payload["updated_at"] = now_iso()
    return payload


def selected_targets(targets: list[ImageTarget], parsed: argparse.Namespace) -> list[ImageTarget]:
    start = max(parsed.start_page or 1, 1)
    end = parsed.end_page if parsed.end_page and parsed.end_page >= start else None
    selected = [target for target in targets if target.index >= start and (end is None or target.index <= end)]
    if parsed.max_pages_per_run and parsed.max_pages_per_run > 0:
        selected = selected[: parsed.max_pages_per_run]
    return selected


def selected_page_entries(page_urls: list[str], parsed: argparse.Namespace) -> list[tuple[int, str]]:
    start = max(parsed.start_page or 1, 1)
    end = parsed.end_page if parsed.end_page and parsed.end_page >= start else None
    selected = [(index, page_url) for index, page_url in enumerate(page_urls or [], 1) if index >= start and (end is None or index <= end)]
    if parsed.max_pages_per_run and parsed.max_pages_per_run > 0:
        selected = selected[: parsed.max_pages_per_run]
    return selected


def download_concurrency(parsed: argparse.Namespace) -> int:
    return max(1, min(int(parsed.download_concurrency or 1), 8))


def resolve_image_targets(client: HttpClient, meta: GalleryMeta, parsed: argparse.Namespace) -> list[ImageTarget]:
    entries = selected_page_entries(meta.image_pages or [], parsed)
    if download_concurrency(parsed) <= 1 or len(entries) <= 1:
        targets: list[ImageTarget] = []
        for page_index, page_url in entries:
            targets.append(resolve_single_image_target(client, page_url, page_index, meta.url))
            client.polite_wait()
        return targets

    return sorted(resolve_image_targets_concurrently(meta, parsed, entries), key=lambda target: target.index)


def resolve_image_targets_concurrently(meta: GalleryMeta, parsed: argparse.Namespace, entries: list[tuple[int, str]]) -> list[ImageTarget]:
    targets: list[ImageTarget] = []

    def worker(entry: tuple[int, str]) -> ImageTarget:
        page_index, page_url = entry
        worker_client = HttpClient(parsed, source_label="18comic.vip")
        try:
            return resolve_single_image_target(worker_client, page_url, page_index, meta.url)
        finally:
            worker_client.polite_wait()

    with ThreadPoolExecutor(max_workers=download_concurrency(parsed)) as executor:
        futures = [executor.submit(worker, entry) for entry in entries]
        for future in futures:
            targets.append(future.result())

    return targets


def resolve_single_image_target(client: HttpClient, page_url: str, index: int, gallery_url: str) -> ImageTarget:
    if IMAGE_EXT_RE.search(page_url):
        return ImageTarget(index, page_url, page_url, gallery_url)

    html = client.fetch_text(page_url, referer=gallery_url)
    image_urls = parse_photo_images(html, page_url)
    if not image_urls:
        raise RuntimeError(f"No image URL found on photo page {page_url}")
    return ImageTarget(index, page_url, image_urls[0], page_url)


def image_files(folder: Path) -> set[int]:
    indexes: set[int] = set()
    if not folder.exists():
        return indexes
    for child in folder.iterdir():
        if not child.is_file() or not IMAGE_EXT_RE.search(child.name):
            continue
        match = re.match(r"^(\d+)", child.stem)
        if match:
            indexes.add(int(match.group(1)))
    return indexes


def existing_image_for_index(folder: Path, index: int) -> Path | None:
    if not folder.exists():
        return None
    prefix = f"{index:04d}"
    for child in folder.iterdir():
        if child.is_file() and child.stem == prefix and IMAGE_EXT_RE.search(child.name):
            return child
    return None


def load_metadata(folder: Path) -> GalleryMeta:
    data = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
    tags = data.get("tags") if isinstance(data.get("tags"), dict) else {"tag": list(data.get("tags") or [])}
    return GalleryMeta(
        source_id=str(data.get("source_id") or SOURCE_ID),
        title=str(data.get("title") or folder.name),
        url=str(data.get("url") or data.get("gallery_url") or ""),
        gid=str(data.get("gid") or ""),
        token=str(data.get("token") or ""),
        length=data.get("length") if isinstance(data.get("length"), int) else data.get("page_count"),
        tags=tags,
        image_pages=[str(item) for item in data.get("image_pages") or []],
    )


def write_failed_page(folder: Path, target: ImageTarget, error: str) -> None:
    record = {
        "timestamp": now_iso(),
        "source_id": SOURCE_ID,
        "index": target.index,
        "page_url": target.page_url,
        "image_url": target.image_url,
        "error": error,
    }
    with (folder / "failed_pages.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def update_download_state(folder: Path, meta: GalleryMeta, stats: DownloadStats, total: int, last_index: int | None) -> None:
    payload = {
        "source_id": SOURCE_ID,
        "gallery_url": meta.url,
        "title": meta.title,
        "total": total,
        "done": stats.done,
        "skipped": stats.skipped,
        "failed": stats.failed,
        "stopped": stats.stopped,
        "last_index": last_index,
        "updated_at": now_iso(),
    }
    write_json_atomic(
        folder / "download_state.json",
        payload,
    )
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}", file=sys.stderr, flush=True)


def save_image_target(
    client: HttpClient,
    folder: Path,
    target: ImageTarget,
    overwrite: bool,
    min_image_bytes: int,
) -> tuple[Path, str | None, int, bool]:
    existing = existing_image_for_index(folder, target.index)
    if existing and not overwrite and existing.stat().st_size >= min_image_bytes:
        return existing, content_type_from_suffix(existing.suffix), existing.stat().st_size, True

    body, content_type = client.fetch_binary(target.image_url, referer=target.referer)
    if len(body) < min_image_bytes:
        raise RuntimeError(
            f"Image response is too small for page {target.index}: {len(body)} bytes from {target.image_url}. "
            "This usually means the source returned a placeholder or blocked image."
        )
    extension = image_extension(target.image_url, content_type)
    file_path = folder / f"{target.index:04d}{extension}"
    file_path.write_bytes(body)
    return file_path, content_type, len(body), False


def download_one_target(folder: Path, target: ImageTarget, parsed: argparse.Namespace) -> bool:
    client = HttpClient(parsed, source_label="18comic.vip")
    try:
        _file_path, _content_type, _byte_size, skipped = save_image_target(
            client,
            folder,
            target,
            parsed.overwrite,
            max(parsed.min_image_bytes, 0),
        )
        return skipped
    finally:
        client.polite_wait()


def download_targets(folder: Path, meta: GalleryMeta, targets: list[ImageTarget], parsed: argparse.Namespace) -> DownloadStats:
    stats = DownloadStats()
    if download_concurrency(parsed) <= 1 or len(targets) <= 1:
        client = HttpClient(parsed, source_label="18comic.vip")
        forbidden_failures = 0
        for target in targets:
            try:
                _file_path, _content_type, _byte_size, skipped = save_image_target(
                    client,
                    folder,
                    target,
                    parsed.overwrite,
                    max(parsed.min_image_bytes, 0),
                )
                if skipped:
                    stats.skipped += 1
                else:
                    stats.done += 1
                forbidden_failures = 0
            except HttpStatusError as error:
                stats.failed += 1
                if error.status in BLOCKED_STATUSES:
                    forbidden_failures += 1
                write_failed_page(folder, target, str(error))
                if parsed.forbidden_stop_after and forbidden_failures >= parsed.forbidden_stop_after:
                    stats.stopped = True
                    break
            except Exception as error:  # noqa: BLE001 - bridge must report per-page failures.
                stats.failed += 1
                write_failed_page(folder, target, str(error))
                if parsed.max_failures and stats.failed >= parsed.max_failures:
                    stats.stopped = True
                    break
            finally:
                update_download_state(folder, meta, stats, len(targets), target.index)
                client.polite_wait()
        return stats

    forbidden_failures = 0
    next_index = 0
    pending: dict[Any, ImageTarget] = {}
    stop_scheduling = False

    with ThreadPoolExecutor(max_workers=download_concurrency(parsed)) as executor:
        def submit_next() -> None:
            nonlocal next_index
            if stop_scheduling or next_index >= len(targets):
                return
            target = targets[next_index]
            next_index += 1
            pending[executor.submit(download_one_target, folder, target, parsed)] = target

        for _ in range(min(download_concurrency(parsed), len(targets))):
            submit_next()

        while pending:
            completed, _pending = wait(pending.keys(), return_when=FIRST_COMPLETED)
            for future in completed:
                target = pending.pop(future)
                try:
                    skipped = future.result()
                    if skipped:
                        stats.skipped += 1
                    else:
                        stats.done += 1
                    forbidden_failures = 0
                except HttpStatusError as error:
                    stats.failed += 1
                    if error.status in BLOCKED_STATUSES:
                        forbidden_failures += 1
                    write_failed_page(folder, target, str(error))
                    if parsed.forbidden_stop_after and forbidden_failures >= parsed.forbidden_stop_after:
                        stats.stopped = True
                        stop_scheduling = True
                except Exception as error:  # noqa: BLE001 - bridge must report per-page failures.
                    stats.failed += 1
                    write_failed_page(folder, target, str(error))
                    if parsed.max_failures and stats.failed >= parsed.max_failures:
                        stats.stopped = True
                        stop_scheduling = True
                finally:
                    update_download_state(folder, meta, stats, len(targets), target.index)

                if not stop_scheduling:
                    submit_next()

    return stats


def page_descriptors(meta: GalleryMeta) -> list[dict[str, Any]]:
    return [
        {
            "source_id": SOURCE_ID,
            "gallery_url": meta.url,
            "page_url": page_url,
            "index": index,
        }
        for index, page_url in enumerate(meta.image_pages or [], 1)
    ]


def fetch_gallery_meta(parsed: argparse.Namespace) -> GalleryMeta:
    base_url = normalize_base_url(parsed.base_url)
    gallery_url = ensure_18comic_url(parsed.gallery_url, base_url)
    client = HttpClient(parsed, source_label="18comic.vip")
    html = client.fetch_text(gallery_url)
    return parse_gallery_meta(html, gallery_url, base_url)


def run_web_search(parsed: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(parsed.base_url)
    tags = json.loads(parsed.tags_json)
    site_query = build_site_query(tags, parsed.name, parsed.query)
    legacy_query = build_query(tags, parsed.name, parsed.query)
    query = site_query or legacy_query
    if not query:
        raise RuntimeError("Search requires tags, name, or query")

    client = HttpClient(parsed, source_label="18comic.vip")
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in range(1, parsed.max_search_pages + 1):
        page_results: list[dict[str, Any]] = []
        blocked_errors: list[HttpStatusError] = []
        fetched_any_candidate = False
        for page_url in search_page_urls(base_url, site_query or query, legacy_query or query, page):
            try:
                html = client.fetch_text(page_url)
            except HttpStatusError as error:
                if error.status in BLOCKED_STATUSES:
                    blocked_errors.append(error)
                    if getattr(error, "kind", "") == "access_challenge":
                        break
                    client.polite_wait()
                    continue
                raise
            fetched_any_candidate = True
            page_results = parse_search_results(html, page_url)
            client.polite_wait()
            if page_results:
                break
        if not page_results and not fetched_any_candidate and blocked_errors:
            attempted_urls = ", ".join(error.url for error in blocked_errors[:3])
            extra = "..." if len(blocked_errors) > 3 else ""
            challenge_error = next((error for error in blocked_errors if getattr(error, "kind", "") == "access_challenge"), None)
            reason = clean_text(str(challenge_error or blocked_errors[0]))
            if challenge_error is not None:
                raise RuntimeError(
                    "18comic.vip search reached the current search entry but received a browser verification/challenge page. "
                    f"Query: {query}. Legacy query: {legacy_query or query}. Attempted: {attempted_urls}{extra}. "
                    f"Reason: {reason} "
                    "This is not a tag parser problem or an old URL problem; the adapter will not solve or bypass that challenge. "
                    "Cookie/Header import only works when the site accepts direct authorized requests."
                )
            raise RuntimeError(
                f"18comic.vip search was blocked for all attempted public search URLs. "
                f"Query: {query}. Legacy query: {legacy_query or query}. Attempted: {attempted_urls}{extra}. "
                f"Reason: {reason} "
                "Provide your own authorized 18comic Cookie/Header in the web source settings or through "
                "COMIC18_COOKIE_FILE / COMIC18_HEADERS_FILE for normal access; "
                "the adapter will not bypass login, age gates, captchas, bans, or rate limits."
            )
        for item in page_results:
            if item["url"] in seen:
                continue
            seen.add(item["url"])
            results.append(item)
            if len(results) >= parsed.limit:
                break
        if len(results) >= parsed.limit or not page_results:
            break

    return {"source_id": SOURCE_ID, "query": query, "results": results[: parsed.limit]}


def run_web_gallery(parsed: argparse.Namespace) -> dict[str, Any]:
    meta = fetch_gallery_meta(parsed)
    return {
        "source_id": SOURCE_ID,
        "title": meta.title,
        "url": meta.url,
        "gid": meta.gid,
        "tags": flatten_tags(meta.tags),
        "page_count": meta.length or len(meta.image_pages) or None,
    }


def run_web_list_pages(parsed: argparse.Namespace) -> dict[str, Any]:
    meta = fetch_gallery_meta(parsed)
    pages = page_descriptors(meta)
    return {
        "source_id": SOURCE_ID,
        "title": meta.title,
        "gallery_url": meta.url,
        "tags": flatten_tags(meta.tags),
        "page_count": meta.length or len(pages) or None,
        "pages": pages,
    }


def run_web_download_gallery(parsed: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(parsed.base_url)
    gallery_url = ensure_18comic_url(parsed.gallery_url, base_url)
    client = HttpClient(parsed, source_label="18comic.vip")
    html = client.fetch_text(gallery_url)
    meta = parse_gallery_meta(html, gallery_url, base_url)
    folder = gallery_folder(parsed.output, meta)

    targets = selected_targets(resolve_image_targets(client, meta, parsed), parsed)
    if parsed.dry_run:
        return {
            "source_id": SOURCE_ID,
            "title": meta.title,
            "url": meta.url,
            "output_folder": str(folder),
            "page_count": len(targets) or meta.length or len(meta.image_pages) or None,
            "done": 0,
            "skipped": 0,
            "failed": 0,
            "stopped": False,
            "dry_run": True,
        }

    folder.mkdir(parents=True, exist_ok=True)
    write_json_atomic(folder / "metadata.json", metadata_to_json(meta, base_url))

    stats = download_targets(folder, meta, targets, parsed)

    return {
        "source_id": SOURCE_ID,
        "title": meta.title,
        "url": meta.url,
        "output_folder": str(folder),
        "page_count": len(targets) or meta.length or len(meta.image_pages) or None,
        "done": stats.done,
        "skipped": stats.skipped,
        "failed": stats.failed,
        "stopped": stats.stopped,
        "dry_run": False,
    }


def run_web_download_page(parsed: argparse.Namespace) -> dict[str, Any]:
    if not parsed.gallery_url:
        raise RuntimeError("--gallery-url is required")
    if not parsed.page_url:
        raise RuntimeError("--page-url is required")
    index = parsed.page_index or parsed.start_page or 1
    base_url = normalize_base_url(parsed.base_url)
    gallery_url = ensure_18comic_url(parsed.gallery_url, base_url)
    client = HttpClient(parsed, source_label="18comic.vip")
    target = resolve_single_image_target(client, absolute_url(parsed.page_url, gallery_url), index, gallery_url)
    folder = parsed.page_output.expanduser() if parsed.page_output else PAGE_ARTIFACT_ROOT / album_id_from_url(gallery_url)
    folder.mkdir(parents=True, exist_ok=True)
    file_path, content_type, byte_size, _skipped = save_image_target(
        client,
        folder,
        target,
        parsed.overwrite,
        max(parsed.min_image_bytes, 0),
    )
    return {
        "source_id": SOURCE_ID,
        "page_url": target.page_url,
        "storage_key": str(file_path),
        "content_type": content_type,
        "byte_size": byte_size,
    }


def run_with_transport(
    parsed: argparse.Namespace,
    api_runner: Any,
    web_runner: Any,
) -> dict[str, Any]:
    transport = str(getattr(parsed, "transport", "auto") or "auto").strip().lower()
    if transport == "web":
        return web_runner()

    try:
        return api_runner()
    except Exception as api_error:  # noqa: BLE001 - auto mode has an explicit web fallback.
        if transport == "api":
            raise RuntimeError(f"18comic API transport failed: {api_error}") from api_error
        try:
            return web_runner()
        except Exception as web_error:  # noqa: BLE001 - report both transport failures.
            raise RuntimeError(
                f"18comic API transport failed: {api_error}. "
                f"Web fallback also failed: {web_error}"
            ) from web_error


def run_search(parsed: argparse.Namespace) -> dict[str, Any]:
    tags = json.loads(parsed.tags_json)
    query = build_query(tags, parsed.name, parsed.query)
    base_url = normalize_base_url(parsed.base_url)
    return run_with_transport(
        parsed,
        lambda: jmcomic_api_adapter.search(parsed, query, base_url),
        lambda: run_web_search(parsed),
    )


def run_gallery(parsed: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(parsed.base_url)
    return run_with_transport(
        parsed,
        lambda: jmcomic_api_adapter.gallery(parsed, parsed.gallery_url, base_url),
        lambda: run_web_gallery(parsed),
    )


def run_list_pages(parsed: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(parsed.base_url)
    return run_with_transport(
        parsed,
        lambda: jmcomic_api_adapter.list_pages(parsed, parsed.gallery_url, base_url),
        lambda: run_web_list_pages(parsed),
    )


def run_download_gallery(parsed: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(parsed.base_url)
    return run_with_transport(
        parsed,
        lambda: jmcomic_api_adapter.download_gallery(parsed, parsed.gallery_url, base_url),
        lambda: run_web_download_gallery(parsed),
    )


def run_download_page(parsed: argparse.Namespace) -> dict[str, Any]:
    return run_with_transport(
        parsed,
        lambda: jmcomic_api_adapter.download_page(parsed, parsed.gallery_url, parsed.page_url),
        lambda: run_web_download_page(parsed),
    )


def run_retry_plan(parsed: argparse.Namespace) -> dict[str, Any]:
    folder = Path(parsed.folder).expanduser().resolve()
    if not (folder / "metadata.json").exists():
        raise RuntimeError(f"metadata.json not found: {folder / 'metadata.json'}")
    meta = load_metadata(folder)
    total = meta.length or len(meta.image_pages)
    if not total:
        raise RuntimeError("metadata.json does not include length or image_pages")
    existing = image_files(folder)
    page_indexes = list(range(1, total + 1))
    if parsed.missing_only:
        page_indexes = [index for index in page_indexes if index not in existing]
    if parsed.start_page:
        page_indexes = [index for index in page_indexes if index >= parsed.start_page]
    if parsed.end_page:
        page_indexes = [index for index in page_indexes if index <= parsed.end_page]
    return {"source_id": SOURCE_ID, "folder": str(folder), "page_indexes": page_indexes}


def flatten_tags(tags: dict[str, list[str]]) -> list[str]:
    flattened: list[str] = []
    for namespace, values in tags.items():
        for value in values:
            text = clean_text(value)
            if not text:
                continue
            flattened.append(f"{namespace}:{text}" if namespace and namespace != "tag" else text)
    return flattened


def run_self_test() -> dict[str, Any]:
    search_html = """
    <article class="album-card">
      <a class="thumb" href="/album/12345/sample" title="Sample Book">
        <img src="/assets/download-arrow.png" alt="">
        <img data-src="/media/albums/12345-cover.webp" alt="Sample Book">
        Read
      </a>
    </article>
    <article class="album-card">
      <a class="thumb" href="/photo/54321" title="Photo Style Book">
        <img data-src="/media/albums/54321-cover.webp" alt="Photo Style Book">
        Read
      </a>
    </article>
    <a href="https://18comic.vip/album/12345/sample">duplicate</a>
    """
    gallery_html = """
    <html><head><meta property="og:title" content="Sample Book - 18comic"></head>
    <body><span>Pages: 2</span><a href="/tags/love">love</a>
    <a href="/photo/12345/1">1</a><a href="/photo/12345/2">2</a></body></html>
    """
    photo_html = """
    <img id="album_photo_1" src="https://cdn.example.test/00001.jpg">
    <script>var next = "https:\\/\\/cdn.example.test\\/00002.webp";</script>
    """
    search_results = parse_search_results(search_html, DEFAULT_BASE_URL)
    search_urls = search_page_urls(DEFAULT_BASE_URL, "female:futanari", "futanari", 1)
    challenge_body = b"<html><head><title>Just a moment...</title></head><body>Cloudflare</body></html>"
    challenge_message = status_message(403, DEFAULT_BASE_URL, "18comic.vip", {"content-type": "text/html"}, challenge_body)
    gallery = parse_gallery_meta(gallery_html, f"{DEFAULT_BASE_URL}album/12345/sample", DEFAULT_BASE_URL)
    images = parse_photo_images(photo_html, f"{DEFAULT_BASE_URL}photo/12345/1")
    pages = page_descriptors(gallery)
    selected = selected_targets(
        [
            ImageTarget(1, "/photo/12345/1", "https://cdn.example.test/00001.jpg", "/photo/12345/1"),
            ImageTarget(2, "/photo/12345/2", "https://cdn.example.test/00002.jpg", "/photo/12345/2"),
        ],
        argparse.Namespace(start_page=2, end_page=None, max_pages_per_run=0),
    )
    assert len(search_results) == 2, search_results
    assert search_results[0].get("thumbnail_url") == f"{DEFAULT_BASE_URL}media/albums/12345-cover.webp", search_results
    assert search_results[1]["url"] == f"{DEFAULT_BASE_URL}photo/54321", search_results
    assert build_query(["female:big breasts", "language:chinese"], None, None) == "big breasts chinese"
    assert build_site_query(["female:big breasts", "language:chinese"], None, None) == "female:big breasts language:chinese"
    assert search_urls[0] == f"{DEFAULT_BASE_URL}meiman?f_search=female%3Afutanari", search_urls
    assert looks_like_access_challenge(challenge_body, "text/html")
    assert "browser verification/challenge page" in challenge_message
    assert build_query(["artist：sample name"], None, None) == "sample name"
    assert gallery.title == "Sample Book", gallery.title
    assert gallery.length == 2, gallery.length
    assert len(gallery.image_pages) == 2, gallery.image_pages
    assert len(images) == 2, images
    assert pages[0]["index"] == 1 and pages[1]["index"] == 2
    assert selected[0].index == 2
    assert jmcomic_api_adapter.parse_page_url("jmapi://photo/12345/2") == ("12345", 2)
    return {"ok": True, "search_results": len(search_results), "photo_images": len(images), "pages": len(pages)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Conservative JSON bridge for public 18comic.vip pages.")
    parser.add_argument(
        "command",
        choices=("search", "gallery", "list-pages", "download-gallery", "download-page", "retry-plan", "self-test"),
    )
    parser.add_argument("--base-url", default=os.environ.get("COMIC18_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--tags-json", default="[]")
    parser.add_argument("--name")
    parser.add_argument("--query")
    parser.add_argument("--gallery-url")
    parser.add_argument("--page-url")
    parser.add_argument("--page-index", type=int)
    parser.add_argument("--folder")
    parser.add_argument("--missing-only", action="store_true")
    parser.add_argument("--start-page", type=int)
    parser.add_argument("--end-page", type=int)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("COMIC18_OUTPUT", DEFAULT_OUTPUT)))
    parser.add_argument("--page-output", type=Path, default=Path(os.environ["COMIC18_PAGE_OUTPUT"]) if os.environ.get("COMIC18_PAGE_OUTPUT") else None)
    parser.add_argument("--cookies-file", default=os.environ.get("COMIC18_COOKIE_FILE"))
    parser.add_argument("--headers-file", default=os.environ.get("COMIC18_HEADERS_FILE"))
    parser.add_argument(
        "--transport",
        choices=("auto", "api", "web"),
        default=os.environ.get("COMIC18_TRANSPORT", "auto"),
    )
    parser.add_argument("--http-backend", default=os.environ.get("COMIC18_HTTP_BACKEND", "auto"))
    parser.add_argument("--impersonate", default=os.environ.get("COMIC18_IMPERSONATE", "chrome146"))
    parser.add_argument("--delay", type=float, default=float(os.environ.get("COMIC18_DELAY", "2.5")))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("COMIC18_TIMEOUT", "45")))
    parser.add_argument("--retries", type=int, default=int(os.environ.get("COMIC18_RETRIES", "2")))
    parser.add_argument("--retry-backoff", type=float, default=float(os.environ.get("COMIC18_RETRY_BACKOFF", "1.5")))
    parser.add_argument("--max-search-pages", type=int, default=int(os.environ.get("COMIC18_MAX_SEARCH_PAGES", "2")))
    parser.add_argument("--max-pages-per-run", type=int, default=int(os.environ.get("COMIC18_MAX_PAGES_PER_RUN", "0")))
    parser.add_argument("--max-failures", type=int, default=int(os.environ.get("COMIC18_MAX_FAILURES", "10")))
    parser.add_argument("--download-concurrency", type=int, default=int(os.environ.get("COMIC18_DOWNLOAD_CONCURRENCY", "3")))
    parser.add_argument("--min-image-bytes", type=int, default=int(os.environ.get("COMIC18_MIN_IMAGE_BYTES", str(DEFAULT_MIN_IMAGE_BYTES))))
    parser.add_argument("--forbidden-stop-after", type=int, default=int(os.environ.get("COMIC18_FORBIDDEN_STOP_AFTER", "2")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--user-agent",
        default=default_user_agent(),
    )
    parser.set_defaults(browser_navigation_headers=True)
    return parser


def main() -> int:
    parser = build_parser()
    parsed = parser.parse_args()
    try:
        with contextlib.redirect_stdout(sys.stderr):
            if parsed.command == "self-test":
                payload = run_self_test()
            elif parsed.command == "search":
                payload = run_search(parsed)
            elif parsed.command == "gallery":
                if not parsed.gallery_url:
                    raise RuntimeError("--gallery-url is required")
                payload = run_gallery(parsed)
            elif parsed.command == "list-pages":
                if not parsed.gallery_url:
                    raise RuntimeError("--gallery-url is required")
                payload = run_list_pages(parsed)
            elif parsed.command == "download-gallery":
                if not parsed.gallery_url:
                    raise RuntimeError("--gallery-url is required")
                payload = run_download_gallery(parsed)
            elif parsed.command == "download-page":
                payload = run_download_page(parsed)
            else:
                if not parsed.folder:
                    raise RuntimeError("--folder is required")
                payload = run_retry_plan(parsed)
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - keep bridge stderr concise for task errors.
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
