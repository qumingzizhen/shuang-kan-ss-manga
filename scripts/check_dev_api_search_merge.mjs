import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-dev-api-search-merge");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
const sources = [
  {
    id: "fangliding",
    pageOne: [
      ["fang-1", "2026-07-28 03:45"],
      ["fang-2", "2026-07-28 03:45"],
    ],
    pageTwo: [["fang-3", "2026-07-28 03:44"]],
  },
  {
    id: "e-hentai",
    pageOne: [
      ["eh-1", "2026-07-28 03:45"],
      ["eh-older", "2026-07-28 03:43"],
    ],
    pageTwo: [["eh-2", "2026-07-28 03:42"]],
  },
  {
    id: "18comic",
    pageOne: [
      ["jm-newest", "2026-07-28 03:46"],
      ["jm-1", "2026-07-28 03:45"],
    ],
    pageTwo: [["jm-2", "2026-07-28 03:41"]],
  },
];

let child;
let stderr = "";
try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
  const registry = {
    version: "0.1.0",
    default_source_id: "fangliding",
    sources: [],
  };
  for (const source of sources) {
    const script = join(fixtureRoot, `${source.id}.py`);
    await writeFile(script, bridgeFixture(source), "utf8");
    registry.sources.push({
      id: source.id,
      name: source.id,
      homepage: `https://${source.id}.test/`,
      thumbnail_hosts: ["images.test"],
      version: "1.0.0",
      capabilities: ["search", "gallery"],
      enabled: true,
      bridge: {
        kind: "python",
        script,
        python_env: ["MANGA_BRIDGE_PYTHON"],
        page_commands: false,
      },
    });
  }

  const registryFile = join(fixtureRoot, "sources.json");
  await writeFile(registryFile, JSON.stringify(registry, null, 2), "utf8");
  const port = await freePort();
  child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEV_API_PORT: String(port),
      DEV_API_DATA_DIR: join(fixtureRoot, "data"),
      SOURCE_ADAPTER_CONFIG: registryFile,
      MANGA_BRIDGE_PYTHON: process.env.MANGA_BRIDGE_PYTHON || "python",
      DEV_API_SEARCH_MAX_PAGES: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const created = await jsonRequest(`${baseUrl}/v1/tasks/search`, {
    method: "POST",
    body: JSON.stringify({
      source_ids: sources.map((source) => source.id),
      tags: ["test"],
      limit: 20,
    }),
  });
  const firstPage = await waitForTask(baseUrl, created.id);
  assert.equal(firstPage.status, "completed", firstPage.progress?.message);
  assert.deepEqual(
    firstPage.output.results.map((result) => result.title),
    ["jm-newest", "fang-1", "eh-1", "jm-1", "fang-2", "eh-older"],
    "initial results must form one global timeline with equal-time source rotation",
  );
  assert.ok(firstPage.output.results.every((result) => result.page_count === 12));
  assert.ok(firstPage.output.results.every((result) => result.category === "Manga"));
  assert.ok(firstPage.output.results.every((result) => result.thumbnail_url));

  const fangResult = firstPage.output.results.find((result) => result.title === "fang-1");
  const detail = await jsonRequest(`${baseUrl}/v1/search-result-details`, {
    method: "POST",
    body: JSON.stringify(fangResult),
  });
  assert.equal(detail.page_count, 77, "detail endpoint should validate and return page_count");
  assert.equal(detail.rating, 4.8, "detail endpoint should preserve a valid rating");

  const secondPage = await jsonRequest(`${baseUrl}/v1/tasks/${created.id}/search-more`, {
    method: "POST",
  });
  assert.deepEqual(
    secondPage.output.results.map((result) => result.title),
    ["jm-newest", "fang-1", "eh-1", "jm-1", "fang-2", "fang-3", "eh-older", "eh-2", "jm-2"],
    "new pages from all sources must be merged and globally re-sorted",
  );
  assert.equal(secondPage.output.has_more, false);

  console.log(
    JSON.stringify({
      ok: true,
      sources: sources.length,
      first_page_results: firstPage.output.results.length,
      merged_results: secondPage.output.results.length,
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(2000),
    ]);
  }
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  if (process.exitCode && stderr) {
    console.error(stderr);
  }
}

function bridgeFixture(source) {
  return `import argparse, json
parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--tags-json")
parser.add_argument("--limit")
parser.add_argument("--search-start-page", type=int, default=1)
parser.add_argument("--max-search-pages")
parser.add_argument("--name")
parser.add_argument("--query")
parser.add_argument("--gallery-url")
args, _ = parser.parse_known_args()
source_id = ${JSON.stringify(source.id)}
pages = ${JSON.stringify({ 1: source.pageOne, 2: source.pageTwo })}
if args.command == "search":
    results = []
    for title, uploaded_at in pages.get(str(args.search_start_page), pages.get(args.search_start_page, [])):
        results.append({
            "source_id": source_id,
            "url": f"https://{source_id}.test/g/{title}",
            "title": title,
            "tags": ["safe"],
            "thumbnail_url": f"https://images.test/{title}.jpg",
            "uploaded_at": uploaded_at,
            "category": "Manga",
            "page_count": 12,
            "rating": 4.5,
        })
    print(json.dumps({"query": "test", "results": results}))
elif args.command == "gallery":
    print(json.dumps({
        "source_id": source_id,
        "url": args.gallery_url,
        "title": "detail",
        "tags": ["safe"],
        "page_count": 77,
        "rating": 4.8,
    }))
else:
    raise SystemExit("unsupported command")
`;
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
      // The child process may still be binding its listener.
    }
    await delay(50);
  }
  throw new Error(`dev API did not become healthy${stderr ? `: ${stderr}` : ""}`);
}

async function waitForTask(baseUrl, taskId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = await jsonRequest(`${baseUrl}/v1/tasks/${taskId}`);
    if (["completed", "failed", "canceled"].includes(task.status)) {
      return task;
    }
    await delay(50);
  }
  throw new Error(`task ${taskId} did not finish`);
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
