import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-first-page");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
const counterFile = join(fixtureRoot, "bridge-calls.jsonl");
let child;
let stderr = "";

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "reader_first_page_bridge.py");
  await writeFile(
    bridgeScript,
    `import argparse, json, os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--gallery-url")
parser.add_argument("--page-url")
parser.add_argument("--page-index", type=int)
parser.add_argument("--page-output")
parser.add_argument("--max-gallery-index-pages", type=int, default=0)
args, _ = parser.parse_known_args()

counter_file = os.environ.get("FIXTURE_COUNTER_FILE")
def record(command):
    if counter_file:
        with open(counter_file, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": command}) + "\\n")

if args.command == "list-pages":
    record("list-pages")
    count = 40
    pages_per_index = 20
    cap = max(args.max_gallery_index_pages or 0, 0)
    max_index = cap if cap > 0 else (count + pages_per_index - 1) // pages_per_index
    visible = min(count, max_index * pages_per_index)
    print(json.dumps({
        "source_id": "reader-first-page-fixture",
        "gallery_url": args.gallery_url,
        "title": "reader first page fixture",
        "tags": ["language:chinese"],
        "page_count": count,
        "pages": [
            {"index": index, "page_url": f"https://reader.test/gallery/1/page/{index}"}
            for index in range(1, visible + 1)
        ],
    }))
elif args.command == "download-page":
    record("download-page")
    index = args.page_index or 1
    folder = Path(args.page_output).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{index:04d}.png"
    body = b"fixture-image-bytes"
    file_path.write_bytes(body)
    print(json.dumps({
        "source_id": "reader-first-page-fixture",
        "page_url": args.page_url,
        "storage_key": str(file_path),
        "content_type": "image/png",
        "byte_size": len(body),
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
        default_source_id: "reader-first-page-fixture",
        sources: [
          {
            id: "reader-first-page-fixture",
            name: "Reader First Page Fixture",
            homepage: "https://reader.test/",
            version: "1.0.0",
            capabilities: ["page_list", "page_image", "online_read"],
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
      SOURCE_ADAPTER_CONFIG: registryFile,
      FIXTURE_COUNTER_FILE: counterFile,
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
  const sessionPayload = {
    source_id: "reader-first-page-fixture",
    gallery_url: "https://reader.test/gallery/1",
  };

  const session = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify(sessionPayload),
  });
  assert.equal(session.page_count, 40);
  assert.equal(session.pages.total, 40);
  assert.equal(session.pages.items.length, 20);
  assert.equal(session.pages.items[0].index, 1);
  assert.equal(await bridgeCallCount(counterFile, "list-pages"), 1);

  const expanded = await jsonRequest(`${baseUrl}/v1/reader/sessions/${session.id}/pages?offset=20&limit=1`);
  assert.equal(expanded.total, 40);
  assert.equal(expanded.items.length, 1);
  assert.equal(expanded.items[0].index, 21);
  assert.equal(await bridgeCallCount(counterFile, "list-pages"), 2);

  const page21 = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/21`);
  assert.equal(page21.status, 200);
  assert.equal(await page21.text(), "fixture-image-bytes");
  assert.equal(await bridgeCallCount(counterFile, "download-page"), 1);

  const page21Cached = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/21`);
  assert.equal(page21Cached.status, 200);
  assert.equal(await bridgeCallCount(counterFile, "download-page"), 1);

  const resumed = await jsonRequest(`${baseUrl}/v1/reader/sessions/${session.id}`);
  assert.equal(resumed.page_count, 40);
  assert.equal(resumed.pages.total, 40);
  assert.equal(resumed.pages.items.length, 24);
  assert.equal(resumed.pages.items[20].index, 21);

  const reused = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify(sessionPayload),
  });
  assert.equal(reused.pages.total, 40);
  assert.equal(reused.pages.items.length, 24);
  assert.equal(await bridgeCallCount(counterFile, "list-pages"), 2);

  const page1 = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1`);
  assert.equal(page1.status, 200);
  assert.equal(await bridgeCallCount(counterFile, "download-page"), 2);

  console.log(
    JSON.stringify({
      ok: true,
      capped_initial_list: true,
      lazy_page_expansion: true,
      session_reuse_without_relist: true,
      page_image_cache: true,
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

async function bridgeCallCount(counterPath, command) {
  try {
    const text = await readFile(counterPath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.command === command).length;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
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
