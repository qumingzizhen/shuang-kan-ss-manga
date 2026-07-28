from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def validate(instance: Any, schema: dict[str, Any], root: dict[str, Any], path: str = "$") -> None:
    if "$ref" in schema:
        validate(instance, resolve_reference(root, schema["$ref"]), root, path)
        return
    if "oneOf" in schema:
        matches = 0
        errors: list[str] = []
        for candidate in schema["oneOf"]:
            try:
                validate(instance, candidate, root, path)
                matches += 1
            except ValueError as error:
                errors.append(str(error))
        if matches != 1:
            raise ValueError(f"{path}: expected exactly one schema match, got {matches}; {'; '.join(errors)}")
        return
    if "const" in schema and instance != schema["const"]:
        raise ValueError(f"{path}: expected constant {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        raise ValueError(f"{path}: {instance!r} is not in enum")

    expected_types = schema.get("type")
    if expected_types is not None:
        allowed = expected_types if isinstance(expected_types, list) else [expected_types]
        if not any(matches_type(instance, expected) for expected in allowed):
            raise ValueError(f"{path}: expected type {allowed}, got {type(instance).__name__}")

    if isinstance(instance, dict):
        properties = schema.get("properties", {})
        missing = [key for key in schema.get("required", []) if key not in instance]
        if missing:
            raise ValueError(f"{path}: missing required field(s): {', '.join(missing)}")
        if schema.get("additionalProperties") is False:
            extra = sorted(set(instance) - set(properties))
            if extra:
                raise ValueError(f"{path}: unknown field(s): {', '.join(extra)}")
        for key, value in instance.items():
            if key in properties:
                validate(value, properties[key], root, f"{path}.{key}")
    elif isinstance(instance, list) and "items" in schema:
        for index, value in enumerate(instance):
            validate(value, schema["items"], root, f"{path}[{index}]")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            raise ValueError(f"{path}: value is below minimum")
        if "maximum" in schema and instance > schema["maximum"]:
            raise ValueError(f"{path}: value is above maximum")
    if isinstance(instance, str) and len(instance) < schema.get("minLength", 0):
        raise ValueError(f"{path}: string is shorter than minLength")


def resolve_reference(root: dict[str, Any], reference: str) -> dict[str, Any]:
    if not reference.startswith("#/"):
        raise ValueError(f"unsupported external reference: {reference}")
    value: Any = root
    for segment in reference[2:].split("/"):
        value = value[segment.replace("~1", "/").replace("~0", "~")]
    return value


def matches_type(value: Any, expected: str) -> bool:
    return {
        "null": value is None,
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
    }.get(expected, False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--normalize", action="store_true")
    args = parser.parse_args()
    schema = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    fixture = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
    validate(fixture, schema, schema)
    if args.normalize:
        print(json.dumps(fixture, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
