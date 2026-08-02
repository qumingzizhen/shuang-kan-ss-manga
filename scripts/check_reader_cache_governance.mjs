import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-cache-governance");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "cache_fixture_bridge.py");
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
args, _ = parser.parse_known_args()

counter = os.environ.get("FIXTURE_COUNTER_FILE")
def record():
    if counter:
        with open(counter, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": args.command}) + "\\n")

if args.command == "list-pages":
    record()
    print(json.dumps({
        "source_id": "cache-fixture",
        "gallery_url": args.gallery_url,
        "title": "cache fixture",
        "tags": [],
        "page_count": 5,
        "pages": [
            {"index": index, "page_url": f"https://cache.test/page/{index}"}
            for index in range(1, 6)
        ],
    }))
elif args.command == "download-page":
    record()
    index = args.page_index or 1
    folder = Path(args.page_output).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{index:04d}.png"
    file_path.write_bytes(b"x" * 200)
    print(json.dumps({
        "source_id": "cache-fixture",
        "page_url": args.page_url,
        "storage_key": str(file_path),
        "content_type": "image/png",
        "byte_size": 200,
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
        default_source_id: "cache-fixture",
        sources: [
          {
            id: "cache-fixture",
            name: "Cache Fixture",
            homepage: "https://cache.test/",
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

  // Instance 1: TTL eviction plus ETag/304 responses.
  const ttlCounter = join(fixtureRoot, "ttl-calls.jsonl");
  const ttl = await startInstance("ttl", {
    DEV_API_READER_CACHE_TTL_MS: "300",
    DEV_API_READER_CACHE_SWEEP_INTERVAL_MS: "150",
    DEV_API_READER_CACHE_GRACE_MS: "0",
    DEV_API_READER_CACHE_MAX_BYTES: "0",
    FIXTURE_COUNTER_FILE: ttlCounter,
  });
  try {
    const session = await jsonRequest(`${ttl.baseUrl}/v1/reader/sessions`, {
      method: "POST",
      body: JSON.stringify({
        source_id: "cache-fixture",
        gallery_url: "https://cache.test/gallery/ttl",
      }),
    });
    const pageUrl = `${ttl.baseUrl}/v1/reader/sessions/${session.id}/pages/1`;
    const first = await fetch(pageUrl);
    assert.equal(first.status, 200);
    const firstEtag = first.headers.get("etag");
    assert.ok(firstEtag, "reader image responses must include an ETag");
    assert.match(String(first.headers.get("cache-control")), /max-age=604800/);

    const notModified = await fetch(pageUrl, { headers: { "if-none-match": firstEtag } });
    assert.equal(notModified.status, 304);

    await delay(1_600);
    const afterTtl = await fetch(pageUrl);
    assert.equal(afterTtl.status, 200);
    assert.equal(await bridgeCallCount(ttlCounter, "download-page"), 2, "expired page must be re-fetched");
    assert.notEqual(afterTtl.headers.get("etag"), firstEtag, "re-fetched page must get a fresh ETag");
  } finally {
    await ttl.stop();
  }

  // Instance 2: capacity eviction when the cache exceeds its byte budget.
  const capacityCounter = join(fixtureRoot, "capacity-calls.jsonl");
  const capacity = await startInstance("capacity", {
    DEV_API_READER_CACHE_TTL_MS: "0",
    DEV_API_READER_CACHE_SWEEP_INTERVAL_MS: "150",
    // Keep freshly downloaded files safe from the capacity sweep while the
    // first response is being produced, then let them age past the grace window.
    DEV_API_READER_CACHE_GRACE_MS: "250",
    DEV_API_READER_CACHE_MAX_BYTES: "150",
    FIXTURE_COUNTER_FILE: capacityCounter,
  });
  try {
    const session = await jsonRequest(`${capacity.baseUrl}/v1/reader/sessions`, {
      method: "POST",
      body: JSON.stringify({
        source_id: "cache-fixture",
        gallery_url: "https://cache.test/gallery/capacity",
      }),
    });
    const pageUrl = `${capacity.baseUrl}/v1/reader/sessions/${session.id}/pages/1`;
    const first = await fetch(pageUrl);
    assert.equal(first.status, 200);
    await delay(1_600);
    const afterCapacity = await fetch(pageUrl);
    assert.equal(afterCapacity.status, 200);
    assert.equal(await bridgeCallCount(capacityCounter, "download-page"), 2, "oversized cache must be evicted");
  } finally {
    await capacity.stop();
  }

  console.log(
    JSON.stringify({
      ok: true,
      etag_and_304: true,
      ttl_eviction: true,
      capacity_eviction: true,
    }),
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function startInstance(name, extraEnv) {
  const instanceRoot = join(fixtureRoot, name);
  await mkdir(instanceRoot, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEV_API_PORT: String(port),
      DEV_API_DATA_DIR: join(instanceRoot, "data"),
      DEV_API_READER_PAGE_CACHE_DIR: join(instanceRoot, "page-cache"),
      DEV_API_READER_SESSION_REUSE_MS: "3600000",
      DEV_API_READER_PREHEAT_PAGES: "0",
      SOURCE_ADAPTER_CONFIG: join(fixtureRoot, "sources.json"),
      MANGA_BRIDGE_PYTHON: process.env.MANGA_BRIDGE_PYTHON || "python",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return {
          baseUrl,
          stop: async () => {
            if (child.exitCode === null) {
              child.kill();
              await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(2_000)]);
            }
          },
        };
      }
    } catch {
      // The isolated child process may still be binding its listener.
    }
    await delay(50);
  }
  child.kill();
  throw new Error(`isolated dev API ${name} did not become healthy: ${stderr}`);
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
