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
import { readAICallRequestDetail } from "@/lib/ai-call-log-detail";
import { useI18n } from "@/i18n/I18nProvider";

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
  const { locale, t } = useI18n();
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
  const requestDetail = detail ? readAICallRequestDetail(detail.request) : null;

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
    if (!window.confirm(t("logs.confirmDelete", { count: selected.size }))) return;
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
    if (!window.confirm(t("logs.confirmCleanup", { days }))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteAICallLogs({ olderThanDays: days });
      window.alert(t("logs.cleaned", { count: result.deleted }));
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
        <h1 className="text-xl font-semibold text-[var(--ob-ink)]">{t("logs.title")}</h1>
        <p className="mt-2 text-sm text-[var(--ob-muted)]">{t("logs.forbidden")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ob-ink)]">{t("logs.title")}</h1>
          <p className="mt-1 text-sm text-[var(--ob-muted)]">
            {t("logs.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm text-[var(--ob-muted)]">
            {t("logs.retentionDays")}
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
            {t("logs.cleanup")}
          </button>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--ob-muted)]">
            <input
              type="checkbox"
              aria-label={t("logs.autoCleanupLabel")}
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
            {retention.enabled
              ? t("logs.autoCleanupEvery", { days: retention.retentionDays })
              : t("logs.autoCleanup")}
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--ob-muted)]">
            <input
              type="checkbox"
              aria-label={t("logs.localReportLabel")}
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
            {t("logs.localReport")}
          </label>
          <button
            type="button"
            className="ob-btn"
            disabled={busy || selected.size === 0}
            onClick={() => void deleteSelected()}
          >
            {t("logs.deleteSelected")}
          </button>
          <button type="button" className="ob-btn" disabled={busy} onClick={() => void load()}>
            {t("common.refresh")}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="ob-input min-w-[12rem] flex-1"
          placeholder={t("logs.search")}
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        <select className="ob-input w-auto" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="all">{t("common.allTypes")}</option>
          <option value="image">image</option>
          <option value="video">video</option>
          <option value="audio">audio</option>
        </select>
        <select className="ob-input w-auto" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">{t("tasks.allStatuses")}</option>
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
          {t("logs.loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--ob-line)] p-8 text-sm text-[var(--ob-muted)]">
          {t("logs.empty")}
        </div>
      ) : (
        <div className="overflow-auto rounded-xl border border-[var(--ob-line)]">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[var(--ob-canvas)] text-[var(--ob-muted)]">
              <tr>
                <th className="px-3 py-2">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label={t("logs.selectAll")} />
                </th>
                <th className="px-3 py-2 font-medium">{t("logs.time")}</th>
                <th className="px-3 py-2 font-medium">{t("logs.type")}</th>
                <th className="px-3 py-2 font-medium">{t("logs.status")}</th>
                <th className="px-3 py-2 font-medium">{t("logs.model")}</th>
                <th className="px-3 py-2 font-medium">{t("logs.channel")}</th>
                <th className="px-3 py-2 font-medium">{t("logs.duration")}</th>
                <th className="px-3 py-2 font-medium">{t("logs.details")}</th>
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
                      aria-label={t("logs.select", { id: item.id })}
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-[var(--ob-muted)]">
                    {new Date(item.createdAt).toLocaleString(locale)}
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
                      {t("logs.view")}
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
            {t("common.previousPage")}
          </button>
          <span className="text-sm text-[var(--ob-muted)]">
            {t("common.pageTotal", { page, pages: totalPages, total })}
          </span>
          <button
            type="button"
            className="ob-btn"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("common.nextPage")}
          </button>
        </div>
      ) : null}

      {detail ? (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4" onClick={() => setDetail(null)}>
          <div
            role="dialog"
            aria-label={t("logs.detailLabel")}
            className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 shadow-[var(--ob-elev-2)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-[var(--ob-ink)]">{t("logs.callDetails")}</h2>
                <p className="mt-1 text-xs text-[var(--ob-muted)]">{detail.id}</p>
              </div>
              <button type="button" className="ob-btn" onClick={() => setDetail(null)}>
                {t("common.close")}
              </button>
            </div>
            <div className="mt-3 grid gap-2 text-sm text-[var(--ob-muted)] sm:grid-cols-2">
              <div>{t("logs.type")}：{detail.kind}</div>
              <div>{t("logs.status")}：{detail.status}</div>
              <div>{t("logs.model")}：{detail.model || "-"}</div>
              <div>{t("logs.protocol")}：{detail.protocol || "-"}</div>
              <div>{t("logs.channel")}：{detail.channelName || detail.channelId || "-"}</div>
              <div>{t("logs.duration")}：{formatDuration(detail.durationMs)}</div>
              <div>Job：{detail.jobId || "-"}</div>
              <div>{t("logs.time")}：{new Date(detail.createdAt).toLocaleString(locale)}</div>
              <div className="break-all sm:col-span-2">
                {t("logs.endpoint")}：{requestDetail?.endpoint ? `${requestDetail.method || "POST"} ${requestDetail.endpoint}` : t("logs.notRecorded")}
              </div>
            </div>
            {detail.error ? (
              <div className="mt-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-3 text-sm text-red-500">
                {detail.error}
              </div>
            ) : null}
            {requestDetail && requestDetail.referenceCount > 0 ? (
              <div className="mt-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-3 text-sm">
                <div className="font-medium text-[var(--ob-ink)]">
                  {detail.kind === "video" ? t("logs.referenceMedia") : t("logs.referenceImage")} · {requestDetail.referenceCount} {detail.kind === "video" ? t("logs.items") : t("logs.images")}
                </div>
                <div className="mt-2 space-y-1 text-xs text-[var(--ob-muted)]">
                  {requestDetail.references.map((reference) => (
                    <div key={reference.index} className="break-all">
                      #{reference.index} · {reference.sourceKnown ? reference.storageKey : t("logs.sourceNotRecorded")}
                      {reference.mimeType ? ` · ${reference.mimeType}` : ""}
                      {reference.bytes ? ` · ${reference.bytes.toLocaleString()} bytes` : ""}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-[var(--ob-muted)]">
                  {t("logs.referencePrivacy")}
                </p>
              </div>
            ) : null}
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 text-sm font-medium text-[var(--ob-ink)]">{t("logs.request")}</h3>
                <pre className="overflow-auto rounded-lg border border-[var(--ob-line)] bg-[var(--ob-canvas)] p-3 text-xs">
                  {prettyJSON(detail.request)}
                </pre>
              </div>
              <div>
                <h3 className="mb-1 text-sm font-medium text-[var(--ob-ink)]">{t("logs.response")}</h3>
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
