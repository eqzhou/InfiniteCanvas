import { useCallback, useEffect, useMemo, useState } from "react";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { canManageAdmin } from "@/services/admin";
import {
  deleteAICallLogs,
  getAICallLog,
  getAICallLogClientReport,
  getAICallLogRetention,
  listAICallLogs,
  putAICallLogClientReport,
  putAICallLogRetention,
  type AICallLog,
  type AICallLogClientReport,
  type AICallLogRetention,
} from "@/services/ai-call-logs";
import { invalidateAICallLogClientReportCache } from "@/services/generation-activity";

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function prettyJSON(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}

export function AICallLogsPage() {
  const auth = useOptionalAuth();
  const canManage = canManageAdmin(auth);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AICallLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retention, setRetention] = useState<AICallLogRetention>({ enabled: false, retentionDays: 30 });
  const [clientReport, setClientReport] = useState<AICallLogClientReport>({ enabled: false });
  const [detail, setDetail] = useState<AICallLog | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleanupDays, setCleanupDays] = useState(30);
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listAICallLogs({
        q,
        kind: kind === "all" ? undefined : kind,
        status: status === "all" ? undefined : status,
        page,
        pageSize,
      });
      setItems(result.items);
      setTotal(result.total);
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [q, kind, status, page]);

  useEffect(() => {
    if (!canManage) return;
    void load();
  }, [load, canManage]);

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    void getAICallLogRetention()
      .then((policy) => { if (!cancelled) setRetention(policy); })
      .catch(() => undefined);
    void getAICallLogClientReport()
      .then((policy) => { if (!cancelled) setClientReport(policy); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [canManage]);

  useEffect(() => {
    setPage(1);
  }, [q, kind, status]);

  const allSelected = useMemo(
    () => items.length > 0 && items.every((item) => selected.has(item.id)),
    [items, selected],
  );

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(items.map((item) => item.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openDetail = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      setDetail(await getAICallLog(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`删除选中的 ${selected.size} 条 AI 调用日志？`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAICallLogs({ ids: Array.from(selected) });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cleanupOld = async () => {
    const days = Math.max(1, Math.min(3650, Math.floor(cleanupDays) || 30));
    if (!window.confirm(`清理 ${days} 天前的 AI 调用日志？`)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteAICallLogs({ olderThanDays: days });
      window.alert(`已清理 ${result.deleted} 条日志`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-xl font-semibold text-[var(--ob-ink)]">AI 调用日志</h1>
        <p className="mt-2 text-sm text-[var(--ob-muted)]">仅管理员可浏览与清理后端 AI 调用日志。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ob-ink)]">AI 调用日志</h1>
          <p className="mt-1 text-sm text-[var(--ob-muted)]">
            后端代理与（可选）浏览器本地直连的请求/响应摘要、耗时、模型与渠道。密钥与二进制内容已脱敏。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm text-[var(--ob-muted)]">
            保留天数
            <input
              type="number"
              min={1}
              max={3650}
              className="ob-input w-20"
              value={cleanupDays}
              onChange={(event) => setCleanupDays(Number(event.target.value) || 30)}
            />
          </label>
          <button type="button" className="ob-btn" disabled={busy} onClick={() => void cleanupOld()}>
            清理过期
          </button>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--ob-muted)]">
            <input
              type="checkbox"
              aria-label="自动清理日志"
              checked={retention.enabled}
              disabled={busy}
              onChange={(event) => {
                const next = {
                  enabled: event.target.checked,
                  retentionDays: Math.max(1, Math.min(3650, Math.floor(cleanupDays) || 30)),
                };
                setRetention(next);
                void putAICallLogRetention(next)
                  .then(setRetention)
                  .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            />
            自动清理{retention.enabled ? `（每 ${retention.retentionDays} 天）` : ""}
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--ob-muted)]">
            <input
              type="checkbox"
              aria-label="本地直连日志上报"
              checked={clientReport.enabled}
              disabled={busy}
              onChange={(event) => {
                const next = { enabled: event.target.checked };
                setClientReport(next);
                void putAICallLogClientReport(next)
                  .then((policy) => {
                    setClientReport(policy);
                    invalidateAICallLogClientReportCache();
                  })
                  .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            />
            本地直连上报
          </label>
          <button
            type="button"
            className="ob-btn"
            disabled={busy || selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            删除选中
          </button>
          <button type="button" className="ob-btn" disabled={busy} onClick={() => void load()}>
            刷新
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="ob-input min-w-[12rem] flex-1"
          placeholder="搜索 job / model / channel / error…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <select className="ob-input w-auto" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="all">全部类型</option>
          <option value="image">image</option>
          <option value="video">video</option>
          <option value="audio">audio</option>
        </select>
        <select className="ob-input w-auto" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">全部状态</option>
          <option value="succeeded">succeeded</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>

      {error ? (
        <div role="alert" className="ob-banner" data-tone="warning">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-xl border border-[var(--ob-line)] p-8 text-sm text-[var(--ob-muted)]">
          正在加载 AI 调用日志…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--ob-line)] p-8 text-sm text-[var(--ob-muted)]">
          暂无 AI 调用日志。后端代理生成任务完成后会出现在此。
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-[var(--ob-line)]">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[var(--ob-canvas)] text-[var(--ob-muted)]">
              <tr>
                <th className="px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全选" />
                </th>
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">模型</th>
                <th className="px-3 py-2 font-medium">渠道</th>
                <th className="px-3 py-2 font-medium">耗时</th>
                <th className="px-3 py-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-[var(--ob-line)]">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggleOne(item.id)}
                      aria-label={`选择 ${item.id}`}
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[var(--ob-muted)]">
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{item.kind}</td>
                  <td className="px-3 py-2">{item.status}</td>
                  <td className="max-w-[10rem] truncate px-3 py-2" title={item.model}>
                    {item.model || "-"}
                  </td>
                  <td className="max-w-[10rem] truncate px-3 py-2" title={item.channelName || item.channelId}>
                    {item.channelName || item.channelId || "-"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDuration(item.durationMs)}</td>
                  <td className="px-3 py-2">
                    <button type="button" className="ob-btn" disabled={busy} onClick={() => void openDetail(item.id)}>
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-center gap-2">
          <button type="button" className="ob-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span className="text-sm text-[var(--ob-muted)]">
            {page} / {totalPages} · 共 {total}
          </span>
          <button
            type="button"
            className="ob-btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}

      {detail ? (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={() => setDetail(null)}>
          <div
            role="dialog"
            aria-label="AI 调用日志详情"
            className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 shadow-[var(--ob-elev-2)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ob-ink)]">调用详情</h2>
                <p className="mt-1 text-xs text-[var(--ob-muted)]">{detail.id}</p>
              </div>
              <button type="button" className="ob-btn" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
            <div className="mt-3 grid gap-2 text-sm text-[var(--ob-muted)] sm:grid-cols-2">
              <div>类型：{detail.kind}</div>
              <div>状态：{detail.status}</div>
              <div>模型：{detail.model || "-"}</div>
              <div>协议：{detail.protocol || "-"}</div>
              <div>渠道：{detail.channelName || detail.channelId || "-"}</div>
              <div>耗时：{formatDuration(detail.durationMs)}</div>
              <div>Job：{detail.jobId || "-"}</div>
              <div>时间：{new Date(detail.createdAt).toLocaleString()}</div>
            </div>
            {detail.error ? (
              <div className="mt-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-3 text-sm text-red-500">
                {detail.error}
              </div>
            ) : null}
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 text-sm font-medium text-[var(--ob-ink)]">请求</h3>
                <pre className="overflow-auto rounded-lg border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-3 text-xs">
                  {prettyJSON(detail.request)}
                </pre>
              </div>
              <div>
                <h3 className="mb-1 text-sm font-medium text-[var(--ob-ink)]">响应</h3>
                <pre className="overflow-auto rounded-lg border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-3 text-xs">
                  {prettyJSON(detail.response)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
