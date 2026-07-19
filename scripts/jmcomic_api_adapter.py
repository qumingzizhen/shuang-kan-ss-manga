from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from source_bridge_core import (
    DownloadStats,
    clean_text,
    content_type_from_suffix,
    now_iso,
    sanitize_filename,
    write_json_atomic,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ID = "18comic"
PAGE_ARTIFACT_ROOT = PROJECT_ROOT / ".data" / "page-artifacts" / SOURCE_ID
PROGRESS_PREFIX = "__COMIC_PLATFORM_PROGRESS__"
ALBUM_RE = re.compile(r"/album/(\d+)(?:[/?#]|$)")
PHOTO_RE = re.compile(r"/photo/(\d+)(?:/(\d+))?(?:[/?#]|$)")
API_PAGE_RE = re.compile(r"^jmapi://photo/(\d+)/(\d+)$", re.I)
IMAGE_SUFFIXES = {".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"}


@dataclass
class ApiPage:
    index: int
    photo_id: str
    image_index: int
    page_url: str
    image: Any


def create_client() -> Any:
    try:
        from jmcomic import JmModuleConfig, JmOption
    except ImportError as error:
        raise RuntimeError(
            "18comic API support requires jmcomic. Run: "
            "python -m pip install --target .\\.cache\\python -r .\\requirements.txt"
        ) from error

    JmModuleConfig.disable_jm_log()
    return JmOption.default().new_jm_client()


def album_id_from_url(url: str) -> str:
    match = ALBUM_RE.search(url or "") or PHOTO_RE.search(url or "")
    if not match:
        raise RuntimeError(f"Missing 18comic album id in URL: {url}")
    return match.group(1)


def public_gallery_url(base_url: str, album_id: str) -> str:
    base_url = base_url if base_url.endswith("/") else f"{base_url}/"
    return urllib.parse.urljoin(base_url, f"album/{album_id}")


def api_page_url(photo_id: str, image_index: int) -> str:
    return f"jmapi://photo/{photo_id}/{image_index}"


def parse_page_url(page_url: str) -> tuple[str, int]:
    match = API_PAGE_RE.match(page_url or "")
    if match:
        return match.group(1), int(match.group(2))
    match = PHOTO_RE.search(page_url or "")
    if match and match.group(2):
        return match.group(1), int(match.group(2))
    raise RuntimeError(f"Unsupported 18comic API page URL: {page_url}")


def search(parsed: argparse.Namespace, query: str, base_url: str) -> dict[str, Any]:
    query = clean_text(query)
    if not query:
        raise RuntimeError("Search requires tags, name, or query")

    client = create_client()
    from jmcomic import JmcomicText
    results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page_number in range(1, max(int(parsed.max_search_pages or 1), 1) + 1):
        page = client.search_site(query, page=page_number)
        for album_id, info in page.content:
            album_id = str(album_id)
            if album_id in seen:
                continue
            seen.add(album_id)
            title = clean_text(str(info.get("name") or f"18comic-{album_id}"))
            tags = [clean_text(str(item)) for item in info.get("tags") or []]
            item = {
                "source_id": SOURCE_ID,
                "title": title,
                "url": public_gallery_url(base_url, album_id),
                "gid": album_id,
                "tags": [tag for tag in tags if tag],
            }
            try:
                item["thumbnail_url"] = JmcomicText.get_album_cover_url(album_id)
            except Exception:
                pass
            results.append(item)
            if len(results) >= parsed.limit:
                break
        if len(results) >= parsed.limit or not page.content:
            break

    return {
        "source_id": SOURCE_ID,
        "query": query,
        "transport": "jmcomic_api",
        "results": results[: parsed.limit],
    }


def load_album(client: Any, gallery_url: str, base_url: str) -> tuple[Any, dict[str, Any]]:
    album_id = album_id_from_url(gallery_url)
    album = client.get_album_detail(album_id)
    url = public_gallery_url(base_url, album_id)
    meta = {
        "source_id": SOURCE_ID,
        "title": clean_text(str(album.name)) or f"18comic-{album_id}",
        "url": url,
        "gid": album_id,
        "token": "",
        "length": int(album.page_count or 0) or None,
        "tags": {"tag": [clean_text(str(tag)) for tag in album.tags if clean_text(str(tag))]},
        "image_pages": [],
    }
    return album, meta


def load_pages(client: Any, album: Any) -> list[ApiPage]:
    pages: list[ApiPage] = []
    for episode in album.episode_list:
        photo_id = str(episode[0])
        photo = client.get_photo_detail(photo_id, fetch_album=False, fetch_scramble_id=True)
        for image_offset in range(len(photo)):
            image = photo[image_offset]
            pages.append(
                ApiPage(
                    index=len(pages) + 1,
                    photo_id=photo_id,
                    image_index=image_offset + 1,
                    page_url=api_page_url(photo_id, image_offset + 1),
                    image=image,
                )
            )
    return pages


def flattened_tags(meta: dict[str, Any]) -> list[str]:
    return list(meta.get("tags", {}).get("tag", []))


def gallery(parsed: argparse.Namespace, gallery_url: str, base_url: str) -> dict[str, Any]:
    client = create_client()
    album, meta = load_album(client, gallery_url, base_url)
    page_count = meta["length"]
    if not page_count:
        page_count = len(load_pages(client, album))
    return {
        "source_id": SOURCE_ID,
        "title": meta["title"],
        "url": meta["url"],
        "gid": meta["gid"],
        "tags": flattened_tags(meta),
        "page_count": page_count,
        "transport": "jmcomic_api",
    }


def list_pages(parsed: argparse.Namespace, gallery_url: str, base_url: str) -> dict[str, Any]:
    client = create_client()
    album, meta = load_album(client, gallery_url, base_url)
    pages = load_pages(client, album)
    return {
        "source_id": SOURCE_ID,
        "title": meta["title"],
        "gallery_url": meta["url"],
        "tags": flattened_tags(meta),
        "page_count": len(pages),
        "transport": "jmcomic_api",
        "pages": [
            {
                "source_id": SOURCE_ID,
                "gallery_url": meta["url"],
                "page_url": page.page_url,
                "index": page.index,
            }
            for page in pages
        ],
    }


def find_existing_image(folder: Path, index: int) -> Path | None:
    if not folder.exists():
        return None
    stem = f"{index:04d}"
    for child in folder.iterdir():
        if child.is_file() and child.stem == stem and child.suffix.lower() in IMAGE_SUFFIXES:
            return child
    return None


def safe_suffix(image: Any) -> str:
    suffix = str(getattr(image, "img_file_suffix", "") or "").lower()
    return suffix if suffix in IMAGE_SUFFIXES else ".jpg"


def save_page_image(
    client: Any,
    folder: Path,
    page: ApiPage,
    *,
    overwrite: bool,
    min_image_bytes: int,
) -> tuple[Path, bool]:
    existing = find_existing_image(folder, page.index)
    if existing and not overwrite and existing.stat().st_size >= min_image_bytes:
        return existing, True

    file_path = folder / f"{page.index:04d}{safe_suffix(page.image)}"
    client.download_by_image_detail(page.image, str(file_path), decode_image=True)
    byte_size = file_path.stat().st_size
    if byte_size < min_image_bytes:
        file_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"Image response is too small for page {page.index}: {byte_size} bytes from {page.image.download_url}"
        )
    return file_path, False


