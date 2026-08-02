import type { ReaderDirection, ReaderMode } from "@/lib/dashboard-model";

export type ReaderLoadPlan = {
  startPage: number;
  endPage: number;
  count: number;
  pageNumbers: number[];
  eagerPageIndexes: number[];
};

export type ReaderPageOrientation = "portrait" | "landscape" | "unknown";

export type ReaderSpreadPlan = {
  anchorPage: number;
  logicalPages: number[];
  displayPages: number[];
};

export type ReaderProgressSnapshot = {
  lastPage: number;
  pageRatio: number;
  scrollOffset: number | null;
  scrollRatio: number | null;
};

export function readerLoadPlan(currentPage: number, totalPages: number, mode: ReaderMode): ReaderLoadPlan {
  const total = Math.max(Math.floor(totalPages) || 1, 1);
  const current = Math.min(Math.max(Math.floor(currentPage) || 1, 1), total);
  const leadingPages = mode === "scroll" ? 2 : mode === "double" ? 4 : 3;
  const trailingPages = mode === "scroll" ? 8 : mode === "double" ? 4 : 3;
  const startPage = Math.max(1, current - leadingPages);
  const endPage = Math.min(total, current + trailingPages);
  const pageNumbers = Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index);
  const priorityOffsets = mode === "scroll" ? [1, 2, 3, 4, -1] : [1, -1, 2, -2, 3, -3, 4, -4];
  const eagerPageIndexes = priorityOffsets
    .map((offset) => current + offset)
    .filter((page, index, pages) => page >= startPage && page <= endPage && pages.indexOf(page) === index);

  return {
    startPage,
    endPage,
    count: pageNumbers.length,
    pageNumbers,
    eagerPageIndexes,
  };
}

export function readerSpreadPlan(
  currentPage: number,
  totalPages: number,
  direction: ReaderDirection,
  orientationForPage: (page: number) => ReaderPageOrientation = () => "unknown",
): ReaderSpreadPlan {
  const total = Math.max(Math.floor(totalPages) || 1, 1);
  const current = Math.min(Math.max(Math.floor(currentPage) || 1, 1), total);
  if (current === 1 || orientationForPage(current) === "landscape") {
    return { anchorPage: current, logicalPages: [current], displayPages: [current] };
  }

  const pairStart = current % 2 === 0 ? current : current - 1;
  const candidatePages = [pairStart, pairStart + 1].filter((page) => page >= 1 && page <= total);
  const logicalPages = candidatePages.some((page) => orientationForPage(page) === "landscape") ? [current] : candidatePages;
  return {
    anchorPage: logicalPages[0] ?? current,
    logicalPages,
    displayPages: direction === "rtl" ? [...logicalPages].reverse() : logicalPages,
  };
}

export function readerNavigationDelta(mode: ReaderMode, direction: ReaderDirection, forward: boolean): number {
  const step = mode === "double" ? 2 : 1;
  const directionMultiplier = direction === "rtl" ? -1 : 1;
  return step * directionMultiplier * (forward ? 1 : -1);
}

export function readerProgressSnapshot(
  page: number,
  totalPages: number,
  scrollOffset?: number | null,
  scrollExtent?: number | null,
): ReaderProgressSnapshot {
  const total = Math.max(Math.floor(totalPages) || 1, 1);
  const lastPage = Math.min(Math.max(Math.floor(page) || 1, 1), total);
  const pageRatio = lastPage / total;
  const normalizedOffset = Number.isFinite(scrollOffset) ? Math.max(Number(scrollOffset), 0) : null;
  const normalizedExtent = Number.isFinite(scrollExtent) ? Math.max(Number(scrollExtent), 0) : null;
  const scrollRatio = normalizedOffset !== null && normalizedExtent !== null && normalizedExtent > 0
    ? Math.min(Math.max(normalizedOffset / normalizedExtent, 0), 1)
    : null;
  return { lastPage, pageRatio, scrollOffset: normalizedOffset, scrollRatio };
}

export function readerModeSwitchRequiresConfirmation(from: ReaderMode, to: ReaderMode, hasProgress: boolean): boolean {
  return hasProgress && from !== to && (from === "scroll" || to === "scroll");
}