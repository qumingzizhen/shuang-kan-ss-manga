export const BRIDGE_ERROR_PREFIX = "__COMIC_PLATFORM_ERROR__";

export class BridgeProcessError extends Error {
  constructor(payload, exitCode) {
    super(String(payload?.message || `bridge exited with code ${exitCode}`));
    this.name = "BridgeProcessError";
    this.bridgeCode = String(payload?.code || "execution_failed");
    this.retryable = Boolean(payload?.retryable);
    this.retryAfterMs = finiteNonNegative(payload?.retry_after_ms);
    this.sourceId = payload?.source_id ? String(payload.source_id) : null;
    this.exitCode = exitCode;
  }
}

export function bridgeErrorFromOutput(output, exitCode) {
  const text = String(output || "").trim();
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(BRIDGE_ERROR_PREFIX)) continue;
    try {
      return new BridgeProcessError(JSON.parse(trimmed.slice(BRIDGE_ERROR_PREFIX.length)), exitCode);
    } catch {
      // Preserve the original output when an older or malformed bridge emits the prefix.
    }
  }
  return new BridgeProcessError({ code: "execution_failed", message: text }, exitCode);
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
