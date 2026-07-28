// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchResultThumbnail } from "@/components/search-results";
import type { TaskSearchResult } from "@/lib/api";

const result: TaskSearchResult = {
  source_id: "18comic",
  gallery_url: "https://18comic.vip/album/1",
  title: "测试漫画",
  tags: [],
  thumbnail_url: "https://cdn.example.test/cover.jpg",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchResultThumbnail", () => {
  it("第一次加载错误进入等待重试，达到上限后才失败", () => {
    vi.useFakeTimers();
    const { container } = render(<SearchResultThumbnail result={result} />);
    const link = screen.getByRole("link", { name: "打开来源：测试漫画" });

    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("正在重试 2/3")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(800));
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(screen.getByText("正在重试 3/3")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_800));
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(link).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("封面暂不可用，点击重试")).toBeInTheDocument();

    fireEvent.click(link);
    expect(link).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("任一尝试加载成功后立即结束等待状态", () => {
    const { container } = render(<SearchResultThumbnail result={result} />);
    const link = screen.getByRole("link", { name: "打开来源：测试漫画" });

    fireEvent.load(container.querySelector("img") as HTMLImageElement);

    expect(link).toHaveClass("loaded");
    expect(link).toHaveAttribute("aria-busy", "false");
  });

  it("没有封面地址时不创建无效图片请求", () => {
    const { container } = render(<SearchResultThumbnail result={{ ...result, thumbnail_url: null }} />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("暂无封面")).toBeInTheDocument();
  });
});