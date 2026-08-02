from __future__ import annotations

import argparse
import json
from pathlib import Path

from source_bridge_core import parse_variant_specs, write_image_variants


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate reader image variants for an already cached page.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--index", required=True, type=int)
    parser.add_argument("--variant-specs", required=True)
    parsed = parser.parse_args()

    try:
        variants, errors = write_image_variants(
            parsed.input,
            parse_variant_specs(parsed.variant_specs),
            parsed.output_dir,
            parsed.index,
        )
        print(json.dumps({"variants": variants, "errors": errors}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - keep stderr concise for the server log.
        print(json.dumps({"variants": [], "errors": [str(exc)]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
