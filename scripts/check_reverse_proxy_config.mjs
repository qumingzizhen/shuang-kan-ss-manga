import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (relativePath) => readFileSync(resolve(projectRoot, relativePath), "utf8");

const nginx = read("infra/nginx/manga-platform.conf.template");
for (const required of [
  "location /v1/",
  "proxy_pass ${BACKEND_API_URL};",
  "proxy_request_buffering off;",
  "proxy_buffering off;",
  "proxy_read_timeout 900s;",
  "error_page 502 504 = @backend_unavailable;",
  "return 502 '{\"error\":",
  "proxy_pass ${FRONTEND_APP_URL};",
]) {
  assert.ok(nginx.includes(required), `Nginx template is missing: ${required}`);
}
assert.ok(!nginx.includes("Access-Control-Allow-Origin"), "same-origin gateway must not add CORS headers");

const nextConfig = read("apps/web/next.config.ts");
assert.ok(nextConfig.includes("NEXT_PUBLIC_API_BASE: \"\""), "browser API base must stay same-origin");
assert.ok(nextConfig.includes("return [apiRewrite]"), "Next.js must register the complete /v1 rewrite");

for (const envFile of [".env.example", "apps/web/.env.example"]) {
  const env = read(envFile);
  assert.match(env, /^BACKEND_API_URL=http:\/\/127\.0\.0\.1:8080$/m, `${envFile} is missing BACKEND_API_URL`);
  assert.match(env, /^BACKEND_PROXY_TIMEOUT_MS=900000$/m, `${envFile} is missing the proxy timeout`);
}

const devScript = read("scripts/dev.ps1");
assert.ok(devScript.includes("$env:BACKEND_API_URL = $apiUrl"), "local startup must pass its selected API port to Next.js");
assert.ok(devScript.includes('$env:NEXT_PUBLIC_API_BASE = ""'), "local browser requests must remain same-origin");

const devApi = read("services/dev-api/server.mjs");
assert.ok(devApi.includes("process.env.DEV_API_BIND_HOST"), "development API must expose an explicit bind-host setting");
assert.ok(devApi.includes("server.listen(port, bindHost"), "development API must use the validated bind-host setting");

console.log("reverse proxy configuration check passed");
