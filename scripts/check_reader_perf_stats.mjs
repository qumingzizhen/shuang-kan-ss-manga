import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-perf-stats");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
let child;
let stderr = "";

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "perf_fixture_bridge.py");
  await writeFile(
    bridgeScript,
    `import argparse, json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--gallery-url")
parser.add_argument("--page-url")
parser.add_argument("--page-index", type=int)
parser.add_argument("--page-output")
args, _ = parser.parse_known_args()

if args.command == "list-pages":
    print(json.dumps({
        "source_id": "perf-fixture",
        "gallery_url": args.gallery_url,
        "title": "perf fixture",
        "tags": [],
        "page_count": 5,
        "pages": [
            {"index": index, "page_url": f"https://perf.test/page/{index}"}
            for index in range(1, 6)
        ],
    }))
elif args.command == "download-page":
    index = args.page_index or 1
    folder = Path(args.page_output).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{index:04d}.png"
    file_path.write_bytes(b"perf-fixture")
    print(json.dumps({
        "source_id": "perf-fixture",
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
        default_source_id: "perf-fixture",
        sources: [
          {
            id: "perf-fixture",
            name: "Perf Fixture",
            homepage: "https://perf.test/",
            version: "1.0.0",
            capabilities: ["page_list", "page_image", "online_read"],
            enabled: true,
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

  const port = await freePort();
  child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEV_API_PORT: String(port),
      DEV_API_DATA_DIR: join(fixtureRoot, "data"),
      DEV_API_READER_PAGE_CACHE_DIR: join(fixtureRoot, "page-cache"),
      DEV_API_READER_SESSION_REUSE_MS: "3600000",
      DEV_API_READER_PREHEAT_PAGES: "0",
      DEV_API_READER_ALBUM_PREFETCH: "0",
      SOURCE_ADAPTER_CONFIG: registryFile,
      MANGA_BRIDGE_PYTHON: process.env.MANGA_BRIDGE_PYTHON || "python",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const session = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "perf-fixture",
      gallery_url: "https://perf.test/gallery/1",
    }),
  });
  const first = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1`);
  assert.equal(first.status, 200);
  const cached = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1`);
  assert.equal(cached.status, 200);

  const diagnostics = await jsonRequest(`${baseUrl}/v1/diagnostics`);
  assert.ok(diagnostics.performance, "diagnostics must include performance stats");
  assert.ok(diagnostics.performance.reader_cache.misses >= 1, "page fetch must count a cache miss");
  assert.ok(diagnostics.performance.reader_cache.hits >= 1, "second fetch must count a cache hit");
  assert.ok(diagnostics.performance.reader_fetch.calls >= 1, "reader page fetch must be timed");
  assert.ok(diagnostics.performance.reader_fetch.maxMs >= 0);
  assert.ok(Array.isArray(diagnostics.performance.bridge), "bridge stats must be an array");
  const sourceStats = diagnostics.performance.bridge.find((entry) => entry.source_id === "perf-fixture");
  assert.ok(sourceStats, "bridge stats must include the fixture source");
  assert.ok(sourceStats.calls >= 2, "list-pages and download-page must both be recorded");
  assert.ok(sourceStats.ok >= 2);
  assert.equal(sourceStats.lastError, null);
  assert.ok(sourceStats.maxMs >= 0);
  assert.ok(diagnostics.performance.reader_cache_sweep.runs >= 1, "startup cache sweep must be recorded");

  console.log(
    JSON.stringify({
      ok: true,
      cache_hits_recorded: true,
      cache_misses_recorded: true,
      bridge_timing_recorded: true,
      fetch_timing_recorded: true,
      sweep_recorded: true,
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(2_000)]);
  }
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  if (process.exitCode && stderr) {
    console.error(stderr);
  }
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

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // The isolated child process may still be binding its listener.
    }
    await delay(50);
  }
  throw new Error(`isolated dev API did not become healthy${stderr ? `: ${stderr}` : ""}`);
}

async function jsonRequest(url, init) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await response.json();
  assert.equal(response.ok, true, `${response.status} ${JSON.stringify(body)}`);
  return body;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
