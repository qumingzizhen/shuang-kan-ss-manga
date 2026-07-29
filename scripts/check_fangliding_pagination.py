from __future__ import annotations

import json
import urllib.parse
from types import SimpleNamespace

import fangliding_bridge as bridge
from source_bridge_core import bridge_error_payload


class BlockedClient:
    def __init__(self, parsed, *, source_label: str) -> None:
        del parsed
        assert source_label == "Fangliding"

    def fetch_text(self, url: str, referer: str | None = None) -> str:
        del referer
        raise bridge.HttpStatusError(
            403,
            url,
            "Fangliding returned a browser verification page",
            kind="access_challenge",
        )

    def polite_wait(self) -> None:
        return None


class FakeClient:
    requested_pages: list[int] = []

    def __init__(self, parsed, *, source_label: str) -> None:
        del parsed
        assert source_label == "Fangliding"

    def fetch_text(self, url: str, referer: str | None = None) -> str:
        del referer
        page = int(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["page"][0])
        self.requested_pages.append(page)
        return str(page)

    def polite_wait(self) -> None:
        return None


def main() -> None:
    original_client = bridge.HttpClient
    original_parser = bridge.parse_search_results
    bridge.HttpClient = FakeClient
    bridge.parse_search_results = lambda text, page_url: [
        {
            "source_id": bridge.SOURCE_ID,
            "gid": text,
            "title": f"page-{text}",
            "url": f"https://ex.fangliding.eu.org/g/{text}/abcdef/",
            "thumbnail_url": f"https://ehgt.org/{text}.webp",
            "tags": [],
        }
    ]
    parsed = SimpleNamespace(
        base_url=bridge.DEFAULT_BASE_URL,
        tags_json="[]",
        name=None,
        query="test",
        search_start_page=3,
        max_search_pages=2,
        limit=10,
    )
    try:
        output = bridge.run_search(parsed)
    finally:
        bridge.HttpClient = original_client
        bridge.parse_search_results = original_parser

    assert FakeClient.requested_pages == [2, 3], FakeClient.requested_pages
    assert output["source_id"] == "fangliding", output
    assert [item["gid"] for item in output["results"]] == ["2", "3"], output

    bridge.HttpClient = BlockedClient
    try:
        bridge.run_search(parsed)
    except bridge.HttpStatusError as error:
        blocked_payload = bridge_error_payload(error, bridge.SOURCE_ID)
    else:
        raise AssertionError("blocked search must raise HttpStatusError")
    finally:
        bridge.HttpClient = original_client

    assert blocked_payload["code"] == "access_blocked", blocked_payload
    assert blocked_payload["retryable"] is False, blocked_payload
    assert "authorized session file" in blocked_payload["message"], blocked_payload
    print(
        json.dumps(
            {
                "ok": True,
                "requested_pages": FakeClient.requested_pages,
                "blocked_error": blocked_payload["code"],
            }
        )
    )


if __name__ == "__main__":
    main()