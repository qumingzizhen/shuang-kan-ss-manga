"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCcw, Save, ShieldCheck, XCircle } from "lucide-react";
import {
  deleteSourceAuth,
  getSourceAuth,
  saveSourceAuth,
  type SourceAdapterDescriptor,
  type SourceAuthStatus,
} from "@/lib/api";
import { fetchDashboardSources } from "@/lib/dashboard-queries";

type SourceAuthPanelProps = {
  descriptor: SourceAdapterDescriptor;
  onSourcesChange: (sources: SourceAdapterDescriptor[]) => void;
  onLog: (message: string) => void;
  onStart: () => void;
  onError: (error: unknown) => void;
  onValidationError: (message: string) => void;
};

export function SourceAuthPanel({
  descriptor,
  onSourcesChange,
  onLog,
  onStart,
  onError,
  onValidationError,
}: SourceAuthPanelProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SourceAuthStatus | null>(null);
  const [cookie, setCookie] = useState("");
  const [headers, setHeaders] = useState("");
  const [loading, setLoading] = useState(false);
  const auth = descriptor.auth;

  async function refresh() {
    setLoading(true);
    onStart();
    try {
      const [nextStatus, nextSources] = await Promise.all([
        getSourceAuth(descriptor.id),
        fetchDashboardSources(queryClient, true),
      ]);
      setStatus(nextStatus);
      onSourcesChange(nextSources);
      onLog(`loaded source auth status for ${descriptor.id}`);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    await refresh();
  }

  async function save() {
    if (!cookie.trim() && !headers.trim()) {
      onValidationError("请先粘贴 Cookie 或请求头");
      return;
    }
    setLoading(true);
    onStart();
    try {
      const nextStatus = await saveSourceAuth(descriptor.id, { cookie, headers });
      const nextSources = await fetchDashboardSources(queryClient, true);
      setStatus(nextStatus);
      onSourcesChange(nextSources);
      setCookie("");
      setHeaders("");
      onLog(`saved ${descriptor.id} source auth`);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  async function clear() {
    setLoading(true);
    onStart();
    try {
      const nextStatus = await deleteSourceAuth(descriptor.id);
      const nextSources = await fetchDashboardSources(queryClient, true);
      setStatus(nextStatus);
      onSourcesChange(nextSources);
      setCookie("");
      setHeaders("");
      onLog(`cleared ${descriptor.id} source auth`);
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={status?.configured ? "source-auth-box ready" : "source-auth-box"}>
      <div className="source-auth-header">
        <div>
          <strong>{auth?.title || `${descriptor.name} 会话配置`}</strong>
          <span>{status?.configured ? "已配置" : "未配置"}</span>
        </div>
        <button className="mini-button" type="button" disabled={loading} onClick={() => void toggle()}>
          <ShieldCheck size={13} aria-hidden />
          {open ? "收起" : "配置"}
        </button>
      </div>
      {open && (
        <div className="source-auth-body">
          <div className="source-auth-status">
            <span>{status?.configured ? "认证会话可用" : "尚未保存认证信息"}</span>
            <span>{status?.has_effective_cookie_file ? "Cookie 已保存" : "Cookie 未保存"}</span>
            <span>{status?.has_effective_headers_file ? "Header 已保存" : "Header 未保存"}</span>
          </div>
          {auth?.fields.includes("cookie") && (
            <label className="field">
              <span>Cookie</span>
              <textarea
                className="textarea compact"
                value={cookie}
                placeholder="name=value; name2=value2"
                onChange={(event) => setCookie(event.target.value)}
              />
            </label>
          )}
          {auth?.fields.includes("headers") && (
            <label className="field">
              <span>请求头</span>
              <textarea
                className="textarea compact"
                value={headers}
                placeholder={auth.headers_placeholder || "User-Agent: ..."}
                onChange={(event) => setHeaders(event.target.value)}
              />
            </label>
          )}
          <div className="source-auth-actions">
            <button className="mini-button primary" type="button" disabled={loading} onClick={() => void save()}>
              <Save size={13} aria-hidden />
              保存
            </button>
            <button className="mini-button" type="button" disabled={loading} onClick={() => void refresh()}>
              <RefreshCcw size={13} aria-hidden />
              刷新
            </button>
            <button className="mini-button danger" type="button" disabled={loading} onClick={() => void clear()}>
              <XCircle size={13} aria-hidden />
              清除
            </button>
          </div>
          <small className="field-hint">
            {auth?.description || "认证信息仅保存在项目目录 .data/source-auth 内。"}
          </small>
          {status?.unavailable_reason ? <small className="field-hint">{status.unavailable_reason}</small> : null}
        </div>
      )}
    </div>
  );
}