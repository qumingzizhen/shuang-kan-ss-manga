import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-reader-variants");
const serverScript = join(projectRoot, "services", "dev-api", "server.mjs");
const counterFile = join(fixtureRoot, "bridge-calls.jsonl");
const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAIAAABrW6giAAAAFElEQVR4nGPkEpFjgAEmBiRADgcAE94ASFNNN1QAAAAASUVORK5CYII=";
let child;
let stderr = "";

try {
  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });

  const bridgeScript = join(fixtureRoot, "variant_fixture_bridge.py");
  await writeFile(
    bridgeScript,
    `import argparse, json, os, sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.getcwd(), "scripts"))
from PIL import Image
from source_bridge_core import parse_variant_specs, write_image_variants

parser = argparse.ArgumentParser()
parser.add_argument("command")
parser.add_argument("--gallery-url")
parser.add_argument("--page-url")
parser.add_argument("--page-index", type=int)
parser.add_argument("--page-output")
parser.add_argument("--max-gallery-index-pages", type=int, default=0)
parser.add_argument("--variant-specs")
args, _ = parser.parse_known_args()

counter_file = os.environ.get("FIXTURE_COUNTER_FILE")
def record(payload):
    if counter_file:
        with open(counter_file, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload) + "\\n")

if args.command == "list-pages":
    record({"command": "list-pages", "gallery_url": args.gallery_url})
    print(json.dumps({
        "source_id": "variant-fixture",
        "gallery_url": args.gallery_url,
        "title": "variant fixture",
        "tags": ["language:chinese"],
        "page_count": 40,
        "pages": [
            {"index": index, "page_url": f"https://reader.test/gallery/{index}"}
            for index in range(1, 41)
        ],
    }))
elif args.command == "download-page":
    index = args.page_index or 1
    folder = Path(args.page_output).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    file_path = folder / f"{index:04d}.png"
    Image.new("RGB", (4, 6), (10, 20, 30)).save(file_path)
    record({
        "command": "download-page",
        "has_variant_specs": bool(args.variant_specs),
        "gallery_url": args.gallery_url,
    })
    report = {
        "source_id": "variant-fixture",
        "page_url": args.page_url,
        "storage_key": str(file_path),
        "content_type": "image/png",
        "byte_size": file_path.stat().st_size,
    }
    if args.variant_specs:
        variants, variant_errors = write_image_variants(
            file_path,
            parse_variant_specs(args.variant_specs),
            folder,
            index,
        )
        report["variants"] = variants
        report["variant_errors"] = variant_errors
    print(json.dumps(report))
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
        default_source_id: "variant-fixture",
        sources: [
          {
            id: "variant-fixture",
            name: "Variant Fixture",
            homepage: "https://variant.test/",
            version: "1.0.0",
            capabilities: ["page_list", "page_image", "online_read"],
            enabled: true,
            gallery_index_page_size: 40,
            reader_variants: true,
            bridge: {
              kind: "python",
              script: bridgeScript,
              python_env: ["MANGA_BRIDGE_PYTHON"],
              page_commands: true,
            },
          },
          {
            id: "plain-fixture",
            name: "Plain Fixture",
            homepage: "https://plain.test/",
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
  const cacheDir = join(fixtureRoot, "page-cache");
  child = spawn(process.execPath, [serverScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEV_API_PORT: String(port),
      DEV_API_DATA_DIR: join(fixtureRoot, "data"),
      DEV_API_READER_PAGE_CACHE_DIR: cacheDir,
      DEV_API_READER_SESSION_REUSE_MS: "3600000",
      DEV_API_READER_PREHEAT_PAGES: "0",
      DEV_API_READER_VARIANT_CONCURRENCY: "2",
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

  // Fresh download path: the bridge receives variant specs and serves variants.
  const session = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "variant-fixture",
      gallery_url: "https://variant.test/gallery/a",
    }),
  });
  assert.equal(session.pages.total, 40);

  const original = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1`);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("content-type"), "image/png");
  assert.ok((await original.text()).length > 0);

  const downloads = await bridgeCalls(counterFile, "download-page");
  assert.ok(downloads.some((call) => call.has_variant_specs === true), "variant source must receive --variant-specs");

  const display = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1?variant=display`);
  assert.equal(display.status, 200);
  assert.equal(display.headers.get("content-type"), "image/webp");
  assert.ok((await display.text()).length > 0);

  const blur = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1?variant=blur`);
  assert.equal(blur.status, 200);
  assert.equal(blur.headers.get("content-type"), "image/webp");

  const unknownVariant = await fetch(`${baseUrl}/v1/reader/sessions/${session.id}/pages/1?variant=weird`);
  assert.equal(unknownVariant.status, 200);
  assert.equal(unknownVariant.headers.get("content-type"), "image/png");

  const resumed = await jsonRequest(`${baseUrl}/v1/reader/sessions/${session.id}`);
  assert.equal(resumed.pages.items[0].width, 4);
  assert.equal(resumed.pages.items[0].height, 6);

  // Backfill path: a pre-seeded original gets variants generated on demand.
  const backfillGallery = "https://variant.test/gallery/backfill";
  const backfillSessionId = readerSessionId("variant-fixture", backfillGallery);
  const backfillCacheRoot = join(cacheDir, "variant-fixture", backfillSessionId);
  await mkdir(backfillCacheRoot, { recursive: true });
  await writeFile(join(backfillCacheRoot, "0001.png"), Buffer.from(tinyPngBase64, "base64"));

  await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "variant-fixture",
      gallery_url: backfillGallery,
    }),
  });
  const beforeBackfill = await fetch(`${baseUrl}/v1/reader/sessions/${backfillSessionId}/pages/1?variant=display`);
  assert.equal(beforeBackfill.status, 200);
  assert.equal(beforeBackfill.headers.get("content-type"), "image/png");

  let backfilled = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = await fetch(`${baseUrl}/v1/reader/sessions/${backfillSessionId}/pages/1?variant=display`);
    if (candidate.headers.get("content-type") === "image/webp") {
      backfilled = candidate;
      break;
    }
    await delay(200);
  }
  assert.ok(backfilled, "background variant backfill should produce a display variant");

  // Plain source: no variant specs, and variant requests fall back to the original.
  const plainSession = await jsonRequest(`${baseUrl}/v1/reader/sessions`, {
    method: "POST",
    body: JSON.stringify({
      source_id: "plain-fixture",
      gallery_url: "https://plain.test/gallery/c",
    }),
  });
  const plainOriginal = await fetch(`${baseUrl}/v1/reader/sessions/${plainSession.id}/pages/1`);
  assert.equal(plainOriginal.status, 200);
  assert.equal(plainOriginal.headers.get("content-type"), "image/png");
  const plainDownloads = await bridgeCalls(counterFile, "download-page");
  assert.ok(plainDownloads.some((call) => call.gallery_url === "https://plain.test/gallery/c" && call.has_variant_specs === false));
  const plainVariant = await fetch(`${baseUrl}/v1/reader/sessions/${plainSession.id}/pages/1?variant=display`);
  assert.equal(plainVariant.status, 200);
  assert.equal(plainVariant.headers.get("content-type"), "image/png");

  console.log(
    JSON.stringify({
      ok: true,
      bridge_variant_specs: true,
      variant_serving: true,
      dimensions_reported: true,
      background_backfill: true,
      plain_source_compat: true,
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

function readerSessionId(sourceId, galleryUrl) {
  return createHash("sha256").update(`${sourceId}\0${galleryUrl}`).digest("base64url");
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
