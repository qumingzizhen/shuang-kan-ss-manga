// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useReaderScrollRestore } from "@/lib/use-reader-scroll";

describe("useReaderScrollRestore", () => {
  it("首次挂载时恢复一次滚动位置，后续内容变化不再覆盖用户位置", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const stage = document.createElement("div");
    Object.defineProperty(stage, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(stage, "clientHeight", { value: 200, configurable: true });
    const stageRef = { current: stage };
    const restoredKeyRef = { current: null as string | null };

    const { rerender } = renderHook(
      ({ pageCount, offset }) =>
        useReaderScrollRestore({
          enabled: true,
          stageRef,
          key: "remote:session-1",
          pageCount,
          offset,
          ratio: null,
          restoredKeyRef,
        }),
      { initialProps: { pageCount: 1, offset: 400 } },
    );

    expect(stage.scrollTop).toBe(400);

    rerender({ pageCount: 12, offset: 999 });
    expect(stage.scrollTop).toBe(400);

    vi.unstubAllGlobals();
  });
});