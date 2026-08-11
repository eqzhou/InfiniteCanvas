import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { RefreshCw, XCircle } from "lucide-react";
import type { GenerationKind, GenerationStatus } from "@/types/board";
import { cancelServerGenerationJob, listAllGenerationJobs } from "@/services/generation-jobs";
import { buildTaskCenterItems, filterTaskCenterItems, type TaskCenterItem } from "@/services/task-center";
import { useBoardStore } from "@/stores/use-board-store";

const statusLabels: Record<GenerationStatus, string> = { queued: "排队中", running: "运行中", succeeded: "已完成", failed: "失败", cancelled: "已取消", deleted: "已删除" };

export function TaskCenterTable({ items, onCancel }: { items: TaskCenterItem[]; onCancel: (id: string) => void }) {
  return <div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[860px] text-left text-sm"><thead className="bg-[var(--ob-surface-2)] text-xs text-[var(--ob-muted)]"><tr><th className="p-3">任务</th><th className="p-3">来源</th><th className="p-3">状态</th><th className="p-3">进度</th><th className="p-3">更新时间</th><th className="p-3">操作</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-t border-[var(--ob-line)]"><td className={`p-3 ${item.parentTaskId ? "pl-8" : ""}`}><strong>{item.parentTaskId ? "↳ " : ""}{item.title}</strong><div className="mt-1 max-w-md truncate text-xs text-[var(--ob-muted)]">{item.id}{item.error ? ` · ${item.error}` : ""}</div></td><td className="p-3">{item.source === "film" ? `影视制片${item.stage ? ` · ${item.stage}` : ""}` : item.source}</td><td className="p-3">{statusLabels[item.status]}</td><td className="p-3 text-xs">{item.progress === undefined ? "—" : <div className="min-w-28"><div>{Math.round(item.progress * 100)}%{item.total !== undefined ? ` · ${item.succeeded ?? 0}/${item.total}` : ""}{item.failed ? ` · 失败 ${item.failed}` : ""}</div><progress className="mt-1 w-full" max={1} value={item.progress} aria-label={`${item.title}进度`} /></div>}</td><td className="p-3 text-xs">{new Date(item.updatedAt).toLocaleString()}</td><td className="p-3"><div className="flex gap-2"><Link className="ob-btn" to={item.sourcePath}>打开来源</Link>{item.status === "queued" || item.status === "running" ? <button type="button" className="ob-btn" onClick={() => onCancel(item.id)}><XCircle size={14} />取消</button> : null}</div></td></tr>)}</tbody></table>{!items.length ? <p className="p-6 text-center text-sm text-[var(--ob-muted)]">没有符合条件的持久任务。</p> : null}</div>;
}

export function TaskCenterPage() {
  const projects = useBoardStore((state) => state.projects);
  const [items, setItems] = useState<TaskCenterItem[]>([]);
  const [status, setStatus] = useState<GenerationStatus | "">("");
  const [kind, setKind] = useState<GenerationKind | "">("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    try { setError(""); setItems(buildTaskCenterItems(await listAllGenerationJobs())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5_000); return () => window.clearInterval(timer); }, []);
  const filtered = useMemo(() => filterTaskCenterItems(items, { status, kind, projectId }), [items, status, kind, projectId]);
  return <div className="h-full overflow-auto bg-[var(--ob-bg)] p-4 md:p-6"><div className="mx-auto max-w-7xl space-y-4"><div className="flex flex-wrap items-center gap-3"><div className="mr-auto"><h1 className="text-xl font-semibold">任务中心</h1><p className="text-sm text-[var(--ob-muted)]">统一查看服务器持久化的画布、工作台、影视阶段和导出任务。</p></div><button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}><RefreshCw size={14} />刷新</button></div><div className="grid gap-2 sm:grid-cols-3"><select aria-label="任务状态" className="ob-field" value={status} onChange={(event) => setStatus(event.target.value as GenerationStatus | "")}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="任务类型" className="ob-field" value={kind} onChange={(event) => setKind(event.target.value as GenerationKind | "")}><option value="">全部类型</option>{(["text", "image", "video", "audio", "workflow", "export", "film-stage"] as GenerationKind[]).map((value) => <option key={value}>{value}</option>)}</select><select aria-label="任务项目" className="ob-field" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</select></div>{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<TaskCenterTable items={filtered} onCancel={(id) => void cancelServerGenerationJob(id).then(load).catch((cause) => setError(String(cause)))} /></div></div>;
}
