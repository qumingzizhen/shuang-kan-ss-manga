import assert from "node:assert/strict";
import { buildDiagnosticReport, redactDiagnostics } from "../services/dev-api/diagnostics.mjs";

const redacted = redactDiagnostics({
  cookie: "igneous=secret",
  nested: {
    authorization: "Bearer abc",
    message: "request failed\nCookie: ipb_member_id=secret",
  },
  safe: "visible",
});
assert.equal(redacted.cookie, "[REDACTED]");
assert.equal(redacted.nested.authorization, "[REDACTED]");
assert.equal(redacted.nested.message.includes("secret"), false);
assert.equal(redacted.safe, "visible");

const report = buildDiagnosticReport({
  tasks: [
    { id: "1", kind: "search", status: "completed", progress: { message: "done" } },
    { id: "2", kind: "gallery", status: "failed", progress: { message: "Bearer dangerous-token" } },
  ],
  sources: [{ id: "source", name: "Source", version: "1", enabled: true, capabilities: ["search"] }],
  libraryRootCount: 2,
  downloadQuota: { global_capacity: 8, global_in_use: 0, waiting: 0 },
});
assert.equal(report.tasks.total, 2);
assert.equal(report.tasks.recent_errors[0].message.includes("dangerous-token"), false);
assert.equal(report.storage.library_root_count, 2);

console.log(JSON.stringify({ ok: true, redacted: true, report: true }));
