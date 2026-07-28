"use client";

import { Image } from "lucide-react";
import { MouseEvent as ReactMouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, type TaskSearchResult } from "@/lib/api";

const initialVisibleResults = 10;
const resultRenderBatch = 10;
const thumbnailAttemptLimit = 3;
const thumbnailRetryDelaysMs = [800, 1800];

type InfiniteSearchResultsProps = {
  taskId: string;
  results: TaskSearchResult[];
  hasMore: boolean;
  loading: boolean;
  error?: string | null;
  renderResult: (result: TaskSearchResult) => ReactNode;
  onLoadMore: () => void;
};

export function InfiniteSearchResults({
  taskId,
  results,
  hasMore,
  loading,
  error,
  renderResult,
  onLoadMore,
}: InfiniteSearchResultsProps) {
  const [visibleCount, setVisibleCount] = useState(Math.min(initialVisibleResults, results.length));
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    setVisibleCount(Math.min(initialVisibleResults, results.length));
  }, [taskId]);

  useEffect(() => {
    setVisibleCount((current) =>
      Math.min(results.length, Math.max(current, Math.min(initialVisibleResults, results.length))),
    );
  }, [results.length]);

  const hasLocalResults = visibleCount < results.length;
  const canRequestMore = hasMore || Boolean(error);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loading || (!hasLocalResults && !canRequestMore) || typeof window === "undefined") {
      return;
    }

    const root = sentinel.closest<HTMLElement>(".detail-body");
    const revealOrLoad = () => {
      if (hasLocalResults) {
        setVisibleCount((current) => Math.min(results.length, current + resultRenderBatch));
      } else {
        onLoadMoreRef.current();
      }
    };

    if (!window.IntersectionObserver) {
      const handleScroll = () => {
        const bounds = sentinel.getBoundingClientRect();
        const viewportBottom = root?.getBoundingClientRect().bottom ?? window.innerHeight;
        if (bounds.top <= viewportBottom + 180) {
          revealOrLoad();
        }
      };
      root?.addEventListener("scroll", handleScroll, { passive: true });
      handleScroll();
      return () => root?.removeEventListener("scroll", handleScroll);
    }

    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          revealOrLoad();
        }
      },
      {
        root,
        rootMargin: "0px 0px 180px 0px",
        threshold: 0.01,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canRequestMore, hasLocalResults, loading, results.length]);

  const displayedResults = results.slice(0, visibleCount);
  return (
    <>
      <div className="detail-results">{displayedResults.map(renderResult)}</div>
      <div className="search-results-sentinel" ref={sentinelRef} aria-live="polite">
        {loading ? (
          <span>正在加载下一页搜索结果…</span>
        ) : error ? (
          <>
            <span>继续加载失败：{error}</span>
            <button className="mini-button" type="button" onClick={onLoadMore}>
              重试
            </button>
          </>
        ) : hasLocalResults ? (
          <span>继续下滑显示更多 · 已显示 {visibleCount}/{results.length}</span>
        ) : hasMore ? (
          <span>继续下滑搜索下一页 · 当前 {results.length} 条</span>
        ) : (
          <span>已加载全部 {results.length} 条结果</span>
        )}
      </div>
    </>
  );
}

type ThumbnailStatus = "missing" | "loading" | "waiting" | "loaded" | "failed";

function thumbnailProxyUrl(result: TaskSearchResult) {
  const thumbnailUrl = result.thumbnail_url?.trim();
  if (!thumbnailUrl) {
    return null;
  }
  const params = new URLSearchParams({
    source_id: result.source_id,
    url: thumbnailUrl,
    referer: result.gallery_url,
  });
  return apiUrl(`/v1/search-thumbnails?${params.toString()}`);
}

function thumbnailAttemptUrl(baseUrl: string, attempt: number) {
  return attempt > 0 ? `${baseUrl}&thumbnail_attempt=${attempt}` : baseUrl;
}

export function SearchResultThumbnail({ result, onOpen }: { result: TaskSearchResult; onOpen?: () => void }) {
  const baseUrl = useMemo(() => thumbnailProxyUrl(result), [result.gallery_url, result.source_id, result.thumbnail_url]);
  const retryTimer = useRef<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ThumbnailStatus>(baseUrl ? "loading" : "missing");

  const clearRetryTimer = useCallback(() => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  useEffect(() => {
    clearRetryTimer();
    setAttempt(0);
    setStatus(baseUrl ? "loading" : "missing");
    return clearRetryTimer;
  }, [baseUrl, clearRetryTimer]);

  function handleError() {
    clearRetryTimer();
    const nextAttempt = attempt + 1;
    if (!baseUrl || nextAttempt >= thumbnailAttemptLimit) {
      setStatus("failed");
      return;
    }

    setStatus("waiting");
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      setAttempt(nextAttempt);
      setStatus("loading");
    }, thumbnailRetryDelaysMs[attempt] ?? thumbnailRetryDelaysMs[thumbnailRetryDelaysMs.length - 1] ?? 1800);
  }

  const statusLabel =
    status === "missing"
      ? "暂无封面"
      : status === "failed"
        ? "封面暂不可用，点击重试"
        : status === "waiting"
          ? `正在重试 ${attempt + 2}/${thumbnailAttemptLimit}`
          : "封面加载中";
  const imageVisible = Boolean(baseUrl && (status === "loading" || status === "loaded"));

  function handleActivation(event: ReactMouseEvent<HTMLElement>) {
    if (status === "failed" && baseUrl) {
      event.preventDefault();
      event.stopPropagation();
      clearRetryTimer();
      setAttempt((current) => current + 1);
      setStatus("loading");
      return;
    }
    onOpen?.();
  }

  const thumbnailContent = (
    <>
      <span className="result-thumbnail-fallback">
        <Image size={22} aria-hidden />
        <span>{statusLabel}</span>
      </span>
      {imageVisible && baseUrl ? (
        <img
          key={attempt}
          src={thumbnailAttemptUrl(baseUrl, attempt)}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => {
            clearRetryTimer();
            setStatus("loaded");
          }}
          onError={handleError}
        />
      ) : null}
    </>
  );

  if (onOpen) {
    return (
      <button
        className={`result-thumbnail ${status}`}
        type="button"
        aria-label={`查看详情：${result.title}`}
        aria-busy={status === "loading" || status === "waiting"}
        onClick={handleActivation}
      >
        {thumbnailContent}
      </button>
    );
  }

  return (
    <a
      className={`result-thumbnail ${status}`}
      href={result.gallery_url}
      target="_blank"
      rel="noreferrer"
      aria-label={`打开来源：${result.title}`}
      aria-busy={status === "loading" || status === "waiting"}
      onClick={handleActivation}
    >
      {thumbnailContent}
    </a>
  );
}
