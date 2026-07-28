from __future__ import annotations

import asyncio
import json
import re
import tempfile
from pathlib import Path
from types import SimpleNamespace

import fangliding_bridge as bridge


class FakeClientContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, traceback):
        return False


async def collect_gallery_meta(client, gallery, delay, max_gallery_pages):
    del client, delay, max_gallery_pages
    return SimpleNamespace(
        title="reader-sample",
        url=gallery.url,
        gid=gallery.gid,
        token="token",
        tags={"language": ["chinese"]},
        length=2,
        image_pages=[
            "https://ex.fangliding.eu.org/s/one/123-1",
            "https://ex.fangliding.eu.org/s/two/123-2",
        ],
    )


async def fetch_text(client, url, delay, *, referer=None, retries=1):
    del client, delay, referer, retries
    return f'<img id="img" src="{url}.jpg">'


def fixture_jpeg() -> bytes:
    sof = b"\xff\xc0\x00\x11\x08\x00\x02\x00\x03\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    return b"\xff\xd8" + sof + b"reader-test-pixels" * 8 + b"\xff\xd9"


async def fetch_binary(client, url, delay, *, referer=None, retries=1):
    del client, url, delay, referer, retries
    return fixture_jpeg(), "image/jpeg"


def parsed_args(page_output: Path) -> SimpleNamespace:
    return SimpleNamespace(
        base_url="https://ex.fangliding.eu.org/",
        output=page_output,
        page_output=page_output,
        page_url="https://ex.fangliding.eu.org/s/two/123-2",
        page_index=2,
        gallery_url="https://ex.fangliding.eu.org/g/123/token/",
        tags_json="[]",
        name=None,
        query=None,
        folder=None,
        missing_only=False,
        start_page=None,
        end_page=None,
        limit=10,
        search_start_page=1,
        max_search_pages=1,
        cookies_file=None,
        no_auto_cookies=True,
        headers_file=None,
        no_auto_headers=True,
        delay=0,
        workers=1,
        timeout=10,
        pool_timeout=5,
        retries=2,
        max_pages_per_run=0,
        page_cooldown_every=80,
        page_cooldown_seconds=45,
        max_gallery_pages=2,
        overwrite=False,
        no_pdf=True,
        fetch_backend="httpx",
        impersonate="chrome",
        curl_ca_bundle=None,
        insecure=False,
        user_agent="reader-test",
        min_image_bytes=64,
    )


async def main() -> None:
    fake_module = SimpleNamespace(
        GALLERY_RE=re.compile(r"/g/(\d+)/[a-z]+/?"),
        GalleryResult=lambda title, url, gid: SimpleNamespace(title=title, url=url, gid=gid),
        make_client=lambda args: FakeClientContext(),
        collect_gallery_meta=collect_gallery_meta,
        fetch_text=fetch_text,
        parse_image_url=lambda html, base_url, original: f"{base_url}.jpg",
        fetch_binary=fetch_binary,
        extension_from=lambda url, content_type: ".jpg",
    )

    with tempfile.TemporaryDirectory(prefix="fangliding-reader-") as temp_dir:
        parsed = parsed_args(Path(temp_dir))
        page_list = await bridge.run_list_pages(fake_module, parsed)
        assert page_list["source_id"] == bridge.SOURCE_ID, page_list
        assert page_list["page_count"] == 2, page_list
        assert [page["index"] for page in page_list["pages"]] == [1, 2], page_list
        assert all(page["gallery_url"] == parsed.gallery_url for page in page_list["pages"]), page_list

        artifact = await bridge.run_download_page(fake_module, parsed)
        artifact_path = Path(artifact["storage_key"])
        assert artifact["source_id"] == bridge.SOURCE_ID, artifact
        assert artifact["page_url"] == parsed.page_url, artifact
        assert artifact["content_type"] == "image/jpeg", artifact
        assert artifact["byte_size"] == len(fixture_jpeg()), artifact
        assert artifact_path.name == "0002.jpg", artifact
        assert artifact_path.read_bytes() == fixture_jpeg(), artifact
        assert not artifact_path.with_suffix(".jpg.part").exists(), artifact

    print(json.dumps({"ok": True, "pages": 2, "artifact": "0002.jpg"}))


if __name__ == "__main__":
    asyncio.run(main())