def select_pages(pages: list[ApiPage], parsed: argparse.Namespace) -> list[ApiPage]:
    start = max(int(parsed.start_page or 1), 1)
    end = int(parsed.end_page) if parsed.end_page and int(parsed.end_page) >= start else None
    selected = [page for page in pages if page.index >= start and (end is None or page.index <= end)]
    if parsed.max_pages_per_run and parsed.max_pages_per_run > 0:
        selected = selected[: parsed.max_pages_per_run]
    return selected


def metadata_payload(meta: dict[str, Any], base_url: str, pages: list[ApiPage]) -> dict[str, Any]:
    return {
        **meta,
        "length": len(pages),
        "image_pages": [page.page_url for page in pages],
        "site": base_url,
        "transport": "jmcomic_api",
        "updated_at": now_iso(),
    }


def write_failure(folder: Path, page: ApiPage, error: Exception) -> None:
    record = {
        "timestamp": now_iso(),
        "source_id": SOURCE_ID,
        "index": page.index,
        "page_url": page.page_url,
        "image_url": str(page.image.download_url),
        "error": str(error),
    }
    with (folder / "failed_pages.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def update_state(folder: Path, meta: dict[str, Any], stats: DownloadStats, total: int, last_index: int | None) -> None:
    payload = {
        "source_id": SOURCE_ID,
        "gallery_url": meta["url"],
        "title": meta["title"],
        "total": total,
        "done": stats.done,
        "skipped": stats.skipped,
        "failed": stats.failed,
        "stopped": stats.stopped,
        "last_index": last_index,
        "transport": "jmcomic_api",
        "updated_at": now_iso(),
    }
    write_json_atomic(folder / "download_state.json", payload)
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}", file=sys.stderr, flush=True)


