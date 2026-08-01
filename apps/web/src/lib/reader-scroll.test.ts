// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  readerScrollPageNumbers,
  restoreReaderScrollPosition,
  visibleReaderPageFromEntries,
} from "@/lib/reader-scroll";

function entry(page: number | null, overrides: Partial<IntersectionObserverEntry> = {}): IntersectionObserverEntry {
  const target = document.createElement("figure");
  if (page !== null) {
    target.dataset.readerPage = String(page);
  }
  const width = overrides.intersectionRect?.width ?? 100;
  const height = overrides.intersectionRect?.height ?? 200;
  return {
    isIntersecting: true,
    intersectionRatio: 0.5,
    intersectionRect: new DOMRect(0, 0, width, height),
    target,
    ...overrides,
  } as IntersectionObserverEntry;
}

describe("visibleReaderPageFromEntries", () => {
  it("返回相交条目中可见比例最高的一页", () => {
    const page = visibleReaderPageFromEntries([entry(3, { intersectionRatio: 0.2 }), entry(5, { intersectionRatio: 0.8 })]);

    expect(page).toBe(5);
  });

  it("忽略未相交条目与缺少页码标记的元素", () => {
    const page = visibleReaderPageFromEntries([
      entry(null),
      entry(2, { isIntersecting: false, intersectionRatio: 0.9 }),
      entry(7, { intersectionRatio: 0.4 }),
    ]);

    expect(page).toBe(7);
  });

  it("比例相同时选择相交面积更大的页面", () => {
    const page = visibleReaderPageFromEntries([
      entry(2, { intersectionRatio: 0.5, intersectionRect: new DOMRect(0, 0, 50, 50) }),
      entry(4, { intersectionRatio: 0.5, intersectionRect: new DOMRect(0, 0, 300, 300) }),
    ]);

    expect(page).toBe(4);
  });

  it("全部不可见时返回 null", () => {
    expect(visibleReaderPageFromEntries([entry(1, { isIntersecting: false })])).toBeNull();
  });
});

describe("restoreReaderScrollPosition", () => {
  function stage() {
    const element = document.createElement("div");
    Object.defineProperty(element, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(element, "clientHeight", { value: 200, configurable: true });
    return element;
  }

  it("有偏移量时直接恢复偏移量", () => {
    const element = stage();
    restoreReaderScrollPosition(element, 400, null);
    expect(element.scrollTop).toBe(400);
  });

  it("只有比例时按比例换算", () => {
    const element = stage();
    restoreReaderScrollPosition(element, null, 0.5);
    expect(element.scrollTop).toBe(400);
  });

  it("偏移量为 0 时保持 0，不落入比例兜底", () => {
    const element = stage();
    restoreReaderScrollPosition(element, 0, 0.9);
    expect(element.scrollTop).toBe(0);
  });

  it("没有进度时回到顶部", () => {
    const element = stage();
    restoreReaderScrollPosition(element, null, null);
    expect(element.scrollTop).toBe(0);
  });
});

describe("readerScrollPageNumbers", () => {
  it("连续模式只规划当前页附近的小窗口", () => {
    expect(readerScrollPageNumbers(50, 100)).toEqual([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  });

  it("首尾页码被收窄到合法范围", () => {
    expect(readerScrollPageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(readerScrollPageNumbers(5, 5)).toEqual([3, 4, 5]);
  });
});