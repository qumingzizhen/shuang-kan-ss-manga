import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import {
  readerScrollObserverMargin,
  readerScrollObserverThresholds,
  restoreReaderScrollPosition,
  visibleReaderPageFromEntries,
} from "@/lib/reader-scroll";

/**
 * Shared scroll-mode reader effects. The dashboard previously duplicated the
 * IntersectionObserver setup, the one-time scroll restore, and the debounced
 * progress save for the library and remote readers; these hooks keep the
 * behavior in one place so fixes apply to both readers.
 */

export function scheduleDebounced(
  timerRef: MutableRefObject<number | null>,
  delayMs: number,
  callback: () => void,
): void {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
  }
  timerRef.current = window.setTimeout(() => {
    timerRef.current = null;
    callback();
  }, delayMs);
}

export function useReaderPageObserver(options: {
  enabled: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  resetKey: string;
  currentPage: number;
  observedPageCount: number;
  onVisiblePage: (page: number) => void;
}): void {
  const { enabled, stageRef, resetKey, currentPage, observedPageCount, onVisiblePage } = options;
  const onVisiblePageRef = useRef(onVisiblePage);

  useEffect(() => {
    onVisiblePageRef.current = onVisiblePage;
  }, [onVisiblePage]);

  useEffect(() => {
    if (!enabled || !stageRef.current || typeof window === "undefined" || !window.IntersectionObserver) {
      return;
    }

    const stage = stageRef.current;
    const observer = new window.IntersectionObserver(
      (entries) => {
        const visiblePage = visibleReaderPageFromEntries(entries);
        if (visiblePage !== null) {
          onVisiblePageRef.current(visiblePage);
        }
      },
      {
        root: stage,
        rootMargin: readerScrollObserverMargin,
        threshold: readerScrollObserverThresholds,
      },
    );

    stage.querySelectorAll<HTMLElement>("[data-reader-page]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [enabled, stageRef, resetKey, currentPage, observedPageCount]);
}

export function useReaderScrollRestore(options: {
  enabled: boolean;
  stageRef: RefObject<HTMLDivElement | null>;
  key: string;
  pageCount: number;
  offset: number | null | undefined;
  ratio: number | null | undefined;
  restoredKeyRef: MutableRefObject<string | null>;
}): void {
  const { enabled, stageRef, key, pageCount, offset, ratio, restoredKeyRef } = options;

  useEffect(() => {
    if (!enabled || !stageRef.current) {
      return;
    }
    if (restoredKeyRef.current === key) {
      return;
    }
    restoredKeyRef.current = key;
    const stage = stageRef.current;
    const frame = window.requestAnimationFrame(() => restoreReaderScrollPosition(stage, offset, ratio));
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, stageRef, key, pageCount, offset, ratio, restoredKeyRef]);
}