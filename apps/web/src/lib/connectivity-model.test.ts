import { describe, expect, it } from "vitest";
import {
  connectionIndicator,
  offlineRetryIntervalMs,
  taskPollingDelay,
  taskPollingIntervalMs,
} from "@/lib/connectivity-model";

describe("connectionIndicator", () => {
  it("API 在线但事件流不可用时显示轮询，不误报离线", () => {
    expect(connectionIndicator("online", "polling")).toMatchObject({
      className: "stream-state degraded",
      icon: "polling",
      label: "在线 · 轮询",
    });
  });

  it("只有 API 不可达时才显示离线", () => {
    expect(connectionIndicator("offline", "realtime")).toMatchObject({
      className: "stream-state offline",
      icon: "offline",
      label: "离线",
    });
  });

  it("API 与实时通道均正常时显示实时", () => {
    expect(connectionIndicator("online", "realtime")).toMatchObject({
      className: "stream-state ready",
      icon: "realtime",
      label: "实时",
    });
  });
});

describe("taskPollingDelay", () => {
  it("事件流不可用时始终轮询以保持任务列表可用", () => {
    expect(taskPollingDelay("online", "polling", false)).toBe(taskPollingIntervalMs);
  });

  it("API 离线后按较低频率自动探测恢复", () => {
    expect(taskPollingDelay("offline", "polling", false)).toBe(offlineRetryIntervalMs);
  });

  it("实时通道稳定且没有活动任务时停止冗余轮询", () => {
    expect(taskPollingDelay("online", "realtime", false)).toBeNull();
  });

  it("存在活动任务时保留低频校准，避免漏事件后界面停滞", () => {
    expect(taskPollingDelay("online", "realtime", true)).toBe(taskPollingIntervalMs);
  });
});
