import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { dashboardQueryKeys, fetchCachedQuery } from "@/lib/dashboard-queries";

function createTestClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

describe("fetchCachedQuery", () => {
  it("相同查询键复用在途请求", async () => {
    const queryClient = createTestClient();
    let resolveRequest: ((value: string[]) => void) | undefined;
    const request = new Promise<string[]>((resolve) => {
      resolveRequest = resolve;
    });
    const loader = vi.fn(() => request);

    const first = fetchCachedQuery(queryClient, dashboardQueryKeys.tasks, loader, {
      staleTime: 1_000,
    });
    const second = fetchCachedQuery(queryClient, dashboardQueryKeys.tasks, loader, {
      staleTime: 1_000,
    });

    expect(loader).toHaveBeenCalledTimes(1);
    resolveRequest?.(["task-1"]);
    await expect(first).resolves.toEqual(["task-1"]);
    await expect(second).resolves.toEqual(["task-1"]);
  });

  it("新鲜缓存直接复用，显式刷新才重新请求", async () => {
    const queryClient = createTestClient();
    const loader = vi.fn()
      .mockResolvedValueOnce(["first"])
      .mockResolvedValueOnce(["fresh"]);

    await expect(fetchCachedQuery(queryClient, dashboardQueryKeys.sources, loader, {
      staleTime: 30_000,
    })).resolves.toEqual(["first"]);
    await expect(fetchCachedQuery(queryClient, dashboardQueryKeys.sources, loader, {
      staleTime: 30_000,
    })).resolves.toEqual(["first"]);
    await expect(fetchCachedQuery(queryClient, dashboardQueryKeys.sources, loader, {
      fresh: true,
      staleTime: 30_000,
    })).resolves.toEqual(["fresh"]);

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("带参数的查询键不会错误共享缓存", () => {
    expect(dashboardQueryKeys.libraryTags(12)).not.toEqual(dashboardQueryKeys.libraryTags(36));
  });
});
