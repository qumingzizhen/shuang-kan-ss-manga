from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from types import SimpleNamespace

import fangliding_bridge as bridge


class FakeImage:
    def __init__(self, page: str):
        attribute = "src" if page == "2" else "data-src"
        self.attributes = {attribute: f"//images.example.test/{page}.webp"}


class FakeGalleryLink:
    def __init__(self, page: str):
        self.page = page
        self.attributes = {"href": f"/g/{page}/token/"}

    def css(self, selector: str) -> list[FakeImage]:
        return [FakeImage(self.page)] if selector == "img" else []


class FakeSearchTree:
    def __init__(self, page: str):
        self.page = page

    def css(self, selector: str) -> list[FakeGalleryLink]:
        return [FakeGalleryLink(self.page)] if selector == "a[href]" else []


class FakeClientContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, traceback):
        return False


async def main() -> None:
    ca_bundle = bridge.resolve_curl_ca_bundle(None)
    assert ca_bundle, ca_bundle
    assert str(ca_bundle).isascii(), ca_bundle
    assert Path(ca_bundle).name == bridge.DEFAULT_CURL_CA_FILENAME, ca_bundle

    requested_pages: list[int] = []

    def search_url(base_url: str, query: str, page: int) -> str:
        requested_pages.append(page)
        return str(page)

    fake_module = SimpleNamespace(
        build_query=lambda tags, name, query: query,
        make_client=lambda args: FakeClientContext(),
        search_url=search_url,
        fetch_text=lambda client, url, delay: asyncio.sleep(0, result=url),
        parse_search_results=lambda html, base_url: [
            SimpleNamespace(title=f"page-{html}", url=f"{base_url}/g/{html}/token/", gid=html)
        ],
        LexborHTMLParser=FakeSearchTree,
        GALLERY_RE=re.compile(r"/g/(\d+)/[a-z]+/?"),
    )
    parsed = SimpleNamespace(
        tags_json=json.dumps({}),
        name=None,
        query="test",
        base_url="https://example.test",
        limit=10,
        delay=0,
        search_start_page=3,
        max_search_pages=2,
    )

    original_build_legacy_args = bridge.build_legacy_args
    bridge.build_legacy_args = lambda parsed: SimpleNamespace()
    try:
        output = await bridge.run_search(fake_module, parsed)
    finally:
        bridge.build_legacy_args = original_build_legacy_args

    assert requested_pages == [2, 3], requested_pages
    assert [item["gid"] for item in output["results"]] == ["2", "3"], output
    assert [item["thumbnail_url"] for item in output["results"]] == [
        "https://images.example.test/2.webp",
        "https://images.example.test/3.webp",
    ], output
    print(json.dumps({"ok": True, "requested_pages": requested_pages, "ca_bundle": ca_bundle}))


if __name__ == "__main__":
    asyncio.run(main())
