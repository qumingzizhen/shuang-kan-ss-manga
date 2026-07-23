from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import re
import sys
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from source_bridge_core import (
    BLOCKED_STATUSES,
    DownloadProgressReporter,
    HttpClient,
    HttpStatusError,
    IMAGE_EXT_RE,
    IMAGE_URL_RE,
    ImageTarget,
    ParsedHtml,
    absolute_url,
    append_failed_page,
    clean_text,
    find_nearby_image_url,
    image_files,
    now_iso,
    parse_html,
    run_bounded_downloads,
    save_image_target,
    sanitize_filename,
    strip_fragment,
    write_json_atomic,
)
from source_tag_resolver import resolve_source_tag


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = "e-hentai"
DEFAULT_BASE_URL = "https://e-hentai.org/"
DEFAULT_OUTPUT = PROJECT_ROOT / ".data" / "downloads"
PAGE_ARTIFACT_ROOT = PROJECT_ROOT / ".data" / "page-artifacts" / SOURCE_ID
GALLERY_PAGE_SIZE = 40
PROGRESS_PREFIX = "__COMIC_PLATFORM_PROGRESS__"
DEFAULT_MIN_IMAGE_BYTES = 2048

GALLERY_RE = re.compile(r"/g/(\d+)/([0-9a-f]+)/?", re.IGNORECASE)
PAGE_RE = re.compile(r"/s/([^/?#]+)/(\d+)-(\d+)(?:[/?#]|$)", re.IGNORECASE)
TAG_NAMESPACE_RE = re.compile(r"^([A-Za-z][\w-]{0,31})\s*[:：]\s*(.+)$")


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


def ensure_ehentai_gallery_url(url: str, base_url: str) -> str:
    normalized = strip_fragment(absolute_url(url, base_url))
    match = GALLERY_RE.search(normalized)
    if not match:
        raise RuntimeError(f"Unrecognized E-Hentai gallery URL: {url}")
    base_host = urllib.parse.urlparse(base_url).hostname or ""
    url_host = urllib.parse.urlparse(normalized).hostname or ""
    if base_host and url_host and url_host != base_host and not url_host.endswith(f".{base_host}"):
        raise RuntimeError(f"Gallery URL host must match configured E-Hentai host: {url}")
    return urllib.parse.urlunparse(urllib.parse.urlparse(normalized)._replace(query=""))


def gallery_parts(url: str) -> tuple[str, str]:
    match = GALLERY_RE.search(url)
    if not match:
        raise RuntimeError(f"Missing E-Hentai gallery id/token in URL: {url}")
    return match.group(1), match.group(2)


def normalize_search_part(value: str) -> str:
    value = clean_text(value)
    if not value:
        return ""
    match = TAG_NAMESPACE_RE.match(value)
    if match:
        namespace = match.group(1).lower()
        tag_value = re.sub(r"\s+", " ", match.group(2).replace("_", " ")).strip()
        return f"{namespace}:{tag_value}" if tag_value else ""
    return re.sub(r"\s+", " ", value.replace("_", " ")).strip()


def build_query(tags: list[str], name: str | None, query: str | None) -> str:
    parts: list[str] = []
    for item in tags:
        normalized = normalize_search_part(resolve_source_tag(item, SOURCE_ID))
        if normalized:
            parts.append(normalized)
    for item in (name, query):
        normalized = normalize_search_part(item or "")
        if normalized:
            parts.append(normalized)
    return " ".join(parts).strip()


def search_page_url(base_url: str, query: str, page: int) -> str:
    params = urllib.parse.urlencode({"f_search": query, "f_cats": "0", "page": str(page)})
    return urllib.parse.urljoin(base_url, f"?{params}")


def parse_search_results(text: str, page_url: str) -> list[dict[str, Any]]:
    parser = parse_html(text, page_url)
    by_url: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for anchor in parser.anchors:
        href = anchor.get("href", "")
        match = GALLERY_RE.search(href)
        if not match:
            continue
        url = strip_fragment(absolute_url(href, page_url))
        title = clean_search_title(anchor.get("title") or anchor.get("text") or "")
        if not title:
            title = f"e-hentai-{match.group(1)}"
        thumbnail_url = find_nearby_image_url(text, page_url, [href, url, f"/g/{match.group(1)}/{match.group(2)}"])
        item = by_url.get(url)
        if item is None:
            by_url[url] = {
                "source_id": SOURCE_ID,
                "title": title,
                "url": url,
                "gid": match.group(1),
                "token": match.group(2),
                "tags": [],
            }
            if thumbnail_url:
                by_url[url]["thumbnail_url"] = thumbnail_url
            order.append(url)
        elif better_title(title, item["title"]):
            item["title"] = title
            if thumbnail_url and not item.get("thumbnail_url"):
                item["thumbnail_url"] = thumbnail_url
        elif thumbnail_url and not item.get("thumbnail_url"):
            item["thumbnail_url"] = thumbnail_url

    return [by_url[url] for url in order]


