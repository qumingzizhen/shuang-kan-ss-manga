from __future__ import annotations

import re
from dataclasses import dataclass
from html import unescape
from typing import Any, Pattern

from search_result_metadata import merge_search_metadata, parse_ehentai_search_block
from source_bridge_core import (
    absolute_url,
    clean_text,
    image_url_candidates_from_html,
    parse_html,
    strip_fragment,
)


STRUCTURAL_TAG_RE = re.compile(r"<\s*(/?)\s*(tr|article|li|div)\b([^>]*)>", re.IGNORECASE)
CLASS_ATTRIBUTE_RE = re.compile(r"\bclass\s*=\s*([\"'])(.*?)\1", re.IGNORECASE | re.DOTALL)


@dataclass(frozen=True)
class HtmlBlock:
    start: int
    end: int


class SearchCardIndex:
    """Indexes result-card boundaries once so metadata lookup stays linear."""

    def __init__(self, html: str) -> None:
        self.html = html
        self.blocks = self._index_blocks(html)
        self._cache: dict[str, str] = {}

    def find(self, markers: list[str]) -> str:
        cache_key = next((str(marker) for marker in reversed(markers) if marker), "")
        if cache_key in self._cache:
            return self._cache[cache_key]
        positions: set[int] = set()
        for marker in markers:
            raw_marker = unescape(str(marker or "")).strip()
            if not raw_marker:
                continue
            for candidate in {raw_marker, raw_marker.replace("&", "&amp;")}:
                start = 0
                while True:
                    position = self.html.find(candidate, start)
                    if position < 0:
                        break
                    positions.add(position)
                    start = position + max(len(candidate), 1)

        matches = [
            block
            for block in self.blocks
            if any(block.start <= position < block.end for position in positions)
        ]
        if not matches:
            self._cache[cache_key] = ""
            return ""
        block = min(matches, key=lambda item: item.end - item.start)
        value = self.html[block.start : block.end]
        self._cache[cache_key] = value
        return value

    @staticmethod
    def _index_blocks(html: str) -> list[HtmlBlock]:
        stack: list[tuple[str, int, bool]] = []
        blocks: list[HtmlBlock] = []
        for match in STRUCTURAL_TAG_RE.finditer(html):
            closing, tag, attributes = match.groups()
            normalized_tag = tag.lower()
            if not closing:
                stack.append(
                    (
                        normalized_tag,
                        match.start(),
                        normalized_tag != "div" or SearchCardIndex._is_gallery_card_div(attributes),
                    )
                )
                continue

            opening_index = next(
                (index for index in range(len(stack) - 1, -1, -1) if stack[index][0] == normalized_tag),
                None,
            )
            if opening_index is None:
                continue
            _tag, start, eligible = stack[opening_index]
            del stack[opening_index:]
            if eligible:
                blocks.append(HtmlBlock(start=start, end=match.end()))
        return blocks

    @staticmethod
    def _is_gallery_card_div(attributes: str) -> bool:
        class_match = CLASS_ATTRIBUTE_RE.search(attributes)
        if not class_match:
            return False
        classes = set(class_match.group(2).lower().split())
        return bool(classes.intersection({"gl1t", "gl1e"}))


def parse_ehentai_compatible_search_results(
    text: str,
    page_url: str,
    *,
    source_id: str,
    gallery_re: Pattern[str],
    fallback_prefix: str | None = None,
) -> list[dict[str, Any]]:
    """Parse table and thumbnail-grid layouts used by E-Hentai compatible sites."""

    parser = parse_html(text, page_url)
    cards = SearchCardIndex(text)
    by_url: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    prefix = clean_text(fallback_prefix) or source_id

    for anchor in parser.anchors:
        href = anchor.get("href", "")
        match = gallery_re.search(href)
        if not match:
            continue

        url = strip_fragment(absolute_url(href, page_url))
        if not url:
            continue
        gid = match.group(1)
        token = match.group(2) if (match.lastindex or 0) >= 2 else None
        title = clean_search_title(anchor.get("title") or anchor.get("text") or "")
        markers = [href, url, match.group(0)]
        block = cards.find(markers)
        metadata = parse_ehentai_search_block(block)
        thumbnail_url = first_search_thumbnail(block, page_url)

        item = by_url.get(url)
        if item is None:
            item = {
                "source_id": source_id,
                "title": title or f"{prefix}-{gid}",
                "url": url,
                "gid": gid,
                "tags": metadata.get("tags", []),
            }
            if token:
                item["token"] = token
            if thumbnail_url:
                item["thumbnail_url"] = thumbnail_url
            merge_search_metadata(item, metadata)
            by_url[url] = item
            order.append(url)
            continue

        if better_search_title(title, str(item.get("title") or "")):
            item["title"] = title
        if thumbnail_url and not item.get("thumbnail_url"):
            item["thumbnail_url"] = thumbnail_url
        merge_search_metadata(item, metadata)

    return [by_url[url] for url in order]


def first_search_thumbnail(block: str, page_url: str) -> str:
    if not block:
        return ""
    candidates = image_url_candidates_from_html(block, page_url)
    return candidates[0][1] if candidates else ""


def clean_search_title(value: str) -> str:
    title = clean_text(value)
    title = re.sub(r"^image:\s*", "", title, flags=re.IGNORECASE)
    return "" if title.lower() in {"t", "thumbnail", "image"} else title


def better_search_title(candidate: str, current: str) -> bool:
    if not candidate:
        return False
    if not current or current.lower() in {"untitled", "t", "thumbnail", "image"}:
        return True
    if current.lower().startswith("image:"):
        return True
    return len(candidate) > len(current) and not candidate.lower().startswith("image:")
