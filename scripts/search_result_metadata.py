from __future__ import annotations

import re
from typing import Any

from source_bridge_core import clean_text, find_enclosing_html_block, html_fragment_text


DATE_TIME_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\b")
EHENTAI_TAG_NAMESPACES = {
    "artist",
    "character",
    "female",
    "group",
    "language",
    "male",
    "mixed",
    "other",
    "parody",
    "reclass",
}


def parse_ehentai_search_metadata(text: str, markers: list[str]) -> dict[str, Any]:
    block = find_enclosing_html_block(text, markers)
    return parse_ehentai_search_block(block)


def parse_ehentai_search_block(block: str) -> dict[str, Any]:
    if not block:
        return {"tags": []}

    result: dict[str, Any] = {"tags": []}
    category_match = re.search(
        r"<[^>]+class=[\"'][^\"']*\b(?:cn|cs)\b[^\"']*[\"'][^>]*>(.*?)</[^>]+>",
        block,
        re.IGNORECASE | re.DOTALL,
    )
    if category_match:
        _set_if_text(result, "category", html_fragment_text(category_match.group(1)))

    uploader_match = re.search(
        r"<a[^>]+href=[\"'][^\"']*f_uploader=[^\"']+[\"'][^>]*>(.*?)</a>",
        block,
        re.IGNORECASE | re.DOTALL,
    )
    if uploader_match:
        _set_if_text(result, "uploader", html_fragment_text(uploader_match.group(1)))

    uploaded_match = DATE_TIME_RE.search(block)
    if uploaded_match:
        result["uploaded_at"] = uploaded_match.group(1)

    page_count_match = re.search(r"\b(\d{1,5})\s+pages?\b", html_fragment_text(block), re.IGNORECASE)
    if page_count_match:
        page_count = int(page_count_match.group(1))
        if 0 < page_count <= 10000:
            result["page_count"] = page_count

    rating_match = re.search(
        r"data-rating\s*=\s*[\"']([0-5](?:\.\d+)?)[\"']"
        r"|(?:aria-label|title)\s*=\s*[\"'][^\"']*?rating\s*[:：]?\s*([0-5](?:\.\d+)?)"
        r"(?:\s*(?:/|out of)\s*5)?[^\"']*[\"']",
        block,
        re.IGNORECASE,
    )
    if rating_match:
        result["rating"] = float(rating_match.group(1) or rating_match.group(2))

    seen_tags: set[str] = set()
    for raw_tag in re.findall(r"title=[\"']([^\"']+:[^\"']+)[\"']", block, re.IGNORECASE):
        tag = clean_text(html_fragment_text(raw_tag).replace("_", " "))
        namespace = tag.partition(":")[0].lower()
        if namespace not in EHENTAI_TAG_NAMESPACES:
            continue
        if tag and tag not in seen_tags:
            seen_tags.add(tag)
            result["tags"].append(tag)
    return result


def parse_generic_search_metadata(text: str, markers: list[str]) -> dict[str, Any]:
    block = find_enclosing_html_block(text, markers, tags=("article", "li", "tr"))
    if not block:
        return {"tags": []}

    result: dict[str, Any] = {"tags": []}
    uploaded_match = re.search(
        r"<time[^>]+datetime=[\"']([^\"']+)[\"']",
        block,
        re.IGNORECASE,
    ) or DATE_TIME_RE.search(block)
    if uploaded_match:
        result["uploaded_at"] = clean_text(uploaded_match.group(1))

    for key, class_pattern in (
        ("uploader", r"(?:uploader|author|username|user-name)"),
        ("category", r"(?:category|type|classification)"),
    ):
        match = re.search(
            rf"<[^>]+class=[\"'][^\"']*\b{class_pattern}\b[^\"']*[\"'][^>]*>(.*?)</[^>]+>",
            block,
            re.IGNORECASE | re.DOTALL,
        )
        if match:
            _set_if_text(result, key, html_fragment_text(match.group(1)))
    return result


def merge_search_metadata(target: dict[str, Any], metadata: dict[str, Any]) -> None:
    for key in ("category", "uploader", "uploaded_at", "page_count", "rating"):
        if metadata.get(key) and not target.get(key):
            target[key] = metadata[key]
    if metadata.get("tags") and not target.get("tags"):
        target["tags"] = metadata["tags"]


def _set_if_text(target: dict[str, Any], key: str, value: Any) -> None:
    text = clean_text(str(value or ""))
    if text:
        target[key] = text
