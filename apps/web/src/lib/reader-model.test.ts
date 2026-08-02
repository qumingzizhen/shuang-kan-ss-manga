import { describe, expect, it } from "vitest";
import {
  readerLoadPlan,
  readerModeSwitchRequiresConfirmation,
  readerNavigationDelta,
  readerProgressSnapshot,
  readerSpreadPlan,
} from "@/lib/reader-model";

describe("readerLoadPlan", () => {
  it("连续模式只规划当前页附近的小窗口", () => {
    const plan = readerLoadPlan(50, 100, "scroll");

    expect(plan.startPage).toBe(48);
    expect(plan.endPage).toBe(58);
    expect(plan.count).toBe(11);
    expect(plan.pageNumbers).toEqual([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
    expect(plan.eagerPageIndexes).toEqual([51, 52, 53, 54, 49]);
  });

  it("单页模式在首尾正确收窄并去除越界预加载", () => {
    expect(readerLoadPlan(1, 3, "single")).toEqual({
      startPage: 1,
      endPage: 3,
      count: 3,
      pageNumbers: [1, 2, 3],
      eagerPageIndexes: [2, 3],
    });
  });

  it("无效页码和总页数回退到第一页", () => {
    expect(readerLoadPlan(Number.NaN, Number.NaN, "single").pageNumbers).toEqual([1]);
  });
});
describe("readerSpreadPlan", () => {
  it("封面独页，后续竖图按阅读方向成对展示", () => {
    expect(readerSpreadPlan(1, 10, "ltr").displayPages).toEqual([1]);
    expect(readerSpreadPlan(3, 10, "ltr").displayPages).toEqual([2, 3]);
    expect(readerSpreadPlan(3, 10, "rtl").displayPages).toEqual([3, 2]);
  });

  it("任一横图在双页模式下保持单页", () => {
    expect(readerSpreadPlan(4, 10, "ltr", (page) => (page === 4 ? "landscape" : "portrait")).displayPages).toEqual([4]);
  });
});

describe("reader progress and navigation", () => {
  it("按模式和阅读方向计算移动步长", () => {
    expect(readerNavigationDelta("double", "ltr", true)).toBe(2);
    expect(readerNavigationDelta("double", "rtl", true)).toBe(-2);
    expect(readerNavigationDelta("single", "rtl", false)).toBe(1);
  });

  it("同时计算页码进度与连续滚动进度", () => {
    expect(readerProgressSnapshot(5, 20, 250, 1000)).toEqual({
      lastPage: 5,
      pageRatio: 0.25,
      scrollOffset: 250,
      scrollRatio: 0.25,
    });
  });

  it("只有跨越连续模式且已有进度时要求确认", () => {
    expect(readerModeSwitchRequiresConfirmation("single", "scroll", true)).toBe(true);
    expect(readerModeSwitchRequiresConfirmation("single", "double", true)).toBe(false);
    expect(readerModeSwitchRequiresConfirmation("scroll", "single", false)).toBe(false);
  });
});