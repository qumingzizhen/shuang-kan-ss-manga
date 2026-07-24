"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Cloud,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderSync,
  HardDrive,
  Image,
  LayoutGrid,
  ListRestart,
  Maximize2,
  PanelRightClose,
  Play,
  RefreshCcw,
  Save,
  Search,
  Server,
  ShieldCheck,
  Star,
  Table2,
  Tags,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import {
  apiUrl,
  cancelTask,
  clearRemoteReaderSessionCache,
  createGalleryTask,
  createLibraryCbzExport,
  createLibraryPdfExport,
  createRemoteReaderSession,
  createRetryFolderTask,
  createSearchTask,
  createTaskEventsSource,
  createRemoteReaderBookmark,
  deleteSourceAuth,
  deleteRemoteReaderBookmark,
  deleteRemoteReaderSession,
  getSourceAuth,
  getRemoteReaderPageStatus,
  getRemoteReaderSession,
  getLibraryDetail,
  listLibraryExports,
  listLibrary,
  listLibraryPages,
  listLibraryTags,
  loadMoreSearchTaskResults,
  listRemoteReaderPageStatuses,
  listRemoteReaderPages,
  listRemoteReaderSessions,
  libraryExportDownloadUrl,
  listSources,
  listTasks,
  parseTaskEvent,
  saveSourceAuth,
  updateRemoteReaderProgress,
  updateLibraryShelf,
  type LibraryCompleteness,
  type LibraryDetail,
  type LibraryExportFormat,
  type LibraryExportResult,
  type LibraryHealthFilter,
  type LibraryItem,
  type LibraryPage,
  type LibraryReadingStatus,
  type LibraryShelf,
  type LibrarySort,
  type LibraryTagStat,
  type RemoteReaderPage,
  type RemoteReaderPageStatus,
  type RemoteReaderSession,
  type RemoteReaderSessionSummary,
  type RemoteReaderBookmark,
  type SourceAdapterDescriptor,
  type SourceAuthStatus,
  type Task,
  type TaskKind,
  type TaskSearchResult,
  type TaskStatus,
} from "@/lib/api";
import {
  cancelableStatuses,
  clampPageNumber,
  compareLibraryItems,
  eventLabel,
  formatLastReadTime,
  hasLibraryReadingHistory,
  isLibraryComplete,
  isReaderMode,
  isReaderFit,
  kindLabel,
  libraryPageTotal,
  normalizeLibrarySearch,
  normalizeSearchText,
  readerFitLabel,
  readerFitStorageKey,
  readerModeLabel,
  readerModeStorageKey,
  readingProgressPercent,
  readingStatusLabel,
  rerunGalleryRequest,
  rerunRetryFolderRequest,
  rerunSearchRequest,
  searchableTaskText,
  statusLabel,
  splitTags,
  taskEventTypes,
  type LibraryReaderState,
  type LibraryViewMode,
  type Mode,
  type ReaderFit,
  type ReaderMode,
  type View,
} from "@/lib/dashboard-model";
import { TagAutocomplete } from "@/components/tag-autocomplete";
import {
  canonicalTag,
  expandExcludedTags,
  filterSearchResults,
  globalExcludedTagsStorageKey,
  normalizeTag,
  tagTranslations,
  uniqueTags,
} from "@/lib/tag-system";
import { readerLoadPlan } from "@/lib/reader-model";

const allSourcesValue = "__all_sources__";
const sourceAuthSourceId = "18comic";
const detailDrawerCloseMs = 220;
const readerScrollSyncDelayMs = 650;
const readerScrollObserverMargin = "-18% 0px -48% 0px";
const readerScrollObserverThresholds = [0, 0.1, 0.25, 0.45, 0.65];
const readerControlsCollapsedStorageKey = "manga-platform.reader-controls-collapsed";
const initialVisibleSearchResults = 10;
const searchResultRenderBatch = 10;

type RemoteReaderState = {
  session: RemoteReaderSession;
  page: RemoteReaderPage;
  total: number;
};

type RemoteReaderPreloadState = {
  sessionId: string;
  page: number;
  requested: number;
  loaded: number;
  failed: number;
  status: "loading" | "ready" | "failed";
};

type ReaderVisiblePageCandidate = {
  page: number;
  ratio: number;
  area: number;
};

type ReaderImageStatus = "loading" | "loaded" | "failed";
type ReaderPageUiStatus = "loading" | "ready" | "failed" | "unknown";

