import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-album-prefetch");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "prefetch_fixture_bridge.py");
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
            handle.write(json.dumps({"command": args.command, "page_index": args.page_index}) + "\\n")

if args.command == "list-pages":
    record()
    print(json.dumps({
        "source_id": "prefetch-fixture",
        "gallery_url": args.gallery_url,
        "title": "prefetch fixture",
        "tags": [],
        "page_count": 5,
        "pages": [
            {"index": index, "page_url": f"https://prefetch.test/page/{index}"}
            for index in range(1, 6)
        ],
    }))
elif args.command == "download-page":
    record()
    index = args.page_index or 1
    folder = Path(args.page_output).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{index:04d}.png"
    file_path.write_bytes(b"prefetch-fixture")
    print(json.dumps({
        "source_id": "prefetch-fixture",
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
        default_source_id: "prefetch-fixture",
        sources: [
          {
            id: "prefetch-fixture",
            name: "Prefetch Fixture",
            homepage: "https://prefetch.test/",
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

  // Enabled: the whole album is fetched into the disk cache at a polite pace.
  const enabledCounter = join(fixtureRoot, "enabled-calls.jsonl");
  const enabled = await startInstance("enabled", {
    DEV_API_READER_ALBUM_PREFETCH: "1",
    DEV_API_READER_ALBUM_PREFETCH_PACE_MS: "60",
    FIXTURE_COUNTER_FILE: enabledCounter,
  });
  try {
    const session = await jsonRequest(`${enabled.baseUrl}/v1/reader/sessions`, {
      method: "POST",
      body: JSON.stringify({
        source_id: "prefetch-fixture",
        gallery_url: "https://prefetch.test/gallery/enabled",
      }),
    });
    assert.equal(session.page_count, 5);
    await delay(1_500);
    assert.equal(await bridgeCallCount(enabledCounter, "download-page"), 5, "whole album should be prefetched");

    const page3 = await fetch(`${enabled.baseUrl}/v1/reader/sessions/${session.id}/pages/3`);
    assert.equal(page3.status, 200);
    assert.equal(await bridgeCallCount(enabledCounter, "download-page"), 5, "prefetched pages must come from cache");
  } finally {
    await enabled.stop();
  }

  // Disabled: no background downloads happen at all.
  const disabledCounter = join(fixtureRoot, "disabled-calls.jsonl");
  const disabled = await startInstance("disabled", {
    DEV_API_READER_ALBUM_PREFETCH: "0",
    FIXTURE_COUNTER_FILE: disabledCounter,
  });
  try {
    await jsonRequest(`${disabled.baseUrl}/v1/reader/sessions`, {
      method: "POST",
      body: JSON.stringify({
        source_id: "prefetch-fixture",
        gallery_url: "https://prefetch.test/gallery/disabled",
      }),
    });
    await delay(800);
    assert.equal(await bridgeCallCount(disabledCounter, "download-page"), 0);
  } finally {
    await disabled.stop();
  }

  console.log(
    JSON.stringify({
      ok: true,
      album_prefetch: true,
      cache_hit: true,
      can_disable: true,
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
