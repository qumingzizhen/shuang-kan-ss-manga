import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-mirror-failover");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
const counterFile = join(fixtureRoot, "bridge-calls.jsonl");
let child;
let stderr = "";

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "mirror_fixture_bridge.py");
  await writeFile(
    bridgeScript,
    `import argparse, json, os, sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--gallery-url")
parser.add_argument("--page-url")
parser.add_argument("--page-index", type=int)
parser.add_argument("--page-output")
parser.add_argument("--base-url")
args, _ = parser.parse_known_args()

counter = os.environ.get("FIXTURE_COUNTER_FILE")
def record():
    if counter:
        with open(counter, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"command": args.command, "args": sys.argv[1:]}) + "\\n")

if args.command == "list-pages":
    record()
    print(json.dumps({
        "source_id": "primary-fixture",
        "gallery_url": args.gallery_url,
        "title": "mirror fixture",
        "tags": [],
        "page_count": 5,
        "pages": [
            {"index": index, "page_url": f"https://{args.gallery_url.split('/')[2]}/page/{index}"}
            for index in range(1, 6)
        ],
    }))
elif args.command == "download-page":
    record()
    host = args.gallery_url.split("/")[2]
    if host.startswith("primary") or host.startswith("solo"):
        raise SystemExit("primary source download failed for this fixture")
    index = args.page_index or 1
    folder = Path(args.page_output).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{index:04d}.png"
    file_path.write_bytes(b"mirror-bytes")
    print(json.dumps({
        "source_id": "mirror-fixture",
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
  const bridge = {
    kind: "python",
    script: bridgeScript,
    python_env: ["MANGA_BRIDGE_PYTHON"],
    page_commands: true,
  };
  await writeFile(
    registryFile,
    JSON.stringify(
      {
        version: "0.1.0",
        default_source_id: "primary-fixture",
        sources: [
          {
            id: "primary-fixture",
            name: "Primary Fixture",
            homepage: "https://primary.test/",
            version: "1.0.0",
            capabilities: ["page_list", "page_image", "online_read"],
            enabled: true,
            reader_mirror_sources: ["mirror-fixture"],
            bridge,
          },
          {
            id: "mirror-fixture",
            name: "Mirror Fixture",
            homepage: "https://mirror.test/",
            version: "1.0.0",
            capabilities: ["page_list", "page_image", "online_read"],
            enabled: true,
            reader_variants: true,
            bridge,
          },
          {
            id: "solo-fixture",
            name: "Solo Fixture",
            homepage: "https://solo.test/",
            version: "1.0.0",
            capabilities: ["page_list", "page_image", "online_read"],
            enabled: true,
            bridge,
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

  const session = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "primary-fixture",
      gallery_url: "https://primary.test/gallery/1",
    }),
  });
  const page = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "mirror-bytes");

  const downloads = await bridgeCalls(counterFile, "download-page");
  const primaryAttempts = downloads.filter((call) => call.args.includes("--gallery-url") && call.args[call.args.indexOf("--gallery-url") + 1] === "https://primary.test/gallery/1");
  assert.equal(primaryAttempts.length, 1, "primary source must be attempted first");
  const mirrorAttempts = downloads.filter((call) => call.args.includes("--page-url") && call.args[call.args.indexOf("--page-url") + 1] === "https://mirror.test/page/1");
  assert.equal(mirrorAttempts.length, 1, "mirror must receive the host-swapped page URL");
  assert.equal(mirrorAttempts[0].args.includes("--base-url"), true);
  assert.equal(mirrorAttempts[0].args[mirrorAttempts[0].args.indexOf("--base-url") + 1], "https://mirror.test/");

  const soloSession = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "solo-fixture",
      gallery_url: "https://solo.test/gallery/1",
    }),
  });
  const soloPage = await fetch(`${baseUrl}/v1/reader/sessions/${soloSession.id}/pages/1`);
  assert.equal(soloPage.status, 502, "sources without mirrors must fail as before");

  console.log(
    JSON.stringify({
      ok: true,
      primary_attempted: true,
      mirror_host_swap: true,
      no_mirror_fails_as_before: true,
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

async function bridgeCalls(counterPath, command) {
  try {
    const text = await readFile(counterPath, "utf8");
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.command === command);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
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
