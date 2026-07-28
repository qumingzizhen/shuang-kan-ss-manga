export class DownloadQuotaCanceledError extends Error {
  constructor(message = "download quota request canceled") {
    super(message);
    this.name = "DownloadQuotaCanceledError";
  }
}

export function createDownloadQuota(options = {}) {
  return new DownloadQuota(options);
}

class DownloadQuota {
  constructor(options) {
    this.globalCapacity = positiveInteger(options.globalCapacity, 8, 64);
    this.sourceCapacity = options.sourceCapacity || (() => 4);
    this.globalInUse = 0;
    this.sourceInUse = new Map();
    this.waiters = [];
  }

  acquire(options = {}) {
    const key = String(options.key || "").trim();
    const sourceId = String(options.sourceId || "").trim();
    if (!key || !sourceId) {
      return Promise.reject(new Error("download quota requires key and sourceId"));
    }
    const sourceCapacity = this.capacityForSource(sourceId);
    const tokens = Math.min(
      positiveInteger(options.requested, sourceCapacity, this.globalCapacity),
      sourceCapacity,
      this.globalCapacity,
    );

    return new Promise((resolve, reject) => {
      this.waiters.push({ key, sourceId, tokens, resolve, reject });
      this.drain();
    });
  }

  cancel(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) {
      return 0;
    }
    let canceled = 0;
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.key !== normalizedKey) {
        return true;
      }
      canceled += 1;
      waiter.reject(new DownloadQuotaCanceledError());
      return false;
    });
    return canceled;
  }

  stats() {
    return {
      global_capacity: this.globalCapacity,
      global_in_use: this.globalInUse,
      waiting: this.waiters.length,
      source_in_use: Object.fromEntries(this.sourceInUse),
    };
  }

  capacityForSource(sourceId) {
    const configured =
      typeof this.sourceCapacity === "function" ? this.sourceCapacity(sourceId) : this.sourceCapacity;
    return positiveInteger(configured, Math.min(4, this.globalCapacity), this.globalCapacity);
  }

  drain() {
    let granted = true;
    while (granted) {
      granted = false;
      for (let index = 0; index < this.waiters.length; index += 1) {
        const waiter = this.waiters[index];
        const sourceUsed = this.sourceInUse.get(waiter.sourceId) || 0;
        const sourceCapacity = this.capacityForSource(waiter.sourceId);
        if (
          this.globalInUse + waiter.tokens > this.globalCapacity ||
          sourceUsed + waiter.tokens > sourceCapacity
        ) {
          continue;
        }
        this.waiters.splice(index, 1);
        this.globalInUse += waiter.tokens;
        this.sourceInUse.set(waiter.sourceId, sourceUsed + waiter.tokens);
        waiter.resolve(this.createPermit(waiter.sourceId, waiter.tokens));
        granted = true;
        break;
      }
    }
  }

  createPermit(sourceId, tokens) {
    let released = false;
    return {
      tokens,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.globalInUse = Math.max(0, this.globalInUse - tokens);
        const remaining = Math.max(0, (this.sourceInUse.get(sourceId) || 0) - tokens);
        if (remaining) {
          this.sourceInUse.set(sourceId, remaining);
        } else {
          this.sourceInUse.delete(sourceId);
        }
        this.drain();
      },
    };
  }
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), maximum);
}
