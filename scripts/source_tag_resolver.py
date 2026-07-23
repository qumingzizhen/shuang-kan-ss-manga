from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DICTIONARY_PATH = PROJECT_ROOT / "apps" / "web" / "src" / "lib" / "tag-translations.json"
NAMESPACE_RE = re.compile(r"^([A-Za-z][\w-]{0,31})\s*[:：]\s*(.+)$")


@lru_cache(maxsize=1)
def _opencc() -> Any:
    try:
        from opencc import OpenCC
    except ImportError:
        return None
    return OpenCC("t2s")


def simplified_tag(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    converter = _opencc()
    if converter is not None:
        text = converter.convert(text)
    return re.sub(r"\s+", " ", text).strip()


def normalized_tag(value: str) -> str:
    text = simplified_tag(value)
    text = "".join(
        character
        for character in text
        if unicodedata.category(character) not in {"Cf", "Sk", "So"}
    )
    return text.casefold()


def namespace_free(value: str) -> str:
    match = NAMESPACE_RE.match(str(value or "").strip())
    return match.group(2).strip() if match else str(value or "").strip()


class SourceTagResolver:
    def __init__(self, entries: list[dict[str, Any]]) -> None:
        self.entries = entries
        self.lookup: dict[str, list[dict[str, Any]]] = {}
        for entry in entries:
            terms = [
                entry.get("canonical", ""),
                entry.get("zh", ""),
                *(entry.get("aliases") or []),
            ]
            for values in (entry.get("source_terms") or {}).values():
                terms.extend(values or [])
            for term in terms:
                key = normalized_tag(term)
                if not key:
                    continue
                matches = self.lookup.setdefault(key, [])
                if entry not in matches:
                    matches.append(entry)

    @classmethod
    def from_path(cls, path: Path = DICTIONARY_PATH) -> "SourceTagResolver":
        return cls(json.loads(path.read_text(encoding="utf-8")))

    def find(self, value: str, source_id: str | None = None) -> dict[str, Any] | None:
        matches = self.lookup.get(normalized_tag(value), [])
        if not matches:
            return None
        if source_id:
            exact_source = [
                entry
                for entry in matches
                if any(
                    normalized_tag(term) == normalized_tag(value)
                    for term in (entry.get("source_terms") or {}).get(source_id, [])
                )
            ]
            if len(exact_source) == 1:
                return exact_source[0]
        exact_canonical = [
            entry for entry in matches if normalized_tag(entry.get("canonical", "")) == normalized_tag(value)
        ]
        if len(exact_canonical) == 1:
            return exact_canonical[0]
        return matches[0] if len(matches) == 1 else None

    def resolve(self, value: str, source_id: str) -> str:
        cleaned = re.sub(r"\s+", " ", str(value or "")).strip()
        if not cleaned:
            return ""
        entry = self.find(cleaned, source_id)
        if entry is None:
            return cleaned
        if source_id == "e-hentai":
            if str(entry["canonical"]).startswith("18comic:"):
                terms = (entry.get("source_terms") or {}).get("18comic", [])
                return str(terms[0]) if terms else namespace_free(str(entry["canonical"]))
            return str(entry["canonical"])
        source_terms = (entry.get("source_terms") or {}).get(source_id, [])
        if source_terms:
            exact = next(
                (term for term in source_terms if normalized_tag(term) == normalized_tag(cleaned)),
                None,
            )
            if exact:
                return str(exact)
            return str(source_terms[0])
        return cleaned


@lru_cache(maxsize=1)
def default_resolver() -> SourceTagResolver:
    return SourceTagResolver.from_path()


def resolve_source_tag(value: str, source_id: str) -> str:
    return default_resolver().resolve(value, source_id)