function visibleReaderPageFromEntries(entries: IntersectionObserverEntry[]) {
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

type InfiniteSearchResultsProps = {
  taskId: string;
  results: TaskSearchResult[];
  hasMore: boolean;
  loading: boolean;
  error?: string | null;
  renderResult: (result: TaskSearchResult) => ReactNode;
  onLoadMore: () => void;
};

function InfiniteSearchResults({
  taskId,
  results,
  hasMore,
  loading,
  error,
  renderResult,
  onLoadMore,
}: InfiniteSearchResultsProps) {
  const [visibleCount, setVisibleCount] = useState(Math.min(initialVisibleSearchResults, results.length));
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    setVisibleCount(Math.min(initialVisibleSearchResults, results.length));
  }, [taskId]);

  useEffect(() => {
    setVisibleCount((current) =>
      Math.min(results.length, Math.max(current, Math.min(initialVisibleSearchResults, results.length))),
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
        setVisibleCount((current) => Math.min(results.length, current + searchResultRenderBatch));
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
      <div className="detail-results">
        {displayedResults.map(renderResult)}
      </div>
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

export function Dashboard() {
  const [view, setView] = useState<View>("tasks");
  const [mode, setMode] = useState<Mode>("search");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [libraryTagStats, setLibraryTagStats] = useState<LibraryTagStat[]>([]);
  const [sources, setSources] = useState<SourceAdapterDescriptor[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState(allSourcesValue);
  const [sourceAuthOpen, setSourceAuthOpen] = useState(false);
  const [sourceAuthStatus, setSourceAuthStatus] = useState<SourceAuthStatus | null>(null);
  const [sourceAuthCookie, setSourceAuthCookie] = useState("");
  const [sourceAuthHeaders, setSourceAuthHeaders] = useState("");
  const [sourceAuthLoading, setSourceAuthLoading] = useState(false);
  const [logLines, setLogLines] = useState<string[]>(["console ready"]);
  const [loading, setLoading] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [eventStreamReady, setEventStreamReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [detailDrawerClosing, setDetailDrawerClosing] = useState(false);
  const [libraryDetails, setLibraryDetails] = useState<Record<string, LibraryDetail>>({});
  const [libraryDetailLoading, setLibraryDetailLoading] = useState(false);
  const [libraryExportHistory, setLibraryExportHistory] = useState<Record<string, LibraryExportResult[]>>({});
  const [libraryExportingKey, setLibraryExportingKey] = useState<string | null>(null);
  const [libraryRetryingId, setLibraryRetryingId] = useState<string | null>(null);
  const [libraryShelfSavingId, setLibraryShelfSavingId] = useState<string | null>(null);
  const [libraryBatchSaving, setLibraryBatchSaving] = useState(false);
  const [libraryBatchExportingFormat, setLibraryBatchExportingFormat] = useState<LibraryExportFormat | null>(null);
  const [libraryShelfDrafts, setLibraryShelfDrafts] = useState<Record<string, string>>({});
  const [libraryPages, setLibraryPages] = useState<Record<string, LibraryPage[]>>({});
  const [libraryPageTotals, setLibraryPageTotals] = useState<Record<string, number>>({});
  const [libraryPagesLoadingId, setLibraryPagesLoadingId] = useState<string | null>(null);
  const [libraryReader, setLibraryReader] = useState<LibraryReaderState | null>(null);
  const [libraryReaderFit, setLibraryReaderFit] = useState<ReaderFit>("width");
  const [readerMode, setReaderMode] = useState<ReaderMode>("single");
  const [readerControlsCollapsed, setReaderControlsCollapsed] = useState(true);
  const [libraryReaderLoading, setLibraryReaderLoading] = useState(false);
  const [libraryReaderPageInput, setLibraryReaderPageInput] = useState("1");
  const [remoteReader, setRemoteReader] = useState<RemoteReaderState | null>(null);
  const [remoteReaderPages, setRemoteReaderPages] = useState<Record<string, RemoteReaderPage[]>>({});
  const [remoteReaderPageStatuses, setRemoteReaderPageStatuses] = useState<Record<string, Record<number, RemoteReaderPageStatus>>>({});
  const [remoteReaderPreload, setRemoteReaderPreload] = useState<RemoteReaderPreloadState | null>(null);
  const [remoteReaderSessions, setRemoteReaderSessions] = useState<RemoteReaderSessionSummary[]>([]);
  const [remoteReaderSessionsLoading, setRemoteReaderSessionsLoading] = useState(false);
  const [remoteReaderLoading, setRemoteReaderLoading] = useState(false);
  const [remoteReaderMaintenanceKey, setRemoteReaderMaintenanceKey] = useState<string | null>(null);
  const [remoteReaderBookmarkSavingKey, setRemoteReaderBookmarkSavingKey] = useState<string | null>(null);
  const [remoteReaderPageInput, setRemoteReaderPageInput] = useState("1");
  const [remoteReaderQuery, setRemoteReaderQuery] = useState("");
  const [remoteReaderHistoryExpanded, setRemoteReaderHistoryExpanded] = useState(false);
  const [readerImageStates, setReaderImageStates] = useState<Record<string, ReaderImageStatus>>({});
  const [readerImageErrors, setReaderImageErrors] = useState<Record<string, string>>({});
  const [readerImageReloadKeys, setReaderImageReloadKeys] = useState<Record<string, number>>({});
  const [selectedResults, setSelectedResults] = useState<Record<string, string[]>>({});
  const [taskQuery, setTaskQuery] = useState("");
  const [taskKindFilter, setTaskKindFilter] = useState<TaskKind | "all">("all");
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatus | "all">("all");
  const [rerunningTaskId, setRerunningTaskId] = useState<string | null>(null);
  const [searchResultsLoadingTaskId, setSearchResultsLoadingTaskId] = useState<string | null>(null);

  const [tags, setTags] = useState("language:chinese female:big breasts");
  const [globalExcludedTags, setGlobalExcludedTags] = useState<string[]>([]);
  const [excludedTagDraft, setExcludedTagDraft] = useState("");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const [galleryUrl, setGalleryUrl] = useState("");
  const [retryFolder, setRetryFolder] = useState("");
  const [missingOnly, setMissingOnly] = useState(true);
  const [startPage, setStartPage] = useState("");
  const [endPage, setEndPage] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryTag, setLibraryTag] = useState("");
  const [libraryCompleteness, setLibraryCompleteness] = useState<LibraryCompleteness>("all");
  const [libraryHealthFilter, setLibraryHealthFilter] = useState<LibraryHealthFilter>("all");
  const [libraryReadingStatus, setLibraryReadingStatus] = useState<LibraryReadingStatus | "all">("all");
  const [libraryFailedOnly, setLibraryFailedOnly] = useState(false);
  const [libraryFavoriteOnly, setLibraryFavoriteOnly] = useState(false);
  const [libraryRecentOnly, setLibraryRecentOnly] = useState(false);
  const [librarySort, setLibrarySort] = useState<LibrarySort>("updated_desc");
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>("grid");
  const [selectedLibraryItems, setSelectedLibraryItems] = useState<Record<string, boolean>>({});
  const detailDrawerCloseTimer = useRef<number | null>(null);
  const libraryReaderStageRef = useRef<HTMLDivElement | null>(null);
  const remoteReaderStageRef = useRef<HTMLDivElement | null>(null);
  const libraryVisiblePageSaveTimer = useRef<number | null>(null);
  const remoteVisiblePageSaveTimer = useRef<number | null>(null);

  const libraryReaderObservedPageCount = libraryReader ? (libraryPages[libraryReader.item.id]?.length ?? 0) : 0;
  const remoteReaderObservedPageCount = remoteReader ? (remoteReaderPages[remoteReader.session.id]?.length ?? 0) : 0;

  useEffect(() => {
    let active = true;
    const source = createTaskEventsSource();

    Promise.all([listTasks(), listSources(), listLibrary(), listLibraryTags({ limit: 36 }), listRemoteReaderSessions()])
      .then(([nextTasks, nextSources, nextLibraryItems, nextLibraryTagStats, nextRemoteReaderSessions]) => {
        if (!active) {
          return;
        }
        setTasks(nextTasks);
        setSources(nextSources);
        setLibraryItems(nextLibraryItems);
        setLibraryTagStats(nextLibraryTagStats);
        setRemoteReaderSessions(nextRemoteReaderSessions);
        setSelectedSourceId((current) => current || allSourcesValue);
        pushLog(
          `loaded ${nextTasks.length} tasks, ${nextSources.length} sources, ${nextLibraryItems.length} library items, and ${nextRemoteReaderSessions.length} reader sessions`,
        );
      })
      .catch(handleError);

    const handleTaskEvent = (message: MessageEvent) => {
      const event = parseTaskEvent(message);
      mergeTask(event.task);
      pushLog(`${eventLabel[event.event]} ${kindLabel[event.task.kind]} ${event.task.id}`);
    };

    source.addEventListener("open", () => {
      if (!active) {
        return;
      }
      setEventStreamReady(true);
      pushLog("event stream connected");
    });
    taskEventTypes.forEach((eventType) => {
      source.addEventListener(eventType, handleTaskEvent);
    });
    source.onerror = () => {
      if (!active) {
        return;
      }
      setEventStreamReady(false);
    };

    return () => {
      active = false;
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!tasks.some((task) => task.status === "queued" || task.status === "running" || task.status === "paused")) {
      return;
    }

    const interval = window.setInterval(() => {
      listTasks()
        .then((nextTasks) => setTasks(nextTasks))
        .catch(() => undefined);
    }, 4000);

    return () => window.clearInterval(interval);
  }, [tasks]);

  useEffect(() => {
    return () => {
      if (detailDrawerCloseTimer.current !== null) {
        window.clearTimeout(detailDrawerCloseTimer.current);
      }
      if (libraryVisiblePageSaveTimer.current !== null) {
        window.clearTimeout(libraryVisiblePageSaveTimer.current);
      }
      if (remoteVisiblePageSaveTimer.current !== null) {
        window.clearTimeout(remoteVisiblePageSaveTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    try {
      const savedFit = window.localStorage.getItem(readerFitStorageKey);
      if (isReaderFit(savedFit)) {
        setLibraryReaderFit(savedFit);
      }
      const savedMode = window.localStorage.getItem(readerModeStorageKey);
      if (isReaderMode(savedMode)) {
        setReaderMode(savedMode);
      }
      const savedControlsCollapsed = window.localStorage.getItem(readerControlsCollapsedStorageKey);
      if (savedControlsCollapsed !== null) {
        setReaderControlsCollapsed(savedControlsCollapsed === "true");
      }
      const savedExcludedTags = window.localStorage.getItem(globalExcludedTagsStorageKey);
      if (savedExcludedTags) {
        const parsed = JSON.parse(savedExcludedTags);
        if (Array.isArray(parsed)) {
          setGlobalExcludedTags(uniqueTags(parsed.filter((tag): tag is string => typeof tag === "string")));
        }
      }
    } catch {
      // Local storage can be unavailable in privacy modes.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(readerFitStorageKey, libraryReaderFit);
    } catch {
      // Local storage can be unavailable in privacy modes.
    }
  }, [libraryReaderFit]);

  useEffect(() => {
    try {
      window.localStorage.setItem(readerModeStorageKey, readerMode);
    } catch {
      // Local storage can be unavailable in privacy modes.
    }
  }, [readerMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(readerControlsCollapsedStorageKey, String(readerControlsCollapsed));
    } catch {
      // Local storage can be unavailable in privacy modes.
    }
  }, [readerControlsCollapsed]);

  useEffect(() => {
    if ((!selectedTaskId && !selectedLibraryId) || libraryReader || remoteReader) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDetailDrawer();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [libraryReader, remoteReader, selectedLibraryId, selectedTaskId]);

  useEffect(() => {
    if (!libraryReader) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeLibraryReader();
        return;
      }

      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        void goToLibraryReaderPage(1);
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void goToLibraryReaderPage(-1);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        void jumpLibraryReaderToPage(1);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        void jumpLibraryReaderToPage(libraryReader.total);
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        cycleLibraryReaderFit();
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        cycleReaderMode();
        return;
      }

      if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        toggleReaderControls();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [libraryReader, libraryReaderLoading]);

  useEffect(() => {
    if (!libraryReader) {
      return;
    }
    setLibraryReaderPageInput(String(libraryReader.page.index));
  }, [libraryReader?.page.index]);

  useEffect(() => {
    if (!libraryReader) {
      return;
    }

    let active = true;
    const currentPage = libraryReader.page.index;
    const totalPages = Math.max(libraryReader.total, currentPage, 1);
    const plan = readerLoadPlan(currentPage, totalPages, readerMode);

    listLibraryPages(libraryReader.item.id, plan.startPage - 1, plan.count)
      .then((batch) => {
        if (!active) {
          return;
        }
        mergeLibraryPages(libraryReader.item.id, batch.items, batch.total);
        if (typeof window !== "undefined") {
          const eagerPages = new Set(plan.eagerPageIndexes);
          batch.items
            .filter((page) => eagerPages.has(page.index))
            .forEach((page) => {
              const image = new window.Image();
              image.src = apiUrl(page.url);
            });
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [libraryReader?.item.id, libraryReader?.page.index, libraryReader?.total, readerMode]);

  useEffect(() => {
    if (!remoteReader) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeRemoteReader();
        return;
      }

      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        void goToRemoteReaderPage(1);
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void goToRemoteReaderPage(-1);
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        void jumpRemoteReaderToPage(1);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        void jumpRemoteReaderToPage(remoteReader.total);
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        cycleLibraryReaderFit();
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        cycleReaderMode();
        return;
      }

      if (event.key.toLowerCase() === "h") {
        event.preventDefault();
        toggleReaderControls();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [remoteReader, remoteReaderLoading]);

  useEffect(() => {
    if (!remoteReader) {
      return;
    }
    setRemoteReaderPageInput(String(remoteReader.page.index));
  }, [remoteReader?.page.index]);

  useEffect(() => {
    if (!remoteReader) {
      setRemoteReaderPreload(null);
      return;
    }

    let active = true;
    const currentPage = remoteReader.page.index;
    const totalPages = Math.max(remoteReader.total, currentPage, 1);
    const plan = readerLoadPlan(currentPage, totalPages, readerMode);
    const expectedPreloadPages = plan.eagerPageIndexes.length;

    setRemoteReaderPreload({
      sessionId: remoteReader.session.id,
      page: currentPage,
      requested: expectedPreloadPages,
      loaded: 0,
      failed: 0,
      status: "loading",
    });

    listRemoteReaderPages(remoteReader.session.id, plan.startPage - 1, plan.count)
      .then((batch) => {
        if (!active) {
          return;
        }
        mergeRemoteReaderPages(remoteReader.session.id, batch.items, batch.total);
        void refreshRemoteReaderPageStatuses(remoteReader.session.id, plan.startPage - 1, plan.count);
        const eagerPages = new Set(plan.eagerPageIndexes);
        const pagesToPreload = batch.items.filter((page) => eagerPages.has(page.index));
        if (!pagesToPreload.length || typeof window === "undefined") {
          setRemoteReaderPreload({
            sessionId: remoteReader.session.id,
            page: currentPage,
            requested: pagesToPreload.length,
            loaded: pagesToPreload.length,
            failed: 0,
            status: "ready",
          });
          return;
        }

        let loaded = 0;
        let failed = 0;
        const settle = (ok: boolean) => {
          if (!active) {
            return;
          }
          if (ok) {
            loaded += 1;
          } else {
            failed += 1;
          }
          setRemoteReaderPreload({
            sessionId: remoteReader.session.id,
            page: currentPage,
            requested: pagesToPreload.length,
            loaded,
            failed,
            status: failed ? "failed" : loaded === pagesToPreload.length ? "ready" : "loading",
          });
        };

        pagesToPreload.forEach((page) => {
          const image = new window.Image();
          image.onload = () => {
            markReaderImageStatus(page.url, "loaded");
            settle(true);
          };
          image.onerror = () => {
            handleReaderImageError(page.url);
            settle(false);
          };
          image.src = readerImageSrc(page.url);
        });
      })
      .catch((caught) => {
        if (!active) {
          return;
        }
        setRemoteReaderPreload({
          sessionId: remoteReader.session.id,
          page: currentPage,
          requested: expectedPreloadPages,
          loaded: 0,
          failed: expectedPreloadPages || 1,
          status: "failed",
        });
        pushLog(`remote reader preload skipped: ${caught instanceof Error ? caught.message : String(caught)}`);
      });

    return () => {
      active = false;
    };
  }, [remoteReader?.session.id, remoteReader?.page.index, remoteReader?.total, readerMode]);

  useEffect(() => {
    if (
      !libraryReader ||
      readerMode !== "scroll" ||
      !libraryReaderStageRef.current ||
      typeof window === "undefined" ||
      !window.IntersectionObserver
    ) {
      return;
    }

    const stage = libraryReaderStageRef.current;
    const observer = new window.IntersectionObserver(
      (entries) => {
        const visiblePage = visibleReaderPageFromEntries(entries);
        if (visiblePage !== null) {
          syncLibraryVisibleScrollPage(visiblePage);
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
  }, [readerMode, libraryReader?.item.id, libraryReader?.page.index, libraryReaderObservedPageCount]);

  useEffect(() => {
    if (
      !remoteReader ||
      readerMode !== "scroll" ||
      !remoteReaderStageRef.current ||
      typeof window === "undefined" ||
      !window.IntersectionObserver
    ) {
      return;
    }

    const stage = remoteReaderStageRef.current;
    const observer = new window.IntersectionObserver(
      (entries) => {
        const visiblePage = visibleReaderPageFromEntries(entries);
        if (visiblePage !== null) {
          syncRemoteVisibleScrollPage(visiblePage);
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
  }, [readerMode, remoteReader?.session.id, remoteReader?.page.index, remoteReaderObservedPageCount]);

  const metrics = useMemo(() => {
    return {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === "queued").length,
      running: tasks.filter((task) => task.status === "running").length,
      failed: tasks.filter((task) => task.status === "failed").length,
    };
  }, [tasks]);
  const filteredTasks = useMemo(() => {
    const queryText = normalizeSearchText(taskQuery);

    return tasks.filter((task) => {
      if (taskKindFilter !== "all" && task.kind !== taskKindFilter) {
        return false;
      }
      if (taskStatusFilter !== "all" && task.status !== taskStatusFilter) {
        return false;
      }
      if (queryText && !searchableTaskText(task).includes(queryText)) {
        return false;
      }
      return true;
    });
  }, [taskKindFilter, taskQuery, tasks, taskStatusFilter]);
  const filteredLibraryItems = useMemo(() => {
    const queryText = normalizeLibrarySearch(libraryQuery);
    const tagText = normalizeLibrarySearch(libraryTag);

    return libraryItems
      .filter((item) => {
        if (queryText) {
          const searchable = normalizeLibrarySearch([item.title, item.folder, item.root, item.gallery_url ?? "", ...item.tags].join(" "));
          if (!searchable.includes(queryText)) {
            return false;
          }
        }

        if (tagText && !item.tags.some((tag) => normalizeLibrarySearch(tag).includes(tagText))) {
          return false;
        }

        if (libraryFailedOnly && item.failed_count <= 0) {
          return false;
        }

        if (libraryFavoriteOnly && !item.shelf.favorite) {
          return false;
        }

        if (libraryRecentOnly && !hasLibraryReadingHistory(item)) {
          return false;
        }

        if (libraryReadingStatus !== "all" && item.shelf.reading_status !== libraryReadingStatus) {
          return false;
        }

        if (libraryCompleteness === "complete" && !isLibraryComplete(item)) {
          return false;
        }
        if (libraryCompleteness === "incomplete" && isLibraryComplete(item)) {
          return false;
        }

        if (libraryHealthFilter !== "all") {
          const status = item.health?.status ?? "ok";
          if (libraryHealthFilter === "needs_attention") {
            if (status === "ok") {
              return false;
            }
          } else if (status !== libraryHealthFilter) {
            return false;
          }
        }

        return true;
      })
      .sort(compareLibraryItems(librarySort));
  }, [
    libraryCompleteness,
    libraryFailedOnly,
    libraryFavoriteOnly,
    libraryHealthFilter,
    libraryItems,
    libraryQuery,
    libraryReadingStatus,
    libraryRecentOnly,
    librarySort,
    libraryTag,
  ]);
  const recentLibraryItems = useMemo(() => {
    return libraryItems.filter(hasLibraryReadingHistory).sort(compareLibraryItems("last_read_desc")).slice(0, 5);
  }, [libraryItems]);
  const selectedLibraryList = useMemo(() => {
    return libraryItems.filter((item) => selectedLibraryItems[item.id]);
  }, [libraryItems, selectedLibraryItems]);
  const selectedLibraryCount = selectedLibraryList.length;
  const libraryBatchBusy = libraryBatchSaving || Boolean(libraryBatchExportingFormat);
  const allFilteredLibrarySelected = filteredLibraryItems.length > 0 && filteredLibraryItems.every((item) => selectedLibraryItems[item.id]);
  const libraryMetrics = useMemo(() => {
    return {
      total: libraryItems.length,
      images: libraryItems.reduce((sum, item) => sum + item.image_count, 0),
      failed: libraryItems.reduce((sum, item) => sum + item.failed_count, 0),
      healthFailed: libraryItems.filter((item) => item.health?.status === "failed").length,
      healthWarning: libraryItems.filter((item) => item.health?.status === "warning").length,
      healthOk: libraryItems.filter((item) => (item.health?.status ?? "ok") === "ok").length,
      reading: libraryItems.filter((item) => item.shelf.reading_status === "reading").length,
      favorites: libraryItems.filter((item) => item.shelf.favorite).length,
      recent: libraryItems.filter(hasLibraryReadingHistory).length,
    };
  }, [libraryItems]);
  const selectedTask = useMemo(() => {
    return selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) ?? null : null;
  }, [selectedTaskId, tasks]);
  const selectedLibrarySummary = useMemo(() => {
    return selectedLibraryId ? libraryItems.find((item) => item.id === selectedLibraryId) ?? null : null;
  }, [selectedLibraryId, libraryItems]);
  const selectedLibraryDetail = selectedLibraryId ? libraryDetails[selectedLibraryId] ?? null : null;
  const enabledSources = useMemo(() => sources.filter((source) => source.enabled), [sources]);
  const sourceAuthDescriptor = useMemo(() => sources.find((source) => source.id === sourceAuthSourceId) ?? null, [sources]);
  const shouldShowSourceAuthShortcut = Boolean(
    sourceAuthDescriptor && sourceAuthDescriptor.enabled && (selectedSourceId === allSourcesValue || selectedSourceId === sourceAuthSourceId),
  );
  const defaultSearchSources = useMemo(
    () => enabledSources.filter((source) => source.available_for_default !== false),
    [enabledSources],
  );
  const targetSourceIds = useMemo(() => {
    if (selectedSourceId === allSourcesValue) {
      return defaultSearchSources.map((source) => source.id);
    }
    const selectedSource = sources.find((source) => source.id === selectedSourceId);
    return selectedSource?.enabled ? [selectedSource.id] : [];
  }, [defaultSearchSources, selectedSourceId, sources]);
  const selectedSourceSummary =
    selectedSourceId === allSourcesValue
      ? `全部可用源站 (${defaultSearchSources.length}/${enabledSources.length})`
      : sources.find((source) => source.id === selectedSourceId)?.name || "未选择来源";
  const directRemoteReadableSources = useMemo(() => {
    if (selectedSourceId === allSourcesValue) {
      return enabledSources.filter(sourceDescriptorSupportsRemoteReading);
    }
    const selectedSource = sources.find((source) => source.id === selectedSourceId);
    return selectedSource && sourceDescriptorSupportsRemoteReading(selectedSource) ? [selectedSource] : [];
  }, [enabledSources, selectedSourceId, sources]);
  const directReaderMatchedSource = useMemo(
    () => sourceForGalleryUrl(galleryUrl, directRemoteReadableSources),
    [directRemoteReadableSources, galleryUrl],
  );
  const directReaderCanOpen = Boolean(galleryUrl.trim()) && directRemoteReadableSources.length > 0;
  const directReaderHint = useMemo(() => {
    if (!directRemoteReadableSources.length) {
      return "当前选择范围内没有支持在线阅读的源站";
    }
    if (directReaderMatchedSource) {
      return `将使用 ${directReaderMatchedSource.name} 打开`;
    }
    if (selectedSourceId !== allSourcesValue) {
      return `将尝试使用 ${directRemoteReadableSources[0].name} 打开`;
    }
    return "会按 URL 域名自动识别源站";
  }, [directReaderMatchedSource, directRemoteReadableSources, selectedSourceId]);
  const taskFiltersActive = Boolean(taskQuery || taskKindFilter !== "all" || taskStatusFilter !== "all");
  const libraryFiltersActive = Boolean(
    libraryQuery ||
      libraryTag ||
      libraryCompleteness !== "all" ||
      libraryHealthFilter !== "all" ||
      libraryReadingStatus !== "all" ||
      libraryFailedOnly ||
      libraryFavoriteOnly ||
      libraryRecentOnly ||
      librarySort !== "updated_desc",
  );

  async function refreshTasks() {
    setLoading(true);
    setError(null);
    try {
      const [nextTasks, nextSources] = await Promise.all([listTasks(), listSources()]);
      setTasks(nextTasks);
      setSources(nextSources);
      pushLog(`refreshed ${nextTasks.length} tasks and ${nextSources.length} sources`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function refreshLibrary() {
    setLibraryLoading(true);
    setError(null);
    try {
      const [nextLibraryItems, nextLibraryTagStats] = await Promise.all([listLibrary(), listLibraryTags({ limit: 36 })]);
      setLibraryItems(nextLibraryItems);
      setLibraryTagStats(nextLibraryTagStats);
      setLibraryDetails({});
      setLibraryExportHistory({});
      setLibraryPages({});
      setLibraryPageTotals({});
      setLibraryShelfDrafts({});
      pushLog(`refreshed ${nextLibraryItems.length} library item(s)`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryLoading(false);
    }
  }

  function refreshActiveView() {
    if (view === "library") {
      void refreshLibrary();
      return;
    }
    void refreshTasks();
    void refreshRemoteReaderSessions();
  }

  async function refreshSourceAuth(sourceId = sourceAuthSourceId) {
    setSourceAuthLoading(true);
    setError(null);
    try {
      const status = await getSourceAuth(sourceId);
      const nextSources = await listSources();
      setSourceAuthStatus(status);
      setSources(nextSources);
      pushLog(`loaded source auth status for ${sourceId}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setSourceAuthLoading(false);
    }
  }

  async function openSourceAuthPanel(sourceId = sourceAuthSourceId) {
    setSourceAuthOpen(true);
    await refreshSourceAuth(sourceId);
  }

  async function saveSourceAuthSettings() {
    if (!sourceAuthCookie.trim() && !sourceAuthHeaders.trim()) {
      setError("请先粘贴 Cookie 或请求头");
      return;
    }

    setSourceAuthLoading(true);
    setError(null);
    try {
      const status = await saveSourceAuth(sourceAuthSourceId, {
        cookie: sourceAuthCookie,
        headers: sourceAuthHeaders,
      });
      const nextSources = await listSources();
      setSourceAuthStatus(status);
      setSources(nextSources);
      setSourceAuthCookie("");
      setSourceAuthHeaders("");
      pushLog("saved 18comic source auth");
    } catch (caught) {
      handleError(caught);
    } finally {
      setSourceAuthLoading(false);
    }
  }

  async function clearSourceAuthSettings() {
    setSourceAuthLoading(true);
    setError(null);
    try {
      const status = await deleteSourceAuth(sourceAuthSourceId);
      const nextSources = await listSources();
      setSourceAuthStatus(status);
      setSources(nextSources);
      setSourceAuthCookie("");
      setSourceAuthHeaders("");
      pushLog("cleared 18comic source auth");
    } catch (caught) {
      handleError(caught);
    } finally {
      setSourceAuthLoading(false);
    }
  }

  function clearTaskFilters() {
    setTaskQuery("");
    setTaskKindFilter("all");
    setTaskStatusFilter("all");
  }

  function clearLibraryFilters() {
    setLibraryQuery("");
    setLibraryTag("");
    setLibraryCompleteness("all");
    setLibraryHealthFilter("all");
    setLibraryReadingStatus("all");
    setLibraryFailedOnly(false);
    setLibraryFavoriteOnly(false);
    setLibraryRecentOnly(false);
    setLibrarySort("updated_desc");
  }

  function isLibraryItemSelected(item: LibraryItem) {
    return Boolean(selectedLibraryItems[item.id]);
  }

  function toggleLibraryItemSelection(item: LibraryItem, selected?: boolean) {
    setSelectedLibraryItems((current) => {
      const nextSelected = selected ?? !current[item.id];
      if (!nextSelected) {
        const { [item.id]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [item.id]: true };
    });
  }

  function selectFilteredLibraryItems() {
    setSelectedLibraryItems((current) => ({
      ...current,
      ...Object.fromEntries(filteredLibraryItems.map((item) => [item.id, true])),
    }));
  }

  function toggleFilteredLibrarySelection() {
    if (allFilteredLibrarySelected) {
      setSelectedLibraryItems((current) => {
        const next = { ...current };
        filteredLibraryItems.forEach((item) => {
          delete next[item.id];
        });
        return next;
      });
      return;
    }
    selectFilteredLibraryItems();
  }

  function clearLibrarySelection() {
    setSelectedLibraryItems({});
  }

  async function applyBatchLibraryShelfPatch(patch: Parameters<typeof updateLibraryShelf>[1], label: string) {
    const targets = selectedLibraryList;
    if (!targets.length) {
      return;
    }

    setLibraryBatchSaving(true);
    setError(null);
    try {
      const updatedShelves = new Map<string, LibraryShelf>();
      for (const item of targets) {
        updatedShelves.set(item.id, await updateLibraryShelf(item.id, patch));
      }

      setLibraryItems((current) => current.map((item) => (updatedShelves.has(item.id) ? { ...item, shelf: updatedShelves.get(item.id)! } : item)));
      setLibraryDetails((current) => {
        const next = { ...current };
        for (const [itemId, shelf] of updatedShelves) {
          if (next[itemId]) {
            next[itemId] = { ...next[itemId], shelf };
          }
        }
        return next;
      });
      pushLog(`batch updated ${updatedShelves.size} library item(s): ${label}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryBatchSaving(false);
    }
  }

  async function exportSelectedLibraryItems(format: LibraryExportFormat) {
    const targets = selectedLibraryList.filter((item) => item.image_count > 0);
    if (!targets.length) {
      return;
    }

    setLibraryBatchExportingFormat(format);
    setError(null);
    try {
      const exportedResults: LibraryExportResult[] = [];
      for (const item of targets) {
        const result = format === "cbz" ? await createLibraryCbzExport(item.id) : await createLibraryPdfExport(item.id);
        exportedResults.push(result);
        setLibraryExportHistory((current) => ({
          ...current,
          [item.id]: [result, ...(current[item.id] ?? []).filter((exportItem) => exportItem.id !== result.id)],
        }));
      }
      pushLog(`batch exported ${exportedResults.length} ${format.toUpperCase()} file(s)`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryBatchExportingFormat(null);
    }
  }

  function showLibraryFailures() {
    setLibraryFailedOnly(true);
    setLibraryHealthFilter("all");
    setLibraryFavoriteOnly(false);
    setLibraryRecentOnly(false);
    setLibraryReadingStatus("all");
  }

  function showLibraryHealth(status: LibraryHealthFilter) {
    setLibraryHealthFilter(status);
    setLibraryFailedOnly(false);
    setLibraryFavoriteOnly(false);
    setLibraryRecentOnly(false);
    setLibraryReadingStatus("all");
  }

  function showLibraryReading() {
    setLibraryFailedOnly(false);
    setLibraryHealthFilter("all");
    setLibraryFavoriteOnly(false);
    setLibraryRecentOnly(false);
    setLibraryReadingStatus("reading");
  }

  function showLibraryFavorites() {
    setLibraryFailedOnly(false);
    setLibraryHealthFilter("all");
    setLibraryFavoriteOnly(true);
    setLibraryRecentOnly(false);
    setLibraryReadingStatus("all");
  }

  function showLibraryRecent() {
    setLibraryFailedOnly(false);
    setLibraryHealthFilter("all");
    setLibraryFavoriteOnly(false);
    setLibraryRecentOnly(true);
    setLibraryReadingStatus("all");
    setLibrarySort("last_read_desc");
  }

  function cancelDetailDrawerClose() {
    if (detailDrawerCloseTimer.current !== null) {
      window.clearTimeout(detailDrawerCloseTimer.current);
      detailDrawerCloseTimer.current = null;
    }
    setDetailDrawerClosing(false);
  }

  function openTaskDetail(taskId: string) {
    cancelDetailDrawerClose();
    setSelectedLibraryId(null);
    setSelectedTaskId(taskId);
  }

  function closeDetailDrawer() {
    if (!selectedTaskId && !selectedLibraryId) {
      return;
    }
    if (detailDrawerClosing) {
      return;
    }

    setDetailDrawerClosing(true);
    detailDrawerCloseTimer.current = window.setTimeout(() => {
      setSelectedTaskId(null);
      setSelectedLibraryId(null);
      setDetailDrawerClosing(false);
      detailDrawerCloseTimer.current = null;
    }, detailDrawerCloseMs);
  }

  function filterLibraryByTag(tag: string) {
    setLibraryTag(tag);
    closeDetailDrawer();
    setView("library");
    pushLog(`filtered library by tag ${tag}`);
  }

  async function openLibraryDetail(item: LibraryItem) {
    cancelDetailDrawerClose();
    setSelectedTaskId(null);
    setSelectedLibraryId(item.id);
    setLibraryDetailLoading(true);
    setError(null);
    try {
      const detailPromise = libraryDetails[item.id] ? Promise.resolve(libraryDetails[item.id]) : getLibraryDetail(item.id);
      const [detail, exports] = await Promise.all([detailPromise, listLibraryExports(item.id)]);
      setLibraryDetails((current) => ({ ...current, [item.id]: detail }));
      setLibraryExportHistory((current) => ({ ...current, [item.id]: exports }));
      setLibraryPages((current) => (current[item.id]?.length ? current : { ...current, [item.id]: detail.pages }));
      setLibraryPageTotals((current) => ({ ...current, [item.id]: detail.pages_total ?? detail.pages.length }));
      setLibraryShelfDrafts((current) => ({ ...current, [item.id]: detail.shelf.note }));
      pushLog(`loaded library detail ${detail.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryDetailLoading(false);
    }
  }

  async function exportLibrary(item: LibraryItem, format: LibraryExportFormat) {
    const key = libraryExportKey(item.id, format);
    setLibraryExportingKey(key);
    setError(null);
    try {
      const result = format === "cbz" ? await createLibraryCbzExport(item.id) : await createLibraryPdfExport(item.id);
      setLibraryExportHistory((current) => ({
        ...current,
        [item.id]: [result, ...(current[item.id] ?? []).filter((exportItem) => exportItem.id !== result.id)],
      }));
      pushLog(`exported ${format.toUpperCase()} ${result.output_file}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryExportingKey(null);
    }
  }

  async function refreshLibraryExports(item: LibraryItem) {
    setLibraryDetailLoading(true);
    setError(null);
    try {
      const exports = await listLibraryExports(item.id);
      setLibraryExportHistory((current) => ({ ...current, [item.id]: exports }));
      pushLog(`refreshed export history for ${item.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryDetailLoading(false);
    }
  }

  async function createLibraryRetryTask(item: LibraryItem) {
    setLibraryRetryingId(item.id);
    setError(null);
    try {
      const task = await createRetryFolderTask({
        source_id: item.source_id,
        folder: item.folder,
        missing_only: true,
      });
      mergeTask(task);
      openTaskDetail(task.id);
      setView("tasks");
      pushLog(`created retry task from library ${item.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryRetryingId(null);
    }
  }

  function mergeLibraryPages(itemId: string, pages: LibraryPage[], total?: number) {
    if (typeof total === "number") {
      setLibraryPageTotals((current) => ({ ...current, [itemId]: total }));
    }
    if (!pages.length) {
      return;
    }
    setLibraryPages((current) => {
      const existing = current[itemId] ?? [];
      const merged = new Map(existing.map((page) => [page.filename, page]));
      pages.forEach((page) => merged.set(page.filename, page));
      return {
        ...current,
        [itemId]: Array.from(merged.values()).sort((left, right) => left.index - right.index),
      };
    });
  }

  function mergeRemoteReaderPages(sessionId: string, pages: RemoteReaderPage[], total?: number) {
    if (!pages.length && typeof total !== "number") {
      return;
    }
    setRemoteReaderPages((current) => {
      const existing = current[sessionId] ?? [];
      const merged = new Map(existing.map((page) => [page.index, page]));
      pages.forEach((page) => merged.set(page.index, page));
      return {
        ...current,
        [sessionId]: Array.from(merged.values()).sort((left, right) => left.index - right.index),
      };
    });
    if (typeof total === "number") {
      setRemoteReader((current) => (current?.session.id === sessionId ? { ...current, total } : current));
    }
  }

  function mergeRemoteReaderPageStatuses(sessionId: string, statuses: RemoteReaderPageStatus[]) {
    if (!statuses.length) {
      return;
    }
    setRemoteReaderPageStatuses((current) => {
      const existing = current[sessionId] ?? {};
      const next = { ...existing };
      statuses.forEach((status) => {
        next[status.page_index] = status;
      });
      return { ...current, [sessionId]: next };
    });
  }

  function mergeRemoteReaderPageStatus(status: RemoteReaderPageStatus) {
    mergeRemoteReaderPageStatuses(status.session_id, [status]);
  }

  async function refreshRemoteReaderPageStatuses(sessionId: string, offset = 0, limit = 24) {
    try {
      const batch = await listRemoteReaderPageStatuses(sessionId, offset, limit);
      mergeRemoteReaderPageStatuses(sessionId, batch.items);
    } catch (caught) {
      pushLog(`reader page status refresh skipped: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  function mergeRemoteReaderSessionSummary(summary: RemoteReaderSessionSummary) {
    setRemoteReaderSessions((current) => {
      const next = [summary, ...current.filter((session) => session.id !== summary.id)];
      return next
        .sort((left, right) => remoteReaderSessionSortTime(right).localeCompare(remoteReaderSessionSortTime(left)))
        .slice(0, 12);
    });
  }

  function applyRemoteReaderSessionSummary(summary: RemoteReaderSessionSummary) {
    mergeRemoteReaderSessionSummary(summary);
    setRemoteReader((current) =>
      current?.session.id === summary.id
        ? {
            ...current,
            session: {
              ...current.session,
              ...summary,
            },
          }
        : current,
    );
  }

  function remoteReaderSessionSortTime(session: RemoteReaderSessionSummary) {
    return String(session.last_read_at || session.updated_at || session.created_at || "");
  }

  async function refreshRemoteReaderSessions() {
    setRemoteReaderSessionsLoading(true);
    setError(null);
    try {
      const sessions = await listRemoteReaderSessions();
      setRemoteReaderSessions(sessions);
      pushLog(`loaded ${sessions.length} remote reader session(s)`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderSessionsLoading(false);
    }
  }

  function clearReaderImageLocalState(urls: string[]) {
    if (!urls.length) {
      return;
    }
    const urlSet = new Set(urls);
    setReaderImageStates((current) => {
      const next = { ...current };
      urlSet.forEach((url) => {
        delete next[url];
      });
      return next;
    });
    setReaderImageErrors((current) => {
      const next = { ...current };
      urlSet.forEach((url) => {
        delete next[url];
      });
      return next;
    });
    setReaderImageReloadKeys((current) => {
      const next = { ...current };
      urlSet.forEach((url) => {
        delete next[url];
      });
      return next;
    });
  }

  function bumpReaderImageReloadKeys(urls: string[]) {
    if (!urls.length) {
      return;
    }
    const now = Date.now();
    setReaderImageStates((current) => {
      const next = { ...current };
      urls.forEach((url) => {
        next[url] = "loading";
      });
      return next;
    });
    setReaderImageErrors((current) => {
      const next = { ...current };
      urls.forEach((url) => {
        delete next[url];
      });
      return next;
    });
    setReaderImageReloadKeys((current) => {
      const next = { ...current };
      urls.forEach((url, index) => {
        next[url] = Math.max(now + index, (current[url] ?? 0) + 1);
      });
      return next;
    });
  }

  function clearRemoteReaderLocalState(sessionId: string) {
    const urls = remoteReaderPages[sessionId]?.map((page) => page.url) ?? [];
    clearReaderImageLocalState(urls);
    setRemoteReaderPages((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setRemoteReaderPageStatuses((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  async function deleteRemoteReaderHistory(session: RemoteReaderSessionSummary) {
    const maintenanceKey = `delete:${session.id}`;
    setRemoteReaderMaintenanceKey(maintenanceKey);
    setError(null);
    try {
      await deleteRemoteReaderSession(session.id);
      setRemoteReaderSessions((current) => current.filter((item) => item.id !== session.id));
      clearRemoteReaderLocalState(session.id);
      if (remoteReader?.session.id === session.id) {
        setRemoteReader(null);
        setRemoteReaderPreload(null);
      }
      pushLog(`deleted remote reader session ${session.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderMaintenanceKey(null);
    }
  }

  async function clearRemoteReaderCurrentPageCache(reader: RemoteReaderState) {
    const maintenanceKey = `clear-page:${reader.session.id}:${reader.page.index}`;
    setRemoteReaderMaintenanceKey(maintenanceKey);
    setError(null);
    try {
      await clearRemoteReaderSessionCache(reader.session.id, { page_index: reader.page.index });
      setRemoteReaderPageStatuses((current) => {
        const sessionStatuses = { ...(current[reader.session.id] ?? {}) };
        delete sessionStatuses[reader.page.index];
        return { ...current, [reader.session.id]: sessionStatuses };
      });
      retryReaderImage(reader.page.url);
      pushLog(`cleared remote reader cache p${reader.page.index}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderMaintenanceKey(null);
    }
  }

  async function clearRemoteReaderAllCache(reader: RemoteReaderState) {
    const maintenanceKey = `clear-session:${reader.session.id}`;
    setRemoteReaderMaintenanceKey(maintenanceKey);
    setError(null);
    try {
      await clearRemoteReaderSessionCache(reader.session.id);
      const knownPages = remoteReaderKnownPages(reader);
      bumpReaderImageReloadKeys(knownPages.map((page) => page.url));
      setRemoteReaderPageStatuses((current) => ({ ...current, [reader.session.id]: {} }));
      pushLog(`cleared remote reader cache for ${reader.session.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderMaintenanceKey(null);
    }
  }

  async function clearRemoteReaderHistoryCache(session: RemoteReaderSessionSummary) {
    const maintenanceKey = `clear-session:${session.id}`;
    setRemoteReaderMaintenanceKey(maintenanceKey);
    setError(null);
    try {
      await clearRemoteReaderSessionCache(session.id);
      clearRemoteReaderLocalState(session.id);
      pushLog(`cleared remote reader cache for ${session.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderMaintenanceKey(null);
    }
  }

  function remoteReaderBookmarks(session: Pick<RemoteReaderSessionSummary, "bookmarks">): RemoteReaderBookmark[] {
    return [...(session.bookmarks ?? [])].sort((left, right) => left.page_index - right.page_index);
  }

  function remoteReaderBookmarkForPage(session: Pick<RemoteReaderSessionSummary, "bookmarks">, pageIndex: number) {
    return remoteReaderBookmarks(session).find((bookmark) => bookmark.page_index === pageIndex) ?? null;
  }

  async function toggleRemoteReaderBookmark(reader: RemoteReaderState) {
    const pageIndex = reader.page.index;
    const savingKey = `${reader.session.id}:${pageIndex}`;
    const existingBookmark = remoteReaderBookmarkForPage(reader.session, pageIndex);
    setRemoteReaderBookmarkSavingKey(savingKey);
    setError(null);
    try {
      const summary = existingBookmark
        ? await deleteRemoteReaderBookmark(reader.session.id, pageIndex)
        : await createRemoteReaderBookmark(reader.session.id, {
            page_index: pageIndex,
            label: `p${pageIndex}`,
          });
      applyRemoteReaderSessionSummary(summary);
      pushLog(`${existingBookmark ? "removed" : "added"} remote reader bookmark p${pageIndex}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderBookmarkSavingKey(null);
    }
  }

  async function removeRemoteReaderBookmark(sessionId: string, pageIndex: number) {
    const savingKey = `${sessionId}:${pageIndex}`;
    setRemoteReaderBookmarkSavingKey(savingKey);
    setError(null);
    try {
      const summary = await deleteRemoteReaderBookmark(sessionId, pageIndex);
      applyRemoteReaderSessionSummary(summary);
      pushLog(`removed remote reader bookmark p${pageIndex}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderBookmarkSavingKey(null);
    }
  }

  async function updateShelfForItem(item: LibraryItem, patch: Parameters<typeof updateLibraryShelf>[1]): Promise<LibraryShelf | null> {
    setLibraryShelfSavingId(item.id);
    setError(null);
    try {
      const shelf = await updateLibraryShelf(item.id, patch);
      setLibraryItems((current) => current.map((libraryItem) => (libraryItem.id === item.id ? { ...libraryItem, shelf } : libraryItem)));
      setLibraryDetails((current) => {
        const detail = current[item.id];
        return detail ? { ...current, [item.id]: { ...detail, shelf } } : current;
      });
      setLibraryShelfDrafts((current) => ({ ...current, [item.id]: shelf.note }));
      setLibraryReader((current) => (current?.item.id === item.id ? { ...current, item: { ...current.item, shelf } } : current));
      pushLog(`updated shelf state for ${item.title}`);
      return shelf;
    } catch (caught) {
      handleError(caught);
      return null;
    } finally {
      setLibraryShelfSavingId(null);
    }
  }

  async function markLibraryPageRead(item: LibraryItem, page: number) {
    const nextStatus: LibraryReadingStatus = page >= libraryPageTotal(item) ? "finished" : "reading";
    return updateShelfForItem(item, { last_page: page, reading_status: nextStatus });
  }

  function syncLibraryVisibleScrollPage(pageNumber: number) {
    if (!libraryReader || readerMode !== "scroll") {
      return;
    }

    const page = (libraryPages[libraryReader.item.id] ?? []).find((candidate) => candidate.index === pageNumber);
    if (!page || page.index === libraryReader.page.index) {
      return;
    }

    const item = libraryReader.item;
    const total = Math.max(libraryReader.total, libraryPageTotal(item));
    setLibraryReader((current) => (current?.item.id === item.id ? { ...current, page, total: Math.max(current.total, total) } : current));
    setLibraryReaderPageInput(String(page.index));

    if (libraryVisiblePageSaveTimer.current !== null) {
      window.clearTimeout(libraryVisiblePageSaveTimer.current);
    }
    libraryVisiblePageSaveTimer.current = window.setTimeout(() => {
      libraryVisiblePageSaveTimer.current = null;
      const readingStatus: LibraryReadingStatus = page.index >= total ? "finished" : "reading";
      void updateShelfForItem(item, { last_page: page.index, reading_status: readingStatus });
    }, readerScrollSyncDelayMs);
  }

  function syncRemoteVisibleScrollPage(pageNumber: number) {
    if (!remoteReader || readerMode !== "scroll") {
      return;
    }

    const page = (remoteReaderPages[remoteReader.session.id] ?? []).find((candidate) => candidate.index === pageNumber);
    if (!page || page.index === remoteReader.page.index) {
      return;
    }

    const sessionId = remoteReader.session.id;
    setRemoteReader((current) =>
      current?.session.id === sessionId ? { ...current, page, total: Math.max(current.total, page.index) } : current,
    );
    setRemoteReaderPageInput(String(page.index));

    if (remoteVisiblePageSaveTimer.current !== null) {
      window.clearTimeout(remoteVisiblePageSaveTimer.current);
    }
    remoteVisiblePageSaveTimer.current = window.setTimeout(() => {
      remoteVisiblePageSaveTimer.current = null;
      void updateRemoteReaderProgress(sessionId, { last_page: page.index })
        .then((summary) => {
          mergeRemoteReaderSessionSummary(summary);
          setRemoteReader((current) =>
            current?.session.id === sessionId
              ? {
                  ...current,
                  session: {
                    ...current.session,
                    last_page: summary.last_page,
                    last_read_at: summary.last_read_at,
                    updated_at: summary.updated_at,
                  },
                }
              : current,
          );
        })
        .catch((caught) => {
          pushLog(`remote reader progress skipped: ${caught instanceof Error ? caught.message : String(caught)}`);
        });
    }, readerScrollSyncDelayMs);
  }

  async function openLibraryReadingPage(item: LibraryItem) {
    await openLibraryReader(item, item.shelf.last_page ?? 1);
  }

  function sourceDescriptorSupportsRemoteReading(source?: SourceAdapterDescriptor | null) {
    if (!source || source.enabled === false) {
      return false;
    }
    return (
      source.capabilities.includes("online_read") ||
      (source.capabilities.includes("page_list") && source.capabilities.includes("page_image"))
    );
  }

  function sourceSupportsRemoteReading(sourceId: string) {
    return sourceDescriptorSupportsRemoteReading(sources.find((candidate) => candidate.id === sourceId));
  }

  function remoteReadableSourceIds() {
    return targetSourceIds.filter((sourceId) => sourceSupportsRemoteReading(sourceId));
  }

  function sourceForGalleryUrl(urlValue: string, candidates: SourceAdapterDescriptor[]) {
    const galleryHost = normalizedHost(urlValue);
    if (!galleryHost) {
      return null;
    }
    return candidates.find((source) => {
      const sourceHost = normalizedHost(source.homepage ?? "");
      return Boolean(sourceHost && hostsMatch(galleryHost, sourceHost));
    });
  }

  function normalizedHost(urlValue: string) {
    const trimmed = urlValue.trim();
    if (!trimmed) {
      return null;
    }
    try {
      return new URL(trimmed).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function hostsMatch(candidateHost: string, sourceHost: string) {
    return candidateHost === sourceHost || candidateHost.endsWith(`.${sourceHost}`);
  }

  function visibleSearchSourceErrors(output: Extract<NonNullable<Task["output"]>, { type: "search_results" }>) {
    const sourceIds = output.source_ids ?? [];
    const wasMergedDefaultRun = sourceIds.length > 1;
    return (output.source_errors ?? []).filter((sourceError) => {
      if (!wasMergedDefaultRun) {
        return true;
      }
      const source = sources.find((candidate) => candidate.id === sourceError.source_id);
      return source?.available_for_default !== false;
    });
  }

  function searchResultThumbnailSrc(result: TaskSearchResult) {
    const value = result.thumbnail_url?.trim();
    if (!value || isBadSearchThumbnailUrl(value)) {
      return null;
    }
    const params = new URLSearchParams({
      source_id: result.source_id,
      url: value,
      referer: result.gallery_url,
    });
    return apiUrl(`/v1/search-thumbnails?${params.toString()}`);
  }

  function isBadSearchThumbnailUrl(value: string) {
    try {
      const parsed = new URL(value, "http://local.invalid");
      const host = parsed.hostname.toLowerCase();
      const path = safeDecodeURIComponent(parsed.pathname).toLowerCase();
      const filename = path.split("/").pop() ?? "";
      const stem = filename.split(".")[0] ?? "";
      const badFileNames = new Set([
        "blank.gif",
        "blank.png",
        "favicon.ico",
        "loading.gif",
        "loading.png",
        "noimage.gif",
        "noimage.png",
        "pixel.gif",
        "spacer.gif",
        "t.png",
        "td.png",
        "transparent.gif",
      ]);
      const badNameParts = ["arrow", "blank", "button", "download", "favicon", "icon", "loader", "loading", "placeholder", "pixel", "sprite"];
      if (!filename || badFileNames.has(filename)) {
        return true;
      }
      if (host.endsWith("ehgt.org") && (path === "/g/t.png" || path === "/g/td.png")) {
        return true;
      }
      if (host.endsWith("ehgt.org") && path.startsWith("/g/") && stem.length <= 2) {
        return true;
      }
      return badNameParts.some((part) => filename.includes(part));
    } catch {
      return true;
    }
  }

  function safeDecodeURIComponent(value: string) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function renderSearchResultThumbnail(result: TaskSearchResult) {
    const src = searchResultThumbnailSrc(result);
    return (
      <a className={src ? "result-thumbnail" : "result-thumbnail empty"} href={result.gallery_url} target="_blank" rel="noreferrer" aria-label={`打开来源：${result.title}`}>
        <span className="result-thumbnail-fallback">
          <Image size={22} aria-hidden />
          <span>暂无封面</span>
        </span>
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(event) => {
              event.currentTarget.hidden = true;
              event.currentTarget.parentElement?.classList.add("empty");
            }}
          />
        ) : null}
      </a>
    );
  }

  async function openRemoteReader(result: TaskSearchResult) {
    await openRemoteReaderSession(result.source_id, result.gallery_url, result.title);
  }

  async function showRemoteReaderSessionPage(session: RemoteReaderSession, requestedPage = 1) {
    const total = Math.max(session.page_count, session.pages.total, 1);
    const targetPage = clampPageNumber(requestedPage, total);
    const batch =
      targetPage === 1 && session.pages.items.some((page) => page.index === 1)
        ? session.pages
        : await listRemoteReaderPages(session.id, targetPage - 1, 1);
    const page = batch.items[0];
    if (!page) {
      throw new Error("No readable page was returned for this gallery.");
    }

    mergeRemoteReaderPages(session.id, batch.items, batch.total);
    const nextSession = {
      ...session,
      page_count: batch.total,
      pages: batch,
      last_page: page.index,
    };
    setRemoteReader({
      session: nextSession,
      page,
      total: batch.total,
    });

    const summary = await updateRemoteReaderProgress(session.id, { last_page: page.index });
    mergeRemoteReaderSessionSummary(summary);
    setRemoteReader((current) =>
      current?.session.id === session.id
        ? {
            ...current,
            session: {
              ...current.session,
              last_page: summary.last_page,
              last_read_at: summary.last_read_at,
              updated_at: summary.updated_at,
            },
          }
        : current,
    );
    return page;
  }

  async function openRemoteReaderSession(sourceId: string, galleryUrlValue: string, title?: string) {
    setRemoteReaderLoading(true);
    setLibraryReader(null);
    setError(null);
    try {
      const session = await createRemoteReaderSession({
        source_id: sourceId,
        gallery_url: galleryUrlValue,
        title,
      });
      const page = await showRemoteReaderSessionPage(session, session.last_page ?? 1);
      pushLog(`opened remote reader p${page.index} for ${session.title}`);
      return session;
    } catch (caught) {
      handleError(caught);
      return null;
    } finally {
      setRemoteReaderLoading(false);
    }
  }

  async function openDirectRemoteReader() {
    const url = galleryUrl.trim();
    if (!url) {
      setError("请输入图库 URL。");
      return;
    }
    if (!directRemoteReadableSources.length) {
      setError("当前选择范围内没有支持在线阅读的源站。");
      return;
    }

    setRemoteReaderLoading(true);
    setLibraryReader(null);
    setError(null);
    try {
      const selectedSource = selectedSourceId === allSourcesValue ? directReaderMatchedSource : directRemoteReadableSources[0];
      const session = await createRemoteReaderSession({
        ...(selectedSource ? { source_id: selectedSource.id } : {}),
        gallery_url: url,
        title: url,
      });
      const page = await showRemoteReaderSessionPage(session, session.last_page ?? 1);
      pushLog(`opened direct remote reader p${page.index} via ${session.source_name}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderLoading(false);
    }
  }

  async function resumeRemoteReaderSession(summary: RemoteReaderSessionSummary) {
    setRemoteReaderLoading(true);
    setLibraryReader(null);
    setError(null);
    try {
      const session = await getRemoteReaderSession(summary.id);
      const page = await showRemoteReaderSessionPage(session, summary.last_page ?? session.last_page ?? 1);
      pushLog(`resumed remote reader p${page.index} for ${session.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderLoading(false);
    }
  }

  async function openRemoteReaderPage(session: RemoteReaderSession, requestedPage = 1) {
    const targetPage = clampPageNumber(requestedPage, Math.max(remoteReader?.total ?? session.page_count, 1));
    setRemoteReaderLoading(true);
    setError(null);
    try {
      const batch = await listRemoteReaderPages(session.id, targetPage - 1, 1);
      const page = batch.items[0];
      if (!page) {
        throw new Error("No readable page was returned for this gallery.");
      }
      mergeRemoteReaderPages(session.id, [page], batch.total);
      const nextSession = { ...session, page_count: batch.total, pages: batch, last_page: page.index };
      setRemoteReader({ session: nextSession, page, total: batch.total });
      const summary = await updateRemoteReaderProgress(session.id, { last_page: page.index });
      mergeRemoteReaderSessionSummary(summary);
      setRemoteReader((current) =>
        current?.session.id === session.id
          ? {
              ...current,
              session: {
                ...current.session,
                last_page: summary.last_page,
                last_read_at: summary.last_read_at,
                updated_at: summary.updated_at,
              },
            }
          : current,
      );
      pushLog(`opened remote reader p${page.index} for ${session.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRemoteReaderLoading(false);
    }
  }

  async function goToRemoteReaderPage(delta: number) {
    if (!remoteReader || remoteReaderLoading) {
      return;
    }
    const nextPage = clampPageNumber(remoteReader.page.index + delta, remoteReader.total);
    if (nextPage === remoteReader.page.index) {
      return;
    }
    await openRemoteReaderPage(remoteReader.session, nextPage);
  }

  async function jumpRemoteReaderToPage(page: number) {
    if (!remoteReader || remoteReaderLoading) {
      return;
    }
    const nextPage = clampPageNumber(page, remoteReader.total);
    if (nextPage === remoteReader.page.index) {
      setRemoteReaderPageInput(String(nextPage));
      return;
    }
    await openRemoteReaderPage(remoteReader.session, nextPage);
  }

  async function submitRemoteReaderJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await jumpRemoteReaderToPage(Number(remoteReaderPageInput));
  }

  function closeRemoteReader() {
    setRemoteReader(null);
    setRemoteReaderPreload(null);
    setRemoteReaderLoading(false);
  }

  async function openLibraryReader(item: LibraryItem, requestedPage = 1) {
    const knownTotal = libraryPageTotals[item.id] ?? libraryPageTotal(item);
    const targetPage = clampPageNumber(requestedPage, knownTotal);
    setLibraryPagesLoadingId(item.id);
    setLibraryReaderLoading(true);
    setRemoteReader(null);
    setRemoteReaderPreload(null);
    setError(null);
    try {
      const batch = await listLibraryPages(item.id, targetPage - 1, 1);
      const page = batch.items[0];
      if (!page) {
        throw new Error("没有找到可阅读页面");
      }
      mergeLibraryPages(item.id, [page], batch.total);
      const shelf = await markLibraryPageRead(item, page.index);
      setLibraryReader({
        item: shelf ? { ...item, shelf } : item,
        page,
        total: batch.total,
      });
      pushLog(`opened reader p${page.index} for ${item.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryPagesLoadingId(null);
      setLibraryReaderLoading(false);
    }
  }

  async function goToLibraryReaderPage(delta: number) {
    if (!libraryReader || libraryReaderLoading) {
      return;
    }
    const nextPage = clampPageNumber(libraryReader.page.index + delta, libraryReader.total);
    if (nextPage === libraryReader.page.index) {
      return;
    }
    await openLibraryReader(libraryReader.item, nextPage);
  }

  async function jumpLibraryReaderToPage(page: number) {
    if (!libraryReader || libraryReaderLoading) {
      return;
    }
    const nextPage = clampPageNumber(page, libraryReader.total);
    if (nextPage === libraryReader.page.index) {
      setLibraryReaderPageInput(String(nextPage));
      return;
    }
    await openLibraryReader(libraryReader.item, nextPage);
  }

  async function submitLibraryReaderJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestedPage = Number(libraryReaderPageInput);
    await jumpLibraryReaderToPage(requestedPage);
  }

  function closeLibraryReader() {
    setLibraryReader(null);
    setLibraryReaderLoading(false);
  }

  function cycleLibraryReaderFit() {
    setLibraryReaderFit((current) => (current === "width" ? "height" : current === "height" ? "original" : "width"));
  }

  function cycleReaderMode() {
    setReaderMode((current) => (current === "single" ? "scroll" : "single"));
  }

  function toggleReaderControls() {
    setReaderControlsCollapsed((current) => !current);
  }

  async function loadMoreLibraryPages(item: LibraryItem) {
    const currentPages = libraryPages[item.id] ?? [];
    setLibraryPagesLoadingId(item.id);
    setError(null);
    try {
      const batch = await listLibraryPages(item.id, currentPages.length, 24);
      mergeLibraryPages(item.id, batch.items, batch.total);
      pushLog(`loaded ${batch.items.length} more page(s) for ${item.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLibraryPagesLoadingId(null);
    }
  }

  async function loadMoreTaskSearchResults(task: Task) {
    if (searchResultsLoadingTaskId === task.id || task.output?.type !== "search_results") {
      return;
    }
    setSearchResultsLoadingTaskId(task.id);
    setError(null);
    try {
      const updatedTask = await loadMoreSearchTaskResults(task.id);
      mergeTask(updatedTask);
      pushLog(`loaded more search results for ${task.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setSearchResultsLoadingTaskId(null);
    }
  }

  function collapseLibraryPages(item: LibraryItem) {
    setLibraryPages((current) => ({ ...current, [item.id]: (current[item.id] ?? []).slice(0, 24) }));
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (!targetSourceIds.length) {
        throw new Error("没有可用源站。");
      }

      const parsedTags = splitTags(tags);
      const createdTasks =
        mode === "search"
          ? [
              await createSearchTask({
                source_ids: targetSourceIds,
                tags: parsedTags,
                excluded_tags: expandExcludedTags(globalExcludedTags),
                name: name.trim() || undefined,
                query: query.trim() || undefined,
                limit,
              }),
            ]
          : await Promise.all(
              targetSourceIds.map((sourceId) =>
                mode === "gallery"
                  ? createGalleryTask({
                      source_id: sourceId,
                      gallery_url: galleryUrl.trim(),
                    })
                  : createRetryFolderTask({
                      source_id: sourceId,
                      folder: retryFolder.trim(),
                      missing_only: missingOnly,
                      start_page: startPage ? Number(startPage) : undefined,
                      end_page: endPage ? Number(endPage) : undefined,
                    }),
              ),
            );

      createdTasks.forEach(mergeTask);
      const firstTask = createdTasks[0];
      if (mode === "search") {
        openTaskDetail(firstTask.id);
      }
      pushLog(`created ${createdTasks.length} ${kindLabel[firstTask.kind]} task(s) via ${selectedSourceSummary}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function rerunTask(task: Task) {
    setRerunningTaskId(task.id);
    setLoading(true);
    setError(null);
    try {
      const nextTask =
        task.kind === "search"
          ? await createSearchTask({ ...rerunSearchRequest(task), excluded_tags: expandExcludedTags(globalExcludedTags) })
          : task.kind === "gallery"
            ? await createGalleryTask(rerunGalleryRequest(task))
            : await createRetryFolderTask(rerunRetryFolderRequest(task));

      mergeTask(nextTask);
      openTaskDetail(nextTask.id);
      setView("tasks");
      pushLog(`reran ${kindLabel[task.kind]} task ${task.id} as ${nextTask.id}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setRerunningTaskId(null);
      setLoading(false);
    }
  }

  async function cancelTaskById(id: string) {
    setLoading(true);
    setError(null);
    try {
      const task = await cancelTask(id);
      mergeTask(task);
      pushLog(`canceled ${kindLabel[task.kind]} task ${task.id}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function downloadSearchResult(result: TaskSearchResult) {
    setLoading(true);
    setError(null);
    try {
      const task = await createGalleryTask({
        source_id: result.source_id,
        gallery_url: result.gallery_url,
      });
      mergeTask(task);
      pushLog(`created ${kindLabel[task.kind]} task from ${result.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function downloadSelectedSearchResults(task: Task) {
    const results = searchResultsForTask(task);
    const selectedKeys = new Set(selectedResults[task.id] ?? []);
    const selected = results.filter((result) => selectedKeys.has(searchResultKey(result)));
    if (!selected.length) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      for (const result of selected) {
        const nextTask = await createGalleryTask({
          source_id: result.source_id,
          gallery_url: result.gallery_url,
        });
        mergeTask(nextTask);
      }
      clearSearchSelection(task.id);
      pushLog(`created ${selected.length} download task(s) from ${task.title}`);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoading(false);
    }
  }

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      pushLog(`copied ${label}`);
    } catch (caught) {
      handleError(caught);
    }
  }

  function mergeTask(task: Task) {
    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
  }

  function pushLog(line: string) {
    const time = new Date().toLocaleTimeString();
    setLogLines((current) => [`[${time}] ${line}`, ...current].slice(0, 80));
  }

  function handleError(caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught);
    setError(message);
    pushLog(`error ${message}`);
  }

  function searchResultsForTask(task: Task): TaskSearchResult[] {
    if (task.output?.type !== "search_results") {
      return [];
    }
    return filterSearchResults(task.output.results, globalExcludedTags);
  }

  function saveGlobalExcludedTags(nextTags: string[]) {
    const normalized = uniqueTags(nextTags);
    setGlobalExcludedTags(normalized);
    try {
      window.localStorage.setItem(globalExcludedTagsStorageKey, JSON.stringify(normalized));
    } catch {
      // Local storage can be unavailable in privacy modes.
    }
  }

  function addGlobalExcludedTag(value: string) {
    const tag = value.trim();
    if (!tag) {
      return;
    }
    saveGlobalExcludedTags([...globalExcludedTags, canonicalTag(tag)]);
    setExcludedTagDraft("");
  }

  function removeGlobalExcludedTag(tag: string) {
    saveGlobalExcludedTags(globalExcludedTags.filter((item) => normalizeTag(item) !== normalizeTag(tag)));
  }

  function searchResultKey(result: TaskSearchResult) {
    return `${result.source_id}|${result.gallery_url}`;
  }

  function libraryExportKey(itemId: string, format: LibraryExportFormat) {
    return `${itemId}:${format}`;
  }

  function isSearchResultSelected(taskId: string, result: TaskSearchResult) {
    return (selectedResults[taskId] ?? []).includes(searchResultKey(result));
  }

  function toggleSearchResult(taskId: string, result: TaskSearchResult) {
    const key = searchResultKey(result);
    setSelectedResults((current) => {
      const selected = new Set(current[taskId] ?? []);
      if (selected.has(key)) {
        selected.delete(key);
      } else {
        selected.add(key);
      }
      return { ...current, [taskId]: Array.from(selected) };
    });
  }

  function selectAllSearchResults(task: Task) {
    setSelectedResults((current) => ({
      ...current,
      [task.id]: searchResultsForTask(task).map(searchResultKey),
    }));
  }

  function clearSearchSelection(taskId: string) {
    setSelectedResults((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }

  function jsonText(value: unknown) {
    return JSON.stringify(value ?? null, null, 2);
  }

  function formatBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function remoteReaderProgressPercent(session: RemoteReaderSessionSummary) {
    const total = Math.max(session.page_count || 0, 1);
    const page = Math.min(Math.max(session.last_page || 0, 0), total);
    return Math.min(100, Math.round((page / total) * 100));
  }

  function remoteReaderPreloadText(preload: RemoteReaderPreloadState | null) {
    if (!preload) {
      return "预载待命";
    }
    if (preload.status === "loading") {
      return `预载 ${preload.loaded}/${preload.requested}`;
    }
    if (preload.status === "failed") {
      return `预载失败 ${preload.failed}/${Math.max(preload.requested, preload.failed)}`;
    }
    return preload.requested ? `已预载 ${preload.loaded} 页` : "临近页已就绪";
  }

  function readerScrollPageNumbers(currentPage: number, totalPages: number) {
    return readerLoadPlan(currentPage, totalPages, "scroll").pageNumbers;
  }

  function markReaderImageStatus(url: string, status: ReaderImageStatus) {
    setReaderImageStates((current) => (current[url] === status ? current : { ...current, [url]: status }));
    if (status === "loaded") {
      clearReaderImageError(url);
    }
  }

  function retryReaderImage(url: string) {
    const reloadKey = Math.max(Date.now(), (readerImageReloadKeys[url] ?? 0) + 1);
    clearReaderImageError(url);
    setReaderImageStates((current) => ({ ...current, [url]: "loading" }));
    setReaderImageReloadKeys((current) => ({ ...current, [url]: reloadKey }));
    return reloadKey;
  }

  function clearReaderImageError(url: string) {
    setReaderImageErrors((current) => {
      if (!(url in current)) {
        return current;
      }
      const next = { ...current };
      delete next[url];
      return next;
    });
  }

  function handleReaderImageError(url: string) {
    markReaderImageStatus(url, "failed");
    void loadReaderImageStatus(url);
  }

  async function loadReaderImageStatus(url: string) {
    const target = remoteReaderPageTarget(url);
    if (!target) {
      return;
    }

    try {
      const pageStatus = await getRemoteReaderPageStatus(target.sessionId, target.pageIndex);
      mergeRemoteReaderPageStatus(pageStatus);
      setReaderImageErrors((current) => ({ ...current, [url]: readerImageStatusMessage(pageStatus) }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setReaderImageErrors((current) => ({ ...current, [url]: message }));
    }
  }

  function remoteReaderPageTarget(url: string) {
    const match = url.match(/^\/v1\/reader\/sessions\/([^/]+)\/pages\/(\d+)$/);
    if (!match) {
      return null;
    }
    return {
      sessionId: decodeURIComponent(match[1]),
      pageIndex: Number(match[2]),
    };
  }

  function readerImageStatusMessage(pageStatus: RemoteReaderPageStatus) {
    if (pageStatus.status === "failed") {
      return pageStatus.error || "源站未能返回这一页图片。";
    }
    if (pageStatus.status === "ready") {
      return "后端已经缓存到这一页，但浏览器未能渲染图片；可以重试，若仍失败请检查图片格式或响应内容。";
    }
    return "后端还没有完成这一页缓存，请稍后重试。";
  }

  function readerImageSrc(url: string) {
    return readerImageSrcWithReload(url, readerImageReloadKeys[url] ?? 0);
  }

  function readerImageSrcWithReload(url: string, reloadKey: number) {
    const source = apiUrl(url);
    if (!reloadKey) {
      return source;
    }
    return `${source}${source.includes("?") ? "&" : "?"}reader_retry=${reloadKey}`;
  }

  function remoteReaderPageVisualStatus(page: RemoteReaderPage, statusMap: Record<number, RemoteReaderPageStatus>): ReaderPageUiStatus {
    const imageStatus = readerImageStates[page.url];
    if (imageStatus === "failed") {
      return "failed";
    }
    if (imageStatus === "loaded") {
      return "ready";
    }
    if (imageStatus === "loading") {
      return "loading";
    }

    const pageStatus = statusMap[page.index]?.status;
    if (pageStatus === "failed") {
      return "failed";
    }
    if (pageStatus === "ready") {
      return "ready";
    }
    if (pageStatus === "pending" || pageStatus === "loading" || imageStatus === "loading") {
      return "loading";
    }
    return "unknown";
  }

  function remoteReaderStatusSummary(pages: RemoteReaderPage[], statusMap: Record<number, RemoteReaderPageStatus>) {
    return pages.reduce(
      (summary, page) => {
        const status = remoteReaderPageVisualStatus(page, statusMap);
        summary[status] += 1;
        return summary;
      },
      { failed: 0, loading: 0, ready: 0, unknown: 0 } satisfies Record<ReaderPageUiStatus, number>,
    );
  }

  function remoteReaderStatusLabel(status: ReaderPageUiStatus) {
    if (status === "ready") {
      return "已就绪";
    }
    if (status === "failed") {
      return "失败";
    }
    if (status === "loading") {
      return "加载中";
    }
    return "未请求";
  }

  function remoteReaderKnownPages(reader: RemoteReaderState) {
    const pages = remoteReaderPages[reader.session.id] ?? [];
    const merged = new Map(pages.map((page) => [page.index, page]));
    merged.set(reader.page.index, reader.page);
    return Array.from(merged.values()).sort((left, right) => left.index - right.index);
  }

  async function retryRemoteReaderFailedPages(reader: RemoteReaderState) {
    if (remoteReaderLoading || typeof window === "undefined") {
      return;
    }

    const statusMap = remoteReaderPageStatuses[reader.session.id] ?? {};
    const targets = remoteReaderKnownPages(reader).filter((page) => remoteReaderPageVisualStatus(page, statusMap) === "failed");
    if (!targets.length) {
      return;
    }

    targets.forEach((page) => {
      const reloadKey = retryReaderImage(page.url);
      const image = new window.Image();
      image.onload = () => {
        markReaderImageStatus(page.url, "loaded");
        void loadReaderImageStatus(page.url);
      };
      image.onerror = () => handleReaderImageError(page.url);
      image.src = readerImageSrcWithReload(page.url, reloadKey);
    });

    pushLog(`retrying ${targets.length} failed remote reader page(s)`);
  }

  async function jumpRemoteReaderToNextAvailablePage(direction = 1) {
    if (!remoteReader || remoteReaderLoading) {
      return;
    }

    const statusMap = remoteReaderPageStatuses[remoteReader.session.id] ?? {};
    const knownPages = new Map(remoteReaderKnownPages(remoteReader).map((page) => [page.index, page]));
    const step = direction >= 0 ? 1 : -1;
    let candidate = remoteReader.page.index + step;

    while (candidate >= 1 && candidate <= remoteReader.total) {
      const page = knownPages.get(candidate);
      if (!page || remoteReaderPageVisualStatus(page, statusMap) !== "failed") {
        await jumpRemoteReaderToPage(candidate);
        return;
      }
      candidate += step;
    }
  }

  function renderReaderImage(options: { title: string; page: number; url: string; loading?: "eager" | "lazy" }) {
    const status = readerImageStates[options.url] ?? "loading";
    const failureMessage = readerImageErrors[options.url] ?? "源站或本地缓存暂时没有返回这一页。";
    const loading = status === "loading";
    const failed = status === "failed";

    return (
      <div className={`reader-image-frame ${status} fit-${libraryReaderFit}`} aria-busy={loading}>
        <img
          className={`reader-image fit-${libraryReaderFit}`}
          src={readerImageSrc(options.url)}
          alt={`${options.title} p${options.page}`}
          draggable={false}
          loading={options.loading}
          onLoad={() => markReaderImageStatus(options.url, "loaded")}
          onError={() => handleReaderImageError(options.url)}
        />
        {loading && (
          <div className="reader-image-state loading" aria-live="polite">
            <Image size={22} aria-hidden />
            <strong>图片加载中</strong>
          </div>
        )}
        {failed && (
          <div className="reader-image-state failed" role="alert">
            <AlertTriangle size={24} aria-hidden />
            <strong>图片加载失败</strong>
            <span>源站或本地缓存暂时没有返回这页。</span>
            <span className="reader-image-error-detail">{failureMessage}</span>
            <button
              className="reader-image-retry-button"
              type="button"
              title="清除本页缓存并重新抓取"
              onClick={(event) => {
                event.stopPropagation();
                retryReaderImage(options.url);
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <RefreshCcw size={13} aria-hidden />
              重试
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderReaderModeTabs() {
    return (
      <div className="reader-mode-tabs" aria-label="阅读模式">
        {(["single", "scroll"] as ReaderMode[]).map((mode) => (
          <button
            className={readerMode === mode ? "reader-mode-button active" : "reader-mode-button"}
            type="button"
            key={mode}
            aria-pressed={readerMode === mode}
            onClick={() => setReaderMode(mode)}
          >
            {mode === "single" ? <BookOpen size={13} aria-hidden /> : <ListRestart size={13} aria-hidden />}
            {readerModeLabel[mode]}
          </button>
        ))}
      </div>
    );
  }

  function renderReaderScrollStack<TPage extends { index: number; url: string }>(options: {
    title: string;
    pages: Map<number, TPage>;
    pageNumbers: number[];
    currentPage: number;
    disabled: boolean;
    getKey: (page: TPage) => string;
    getCaption: (page: TPage) => string;
    getStatus?: (page: TPage) => ReaderPageUiStatus;
    jumpToPage: (page: number) => void | Promise<void>;
  }) {
    return (
      <div className="reader-scroll-stack" aria-label="连续阅读页">
        {options.pageNumbers.map((pageNumber) => {
          const page = options.pages.get(pageNumber);
          if (!page) {
            return (
              <div className="reader-scroll-placeholder" key={`placeholder-${pageNumber}`}>
                <strong>p{pageNumber}</strong>
                <span>等待预载</span>
              </div>
            );
          }

          const pageStatus = options.getStatus?.(page) ?? "unknown";
          return (
            <figure
              className={page.index === options.currentPage ? `reader-scroll-page active ${pageStatus}` : `reader-scroll-page ${pageStatus}`}
              data-reader-page={page.index}
              key={options.getKey(page)}
            >
              <div
                className="reader-scroll-page-button"
                role="button"
                tabIndex={options.disabled ? -1 : 0}
                aria-disabled={options.disabled}
                aria-current={page.index === options.currentPage ? "page" : undefined}
                onClick={() => {
                  if (!options.disabled) {
                    void options.jumpToPage(page.index);
                  }
                }}
                onKeyDown={(event) => {
                  if (options.disabled || (event.key !== "Enter" && event.key !== " ")) {
                    return;
                  }
                  event.preventDefault();
                  void options.jumpToPage(page.index);
                }}
              >
                <span className="reader-scroll-page-index">p{page.index}</span>
                {renderReaderImage({
                  title: options.title,
                  page: page.index,
                  url: page.url,
                  loading: page.index === options.currentPage ? "eager" : "lazy",
                })}
              </div>
              <figcaption>{options.getCaption(page)}</figcaption>
            </figure>
          );
        })}
      </div>
    );
  }

  function renderRemoteReaderHistory() {
    const queryText = normalizeSearchText(remoteReaderQuery);
    const filteredSessions = remoteReaderSessions.filter((session) => {
      if (!queryText) {
        return true;
      }
      return normalizeSearchText([session.title, session.source_name, session.gallery_url, ...session.tags].join(" ")).includes(queryText);
    });
    const visibleLimit = remoteReaderHistoryExpanded ? 12 : 5;
    const visibleSessions = filteredSessions.slice(0, visibleLimit);

    return (
      <section className="panel remote-reader-panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">最近在线阅读</h2>
            <span className="section-note">
              {filteredSessions.length}/{remoteReaderSessions.length} 个会话
            </span>
          </div>
          <div className="remote-reader-header-actions">
            <button
              className="mini-button"
              type="button"
              disabled={remoteReaderSessions.length <= 5}
              onClick={() => setRemoteReaderHistoryExpanded((current) => !current)}
            >
              {remoteReaderHistoryExpanded ? "折叠" : "展开"}
            </button>
            <button className="icon-button" type="button" title="刷新在线阅读记录" aria-label="刷新在线阅读记录" onClick={refreshRemoteReaderSessions}>
              <RefreshCcw size={15} aria-hidden />
            </button>
          </div>
        </div>
        <label className="remote-reader-filter">
          <Search size={14} aria-hidden />
          <input
            value={remoteReaderQuery}
            onChange={(event) => setRemoteReaderQuery(event.target.value)}
            placeholder="筛选标题、来源、tag"
            aria-label="筛选在线阅读记录"
          />
          {remoteReaderQuery && (
            <button type="button" aria-label="清空在线阅读筛选" onClick={() => setRemoteReaderQuery("")}>
              <XCircle size={14} aria-hidden />
            </button>
          )}
        </label>
        <div className="remote-reader-list">
          {visibleSessions.length ? (
            visibleSessions.map((session) => {
              const percent = remoteReaderProgressPercent(session);
              const lastPage = session.last_page ?? 1;
              const bookmarkCount = remoteReaderBookmarks(session).length;
              return (
                <article className="remote-reader-card" key={session.id}>
                  <div className="remote-reader-main">
                    <span>{session.source_name}</span>
                    <strong>{session.title}</strong>
                    <small>
                      p{lastPage}/{Math.max(session.page_count, lastPage, 1)} · {formatLastReadTime(session.last_read_at)}
                      {bookmarkCount ? ` · 书签 ${bookmarkCount}` : ""}
                    </small>
                  </div>
                  <div className="remote-reader-progress" aria-label={`阅读进度 ${percent}%`}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                  <div className="remote-reader-actions">
                    <button className="mini-button primary" type="button" disabled={remoteReaderLoading} onClick={() => resumeRemoteReaderSession(session)}>
                      <BookOpen size={13} aria-hidden />
                      继续
                    </button>
                    <button
                      className="mini-button"
                      type="button"
                      disabled={remoteReaderMaintenanceKey === `clear-session:${session.id}`}
                      onClick={() => clearRemoteReaderHistoryCache(session)}
                    >
                      <HardDrive size={13} aria-hidden />
                      缓存
                    </button>
                    <button className="mini-button" type="button" onClick={() => copyText("remote reader link", session.gallery_url)}>
                      <Copy size={13} aria-hidden />
                      链接
                    </button>
                    <button
                      className="icon-button danger"
                      type="button"
                      title="删除在线阅读记录"
                      aria-label={`删除在线阅读记录：${session.title}`}
                      disabled={remoteReaderMaintenanceKey === `delete:${session.id}`}
                      onClick={() => deleteRemoteReaderHistory(session)}
                    >
                      <XCircle size={15} aria-hidden />
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <div className="empty compact">{remoteReaderSessionsLoading ? "正在加载" : "暂无匹配的在线阅读记录"}</div>
          )}
        </div>
      </section>
    );
  }

  function summarizeTaskResult(task: Task): { primary: string; detail?: string } {
    const output = task.output;
    if (!output) {
      return { primary: task.status === "failed" ? "无结果" : "等待中" };
    }

    if (output.type === "search_results") {
      const visibleCount = searchResultsForTask(task).length;
      const sourceErrorCount = visibleSearchSourceErrors(output).length;
      const excludedCount = (output.excluded_count ?? 0) + Math.max(output.results.length - visibleCount, 0);
      const details = [
        sourceErrorCount ? `${sourceErrorCount} 个源失败` : "",
        excludedCount ? `排除 ${excludedCount}` : "",
      ].filter(Boolean);
      return {
        primary: `${visibleCount} 条漫画`,
        detail: details.join(" · ") || undefined,
      };
    }

    if (output.type === "gallery_download") {
      const total = Math.max(output.page_count ?? output.done + output.skipped + output.failed, 1);
      return {
        primary: `${output.done + output.skipped}/${total} 页`,
        detail: output.failed ? `失败 ${output.failed}` : output.stopped ? "已停止" : undefined,
      };
    }

    return {
      primary: `${output.page_indexes.length} 页待补`,
      detail: output.page_indexes.length ? undefined : "无需补缺",
    };
  }

  function renderTaskDetail(task: Task) {
    const selectedCount = selectedResults[task.id]?.length ?? 0;
    const output = task.output;
    const detailSourceErrors = output?.type === "search_results" ? visibleSearchSourceErrors(output) : [];
    const detailSearchResults = output?.type === "search_results" ? searchResultsForTask(task) : [];
    const detailExcludedCount =
      output?.type === "search_results" ? (output.excluded_count ?? 0) + Math.max(output.results.length - detailSearchResults.length, 0) : 0;

    return (
      <aside
        className={[
          "detail-drawer",
          output?.type === "search_results" ? "search-detail-drawer" : "",
          detailDrawerClosing ? "closing" : "",
        ].filter(Boolean).join(" ")}
        aria-label="任务详情"
      >
        <div className="detail-header">
          <div>
            <h2>{task.title}</h2>
            <span>{task.id}</span>
          </div>
          <div className="detail-actions">
            <button
              className="mini-button"
              type="button"
              title="按原 payload 重新创建任务"
              disabled={loading || Boolean(rerunningTaskId)}
              onClick={() => rerunTask(task)}
            >
              <RefreshCcw size={13} aria-hidden />
              重跑
            </button>
            <button className="drawer-close-button" type="button" title="收回侧边栏" aria-label="收回任务详情侧边栏" onClick={closeDetailDrawer}>
              <PanelRightClose size={16} aria-hidden />
            </button>
          </div>
        </div>

        <div className="detail-body">
          <section className="detail-section">
            <div className="detail-grid">
              <div>
                <span>类型</span>
                <strong>{kindLabel[task.kind]}</strong>
              </div>
              <div>
                <span>状态</span>
                <strong>{statusLabel[task.status]}</strong>
              </div>
              <div>
                <span>完成</span>
                <strong>
                  {task.progress.done}/{Math.max(task.progress.total, task.progress.done + task.progress.failed, 1)}
                </strong>
              </div>
              <div>
                <span>失败</span>
                <strong>{task.progress.failed}</strong>
              </div>
            </div>
            <p className="detail-message">{task.progress.message}</p>
          </section>

          {output?.type === "search_results" && (
            <section className="detail-section search-results-section">
              <div className="detail-section-title">
                <h3>搜索结果</h3>
                <div className="detail-actions">
                  <button className="mini-button" type="button" onClick={() => selectAllSearchResults(task)}>
                    全选
                  </button>
                  <button className="mini-button" type="button" onClick={() => clearSearchSelection(task.id)} disabled={!selectedCount}>
                    清空
                  </button>
                  <button className="mini-button primary" type="button" onClick={() => downloadSelectedSearchResults(task)} disabled={loading || !selectedCount}>
                    <Download size={13} aria-hidden />
                    {selectedCount ? `下载 ${selectedCount}` : "批量下载"}
                  </button>
                </div>
              </div>
              {detailSourceErrors.length ? (
                <div className="source-warning">
                  {detailSourceErrors.length} 个源站暂时不可用，已合并显示其余结果。
                </div>
              ) : null}
              {detailExcludedCount ? <div className="excluded-result-notice">已自动排除 {detailExcludedCount} 条命中全局禁用词条的结果</div> : null}
              {detailSearchResults.length ? (
                <InfiniteSearchResults
                  taskId={task.id}
                  results={detailSearchResults}
                  hasMore={Boolean(output.has_more)}
                  loading={Boolean(output.loading_more) || searchResultsLoadingTaskId === task.id}
                  error={output.load_more_error}
                  onLoadMore={() => void loadMoreTaskSearchResults(task)}
                  renderResult={(result) => (
                    <div className="search-result detail-result" key={`${result.source_id}-${result.gallery_url}`}>
                      <input
                        className="result-checkbox"
                        type="checkbox"
                        aria-label={`选择：${result.title}`}
                        checked={isSearchResultSelected(task.id, result)}
                        onChange={() => toggleSearchResult(task.id, result)}
                      />
                      {renderSearchResultThumbnail(result)}
                      <div className="result-main">
                        <span className="result-source">{result.source_id}</span>
                        <a className="result-link" href={result.gallery_url} target="_blank" rel="noreferrer">
                          <ExternalLink size={13} aria-hidden />
                          {result.title}
                        </a>
                        <div className="result-tags">
                          {result.tags.slice(0, 6).map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      </div>
                      <div className="result-actions">
                        <button
                          className="icon-button"
                          type="button"
                          title={sourceSupportsRemoteReading(result.source_id) ? "打开在线阅读器" : "该源站暂不支持在线阅读"}
                          aria-label={`打开在线阅读器：${result.title}`}
                          disabled={remoteReaderLoading || !sourceSupportsRemoteReading(result.source_id)}
                          onClick={() => openRemoteReader(result)}
                        >
                          <BookOpen size={15} aria-hidden />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title="创建下载任务"
                          aria-label={`创建下载任务：${result.title}`}
                          disabled={loading}
                          onClick={() => downloadSearchResult(result)}
                        >
                          <Download size={15} aria-hidden />
                        </button>
                      </div>
                    </div>
                  )}
                />
              ) : <div className="empty compact">当前结果均已被全局禁用词条排除</div>}
            </section>
          )}

          {output?.type === "gallery_download" && (
            <section className="detail-section">
              <div className="detail-section-title">
                <h3>下载结果</h3>
                <button className="mini-button" type="button" onClick={() => copyText("output folder", output.output_folder)}>
                  <Copy size={13} aria-hidden />
                  复制路径
                </button>
              </div>
              <div className="path-box">{output.output_folder}</div>
            </section>
          )}

          {output?.type === "retry_plan" && (
            <section className="detail-section">
              <div className="detail-section-title">
                <h3>补缺计划</h3>
                <button className="mini-button" type="button" onClick={() => copyText("retry folder", output.folder)}>
                  <Copy size={13} aria-hidden />
                  复制目录
                </button>
              </div>
              <div className="path-box">{output.folder}</div>
              <div className="result-tags">
                {output.page_indexes.slice(0, 40).map((page) => (
                  <span key={page}>p{page}</span>
                ))}
              </div>
            </section>
          )}

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>Payload</h3>
              <button className="mini-button" type="button" onClick={() => copyText("payload JSON", jsonText(task.payload))}>
                <Copy size={13} aria-hidden />
                复制
              </button>
            </div>
            <pre className="json-view">{jsonText(task.payload)}</pre>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>Output</h3>
              <button className="mini-button" type="button" onClick={() => copyText("output JSON", jsonText(output))} disabled={!output}>
                <Copy size={13} aria-hidden />
                复制
              </button>
            </div>
            <pre className="json-view">{jsonText(output)}</pre>
          </section>
        </div>
      </aside>
    );
  }

  function renderLibraryView() {
    return (
      <section className="library-layout">
        <section className="metrics" aria-label="文件库统计">
          <button
            className={!libraryFiltersActive ? "metric metric-button active" : "metric metric-button"}
            type="button"
            aria-pressed={!libraryFiltersActive}
            onClick={clearLibraryFilters}
          >
            <span>当前目录</span>
            <strong>{libraryMetrics.total}</strong>
          </button>
          <button
            className={libraryFailedOnly ? "metric metric-button active" : "metric metric-button"}
            type="button"
            aria-pressed={libraryFailedOnly}
            onClick={showLibraryFailures}
          >
            <span>失败记录</span>
            <strong>{libraryMetrics.failed}</strong>
          </button>
          <button
            className={libraryHealthFilter === "failed" ? "metric metric-button active" : "metric metric-button"}
            type="button"
            aria-pressed={libraryHealthFilter === "failed"}
            onClick={() => showLibraryHealth("failed")}
          >
            <span>异常目录</span>
            <strong>{libraryMetrics.healthFailed}</strong>
          </button>
          <button
            className={libraryHealthFilter === "warning" ? "metric metric-button active" : "metric metric-button"}
            type="button"
            aria-pressed={libraryHealthFilter === "warning"}
            onClick={() => showLibraryHealth("warning")}
          >
            <span>需处理</span>
            <strong>{libraryMetrics.healthWarning}</strong>
          </button>
          <button
            className={libraryReadingStatus === "reading" ? "metric metric-button active" : "metric metric-button"}
            type="button"
            aria-pressed={libraryReadingStatus === "reading"}
            onClick={showLibraryReading}
          >
            <span>在读</span>
            <strong>{libraryMetrics.reading}</strong>
          </button>
          <button
            className={libraryFavoriteOnly ? "metric metric-button active" : "metric metric-button"}
            type="button"
            aria-pressed={libraryFavoriteOnly}
            onClick={showLibraryFavorites}
          >
            <span>收藏</span>
            <strong>{libraryMetrics.favorites}</strong>
          </button>
          <button
            className={libraryRecentOnly ? "metric metric-button active" : "metric metric-button"}
            type="button"
            aria-pressed={libraryRecentOnly}
            onClick={showLibraryRecent}
          >
            <span>最近阅读</span>
            <strong>{libraryMetrics.recent}</strong>
          </button>
        </section>

        {recentLibraryItems.length > 0 && (
          <section className="panel recent-reading-panel" aria-label="最近阅读">
            <div className="panel-header recent-reading-header">
              <div>
                <h2 className="panel-title">继续阅读</h2>
                <span className="section-note">按最近阅读时间排列</span>
              </div>
              <button className="mini-button" type="button" onClick={showLibraryRecent}>
                <Clock size={13} aria-hidden />
                查看全部
              </button>
            </div>
            <div className="recent-reading-grid">
              {recentLibraryItems.map((item) => (
                <article className="recent-reading-card" key={item.id}>
                  {renderLibraryCover(item, "compact")}
                  <div className="recent-reading-main">
                    <span className={`shelf-status ${item.shelf.reading_status}`}>
                      <BookOpen size={13} aria-hidden />
                      {readingStatusLabel[item.shelf.reading_status]}
                    </span>
                    <h3>{item.title}</h3>
                    <p>
                      p{item.shelf.last_page}/{libraryPageTotal(item)} · {readingProgressPercent(item)}%
                    </p>
                    <span className="recent-reading-time">
                      <Clock size={13} aria-hidden />
                      {formatLastReadTime(item.shelf.last_read_at)}
                    </span>
                  </div>
                  <div className="recent-reading-actions">
                    <button className="mini-button primary" type="button" disabled={libraryPagesLoadingId === item.id} onClick={() => openLibraryReadingPage(item)}>
                      <BookOpen size={13} aria-hidden />
                      继续
                    </button>
                    <button className="icon-button" type="button" title="查看详情" aria-label="查看详情" onClick={() => openLibraryDetail(item)}>
                      <Eye size={15} aria-hidden />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {libraryTagStats.length > 0 && (
          <section className="panel library-tag-panel" aria-label="热门 tag">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">热门 tag</h2>
                <span className="section-note">按本地文件库出现次数排序</span>
              </div>
              <Tags size={18} aria-hidden />
            </div>
            <div className="library-tag-cloud">
              {libraryTagStats.map((stat) => {
                const active = normalizeLibrarySearch(libraryTag) === normalizeLibrarySearch(stat.tag);
                return (
                  <button
                    className={active ? "library-tag-stat active" : "library-tag-stat"}
                    type="button"
                    key={stat.tag}
                    title={`按 tag 筛选：${stat.tag}`}
                    aria-pressed={active}
                    onClick={() => filterLibraryByTag(stat.tag)}
                  >
                    <span>{stat.tag}</span>
                    <strong>{stat.item_count}</strong>
                    <small>{stat.image_count} 图</small>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="panel library-filter-panel">
          <div className="panel-body">
            <div className="library-filter-grid">
              <label className="field">
                <span>关键词</span>
                <input className="input" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} />
              </label>
              <label className="field">
                <span>tag</span>
                <input className="input" value={libraryTag} onChange={(event) => setLibraryTag(event.target.value)} />
              </label>
              <label className="field">
                <span>完整度</span>
                <select className="select" value={libraryCompleteness} onChange={(event) => setLibraryCompleteness(event.target.value as LibraryCompleteness)}>
                  <option value="all">全部</option>
                  <option value="complete">完整</option>
                  <option value="incomplete">缺页</option>
                </select>
              </label>
              <label className="field">
                <span>健康状态</span>
                <select className="select" value={libraryHealthFilter} onChange={(event) => setLibraryHealthFilter(event.target.value as LibraryHealthFilter)}>
                  <option value="all">全部</option>
                  <option value="ok">正常</option>
                  <option value="warning">需处理</option>
                  <option value="failed">异常</option>
                  <option value="needs_attention">异常或需处理</option>
                </select>
              </label>
              <label className="field">
                <span>阅读状态</span>
                <select className="select" value={libraryReadingStatus} onChange={(event) => setLibraryReadingStatus(event.target.value as LibraryReadingStatus | "all")}>
                  <option value="all">全部</option>
                  <option value="unread">未读</option>
                  <option value="reading">在读</option>
                  <option value="finished">读完</option>
                  <option value="paused">搁置</option>
                </select>
              </label>
              <label className="field">
                <span>排序</span>
                <select className="select" value={librarySort} onChange={(event) => setLibrarySort(event.target.value as LibrarySort)}>
                  <option value="updated_desc">最近更新</option>
                  <option value="last_read_desc">最近阅读</option>
                  <option value="title_asc">标题 A-Z</option>
                  <option value="images_desc">图片最多</option>
                  <option value="failed_desc">失败最多</option>
                  <option value="size_desc">体积最大</option>
                  <option value="completeness_asc">缺页优先</option>
                </select>
              </label>
              <label className="check-field">
                <input type="checkbox" checked={libraryFailedOnly} onChange={(event) => setLibraryFailedOnly(event.target.checked)} />
                <span>仅失败</span>
              </label>
              <label className="check-field">
                <input type="checkbox" checked={libraryFavoriteOnly} onChange={(event) => setLibraryFavoriteOnly(event.target.checked)} />
                <span>仅收藏</span>
              </label>
              <label className="check-field">
                <input type="checkbox" checked={libraryRecentOnly} onChange={(event) => setLibraryRecentOnly(event.target.checked)} />
                <span>仅最近读过</span>
              </label>
              <button className="button ghost" type="button" onClick={clearLibraryFilters} disabled={!libraryFiltersActive}>
                <Search size={16} aria-hidden />
                清空
              </button>
            </div>
          </div>
        </section>

        <section className={selectedLibraryCount ? "panel library-batch-panel active" : "panel library-batch-panel"} aria-label="批量书架操作">
          <div className="panel-body library-batch-bar">
            <label className="check-field">
              <input type="checkbox" checked={allFilteredLibrarySelected} disabled={!filteredLibraryItems.length || libraryBatchBusy} onChange={toggleFilteredLibrarySelection} />
              <span>选中 {selectedLibraryCount}</span>
            </label>
            <button className="mini-button" type="button" disabled={!filteredLibraryItems.length || libraryBatchBusy} onClick={selectFilteredLibraryItems}>
              全选当前结果
            </button>
            <button className="mini-button" type="button" disabled={!selectedLibraryCount || libraryBatchBusy} onClick={clearLibrarySelection}>
              清空选择
            </button>
            <div className="library-batch-actions">
              <button className="mini-button primary" type="button" disabled={!selectedLibraryCount || libraryBatchBusy} onClick={() => applyBatchLibraryShelfPatch({ favorite: true }, "favorite")}>
                批量收藏
              </button>
              <button className="mini-button" type="button" disabled={!selectedLibraryCount || libraryBatchBusy} onClick={() => applyBatchLibraryShelfPatch({ favorite: false }, "unfavorite")}>
                取消收藏
              </button>
              <select
                className="select batch-select"
                value=""
                disabled={!selectedLibraryCount || libraryBatchBusy}
                onChange={(event) => {
                  const nextStatus = event.target.value as LibraryReadingStatus | "";
                  if (nextStatus) {
                    void applyBatchLibraryShelfPatch({ reading_status: nextStatus }, `reading status ${nextStatus}`);
                  }
                }}
              >
                <option value="">修改阅读状态</option>
                <option value="unread">未读</option>
                <option value="reading">在读</option>
                <option value="finished">读完</option>
                <option value="paused">搁置</option>
              </select>
              <button className="mini-button" type="button" disabled={!selectedLibraryCount || libraryBatchBusy} onClick={() => exportSelectedLibraryItems("cbz")}>
                <Archive size={13} aria-hidden />
                {libraryBatchExportingFormat === "cbz" ? "导出中" : "批量 CBZ"}
              </button>
              <button className="mini-button primary" type="button" disabled={!selectedLibraryCount || libraryBatchBusy} onClick={() => exportSelectedLibraryItems("pdf")}>
                <FileText size={13} aria-hidden />
                {libraryBatchExportingFormat === "pdf" ? "导出中" : "批量 PDF"}
              </button>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header library-list-header">
            <div className="panel-heading-inline">
              <h2 className="panel-title">文件库</h2>
              <span className="section-note">
                {filteredLibraryItems.length}/{libraryItems.length}
              </span>
              <FolderOpen size={18} aria-hidden />
            </div>
            <div className="view-switcher" aria-label="文件库视图">
              <button
                className={libraryViewMode === "grid" ? "view-switch-button active" : "view-switch-button"}
                type="button"
                aria-pressed={libraryViewMode === "grid"}
                title="卡片视图"
                onClick={() => setLibraryViewMode("grid")}
              >
                <LayoutGrid size={15} aria-hidden />
              </button>
              <button
                className={libraryViewMode === "table" ? "view-switch-button active" : "view-switch-button"}
                type="button"
                aria-pressed={libraryViewMode === "table"}
                title="表格视图"
                onClick={() => setLibraryViewMode("table")}
              >
                <Table2 size={15} aria-hidden />
              </button>
            </div>
          </div>
          {filteredLibraryItems.length ? (
            libraryViewMode === "table" ? (
              <div className="table-wrap">
              <table className="task-table library-table">
                <thead>
                  <tr>
                    <th className="select-column">
                      <input type="checkbox" checked={allFilteredLibrarySelected} disabled={!filteredLibraryItems.length || libraryBatchBusy} onChange={toggleFilteredLibrarySelection} aria-label="全选当前文件库结果" />
                    </th>
                    <th>漫画</th>
                    <th>目录</th>
                    <th>文件</th>
                    <th>健康</th>
                    <th>失败</th>
                    <th>书架</th>
                    <th>大小</th>
                    <th>更新时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLibraryItems.map((item) => (
                    <tr key={item.id} className={isLibraryItemSelected(item) ? "selected-row" : undefined}>
                      <td className="select-column">
                        <input type="checkbox" checked={isLibraryItemSelected(item)} disabled={libraryBatchBusy} onChange={(event) => toggleLibraryItemSelection(item, event.target.checked)} aria-label={"选择 " + item.title} />
                      </td>
                      <td>
                        <div className="library-title-row">
                          {renderLibraryCover(item, "compact")}
                          <div className="library-title">
                            {renderLibraryTitle(item)}
                            <div className="result-tags">
                              {item.tags.slice(0, 6).map(renderLibraryTag)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="path-stack">
                          <span>{item.root}</span>
                          <strong>{item.folder}</strong>
                        </div>
                      </td>
                      <td>
                        <div className="library-count">
                          <Image size={14} aria-hidden />
                          <span>
                            {item.image_count}/{Math.max(item.page_count, item.image_count)}
                          </span>
                        </div>
                      </td>
                      <td>{renderLibraryHealthBadge(item)}</td>
                      <td>
                        <span className={item.failed_count > 0 ? "badge failed" : "badge completed"}>{item.failed_count}</span>
                      </td>
                      <td>
                        {renderLibraryShelfCell(item)}
                      </td>
                      <td>{formatBytes(item.size_bytes)}</td>
                      <td>{new Date(item.updated_at).toLocaleString()}</td>
                      <td>
                        {renderLibraryActions(item)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <div className="library-card-grid">{filteredLibraryItems.map(renderLibraryCard)}</div>
            )
          ) : (
              <div className="empty">
                {libraryLoading ? <RefreshCcw size={24} aria-hidden /> : <FolderOpen size={24} aria-hidden />}
                <span>{libraryLoading ? "正在扫描文件库" : libraryItems.length ? "没有匹配目录" : "暂无本地漫画目录"}</span>
              </div>
          )}
        </section>

        {error && (
          <div className="error library-error">
            <AlertTriangle size={16} aria-hidden />
            {error}
          </div>
        )}
      </section>
    );
  }

  function renderLibraryExportResult(label: string, result: LibraryExportResult) {
    return (
      <div className="export-result" key={result.output_file}>
        <div className="export-result-header">
          <strong>{label}</strong>
          <div className="detail-actions">
            {result.exists !== false && (
              <a className="mini-link" href={libraryExportDownloadUrl(result.item_id, result.id)}>
                <Download size={13} aria-hidden />
                下载
              </a>
            )}
            {result.exists !== false && (
              <button className="mini-button" type="button" onClick={() => copyText(`${label} download link`, libraryExportDownloadUrl(result.item_id, result.id))}>
                <Copy size={13} aria-hidden />
                复制链接
              </button>
            )}
            <button className="mini-button" type="button" onClick={() => copyText(`${label} file`, result.output_file)}>
              <Copy size={13} aria-hidden />
              复制路径
            </button>
          </div>
        </div>
        <div className="path-box">{result.output_file}</div>
        <div className="output-meta">
          {result.page_count} 页 · {formatBytes(result.size_bytes)} · {new Date(result.created_at).toLocaleString()}
          {result.exists === false ? " · 文件缺失" : ""}
          {result.quality ? ` · quality ${result.quality}` : ""}
          {result.included_metadata ? " · Metadata" : ""}
          {result.included_failure_log ? " · 失败记录" : ""}
        </div>
      </div>
    );
  }

  function renderLibraryTag(tag: string) {
    return (
      <button className="tag-chip" type="button" key={tag} title={`按 tag 筛选：${tag}`} onClick={() => filterLibraryByTag(tag)}>
        {tag}
      </button>
    );
  }

  function renderLibraryCover(item: LibraryItem, size: "normal" | "compact" = "normal") {
    const className = size === "compact" ? "library-cover compact" : "library-cover";
    return (
      <button className={className} type="button" title="继续阅读" aria-label={"继续阅读 " + item.title} disabled={libraryPagesLoadingId === item.id} onClick={() => openLibraryReadingPage(item)}>
        {item.cover_url ? (
          <img src={apiUrl(item.cover_url)} alt="" loading="lazy" />
        ) : (
          <span>
            <Image size={size === "compact" ? 18 : 28} aria-hidden />
          </span>
        )}
      </button>
    );
  }

  function renderLibraryTitle(item: LibraryItem) {
    return item.gallery_url ? (
      <a href={item.gallery_url} target="_blank" rel="noreferrer">
        <ExternalLink size={13} aria-hidden />
        {item.title}
      </a>
    ) : (
      <strong>{item.title}</strong>
    );
  }

  function renderLibraryHealthBadge(item: LibraryItem) {
    const health = item.health;
    if (!health || health.status === "ok") {
      return <span className="badge completed">正常</span>;
    }
    if (health.status === "failed") {
      return <span className="badge failed">异常 {health.issues.length}</span>;
    }
    return <span className="badge warning">需处理 {health.issues.length}</span>;
  }

  function healthIssueTitle(kind: string) {
    if (kind === "missing_pages") {
      return "缺页";
    }
    if (kind === "failed_pages") {
      return "失败记录";
    }
    if (kind === "small_images") {
      return "疑似占位图";
    }
    if (kind === "stopped_download") {
      return "下载中断";
    }
    return "诊断";
  }

  function renderLibraryShelfCell(item: LibraryItem) {
    return (
      <div className="shelf-cell">
        <button
          className={item.shelf.favorite ? "icon-button active" : "icon-button"}
          type="button"
          title={item.shelf.favorite ? "取消收藏" : "收藏"}
          aria-label={item.shelf.favorite ? "取消收藏" : "收藏"}
          disabled={libraryShelfSavingId === item.id}
          onClick={() => updateShelfForItem(item, { favorite: !item.shelf.favorite })}
        >
          <Star size={16} fill={item.shelf.favorite ? "currentColor" : "none"} aria-hidden />
        </button>
        <span className={`shelf-status ${item.shelf.reading_status}`}>
          <BookOpen size={13} aria-hidden />
          {readingStatusLabel[item.shelf.reading_status]}
        </span>
        {item.shelf.last_page && (
          <span className="shelf-progress-chip">
            p{item.shelf.last_page} · {readingProgressPercent(item)}%
          </span>
        )}
      </div>
    );
  }

  function renderLibraryActions(item: LibraryItem) {
    return (
      <div className="task-actions">
        <button className="icon-button" type="button" title="继续阅读" aria-label="继续阅读" disabled={libraryPagesLoadingId === item.id} onClick={() => openLibraryReadingPage(item)}>
          <BookOpen size={16} aria-hidden />
        </button>
        <button className="icon-button" type="button" title="查看详情" aria-label="查看详情" onClick={() => openLibraryDetail(item)}>
          <Eye size={16} aria-hidden />
        </button>
        <button className="icon-button" type="button" title="复制目录" aria-label="复制目录" onClick={() => copyText("library folder", item.folder)}>
          <Copy size={16} aria-hidden />
        </button>
        <button
          className="icon-button"
          type="button"
          title="创建补缺任务"
          aria-label="创建补缺任务"
          disabled={libraryRetryingId === item.id}
          onClick={() => createLibraryRetryTask(item)}
        >
          <FolderSync size={16} aria-hidden />
        </button>
        {item.metadata_path && (
          <button className="icon-button" type="button" title="复制元数据路径" aria-label="复制元数据路径" onClick={() => copyText("metadata path", item.metadata_path || "")}>
            <HardDrive size={16} aria-hidden />
          </button>
        )}
      </div>
    );
  }

  function renderLibraryCard(item: LibraryItem) {
    return (
      <article className={isLibraryItemSelected(item) ? "library-card selected" : "library-card"} key={item.id}>
        <label className="library-select-check">
          <input type="checkbox" checked={isLibraryItemSelected(item)} disabled={libraryBatchBusy} onChange={(event) => toggleLibraryItemSelection(item, event.target.checked)} />
          <span>选择</span>
        </label>
        {renderLibraryCover(item)}
        <div className="library-card-body">
          <div className="library-card-title">{renderLibraryTitle(item)}</div>
          <div className="library-card-stats">
            <span>
              <Image size={13} aria-hidden />
              {item.image_count}/{Math.max(item.page_count, item.image_count)}
            </span>
            {renderLibraryHealthBadge(item)}
            <span className={item.failed_count > 0 ? "badge failed" : "badge completed"}>{item.failed_count} 失败</span>
            <span>{formatBytes(item.size_bytes)}</span>
          </div>
          <div className="library-card-progress" aria-label={`阅读进度 ${readingProgressPercent(item)}%`}>
            <span style={{ width: `${readingProgressPercent(item)}%` }} />
          </div>
          {renderLibraryShelfCell(item)}
          <div className="result-tags">{item.tags.slice(0, 8).map(renderLibraryTag)}</div>
          <div className="path-stack compact">
            <span>{item.root}</span>
            <strong>{item.folder}</strong>
          </div>
        </div>
        <div className="library-card-footer">
          <span>{new Date(item.updated_at).toLocaleString()}</span>
          {renderLibraryActions(item)}
        </div>
      </article>
    );
  }

  function renderLibraryReader(reader: LibraryReaderState) {
    const currentPage = reader.page.index;
    const totalPages = Math.max(reader.total, currentPage, 1);
    const progress = Math.min(100, Math.round((currentPage / totalPages) * 100));
    const previousDisabled = libraryReaderLoading || currentPage <= 1;
    const nextDisabled = libraryReaderLoading || currentPage >= totalPages;
    const shortcutStart = Math.max(1, Math.min(currentPage - 2, Math.max(totalPages - 4, 1)));
    const pageShortcuts = Array.from({ length: Math.min(5, totalPages) }, (_, index) => shortcutStart + index).filter((page) => page <= totalPages);
    const thumbnailStart = Math.max(1, currentPage - 3);
    const thumbnailEnd = Math.min(totalPages, currentPage + 3);
    const thumbnailPages = (libraryPages[reader.item.id] ?? [])
      .filter((page) => page.index >= thumbnailStart && page.index <= thumbnailEnd)
      .sort((left, right) => left.index - right.index);
    const loadedPages = libraryPages[reader.item.id] ?? [reader.page];
    const pageMap = new Map(loadedPages.map((page) => [page.index, page]));
    pageMap.set(reader.page.index, reader.page);
    const scrollPageNumbers = readerScrollPageNumbers(currentPage, totalPages);

    return (
      <div className="reader-overlay" role="dialog" aria-modal="true" aria-label="漫画阅读器">
        <section className={readerControlsCollapsed ? "reader-shell controls-collapsed" : "reader-shell"}>
          <header className="reader-header">
            <div className="reader-title-block">
              <span>内置阅读器</span>
              <h2>{reader.item.title}</h2>
              <p>
                p{currentPage}/{totalPages} · {readingStatusLabel[reader.item.shelf.reading_status]}
              </p>
            </div>
            <div className="reader-actions">
              {renderReaderModeTabs()}
              <div className="reader-fit-tabs" aria-label="阅读器适配模式">
                {(["width", "height", "original"] as ReaderFit[]).map((fit) => (
                  <button
                    className={libraryReaderFit === fit ? "reader-fit-button active" : "reader-fit-button"}
                    type="button"
                    key={fit}
                    aria-pressed={libraryReaderFit === fit}
                    onClick={() => setLibraryReaderFit(fit)}
                  >
                    {readerFitLabel[fit]}
                  </button>
                ))}
              </div>
              <button
                className="reader-icon-button"
                type="button"
                title={`${readerControlsCollapsed ? "显示" : "隐藏"}底栏（H）`}
                aria-label={`${readerControlsCollapsed ? "显示" : "隐藏"}阅读器底栏`}
                aria-controls="library-reader-controls"
                aria-expanded={!readerControlsCollapsed}
                onClick={toggleReaderControls}
              >
                {readerControlsCollapsed ? <ChevronUp size={17} aria-hidden /> : <ChevronDown size={17} aria-hidden />}
                {readerControlsCollapsed ? "显示底栏" : "隐藏底栏"}
              </button>
              <button className="reader-icon-button" type="button" title="收起阅读器" aria-label="收起阅读器" onClick={closeLibraryReader}>
                <PanelRightClose size={17} aria-hidden />
                收起
              </button>
            </div>
          </header>

          <div className={readerMode === "scroll" ? "reader-main scroll-mode" : "reader-main"}>
            <button
              className="reader-side-button"
              type="button"
              title="上一页"
              aria-label="上一页"
              disabled={previousDisabled}
              onClick={() => goToLibraryReaderPage(-1)}
            >
              <ChevronLeft size={28} aria-hidden />
            </button>
            <div ref={libraryReaderStageRef} className={readerMode === "scroll" ? "reader-image-stage scroll-mode" : "reader-image-stage"}>
              {libraryReaderLoading && <div className="reader-loading">加载中</div>}
              {readerMode === "scroll" ? (
                renderReaderScrollStack({
                  title: reader.item.title,
                  pages: pageMap,
                  pageNumbers: scrollPageNumbers,
                  currentPage,
                  disabled: libraryReaderLoading,
                  getKey: (page) => page.filename,
                  getCaption: (page) => page.filename,
                  jumpToPage: jumpLibraryReaderToPage,
                })
              ) : (
                renderReaderImage({
                  title: reader.item.title,
                  page: currentPage,
                  url: reader.page.url,
                  loading: "eager",
                })
              )}
            </div>
            <button className="reader-side-button" type="button" title="下一页" aria-label="下一页" disabled={nextDisabled} onClick={() => goToLibraryReaderPage(1)}>
              <ChevronRight size={28} aria-hidden />
            </button>
          </div>

          {readerControlsCollapsed ? (
            <button
              className="reader-controls-restore"
              type="button"
              title="显示阅读工具栏（H）"
              aria-label={`显示阅读器底栏，当前第 ${currentPage} 页，共 ${totalPages} 页`}
              aria-controls="library-reader-controls"
              aria-expanded={false}
              onClick={toggleReaderControls}
            >
              <ChevronUp size={15} aria-hidden />
              工具 · p{currentPage}/{totalPages}
            </button>
          ) : (
          <footer className="reader-footer" id="library-reader-controls">
            <button className="reader-footer-collapse" type="button" title="隐藏底栏（H）" onClick={toggleReaderControls}>
              <ChevronDown size={14} aria-hidden />
              收起底栏
            </button>
            <div className="reader-progress-line">
              <span>阅读进度 {progress}%</span>
              {readerMode === "scroll" && <span className="reader-sync-pill">滚动同步进度</span>}
              <span>{reader.page.filename}</span>
            </div>
            <div className="reader-progress-track">
              <div className="reader-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="reader-thumb-strip" aria-label="阅读器缩略图">
              {thumbnailPages.map((page) => (
                <button
                  className={page.index === currentPage ? "reader-thumb active" : "reader-thumb"}
                  type="button"
                  key={page.filename}
                  title={`跳到 p${page.index}`}
                  aria-current={page.index === currentPage ? "page" : undefined}
                  disabled={libraryReaderLoading}
                  onClick={() => jumpLibraryReaderToPage(page.index)}
                >
                  <img src={apiUrl(page.url)} alt={`${reader.item.title} p${page.index}`} loading="lazy" />
                  <span>p{page.index}</span>
                </button>
              ))}
            </div>
            <div className="reader-page-tools">
              <div className="reader-page-shortcuts" aria-label="临近页码">
                {pageShortcuts.map((page) => (
                  <button
                    className={page === currentPage ? "reader-page-button active" : "reader-page-button"}
                    type="button"
                    key={page}
                    aria-current={page === currentPage ? "page" : undefined}
                    disabled={libraryReaderLoading}
                    onClick={() => jumpLibraryReaderToPage(page)}
                  >
                    p{page}
                  </button>
                ))}
              </div>
              <form className="reader-jump-form" onSubmit={submitLibraryReaderJump}>
                <input
                  className="reader-page-input"
                  type="number"
                  min={1}
                  max={totalPages}
                  value={libraryReaderPageInput}
                  disabled={libraryReaderLoading}
                  onChange={(event) => setLibraryReaderPageInput(event.target.value)}
                  aria-label="跳转页码"
                />
                <button className="mini-button" type="submit" disabled={libraryReaderLoading}>
                  跳转
                </button>
              </form>
            </div>
            <div className="reader-footer-actions">
              <button className="mini-button" type="button" disabled={previousDisabled} onClick={() => goToLibraryReaderPage(-1)}>
                <ChevronLeft size={13} aria-hidden />
                上一页
              </button>
              <button className="mini-button" type="button" onClick={cycleReaderMode}>
                <ListRestart size={13} aria-hidden />
                {readerModeLabel[readerMode]}
              </button>
              <button className="mini-button" type="button" onClick={cycleLibraryReaderFit}>
                <Maximize2 size={13} aria-hidden />
                {readerFitLabel[libraryReaderFit]}
              </button>
              <button className="mini-button primary" type="button" disabled={nextDisabled} onClick={() => goToLibraryReaderPage(1)}>
                下一页
                <ChevronRight size={13} aria-hidden />
              </button>
            </div>
          </footer>
          )}
        </section>
      </div>
    );
  }

  function renderRemoteReader(reader: RemoteReaderState) {
    const currentPage = reader.page.index;
    const totalPages = Math.max(reader.total, currentPage, 1);
    const progress = Math.min(100, Math.round((currentPage / totalPages) * 100));
    const previousDisabled = remoteReaderLoading || currentPage <= 1;
    const nextDisabled = remoteReaderLoading || currentPage >= totalPages;
    const shortcutStart = Math.max(1, Math.min(currentPage - 2, Math.max(totalPages - 4, 1)));
    const pageShortcuts = Array.from({ length: Math.min(5, totalPages) }, (_, index) => shortcutStart + index).filter((page) => page <= totalPages);
    const thumbnailStart = Math.max(1, currentPage - 3);
    const thumbnailEnd = Math.min(totalPages, currentPage + 3);
    const preload =
      remoteReaderPreload?.sessionId === reader.session.id && remoteReaderPreload.page === currentPage ? remoteReaderPreload : null;
    const statusMap = remoteReaderPageStatuses[reader.session.id] ?? {};
    const thumbnailPages = (remoteReaderPages[reader.session.id] ?? [])
      .filter((page) => page.index >= thumbnailStart && page.index <= thumbnailEnd)
      .sort((left, right) => left.index - right.index);
    const loadedPages = remoteReaderKnownPages(reader);
    const statusSummary = remoteReaderStatusSummary(loadedPages, statusMap);
    const currentPageStatus = remoteReaderPageVisualStatus(reader.page, statusMap);
    const failedPages = loadedPages.filter((page) => remoteReaderPageVisualStatus(page, statusMap) === "failed");
    const bookmarks = remoteReaderBookmarks(reader.session);
    const currentBookmark = remoteReaderBookmarkForPage(reader.session, currentPage);
    const currentBookmarkSaving = remoteReaderBookmarkSavingKey === `${reader.session.id}:${currentPage}`;
    const pageMap = new Map(loadedPages.map((page) => [page.index, page]));
    pageMap.set(reader.page.index, reader.page);
    const scrollPageNumbers = readerScrollPageNumbers(currentPage, totalPages);

    return (
      <div className="reader-overlay" role="dialog" aria-modal="true" aria-label="在线漫画阅读器">
        <section className={readerControlsCollapsed ? "reader-shell controls-collapsed" : "reader-shell"}>
          <header className="reader-header">
            <div className="reader-title-block">
              <span>在线阅读器 · {reader.session.source_name}</span>
              <h2>{reader.session.title}</h2>
              <p>
                p{currentPage}/{totalPages} · 按需缓存，不需要先下载整本
              </p>
            </div>
            <div className="reader-actions">
              {renderReaderModeTabs()}
              <div className="reader-fit-tabs" aria-label="阅读器适配模式">
                {(["width", "height", "original"] as ReaderFit[]).map((fit) => (
                  <button
                    className={libraryReaderFit === fit ? "reader-fit-button active" : "reader-fit-button"}
                    type="button"
                    key={fit}
                    aria-pressed={libraryReaderFit === fit}
                    onClick={() => setLibraryReaderFit(fit)}
                  >
                    {readerFitLabel[fit]}
                  </button>
                ))}
              </div>
              <button
                className="reader-icon-button"
                type="button"
                title={`${readerControlsCollapsed ? "显示" : "隐藏"}底栏（H）`}
                aria-label={`${readerControlsCollapsed ? "显示" : "隐藏"}阅读器底栏`}
                aria-controls="remote-reader-controls"
                aria-expanded={!readerControlsCollapsed}
                onClick={toggleReaderControls}
              >
                {readerControlsCollapsed ? <ChevronUp size={17} aria-hidden /> : <ChevronDown size={17} aria-hidden />}
                {readerControlsCollapsed ? "显示底栏" : "隐藏底栏"}
              </button>
              <button className="reader-icon-button" type="button" title="收起阅读器" aria-label="收起阅读器" onClick={closeRemoteReader}>
                <PanelRightClose size={17} aria-hidden />
                收起
              </button>
            </div>
          </header>

          <div className={readerMode === "scroll" ? "reader-main scroll-mode" : "reader-main"}>
            <button
              className="reader-side-button"
              type="button"
              title="上一页"
              aria-label="上一页"
              disabled={previousDisabled}
              onClick={() => goToRemoteReaderPage(-1)}
            >
              <ChevronLeft size={28} aria-hidden />
            </button>
            <div ref={remoteReaderStageRef} className={readerMode === "scroll" ? "reader-image-stage scroll-mode" : "reader-image-stage"}>
              {remoteReaderLoading && <div className="reader-loading">加载中</div>}
              {readerMode === "scroll" ? (
                renderReaderScrollStack({
                  title: reader.session.title,
                  pages: pageMap,
                  pageNumbers: scrollPageNumbers,
                  currentPage,
                  disabled: remoteReaderLoading,
                  getKey: (page) => `${page.index}:${page.page_url}`,
                  getCaption: (page) => page.page_url,
                  getStatus: (page) => remoteReaderPageVisualStatus(page, statusMap),
                  jumpToPage: jumpRemoteReaderToPage,
                })
              ) : (
                renderReaderImage({
                  title: reader.session.title,
                  page: currentPage,
                  url: reader.page.url,
                  loading: "eager",
                })
              )}
            </div>
            <button className="reader-side-button" type="button" title="下一页" aria-label="下一页" disabled={nextDisabled} onClick={() => goToRemoteReaderPage(1)}>
              <ChevronRight size={28} aria-hidden />
            </button>
          </div>

          {readerControlsCollapsed ? (
            <button
              className="reader-controls-restore"
              type="button"
              title="显示阅读工具栏（H）"
              aria-label={`显示阅读器底栏，当前第 ${currentPage} 页，共 ${totalPages} 页`}
              aria-controls="remote-reader-controls"
              aria-expanded={false}
              onClick={toggleReaderControls}
            >
              <ChevronUp size={15} aria-hidden />
              工具 · p{currentPage}/{totalPages}
            </button>
          ) : (
          <footer className="reader-footer" id="remote-reader-controls">
            <button className="reader-footer-collapse" type="button" title="隐藏底栏（H）" onClick={toggleReaderControls}>
              <ChevronDown size={14} aria-hidden />
              收起底栏
            </button>
            <div className="reader-progress-line">
              <span>阅读进度 {progress}%</span>
              {readerMode === "scroll" && <span className="reader-sync-pill">滚动同步进度</span>}
              <span className={preload?.status === "failed" ? "reader-preload failed" : "reader-preload"}>
                {remoteReaderPreloadText(preload)}
              </span>
              <span>{reader.page.page_url}</span>
            </div>
            <div className="reader-status-panel" aria-label="远程页状态">
              <span className={`reader-status-pill ${currentPageStatus}`}>当前页：{remoteReaderStatusLabel(currentPageStatus)}</span>
              <span className="reader-status-counts">
                已就绪 {statusSummary.ready} · 失败 {statusSummary.failed} · 待加载 {statusSummary.loading + statusSummary.unknown}
              </span>
              <button
                className="mini-button"
                type="button"
                disabled={remoteReaderLoading}
                onClick={() => refreshRemoteReaderPageStatuses(reader.session.id, Math.max(0, currentPage - 4), Math.min(12, totalPages))}
              >
                <RefreshCcw size={13} aria-hidden />
                刷新状态
              </button>
              <button
                className="mini-button"
                type="button"
                disabled={remoteReaderLoading || remoteReaderMaintenanceKey === `clear-page:${reader.session.id}:${currentPage}`}
                onClick={() => clearRemoteReaderCurrentPageCache(reader)}
              >
                <HardDrive size={13} aria-hidden />
                清当前页
              </button>
              <button
                className="mini-button"
                type="button"
                disabled={remoteReaderLoading || remoteReaderMaintenanceKey === `clear-session:${reader.session.id}`}
                onClick={() => clearRemoteReaderAllCache(reader)}
              >
                <Archive size={13} aria-hidden />
                清本书缓存
              </button>
              <button
                className={currentBookmark ? "mini-button active" : "mini-button"}
                type="button"
                disabled={remoteReaderLoading || currentBookmarkSaving}
                onClick={() => toggleRemoteReaderBookmark(reader)}
              >
                <Star size={13} fill={currentBookmark ? "currentColor" : "none"} aria-hidden />
                {currentBookmark ? "取消书签" : "加书签"}
              </button>
              <button
                className="mini-button"
                type="button"
                disabled={remoteReaderLoading || !failedPages.length}
                onClick={() => retryRemoteReaderFailedPages(reader)}
              >
                <RefreshCcw size={13} aria-hidden />
                重试失败页{failedPages.length ? ` ${failedPages.length}` : ""}
              </button>
              <button
                className="mini-button primary"
                type="button"
                disabled={remoteReaderLoading || currentPageStatus !== "failed"}
                onClick={() => jumpRemoteReaderToNextAvailablePage(1)}
              >
                跳过失败页
                <ChevronRight size={13} aria-hidden />
              </button>
            </div>
            {bookmarks.length ? (
              <div className="reader-bookmark-strip" aria-label="远程阅读书签">
                <span>书签</span>
                {bookmarks.slice(0, 12).map((bookmark) => (
                  <div className={bookmark.page_index === currentPage ? "reader-bookmark active" : "reader-bookmark"} key={bookmark.page_index}>
                    <button
                      type="button"
                      title={`跳到 ${bookmark.label}`}
                      disabled={remoteReaderLoading}
                      onClick={() => jumpRemoteReaderToPage(bookmark.page_index)}
                    >
                      {bookmark.label}
                    </button>
                    <button
                      type="button"
                      title={`删除 ${bookmark.label}`}
                      aria-label={`删除书签 ${bookmark.label}`}
                      disabled={remoteReaderBookmarkSavingKey === `${reader.session.id}:${bookmark.page_index}`}
                      onClick={() => removeRemoteReaderBookmark(reader.session.id, bookmark.page_index)}
                    >
                      <XCircle size={12} aria-hidden />
                    </button>
                  </div>
                ))}
                {bookmarks.length > 12 && <strong>+{bookmarks.length - 12}</strong>}
              </div>
            ) : null}
            <div className="reader-progress-track">
              <div className="reader-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="reader-thumb-strip" aria-label="阅读器缩略图">
              {thumbnailPages.map((page) => {
                const pageStatus = remoteReaderPageVisualStatus(page, statusMap);
                return (
                  <button
                    className={page.index === currentPage ? `reader-thumb active ${pageStatus}` : `reader-thumb ${pageStatus}`}
                    type="button"
                    key={page.index}
                    title={`跳到 p${page.index} · ${remoteReaderStatusLabel(pageStatus)}`}
                    aria-current={page.index === currentPage ? "page" : undefined}
                    disabled={remoteReaderLoading}
                    onClick={() => jumpRemoteReaderToPage(page.index)}
                  >
                    <img
                      src={readerImageSrc(page.url)}
                      alt={`${reader.session.title} p${page.index}`}
                      loading="lazy"
                      onLoad={() => markReaderImageStatus(page.url, "loaded")}
                      onError={() => handleReaderImageError(page.url)}
                    />
                    <span>p{page.index}</span>
                  </button>
                );
              })}
            </div>
            <div className="reader-page-tools">
              <div className="reader-page-shortcuts" aria-label="临近页码">
                {pageShortcuts.map((page) => {
                  const pageStatus = pageMap.has(page) ? remoteReaderPageVisualStatus(pageMap.get(page)!, statusMap) : "unknown";
                  return (
                    <button
                      className={page === currentPage ? `reader-page-button active ${pageStatus}` : `reader-page-button ${pageStatus}`}
                      type="button"
                      key={page}
                      title={remoteReaderStatusLabel(pageStatus)}
                      aria-current={page === currentPage ? "page" : undefined}
                      disabled={remoteReaderLoading}
                      onClick={() => jumpRemoteReaderToPage(page)}
                    >
                      p{page}
                    </button>
                  );
                })}
              </div>
              <form className="reader-jump-form" onSubmit={submitRemoteReaderJump}>
                <input
                  className="reader-page-input"
                  type="number"
                  min={1}
                  max={totalPages}
                  value={remoteReaderPageInput}
                  disabled={remoteReaderLoading}
                  onChange={(event) => setRemoteReaderPageInput(event.target.value)}
                  aria-label="跳转页码"
                />
                <button className="mini-button" type="submit" disabled={remoteReaderLoading}>
                  跳转
                </button>
              </form>
            </div>
            <div className="reader-footer-actions">
              <button className="mini-button" type="button" disabled={previousDisabled} onClick={() => goToRemoteReaderPage(-1)}>
                <ChevronLeft size={13} aria-hidden />
                上一页
              </button>
              <button className="mini-button" type="button" onClick={cycleReaderMode}>
                <ListRestart size={13} aria-hidden />
                {readerModeLabel[readerMode]}
              </button>
              <button className="mini-button" type="button" onClick={cycleLibraryReaderFit}>
                <Maximize2 size={13} aria-hidden />
                {readerFitLabel[libraryReaderFit]}
              </button>
              <button className="mini-button primary" type="button" disabled={nextDisabled} onClick={() => goToRemoteReaderPage(1)}>
                下一页
                <ChevronRight size={13} aria-hidden />
              </button>
            </div>
          </footer>
          )}
        </section>
      </div>
    );
  }

  function renderLibraryDetail(item: LibraryItem, detail: LibraryDetail | null) {
    const pages = libraryPages[item.id] ?? detail?.pages ?? [];
    const pageTotal = libraryPageTotals[item.id] ?? detail?.pages_total ?? pages.length;
    const failedEntries = detail?.failed_entries ?? [];
    const metadata = detail?.metadata;
    const cbzExportKey = libraryExportKey(item.id, "cbz");
    const pdfExportKey = libraryExportKey(item.id, "pdf");
    const exportHistory = libraryExportHistory[item.id] ?? [];
    const cbzExporting = libraryExportingKey === cbzExportKey;
    const pdfExporting = libraryExportingKey === pdfExportKey;
    const shelf = detail?.shelf ?? item.shelf;
    const shelfSaving = libraryShelfSavingId === item.id;
    const noteDraft = libraryShelfDrafts[item.id] ?? shelf.note;
    const noteDirty = noteDraft !== shelf.note;
    const health = detail?.health ?? item.health;

    return (
      <aside className={detailDrawerClosing ? "detail-drawer library-drawer closing" : "detail-drawer library-drawer"} aria-label="文件库详情">
        <div className="detail-header">
          <div>
            <h2>{detail?.title ?? item.title}</h2>
            <span>{item.folder}</span>
          </div>
          <button className="drawer-close-button" type="button" title="收回侧边栏" aria-label="收回文件库详情侧边栏" onClick={closeDetailDrawer}>
            <PanelRightClose size={16} aria-hidden />
          </button>
        </div>

        <div className="detail-body">
          <section className="detail-section">
            <div className="detail-grid">
              <div>
                <span>图片</span>
                <strong>{detail?.image_count ?? item.image_count}</strong>
              </div>
              <div>
                <span>页数</span>
                <strong>{detail?.page_count ?? item.page_count}</strong>
              </div>
              <div>
                <span>失败</span>
                <strong>{detail?.failed_count ?? item.failed_count}</strong>
              </div>
              <div>
                <span>大小</span>
                <strong>{formatBytes(detail?.size_bytes ?? item.size_bytes)}</strong>
              </div>
              <div>
                <span>健康</span>
                <strong>{health?.status === "failed" ? "异常" : health?.status === "warning" ? "需处理" : "正常"}</strong>
              </div>
              <div>
                <span>缺页</span>
                <strong>{health?.missing_count ?? 0}</strong>
              </div>
              <div>
                <span>小图</span>
                <strong>{health?.suspicious_count ?? 0}</strong>
              </div>
              <div>
                <span>上次失败</span>
                <strong>{health?.last_failed ?? 0}</strong>
              </div>
            </div>
          </section>

          {health && health.status !== "ok" && (
            <section className="detail-section">
              <div className="detail-section-title">
                <h3>下载诊断</h3>
                <span className={health.status === "failed" ? "badge failed" : "badge warning"}>
                  {health.status === "failed" ? "异常" : "需处理"}
                </span>
              </div>
              <div className="health-panel">
                <div className="health-summary">
                  <AlertTriangle size={15} aria-hidden />
                  <span>
                    期望 {health.expected_count} 页，已有 {health.image_count} 张；小于 {formatBytes(health.suspicious_min_bytes)} 的图片会被视为疑似占位图。
                  </span>
                </div>
                <div className="health-issue-list">
                  {health.issues.map((issue) => (
                    <div className={issue.severity === "failed" ? "health-issue failed" : "health-issue"} key={`${issue.kind}-${issue.message}`}>
                      <strong>{healthIssueTitle(issue.kind)}</strong>
                      <span>{issue.message}</span>
                      {issue.samples?.length ? (
                        <div className="health-samples">
                          {issue.samples.map((sample) => (
                            <span key={sample.filename}>
                              {sample.filename} · {formatBytes(sample.size_bytes)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {health.updated_at && <div className="output-meta">download_state 更新于 {new Date(health.updated_at).toLocaleString()}</div>}
              </div>
            </section>
          )}

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>书架</h3>
              <div className="detail-actions">
                <button
                  className={shelf.favorite ? "mini-button active" : "mini-button"}
                  type="button"
                  disabled={shelfSaving}
                  onClick={() => updateShelfForItem(item, { favorite: !shelf.favorite })}
                >
                  <Star size={13} fill={shelf.favorite ? "currentColor" : "none"} aria-hidden />
                  {shelf.favorite ? "已收藏" : "收藏"}
                </button>
                {shelf.updated_at && <span className="section-note">{new Date(shelf.updated_at).toLocaleString()}</span>}
              </div>
            </div>
            <div className="reading-progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${readingProgressPercent({ ...item, shelf })}%` }} />
              </div>
              <div className="reading-progress-meta">
                <span>
                  {shelf.last_page ? `读到 p${shelf.last_page}/${libraryPageTotal(item)}` : "还没有阅读进度"}
                </span>
                {shelf.last_read_at && <span>{new Date(shelf.last_read_at).toLocaleString()}</span>}
              </div>
              <div className="detail-actions">
                <button className="mini-button primary" type="button" disabled={libraryPagesLoadingId === item.id} onClick={() => openLibraryReadingPage({ ...item, shelf })}>
                  <BookOpen size={13} aria-hidden />
                  继续阅读
                </button>
                <button className="mini-button" type="button" disabled={shelfSaving || !shelf.last_page} onClick={() => updateShelfForItem(item, { last_page: null, reading_status: "unread" })}>
                  清除进度
                </button>
              </div>
            </div>
            <div className="shelf-control-grid">
              <label className="field">
                <span>阅读状态</span>
                <select
                  className="select"
                  value={shelf.reading_status}
                  disabled={shelfSaving}
                  onChange={(event) => updateShelfForItem(item, { reading_status: event.target.value as LibraryReadingStatus })}
                >
                  <option value="unread">未读</option>
                  <option value="reading">在读</option>
                  <option value="finished">读完</option>
                  <option value="paused">搁置</option>
                </select>
              </label>
              <label className="field shelf-note-field">
                <span>备注</span>
                <textarea
                  className="textarea shelf-note"
                  value={noteDraft}
                  maxLength={1000}
                  disabled={shelfSaving}
                  onChange={(event) => setLibraryShelfDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                />
              </label>
              <button className="mini-button primary" type="button" disabled={shelfSaving || !noteDirty} onClick={() => updateShelfForItem(item, { note: noteDraft })}>
                <Save size={13} aria-hidden />
                保存备注
              </button>
            </div>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>本地目录</h3>
              <button className="mini-button" type="button" onClick={() => copyText("library folder", item.folder)}>
                <Copy size={13} aria-hidden />
                复制
              </button>
            </div>
            <div className="path-box">{item.folder}</div>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>补缺</h3>
              <div className="detail-actions">
                <span className="section-note">{detail?.failed_count ?? item.failed_count} 条失败记录</span>
                <button className="mini-button primary" type="button" disabled={libraryRetryingId === item.id} onClick={() => createLibraryRetryTask(item)}>
                  <FolderSync size={13} aria-hidden />
                  {libraryRetryingId === item.id ? "创建中" : "创建补缺任务"}
                </button>
              </div>
            </div>
            <div className="output-meta">按当前本地目录创建 missing-only 补缺计划，任务状态会在任务控制台中继续更新。</div>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>导出</h3>
              <div className="detail-actions">
                <button className="mini-button" type="button" disabled={libraryDetailLoading} onClick={() => refreshLibraryExports(item)}>
                  <RefreshCcw size={13} aria-hidden />
                  刷新历史
                </button>
                <button
                  className="mini-button primary"
                  type="button"
                  disabled={Boolean(libraryExportingKey) || (detail?.image_count ?? item.image_count) <= 0}
                  onClick={() => exportLibrary(item, "cbz")}
                >
                  <Archive size={13} aria-hidden />
                  {cbzExporting ? "导出中" : "导出 CBZ"}
                </button>
                <button
                  className="mini-button primary"
                  type="button"
                  disabled={Boolean(libraryExportingKey) || (detail?.image_count ?? item.image_count) <= 0}
                  onClick={() => exportLibrary(item, "pdf")}
                >
                  <FileText size={13} aria-hidden />
                  {pdfExporting ? "导出中" : "导出 PDF"}
                </button>
              </div>
            </div>
            <div className="export-results">
              {exportHistory.length ? (
                exportHistory.slice(0, 8).map((result) => renderLibraryExportResult(result.format.toUpperCase(), result))
              ) : (
                <div className="empty compact">暂无导出记录</div>
              )}
            </div>
          </section>

          {(detail?.gallery_url || item.gallery_url) && (
            <section className="detail-section">
              <div className="detail-section-title">
                <h3>来源</h3>
                <a className="mini-link" href={detail?.gallery_url || item.gallery_url || ""} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} aria-hidden />
                  打开
                </a>
              </div>
              <div className="path-box">{detail?.gallery_url || item.gallery_url}</div>
            </section>
          )}

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>Tag</h3>
              <span className="section-note">{(metadata?.tags ?? item.tags).length} 个</span>
            </div>
            <div className="result-tags">
              {(metadata?.tags ?? item.tags).slice(0, 60).map(renderLibraryTag)}
            </div>
          </section>

          <section className="detail-section">
            <div className="detail-section-title">
              <h3>页面预览</h3>
              <span className="section-note">{pageTotal ? `${pages.length}/${pageTotal} 页` : libraryDetailLoading ? "加载中" : "暂无页面"}</span>
            </div>
            {pages.length ? (
              <div className="page-grid">
                {pages.map((page) => (
                  <figure className="page-tile" key={page.filename}>
                    <button className="page-preview-button" type="button" title={`阅读 p${page.index}`} onClick={() => openLibraryReader({ ...item, shelf }, page.index)}>
                      <img src={apiUrl(page.url)} alt={`${item.title} p${page.index}`} loading="lazy" />
                    </button>
                    <figcaption>
                      <span>p{page.index}</span>
                      <span>{formatBytes(page.size_bytes)}</span>
                    </figcaption>
                    <button
                      className={shelf.last_page === page.index ? "page-mark-button active" : "page-mark-button"}
                      type="button"
                      disabled={shelfSaving}
                      onClick={() => markLibraryPageRead(item, page.index)}
                    >
                      {shelf.last_page === page.index ? "已读到这里" : "读到这里"}
                    </button>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="empty compact">{libraryDetailLoading ? "正在读取页面列表" : "暂无可预览图片"}</div>
            )}
            {pageTotal > 24 && (
              <div className="output-actions">
                {pages.length < pageTotal && (
                  <button className="mini-button" type="button" disabled={libraryPagesLoadingId === item.id} onClick={() => loadMoreLibraryPages(item)}>
                    {libraryPagesLoadingId === item.id ? "加载中" : "显示更多"}
                  </button>
                )}
                {pages.length > 24 && (
                  <button className="mini-button" type="button" onClick={() => collapseLibraryPages(item)}>
                    收起
                  </button>
                )}
                <span className="section-note">
                  已加载 {pages.length}/{pageTotal} 页
                </span>
              </div>
            )}
          </section>

          {failedEntries.length > 0 && (
            <section className="detail-section">
              <div className="detail-section-title">
                <h3>失败记录</h3>
                <span className="section-note">{failedEntries.length} 条</span>
              </div>
              <pre className="json-view">{jsonText(failedEntries)}</pre>
            </section>
          )}

          {metadata && (
            <section className="detail-section">
              <div className="detail-section-title">
                <h3>Metadata</h3>
                <button className="mini-button" type="button" onClick={() => copyText("metadata JSON", jsonText(metadata))}>
                  <Copy size={13} aria-hidden />
                  复制
                </button>
              </div>
              <pre className="json-view">{jsonText(metadata)}</pre>
            </section>
          )}
        </div>
      </aside>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Archive size={19} aria-hidden />
          </span>
          <span>Manga Platform</span>
        </div>

        <nav className="nav" aria-label="主导航">
          <button className={view === "tasks" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("tasks")}>
            <Activity size={17} aria-hidden />
            任务控制台
          </button>
          <button className={view === "library" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("library")}>
            <Cloud size={17} aria-hidden />
            文件库
          </button>
          <button className="nav-item" type="button">
            <ShieldCheck size={17} aria-hidden />
            审核
          </button>
          <button className="nav-item" type="button">
            <Server size={17} aria-hidden />
            基础设施
          </button>
        </nav>

        <div className="sidebar-status">
          <span>API http://localhost:8080</span>
          <span>Queue pending integration</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="title-block">
            <span className="eyebrow">Newwork Console</span>
            <h1>{view === "tasks" ? "任务控制台" : "文件库"}</h1>
          </div>
          <div className="toolbar">
            <span className={eventStreamReady ? "stream-state ready" : "stream-state"}>
              {eventStreamReady ? <Wifi size={15} aria-hidden /> : <WifiOff size={15} aria-hidden />}
              {eventStreamReady ? "实时" : "离线"}
            </span>
            <button className="button ghost" type="button" onClick={refreshActiveView} disabled={loading || libraryLoading || remoteReaderSessionsLoading}>
              <RefreshCcw size={16} aria-hidden />
              刷新
            </button>
            {view === "tasks" && (
              <button className="button primary" form="task-form" type="submit" disabled={loading}>
                <Play size={16} aria-hidden />
                创建任务
              </button>
            )}
          </div>
        </header>

        {view === "tasks" ? (
          <section className="content-grid">
          <details className="panel task-composer" open>
            <summary className="panel-header task-composer-summary">
              <div>
                <h2 className="panel-title">新建任务</h2>
                <span className="section-note">搜索、直链下载或补缺</span>
              </div>
              <span className="task-composer-toggle">展开 / 收起</span>
            </summary>
            <div className="panel-body">
              <form id="task-form" className="form" onSubmit={submitTask}>
                <div className="tabs" role="tablist" aria-label="任务模式">
                  <button className={mode === "search" ? "tab active" : "tab"} type="button" onClick={() => setMode("search")}>
                    搜索
                  </button>
                  <button className={mode === "gallery" ? "tab active" : "tab"} type="button" onClick={() => setMode("gallery")}>
                    直链
                  </button>
                  <button className={mode === "retry" ? "tab active" : "tab"} type="button" onClick={() => setMode("retry")}>
                    补缺
                  </button>
                </div>

                <label className="field">
                  <span>来源</span>
                  <select
                    className="select"
                    value={selectedSourceId}
                    disabled={!sources.length}
                    onChange={(event) => setSelectedSourceId(event.target.value)}
                  >
                    <option value={allSourcesValue} disabled={!defaultSearchSources.length}>
                      全部可用源站一起爬取
                    </option>
                    {sources.map((source) => (
                      <option key={source.id} value={source.id} disabled={!source.enabled}>
                        {source.name} · {source.version}
                        {source.enabled && source.available_for_default === false ? "（手动）" : ""}
                      </option>
                    ))}
                  </select>
                  {enabledSources.length > defaultSearchSources.length ? (
                    <small className="field-hint">
                      {enabledSources.length - defaultSearchSources.length} 个源站需要手动选择或配置授权后才加入默认搜索。
                    </small>
                  ) : null}
                </label>

                {shouldShowSourceAuthShortcut && sourceAuthDescriptor && (
                  <div className={sourceAuthStatus?.configured ? "source-auth-box ready" : "source-auth-box"}>
                    <div className="source-auth-header">
                      <div>
                        <strong>18comic 网页备用会话</strong>
                        <span>{sourceAuthStatus?.configured ? "已配置" : "API 模式无需配置"}</span>
                      </div>
                      <button
                        className="mini-button"
                        type="button"
                        disabled={sourceAuthLoading}
                        onClick={() => {
                          if (sourceAuthOpen) {
                            setSourceAuthOpen(false);
                            return;
                          }
                          void openSourceAuthPanel();
                        }}
                      >
                        <ShieldCheck size={13} aria-hidden />
                        {sourceAuthOpen ? "收起" : "配置"}
                      </button>
                    </div>
                    {sourceAuthOpen && (
                      <div className="source-auth-body">
                        <div className="source-auth-status">
                          <span>{sourceAuthStatus?.configured ? "网页备用会话可用" : "当前使用 API"}</span>
                          <span>{sourceAuthStatus?.has_effective_cookie_file ? "Cookie 已保存" : "Cookie 未保存"}</span>
                          <span>{sourceAuthStatus?.has_effective_headers_file ? "Header 已保存" : "Header 未保存"}</span>
                        </div>
                        <label className="field">
                          <span>Cookie</span>
                          <textarea
                            className="textarea compact"
                            value={sourceAuthCookie}
                            placeholder="name=value; name2=value2"
                            onChange={(event) => setSourceAuthCookie(event.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span>请求头</span>
                          <textarea
                            className="textarea compact"
                            value={sourceAuthHeaders}
                            placeholder={"User-Agent: ...\nReferer: https://18comic.vip/"}
                            onChange={(event) => setSourceAuthHeaders(event.target.value)}
                          />
                        </label>
                        <div className="source-auth-actions">
                          <button className="mini-button primary" type="button" disabled={sourceAuthLoading} onClick={saveSourceAuthSettings}>
                            <Save size={13} aria-hidden />
                            保存
                          </button>
                          <button className="mini-button" type="button" disabled={sourceAuthLoading} onClick={() => void refreshSourceAuth()}>
                            <RefreshCcw size={13} aria-hidden />
                            刷新
                          </button>
                          <button className="mini-button danger" type="button" disabled={sourceAuthLoading} onClick={clearSourceAuthSettings}>
                            <XCircle size={13} aria-hidden />
                            清除
                          </button>
                        </div>
                        <small className="field-hint">移动 API 默认无需 Cookie；这里仅供网页兼容回退。凭据只保存在项目目录 .data/source-auth 内。</small>
                        {sourceAuthStatus?.unavailable_reason ? <small className="field-hint">{sourceAuthStatus.unavailable_reason}</small> : null}
                      </div>
                    )}
                  </div>
                )}

                {mode === "search" && (
                  <>
                    <div className="field">
                      <span>搜索词条</span>
                      <TagAutocomplete
                        value={tags}
                        onChange={setTags}
                        excludedCanonical={globalExcludedTags}
                        multiline
                        ariaLabel="搜索词条，支持中文联想"
                        placeholder="输入中文或英文词条，例如：中文、巨乳、女仆"
                      />
                      <small className="field-hint">输入中文后可用 ↑ ↓ 选择，按 Enter 或 Tab 补全为源站英文词条。</small>
                    </div>
                    <section className="global-excluded-tags" aria-label="全局禁用词条">
                      <div className="global-excluded-tags-header">
                        <div>
                          <strong>全局禁用词条</strong>
                          <span>{globalExcludedTags.length ? `已启用 ${globalExcludedTags.length} 条` : "尚未设置"}</span>
                        </div>
                        {globalExcludedTags.length ? (
                          <button className="mini-button danger" type="button" onClick={() => saveGlobalExcludedTags([])}>
                            清空
                          </button>
                        ) : null}
                      </div>
                      <TagAutocomplete
                        value={excludedTagDraft}
                        onChange={setExcludedTagDraft}
                        onCommit={addGlobalExcludedTag}
                        excludedCanonical={globalExcludedTags}
                        ariaLabel="添加全局禁用词条"
                        placeholder="输入中文或英文，回车加入禁用列表"
                      />
                      {globalExcludedTags.length ? (
                        <div className="excluded-tag-chips" aria-label="已禁用词条列表">
                          {globalExcludedTags.map((tag) => {
                            const translation = tagTranslations.find((item) => normalizeTag(item.canonical) === normalizeTag(tag));
                            return (
                              <span className="excluded-tag-chip" key={tag}>
                                {translation ? <small>{translation.zh}</small> : null}
                                <strong>{tag}</strong>
                                <button type="button" title={`移除 ${tag}`} aria-label={`移除禁用词条 ${tag}`} onClick={() => removeGlobalExcludedTag(tag)}>
                                  <XCircle size={13} aria-hidden />
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      ) : (
                        <small className="field-hint">加入后会持久保存，并在每次多源搜索合并结果时自动排除匹配漫画。</small>
                      )}
                    </section>
                    <label className="field">
                      <span>名称关键词</span>
                      <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
                    </label>
                    <label className="field">
                      <span>自定义查询</span>
                      <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} />
                    </label>
                    <label className="field">
                      <span>每次加载数量</span>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        max={100}
                        value={limit}
                        onChange={(event) => setLimit(Math.min(100, Math.max(1, Number(event.target.value) || 1)))}
                      />
                    </label>
                  </>
                )}

                {mode === "gallery" && (
                  <>
                    <label className="field">
                      <span>图库 URL</span>
                      <input className="input" value={galleryUrl} onChange={(event) => setGalleryUrl(event.target.value)} />
                    </label>
                    <div className="direct-gallery-actions">
                      <button
                        className="mini-button primary"
                        type="button"
                        disabled={remoteReaderLoading || !directReaderCanOpen}
                        onClick={openDirectRemoteReader}
                      >
                        <BookOpen size={13} aria-hidden />
                        在线阅读
                      </button>
                      <span>{directReaderHint}</span>
                    </div>
                  </>
                )}

                {mode === "retry" && (
                  <>
                    <label className="field">
                      <span>下载目录</span>
                      <input className="input" value={retryFolder} onChange={(event) => setRetryFolder(event.target.value)} />
                    </label>
                    <div className="field-row">
                      <label className="field">
                        <span>起始页</span>
                        <input className="input" type="number" min={1} value={startPage} onChange={(event) => setStartPage(event.target.value)} />
                      </label>
                      <label className="field">
                        <span>结束页</span>
                        <input className="input" type="number" min={1} value={endPage} onChange={(event) => setEndPage(event.target.value)} />
                      </label>
                    </div>
                    <label className="field">
                      <span>补缺策略</span>
                      <select className="select" value={missingOnly ? "missing" : "all"} onChange={(event) => setMissingOnly(event.target.value === "missing")}>
                        <option value="missing">只补缺失页</option>
                        <option value="all">重新处理选中页</option>
                      </select>
                    </label>
                  </>
                )}

                {error && <div className="error">{error}</div>}
              </form>
            </div>
          </details>

          <div className="right-stack">
            <section className="metrics" aria-label="任务统计">
              <button
                className={taskStatusFilter === "all" ? "metric metric-button active" : "metric metric-button"}
                type="button"
                aria-pressed={taskStatusFilter === "all"}
                onClick={() => setTaskStatusFilter("all")}
              >
                <span>全部任务</span>
                <strong>{metrics.total}</strong>
              </button>
              <button
                className={taskStatusFilter === "queued" ? "metric metric-button active" : "metric metric-button"}
                type="button"
                aria-pressed={taskStatusFilter === "queued"}
                onClick={() => setTaskStatusFilter("queued")}
              >
                <span>排队</span>
                <strong>{metrics.queued}</strong>
              </button>
              <button
                className={taskStatusFilter === "running" ? "metric metric-button active" : "metric metric-button"}
                type="button"
                aria-pressed={taskStatusFilter === "running"}
                onClick={() => setTaskStatusFilter("running")}
              >
                <span>运行</span>
                <strong>{metrics.running}</strong>
              </button>
              <button
                className={taskStatusFilter === "failed" ? "metric metric-button active" : "metric metric-button"}
                type="button"
                aria-pressed={taskStatusFilter === "failed"}
                onClick={() => setTaskStatusFilter("failed")}
              >
                <span>失败</span>
                <strong>{metrics.failed}</strong>
              </button>
            </section>

            {renderRemoteReaderHistory()}

            <section className="panel task-list-panel">
              <div className="panel-header task-list-header">
                <div className="task-list-heading">
                  <h2 className="panel-title">任务</h2>
                  <span className="section-note">
                    显示 {filteredTasks.length} / 共 {tasks.length}
                  </span>
                </div>
                <div className="task-toolbar" aria-label="任务筛选">
                  <label className="task-toolbar-search">
                    <Search size={15} aria-hidden />
                    <input
                      className="input"
                      value={taskQuery}
                      aria-label="按关键词筛选任务"
                      placeholder="筛选标题、ID 或结果"
                      onChange={(event) => setTaskQuery(event.target.value)}
                    />
                  </label>
                  <select
                    className="select task-toolbar-select"
                    aria-label="按任务类型筛选"
                    value={taskKindFilter}
                    onChange={(event) => setTaskKindFilter(event.target.value as TaskKind | "all")}
                  >
                      <option value="all">全部类型</option>
                      <option value="search">搜索</option>
                      <option value="gallery">直链</option>
                      <option value="retry_folder">补缺</option>
                  </select>
                  <select
                    className="select task-toolbar-select"
                    aria-label="按任务状态筛选"
                    value={taskStatusFilter}
                    onChange={(event) => setTaskStatusFilter(event.target.value as TaskStatus | "all")}
                  >
                      <option value="all">全部状态</option>
                      <option value="queued">排队</option>
                      <option value="running">运行</option>
                      <option value="paused">暂停</option>
                      <option value="completed">完成</option>
                      <option value="failed">失败</option>
                      <option value="canceled">取消</option>
                  </select>
                  <button
                    className="icon-button"
                    type="button"
                    title="清空筛选"
                    aria-label="清空任务筛选"
                    onClick={clearTaskFilters}
                    disabled={!taskFiltersActive}
                  >
                    <XCircle size={15} aria-hidden />
                  </button>
                </div>
              </div>
              <div className="table-wrap">
                {filteredTasks.length ? (
                  <table className="task-table">
                    <colgroup>
                      <col className="task-column-title" />
                      <col className="task-column-kind" />
                      <col className="task-column-status" />
                      <col className="task-column-progress" />
                      <col className="task-column-result" />
                      <col className="task-column-updated" />
                      <col className="task-column-actions" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>任务</th>
                        <th>类型</th>
                        <th>状态</th>
                        <th>进度</th>
                        <th>结果</th>
                        <th>更新时间</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTasks.map((task) => {
                        const total = Math.max(task.progress.total, task.progress.done + task.progress.failed, 1);
                        const percent = Math.min(100, Math.round((task.progress.done / total) * 100));
                        const resultSummary = summarizeTaskResult(task);
                        return (
                          <tr key={task.id}>
                            <td className="task-cell-title">
                              <button className="task-title" type="button" onClick={() => openTaskDetail(task.id)}>
                                <strong>{task.title}</strong>
                                <span>{task.id}</span>
                              </button>
                            </td>
                            <td className="task-cell-kind">
                              <span className={`task-kind ${task.kind}`}>{kindLabel[task.kind]}</span>
                            </td>
                            <td className="task-cell-status">
                              <span className={`badge ${task.status}`}>{statusLabel[task.status]}</span>
                            </td>
                            <td className="task-cell-progress">
                              <div className="task-progress">
                                <div className="progress-track">
                                  <div className="progress-fill" style={{ width: `${percent}%` }} />
                                </div>
                                <span title={task.progress.message}>{task.progress.message}</span>
                              </div>
                            </td>
                            <td className="task-cell-result">
                              <button
                                className="task-result-link"
                                type="button"
                                disabled={!task.output}
                                onClick={() => openTaskDetail(task.id)}
                              >
                                <strong>{resultSummary.primary}</strong>
                                {resultSummary.detail ? <span>{resultSummary.detail}</span> : null}
                              </button>
                            </td>
                            <td className="task-cell-updated">
                              <time dateTime={task.updated_at}>{new Date(task.updated_at).toLocaleString()}</time>
                            </td>
                            <td className="task-cell-actions">
                              <div className="task-actions">
                                <button
                                  className="icon-button"
                                  type="button"
                                  title="查看详情"
                                  aria-label="查看详情"
                                  onClick={() => openTaskDetail(task.id)}
                                >
                                  <Eye size={16} aria-hidden />
                                </button>
                                <button
                                  className="icon-button"
                                  type="button"
                                  title="重跑任务"
                                  aria-label="重跑任务"
                                  disabled={loading || Boolean(rerunningTaskId)}
                                  onClick={() => rerunTask(task)}
                                >
                                  <RefreshCcw size={16} aria-hidden />
                                </button>
                                <button
                                  className="icon-button danger"
                                  type="button"
                                  title="取消任务"
                                  aria-label="取消任务"
                                  disabled={loading || !cancelableStatuses.has(task.status)}
                                  onClick={() => cancelTaskById(task.id)}
                                >
                                  <XCircle size={16} aria-hidden />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="empty">
                    <Search size={24} aria-hidden />
                    <span>{tasks.length ? "没有匹配任务" : "暂无任务"}</span>
                  </div>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2 className="panel-title">事件日志</h2>
                <FolderSync size={18} aria-hidden />
              </div>
              <div className="panel-body">
                <div className="log" aria-live="polite">
                  {logLines.map((line, index) => (
                    <div key={`${line}-${index}`}>{line}</div>
                  ))}
                </div>
              </div>
            </section>
          </div>
          </section>
        ) : (
          renderLibraryView()
        )}
      </main>
      {(selectedTask || selectedLibrarySummary) && (
        <button className={detailDrawerClosing ? "drawer-backdrop closing" : "drawer-backdrop"} type="button" aria-label="收回侧边栏" onClick={closeDetailDrawer} />
      )}
      {selectedTask && renderTaskDetail(selectedTask)}
      {selectedLibrarySummary && renderLibraryDetail(selectedLibrarySummary, selectedLibraryDetail)}
      {libraryReader && renderLibraryReader(libraryReader)}
      {remoteReader && renderRemoteReader(remoteReader)}
    </div>
  );
}
