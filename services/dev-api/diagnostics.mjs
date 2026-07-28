const sensitiveKeyPattern = /authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key/i;
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const cookiePattern = /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi;

export function redactDiagnostics(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    return value.replace(bearerPattern, "Bearer [REDACTED]").replace(cookiePattern, "$1: [REDACTED]");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnostics(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactDiagnostics(item, seen),
    ]),
  );
}

export function buildDiagnosticReport(input) {
  const taskList = Array.isArray(input.tasks) ? input.tasks : [];
  const sourceList = Array.isArray(input.sources) ? input.sources : [];
  const statusCounts = {};
  for (const task of taskList) {
    const status = String(task?.status || "unknown");
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  return redactDiagnostics({
    generated_at: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    storage: {
      engine: "sqlite",
      library_root_count: Math.max(Number(input.libraryRootCount || 0), 0),
    },
    tasks: {
      total: taskList.length,
      status_counts: statusCounts,
      recent_errors: taskList
        .filter((task) => task?.status === "failed")
        .slice(-20)
        .map((task) => ({ id: task.id, kind: task.kind, message: task.progress?.message })),
    },
    sources: sourceList.map((source) => ({
      id: source.id,
      name: source.name,
      version: source.version,
      enabled: source.enabled,
      capabilities: source.capabilities,
      available_for_default: source.available_for_default,
      unavailable_reason: source.unavailable_reason,
    })),
    download_quota: input.downloadQuota,
  });
}
