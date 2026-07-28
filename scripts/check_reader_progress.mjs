import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-progress");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
let child;
let stderr = "";

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
  const bridgeScript = join(fixtureRoot, "reader_bridge.py");
  await writeFile(
    bridgeScript,
    `import argparse, json
parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--gallery-url")
args, _ = parser.parse_known_args()
if args.command == "list-pages":
    print(json.dumps({
        "source_id": "reader-fixture",
        "gallery_url": args.gallery_url,
        "title": "reader fixture",
        "tags": ["language:chinese"],
        "page_count": 5,
        "pages": [
            {"index": index, "page_url": f"https://reader.test/page/{index}"}
            for index in range(1, 6)
        ],
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
        default_source_id: "reader-fixture",
        sources: [
          {
            id: "reader-fixture",
            name: "Reader Fixture",
            homepage: "https://reader.test/",
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
      source_id: "reader-fixture",
      gallery_url: "https://reader.test/gallery/1",
    }),
  });

  const legacy = await jsonRequest(`${baseUrl}/v1/reader/sessions/${session.id}/progress`, {
    method: "PATCH",
    body: JSON.stringify({ last_page: 2 }),
  });
  assert.equal(legacy.last_page, 2);
  assert.equal(legacy.reading_mode, "single");
  assert.equal(legacy.reading_direction, "ltr");

  const extended = await jsonRequest(`${baseUrl}/v1/reader/sessions/${session.id}/progress`, {
    method: "PATCH",
    body: JSON.stringify({
      last_page: 4,
      reading_mode: "scroll",
      reading_direction: "rtl",
      scroll_offset: 640.5,
      scroll_ratio: 0.625,
    }),
  });
  assert.equal(extended.last_page, 4);
  assert.equal(extended.reading_mode, "scroll");
  assert.equal(extended.reading_direction, "rtl");
  assert.equal(extended.scroll_offset, 640.5);
  assert.equal(extended.scroll_ratio, 0.625);

  const invalidResponse = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/progress`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ last_page: 3, reading_mode: "unsupported" }),
  });
  assert.equal(invalidResponse.status, 400);

  console.log(JSON.stringify({ ok: true, legacy_compatible: true, mode_progress: true, validation: true }));
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
