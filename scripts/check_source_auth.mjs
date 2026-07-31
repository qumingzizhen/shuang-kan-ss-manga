import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createSourceAuthManager } from "../services/dev-api/source-auth.mjs";
import {
  loadSourceAdapterRegistry,
  materializeSourceAuthSpecs,
  publicSourceDescriptors,
} from "../services/dev-api/source-registry.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const registry = loadSourceAdapterRegistry(join(projectRoot, "config", "source-adapters.json"));
const authDir = await mkdtemp(join(tmpdir(), "manga-source-auth-"));
const configuredSpecs = materializeSourceAuthSpecs(registry.sources, authDir);
const publicDescriptors = publicSourceDescriptors(registry.sources);
const fanglidingDescriptor = publicDescriptors.find(
  (source) => source.id === "fangliding",
);
const comic18Descriptor = publicDescriptors.find((source) => source.id === "18comic");
assert.equal(configuredSpecs.fangliding, undefined);
assert.equal(fanglidingDescriptor?.auth, null);
assert.equal(fanglidingDescriptor?.available_for_default, true);
assert.equal(configuredSpecs["18comic"].cookieEnv, "COMIC18_COOKIE_FILE");
assert.equal(configuredSpecs["18comic"].headersEnv, "COMIC18_HEADERS_FILE");
assert.deepEqual(comic18Descriptor?.auth?.fields, ["cookie", "headers"]);

const environment = {};
const cookieFile = join(authDir, "fixture.cookies.txt");
const headersFile = join(authDir, "fixture.headers.txt");
const specs = {
  fixture: {
    cookieEnv: "FIXTURE_COOKIE_FILE",
    headersEnv: "FIXTURE_HEADERS_FILE",
    cookieFile,
    headersFile,
  },
};
const manager = createSourceAuthManager({
  authDir,
  specs,
  environment,
  describeSources: () => [
    {
      id: "fixture",
      available_for_default: Boolean(environment.FIXTURE_COOKIE_FILE),
      unavailable_reason: environment.FIXTURE_COOKIE_FILE ? null : "missing fixture auth",
    },
  ],
});

try {
  assert.equal((await manager.status("fixture")).configured, false);
  const saved = await manager.save("fixture", {
    cookie: "Cookie: session=one; token=two",
    headers: "User-Agent: fixture\nCookie: session=one\n# ignored",
    headers_json: { Accept: "image/avif", "Bad Header": "ignored" },
  });
  assert.equal(saved.configured, true);
  assert.equal(environment.FIXTURE_COOKIE_FILE, cookieFile);
  assert.equal(environment.FIXTURE_HEADERS_FILE, headersFile);
  assert.equal((await readFile(cookieFile, "utf8")).trim(), "session=one; token=two");
  assert.equal((await readFile(headersFile, "utf8")).trim(), "User-Agent: fixture\nAccept: image/avif");
  assert.equal((await readdir(authDir)).some((name) => name.endsWith(".tmp")), false);
  assert.equal(manager.bridgeEnv({ id: "fixture" }).PYTHONIOENCODING, "utf-8");

  const removed = await manager.remove("fixture");
  assert.equal(removed.configured, false);
  assert.equal(environment.FIXTURE_COOKIE_FILE, undefined);
  assert.equal(environment.FIXTURE_HEADERS_FILE, undefined);
  await assert.rejects(() => manager.save("fixture", {}), /cookie or headers is required/);
  await assert.rejects(() => manager.status("unknown"), /not configurable/);
} finally {
  await rm(authDir, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    ok: true,
    atomic_auth_files: true,
    managed_env: true,
    fangliding_public: true,
    comic18_optional_auth: true,
  }),
);
