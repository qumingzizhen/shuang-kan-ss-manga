from __future__ import annotations

import re

from gallery_search_parser import parse_ehentai_compatible_search_results


GALLERY_RE = re.compile(r"/g/(\d+)/([0-9a-f]+)/?", re.IGNORECASE)


def main() -> None:
    html = """
    <div class="itg gld">
      <div class="gl1t">
        <div class="gl3t"><a href="/g/101/aaa111/" title="Image: Grid Book">
          <img src="/img/loading.gif" data-src="https://ehgt.example.test/101.webp">
        </a></div>
        <div class="gl4t glname glink"><a href="/g/101/aaa111/">Grid Book</a></div>
        <div class="cs cta">Manga</div>
        <div>2026-07-28 03:45</div><div>68 pages</div>
        <div class="ir" title="Rating: 4.5"></div>
      </div>
      <div class="gl1t">
        <div class="gl3t"><a href="/g/102/bbb222/" title="Image: Second Book">
          <img data-original="https://ehgt.example.test/102.jpg">
        </a></div>
        <div class="gl4t glname glink"><a href="/g/102/bbb222/">Second Book</a></div>
        <div class="cs cta">Doujinshi</div>
        <div>2026-07-28 03:44</div><div>34 pages</div>
      </div>
    </div>
    """
    results = parse_ehentai_compatible_search_results(
        html,
        "https://example.test/?f_search=test",
        source_id="fangliding",
        gallery_re=GALLERY_RE,
    )

    assert len(results) == 2, results
    first, second = results
    assert first["title"] == "Grid Book", first
    assert first["thumbnail_url"] == "https://ehgt.example.test/101.webp", first
    assert first["category"] == "Manga", first
    assert first["uploaded_at"] == "2026-07-28 03:45", first
    assert first["page_count"] == 68, first
    assert first["rating"] == 4.5, first
    assert second["thumbnail_url"] == "https://ehgt.example.test/102.jpg", second
    assert second["category"] == "Doujinshi", second
    assert second["page_count"] == 34, second
    assert first["thumbnail_url"] != second["thumbnail_url"]
    print({"ok": True, "results": len(results), "grid_layout": True})


if __name__ == "__main__":
    main()
