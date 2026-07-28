from __future__ import annotations

import threading
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from source_bridge_core import (
    ImageTarget,
    InvalidImagePayloadError,
    inspect_image_payload,
    run_bounded_downloads,
    save_image_target,
)


def main() -> None:
    lock = threading.Lock()
    active = 0
    max_active = 0
    failures: list[tuple[int, str]] = []
    progress: list[tuple[int, int, int, bool]] = []
    targets = [ImageTarget(index, f"https://page/{index}", f"https://image/{index}.jpg", "https://gallery") for index in range(1, 7)]

    def worker(target: ImageTarget) -> bool:
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            time.sleep(0.02)
            if target.index == 4:
                raise RuntimeError("fixture failure")
            return target.index == 2
        finally:
            with lock:
                active -= 1

    stats = run_bounded_downloads(
        targets,
        concurrency=3,
        worker=worker,
        on_failure=lambda target, error: failures.append((target.index, str(error))),
        on_progress=lambda state, total, _last_index, force=False: progress.append(
            (state.done, state.skipped, total, force)
        ),
    )

    assert max_active == 3
    assert (stats.done, stats.skipped, stats.failed, stats.stopped) == (4, 1, 1, False)
    assert failures == [(4, "fixture failure")]
    assert progress[-1] == (4, 1, 6, True)

    def valid_jpeg(width: int = 3, height: int = 2) -> bytes:
        sof = (
            b"\xff\xc0\x00\x11\x08"
            + height.to_bytes(2, "big")
            + width.to_bytes(2, "big")
            + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
        )
        return b"\xff\xd8" + sof + b"fixture-pixels" * 8 + b"\xff\xd9"

    class FakeClient:
        def __init__(self) -> None:
            self.attempts = 0

        def fetch_binary(self, _url: str, referer: str | None = None) -> tuple[bytes, str]:
            assert referer == "https://gallery"
            self.attempts += 1
            if self.attempts == 1:
                return b"<html>temporary placeholder</html>" * 4, "text/html"
            return valid_jpeg(), "image/jpeg"

    with TemporaryDirectory() as temporary:
        folder = Path(temporary)
        (folder / "0001.jpg").write_bytes(b"\xff\xd8truncated")
        client = FakeClient()
        path, content_type, size, skipped = save_image_target(
            client,
            folder,
            targets[0],
            overwrite=False,
            min_image_bytes=64,
        )
        assert path.name == "0001.jpg"
        assert content_type == "image/jpeg"
        assert size == len(valid_jpeg())
        assert skipped is False
        assert client.attempts == 2
        assert inspect_image_payload(path.read_bytes(), content_type).width == 3
        assert not list(folder.glob("*.part"))
        try:
            inspect_image_payload(b"\x89PNG\r\n\x1a\n" + b"x" * 80, "image/png")
        except InvalidImagePayloadError:
            pass
        else:
            raise AssertionError("truncated PNG must be rejected")
    print({"ok": True, "max_concurrency": max_active, "done": stats.done, "failed": stats.failed})


if __name__ == "__main__":
    main()
