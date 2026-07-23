from __future__ import annotations

import argparse
import json
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jmcomic_api_adapter import create_client
from source_bridge_core import clean_text


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_ROOT / "config" / "tag-vocabularies" / "18comic.json"
SAMPLE_PLANS = (
    {"order_by": "mr", "time": "a", "label": "最新"},
    {"order_by": "mv", "time": "m", "label": "月浏览量"},
    {"order_by": "tr", "time": "a", "label": "总评分"},
)
_thread_local = threading.local()


def detail_client() -> Any:
    client = getattr(_thread_local, "client", None)
    if client is None:
        client = create_client()
        _thread_local.client = client
    return client


def load_tags(album_id: str) -> tuple[str, list[str]]:
    album = detail_client().get_album_detail(album_id)
    tags = [clean_text(str(tag)) for tag in album.tags]
    return album_id, [tag for tag in tags if tag]


def collect_album_ids(max_albums: int, pages_per_plan: int) -> tuple[list[str], list[dict[str, Any]]]:
    client = create_client()
    album_ids: list[str] = []
    seen: set[str] = set()
    samples: list[dict[str, Any]] = []
    target_per_plan = max(max_albums // len(SAMPLE_PLANS), 1)
    for plan in SAMPLE_PLANS:
        before = len(album_ids)
        for page_number in range(1, pages_per_plan + 1):
            page = client.categories_filter(
                page=page_number,
                time=plan["time"],
                category="0",
                order_by=plan["order_by"],
            )
            for album_id, _info in page.content:
                album_id = str(album_id)
                if album_id in seen:
                    continue
                seen.add(album_id)
                album_ids.append(album_id)
                if len(album_ids) - before >= target_per_plan or len(album_ids) >= max_albums:
                    break
            if len(album_ids) - before >= target_per_plan or len(album_ids) >= max_albums or not page.content:
                break
        samples.append({**plan, "albums": len(album_ids) - before})
        if len(album_ids) >= max_albums:
            break
    return album_ids[:max_albums], samples


def main() -> None:
    parser = argparse.ArgumentParser(description="从 18comic/JM API 抽样真实漫画词条。")
    parser.add_argument("--max-albums", type=int, default=600)
    parser.add_argument("--pages-per-plan", type=int, default=20)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    album_ids, sample_plans = collect_album_ids(max(args.max_albums, 1), max(args.pages_per_plan, 1))
    counts: Counter[str] = Counter()
    succeeded = 0
    failures: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 6))) as pool:
        futures = {pool.submit(load_tags, album_id): album_id for album_id in album_ids}
        for future in as_completed(futures):
            album_id = futures[future]
            try:
                _, tags = future.result()
            except Exception as error:
                failures.append({"album_id": album_id, "error": clean_text(str(error))[:300]})
                continue
            succeeded += 1
            counts.update(tags)

    payload = {
        "source_id": "18comic",
        "source": "JM API album.tags",
        "sampled_at": datetime.now(timezone.utc).isoformat(),
        "requested_albums": len(album_ids),
        "successful_albums": succeeded,
        "failed_albums": len(failures),
        "sample_plans": sample_plans,
        "tag_occurrences": sum(counts.values()),
        "unique_tags": len(counts),
        "tags": [
            {"name": name, "count": count}
            for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0].casefold()))
        ],
        "failures": failures[:20],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    print(json.dumps({key: payload[key] for key in (
        "requested_albums",
        "successful_albums",
        "failed_albums",
        "tag_occurrences",
        "unique_tags",
    )}, ensure_ascii=False))


if __name__ == "__main__":
    main()