def clean_search_title(value: str) -> str:
    value = clean_text(value)
    value = re.sub(r"^image:\s*", "", value, flags=re.IGNORECASE)
    if value.lower() in {"t", "thumbnail", "image"}:
        return ""
    return value


def better_title(candidate: str, current: str) -> bool:
    if not candidate:
        return False
    if not current or current.lower() in {"untitled", "t", "thumbnail", "image"}:
        return True
    if current.lower().startswith("image:"):
        return True
    return len(candidate) > len(current) and not candidate.lower().startswith("image:")


def parse_gallery_meta(text: str, url: str) -> GalleryMeta:
    parser = parse_html(text, url)
    gid, token = gallery_parts(url)
    page_map = extract_gallery_page_map(parser, url)
    return GalleryMeta(
        source_id=SOURCE_ID,
        title=pick_title(parser, text, gid),
        url=url,
        gid=gid,
        token=token,
        length=extract_page_count(parser, text),
        tags=extract_tags(parser),
        image_pages=[page_map[index] for index in sorted(page_map)],
    )


def pick_title(parser: ParsedHtml, raw_html: str, gid: str) -> str:
    for element_id in ("gn", "gj"):
        match = re.search(rf"<h1[^>]+id=[\"']{element_id}[\"'][^>]*>(.*?)</h1>", raw_html, re.IGNORECASE | re.DOTALL)
        if match:
            title = clean_text(match.group(1))
            if title:
                return title
    for candidate in (parser.meta.get("og:title", ""), parser.title):
        title = clean_text(candidate)
        title = re.sub(r"\s*[-|]\s*E-Hentai.*$", "", title, flags=re.IGNORECASE)
        if title:
            return title
    return f"e-hentai-{gid}"


def extract_page_count(parser: ParsedHtml, raw_html: str) -> int | None:
    text = clean_text(" ".join(parser.text_chunks))
    candidates: list[int] = []
    for pattern in (
        r"Length:\s*(\d{1,5})\s*pages?",
        r"Pages?:\s*(\d{1,5})",
        r"(\d{1,5})\s*pages?\b",
    ):
        for match in re.finditer(pattern, text, re.IGNORECASE):
            value = int(match.group(1))
            if 0 < value <= 10000:
                candidates.append(value)
    for pattern in (
        r"length[\"']?\s*[:=]\s*[\"']?(\d{1,5})",
        r"page_count[\"']?\s*[:=]\s*[\"']?(\d{1,5})",
    ):
        for match in re.finditer(pattern, raw_html, re.IGNORECASE):
            value = int(match.group(1))
            if 0 < value <= 10000:
                candidates.append(value)
    return max(candidates) if candidates else None


def extract_tags(parser: ParsedHtml) -> dict[str, list[str]]:
    tags: dict[str, list[str]] = {}
    seen: set[str] = set()
    for anchor in parser.anchors:
        parsed = urllib.parse.urlparse(anchor.get("href", ""))
        raw_tag = ""
        if "/tag/" in parsed.path:
            raw_tag = urllib.parse.unquote_plus(parsed.path.split("/tag/", 1)[1]).strip("/")
        elif "f_search" in parsed.query:
            raw_tag = urllib.parse.parse_qs(parsed.query).get("f_search", [""])[0]
        if not raw_tag:
            continue

        raw_tag = clean_text(raw_tag.replace("_", " "))
        match = TAG_NAMESPACE_RE.match(raw_tag)
        if match:
            namespace = match.group(1).lower()
            value = clean_text(match.group(2).replace("_", " "))
        else:
            namespace = "tag"
            value = clean_text(anchor.get("text") or raw_tag)
        if not value or len(value) > 100:
            continue
        key = f"{namespace}:{value}".lower()
        if key in seen:
            continue
        seen.add(key)
        tags.setdefault(namespace, []).append(value)
    return tags


def extract_gallery_page_map(parser: ParsedHtml, page_url: str) -> dict[int, str]:
    pages: dict[int, str] = {}
    for anchor in parser.anchors:
        href = strip_fragment(absolute_url(anchor.get("href", ""), page_url))
        match = PAGE_RE.search(href)
        if not match:
            continue
        index = int(match.group(3))
        pages.setdefault(index, href)
    return pages


