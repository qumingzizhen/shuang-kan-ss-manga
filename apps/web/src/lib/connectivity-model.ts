export type ApiConnectivity = "connecting" | "online" | "offline";

export type TaskUpdateTransport = "connecting" | "realtime" | "polling";

export type ConnectionIndicatorIcon = "connecting" | "realtime" | "polling" | "offline";

export type ConnectionIndicator = {
  className: string;
  icon: ConnectionIndicatorIcon;
  label: string;
  title: string;
};

export const taskPollingIntervalMs = 4_000;
export const offlineRetryIntervalMs = 6_000;

export function connectionIndicator(
  connectivity: ApiConnectivity,
  transport: TaskUpdateTransport,
): ConnectionIndicator {
  if (connectivity === "offline") {
    return {
      className: "stream-state offline",
      icon: "offline",
      label: "离线",
      title: "后端 API 暂时不可达，页面会自动重试",
    };
  }

  if (connectivity === "connecting") {
    return {
      className: "stream-state connecting",
      icon: "connecting",
      label: "连接中",
      title: "正在连接后端 API",
    };
  }

  if (transport === "realtime") {
    return {
      className: "stream-state ready",
      icon: "realtime",
      label: "实时",
      title: "后端 API 在线，任务通过实时事件流更新",
    };
  }

  return {
    className: "stream-state degraded",
    icon: "polling",
    label: "在线 · 轮询",
    title: "后端 API 在线；实时通道不可用，任务每 4 秒自动更新",
  };
}

export function taskPollingDelay(
  connectivity: ApiConnectivity,
  transport: TaskUpdateTransport,
  hasActiveTasks: boolean,
): number | null {
  if (connectivity === "offline") {
    return offlineRetryIntervalMs;
  }

  if (transport !== "realtime" || hasActiveTasks) {
    return taskPollingIntervalMs;
  }

  return null;
}
