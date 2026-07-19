import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseUrl = (process.env.DEV_API_BASE || "http://127.0.0.1:18082").replace(/\/$/, "");
const projectRoot = resolve(import.meta.dirname, "..");
const dictionary = JSON.parse(await readFile(resolve(projectRoot, "apps/web/src/lib/tag-translations.json"), "utf8"));
const translation = dictionary.find((item) => item.canonical === "female:big breasts");
assert.ok(translation, "female:big breasts translation is required");

const excludedTags = [translation.canonical, translation.zh, ...(translation.aliases || [])];

async function requireJson(response) {
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

const createResponse = await fetch(`${baseUrl}/v1/tasks/search`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    source_ids: ["18comic"],
    tags: ["language:chinese", "female:big breasts"],
    excluded_tags: excludedTags,
    limit: 5,
  }),
});
const created = await requireJson(createResponse);

const deadline = Date.now() + 120_000;
let task;
while (Date.now() < deadline) {
  const response = await fetch(`${baseUrl}/v1/tasks`);
  const tasks = await requireJson(response);
  task = tasks.find((item) => item.id === created.id);
  if (task && ["completed", "failed", "canceled"].includes(task.status)) {
    break;
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
}

assert.ok(task, `task ${created.id} was not returned by the API`);
assert.equal(task.status, "completed", task.progress?.message || JSON.stringify(task));
assert.equal(task.output?.type, "search_results");
assert.ok(task.output.excluded_count >= 1, `expected at least one real 18comic result tagged ${translation.zh} to be excluded`);
assert.ok(task.payload.excluded_tags.includes(translation.canonical));
assert.ok(task.payload.excluded_tags.includes(translation.zh));
assert.ok(task.output.results.every((result) => !(result.tags || []).includes(translation.zh)));

console.log(
  JSON.stringify({
    ok: true,
    task_id: task.id,
    excluded_canonical: translation.canonical,
    excluded_zh: translation.zh,
    excluded_count: task.output.excluded_count,
    remaining_count: task.output.results.length,
  }),
);