def merge_meta(base: GalleryMeta, next_meta: GalleryMeta) -> GalleryMeta:
    page_map = {index: url for index, url in enumerate(base.image_pages, 1)}
    for page_url in next_meta.image_pages:
        match = PAGE_RE.search(page_url)
        if match:
            page_map[int(match.group(3))] = page_url
        else:
            page_map.setdefault(len(page_map) + 1, page_url)
    tags = {namespace: list(values) for namespace, values in base.tags.items()}
    for namespace, values in next_meta.tags.items():
        bucket = tags.setdefault(namespace, [])
        for value in values:
            if value not in bucket:
                bucket.append(value)
    return GalleryMeta(
        source_id=SOURCE_ID,
        title=base.title or next_meta.title,
        url=base.url,
        gid=base.gid,
        token=base.token,
        length=base.length or next_meta.length,
        tags=tags,
        image_pages=[page_map[index] for index in sorted(page_map)],
    )


def gallery_index_url(gallery_url: str, index_page: int) -> str:
    if index_page <= 0:
        return gallery_url
    return f"{gallery_url}?p={index_page}"


def collect_gallery_meta(client: HttpClient, gallery_url: str, parsed: argparse.Namespace) -> GalleryMeta:
    html = client.fetch_text(gallery_url)
    meta = parse_gallery_meta(html, gallery_url)
    target_index_pages = math.ceil(meta.length / GALLERY_PAGE_SIZE) if meta.length else None
    max_index_pages = max(parsed.max_gallery_index_pages or 0, 0)

    page_number = 1
    while True:
        if meta.length and len(meta.image_pages) >= meta.length:
            break
        if target_index_pages is not None and page_number >= target_index_pages:
            break
        if max_index_pages and page_number >= max_index_pages:
            break
        next_url = gallery_index_url(gallery_url, page_number)
        client.polite_wait()
        next_html = client.fetch_text(next_url, referer=gallery_url)
        next_meta = parse_gallery_meta(next_html, gallery_url)
        before = len(meta.image_pages)
        meta = merge_meta(meta, next_meta)
        if len(meta.image_pages) == before:
            break
        page_number += 1
    return meta


def parse_page_images(text: str, page_url: str) -> list[str]:
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
    label = f"{image.get('id', '')} {image.get('class', '')}".lower()
    if image.get("id", "").lower() == "img":
        return True
    lowered = url.lower()
    blocked_tokens = ["avatar", "blank", "cover", "favicon", "logo", "sprite", "thumb"]
    if any(token in lowered for token in blocked_tokens):
        return False
    if label and any(token in label for token in ["avatar", "logo", "preview", "thumb"]):
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
            target = resolve_single_image_target(client, page_url, page_index, meta.url)
            targets.append(target)
            client.polite_wait()
        return targets

    return sorted(resolve_image_targets_concurrently(meta, parsed, entries), key=lambda target: target.index)


def resolve_image_targets_concurrently(meta: GalleryMeta, parsed: argparse.Namespace, entries: list[tuple[int, str]]) -> list[ImageTarget]:
    targets: list[ImageTarget] = []

    def worker(entry: tuple[int, str]) -> ImageTarget:
        page_index, page_url = entry
        worker_client = HttpClient(parsed, source_label="E-Hentai")
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
    images = parse_page_images(html, page_url)
    if not images:
        raise RuntimeError(f"No image URL found on E-Hentai page {page_url}")
    return ImageTarget(index, page_url, images[0], page_url)


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


_download_clients = threading.local()


def download_one_target(folder: Path, target: ImageTarget, parsed: argparse.Namespace) -> bool:
    client = getattr(_download_clients, "client", None)
    if client is None:
        client = HttpClient(parsed, source_label="E-Hentai")
        _download_clients.client = client
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


def download_targets(folder: Path, meta: GalleryMeta, targets: list[ImageTarget], parsed: argparse.Namespace):
    reporter = DownloadProgressReporter(
        folder,
        source_id=SOURCE_ID,
        gallery_url=meta.url,
        title=meta.title,
        prefix=PROGRESS_PREFIX,
    )
    return run_bounded_downloads(
        targets,
        concurrency=download_concurrency(parsed),
        worker=lambda target: download_one_target(folder, target, parsed),
        on_failure=lambda target, error: append_failed_page(folder, SOURCE_ID, target, str(error)),
        on_progress=reporter.report,
        forbidden_stop_after=parsed.forbidden_stop_after,
        max_failures=parsed.max_failures,
    )


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
    gallery_url = ensure_ehentai_gallery_url(parsed.gallery_url, base_url)
    client = HttpClient(parsed, source_label="E-Hentai")
    return collect_gallery_meta(client, gallery_url, parsed)


