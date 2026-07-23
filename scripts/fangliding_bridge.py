from __future__ import annotations

import argparse
import asyncio
import contextlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LEGACY_SCRIPT = PROJECT_ROOT.parent / "ex_fangliding_downloader.py"


def load_downloader() -> ModuleType:
    script_path = Path(os.environ.get("FANGLIDING_SCRIPT_PATH", LEGACY_SCRIPT)).resolve()
    if not script_path.exists():
        raise RuntimeError(f"Fangliding downloader script not found: {script_path}")

    spec = importlib.util.spec_from_file_location("fangliding_legacy_downloader", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load Fangliding downloader script: {script_path}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def build_legacy_args(
    parsed: argparse.Namespace,
    *,
    dry_run: bool = True,
    no_pdf: bool = True,
) -> SimpleNamespace:
    return SimpleNamespace(
        base_url=parsed.base_url,
        tag=[],
        name=None,
        query=None,
        output=str(parsed.output),
        cookies_file=parsed.cookies_file,
        no_auto_cookies=parsed.no_auto_cookies,
        headers_file=parsed.headers_file,
        no_auto_headers=parsed.no_auto_headers,
        gallery_url=None,
        retry_folder=None,
        retry_missing_only=False,
        start_page=None,
        end_page=None,
        limit=parsed.limit,
        workers=parsed.workers,
        delay=parsed.delay,
        timeout=parsed.timeout,
        pool_timeout=parsed.pool_timeout,
        retries=parsed.retries,
        refresh_attempts=2,
        failure_log="failed_pages.jsonl",
        max_pages_per_run=parsed.max_pages_per_run,
        max_failures=25,
        max_consecutive_failures=6,
        forbidden_stop_after=3,
        page_cooldown_every=parsed.page_cooldown_every,
        page_cooldown_seconds=parsed.page_cooldown_seconds,
        gallery_cooldown_seconds=180.0,
        continue_on_block=False,
        max_gallery_pages=parsed.max_gallery_pages,
        yes=True,
        dry_run=dry_run,
        overwrite=parsed.overwrite,
        original=False,
        no_pdf=no_pdf,
        pdf_dir=None,
        pdf_quality=90,
        pdf_even_if_incomplete=False,
        skip_existing_pdf=True,
        http2=False,
        fetch_backend=parsed.fetch_backend,
        impersonate=parsed.impersonate,
        curl_ca_bundle=parsed.curl_ca_bundle,
        insecure=parsed.insecure,
        user_agent=parsed.user_agent,
    )


def flatten_tags(tags: dict[str, list[str]]) -> list[str]:
    flattened: list[str] = []
    for namespace, values in tags.items():
        prefix = namespace.strip()
        for value in values:
            value = str(value).strip()
            if not value:
                continue
            flattened.append(f"{prefix}:{value}" if prefix and prefix != "tag" else value)
    return flattened


def gallery_result_from_url(module: ModuleType, gallery_url: str):
    match = module.GALLERY_RE.search(gallery_url)
    if not match:
        raise RuntimeError(f"Unrecognized gallery URL: {gallery_url}")
    return module.GalleryResult(
        title=f"gallery-{match.group(1)}",
        url=gallery_url,
        gid=match.group(1),
    )


async def run_search(module: ModuleType, parsed: argparse.Namespace) -> dict:
    args = build_legacy_args(parsed)
    tags = json.loads(parsed.tags_json)
    final_query = module.build_query(tags, parsed.name, parsed.query)
    if not final_query:
        raise RuntimeError("Search requires tags, name, or query")

    start_page = max(int(parsed.search_start_page or 1), 1) - 1
    page_count = max(int(parsed.max_search_pages or 1), 1)
    results = []
    seen_urls: set[str] = set()
    async with module.make_client(args) as client:
        for page in range(start_page, start_page + page_count):
            url = module.search_url(parsed.base_url, final_query, page)
            html = await module.fetch_text(client, url, parsed.delay)
            page_results = module.parse_search_results(html, parsed.base_url)
            for result in page_results:
                if result.url in seen_urls:
                    continue
                seen_urls.add(result.url)
                results.append(result)
                if len(results) >= parsed.limit:
                    break
            if len(results) >= parsed.limit or not page_results:
                break

    return {
        "query": final_query,
        "results": [
            {
                "title": item.title,
                "url": item.url,
                "gid": item.gid,
                "tags": [],
            }
            for item in results
        ],
    }


async def run_gallery(module: ModuleType, parsed: argparse.Namespace) -> dict:
    args = build_legacy_args(parsed)
    gallery = gallery_result_from_url(module, parsed.gallery_url)

    async with module.make_client(args) as client:
        meta = await module.collect_gallery_meta(
            client,
            gallery,
            parsed.delay,
            parsed.max_gallery_pages,
        )

    page_count = len(meta.image_pages) or meta.length
    return {
        "title": meta.title,
        "url": meta.url,
        "gid": meta.gid,
        "token": meta.token,
        "tags": flatten_tags(meta.tags),
        "page_count": page_count,
    }


async def run_download_gallery(module: ModuleType, parsed: argparse.Namespace) -> dict:
    args = build_legacy_args(parsed, dry_run=False, no_pdf=parsed.no_pdf)
    args.gallery_url = parsed.gallery_url
    gallery = gallery_result_from_url(module, parsed.gallery_url)

    async with module.make_client(args) as client:
        meta = await module.collect_gallery_meta(
            client,
            gallery,
            parsed.delay,
            parsed.max_gallery_pages,
        )
        folder = module.gallery_folder(args.output, meta)
        if not meta.image_pages:
            return {
                "title": meta.title,
                "url": meta.url,
                "output_folder": str(folder),
                "page_count": meta.length,
                "done": 0,
                "skipped": 0,
                "failed": 0,
                "stopped": False,
            }

        stats = await module.download_meta(client, meta, folder, args)

    return {
        "title": meta.title,
        "url": meta.url,
        "output_folder": str(folder),
        "page_count": len(meta.image_pages) or meta.length,
        "done": stats.done,
        "skipped": stats.skipped,
        "failed": stats.failed,
        "stopped": stats.stopped,
    }


async def run_retry_plan(module: ModuleType, parsed: argparse.Namespace) -> dict:
    folder = Path(parsed.folder).expanduser().resolve()
    meta_path = folder / "metadata.json"
    if not meta_path.exists():
        raise RuntimeError(f"metadata.json not found: {meta_path}")

    meta = module.load_gallery_meta(meta_path)
    args = build_legacy_args(parsed)
    args.retry_folder = str(folder)
    args.retry_missing_only = parsed.missing_only
    args.start_page = parsed.start_page
    args.end_page = parsed.end_page

    items = module.selected_page_items(meta, folder, args)
    return {
        "folder": str(folder),
        "page_indexes": [index for index, _url in items],
    }


async def async_main() -> int:
    parser = argparse.ArgumentParser(description="JSON bridge for the legacy Fangliding downloader.")
    parser.add_argument("command", choices=("search", "gallery", "download-gallery", "retry-plan"))
    parser.add_argument("--base-url", default="https://ex.fangliding.eu.org/")
    parser.add_argument("--tags-json", default="[]")
    parser.add_argument("--name")
    parser.add_argument("--query")
    parser.add_argument("--gallery-url")
    parser.add_argument("--folder")
    parser.add_argument("--missing-only", action="store_true")
    parser.add_argument("--start-page", type=int)
    parser.add_argument("--end-page", type=int)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--search-start-page", type=int, default=1)
    parser.add_argument("--max-search-pages", type=int, default=1)
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / ".data" / "downloads")
    parser.add_argument("--cookies-file")
    parser.add_argument("--no-auto-cookies", action="store_true")
    parser.add_argument("--headers-file")
    parser.add_argument("--no-auto-headers", action="store_true")
    parser.add_argument("--delay", type=float, default=2.0)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--pool-timeout", type=float, default=10.0)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--max-pages-per-run", type=int, default=0)
    parser.add_argument("--page-cooldown-every", type=int, default=80)
    parser.add_argument("--page-cooldown-seconds", type=float, default=45.0)
    parser.add_argument("--max-gallery-pages", type=int, default=200)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--no-pdf", action="store_true")
    parser.add_argument("--fetch-backend", choices=("auto", "httpx", "curl-cffi"), default="auto")
    parser.add_argument("--impersonate", default="chrome")
    parser.add_argument("--curl-ca-bundle", default=os.environ.get("FANGLIDING_CURL_CA_BUNDLE"))
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument(
        "--user-agent",
        default="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    )
    parsed = parser.parse_args()

    module = load_downloader()
    with contextlib.redirect_stdout(sys.stderr):
        if parsed.command == "search":
            payload = await run_search(module, parsed)
        elif parsed.command == "gallery":
            if not parsed.gallery_url:
                raise RuntimeError("--gallery-url is required")
            payload = await run_gallery(module, parsed)
        elif parsed.command == "download-gallery":
            if not parsed.gallery_url:
                raise RuntimeError("--gallery-url is required")
            payload = await run_download_gallery(module, parsed)
        else:
            if not parsed.folder:
                raise RuntimeError("--folder is required")
            payload = await run_retry_plan(module, parsed)

    print(json.dumps(payload, ensure_ascii=False))
    return 0


def main() -> int:
    try:
        return asyncio.run(async_main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
