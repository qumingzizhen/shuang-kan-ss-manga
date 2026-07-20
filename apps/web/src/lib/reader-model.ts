import type { ReaderMode } from "@/lib/dashboard-model";

export type ReaderLoadPlan = {
  startPage: number;
  endPage: number;
  count: number;
  pageNumbers: number[];
  eagerPageIndexes: number[];
};

export function readerLoadPlan(currentPage: number, totalPages: number, mode: ReaderMode): ReaderLoadPlan {
  const total = Math.max(Math.floor(totalPages) || 1, 1);
  const current = Math.min(Math.max(Math.floor(currentPage) || 1, 1), total);
  const leadingPages = mode === "scroll" ? 2 : 3;
  const trailingPages = mode === "scroll" ? 8 : 3;
  const startPage = Math.max(1, current - leadingPages);
  const endPage = Math.min(total, current + trailingPages);
  const pageNumbers = Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage + index);
  const priorityOffsets = mode === "scroll" ? [1, 2, 3, -1] : [1, -1, 2, -2, 3, -3];
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
