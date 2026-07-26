import { describe, expect, it } from "vitest";
import { readerLoadPlan } from "@/lib/reader-model";

describe("readerLoadPlan", () => {
  it("连续模式只规划当前页附近的小窗口", () => {
    const plan = readerLoadPlan(50, 100, "scroll");

    expect(plan.startPage).toBe(48);
    expect(plan.endPage).toBe(58);
    expect(plan.count).toBe(11);
    expect(plan.pageNumbers).toEqual([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
    expect(plan.eagerPageIndexes).toEqual([51, 52, 53, 49]);
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
