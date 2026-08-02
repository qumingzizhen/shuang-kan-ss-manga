import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-list-expansion");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
const counterFile = join(fixtureRoot, "bridge-calls.jsonl");
let child;
let stderr = "";

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "expand_fixture_bridge.py");
  await writeFile(
    bridgeScript,
    `import argparse, json, os, sys

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--gallery-url")
parser.add_argument("--max-gallery-index-pages", type=int, default=0)
parser.add_argument("--gallery-index-page", type=int)
args, _ = parser.parse_known_args()

counter = os.environ.get("FIXTURE_COUNTER_FILE")
def record():
    if counter:
        with open(counter, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": args.command, "args": sys.argv[1:]}) + "\\n")

if args.command == "list-pages":
    record()
    if "short" in (args.gallery_url or ""):
        count = 100
        if args.gallery_index_page and args.gallery_index_page >= 1:
            start = (args.gallery_index_page - 1) * 40 + 1
            end = min(40, args.gallery_index_page * 40)
            pages = [{"index": index, "page_url": f"https://expand.test/page/{index}"} for index in range(start, end + 1)] if end >= start else []
        elif args.max_gallery_index_pages and args.max_gallery_index_pages >= 1:
            pages = [{"index": index, "page_url": f"https://expand.test/page/{index}"} for index in range(1, 41)]
        else:
            pages = [{"index": index, "page_url": f"https://expand.test/page/{index}"} for index in range(1, 41)]
    else:
        count = 80
        if args.gallery_index_page and args.gallery_index_page >= 1:
            start = (args.gallery_index_page - 1) * 40 + 1
            end = min(count, args.gallery_index_page * 40)
            pages = [{"index": index, "page_url": f"https://expand.test/page/{index}"} for index in range(start, end + 1)]
        elif args.max_gallery_index_pages and args.max_gallery_index_pages >= 1:
            pages = [{"index": index, "page_url": f"https://expand.test/page/{index}"} for index in range(1, 41)]
        else:
            pages = [{"index": index, "page_url": f"https://expand.test/page/{index}"} for index in range(1, count + 1)]
    print(json.dumps({
        "source_id": "expand-fixture",
        "gallery_url": args.gallery_url,
        "title": "expand fixture",
        "tags": [],
        "page_count": count,
        "pages": pages,
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
        default_source_id: "expand-fixture",
        sources: [
          {
            id: "expand-fixture",
            name: "Expand Fixture",
            homepage: "https://expand.test/",
            version: "1.0.0",
            capabilities: ["page_list", "page_image", "online_read"],
            enabled: true,
            gallery_index_page_size: 40,
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
      DEV_API_READER_SESSION_REUSE_MS: "3600000",
      DEV_API_READER_PREHEAT_PAGES: "0",
      DEV_API_READER_LIST_PACE_MS: "120",
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

  // Background expansion completes the page list without any user navigation.
  const session = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "expand-fixture",
      gallery_url: "https://expand.test/gallery/background",
    }),
  });
  assert.equal(session.pages.total, 80);
  assert.equal(await bridgeCallCount(counterFile, "list-pages", "https://expand.test/gallery/background"), 1);

  await delay(900);
  const backgroundCalls = await bridgeCalls(counterFile, "list-pages", "https://expand.test/gallery/background");
  assert.equal(backgroundCalls.length, 2, "background expansion should fetch one more index page");
  assert.deepEqual(argValue(backgroundCalls[1], "--gallery-index-page"), "2");

  const afterBackground = await jsonRequest(`${baseUrl}/v1/reader/sessions/${session.id}/pages?offset=40&limit=1`);
  assert.equal(afterBackground.items[0].index, 41);
  assert.equal(
    await bridgeCallCount(counterFile, "list-pages", "https://expand.test/gallery/background"),
    2,
    "known pages must not trigger another bridge call",
  );

  // Deep jump before the background step: on-demand single-index fetch, then stop.
  const jumpSession = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "expand-fixture",
      gallery_url: "https://expand.test/gallery/deepjump",
    }),
  });
  const deep = await jsonRequest(`${baseUrl}/v1/reader/sessions/${jumpSession.id}/pages?offset=40&limit=1`);
  assert.equal(deep.items[0].index, 41);
  const deepCalls = await bridgeCalls(counterFile, "list-pages", "https://expand.test/gallery/deepjump");
  assert.equal(deepCalls.length, 2);
  assert.deepEqual(argValue(deepCalls[1], "--gallery-index-page"), "2");

  await delay(900);
  assert.equal(
    await bridgeCallCount(counterFile, "list-pages", "https://expand.test/gallery/deepjump"),
    2,
    "completed sessions must not keep expanding",
  );

  // Claimed page counts can exceed reality; an empty index page must stop the scheduler.
  const shortSession = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "expand-fixture",
      gallery_url: "https://expand.test/gallery/short",
    }),
  });
  assert.equal(shortSession.page_count, 100);
  await delay(1_000);
  const shortCalls = await bridgeCalls(counterFile, "list-pages", "https://expand.test/gallery/short");
  assert.equal(shortCalls.length, 2, "initial list plus one empty index page, then stop");
  assert.deepEqual(argValue(shortCalls[1], "--gallery-index-page"), "2");
  await delay(700);
  assert.equal(
    await bridgeCallCount(counterFile, "list-pages", "https://expand.test/gallery/short"),
    2,
    "empty expansion steps must not keep looping",
  );

  console.log(
    JSON.stringify({
      ok: true,
      background_expansion: true,
      deep_jump_single_index: true,
      scheduler_stops: true,
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

function argValue(call, name) {
  const args = Array.isArray(call.args) ? call.args : [];
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? String(args[index + 1]) : undefined;
}

async function bridgeCalls(counterPath, command, galleryUrl) {
  try {
    const text = await readFile(counterPath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.command === command && (!galleryUrl || entry.args?.includes("--gallery-url") && entry.args[entry.args.indexOf("--gallery-url") + 1] === galleryUrl));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function bridgeCallCount(counterPath, command, galleryUrl) {
  return (await bridgeCalls(counterPath, command, galleryUrl)).length;
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
