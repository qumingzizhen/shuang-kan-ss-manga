import { describe, expect, it } from "vitest";
import {
  ReaderPreloadQueue,
  type ReaderPreloadHandle,
  type ReaderPreloadOutcome,
} from "@/lib/reader-preload-queue";

function deferredHandle(registry: Array<{ finish: (outcome: ReaderPreloadOutcome) => void; canceled: () => boolean }>): ReaderPreloadHandle {
  let resolve: (outcome: ReaderPreloadOutcome) => void = () => undefined;
  let wasCanceled = false;
  const promise = new Promise<ReaderPreloadOutcome>((done) => {
    resolve = done;
  });
  registry.push({
    finish: resolve,
    canceled: () => wasCanceled,
  });
  return {
    promise,
    cancel: () => {
      wasCanceled = true;
      resolve("canceled");
    },
  };
}

describe("ReaderPreloadQueue", () => {
  it("限制并发并在前序请求结束后继续排队", async () => {
    const handles: Array<{ finish: (outcome: ReaderPreloadOutcome) => void; canceled: () => boolean }> = [];
    const queue = new ReaderPreloadQueue(() => deferredHandle(handles), 2);
    const outcomes = [queue.enqueue("1", "/1"), queue.enqueue("2", "/2"), queue.enqueue("3", "/3")];

    expect(queue.stats).toEqual({ active: 2, queued: 1 });
    handles[0].finish("loaded");
    await outcomes[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.stats.active).toBe(2);
    expect(handles).toHaveLength(3);

    handles[1].finish("loaded");
    handles[2].finish("failed");
    await expect(Promise.all(outcomes)).resolves.toEqual(["loaded", "loaded", "failed"]);
  });

  it("切页时取消窗口之外的待处理和活动请求", async () => {
    const handles: Array<{ finish: (outcome: ReaderPreloadOutcome) => void; canceled: () => boolean }> = [];
    const queue = new ReaderPreloadQueue(() => deferredHandle(handles), 1);
    const first = queue.enqueue("old-active", "/old-1");
    const second = queue.enqueue("old-pending", "/old-2");
    const retained = queue.enqueue("keep", "/keep");

    queue.cancelExcept(["keep"]);

    await expect(first).resolves.toBe("canceled");
    await expect(second).resolves.toBe("canceled");
    await Promise.resolve();
    await Promise.resolve();
    expect(handles[0].canceled()).toBe(true);
    expect(handles).toHaveLength(2);
    handles[1].finish("loaded");
    await expect(retained).resolves.toBe("loaded");
  });
});
