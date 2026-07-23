from __future__ import annotations

import argparse
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT_ROOT / "apps" / "web" / "src" / "lib" / "tag-translations.json"
META_OUTPUT = PROJECT_ROOT / "apps" / "web" / "src" / "lib" / "tag-translations.meta.json"
UPSTREAM_URL = "https://raw.githubusercontent.com/EhTagTranslation/DatabaseReleases/master/db.text.json"
UPSTREAM_REPO = "https://github.com/EhTagTranslation/Database"
SEARCH_NAMESPACES = ("female", "male", "mixed", "language", "other")
CJK_PATTERN = re.compile(r"[\u3400-\u9fff]")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def download_database() -> dict[str, Any]:
    request = urllib.request.Request(UPSTREAM_URL, headers={"User-Agent": "manga-platform-tag-updater/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def existing_entries() -> dict[str, dict[str, Any]]:
    if not OUTPUT.exists():
        return {}
    return {str(item["canonical"]).lower(): item for item in load_json(OUTPUT) if isinstance(item, dict) and item.get("canonical")}


def prefer_chinese_name(upstream_name: str, existing_name: str) -> str:
    if CJK_PATTERN.search(upstream_name):
        return upstream_name
    if CJK_PATTERN.search(existing_name):
        return existing_name
    return upstream_name or existing_name


def source_terms(item: dict[str, Any]) -> dict[str, list[str]]:
    return {
        str(source_id): [str(term).strip() for term in terms if str(term).strip()]
        for source_id, terms in (item.get("source_terms") or {}).items()
        if isinstance(terms, list)
    }


def convert_database(database: dict[str, Any]) -> list[dict[str, Any]]:
    existing = existing_entries()
    converted: dict[str, dict[str, Any]] = {}
    sections = {
        str(section.get("namespace")): section
        for section in database.get("data", [])
        if isinstance(section, dict) and section.get("namespace") in SEARCH_NAMESPACES
    }

    for namespace in SEARCH_NAMESPACES:
        section = sections.get(namespace, {})
        for raw_tag, record in (section.get("data") or {}).items():
            if not isinstance(record, dict):
                continue
            canonical = f"{namespace}:{str(raw_tag).strip()}"
            key = canonical.lower()
            previous = existing.get(key, {})
            upstream_name = str(record.get("name") or "").strip()
            zh = prefer_chinese_name(upstream_name, str(previous.get("zh") or "").strip())
            if not zh:
                continue
            aliases = [str(alias).strip() for alias in previous.get("aliases", []) if str(alias).strip()]
            converted[key] = {
                "canonical": canonical,
                "zh": zh,
                "aliases": aliases,
                **({"source_terms": source_terms(previous)} if source_terms(previous) else {}),
            }

    # Keep small project-specific aliases and mappings outside the selected
    # upstream namespaces, such as parody:original.
    for key, item in existing.items():
        preserved = {
            "canonical": str(item["canonical"]).strip(),
            "zh": str(item.get("zh") or "").strip(),
            "aliases": [str(alias).strip() for alias in item.get("aliases", []) if str(alias).strip()],
        }
        if source_terms(item):
            preserved["source_terms"] = source_terms(item)
        converted.setdefault(key, preserved)

    return sorted(converted.values(), key=lambda item: (item["canonical"].split(":", 1)[0], item["canonical"]))


def main() -> None:
    parser = argparse.ArgumentParser(description="Update the local E-Hentai Chinese tag autocomplete dictionary.")
    parser.add_argument("--input", type=Path, help="Use a previously downloaded db.text.json instead of the network.")
    args = parser.parse_args()

    database = load_json(args.input) if args.input else download_database()
    entries = convert_database(database)
    OUTPUT.write_bytes((json.dumps(entries, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    head = database.get("head") if isinstance(database.get("head"), dict) else {}
    metadata = {
        "source": UPSTREAM_REPO,
        "release_url": UPSTREAM_URL,
        "upstream_sha": head.get("sha"),
        "upstream_version": database.get("version"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "namespaces": list(SEARCH_NAMESPACES),
        "entry_count": len(entries),
        "license": "CC BY-NC-SA 3.0 by default; namespace-specific additional terms may apply",
    }
    META_OUTPUT.write_bytes((json.dumps(metadata, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()
