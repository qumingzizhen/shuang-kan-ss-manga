// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskDetailDrawer, type TaskDetailSearchState } from "@/components/task-detail-drawer";
import type { Task, TaskSearchResult } from "@/lib/api";

vi.mock("@/components/search-results-view", () => ({
  SearchResultsView: ({
    results,
    selectedKeys,
  }: {
    results: TaskSearchResult[];
    selectedKeys: string[];
  }) => (
    <div data-testid="search-results-view">
      {results.length} 条结果 · {selectedKeys.length} 条已选择
    </div>
  ),
}));

const searchResult: TaskSearchResult = {
  source_id: "e-hentai",
  gallery_url: "https://e-hentai.org/g/1/token/",
  title: "测试漫画",
  tags: ["language:chinese"],
};

function taskWithOutput(output: Task["output"]): Task {
  return {
    id: "task-1",
    kind: output?.type === "retry_plan" ? "retry_folder" : output?.type === "gallery_download" ? "gallery" : "search",
    status: "completed",
    title: "任务详情测试",
    payload: { source_id: "e-hentai" },
    progress: { total: 2, done: 2, failed: 0, message: "completed" },
    output,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
  };
}

function createActions() {
  return {
    close: vi.fn(),
    rerun: vi.fn(),
    copy: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    downloadSelected: vi.fn(),
    toggleSelected: vi.fn(),
    loadMore: vi.fn(),
    read: vi.fn(),
    download: vi.fn(),
  };
}

describe("TaskDetailDrawer", () => {
  it("搜索任务保留来源告警、禁用词统计和批量操作", () => {
    const actions = createActions();
    const task = taskWithOutput({
      type: "search_results",
      results: [searchResult],
      has_more: true,
    });
    const search: TaskDetailSearchState = {
      results: [searchResult],
      selectedKeys: ["e-hentai:https://e-hentai.org/g/1/token/"],
      sourceErrorCount: 1,
      excludedCount: 2,
      hasMore: true,
      loadingMore: false,
    };

    render(
      <TaskDetailDrawer
        task={task}
        closing={false}
        actionBusy={false}
        rerunBusy={false}
        readerBusy={false}
        search={search}
        canRead={() => true}
        actions={actions}
      />,
    );

    expect(screen.getByText("1 个源站暂时不可用，已合并显示其余结果。")).toBeInTheDocument();
    expect(screen.getByText("已自动排除 2 条命中全局禁用词条的结果")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-view")).toHaveTextContent("1 条结果 · 1 条已选择");

    fireEvent.click(screen.getByRole("button", { name: "下载 1" }));
    fireEvent.click(screen.getByRole("button", { name: "重跑" }));
    fireEvent.click(screen.getByRole("button", { name: "收回任务详情侧边栏" }));

    expect(actions.downloadSelected).toHaveBeenCalledTimes(1);
    expect(actions.rerun).toHaveBeenCalledTimes(1);
    expect(actions.close).toHaveBeenCalledTimes(1);
  });

  it("下载任务保留输出路径及复制行为", () => {
    const actions = createActions();
    const task = taskWithOutput({
      type: "gallery_download",
      source_id: "e-hentai",
      gallery_url: "https://e-hentai.org/g/1/token/",
      title: "测试漫画",
      output_folder: "D:\\漫画\\下载\\测试漫画",
      done: 42,
      skipped: 0,
      failed: 0,
      stopped: false,
    });

    render(
      <TaskDetailDrawer
        task={task}
        closing={false}
        actionBusy={false}
        rerunBusy={false}
        readerBusy={false}
        canRead={() => true}
        actions={actions}
      />,
    );

    expect(screen.getByText("D:\\漫画\\下载\\测试漫画")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));
    expect(actions.copy).toHaveBeenCalledWith("output folder", "D:\\漫画\\下载\\测试漫画");
  });
});
