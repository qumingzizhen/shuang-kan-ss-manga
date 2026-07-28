import { describe, expect, it } from "vitest";
import {
  clampPageNumber,
  isReaderFit,
  isReaderMode,
  rerunSearchRequest,
  splitTags,
} from "@/lib/dashboard-model";
import type { Task } from "@/lib/api";

function searchTask(payload: unknown): Task {
  return {
    id: "task-1",
    kind: "search",
    title: "测试搜索",
    status: "completed",
    payload,
    output: null,
    progress: {
      total: 1,
      done: 1,
      failed: 0,
      message: "done",
    },
    created_at: "2026-07-25T00:00:00Z",
    updated_at: "2026-07-25T00:00:00Z",
  };
}

describe("splitTags", () => {
  it("支持中英文分隔符、命名空间词条并稳定去重", () => {
    expect(splitTags("巨乳，language:chinese female:big breasts\n巨乳")).toEqual([
      "巨乳",
      "language:chinese",
      "female:big breasts",
    ]);
  });

  it("忽略空白输入", () => {
    expect(splitTags(" ,，；\n ")).toEqual([]);
  });
});

describe("rerunSearchRequest", () => {
  it("清洗旧任务入参并保留兼容字段", () => {
    expect(
      rerunSearchRequest(
        searchTask({
          source_ids: ["18comic", "", 123],
          tags: ["language:chinese", null, ""],
          excluded_tags: ["female:guro", 1],
          name: "  标题  ",
          limit: "12.9",
        }),
      ),
    ).toEqual({
      source_ids: ["18comic"],
      tags: ["language:chinese"],
      excluded_tags: ["female:guro"],
      name: "标题",
      limit: 12,
    });
  });

  it("旧任务缺少 payload 时给出明确错误", () => {
    expect(() => rerunSearchRequest(searchTask(null))).toThrow("旧任务缺少 payload");
  });
});

describe("reader guards", () => {
  it("约束页码边界", () => {
    expect(clampPageNumber(Number.NaN, 0)).toBe(1);
    expect(clampPageNumber(-3, 10)).toBe(1);
    expect(clampPageNumber(20, 10)).toBe(10);
    expect(clampPageNumber(4.9, 10)).toBe(4);
  });

  it("只接受受支持的阅读器设置", () => {
    expect(isReaderFit("width")).toBe(true);
    expect(isReaderFit("wide")).toBe(false);
    expect(isReaderMode("scroll")).toBe(true);
    expect(isReaderMode(null)).toBe(false);
  });
});
