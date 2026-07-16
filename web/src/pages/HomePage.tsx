import { useMemo, useRef, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { BoardCanvas } from "@/components/canvas/BoardCanvas";
import { AssistantPanel } from "@/components/assistant/AssistantPanel";
import {
  Archive,
  Download,
  FolderPlus,
  PanelLeftOpen,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { parseBoardProject } from "@/lib/board-document";
import { exportProjectBundle, importProjectBundle } from "@/lib/project-bundle";

export function HomePage() {
  const ready = useBoardStore((s) => s.ready);
  const projects = useBoardStore((s) => s.projects);
  const activeProjectId = useBoardStore((s) => s.activeProjectId);
  const setActiveProject = useBoardStore((s) => s.setActiveProject);
  const createProject = useBoardStore((s) => s.createProject);
  const renameProject = useBoardStore((s) => s.renameProject);
  const deleteProjects = useBoardStore((s) => s.deleteProjects);
  const exportActiveProject = useBoardStore((s) => s.exportActiveProject);
  const importProject = useBoardStore((s) => s.importProject);
  const fileRef = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);

  const sorted = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects],
  );

  if (!ready) {
    return <div className="grid h-full place-items-center">加载本地数据…</div>;
  }

  return (
    <div className="relative flex h-full min-h-0">
      <button
        type="button"
        className="absolute left-2 top-2 z-[60] rounded-md border border-[var(--ob-line)] bg-[var(--ob-panel)] p-2 shadow-[var(--ob-shadow)] md:hidden"
        title="项目"
        onClick={() => setProjectsOpen(true)}
      >
        <PanelLeftOpen size={17} />
      </button>
      {projectsOpen ? (
        <button
          type="button"
          className="absolute inset-0 z-40 bg-black/45 md:hidden"
          aria-label="关闭项目面板"
          onClick={() => setProjectsOpen(false)}
        />
      ) : null}
      <aside
        className={`${projectsOpen ? "absolute inset-y-0 left-0 z-50 flex" : "hidden"} w-[min(88vw,320px)] shrink-0 flex-col border-r border-[var(--ob-line)] bg-[var(--ob-panel)] md:static md:flex md:w-64`}
      >
        <div className="flex items-center gap-2 border-b border-[var(--ob-line)] p-3">
          <strong className="text-sm">项目</strong>
          <button
            type="button"
            className="ml-auto rounded p-1 hover:bg-[var(--ob-accent-soft)] md:hidden"
            title="关闭"
            onClick={() => setProjectsOpen(false)}
          >
            <X size={16} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-[var(--ob-accent-soft)] md:ml-auto"
            title="新建"
            onClick={() => createProject(`画布 ${projects.length + 1}`)}
          >
            <FolderPlus size={16} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
            title="导入 JSON"
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={16} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
            title="导出当前"
            onClick={() => {
              const p = exportActiveProject();
              if (!p) return;
              const blob = new Blob([JSON.stringify(p, null, 2)], {
                type: "application/json",
              });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `${p.title || "openboard"}.json`;
              a.click();
            }}
          >
            <Download size={16} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-[var(--ob-accent-soft)]"
            title="导出完整包"
            onClick={() => {
              void (async () => {
                const project = exportActiveProject();
                if (!project) return;
                try {
                  const blob = await exportProjectBundle(project);
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = `${project.title || "openboard"}.openboard`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                } catch (error) {
                  alert(error instanceof Error ? error.message : String(error));
                }
              })();
            }}
          >
            <Archive size={16} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-[var(--ob-danger)] hover:bg-[var(--ob-accent-soft)] disabled:opacity-40"
            title="删除勾选"
            disabled={!checked.length}
            onClick={() => {
              if (!checked.length) return;
              if (confirm(`删除选中的 ${checked.length} 个项目？`)) {
                deleteProjects(checked);
                setChecked([]);
              }
            }}
          >
            <Trash2 size={16} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.openboard,application/json,application/zip"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const isJson = file.name.toLowerCase().endsWith(".json");
                if (file.size > (isJson ? 32 : 128) * 1024 * 1024) {
                  throw new Error("file too large");
                }
                const data = isJson
                  ? parseBoardProject(JSON.parse(await file.text()))
                  : await importProjectBundle(file);
                importProject(data);
              } catch {
                alert("导入失败：JSON 格式不正确");
              }
              e.currentTarget.value = "";
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`group mb-1 rounded-lg border px-2 py-2 ${
                p.id === activeProjectId
                  ? "border-[var(--ob-accent)] bg-[var(--ob-accent-soft)]"
                  : "border-transparent hover:border-[var(--ob-line)]"
              }`}
            >
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked.includes(p.id)}
                  onChange={(e) => {
                    setChecked((prev) =>
                      e.target.checked
                        ? [...prev, p.id]
                        : prev.filter((id) => id !== p.id),
                    );
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setActiveProject(p.id);
                    setProjectsOpen(false);
                  }}
                >
                  <input
                    className="w-full bg-transparent font-medium outline-none"
                    value={p.title}
                    onChange={(e) => renameProject(p.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="mt-1 text-[11px] text-[var(--ob-muted)]">
                    {p.nodes.length} 节点 · {new Date(p.updatedAt).toLocaleString()}
                  </div>
                </button>
              </div>
            </div>
          ))}
          {!sorted.length ? (
            <p className="p-3 text-sm text-[var(--ob-muted)]">
              还没有项目，点击右上角新建。
            </p>
          ) : null}
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <BoardCanvas />
      </div>
      <AssistantPanel />
    </div>
  );
}
