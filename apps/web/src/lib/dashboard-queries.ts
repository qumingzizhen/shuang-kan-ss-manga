import type { QueryClient, QueryKey } from "@tanstack/react-query";
import {
  listLibrary,
  listLibraryTags,
  listRemoteReaderSessions,
  listSources,
  listTasks,
} from "@/lib/api";

type CachedQueryOptions = {
  fresh?: boolean;
  staleTime: number;
};

export const dashboardQueryKeys = {
  tasks: ["dashboard", "tasks"] as const,
  sources: ["dashboard", "sources"] as const,
  library: ["dashboard", "library"] as const,
  libraryTags: (limit: number) => ["dashboard", "library-tags", { limit }] as const,
  remoteReaderSessions: ["dashboard", "remote-reader-sessions"] as const,
};

export async function fetchCachedQuery<T>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  queryFn: () => Promise<T>,
  options: CachedQueryOptions,
): Promise<T> {
  if (options.fresh) {
    await queryClient.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: "none",
    });
  }

  return queryClient.fetchQuery({
    queryKey,
    queryFn,
    staleTime: options.staleTime,
  });
}

export function fetchDashboardTasks(queryClient: QueryClient, fresh = false) {
  return fetchCachedQuery(queryClient, dashboardQueryKeys.tasks, () => listTasks(), {
    fresh,
    staleTime: 1_000,
  });
}

export function fetchDashboardSources(queryClient: QueryClient, fresh = false) {
  return fetchCachedQuery(queryClient, dashboardQueryKeys.sources, () => listSources(), {
    fresh,
    staleTime: 30_000,
  });
}

export function fetchDashboardLibrary(queryClient: QueryClient, fresh = false) {
  return fetchCachedQuery(queryClient, dashboardQueryKeys.library, () => listLibrary(), {
    fresh,
    staleTime: 5_000,
  });
}

export function fetchDashboardLibraryTags(queryClient: QueryClient, limit = 36, fresh = false) {
  return fetchCachedQuery(
    queryClient,
    dashboardQueryKeys.libraryTags(limit),
    () => listLibraryTags({ limit }),
    {
      fresh,
      staleTime: 30_000,
    },
  );
}

export function fetchDashboardRemoteReaderSessions(queryClient: QueryClient, fresh = false) {
  return fetchCachedQuery(
    queryClient,
    dashboardQueryKeys.remoteReaderSessions,
    () => listRemoteReaderSessions(),
    {
      fresh,
      staleTime: 2_000,
    },
  );
}
