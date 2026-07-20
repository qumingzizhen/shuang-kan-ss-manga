import assert from "node:assert/strict";
import {
  isAllowedThumbnailHost,
  isPrivateHostname,
  validateThumbnailUrl,
} from "../services/dev-api/thumbnail-policy.mjs";

const source = {
  id: "fixture",
  homepage: "https://example.org/",
  thumbnail_hosts: ["cdn.example.net"],
};

for (const host of ["localhost", "127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
  assert.equal(isPrivateHostname(host), true, `${host} should be private`);
}
assert.equal(isPrivateHostname("1.1.1.1"), false);
assert.equal(isAllowedThumbnailHost(source, "cdn.example.net"), true);
assert.equal(isAllowedThumbnailHost(source, "img.cdn.example.net"), true);
assert.equal(isAllowedThumbnailHost(source, "example.org"), true);
assert.equal(isAllowedThumbnailHost(source, "attacker.test"), false);
assert.equal(validateThumbnailUrl(source, "https://cdn.example.net/image.jpg").hostname, "cdn.example.net");
assert.throws(() => validateThumbnailUrl(source, "http://127.0.0.1/image.jpg"), /private or local/);
assert.throws(() => validateThumbnailUrl(source, "https://attacker.test/image.jpg"), /not allowed/);

console.log(JSON.stringify({ ok: true, private_host_cases: 9 }));
