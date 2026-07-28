export type ReaderPreloadOutcome = "loaded" | "failed" | "canceled";

export type ReaderPreloadHandle = {
  promise: Promise<ReaderPreloadOutcome>;
  cancel: () => void;
};

export type ReaderPreloadLoader = (url: string) => ReaderPreloadHandle;

type QueueEntry = {
  key: string;
  url: string;
  promise: Promise<ReaderPreloadOutcome>;
  resolve: (outcome: ReaderPreloadOutcome) => void;
  handle?: ReaderPreloadHandle;
  canceled: boolean;
};

/**
 * A small bounded queue for speculative reader image requests.
 *
 * Switching pages cancels obsolete entries as a group. The queue owns only
 * speculative requests; visible <img> elements keep their normal browser
 * lifecycle so cancellation can never blank the page currently being read.
 */
export class ReaderPreloadQueue {
  readonly #limit: number;
  readonly #loader: ReaderPreloadLoader;
  readonly #pending: QueueEntry[] = [];
  readonly #entries = new Map<string, QueueEntry>();
  #active = 0;

  constructor(loader: ReaderPreloadLoader, concurrency = 3) {
    this.#loader = loader;
    this.#limit = Math.min(Math.max(Math.floor(concurrency) || 1, 1), 8);
  }

  enqueue(key: string, url: string): Promise<ReaderPreloadOutcome> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return Promise.resolve("canceled");
    }

    const existing = this.#entries.get(normalizedKey);
    if (existing) {
      return existing.promise;
    }

    let resolve: (outcome: ReaderPreloadOutcome) => void = () => undefined;
    const promise = new Promise<ReaderPreloadOutcome>((done) => {
      resolve = done;
    });
    const entry: QueueEntry = { key: normalizedKey, url, promise, resolve, canceled: false };
    this.#entries.set(normalizedKey, entry);
    this.#pending.push(entry);
    this.#drain();
    return promise;
  }

  cancelExcept(keys: Iterable<string>) {
    const retained = new Set(keys);
    for (const [key, entry] of this.#entries) {
      if (retained.has(key)) {
        continue;
      }
      entry.canceled = true;
      entry.handle?.cancel();
      if (!entry.handle) {
        entry.resolve("canceled");
        this.#entries.delete(key);
      }
    }
  }

  cancelAll() {
    this.cancelExcept([]);
  }

  get stats() {
    return { active: this.#active, queued: this.#pending.filter((entry) => !entry.canceled).length };
  }

  #drain() {
    while (this.#active < this.#limit) {
      const entry = this.#pending.shift();
      if (!entry) {
        return;
      }
      if (entry.canceled) {
        continue;
      }

      this.#active += 1;
      const handle = this.#loader(entry.url);
      entry.handle = handle;
      handle.promise
        .then((outcome) => entry.resolve(entry.canceled ? "canceled" : outcome))
        .catch(() => entry.resolve(entry.canceled ? "canceled" : "failed"))
        .finally(() => {
          this.#active -= 1;
          this.#entries.delete(entry.key);
          this.#drain();
        });
    }
  }
}

export function browserImagePreloadLoader(url: string): ReaderPreloadHandle {
  const image = new window.Image();
  let settled = false;
  let settle: (outcome: ReaderPreloadOutcome) => void = () => undefined;
  const promise = new Promise<ReaderPreloadOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (outcome: ReaderPreloadOutcome) => {
    if (settled) {
      return;
    }
    settled = true;
    image.onload = null;
    image.onerror = null;
    settle(outcome);
  };

  image.onload = () => finish("loaded");
  image.onerror = () => finish("failed");
  image.src = url;

  return {
    promise,
    cancel: () => {
      if (!settled) {
        image.src = "";
        finish("canceled");
      }
    },
  };
}
