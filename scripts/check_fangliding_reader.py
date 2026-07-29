from __future__ import annotations

import json

import fangliding_bridge as bridge


GALLERY_URL = "https://ex.fangliding.eu.org/g/123/abcdef/"


def main() -> None:
    gallery_html = """
    <html><head><title>Reader Fixture - Fangliding</title></head><body>
      <h1 id="gn">Reader Fixture</h1>
      <div>Length: 2 pages</div>
      <a href="/tag/language:chinese">Chinese</a>
      <a href="/s/one/123-1">1</a>
      <a href="/s/two/123-2">2</a>
    </body></html>
    """
    page_html = '<html><body><img id="img" src="https://ehgt.org/fixture/00001.jpg"></body></html>'
    meta = bridge.parse_gallery_meta(gallery_html, GALLERY_URL)
    pages = bridge.page_descriptors(meta)
    images = bridge.parse_page_images(page_html, pages[0]["page_url"])

    assert meta.source_id == "fangliding", meta
    assert meta.title == "Reader Fixture", meta.title
    assert meta.length == 2, meta.length
    assert [page["index"] for page in pages] == [1, 2], pages
    assert all(page["source_id"] == "fangliding" for page in pages), pages
    assert images == ["https://ehgt.org/fixture/00001.jpg"], images
    print(json.dumps({"ok": True, "pages": len(pages), "page_images": len(images)}))


if __name__ == "__main__":
    main()