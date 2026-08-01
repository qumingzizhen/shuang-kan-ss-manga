from __future__ import annotations

import os
import sys
from pathlib import Path


SOURCE_ID = "exhentai"
SOURCE_LABEL = "ExHentai"
DEFAULT_BASE_URL = "https://exhentai.org/"
PROJECT_ROOT = Path(__file__).resolve().parents[1]

_ENV_ALIASES = {
    "EHENTAI_BASE_URL": "EXHENTAI_BASE_URL",
    "EHENTAI_OUTPUT": "EXHENTAI_OUTPUT",
    "EHENTAI_PAGE_OUTPUT": "EXHENTAI_PAGE_OUTPUT",
    "EHENTAI_COOKIE_FILE": "EXHENTAI_COOKIE_FILE",
    "EHENTAI_HEADERS_FILE": "EXHENTAI_HEADERS_FILE",
    "EHENTAI_HTTP_BACKEND": "EXHENTAI_HTTP_BACKEND",
    "EHENTAI_IMPERSONATE": "EXHENTAI_IMPERSONATE",
    "EHENTAI_DELAY": "EXHENTAI_DELAY",
    "EHENTAI_TIMEOUT": "EXHENTAI_TIMEOUT",
    "EHENTAI_RETRIES": "EXHENTAI_RETRIES",
    "EHENTAI_RETRY_BACKOFF": "EXHENTAI_RETRY_BACKOFF",
    "EHENTAI_MAX_SEARCH_PAGES": "EXHENTAI_MAX_SEARCH_PAGES",
    "EHENTAI_MAX_GALLERY_INDEX_PAGES": "EXHENTAI_MAX_GALLERY_INDEX_PAGES",
    "EHENTAI_MAX_PAGES_PER_RUN": "EXHENTAI_MAX_PAGES_PER_RUN",
    "EHENTAI_MAX_FAILURES": "EXHENTAI_MAX_FAILURES",
    "EHENTAI_DOWNLOAD_CONCURRENCY": "EXHENTAI_DOWNLOAD_CONCURRENCY",
    "EHENTAI_MIN_IMAGE_BYTES": "EXHENTAI_MIN_IMAGE_BYTES",
    "EHENTAI_FORBIDDEN_STOP_AFTER": "EXHENTAI_FORBIDDEN_STOP_AFTER",
    "EHENTAI_USER_AGENT": "EXHENTAI_USER_AGENT",
}

for generic_key, source_key in _ENV_ALIASES.items():
    if generic_key not in os.environ and os.environ.get(source_key):
        os.environ[generic_key] = os.environ[source_key]
os.environ.setdefault("EHENTAI_BASE_URL", DEFAULT_BASE_URL)
os.environ.setdefault("EHENTAI_HTTP_BACKEND", "auto")
os.environ.setdefault("EHENTAI_IMPERSONATE", "chrome124")

import ehentai_bridge as _core  # noqa: E402 - configure the generic bridge before import.

_core.SOURCE_ID = SOURCE_ID
_core.SOURCE_LABEL = SOURCE_LABEL
_core.DEFAULT_BASE_URL = DEFAULT_BASE_URL
_core.PAGE_ARTIFACT_ROOT = PROJECT_ROOT / ".data" / "page-artifacts" / SOURCE_ID

if __name__ == "__main__":
    raise SystemExit(_core.main())

# Importers and offline tests receive the configured generic module directly. This
# keeps one implementation of search, gallery parsing, reading, retries, and download.
sys.modules[__name__] = _core