def download_gallery(parsed: argparse.Namespace, gallery_url: str, base_url: str) -> dict[str, Any]:
    client = create_client()
    album, meta = load_album(client, gallery_url, base_url)
    all_pages = load_pages(client, album)
    pages = select_pages(all_pages, parsed)
    folder = parsed.output.expanduser() / sanitize_filename(f"{meta['title']} [{meta['gid']}]")

    if parsed.dry_run:
        return {
            "source_id": SOURCE_ID,
            "title": meta["title"],
            "url": meta["url"],
            "output_folder": str(folder),
            "page_count": len(pages),
            "done": 0,
            "skipped": 0,
            "failed": 0,
            "stopped": False,
            "dry_run": True,
            "transport": "jmcomic_api",
        }

    folder.mkdir(parents=True, exist_ok=True)
    write_json_atomic(folder / "metadata.json", metadata_payload(meta, base_url, all_pages))
    stats = DownloadStats()
    min_image_bytes = max(int(parsed.min_image_bytes or 0), 0)
    workers = max(1, min(int(parsed.download_concurrency or 1), 8))

    def worker(page: ApiPage) -> tuple[Path, bool]:
        return save_page_image(
            client,
            folder,
            page,
            overwrite=bool(parsed.overwrite),
            min_image_bytes=min_image_bytes,
        )

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(worker, page): page for page in pages}
        for future in as_completed(futures):
            page = futures[future]
            if future.cancelled():
                continue
            try:
                _file_path, skipped = future.result()
                if skipped:
                    stats.skipped += 1
                else:
                    stats.done += 1
            except Exception as error:  # noqa: BLE001 - report per-page failures.
                stats.failed += 1
                write_failure(folder, page, error)
                if parsed.max_failures and stats.failed >= parsed.max_failures:
                    stats.stopped = True
                    for pending in futures:
                        if not pending.done():
                            pending.cancel()
            finally:
                update_state(folder, meta, stats, len(pages), page.index)

    return {
        "source_id": SOURCE_ID,
        "title": meta["title"],
        "url": meta["url"],
        "output_folder": str(folder),
        "page_count": len(pages),
        "done": stats.done,
        "skipped": stats.skipped,
        "failed": stats.failed,
        "stopped": stats.stopped,
        "dry_run": False,
        "transport": "jmcomic_api",
    }


def download_page(parsed: argparse.Namespace, gallery_url: str, page_url: str) -> dict[str, Any]:
    photo_id, image_index = parse_page_url(page_url)
    client = create_client()
    photo = client.get_photo_detail(photo_id, fetch_album=False, fetch_scramble_id=True)
    if image_index < 1 or image_index > len(photo):
        raise RuntimeError(f"18comic page index is out of range: {image_index} / {len(photo)}")
    image = photo[image_index - 1]
    global_index = int(parsed.page_index or parsed.start_page or image_index)
    page = ApiPage(global_index, photo_id, image_index, api_page_url(photo_id, image_index), image)
    album_id = album_id_from_url(gallery_url)
    folder = parsed.page_output.expanduser() if parsed.page_output else PAGE_ARTIFACT_ROOT / album_id
    folder.mkdir(parents=True, exist_ok=True)
    file_path, _skipped = save_page_image(
        client,
        folder,
        page,
        overwrite=bool(parsed.overwrite),
        min_image_bytes=max(int(parsed.min_image_bytes or 0), 0),
    )
    return {
        "source_id": SOURCE_ID,
        "page_url": page.page_url,
        "storage_key": str(file_path),
        "content_type": content_type_from_suffix(file_path.suffix)
        or {
            ".avif": "image/avif",
            ".gif": "image/gif",
            ".jpeg": "image/jpeg",
            ".jpg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(file_path.suffix.lower()),
        "byte_size": file_path.stat().st_size,
        "transport": "jmcomic_api",
    }
