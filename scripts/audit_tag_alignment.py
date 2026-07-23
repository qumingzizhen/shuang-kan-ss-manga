from __future__ import annotations

import argparse
import json
from pathlib import Path

from source_tag_resolver import SourceTagResolver, normalized_tag


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DICTIONARY = PROJECT_ROOT / "apps" / "web" / "src" / "lib" / "tag-translations.json"
VOCABULARY = PROJECT_ROOT / "config" / "tag-vocabularies" / "18comic.json"
REPORT = PROJECT_ROOT / "config" / "tag-vocabularies" / "alignment-report.json"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="审计统一词典与来源真实词条的可解析覆盖率。")
    parser.add_argument("--minimum-coverage", type=float, default=0.90)
    args = parser.parse_args()

    vocabulary = read_json(VOCABULARY)
    report = read_json(REPORT)
    resolver = SourceTagResolver.from_path(DICTIONARY)
    unresolved: list[str] = []
    wrong_round_trips: list[dict[str, str]] = []
    resolved_occurrences = 0
    for item in vocabulary["tags"]:
        source_term = str(item["name"])
        entry = resolver.find(source_term, "18comic")
        if entry is None:
            unresolved.append(source_term)
            continue
        resolved = resolver.resolve(source_term, "18comic")
        if normalized_tag(resolved) != normalized_tag(source_term):
            wrong_round_trips.append(
                {"source_term": source_term, "canonical": entry["canonical"], "resolved": resolved}
            )
            continue
        resolved_occurrences += int(item["count"])

    total_unique = int(vocabulary["unique_tags"])
    total_occurrences = int(vocabulary["tag_occurrences"])
    unique_rate = (total_unique - len(unresolved) - len(wrong_round_trips)) / total_unique
    occurrence_rate = resolved_occurrences / total_occurrences
    if unresolved or wrong_round_trips:
        raise SystemExit(json.dumps({
            "unresolved": unresolved,
            "wrong_round_trips": wrong_round_trips,
        }, ensure_ascii=False))
    if unique_rate < args.minimum_coverage or occurrence_rate < args.minimum_coverage:
        raise SystemExit(
            f"覆盖率不达标：唯一词条 {unique_rate:.2%}，出现频次 {occurrence_rate:.2%}"
        )
    if abs(float(report["unique_resolution_rate"]) - unique_rate) > 1e-9:
        raise SystemExit("alignment-report.json 与实时唯一词条审计结果不一致")
    print(json.dumps({
        "ok": True,
        "sampled_albums": vocabulary["successful_albums"],
        "unique_tags": total_unique,
        "tag_occurrences": total_occurrences,
        "unique_resolution_rate": unique_rate,
        "occurrence_resolution_rate": occurrence_rate,
        "minimum": args.minimum_coverage,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
