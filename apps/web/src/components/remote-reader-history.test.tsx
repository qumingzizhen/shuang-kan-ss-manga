// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { RemoteReaderHistory } from "@/components/remote-reader-history";
import type { RemoteReaderSessionSummary } from "@/lib/api";

function session(index: number, tags: string[] = []): RemoteReaderSessionSummary {
  return {
    id: `session-${index}`,
    source_id: "e-hentai",
    source_name: "E-Hentai",
    gallery_url: `https://e-hentai.org/g/${index}/token/`,
    title: `漫画 ${index}`,
    tags,
    page_count: 20,
    last_page: index,
    last_read_at: "2026-07-27T00:00:00Z",
    bookmarks: index === 1
      ? [{ page_index: 3, note: "", created_at: "2026-07-27T00:00:00Z" }]
      : [],
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
  };
}

function renderHistory(
  sessions: RemoteReaderSessionSummary[],
  overrides: Partial<ComponentProps<typeof RemoteReaderHistory>> = {},
) {
  const actions = {
    onRefresh: vi.fn(),
    onResume: vi.fn(),
    onClearCache: vi.fn(),
    onCopyLink: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <RemoteReaderHistory
      sessions={sessions}
      loading={false}
      readerBusy={false}
      maintenanceKey={null}
      {...actions}
      {...overrides}
    />,
  );
  return actions;
}

describe("RemoteReaderHistory", () => {
  it("默认限制五条，支持展开和按标题、来源、Tag 筛选", () => {
    const sessions = [
      session(1),
      session(2),
      session(3, ["special:match"]),
      session(4),
      session(5),
      session(6),
    ];
    renderHistory(sessions);

    expect(screen.getAllByRole("button", { name: "继续" })).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "展开" }));
    expect(screen.getAllByRole("button", { name: "继续" })).toHaveLength(6);

    fireEvent.change(screen.getByRole("textbox", { name: "筛选在线阅读记录" }), {
      target: { value: "special:match" },
    });
    expect(screen.getByText("漫画 3")).toBeInTheDocument();
    expect(screen.queryByText("漫画 1")).not.toBeInTheDocument();
    expect(screen.getByText("1/6 个会话")).toBeInTheDocument();
  });

  it("继续、缓存、复制、删除和刷新仍转发给仪表盘", () => {
    const currentSession = session(1);
    const actions = renderHistory([currentSession]);

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.click(screen.getByRole("button", { name: "缓存" }));
    fireEvent.click(screen.getByRole("button", { name: "链接" }));
    fireEvent.click(screen.getByRole("button", { name: `删除在线阅读记录：${currentSession.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "刷新在线阅读记录" }));

    expect(actions.onResume).toHaveBeenCalledWith(currentSession);
    expect(actions.onClearCache).toHaveBeenCalledWith(currentSession);
    expect(actions.onCopyLink).toHaveBeenCalledWith(currentSession);
    expect(actions.onDelete).toHaveBeenCalledWith(currentSession);
    expect(actions.onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/书签 1/)).toBeInTheDocument();
  });
});
