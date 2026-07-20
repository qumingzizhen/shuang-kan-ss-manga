import assert from "node:assert/strict";
import { createAsyncLimiter, createSingleFlight } from "../services/dev-api/async-pool.mjs";

const limit = createAsyncLimiter(3);
let active = 0;
let maxActive = 0;
const results = await Promise.all(
  Array.from({ length: 7 }, (_, index) =>
    limit(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return index;
    }),
  ),
);
assert.equal(maxActive, 3);
assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6]);

const singleFlight = createSingleFlight();
let executions = 0;
const operation = () =>
  singleFlight.run("same-key", async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return "value";
  });
assert.deepEqual(await Promise.all([operation(), operation(), operation()]), ["value", "value", "value"]);
assert.equal(executions, 1);
assert.equal(singleFlight.has("same-key"), false);

console.log(JSON.stringify({ ok: true, max_active: maxActive, single_flight_executions: executions }));
