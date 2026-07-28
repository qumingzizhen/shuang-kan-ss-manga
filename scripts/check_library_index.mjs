import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareNaturalPageNames,
  createLibraryImageInspector,
  inspectImageBytes,
} from "../services/dev-api/library-index.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(projectRoot, ".tmp", "check-library-index");

try {
  assert.deepEqual(["10.jpg", "2.jpg", "001.jpg"].sort(compareNaturalPageNames), ["001.jpg", "2.jpg", "10.jpg"]);

  const png = Buffer.alloc(45);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(1200, 20);
  png.write("IEND", 37, "ascii");
  assert.deepEqual(inspectImageBytes(png), {
    valid: true,
    format: "png",
    width: 800,
    height: 1200,
    error: null,
  });
  assert.equal(inspectImageBytes(Buffer.from("not-an-image")).valid, false);

  await rm(fixtureRoot, { recursive: true, force: true });
  await mkdir(fixtureRoot, { recursive: true });
  const imagePath = join(fixtureRoot, "page.png");
  await writeFile(imagePath, png);
  const inspector = createLibraryImageInspector({ maximumEntries: 100 });
  const stat = { size: png.length, mtimeMs: 1 };
  assert.equal((await inspector.inspect(imagePath, stat)).valid, true);
  assert.equal((await inspector.inspect(imagePath, stat)).valid, true);
  assert.equal(inspector.size, 1, "unchanged files should reuse the validation cache");

  console.log(JSON.stringify({ ok: true, natural_sort: true, corruption_detection: true, cached: true }));
} finally {
  await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
}
