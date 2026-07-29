// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceAuthPanel } from "@/components/source-auth-panel";
import type { SourceAdapterDescriptor, SourceAuthStatus } from "@/lib/api";

const apiMocks = vi.hoisted(() => ({
  getSourceAuth: vi.fn(),
  saveSourceAuth: vi.fn(),
  deleteSourceAuth: vi.fn(),
  fetchDashboardSources: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getSourceAuth: apiMocks.getSourceAuth,
  saveSourceAuth: apiMocks.saveSourceAuth,
  deleteSourceAuth: apiMocks.deleteSourceAuth,
}));
vi.mock("@/lib/dashboard-queries", () => ({
  fetchDashboardSources: apiMocks.fetchDashboardSources,
}));

const descriptor: SourceAdapterDescriptor = {
  id: "fixture",
  name: "Fixture",
  version: "1.0.0",
  capabilities: ["search"],
  enabled: true,
  auth: {
    mode: "cookie_headers",
    title: "Fixture 会话",
    description: "仅用于测试",
    fields: ["cookie", "headers"],
    headers_placeholder: "User-Agent: fixture",
  },
};
const configuredStatus: SourceAuthStatus = {
  source_id: "fixture",
  configured: true,
  has_local_cookie_file: true,
  has_local_headers_file: true,
  has_effective_cookie_file: true,
  has_effective_headers_file: true,
  available_for_default: true,
};

function renderPanel() {
  const callbacks = {
    onSourcesChange: vi.fn(),
    onLog: vi.fn(),
    onStart: vi.fn(),
    onError: vi.fn(),
    onValidationError: vi.fn(),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SourceAuthPanel descriptor={descriptor} {...callbacks} />
    </QueryClientProvider>,
  );
  return callbacks;
}

describe("SourceAuthPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getSourceAuth.mockResolvedValue(configuredStatus);
    apiMocks.saveSourceAuth.mockResolvedValue(configuredStatus);
    apiMocks.deleteSourceAuth.mockResolvedValue({ ...configuredStatus, configured: false });
    apiMocks.fetchDashboardSources.mockResolvedValue([descriptor]);
  });

  it("loads status and saves credentials through the existing API contract", async () => {
    const callbacks = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /配置/ }));
    expect(await screen.findByText("认证会话可用")).toBeInTheDocument();
    expect(callbacks.onSourcesChange).toHaveBeenCalledWith([descriptor]);

    fireEvent.change(screen.getByPlaceholderText("name=value; name2=value2"), {
      target: { value: "session=fixture" },
    });
    fireEvent.change(screen.getByPlaceholderText("User-Agent: fixture"), {
      target: { value: "User-Agent: test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(apiMocks.saveSourceAuth).toHaveBeenCalledWith("fixture", {
        cookie: "session=fixture",
        headers: "User-Agent: test",
      }),
    );
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("keeps empty credential validation inside the component", async () => {
    const callbacks = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /配置/ }));
    await screen.findByText("认证会话可用");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(callbacks.onValidationError).toHaveBeenCalledWith("请先粘贴 Cookie 或请求头");
    expect(apiMocks.saveSourceAuth).not.toHaveBeenCalled();
  });
});