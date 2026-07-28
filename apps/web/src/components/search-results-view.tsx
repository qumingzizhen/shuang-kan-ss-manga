"use client";

import {
  BookOpen,
  CalendarDays,
  Download,
  ExternalLink,
  Files,
  LoaderCircle,
  Star,
  Tags,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getSearchResultDetail,
  type SearchResultDetail,
  type TaskSearchResult,
} from "@/lib/api";
import {
  formatSearchResultCategory,
  formatSearchResultTime,
  searchResultKey,
  sortSearchResults,
  type SearchResultSort,
} from "@/lib/search-result-model";
import { InfiniteSearchResults, SearchResultThumbnail } from "@/components/search-results";

type SearchResultsViewProps = {
  taskId: string;
  results: TaskSearchResult[];
  selectedKeys: string[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError?: string | null;
  actionBusy: boolean;
  readerBusy: boolean;
  canRead: (sourceId: string) => boolean;
  onToggleSelected: (result: TaskSearchResult) => void;
  onLoadMore: () => void;
  onRead: (result: TaskSearchResult) => void;
  onDownload: (result: TaskSearchResult) => void;
};

export function SearchResultsView({
  taskId,
  results,
  selectedKeys,
  hasMore,
  loadingMore,
  loadMoreError,
  actionBusy,
  readerBusy,
  canRead,
  onToggleSelected,
  onLoadMore,
  onRead,
  onDownload,
}: SearchResultsViewProps) {
  const [sort, setSort] = useState<SearchResultSort>("newest");
  const [activeResult, setActiveResult] = useState<TaskSearchResult | null>(null);
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const sortedResults = useMemo(() => sortSearchResults(results, sort), [results, sort]);
  const activeResultKey = activeResult ? searchResultKey(activeResult) : "none";
  const detailQuery = useQuery<SearchResultDetail>({
    queryKey: ["search-result-detail", activeResultKey],
    queryFn: () => getSearchResultDetail(activeResult as TaskSearchResult),
    enabled: Boolean(activeResult),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  useEffect(() => {
    setSort("newest");
    setActiveResult(null);
  }, [taskId]);

  useEffect(() => {
    if (!activeResult) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        setActiveResult(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeResult]);

  function openDetail(result: TaskSearchResult) {
    setActiveResult(result);
  }

  const activeDetail: SearchResultDetail | null = detailQuery.data ?? activeResult;
  const detailError = detailQuery.error instanceof Error ? detailQuery.error.message : null;
  return (
    <>
      <div className="search-results-toolbar">
        <span>默认按上传时间由近到远排列；无时间结果按来源交错</span>
        <label>
          排序
          <select value={sort} onChange={(event) => setSort(event.target.value as SearchResultSort)}>
            <option value="newest">最新上传</option>
            <option value="oldest">最早上传</option>
            <option value="title">名称</option>
          </select>
        </label>
      </div>

      <InfiniteSearchResults
        taskId={taskId}
        results={sortedResults}
        hasMore={hasMore}
        loading={loadingMore}
        error={loadMoreError}
        onLoadMore={onLoadMore}
        renderResult={(result) => {
          const category = formatSearchResultCategory(result.category);
          const uploadedAt = formatSearchResultTime(result.uploaded_at);
          return (
            <article className="search-result search-result-card" key={searchResultKey(result)}>
              <button className="search-result-summary" type="button" onClick={() => openDetail(result)}>
                <strong title={result.title}>{result.title}</strong>
              </button>
              <div className="search-result-cover">
                <input
                  className="result-checkbox"
                  type="checkbox"
                  aria-label={`选择：${result.title}`}
                  checked={selected.has(searchResultKey(result))}
                  onChange={() => onToggleSelected(result)}
                />
                <SearchResultThumbnail result={result} onOpen={() => openDetail(result)} />
              </div>
              <div className="search-result-badges">
                {category ? <span className="result-category">{category}</span> : null}
                <span className="result-source">{result.source_id}</span>
              </div>
              <div className="search-result-meta">
                {uploadedAt ? (
                  <span>
                    <CalendarDays size={13} aria-hidden />
                    <time dateTime={result.uploaded_at ?? undefined}>{uploadedAt}</time>
                  </span>
                ) : null}
                {result.uploader ? (
                  <span title={result.uploader}>
                    <UserRound size={13} aria-hidden />
                    {result.uploader}
                  </span>
                ) : null}
                {result.page_count ? (
                  <span>
                    <Files size={13} aria-hidden />
                    {result.page_count} 页
                  </span>
                ) : null}
                {typeof result.rating === "number" ? (
                  <span>
                    <Star size={13} aria-hidden />
                    {result.rating.toFixed(1)} / 5
                  </span>
                ) : null}
              </div>
            </article>
          );
        }}
      />

      {activeResult && activeDetail ? (
        <div className="search-result-detail-layer">
          <button
            className="search-result-detail-backdrop"
            type="button"
            aria-label="关闭漫画详情"
            onClick={() => setActiveResult(null)}
          />
          <section
            className="search-result-detail-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="search-result-detail-title"
          >
            <header>
              <div>
                <span>漫画详情</span>
                <h3 id="search-result-detail-title">{activeDetail.title}</h3>
              </div>
              <button className="drawer-close-button" type="button" aria-label="关闭漫画详情" onClick={() => setActiveResult(null)}>
                <X size={17} aria-hidden />
              </button>
            </header>

            <div className="search-result-detail-body">
              <div className="search-result-detail-overview">
                <SearchResultThumbnail result={activeDetail} />
                <div className="search-result-detail-facts">
                  <Fact label="来源" value={activeDetail.source_id} />
                  <Fact label="分类" value={formatSearchResultCategory(activeDetail.category)} />
                  <Fact label="上传人" value={activeDetail.uploader} />
                  <Fact label="上传时间" value={formatSearchResultTime(activeDetail.uploaded_at)} />
                  <Fact label="页数" value={activeDetail.page_count ? `${activeDetail.page_count} 页` : null} />
                  <Fact label="评分" value={typeof activeDetail.rating === "number" ? `${activeDetail.rating.toFixed(1)} / 5` : null} />
                </div>
              </div>

              <div className="search-result-detail-actions">
                <button
                  className="mini-button primary"
                  type="button"
                  disabled={readerBusy || !canRead(activeDetail.source_id)}
                  title={canRead(activeDetail.source_id) ? "打开在线阅读器" : "该源站暂不支持在线阅读"}
                  onClick={() => onRead(activeDetail)}
                >
                  <BookOpen size={15} aria-hidden />
                  在线阅读
                </button>
                <button className="mini-button primary" type="button" disabled={actionBusy} onClick={() => onDownload(activeDetail)}>
                  <Download size={15} aria-hidden />
                  下载
                </button>
                <a className="mini-button" href={activeDetail.gallery_url} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} aria-hidden />
                  来源页面
                </a>
              </div>

              <section className="search-result-detail-tags">
                <div>
                  <h4>
                    <Tags size={15} aria-hidden />
                    Tag
                  </h4>
                  <span>{activeDetail.tags.length} 个</span>
                </div>
                {detailQuery.isFetching ? (
                  <p className="search-result-detail-status">
                    <LoaderCircle size={15} className="spin" aria-hidden />
                    正在补齐完整 Tag…
                  </p>
                ) : activeDetail.tags.length ? (
                  <div className="result-tags">
                    {activeDetail.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                ) : (
                  <p className="search-result-detail-status">来源未提供 Tag</p>
                )}
                {detailError ? (
                  <div className="search-result-detail-error">
                    <span>完整详情加载失败：{detailError}</span>
                    <button className="mini-button" type="button" onClick={() => void detailQuery.refetch()}>
                      重试
                    </button>
                  </div>
                ) : null}
              </section>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) {
    return null;
  }
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
