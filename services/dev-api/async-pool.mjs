export function normalizeConcurrency(value, fallback = 1, maximum = 32) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const safeFallback = Math.max(1, Math.min(Number(fallback) || 1, maximum));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, maximum)) : safeFallback;
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  const items = Array.from(values);
  if (!items.length) {
    return [];
  }

  const results = new Array(items.length);
  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function createAsyncLimiter(concurrency) {
  const limit = normalizeConcurrency(concurrency);
  const queue = [];
  let active = 0;

  function drain() {
    while (active < limit && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.operation)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  const schedule = (operation) =>
    new Promise((resolve, reject) => {
      queue.push({ operation, resolve, reject });
      drain();
    });

  Object.defineProperties(schedule, {
    active: { get: () => active },
    pending: { get: () => queue.length },
    concurrency: { value: limit },
  });
  return schedule;
}

export function createSingleFlight() {
  const inFlight = new Map();
  return {
    get(key) {
      return inFlight.get(key);
    },
    has(key) {
      return inFlight.has(key);
    },
    entries() {
      return inFlight.entries();
    },
    run(key, operation) {
      const current = inFlight.get(key);
      if (current) {
        return current;
      }
      const pending = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (inFlight.get(key) === pending) {
            inFlight.delete(key);
          }
        });
      inFlight.set(key, pending);
      return pending;
    },
  };
}
