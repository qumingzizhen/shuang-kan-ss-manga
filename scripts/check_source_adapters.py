from __future__ import annotations

import contextlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(os.environ.get("SOURCE_ADAPTER_CONFIG", PROJECT_ROOT / "config" / "source-adapters.json"))
CAPABILITIES = {"search", "gallery", "download", "retry_folder", "page_list", "page_image", "online_read"}
HOSTNAME_PATTERN = re.compile(
    r"^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*"
    r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$"
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        fail(f"source adapter config not found: {CONFIG_PATH}")
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        fail("source adapter config root must be an object")
    return data


def validate_source(source: dict[str, Any], seen_ids: set[str]) -> None:
    source_id = text(source.get("id"))
    if not source_id:
        fail("source id is required")
    if source_id in seen_ids:
        fail(f"duplicate source id: {source_id}")
    seen_ids.add(source_id)

    for key in ("name", "version"):
        if not text(source.get(key)):
            fail(f"{source_id}: {key} is required")

    capabilities = source.get("capabilities")
    if not isinstance(capabilities, list) or not capabilities:
        fail(f"{source_id}: capabilities must be a non-empty list")
    unknown_capabilities = sorted({str(item) for item in capabilities} - CAPABILITIES)
    if unknown_capabilities:
        fail(f"{source_id}: unknown capabilities: {', '.join(unknown_capabilities)}")

    bridge = source.get("bridge")
    if not isinstance(bridge, dict):
        fail(f"{source_id}: bridge config is required")
    if bridge.get("kind") != "python":
        fail(f"{source_id}: only python bridges are supported for built-in config")

    script = text(bridge.get("script"))
    if not script:
        fail(f"{source_id}: bridge.script is required")
    script_path = Path(script)
    if not script_path.is_absolute():
        script_path = PROJECT_ROOT / script_path
    if not script_path.exists():
        fail(f"{source_id}: bridge script not found: {script_path}")

    script_env = bridge.get("script_env")
    if script_env is not None and not text(script_env):
        fail(f"{source_id}: bridge.script_env must be a non-empty string when set")

    python_env = bridge.get("python_env")
    if not isinstance(python_env, list) or not all(text(item) for item in python_env):
        fail(f"{source_id}: bridge.python_env must be a non-empty string list")

    page_commands = bridge.get("page_commands")
    if not isinstance(page_commands, bool):
        fail(f"{source_id}: bridge.page_commands must be boolean")
    if "online_read" in capabilities and not {"page_list", "page_image"}.issubset(set(capabilities)):
        fail(f"{source_id}: online_read requires page_list and page_image capabilities")
    if ("page_list" in capabilities or "page_image" in capabilities) and not page_commands:
        fail(f"{source_id}: page-level capabilities require bridge.page_commands=true")

    default_requires_any_env = source.get("default_requires_any_env")
    if default_requires_any_env is not None and (
        not isinstance(default_requires_any_env, list) or not all(text(item) for item in default_requires_any_env)
    ):
        fail(f"{source_id}: default_requires_any_env must be a non-empty string list when set")

    default_disabled_reason = source.get("default_disabled_reason")
    if default_disabled_reason is not None and not text(default_disabled_reason):
        fail(f"{source_id}: default_disabled_reason must be a non-empty string when set")

    thumbnail_hosts = source.get("thumbnail_hosts")
    if thumbnail_hosts is not None:
        if not isinstance(thumbnail_hosts, list) or not thumbnail_hosts:
            fail(f"{source_id}: thumbnail_hosts must be a non-empty hostname list when set")
        normalized_hosts = [text(item).lower().rstrip(".") for item in thumbnail_hosts]
        if not all(host and HOSTNAME_PATTERN.fullmatch(host) for host in normalized_hosts):
            fail(f"{source_id}: thumbnail_hosts contains an invalid hostname")
        if len(set(normalized_hosts)) != len(normalized_hosts):
            fail(f"{source_id}: thumbnail_hosts must not contain duplicates")


def text(value: object) -> str:
    return str(value).strip() if value is not None else ""


def main() -> int:
    try:
        data = read_config()
        sources = data.get("sources")
        if not isinstance(sources, list) or not sources:
            fail("sources must be a non-empty list")

        seen_ids: set[str] = set()
        for source in sources:
            if not isinstance(source, dict):
                fail("each source must be an object")
            validate_source(source, seen_ids)

        default_source_id = text(data.get("default_source_id"))
        if not default_source_id:
            fail("default_source_id is required")
        if default_source_id not in seen_ids:
            fail(f"default_source_id does not match a registered source: {default_source_id}")

        display_path = CONFIG_PATH
        with contextlib.suppress(ValueError):
            display_path = CONFIG_PATH.relative_to(PROJECT_ROOT)
        print(f"ok {display_path} ({len(sources)} source adapter(s))")
        return 0
    except Exception as exc:  # noqa: BLE001 - command-line validator should be concise.
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
