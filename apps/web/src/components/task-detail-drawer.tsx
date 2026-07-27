"use client";

import { Copy, Download, PanelRightClose, RefreshCcw } from "lucide-react";
import { AsyncState } from "@/components/async-state";
import { SearchResultsView } from "@/components/search-results-view";
import { TaskTechnicalDetails } from "@/components/task-technical-details";
import type { Task, TaskSearchResult } from "@/lib/api";
import { kindLabel, statusLabel } from "@/lib/dashboard-model";

export type TaskDetailSearchState = {
  results: TaskSearchResult[];
  selectedKeys: string[];
  sourceErrorCount: number;
  excludedCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError?: string | null;
};

type TaskDetailActions = {
  close: () => void;
  rerun: () => void;
  copy: (label: string, value: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  downloadSelected: () => void;
  toggleSelected: (result: TaskSearchResult) => void;
  loadMore: () => void;
  read: (result: TaskSearchResult) => void;
  download: (result: TaskSearchResult) => void;
};

type TaskDetailDrawerProps = {
  task: Task;
  closing: boolean;
  actionBusy: boolean;
  rerunBusy: boolean;
  readerBusy: boolean;
  search?: TaskDetailSearchState | null;
  canRead: (sourceId: string) => boolean;
  actions: TaskDetailActions;
};

export function TaskDetailDrawer({
  task,
  closing,
  actionBusy,
  rerunBusy,
  readerBusy,
  search,
  canRead,
  actions,
}: TaskDetailDrawerProps) {
  const output = task.output;
  return (
    <aside
      className={[
        "detail-drawer",
        output?.type === "search_results" ? "search-detail-drawer" : "",
        closing ? "closing" : "",
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
            disabled={actionBusy || rerunBusy}
            onClick={actions.rerun}
          >
            <RefreshCcw size={13} aria-hidden />
            重跑
          </button>
          <button
            className="drawer-close-button"
            type="button"
            title="收回侧边栏"
            aria-label="收回任务详情侧边栏"
            onClick={actions.close}
          >
            <PanelRightClose size={16} aria-hidden />
          </button>
        </div>
      </div>

      <div className="detail-body">
        <TaskProgressSummary task={task} />

        {output?.type === "search_results" ? (
          search ? (
            <SearchTaskResultSection
              task={task}
              search={search}
              actionBusy={actionBusy}
              readerBusy={readerBusy}
              canRead={canRead}
              actions={actions}
            />
          ) : (
            <AsyncState compact kind="error" message="搜索结果状态暂不可用" />
          )
        ) : null}

        {output?.type === "gallery_download" ? (
          <section className="detail-section">
            <div className="detail-section-title">
              <h3>下载结果</h3>
              <button className="mini-button" type="button" onClick={() => actions.copy("output folder", output.output_folder)}>
                <Copy size={13} aria-hidden />
                复制路径
              </button>
            </div>
            <div className="path-box">{output.output_folder}</div>
          </section>
        ) : null}

        {output?.type === "retry_plan" ? (
          <section className="detail-section">
            <div className="detail-section-title">
              <h3>补缺计划</h3>
              <button className="mini-button" type="button" onClick={() => actions.copy("retry folder", output.folder)}>
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
        ) : null}

        <TaskTechnicalDetails payload={task.payload} output={output} onCopy={actions.copy} />
      </div>
    </aside>
  );
}

function TaskProgressSummary({ task }: { task: Task }) {
  return (
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
  );
}

function SearchTaskResultSection({
  task,
  search,
  actionBusy,
  readerBusy,
  canRead,
  actions,
}: {
  task: Task;
  search: TaskDetailSearchState;
  actionBusy: boolean;
  readerBusy: boolean;
  canRead: (sourceId: string) => boolean;
  actions: TaskDetailActions;
}) {
  const selectedCount = search.selectedKeys.length;

  return (
    <section className="detail-section search-results-section">
      <div className="detail-section-title">
        <h3>搜索结果</h3>
        <div className="detail-actions">
          <button className="mini-button" type="button" onClick={actions.selectAll}>
            全选
          </button>
          <button className="mini-button" type="button" onClick={actions.clearSelection} disabled={!selectedCount}>
            清空
          </button>
          <button className="mini-button primary" type="button" onClick={actions.downloadSelected} disabled={actionBusy || !selectedCount}>
            <Download size={13} aria-hidden />
            {selectedCount ? `下载 ${selectedCount}` : "批量下载"}
          </button>
        </div>
      </div>

      {search.sourceErrorCount ? (
        <div className="source-warning">
          {search.sourceErrorCount} 个源站暂时不可用，已合并显示其余结果。
        </div>
      ) : null}
      {search.excludedCount ? (
        <div className="excluded-result-notice">已自动排除 {search.excludedCount} 条命中全局禁用词条的结果</div>
      ) : null}

      {search.results.length ? (
        <SearchResultsView
          taskId={task.id}
          results={search.results}
          selectedKeys={search.selectedKeys}
          hasMore={search.hasMore}
          loadingMore={search.loadingMore}
          loadMoreError={search.loadMoreError}
          actionBusy={actionBusy}
          readerBusy={readerBusy}
          canRead={canRead}
          onToggleSelected={actions.toggleSelected}
          onLoadMore={actions.loadMore}
          onRead={actions.read}
          onDownload={actions.download}
        />
      ) : (
        <AsyncState compact kind="empty" message="当前结果均已被全局禁用词条排除" />
      )}
    </section>
  );
}
