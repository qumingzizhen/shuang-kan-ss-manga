import { describe, expect, it } from "vitest";
import { prettyJson } from "@/lib/json";

describe("prettyJson", () => {
  it("把 undefined 规范化为 JSON null", () => {
    expect(prettyJson(undefined)).toBe("null");
  });

  it("循环引用不会导致诊断面板崩溃", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(JSON.parse(prettyJson(value))).toMatchObject({
      error: expect.stringContaining("circular"),
    });
  });
});
