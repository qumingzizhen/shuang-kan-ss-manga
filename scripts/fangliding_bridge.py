from __future__ import annotations

import os
import sys
from pathlib import Path


SOURCE_ID = "fangliding"
SOURCE_LABEL = "Fangliding"
DEFAULT_BASE_URL = "https://ex.fangliding.eu.org/"
PROJECT_ROOT = Path(__file__).resolve().parents[1]

_ENV_ALIASES = {
    "EHENTAI_BASE_URL": "FANGLIDING_BASE_URL",
    "EHENTAI_OUTPUT": "FANGLIDING_OUTPUT",
    "EHENTAI_PAGE_OUTPUT": "FANGLIDING_PAGE_OUTPUT",
    "EHENTAI_COOKIE_FILE": "FANGLIDING_COOKIE_FILE",
    "EHENTAI_HEADERS_FILE": "FANGLIDING_HEADERS_FILE",
    "EHENTAI_DELAY": "FANGLIDING_DELAY",
    "EHENTAI_TIMEOUT": "FANGLIDING_TIMEOUT",
    "EHENTAI_RETRIES": "FANGLIDING_RETRIES",
    "EHENTAI_RETRY_BACKOFF": "FANGLIDING_RETRY_BACKOFF",
    "EHENTAI_MAX_SEARCH_PAGES": "FANGLIDING_MAX_SEARCH_PAGES",
    "EHENTAI_MAX_GALLERY_INDEX_PAGES": "FANGLIDING_MAX_GALLERY_INDEX_PAGES",
    "EHENTAI_MAX_PAGES_PER_RUN": "FANGLIDING_MAX_PAGES_PER_RUN",
    "EHENTAI_MAX_FAILURES": "FANGLIDING_MAX_FAILURES",
    "EHENTAI_DOWNLOAD_CONCURRENCY": "FANGLIDING_DOWNLOAD_CONCURRENCY",
    "EHENTAI_MIN_IMAGE_BYTES": "FANGLIDING_MIN_IMAGE_BYTES",
    "EHENTAI_FORBIDDEN_STOP_AFTER": "FANGLIDING_FORBIDDEN_STOP_AFTER",
    "EHENTAI_USER_AGENT": "FANGLIDING_USER_AGENT",
}

for generic_key, source_key in _ENV_ALIASES.items():
    if generic_key not in os.environ and os.environ.get(source_key):
        os.environ[generic_key] = os.environ[source_key]
os.environ.setdefault("EHENTAI_BASE_URL", DEFAULT_BASE_URL)

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