from __future__ import annotations

import threading
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from source_bridge_core import ImageTarget, run_bounded_downloads, save_image_target


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

    class FakeClient:
        def fetch_binary(self, _url: str, referer: str | None = None) -> tuple[bytes, str]:
            assert referer == "https://gallery"
            return b"\xff\xd8\xff" + b"x" * 128, "image/jpeg"

    with TemporaryDirectory() as temporary:
        folder = Path(temporary)
        path, content_type, size, skipped = save_image_target(
            FakeClient(),
            folder,
            targets[0],
            overwrite=False,
            min_image_bytes=64,
        )
        assert path.name == "0001.jpg"
        assert content_type == "image/jpeg"
        assert size == 131
        assert skipped is False
        assert not list(folder.glob("*.part"))

    print({"ok": True, "max_concurrency": max_active, "done": stats.done, "failed": stats.failed})


if __name__ == "__main__":
    main()
