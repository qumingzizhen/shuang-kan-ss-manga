// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryProvider } from "@/components/query-provider";
import { SearchResultsView } from "@/components/search-results-view";
import { getSearchResultDetail, type TaskSearchResult } from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, getSearchResultDetail: vi.fn() };
});

const results: TaskSearchResult[] = [
  {
    source_id: "one",
    gallery_url: "https://one.test/older",
    title: "较早作品",
    tags: ["language:chinese"],
    uploaded_at: "2026-07-24T10:00:00Z",
  },
  {
    source_id: "two",
    gallery_url: "https://two.test/newest",
    title: "最新作品",
    tags: [],
    uploader: "上传者",
    category: "Doujinshi",
    uploaded_at: "2026-07-26T10:00:00Z",
    page_count: 42,
    rating: 4.5,
  },
];

beforeEach(() => {
  vi.mocked(getSearchResultDetail).mockResolvedValue({
    ...results[1],
    tags: ["language:chinese", "female:big breasts"],
    page_count: 42,
  });
});

describe("SearchResultsView", () => {
  it("一级结果以封面网格展示、默认按最新排序，且不直接显示阅读下载和 Tag", () => {
    const { container } = renderView();
    const summaries = container.querySelectorAll(".search-result-summary strong");

    expect(summaries[0]).toHaveTextContent("最新作品");
    expect(container.querySelectorAll(".search-result-card")).toHaveLength(2);
    expect(container.querySelector(".search-result-row")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "在线阅读" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下载" })).not.toBeInTheDocument();
    expect(screen.queryByText("female:big breasts")).not.toBeInTheDocument();
    expect(screen.getAllByText("42 页").length).toBeGreaterThan(0);
    expect(screen.getByText("4.5 / 5")).toBeInTheDocument();
  });

  it("打开二级详情后按需补齐 Tag，并提供阅读和下载", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "查看详情：最新作品" }));

    expect(await screen.findByRole("dialog", { name: "最新作品" })).toBeInTheDocument();
    await waitFor(() => expect(getSearchResultDetail).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("female:big breasts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "在线阅读" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "下载" })).toBeEnabled();
    expect(screen.getAllByText("42 页").length).toBeGreaterThan(0);
  });
});

function renderView() {
  return render(
    <QueryProvider>
      <SearchResultsView
        taskId="task-1"
        results={results}
        selectedKeys={[]}
        hasMore={false}
        loadingMore={false}
        actionBusy={false}
        readerBusy={false}
        canRead={() => true}
        onToggleSelected={vi.fn()}
        onLoadMore={vi.fn()}
        onRead={vi.fn()}
        onDownload={vi.fn()}
      />
    </QueryProvider>,
  );
}
