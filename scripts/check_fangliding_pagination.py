from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import fangliding_bridge as bridge


class FakeClientContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, traceback):
        return False


async def main() -> None:
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
            SimpleNamespace(title=f"page-{html}", url=f"{base_url}/gallery/{html}", gid=html)
        ],
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
    print(json.dumps({"ok": True, "requested_pages": requested_pages}))


if __name__ == "__main__":
    asyncio.run(main())
