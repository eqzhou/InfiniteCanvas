import { useCallback, useEffect, useMemo, useState } from "react";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { hasTenantOwnerCapability } from "@/services/admin";
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
import { normalizeAICallLogRetentionDays } from "@/lib/ai-call-log-ui";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useI18n } from "@/i18n/I18nProvider";
import { toast } from "@/components/common/toast";
import {
  Activity,
  Clock,
  Eye,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";

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
  const canManage = hasTenantOwnerCapability(auth);
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
  const [confirmDeletingSelected, setConfirmDeletingSelected] = useState(false);
  const [confirmCleanupDays, setConfirmCleanupDays] = useState<number | null>(null);
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
      .then((policy) => {
        if (cancelled) return;
        setRetention(policy);
        setCleanupDays(policy.retentionDays);
      })
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
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAICallLogs({ ids: Array.from(selected) });
      setConfirmDeletingSelected(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cleanupOld = async (days: number) => {
    setBusy(true);
    setError(null);
    try {
      const result = await deleteAICallLogs({ olderThanDays: days });
      setConfirmCleanupDays(null);
      toast.success(t("logs.cleaned", { count: result.deleted }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
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

  if (!canManage) {
    return (
      <div className="ob-page ob-view-fade-in p-6">
        <div className="ob-empty">
          <p className="ob-empty-title">{t("common.accessDenied")}</p>
          <p className="ob-empty-desc">{t("common.permissionRequired")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ob-page ob-view-fade-in pb-12">
      <header className="ob-page-header">
        <div className="min-w-0">
          <span className="ob-page-kicker"><Activity size={13} aria-hidden />{t("nav.logs")}</span>
          <h1 className="ob-page-title">{t("logs.title")}</h1>
          <p className="ob-page-desc">{t("logs.description")}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 ? (
            <button
              type="button"
              className="ob-btn ob-btn-danger"
              disabled={busy}
              onClick={() => setConfirmDeletingSelected(true)}
            >
              <Trash2 size={14} aria-hidden />
              {t("logs.deleteSelected")} ({selected.size})
            </button>
          ) : null}
          <button type="button" className="ob-btn" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden />
            {t("common.refresh")}
          </button>
        </div>
      </header>

      {/* Policies Bar */}
      <section className="ob-card mb-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex items-center gap-2 text-xs font-medium text-[var(--ob-ink)]">
              <label htmlFor="ai-log-retention-days">{t("logs.retentionDays")}</label>
              <input
                id="ai-log-retention-days"
                type="number"
                min={1}
                max={3650}
                className="ob-field w-20"
                value={cleanupDays}
                disabled={busy}
                onChange={(event) => setCleanupDays(Number(event.target.value) || 30)}
              />
              <button
                type="button"
                className="ob-btn ob-btn-sm"
                disabled={busy}
                onClick={() => setConfirmCleanupDays(normalizeAICallLogRetentionDays(cleanupDays))}
              >
                <Trash2 size={13} aria-hidden />
                {t("logs.cleanup")}
              </button>
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[var(--ob-ink)] cursor-pointer">
              <input
                type="checkbox"
                aria-label={t("logs.autoCleanupLabel")}
                checked={retention.enabled}
                disabled={busy}
                onChange={(event) => {
                  const next = {
                    enabled: event.target.checked,
                    retentionDays: normalizeAICallLogRetentionDays(cleanupDays),
                  };
                  setRetention(next);
                  void putAICallLogRetention(next)
                    .then(setRetention)
                    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              />
              <Clock size={13} className="text-[var(--ob-muted)]" />
              {retention.enabled
                ? t("logs.autoCleanupEvery", { days: retention.retentionDays })
                : t("logs.autoCleanup")}
            </label>
            <label className="inline-flex items-center gap-2 text-xs font-medium text-[var(--ob-ink)] cursor-pointer">
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
              <Activity size={13} className="text-[var(--ob-muted)]" />
              {t("logs.localReport")}
            </label>
          </div>
          <span className="ob-chip text-xs text-[var(--ob-muted)]">
            {t("common.pageTotal", { page, pages: totalPages, total })}
          </span>
        </div>
      </section>

      {/* Filter strip */}
      <div className="ob-toolbar-strip mb-4 flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ob-muted)]" aria-hidden />
          <input
            className="ob-field pl-8"
            placeholder={t("logs.search")}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        <select className="ob-field w-auto cursor-pointer" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="all">{t("common.allTypes")}</option>
          <option value="image">image</option>
          <option value="video">video</option>
          <option value="audio">audio</option>
        </select>
        <select className="ob-field w-auto cursor-pointer" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">{t("tasks.allStatuses")}</option>
          <option value="succeeded">succeeded</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>

      {error ? (
        <div role="alert" className="ob-banner mb-4 rounded-xl" data-tone="danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="ob-card p-12 text-center text-sm text-[var(--ob-muted)]">
          <RefreshCw size={18} className="mx-auto mb-2 animate-spin text-[var(--ob-accent)]" />
          {t("logs.loading")}
        </div>
      ) : items.length === 0 ? (
        <div className="ob-empty mt-8">
          <span className="ob-empty-icon" aria-hidden><Activity size={20} /></span>
          <p className="ob-empty-title">{t("logs.empty")}</p>
        </div>
      ) : (
        <div className="ob-table-shell overflow-x-auto">
          <table className="ob-table w-full min-w-[840px] text-left">
            <thead>
              <tr>
                <th className="w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label={t("logs.selectAll")} />
                </th>
                <th scope="col">{t("logs.time")}</th>
                <th scope="col">{t("logs.type")}</th>
                <th scope="col">{t("logs.status")}</th>
                <th scope="col">{t("logs.model")}</th>
                <th scope="col">{t("logs.channel")}</th>
                <th scope="col">{t("logs.duration")}</th>
                <th scope="col" className="text-right">{t("logs.details")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="transition-colors hover:bg-[var(--ob-surface-2)]">
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggleOne(item.id)}
                      aria-label={t("logs.select", { id: item.id })}
                    />
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs text-[var(--ob-muted)]" data-numeric="true">
                    {new Date(item.createdAt).toLocaleString(locale)}
                  </td>
                  <td><span className="ob-chip uppercase text-[10px]">{item.kind}</span></td>
                  <td>
                    <span
                      className="ob-status-chip"
                      data-tone={item.status === "succeeded" ? "success" : item.status === "failed" ? "danger" : "neutral"}
                    >
                      <span className="ob-status-dot" aria-hidden />
                      {item.status}
                    </span>
                  </td>
                  <td className="max-w-[12rem] truncate font-mono text-xs" title={item.model}>
                    {item.model || "—"}
                  </td>
                  <td className="max-w-[10rem] truncate text-xs text-[var(--ob-muted)]" title={item.channelName || item.channelId}>
                    {item.channelName || item.channelId || "—"}
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs text-[var(--ob-muted)]" data-numeric="true">
                    {formatDuration(item.durationMs)}
                  </td>
                  <td className="text-right">
                    <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => void openDetail(item.id)}>
                      <Eye size={13} aria-hidden />
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
        <div className="mt-8 flex items-center justify-center gap-4 text-sm">
          <button type="button" className="ob-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t("common.previousPage")}
          </button>
          <span className="ob-chip px-4 py-1.5 text-xs text-[var(--ob-muted)]">
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
        <div className="ob-overlay z-[120] p-4" onClick={() => setDetail(null)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("logs.detailLabel")}
            className="ob-surface ob-view-fade-in mx-auto mt-[5vh] max-h-[90vh] w-full max-w-3xl overflow-auto p-5 shadow-[var(--ob-elev-2)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ob-admin-section-header !mb-3">
              <span className="ob-admin-section-icon" aria-hidden><Activity size={16} /></span>
              <div className="ob-admin-section-heading">
                <h2 className="ob-admin-section-title">{t("logs.callDetails")}</h2>
                <p className="ob-admin-section-desc font-mono">{detail.id}</p>
              </div>
              <button
                type="button"
                className="ob-icon-btn ob-icon-btn-sm ml-auto"
                aria-label={t("common.close")}
                onClick={() => setDetail(null)}
              >
                <X size={16} aria-hidden />
              </button>
            </div>

            <div className="mt-3 grid gap-2.5 rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-4 text-xs text-[var(--ob-muted)] sm:grid-cols-2">
              <div><strong className="text-[var(--ob-ink)]">{t("logs.type")}:</strong> {detail.kind}</div>
              <div><strong className="text-[var(--ob-ink)]">{t("logs.status")}:</strong> {detail.status}</div>
              <div><strong className="text-[var(--ob-ink)]">{t("logs.model")}:</strong> {detail.model || "-"}</div>
              <div><strong className="text-[var(--ob-ink)]">{t("logs.protocol")}:</strong> {detail.protocol || "-"}</div>
              <div><strong className="text-[var(--ob-ink)]">{t("logs.channel")}:</strong> {detail.channelName || detail.channelId || "-"}</div>
              <div><strong className="text-[var(--ob-ink)]">{t("logs.duration")}:</strong> {formatDuration(detail.durationMs)}</div>
              <div><strong className="text-[var(--ob-ink)]">{t("logs.jobId")}:</strong> {detail.jobId || "-"}</div>
              <div><strong className="text-[var(--ob-ink)]">{t("logs.time")}:</strong> {new Date(detail.createdAt).toLocaleString(locale)}</div>
              <div className="break-all sm:col-span-2">
                <strong className="text-[var(--ob-ink)]">{t("logs.endpoint")}:</strong> {requestDetail?.endpoint ? `${requestDetail.method || "POST"} ${requestDetail.endpoint}` : t("logs.notRecorded")}
              </div>
            </div>

            {detail.error ? (
              <div className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--ob-danger)_30%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_10%,transparent)] p-3 text-xs text-[var(--ob-danger)]">
                {detail.error}
              </div>
            ) : null}

            {requestDetail && requestDetail.referenceCount > 0 ? (
              <div className="mt-3 rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-3 text-xs">
                <div className="font-semibold text-[var(--ob-ink)]">
                  {detail.kind === "video" ? t("logs.referenceMedia") : t("logs.referenceImage")} · {requestDetail.referenceCount} {detail.kind === "video" ? t("logs.items") : t("logs.images")}
                </div>
                <div className="mt-2 space-y-1 font-mono text-[11px] text-[var(--ob-muted)]">
                  {requestDetail.references.map((reference) => (
                    <div key={reference.index} className="break-all">
                      #{reference.index} · {reference.sourceKnown ? reference.storageKey : t("logs.sourceNotRecorded")}
                      {reference.mimeType ? ` · ${reference.mimeType}` : ""}
                      {reference.bytes ? ` · ${reference.bytes.toLocaleString()} bytes` : ""}
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("logs.referencePrivacy")}</p>
              </div>
            ) : null}

            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-semibold text-[var(--ob-ink)]">{t("logs.request")}</h3>
                <pre className="max-h-60 overflow-auto rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-3 font-mono text-[11px] leading-relaxed">
                  {prettyJSON(detail.request)}
                </pre>
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold text-[var(--ob-ink)]">{t("logs.response")}</h3>
                <pre className="max-h-60 overflow-auto rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-3 font-mono text-[11px] leading-relaxed">
                  {prettyJSON(detail.response)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDeletingSelected ? (
        <ConfirmDialog
          title={t("logs.deleteSelected")}
          message={t("logs.confirmDelete", { count: selected.size })}
          confirmLabel={t("common.delete")}
          tone="danger"
          busy={busy}
          onCancel={() => setConfirmDeletingSelected(false)}
          onConfirm={() => void deleteSelected()}
        />
      ) : null}
      {confirmCleanupDays !== null ? (
        <ConfirmDialog
          title={t("logs.cleanup")}
          message={t("logs.confirmCleanup", { days: confirmCleanupDays })}
          confirmLabel={t("logs.cleanup")}
          tone="danger"
          busy={busy}
          onCancel={() => setConfirmCleanupDays(null)}
          onConfirm={() => void cleanupOld(confirmCleanupDays)}
        />
      ) : null}
    </div>
  );
}
