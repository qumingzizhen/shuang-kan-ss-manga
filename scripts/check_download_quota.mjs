import assert from "node:assert/strict";
import {
  DownloadQuotaCanceledError,
  createDownloadQuota,
} from "../services/dev-api/download-quota.mjs";

const quota = createDownloadQuota({
  globalCapacity: 4,
  sourceCapacity: () => 2,
});

const firstA = await quota.acquire({ key: "a-1", sourceId: "a", requested: 2 });
const waitingA = quota.acquire({ key: "a-2", sourceId: "a", requested: 2 });
const firstB = await quota.acquire({ key: "b-1", sourceId: "b", requested: 2 });
assert.deepEqual(quota.stats(), {
  global_capacity: 4,
  global_in_use: 4,
  waiting: 1,
  source_in_use: { a: 2, b: 2 },
});

let secondAResolved = false;
waitingA.then(() => {
  secondAResolved = true;
});
firstB.release();
await Promise.resolve();
assert.equal(secondAResolved, false, "same-source quota must remain enforced after another source releases");
firstA.release();
const secondA = await waitingA;
assert.equal(secondA.tokens, 2);

const waitingB = quota.acquire({ key: "b-canceled", sourceId: "a", requested: 2 });
assert.equal(quota.cancel("b-canceled"), 1);
await assert.rejects(waitingB, DownloadQuotaCanceledError);
secondA.release();
assert.equal(quota.stats().global_in_use, 0, "all quota tokens must be returned");
console.log(JSON.stringify({ ok: true, no_overrun: true, no_deadlock: true, cancelable: true }));
