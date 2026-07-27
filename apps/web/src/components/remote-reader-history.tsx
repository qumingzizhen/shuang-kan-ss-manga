"use client";

import { useMemo, useState } from "react";
import {
  BookOpen,
  Copy,
  HardDrive,
  RefreshCcw,
  Search,
  XCircle,
} from "lucide-react";
import { AsyncState } from "@/components/async-state";
import type { RemoteReaderSessionSummary } from "@/lib/api";
import {
  formatLastReadTime,
  normalizeSearchText,
} from "@/lib/dashboard-model";

type RemoteReaderHistoryProps = {
  sessions: RemoteReaderSessionSummary[];
  loading: boolean;
  readerBusy: boolean;
  maintenanceKey: string | null;
  onRefresh: () => void;
  onResume: (session: RemoteReaderSessionSummary) => void;
  onClearCache: (session: RemoteReaderSessionSummary) => void;
  onCopyLink: (session: RemoteReaderSessionSummary) => void;
  onDelete: (session: RemoteReaderSessionSummary) => void;
};

export function RemoteReaderHistory({
  sessions,
  loading,
  readerBusy,
  maintenanceKey,
  onRefresh,
  onResume,
  onClearCache,
  onCopyLink,
  onDelete,
}: RemoteReaderHistoryProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const filteredSessions = useMemo(() => {
    const queryText = normalizeSearchText(query);
    if (!queryText) {
      return sessions;
    }
    return sessions.filter((session) =>
      normalizeSearchText([
        session.title,
        session.source_name,
        session.gallery_url,
        ...session.tags,
      ].join(" ")).includes(queryText),
    );
  }, [query, sessions]);
  const visibleLimit = expanded ? 12 : 5;
  const visibleSessions = filteredSessions.slice(0, visibleLimit);

  return (
    <section className="panel remote-reader-panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">最近在线阅读</h2>
          <span className="section-note">
            {filteredSessions.length}/{sessions.length} 个会话
          </span>
        </div>
        <div className="remote-reader-header-actions">
          <button
            className="mini-button"
            type="button"
            disabled={sessions.length <= 5}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "折叠" : "展开"}
          </button>
          <button
            className="icon-button"
            type="button"
            title="刷新在线阅读记录"
            aria-label="刷新在线阅读记录"
            onClick={onRefresh}
          >
            <RefreshCcw size={15} aria-hidden />
          </button>
        </div>
      </div>

      <label className="remote-reader-filter">
        <Search size={14} aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选标题、来源、tag"
          aria-label="筛选在线阅读记录"
        />
        {query ? (
          <button type="button" aria-label="清空在线阅读筛选" onClick={() => setQuery("")}>
            <XCircle size={14} aria-hidden />
          </button>
        ) : null}
      </label>

      <div className="remote-reader-list">
        {visibleSessions.length ? (
          visibleSessions.map((session) => (
            <RemoteReaderHistoryCard
              key={session.id}
              session={session}
              readerBusy={readerBusy}
              maintenanceKey={maintenanceKey}
              onResume={onResume}
              onClearCache={onClearCache}
              onCopyLink={onCopyLink}
              onDelete={onDelete}
            />
          ))
        ) : (
          <AsyncState
            compact
            kind={loading ? "loading" : "empty"}
            message={loading ? "正在加载" : "暂无匹配的在线阅读记录"}
          />
        )}
      </div>
    </section>
  );
}

function RemoteReaderHistoryCard({
  session,
  readerBusy,
  maintenanceKey,
  onResume,
  onClearCache,
  onCopyLink,
  onDelete,
}: {
  session: RemoteReaderSessionSummary;
  readerBusy: boolean;
  maintenanceKey: string | null;
  onResume: (session: RemoteReaderSessionSummary) => void;
  onClearCache: (session: RemoteReaderSessionSummary) => void;
  onCopyLink: (session: RemoteReaderSessionSummary) => void;
  onDelete: (session: RemoteReaderSessionSummary) => void;
}) {
  const percent = remoteReaderProgressPercent(session);
  const lastPage = session.last_page ?? 1;
  const bookmarkCount = session.bookmarks.length;

  return (
    <article className="remote-reader-card">
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
        <button className="mini-button primary" type="button" disabled={readerBusy} onClick={() => onResume(session)}>
          <BookOpen size={13} aria-hidden />
          继续
        </button>
        <button
          className="mini-button"
          type="button"
          disabled={maintenanceKey === `clear-session:${session.id}`}
          onClick={() => onClearCache(session)}
        >
          <HardDrive size={13} aria-hidden />
          缓存
        </button>
        <button className="mini-button" type="button" onClick={() => onCopyLink(session)}>
          <Copy size={13} aria-hidden />
          链接
        </button>
        <button
          className="icon-button danger"
          type="button"
          title="删除在线阅读记录"
          aria-label={`删除在线阅读记录：${session.title}`}
          disabled={maintenanceKey === `delete:${session.id}`}
          onClick={() => onDelete(session)}
        >
          <XCircle size={15} aria-hidden />
        </button>
      </div>
    </article>
  );
}

function remoteReaderProgressPercent(session: RemoteReaderSessionSummary) {
  const total = Math.max(session.page_count || 0, 1);
  const page = Math.min(Math.max(session.last_page || 0, 0), total);
  return Math.min(100, Math.round((page / total) * 100));
}
