from __future__ import annotations

import argparse
import io
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageOps, UnidentifiedImageError
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


IMAGE_EXTENSIONS = {".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"}


def natural_key(path: Path) -> list[object]:
    parts = re.split(r"(\d+)", path.name)
    return [int(part) if part.isdigit() else part.casefold() for part in parts]


def collect_images(folder: Path) -> list[Path]:
    return sorted(
        (path for path in folder.iterdir() if path.is_file() and path.suffix.casefold() in IMAGE_EXTENSIONS),
        key=natural_key,
    )


def export_pdf(folder: Path, output: Path, title: str | None, quality: int) -> dict[str, object]:
    if not folder.is_dir():
        raise FileNotFoundError(f"library folder does not exist: {folder}")

    images = collect_images(folder)
    if not images:
        raise ValueError(f"library folder has no image files: {folder}")

    page_count = create_pdf_from_images(images, output, quality=quality)
    return {
        "type": "pdf_export",
        "title": title or folder.name,
        "source_folder": str(folder),
        "output_file": str(output),
        "page_count": page_count,
        "size_bytes": output.stat().st_size,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "quality": quality,
    }


def create_pdf_from_images(image_paths: Iterable[Path], output: Path, quality: int) -> int:
    paths = list(image_paths)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_output = output.with_suffix(output.suffix + ".part")
    pdf = canvas.Canvas(str(temp_output), pageCompression=1)
    page_count = 0

    try:
        for image_path in paths:
            reader, width, height = image_reader(image_path, quality)
            pdf.setPageSize((width, height))
            pdf.drawImage(reader, 0, 0, width=width, height=height, preserveAspectRatio=True, mask="auto")
            pdf.showPage()
            page_count += 1
        pdf.save()
        temp_output.replace(output)
    except Exception:
        if temp_output.exists():
            temp_output.unlink()
        raise

    return page_count


def image_reader(path: Path, quality: int) -> tuple[ImageReader, int, int]:
    try:
        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                flattened = Image.new("RGB", rgba.size, (255, 255, 255))
                flattened.paste(rgba, mask=rgba.getchannel("A"))
                image = flattened
            elif image.mode != "RGB":
                image = image.convert("RGB")
            else:
                image = image.copy()
    except UnidentifiedImageError as exc:
        raise ValueError(f"cannot identify image file: {path}") from exc

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=max(1, min(100, quality)), optimize=True)
    width, height = image.size
    image.close()
    buffer.seek(0)
    return ImageReader(buffer), width, height


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a local manga library folder to PDF.")
    parser.add_argument("--folder", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--title", default=None)
    parser.add_argument("--quality", type=int, default=90)
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    args = parse_args()
    result = export_pdf(args.folder.resolve(), args.output.resolve(), args.title, quality=args.quality)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
