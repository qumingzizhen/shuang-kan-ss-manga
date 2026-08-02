// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReaderScrollStack } from "@/components/reader-scroll-stack";
import type { ReaderPageUiStatus } from "@/lib/reader-scroll";

type FakePage = { index: number; url: string; caption: string };

function renderStack(options: {
  pages?: FakePage[];
  pageNumbers?: number[];
  currentPage?: number;
  disabled?: boolean;
  getStatus?: (page: FakePage) => ReaderPageUiStatus;
  caption?: boolean;
}) {
  const pages = new Map((options.pages ?? []).map((page) => [page.index, page]));
  const jumpToPage = vi.fn();
  const renderPage = vi.fn((page: FakePage, loading: "eager" | "lazy") => (
    <img alt={`p${page.index}`} data-loading={loading} src={page.url} />
  ));
  const { container } = render(
    <ReaderScrollStack
      pages={pages}
      pageNumbers={options.pageNumbers ?? [1, 2, 3, 4]}
      currentPage={options.currentPage ?? 2}
      disabled={options.disabled ?? false}
      getKey={(page) => `k${page.index}`}
      getCaption={options.caption === false ? undefined : (page) => page.caption}
      getStatus={options.getStatus}
      jumpToPage={jumpToPage}
      renderPage={renderPage}
    />,
  );
  return { jumpToPage, renderPage, container };
}

describe("ReaderScrollStack", () => {
  it("缺失的页码渲染等高占位符，不渲染图片", () => {
    renderStack({ pages: [{ index: 2, url: "u2", caption: "c2" }], pageNumbers: [1, 2, 3] });

    expect(screen.getAllByText("等待预载")).toHaveLength(2);
    expect(screen.getByText("p1")).toBeInTheDocument();
    expect(screen.getByText("p3")).toBeInTheDocument();
    expect(document.querySelectorAll(".reader-scroll-placeholder img")).toHaveLength(0);
    expect(document.querySelectorAll(".reader-scroll-page img")).toHaveLength(1);
  });

  it("已加载页渲染图片、页码标记与说明文字，并标注当前页", () => {
    const { renderPage } = renderStack({
      pages: [
        { index: 2, url: "u2", caption: "c2" },
        { index: 3, url: "u3", caption: "c3" },
      ],
      pageNumbers: [2, 3],
      currentPage: 3,
    });

    const figure = document.querySelector('[data-reader-page="3"]');
    expect(figure).not.toBeNull();
    expect(figure?.classList.contains("active")).toBe(true);
    expect(renderPage).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }), "eager");
    expect(renderPage).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }), "lazy");
    expect(screen.getByText("c2")).toBeInTheDocument();
  });

  it("getStatus 结果映射为页面状态类名", () => {
    renderStack({
      pages: [{ index: 2, url: "u2", caption: "c2" }],
      pageNumbers: [2],
      getStatus: (page) => (page.index === 2 ? "failed" : "ready"),
    });

    const figure = document.querySelector('[data-reader-page="2"]');
    expect(figure?.classList.contains("failed")).toBe(true);
  });

  it("点击页面触发跳页，禁用时忽略", () => {
    const first = renderStack({ pages: [{ index: 2, url: "u2", caption: "c2" }], pageNumbers: [2] });
    fireEvent.click(first.container.querySelector(".reader-scroll-page-button")!);
    expect(first.jumpToPage).toHaveBeenCalledWith(2);

    const second = renderStack({ pages: [{ index: 2, url: "u2", caption: "c2" }], pageNumbers: [2], disabled: true });
    fireEvent.click(second.container.querySelector(".reader-scroll-page-button")!);
    expect(second.jumpToPage).not.toHaveBeenCalled();
  });

  it("回车键触发跳页", () => {
    const { jumpToPage, container } = renderStack({ pages: [{ index: 2, url: "u2", caption: "c2" }], pageNumbers: [2] });
    fireEvent.keyDown(container.querySelector(".reader-scroll-page-button")!, { key: "Enter" });
    expect(jumpToPage).toHaveBeenCalledWith(2);
  });

  it("does not render a figcaption when caption text is omitted", () => {
    renderStack({ pages: [{ index: 2, url: "u2", caption: "c2" }], pageNumbers: [2], caption: false });
    expect(document.querySelector("figcaption")).toBeNull();
  });
});