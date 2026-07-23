from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from source_tag_resolver import normalized_tag, simplified_tag


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DICTIONARY = PROJECT_ROOT / "apps" / "web" / "src" / "lib" / "tag-translations.json"
METADATA = PROJECT_ROOT / "apps" / "web" / "src" / "lib" / "tag-translations.meta.json"
VOCABULARY = PROJECT_ROOT / "config" / "tag-vocabularies" / "18comic.json"
OVERRIDES = PROJECT_ROOT / "config" / "source-tag-overrides.json"
REPORT = PROJECT_ROOT / "config" / "tag-vocabularies" / "alignment-report.json"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def searchable_terms(entry: dict[str, Any]) -> list[str]:
    return [
        str(entry.get("zh") or ""),
        *(str(value) for value in entry.get("aliases") or []),
        str(entry.get("canonical") or "").split(":", 1)[-1],
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description="把来源真实词条同步到统一词典。")
    parser.add_argument("--minimum-coverage", type=float, default=0.90)
    args = parser.parse_args()

    entries = [
        entry for entry in read_json(DICTIONARY)
        if not str(entry.get("canonical") or "").startswith("18comic:")
    ]
    vocabulary = read_json(VOCABULARY)
    override_config = read_json(OVERRIDES).get("18comic", {})
    overrides = {
        normalized_tag(source_term): canonical
        for source_term, canonical in override_config.get("mappings", {}).items()
    }
    explicit_source_only = {
        normalized_tag(source_term)
        for source_term in override_config.get("source_only", [])
    }
    by_canonical = {str(entry["canonical"]).casefold(): entry for entry in entries}
    lookup: dict[str, set[str]] = {}
    for entry in entries:
        for term in searchable_terms(entry):
            key = normalized_tag(term)
            if key:
                lookup.setdefault(key, set()).add(str(entry["canonical"]))

    mapped_unique = mapped_occurrences = 0
    source_only_unique = source_only_occurrences = 0
    ambiguous: list[dict[str, Any]] = []
    mapping_methods: dict[str, int] = {"override": 0, "exact": 0, "source_only": 0}
    for tag in vocabulary.get("tags", []):
        source_term = str(tag["name"]).strip()
        count = int(tag.get("count") or 0)
        key = normalized_tag(source_term)
        target = overrides.get(key)
        method = "override" if target else ""
        candidates = sorted(lookup.get(key, set()))
        if target:
            entry = by_canonical.get(str(target).casefold())
            if entry is None:
                raise SystemExit(f"无效覆盖映射：{source_term} -> {target}")
        elif len(candidates) == 1 and key not in explicit_source_only:
            target = candidates[0]
            entry = by_canonical[target.casefold()]
            method = "exact"
        else:
            if len(candidates) > 1 and key not in explicit_source_only:
                ambiguous.append({"source_term": source_term, "count": count, "candidates": candidates})
            canonical = f"18comic:{source_term}"
            entry = {
                "canonical": canonical,
                "zh": simplified_tag(source_term),
                "aliases": [],
                "source_terms": {"18comic": [source_term]},
            }
            entries.append(entry)
            by_canonical[canonical.casefold()] = entry
            source_only_unique += 1
            source_only_occurrences += count
            mapping_methods["source_only"] += 1
            continue

        source_terms = entry.setdefault("source_terms", {}).setdefault("18comic", [])
        if source_term not in source_terms:
            source_terms.append(source_term)
        mapped_unique += 1
        mapped_occurrences += count
        mapping_methods[method] += 1

    total_unique = int(vocabulary.get("unique_tags") or 0)
    total_occurrences = int(vocabulary.get("tag_occurrences") or 0)
    resolved_unique = mapped_unique + source_only_unique
    resolved_occurrences = mapped_occurrences + source_only_occurrences
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_id": "18comic",
        "sampled_albums": int(vocabulary.get("successful_albums") or 0),
        "total_unique_tags": total_unique,
        "total_tag_occurrences": total_occurrences,
        "cross_source_mapped_unique": mapped_unique,
        "cross_source_mapped_occurrences": mapped_occurrences,
        "source_specific_unique": source_only_unique,
        "source_specific_occurrences": source_only_occurrences,
        "resolved_unique": resolved_unique,
        "resolved_occurrences": resolved_occurrences,
        "unique_resolution_rate": resolved_unique / total_unique if total_unique else 1.0,
        "occurrence_resolution_rate": resolved_occurrences / total_occurrences if total_occurrences else 1.0,
        "cross_source_unique_rate": mapped_unique / total_unique if total_unique else 1.0,
        "cross_source_occurrence_rate": mapped_occurrences / total_occurrences if total_occurrences else 1.0,
        "mapping_methods": mapping_methods,
        "ambiguous_terms_kept_source_specific": ambiguous,
        "policy": "仅精确简繁匹配或人工覆盖可作为跨站同义词；其余词条保留为 18comic 专用词，禁止模糊猜配。",
    }
    if report["unique_resolution_rate"] < args.minimum_coverage:
        raise SystemExit(
            f"唯一词条解析覆盖率 {report['unique_resolution_rate']:.2%} 低于要求 {args.minimum_coverage:.2%}"
        )
    if report["occurrence_resolution_rate"] < args.minimum_coverage:
        raise SystemExit(
            f"词条频次解析覆盖率 {report['occurrence_resolution_rate']:.2%} 低于要求 {args.minimum_coverage:.2%}"
        )

    for entry in entries:
        source_terms = entry.get("source_terms")
        if source_terms:
            for source_id, values in list(source_terms.items()):
                source_terms[source_id] = sorted(set(values), key=lambda value: normalized_tag(value))
    entries.sort(key=lambda entry: (str(entry["canonical"]).split(":", 1)[0], str(entry["canonical"])))
    write_json(DICTIONARY, entries)
    metadata = read_json(METADATA)
    metadata["entry_count"] = len(entries)
    metadata["source_alignment"] = {
        "report": "config/tag-vocabularies/alignment-report.json",
        "18comic_sampled_albums": report["sampled_albums"],
        "18comic_unique_resolution_rate": report["unique_resolution_rate"],
        "18comic_occurrence_resolution_rate": report["occurrence_resolution_rate"],
    }
    write_json(METADATA, metadata)
    write_json(REPORT, report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
