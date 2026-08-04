import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../apps/web/node_modules/playwright");

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "bench-reader-dom");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
const nextBin = join(projectRoot, "apps", "web", "node_modules", "next", "dist", "bin", "next");
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAIAAABrW6giAAAAFElEQVR4nGPkEpFjgAEmBiRADgcAE94ASFNNN1QAAAAASUVORK5CYII=";

const children = [];

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "bench_fixture_bridge.py");
  await writeFile(
    bridgeScript,
    `import argparse, base64, json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--gallery-url")
parser.add_argument("--page-url")
parser.add_argument("--page-index", type=int)
parser.add_argument("--page-output")
parser.add_argument("--max-gallery-index-pages", type=int, default=0)
parser.add_argument("--gallery-index-page", type=int)
args, _ = parser.parse_known_args()

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAIAAABrW6giAAAAFElEQVR4nGPkEpFjgAEmBiRADgcAE94ASFNNN1QAAAAASUVORK5CYII="
)

if args.command == "list-pages":
    count = 800
    if args.gallery_index_page and args.gallery_index_page >= 1:
        start = (args.gallery_index_page - 1) * 20 + 1
        end = min(count, args.gallery_index_page * 20)
        pages = [{"index": index, "page_url": f"https://bench.test/page/{index}"} for index in range(start, end + 1)] if end >= start else []
    elif args.max_gallery_index_pages and args.max_gallery_index_pages >= 1:
        pages = [{"index": index, "page_url": f"https://bench.test/page/{index}"} for index in range(1, 21)]
    else:
        pages = [{"index": index, "page_url": f"https://bench.test/page/{index}"} for index in range(1, count + 1)]
    print(json.dumps({
        "source_id": "bench-fixture",
        "gallery_url": args.gallery_url,
        "title": "bench fixture",
        "tags": [],
        "page_count": count,
        "pages": pages,
    }))
elif args.command == "download-page":
    index = args.page_index or 1
    folder = Path(args.page_output).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{index:04d}.png"
    file_path.write_bytes(PNG)
    print(json.dumps({
        "source_id": "bench-fixture",
        "page_url": args.page_url,
        "storage_key": str(file_path),
        "content_type": "image/png",
        "byte_size": file_path.stat().st_size,
    }))
else:
    raise SystemExit("unsupported command")
`,
    "utf8",
  );

  const registryFile = join(fixtureRoot, "sources.json");
  await writeFile(
    registryFile,
    JSON.stringify(
      {
        version: "0.1.0",
        default_source_id: "bench-fixture",
        sources: [
          {
            id: "bench-fixture",
            name: "Bench Fixture",
            homepage: "https://bench.test/",
            version: "1.0.0",
            capabilities: ["search", "page_list", "page_image", "online_read"],
            enabled: true,
            gallery_index_page_size: 20,
            bridge: {
              kind: "python",
              script: bridgeScript,
              python_env: ["MANGA_BRIDGE_PYTHON"],
              page_commands: true,
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) {
    webPort = await freePort();
  }
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const webBase = `http://127.0.0.1:${webPort}`;

  const api = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEV_API_PORT: String(apiPort),
      DEV_API_DATA_DIR: join(fixtureRoot, "api-data"),
      DEV_API_READER_PAGE_CACHE_DIR: join(fixtureRoot, "page-cache"),
      DEV_API_READER_SESSION_REUSE_MS: "0",
      DEV_API_READER_PREHEAT_PAGES: "3",
      DEV_API_READER_ALBUM_PREFETCH: "0",
      DEV_API_READER_LIST_PACE_MS: "10",
      SOURCE_ADAPTER_CONFIG: registryFile,
      MANGA_BRIDGE_PYTHON: process.env.MANGA_BRIDGE_PYTHON || "python",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(api);

  const webBuild = spawn(process.execPath, [nextBin, "build"], {
    cwd: join(projectRoot, "apps", "web"),
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE: apiBase,
      BACKEND_API_URL: apiBase,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const buildExit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit("timeout"), 240_000);
    webBuild.on("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  if (buildExit !== 0) {
    throw new Error(`web build failed with exit code ${buildExit}`);
  }

  const web = spawn(process.execPath, [nextBin, "start", "-p", String(webPort)], {
    cwd: join(projectRoot, "apps", "web"),
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE: apiBase,
      BACKEND_API_URL: apiBase,
      PORT: String(webPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(web);

  await waitForUrl(`${apiBase}/health`, 15_000);
  await waitForUrl(webBase, 60_000);

  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "E:\\MangaDevCache\\ms-playwright";
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(webBase, { waitUntil: "domcontentloaded", timeout: 120_000 });

    await page.locator(".task-composer .tabs button").filter({ hasText: "直链" }).click();
    const galleryInput = page.locator('label:has-text("图库 URL") input');
    await galleryInput.waitFor({ state: "visible", timeout: 30_000 });
    await galleryInput.fill("https://bench.test/gallery/1");
    await page.getByRole("button", { name: "在线阅读", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "在线漫画阅读器" });
    await dialog.waitFor({ state: "visible", timeout: 60_000 });
    await dialog.getByRole("button", { name: "连续" }).click();
    await page.waitForSelector(".reader-image-stage.scroll-mode", { timeout: 30_000 });
    await page.waitForTimeout(800);

    const metrics = await page.evaluate(async () => {
      const stage = document.querySelector(".reader-image-stage.scroll-mode");
      if (!stage) {
        throw new Error("scroll stage not found");
      }
      const figureCount = () => document.querySelectorAll(".reader-scroll-page").length;
      const samples = [];
      const sampleTargets = [100, 300, 600];
      const reached = new Set();
      const startFigures = figureCount();
      let frames = 0;
      let maxGapMs = 0;
      let jumpsToTop = 0;
      let previousScrollTop = -1;
      const startTime = performance.now();
      let lastFrame = performance.now();

      await new Promise((resolveDone) => {
        const step = () => {
          const now = performance.now();
          const gap = now - lastFrame;
          lastFrame = now;
          if (gap > maxGapMs) {
            maxGapMs = gap;
          }
          frames += 1;
          if (stage.scrollTop < stage.scrollHeight - stage.clientHeight - 10) {
            stage.scrollTop += 4000;
          }
          if (previousScrollTop >= 0 && stage.scrollTop < previousScrollTop - 500 && previousScrollTop > 20_000) {
            jumpsToTop += 1;
          }
          previousScrollTop = stage.scrollTop;
          const count = figureCount();
          for (const target of sampleTargets) {
            if (count >= target && !reached.has(target)) {
              reached.add(target);
              samples.push({ figures: target, actual: count, heapBytes: performance.memory?.usedJSHeapSize ?? null });
            }
          }
          if (count >= 750 || (now - startTime > 20_000 && frames > 60)) {
            resolveDone();
          } else {
            requestAnimationFrame(step);
          }
        };
        requestAnimationFrame(step);
      });

      const durationMs = performance.now() - startTime;
      const memory = performance.memory
        ? { usedBytes: performance.memory.usedJSHeapSize, totalBytes: performance.memory.totalJSHeapSize }
        : null;
      return {
        startFigures,
        endFigures: figureCount(),
        imgCount: document.querySelectorAll(".reader-image-stage img").length,
        frames,
        durationMs,
        avgGapMs: durationMs / Math.max(frames, 1),
        maxGapMs,
        jumpsToTop,
        samples,
        memory,
      };
    });

    console.log(JSON.stringify(metrics, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`service did not become ready at ${url}: ${lastError?.message ?? "timeout"}`);
}
