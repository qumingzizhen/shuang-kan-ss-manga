import { readerLoadPlan } from "@/lib/reader-model";

/**
 * Shared scroll-mode reader helpers used by both the local library reader and
 * the remote online reader. Keeping the constants and pure DOM logic here
 * guarantees the two readers cannot drift apart.
 */

export const readerScrollSyncDelayMs = 650;
export const readerScrollObserverMargin = "-18% 0px -48% 0px";
export const readerScrollObserverThresholds = [0, 0.1, 0.25, 0.45, 0.65];

export type ReaderPageUiStatus = "loading" | "ready" | "failed" | "unknown";

export type ReaderVisiblePageCandidate = {
  page: number;
  ratio: number;
  area: number;
};

export function visibleReaderPageFromEntries(entries: IntersectionObserverEntry[]): number | null {
  let best: ReaderVisiblePageCandidate | null = null;

  for (const entry of entries) {
    if (!entry.isIntersecting) {
      continue;
    }

    const element = entry.target as HTMLElement;
    const page = Number(element.dataset.readerPage);
    if (!Number.isFinite(page)) {
      continue;
    }

    const area = entry.intersectionRect.width * entry.intersectionRect.height;
    const candidate = { page, ratio: entry.intersectionRatio, area };
    if (!best || candidate.ratio > best.ratio || (candidate.ratio === best.ratio && candidate.area > best.area)) {
      best = candidate;
    }
  }

  return best ? best.page : null;
}

export function restoreReaderScrollPosition(
  stage: HTMLElement,
  offset: number | null | undefined,
  ratio: number | null | undefined,
): void {
  const extent = Math.max(stage.scrollHeight - stage.clientHeight, 0);
  stage.scrollTop = offset ?? (ratio ?? 0) * extent;
}

export function readerScrollPageNumbers(currentPage: number, totalPages: number): number[] {
  const plan = readerLoadPlan(currentPage, totalPages, "scroll");
  // Render a contiguous, append-only stack from page 1. Removing rendered pages
  // above the viewport during fast scrolling makes the browser lose its scroll
  // anchor and clamp back to the top; append-only keeps the document stable.
  return Array.from({ length: plan.endPage }, (_, index) => index + 1);
}

export function scrollReaderStageToPage(stage: HTMLElement, pageIndex: number): void {
  const element = stage.querySelector<HTMLElement>(`[data-reader-page="${pageIndex}"]`);
  if (!element) {
    return;
  }
  const paddingTop = Number.parseFloat(window.getComputedStyle(stage).paddingTop) || 0;
  const stageRect = stage.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  stage.scrollTop = Math.max(stage.scrollTop + elementRect.top - stageRect.top - paddingTop, 0);
}