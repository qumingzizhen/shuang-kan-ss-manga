// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskTechnicalDetails } from "@/components/task-technical-details";

function setDetailsOpen(open: boolean) {
  const details = screen.getByText("技术详情").closest("details");
  if (!details) {
    throw new Error("technical details element is missing");
  }
  details.open = open;
  fireEvent(details, new Event("toggle"));
}

describe("TaskTechnicalDetails", () => {
  it("默认不挂载大段原始 JSON，展开后才序列化", () => {
    render(
      <TaskTechnicalDetails
        payload={{ query: "test" }}
        output={{ results: [1, 2, 3] }}
        onCopy={vi.fn()}
      />,
    );

    expect(screen.queryByText(/"query": "test"/)).not.toBeInTheDocument();

    setDetailsOpen(true);
    expect(screen.getByText(/"query": "test"/)).toBeInTheDocument();
    expect(screen.getByText(/"results"/)).toBeInTheDocument();

    setDetailsOpen(false);
    expect(screen.queryByText(/"query": "test"/)).not.toBeInTheDocument();
  });

  it("复制按钮传递格式化后的 JSON", () => {
    const onCopy = vi.fn();
    render(
      <TaskTechnicalDetails
        payload={{ source_id: "18comic" }}
        output={null}
        onCopy={onCopy}
      />,
    );

    setDetailsOpen(true);
    fireEvent.click(screen.getAllByRole("button", { name: "复制" })[0]);

    expect(onCopy).toHaveBeenCalledWith(
      "payload JSON",
      expect.stringContaining('"source_id": "18comic"'),
    );
    expect(screen.getAllByRole("button", { name: "复制" })[1]).toBeDisabled();
  });
});
