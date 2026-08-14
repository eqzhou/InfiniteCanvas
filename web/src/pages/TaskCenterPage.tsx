import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Cpu, RefreshCw, XCircle } from "lucide-react";
import type { GenerationKind, GenerationStatus } from "@/types/board";
import { cancelServerGenerationJob, listAllGenerationJobs } from "@/services/generation-jobs";
import { buildTaskCenterItems, filterTaskCenterItems, type TaskCenterItem } from "@/services/task-center";
import { useBoardStore } from "@/stores/use-board-store";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

const statusMessageKeys: Record<GenerationStatus, MessageKey> = {
  queued: "tasks.queued",
  running: "tasks.running",
  succeeded: "tasks.succeeded",
  failed: "tasks.failed",
  cancelled: "tasks.cancelled",
  deleted: "tasks.deleted",
};

const statusTones: Record<GenerationStatus, "neutral" | "info" | "success" | "danger" | "warning"> = {
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
  deleted: "neutral",
};

export function TaskCenterTable({ items, onCancel }: {
  items: TaskCenterItem[];
  onCancel: (id: string) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  return (
    <>
      <div className="ob-table-shell overflow-x-auto">
        <table className="ob-table w-full min-w-[940px] text-left">
          <thead>
            <tr>
              <th scope="col">{t("tasks.task")}</th>
              <th scope="col">{t("tasks.source")}</th>
              <th scope="col">{t("tasks.status")}</th>
              <th scope="col">{t("tasks.progress")}</th>
              <th scope="col">{t("tasks.credits")}</th>
              <th scope="col">{t("tasks.updatedAt")}</th>
              <th scope="col" className="text-right">{t("tasks.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="transition-colors hover:bg-[var(--ob-surface-2)]">
                <td className={`${item.parentTaskId ? "pl-8" : ""}`}>
                  <strong className="text-[var(--ob-ink)]">{item.parentTaskId ? "↳ " : ""}{item.title}</strong>
                  <div className="mt-0.5 max-w-md truncate font-mono text-[11px] text-[var(--ob-muted)]">
                    {item.id}{item.error ? ` · ${item.error}` : ""}
                  </div>
                </td>
                <td className="text-xs text-[var(--ob-muted)]">
                  {item.source === "film"
                    ? `${t("tasks.filmProduction")}${item.stage ? ` · ${item.stage}` : ""}`
                    : item.source}
                </td>
                <td>
                  <span className="ob-status-chip" data-tone={statusTones[item.status]}>
                    <span className="ob-status-dot" aria-hidden />
                    {t(statusMessageKeys[item.status])}
                  </span>
                </td>
                <td className="text-xs">
                  {item.progress === undefined ? "—" : (
                    <div className="min-w-28 space-y-1">
                      <div className="flex justify-between text-[11px] text-[var(--ob-muted)]">
                        <span>{Math.round(item.progress * 100)}%</span>
                        <span>{item.total !== undefined ? `${item.succeeded ?? 0}/${item.total}` : ""}</span>
                      </div>
                      <div
                        className="ob-meter h-1.5 w-full"
                        role="progressbar"
                        aria-label={`${item.title} ${t("tasks.progress")}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(item.progress * 100)}
                      >
                        <div
                          className="ob-meter-fill bg-[var(--ob-accent)] transition-all duration-300"
                          style={{ width: `${Math.min(100, Math.max(0, item.progress * 100))}%` }}
                        />
                      </div>
                      {item.failed ? <p className="text-[10px] text-[var(--ob-danger)]">{t("tasks.failedCount", { count: item.failed })}</p> : null}
                    </div>
                  )}
                </td>
                <td className="text-xs text-[var(--ob-muted)]" data-numeric="true">
                  {item.estimatedCredits === undefined
                    ? "—"
                    : t("tasks.creditUsage", {
                        actual: item.actualCredits ?? 0,
                        estimated: item.estimatedCredits,
                      })}
                </td>
                <td className="whitespace-nowrap text-xs text-[var(--ob-muted)]" data-numeric="true">
                  {new Date(item.updatedAt).toLocaleString(locale)}
                </td>
                <td>
                  <div className="flex justify-end gap-1.5">
                    <Link className="ob-btn ob-btn-sm" to={item.sourcePath}>{t("tasks.openSource")}</Link>
                    {item.status === "queued" || item.status === "running" ? (
                      <button
                        type="button"
                        className="ob-btn ob-btn-danger ob-btn-sm"
                        disabled={cancellingId !== null}
                        onClick={() => setCancellingId(item.id)}
                      >
                        <XCircle size={13} aria-hidden />
                        {t("common.cancel")}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length ? (
          <p className="p-8 text-center text-sm text-[var(--ob-muted)]">{t("tasks.empty")}</p>
        ) : null}
      </div>

      {cancellingId ? (
        <ConfirmDialog
          title={t("tasks.confirmCancel")}
          confirmLabel={t("common.confirm")}
          tone="danger"
          busy={cancelling}
          onCancel={() => { if (!cancelling) setCancellingId(null); }}
          onConfirm={() => {
            setCancelling(true);
            void onCancel(cancellingId)
              .catch(() => undefined)
              .finally(() => {
                setCancelling(false);
                setCancellingId(null);
              });
          }}
        />
      ) : null}
    </>
  );
}

export function TaskCenterPage() {
  const { t } = useI18n();
  const projects = useBoardStore((state) => state.projects);
  const [items, setItems] = useState<TaskCenterItem[]>([]);
  const [status, setStatus] = useState<GenerationStatus | "">("");
  const [kind, setKind] = useState<GenerationKind | "">("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setError("");
      setItems(buildTaskCenterItems(await listAllGenerationJobs()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = useMemo(
    () => filterTaskCenterItems(items, { status, kind, projectId }),
    [items, status, kind, projectId],
  );

  const activeCount = useMemo(
    () => items.filter((i) => i.status === "running" || i.status === "queued").length,
    [items],
  );

  return (
    <div className="ob-page ob-view-fade-in pb-12">
      <header className="ob-page-header">
        <div className="min-w-0">
          <span className="ob-page-kicker"><Cpu size={13} aria-hidden />{t("nav.tasks")}</span>
          <h1 className="ob-page-title">{t("tasks.title")}</h1>
          <p className="ob-page-desc">{t("tasks.description")}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {activeCount > 0 ? (
            <span className="ob-chip border-[color-mix(in_srgb,var(--ob-accent)_30%,transparent)] bg-[var(--ob-accent-soft)] text-xs text-[var(--ob-accent)] font-medium">
              <span className="ob-status-dot bg-[var(--ob-accent)]" aria-hidden />
              {activeCount} {t("tasks.running")}
            </span>
          ) : null}
          <button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden />
            {t("common.refresh")}
          </button>
        </div>
      </header>

      <div className="ob-toolbar-strip mb-4 grid gap-2.5 sm:grid-cols-3">
        <select
          aria-label={t("tasks.statusFilter")}
          className="ob-field"
          value={status}
          onChange={(event) => setStatus(event.target.value as GenerationStatus | "")}
        >
          <option value="">{t("tasks.allStatuses")}</option>
          {Object.entries(statusMessageKeys).map(([value, key]) => (
            <option key={value} value={value}>{t(key)}</option>
          ))}
        </select>
        <select
          aria-label={t("tasks.kindFilter")}
          className="ob-field"
          value={kind}
          onChange={(event) => setKind(event.target.value as GenerationKind | "")}
        >
          <option value="">{t("common.allTypes")}</option>
          {(["text", "image", "video", "audio", "workflow", "export", "film-stage"] as GenerationKind[])
            .map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select
          aria-label={t("tasks.projectFilter")}
          className="ob-field"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">{t("tasks.allProjects")}</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
      </div>

      {error ? <p role="alert" className="ob-banner mb-4 rounded-xl" data-tone="danger">{error}</p> : null}

      <TaskCenterTable
        items={filtered}
        onCancel={async (id) => {
          try {
            await cancelServerGenerationJob(id);
            await load();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      />
    </div>
  );
}
