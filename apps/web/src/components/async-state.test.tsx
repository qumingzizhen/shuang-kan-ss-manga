// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { Search } from "lucide-react";
import { describe, expect, it } from "vitest";
import { AsyncState } from "@/components/async-state";

describe("AsyncState", () => {
  it("加载和空数据使用非打断式状态语义", () => {
    const { rerender } = render(<AsyncState kind="loading" message="正在加载" compact />);
    const loading = screen.getByRole("status");

    expect(loading).toHaveTextContent("正在加载");
    expect(loading).toHaveClass("empty", "compact", "async-state", "loading");

    rerender(<AsyncState kind="empty" message="暂无结果" icon={<Search data-testid="search-icon" />} />);
    expect(screen.getByRole("status")).toHaveTextContent("暂无结果");
    expect(screen.getByTestId("search-icon")).toBeInTheDocument();
  });

  it("错误使用 alert 并保留附加样式", () => {
    render(<AsyncState kind="error" message="请求失败" className="library-error" />);

    expect(screen.getByRole("alert")).toHaveTextContent("请求失败");
    expect(screen.getByRole("alert")).toHaveClass("error", "async-state", "library-error");
  });
});