from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path


IMAGE_EXTENSIONS = {".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"}
EXTRA_FILES = ("metadata.json", "failed_pages.jsonl")


def natural_key(path: Path) -> list[object]:
    parts = re.split(r"(\d+)", path.name)
    return [int(part) if part.isdigit() else part.casefold() for part in parts]


def collect_images(folder: Path) -> list[Path]:
    return sorted(
        (path for path in folder.iterdir() if path.is_file() and path.suffix.casefold() in IMAGE_EXTENSIONS),
        key=natural_key,
    )


def export_cbz(folder: Path, output: Path, title: str | None) -> dict[str, object]:
    if not folder.is_dir():
        raise FileNotFoundError(f"library folder does not exist: {folder}")

    images = collect_images(folder)
    if not images:
        raise ValueError(f"library folder has no image files: {folder}")

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for image in images:
            archive.write(image, image.name)

        for extra_name in EXTRA_FILES:
            extra_path = folder / extra_name
            if extra_path.is_file():
                archive.write(extra_path, extra_name)

    return {
        "type": "cbz_export",
        "title": title or folder.name,
        "source_folder": str(folder),
        "output_file": str(output),
        "page_count": len(images),
        "size_bytes": output.stat().st_size,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "included_metadata": (folder / "metadata.json").is_file(),
        "included_failure_log": (folder / "failed_pages.jsonl").is_file(),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a local manga library folder to CBZ.")
    parser.add_argument("--folder", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--title", default=None)
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    args = parse_args()
    result = export_cbz(args.folder.resolve(), args.output.resolve(), args.title)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