def run_search(parsed: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(parsed.base_url)
    query = build_query(json.loads(parsed.tags_json), parsed.name, parsed.query)
    if not query:
        raise RuntimeError("Search requires tags, name, or query")

    client = HttpClient(parsed, source_label="E-Hentai")
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    blocked_errors: list[HttpStatusError] = []
    for page in range(max(parsed.max_search_pages, 1)):
        page_url = search_page_url(base_url, query, page)
        try:
            html = client.fetch_text(page_url)
        except HttpStatusError as error:
            if error.status in BLOCKED_STATUSES:
                blocked_errors.append(error)
                client.polite_wait()
                continue
            raise
        page_results = parse_search_results(html, page_url)
        client.polite_wait()
        for item in page_results:
            if item["url"] in seen:
                continue
            seen.add(item["url"])
            results.append(item)
            if len(results) >= parsed.limit:
                break
        if len(results) >= parsed.limit or not page_results:
            break

    if not results and blocked_errors:
        attempted_urls = ", ".join(error.url for error in blocked_errors[:3])
        raise RuntimeError(
            f"E-Hentai search was blocked for all attempted public search URLs. "
            f"Query: {query}. Attempted: {attempted_urls}. "
            "Provide an authorized EHENTAI_COOKIE_FILE or EHENTAI_HEADERS_FILE for normal access; "
            "the adapter will not bypass login, age gates, captchas, bans, or rate limits."
        )

    return {"source_id": SOURCE_ID, "query": query, "results": results[: parsed.limit]}


def run_gallery(parsed: argparse.Namespace) -> dict[str, Any]:
    meta = fetch_gallery_meta(parsed)
    return {
        "source_id": SOURCE_ID,
        "title": meta.title,
        "url": meta.url,
        "gid": meta.gid,
        "token": meta.token,
        "tags": flatten_tags(meta.tags),
        "page_count": meta.length or len(meta.image_pages) or None,
    }


def run_list_pages(parsed: argparse.Namespace) -> dict[str, Any]:
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


def run_download_gallery(parsed: argparse.Namespace) -> dict[str, Any]:
    base_url = normalize_base_url(parsed.base_url)
    gallery_url = ensure_ehentai_gallery_url(parsed.gallery_url, base_url)
    client = HttpClient(parsed, source_label="E-Hentai")
    meta = collect_gallery_meta(client, gallery_url, parsed)
    folder = gallery_folder(parsed.output, meta)
    targets = resolve_image_targets(client, meta, parsed)

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


def run_download_page(parsed: argparse.Namespace) -> dict[str, Any]:
    if not parsed.gallery_url:
        raise RuntimeError("--gallery-url is required")
    if not parsed.page_url:
        raise RuntimeError("--page-url is required")
    index = parsed.page_index or parsed.start_page or 1
    base_url = normalize_base_url(parsed.base_url)
    gallery_url = ensure_ehentai_gallery_url(parsed.gallery_url, base_url)
    client = HttpClient(parsed, source_label="E-Hentai")
    target = resolve_single_image_target(client, absolute_url(parsed.page_url, gallery_url), index, gallery_url)
    folder = parsed.page_output.expanduser() if parsed.page_output else PAGE_ARTIFACT_ROOT / gallery_parts(gallery_url)[0]
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
    <table class="itg">
      <tr><td><a href="/g/12345/abcdef1234/" title="Image: Sample EH Book"><img src="https://ehgt.org/g/t.png"><img src="https://ehgt.example.test/thumbs/12345.jpg"></a></td>
      <td><a class="glink" href="https://e-hentai.org/g/12345/abcdef1234/">Sample EH Book</a></td></tr>
    </table>
    """
    gallery_html = """
    <html><head><title>Sample EH Book - E-Hentai Galleries</title></head><body>
      <h1 id="gn">Sample EH Book</h1>
      <div id="gdd"><tr><td class="gdt1">Length:</td><td class="gdt2">2 pages</td></tr></div>
      <div id="taglist">
        <a href="/tag/female:big+breasts">big breasts</a>
        <a href="/tag/language:chinese">chinese</a>
      </div>
      <div class="gdtm"><a href="/s/aaa111/12345-1"><img src="/t/1.jpg"></a></div>
      <div class="gdtm"><a href="/s/bbb222/12345-2"><img src="/t/2.jpg"></a></div>
    </body></html>
    """
    page_html = """
    <html><body><img id="img" src="https://ehgt.example.test/full/00001.jpg"></body></html>
    """
    search_results = parse_search_results(search_html, DEFAULT_BASE_URL)
    gallery = parse_gallery_meta(gallery_html, f"{DEFAULT_BASE_URL}g/12345/abcdef1234/")
    images = parse_page_images(page_html, f"{DEFAULT_BASE_URL}s/aaa111/12345-1")
    pages = page_descriptors(gallery)
    selected = selected_targets(
        [
            ImageTarget(1, "/s/aaa111/12345-1", "https://ehgt.example.test/00001.jpg", "/s/aaa111/12345-1"),
            ImageTarget(2, "/s/bbb222/12345-2", "https://ehgt.example.test/00002.jpg", "/s/bbb222/12345-2"),
        ],
        argparse.Namespace(start_page=2, end_page=None, max_pages_per_run=0),
    )
    assert len(search_results) == 1, search_results
    assert search_results[0]["title"] == "Sample EH Book", search_results
    assert search_results[0].get("thumbnail_url") == "https://ehgt.example.test/thumbs/12345.jpg", search_results
    assert build_query(["female:big breasts", "language:chinese"], None, None) == "female:big breasts language:chinese"
    assert gallery.title == "Sample EH Book", gallery.title
    assert gallery.length == 2, gallery.length
    assert "female:big breasts" in flatten_tags(gallery.tags), gallery.tags
    assert len(gallery.image_pages) == 2, gallery.image_pages
    assert len(images) == 1, images
    assert pages[0]["index"] == 1 and pages[1]["index"] == 2
    assert selected[0].index == 2
    return {"ok": True, "search_results": len(search_results), "page_images": len(images), "pages": len(pages)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Conservative JSON bridge for public E-Hentai pages.")
    parser.add_argument(
        "command",
        choices=("search", "gallery", "list-pages", "download-gallery", "download-page", "retry-plan", "self-test"),
    )
    parser.add_argument("--base-url", default=os.environ.get("EHENTAI_BASE_URL", DEFAULT_BASE_URL))
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
    parser.add_argument("--output", type=Path, default=Path(os.environ.get("EHENTAI_OUTPUT", DEFAULT_OUTPUT)))
    parser.add_argument("--page-output", type=Path, default=Path(os.environ["EHENTAI_PAGE_OUTPUT"]) if os.environ.get("EHENTAI_PAGE_OUTPUT") else None)
    parser.add_argument("--cookies-file", default=os.environ.get("EHENTAI_COOKIE_FILE"))
    parser.add_argument("--headers-file", default=os.environ.get("EHENTAI_HEADERS_FILE"))
    parser.add_argument("--delay", type=float, default=float(os.environ.get("EHENTAI_DELAY", "2.0")))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("EHENTAI_TIMEOUT", "45")))
    parser.add_argument("--retries", type=int, default=int(os.environ.get("EHENTAI_RETRIES", "2")))
    parser.add_argument("--retry-backoff", type=float, default=float(os.environ.get("EHENTAI_RETRY_BACKOFF", "1.5")))
    parser.add_argument("--max-search-pages", type=int, default=int(os.environ.get("EHENTAI_MAX_SEARCH_PAGES", "2")))
    parser.add_argument("--max-gallery-index-pages", type=int, default=int(os.environ.get("EHENTAI_MAX_GALLERY_INDEX_PAGES", "0")))
    parser.add_argument("--max-pages-per-run", type=int, default=int(os.environ.get("EHENTAI_MAX_PAGES_PER_RUN", "0")))
    parser.add_argument("--max-failures", type=int, default=int(os.environ.get("EHENTAI_MAX_FAILURES", "10")))
    parser.add_argument("--download-concurrency", type=int, default=int(os.environ.get("EHENTAI_DOWNLOAD_CONCURRENCY", "3")))
    parser.add_argument("--min-image-bytes", type=int, default=int(os.environ.get("EHENTAI_MIN_IMAGE_BYTES", str(DEFAULT_MIN_IMAGE_BYTES))))
    parser.add_argument("--forbidden-stop-after", type=int, default=int(os.environ.get("EHENTAI_FORBIDDEN_STOP_AFTER", "2")))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument(
        "--user-agent",
        default=os.environ.get(
            "EHENTAI_USER_AGENT",
            "MangaPlatformCrawler/0.1 (+local user-controlled source adapter)",
        ),
    )
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
