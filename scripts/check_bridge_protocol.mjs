import assert from "node:assert/strict";
import { BridgeProcessError, bridgeErrorFromOutput } from "../services/dev-api/bridge-protocol.mjs";

const rateLimited = bridgeErrorFromOutput(
  'diagnostic\n__COMIC_PLATFORM_ERROR__{"code":"rate_limited","message":"slow down","retryable":true,"retry_after_ms":30000,"source_id":"fixture"}',
  1,
);
assert.ok(rateLimited instanceof BridgeProcessError);
assert.equal(rateLimited.bridgeCode, "rate_limited");
assert.equal(rateLimited.retryable, true);
assert.equal(rateLimited.retryAfterMs, 30000);
assert.equal(rateLimited.sourceId, "fixture");
assert.equal(rateLimited.exitCode, 1);

const legacy = bridgeErrorFromOutput("legacy bridge failure", 2);
assert.equal(legacy.bridgeCode, "execution_failed");
assert.equal(legacy.retryable, false);
assert.equal(legacy.message, "legacy bridge failure");

console.log(JSON.stringify({ ok: true, structured: rateLimited.bridgeCode, legacy: legacy.bridgeCode }));
