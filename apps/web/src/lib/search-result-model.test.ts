import { describe, expect, it } from "vitest";
import type { TaskSearchResult } from "@/lib/api";
import { formatSearchResultCategory, sortSearchResults } from "@/lib/search-result-model";

function result(sourceId: string, title: string, uploadedAt?: string): TaskSearchResult {
  return {
    source_id: sourceId,
    gallery_url: `https://${sourceId}.test/${title}`,
    title,
    tags: [],
    uploaded_at: uploadedAt,
  };
}

describe("sortSearchResults", () => {
  it("默认把有时间结果按由近到远排列", () => {
    const sorted = sortSearchResults([
      result("one", "较早", "2026-07-24T10:00:00Z"),
      result("two", "最新", "2026-07-26T10:00:00Z"),
      result("one", "中间", "2026-07-25T10:00:00Z"),
    ]);
    expect(sorted.map((item) => item.title)).toEqual(["最新", "中间", "较早"]);
  });

  it("无上传时间时按来源轮转，避免单一来源占满首屏", () => {
    const sorted = sortSearchResults([
      result("one", "one-1"),
      result("one", "one-2"),
      result("two", "two-1"),
      result("two", "two-2"),
      result("three", "three-1"),
    ]);
    expect(sorted.map((item) => item.title)).toEqual(["one-1", "two-1", "three-1", "one-2", "two-2"]);
  });

  it("分类使用中文展示名且不丢弃未知分类", () => {
    expect(formatSearchResultCategory("Doujinshi")).toBe("同人志");
    expect(formatSearchResultCategory("Experimental")).toBe("Experimental");
  });
});
