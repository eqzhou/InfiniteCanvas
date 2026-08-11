import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { RefreshCw, XCircle } from "lucide-react";
import type { GenerationKind, GenerationStatus } from "@/types/board";
import { cancelServerGenerationJob, listAllGenerationJobs } from "@/services/generation-jobs";
import { buildTaskCenterItems, filterTaskCenterItems, type TaskCenterItem } from "@/services/task-center";
import { useBoardStore } from "@/stores/use-board-store";
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

export function TaskCenterTable({ items, onCancel }: {
  items: TaskCenterItem[];
  onCancel: (id: string) => void;
}) {
  const { locale, t } = useI18n();
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]">
      <table className="w-full min-w-[940px] text-left text-sm">
        <thead className="bg-[var(--ob-surface-2)] text-xs text-[var(--ob-muted)]">
          <tr>
            <th className="p-3">{t("tasks.task")}</th>
            <th className="p-3">{t("tasks.source")}</th>
            <th className="p-3">{t("tasks.status")}</th>
            <th className="p-3">{t("tasks.progress")}</th>
            <th className="p-3">{t("tasks.credits")}</th>
            <th className="p-3">{t("tasks.updatedAt")}</th>
            <th className="p-3">{t("tasks.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-t border-[var(--ob-line)]">
              <td className={`p-3 ${item.parentTaskId ? "pl-8" : ""}`}>
                <strong>{item.parentTaskId ? "↳ " : ""}{item.title}</strong>
                <div className="mt-1 max-w-md truncate text-xs text-[var(--ob-muted)]">
                  {item.id}{item.error ? ` · ${item.error}` : ""}
                </div>
              </td>
              <td className="p-3">
                {item.source === "film"
                  ? `${t("tasks.filmProduction")}${item.stage ? ` · ${item.stage}` : ""}`
                  : item.source}
              </td>
              <td className="p-3">{t(statusMessageKeys[item.status])}</td>
              <td className="p-3 text-xs">
                {item.progress === undefined ? "—" : (
                  <div className="min-w-28">
                    <div>
                      {Math.round(item.progress * 100)}%
                      {item.total !== undefined ? ` · ${item.succeeded ?? 0}/${item.total}` : ""}
                      {item.failed ? ` · ${t("tasks.failedCount", { count: item.failed })}` : ""}
                    </div>
                    <progress
                      className="mt-1 w-full"
                      max={1}
                      value={item.progress}
                      aria-label={`${item.title} ${t("tasks.progress")}`}
                    />
                  </div>
                )}
              </td>
              <td className="p-3 text-xs">
                {item.estimatedCredits === undefined
                  ? "—"
                  : t("tasks.creditUsage", {
                      actual: item.actualCredits ?? 0,
                      estimated: item.estimatedCredits,
                    })}
              </td>
              <td className="p-3 text-xs">{new Date(item.updatedAt).toLocaleString(locale)}</td>
              <td className="p-3">
                <div className="flex gap-2">
                  <Link className="ob-btn" to={item.sourcePath}>{t("tasks.openSource")}</Link>
                  {item.status === "queued" || item.status === "running" ? (
                    <button type="button" className="ob-btn" onClick={() => onCancel(item.id)}>
                      <XCircle size={14} />{t("common.cancel")}
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length ? (
        <p className="p-6 text-center text-sm text-[var(--ob-muted)]">{t("tasks.empty")}</p>
      ) : null}
    </div>
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
      // Server errors are intentionally preserved verbatim.
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

  return (
    <div className="h-full overflow-auto bg-[var(--ob-bg)] p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto">
            <h1 className="text-xl font-semibold">{t("tasks.title")}</h1>
            <p className="text-sm text-[var(--ob-muted)]">{t("tasks.description")}</p>
          </div>
          <button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={14} />{t("common.refresh")}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
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
              .map((value) => <option key={value}>{value}</option>)}
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
        {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
        <TaskCenterTable
          items={filtered}
          onCancel={(id) => void cancelServerGenerationJob(id).then(load).catch((cause) => setError(String(cause)))}
        />
      </div>
    </div>
  );
}
