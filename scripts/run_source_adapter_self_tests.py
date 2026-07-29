from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(os.environ.get("SOURCE_ADAPTER_CONFIG", PROJECT_ROOT / "config" / "source-adapters.json"))


def main() -> int:
    registry = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    executed = 0
    for source in registry.get("sources", []):
        source_id = str(source.get("id") or "").strip()
        for spec in source.get("self_tests") or []:
            script = resolve_project_script(spec.get("script"))
            args = [str(item) for item in spec.get("args") or []]
            print(f"[source self-test] {source_id}: {script.relative_to(PROJECT_ROOT)} {' '.join(args)}".rstrip())
            result = subprocess.run(
                [sys.executable, str(script), *args],
                cwd=PROJECT_ROOT,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                check=False,
            )
            if result.returncode != 0:
                raise RuntimeError(f"{source_id} self-test failed with exit code {result.returncode}")
            executed += 1
    if executed == 0:
        raise RuntimeError("source adapter registry did not declare any self tests")
    print(json.dumps({"ok": True, "source_tests": executed}, ensure_ascii=False))
    return 0


def resolve_project_script(value: Any) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError("source self-test script is required")
    candidate = (PROJECT_ROOT / value).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT.resolve())
    except ValueError as error:
        raise RuntimeError(f"source self-test script escapes project root: {value}") from error
    if not candidate.is_file() or candidate.suffix.lower() != ".py":
        raise RuntimeError(f"source self-test script is not a Python file: {candidate}")
    return candidate


if __name__ == "__main__":
    raise SystemExit(main())
