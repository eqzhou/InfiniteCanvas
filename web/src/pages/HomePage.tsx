import { useEffect, useMemo, useRef, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import { BoardCanvas } from "@/components/canvas/BoardCanvas";
import {
  Archive,
  Download,
  FolderPlus,
  ListChecks,
  LocateFixed,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import { parseBoardProject } from "@/lib/board-document";
import { assertPlainProjectImportSafe } from "@/lib/plain-project-import";
import { exportProjectBundle, importProjectBundle } from "@/lib/project-bundle";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { exportNodeSelection } from "@/lib/node-export";
import type { BoardNode } from "@/types/board";
import { CanvasAssetsPanel } from "@/components/canvas/CanvasAssetsPanel";
import { CanvasPromptsPanel } from "@/components/canvas/CanvasPromptsPanel";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import {
  directorCaptureStore,
  getDirectorCaptureOwnerScope,
} from "@/services/director-capture-store";
import { directorModelStore } from "@/services/director-model-store";
import { ProjectAudioRolesDialog } from "@/components/canvas/ProjectAudioRolesDialog";

const NODE_TYPE_LABELS: Record<BoardNode["type"], string> = {
  text: "文本",
  image: "图片",
  config: "配置",
  video: "视频",
  audio: "音频",
  panorama: "全景",
  director: "导演台",
  group: "分组",
  plugin: "插件",
};

export function HomePage() {
  const auth = useOptionalAuth();
  const ready = useBoardStore((s) => s.ready);
  const projects = useBoardStore((s) => s.projects);
  const activeProjectId = useBoardStore((s) => s.activeProjectId);
  const activeProject = useBoardStore((s) => s.projects.find((project) => project.id === s.activeProjectId) ?? null);
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const setActiveProject = useBoardStore((s) => s.setActiveProject);
  const setSelected = useBoardStore((s) => s.setSelected);
  const setViewport = useBoardStore((s) => s.setViewport);
  const createProject = useBoardStore((s) => s.createProject);
  const renameProject = useBoardStore((s) => s.renameProject);
  const deleteProjects = useBoardStore((s) => s.deleteProjects);
  const exportActiveProject = useBoardStore((s) => s.exportActiveProject);
  const importProject = useBoardStore((s) => s.importProject);
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);
  const flushConfig = useBoardStore((s) => s.flushConfig);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelWidthRef = useRef(config.canvasPanelWidth ?? 256);
  const viewportAnimationRef = useRef<number | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [checkedNodes, setCheckedNodes] = useState<string[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [audioRolesOpen, setAudioRolesOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(config.canvasPanelWidth ?? 256);
  const panelCollapsed = config.canvasPanelCollapsed === true;
  const panelTab = config.canvasPanelTab ?? "projects";
  const captureOwnerScope = useMemo(
    () => getDirectorCaptureOwnerScope(auth?.user),
    [auth?.user?.id, auth?.user?.tenantId],
  );
  const captureDirectory = useMemo(() => Object.fromEntries(projects.map((project) => [
    project.id,
    project.nodes.filter((node) => node.type === "director").map((node) => node.id),
  ])), [projects]);
  const captureDirectorySignature = JSON.stringify(captureDirectory);
  const modelDirectory = useMemo(() => Object.fromEntries(projects.map((project) => [
    project.id,
    Object.fromEntries(project.nodes.filter((node) => node.type === "director").map((node) => [
      node.id,
      Object.fromEntries((node.metadata.directorScene?.objects ?? [])
        .filter((object) => object.kind === "model" && object.modelAsset)
        .map((object) => [object.id, object.modelAsset!.assetId])),
    ])),
  ])), [projects]);
  const modelDirectorySignature = JSON.stringify(modelDirectory);
  useEscapeDismiss(projectsOpen, () => setProjectsOpen(false));

  useEffect(() => {
    if (!ready) return;
    void directorCaptureStore.prune(captureOwnerScope, captureDirectory).catch(() => undefined);
    void directorModelStore.prune(captureOwnerScope, modelDirectory).catch(() => undefined);
  }, [captureDirectorySignature, captureOwnerScope, modelDirectorySignature, ready]);

  useEffect(() => {
    const width = config.canvasPanelWidth ?? 256;
    setPanelWidth(width);
    panelWidthRef.current = width;
  }, [config.canvasPanelWidth]);

  useEffect(() => {
    const available = new Set(activeProject?.nodes.map((node) => node.id) ?? []);
    setCheckedNodes((current) => current.filter((id) => available.has(id)));
  }, [activeProject]);

  useEffect(() => () => {
    if (viewportAnimationRef.current !== null) cancelAnimationFrame(viewportAnimationRef.current);
  }, []);

  const updatePanelConfig = (patch: Partial<Pick<typeof config, "canvasPanelWidth" | "canvasPanelCollapsed" | "canvasPanelTab">>) => {
    const latest = useBoardStore.getState().config;
    setConfig({ ...latest, ...patch });
    // Collapse/expand/width must hit formal storage before reload (LatestWrite is async).
    void flushConfig();
  };

  const changePanelTab = (tab: "projects" | "elements" | "assets" | "prompts") => {
    updatePanelConfig({ canvasPanelTab: tab });
  };

  const focusNode = (node: BoardNode) => {
    const project = useBoardStore.getState().getActive();
    if (!project) return;
    setProjectsOpen(false);
    setSelected([node.id]);
    if (viewportAnimationRef.current !== null) cancelAnimationFrame(viewportAnimationRef.current);
    const start = { ...project.viewport };
    const canvasRect = document
      .querySelector<HTMLElement>('[data-testid="canvas-surface"]')
      ?.getBoundingClientRect();
    const assistantRect = document
      .querySelector<HTMLElement>('aside[aria-label="画布 Agent"]')
      ?.getBoundingClientRect();
    const visibleCanvasWidth = canvasRect && assistantRect && assistantRect.left < canvasRect.right
      ? Math.max(1, assistantRect.left - canvasRect.left)
      : canvasRect?.width;
    const canvasWidth = Math.max(320, visibleCanvasWidth ?? window.innerWidth - panelWidth);
    const canvasHeight = Math.max(240, canvasRect?.height ?? window.innerHeight - 104);
    const target = {
      k: start.k,
      x: canvasWidth / 2 - (node.position.x + node.width / 2) * start.k,
      y: canvasHeight / 2 - (node.position.y + node.height / 2) * start.k,
    };
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 260);
      const eased = 1 - (1 - progress) ** 3;
      setViewport({
        k: start.k,
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      }, false);
      if (progress < 1) viewportAnimationRef.current = requestAnimationFrame(tick);
      else viewportAnimationRef.current = null;
    };
    viewportAnimationRef.current = requestAnimationFrame(tick);
  };

  const exportCheckedNodes = async () => {
    if (!activeProject) return;
    const selected = activeProject.nodes.filter((node) => checkedNodes.includes(node.id));
    const blob = await exportNodeSelection(selected);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `画布元素-${selected.length}.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const sorted = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects],
  );

  if (!ready) {
    return (
      <div className="ob-loading" role="status" aria-live="polite">
        <span className="ob-loading-dot" aria-hidden />
        <span>加载本地数据…</span>
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 overflow-hidden"
      data-testid="workspace-shell"
    >
      <button
        type="button"
        className={`ob-chrome absolute left-2 top-2 z-[60] grid h-10 w-10 place-items-center transition-colors hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-accent)] ${projectsOpen ? "!hidden" : panelCollapsed ? "" : "md:hidden"}`}
        title={panelCollapsed ? "展开侧栏" : "打开项目侧栏"}
        aria-label={panelCollapsed ? "展开侧栏" : "打开项目侧栏"}
        onClick={() => {
          if (window.innerWidth >= 768) {
            updatePanelConfig({ canvasPanelCollapsed: false });
          } else {
            setProjectsOpen(true);
          }
        }}
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
        aria-label="项目侧栏"
        className={`${projectsOpen ? "absolute inset-y-0 left-0 z-50 flex" : "hidden"} ${panelCollapsed ? "md:hidden" : "md:relative md:flex"} z-40 w-[min(88vw,320px)] shrink-0 flex-col border-r border-[var(--ob-line)] bg-[var(--ob-panel-glass)] shadow-[var(--ob-elev-1)] backdrop-blur-md transition-opacity duration-200 md:w-[var(--canvas-panel-width)]`}
        style={{ "--canvas-panel-width": `${panelWidth}px` } as React.CSSProperties}
      >
        <div className="flex min-h-12 min-w-0 items-center gap-px overflow-hidden border-b border-[var(--ob-line)] px-1 py-2">
          {panelWidth >= 300 ? (
            <strong className="mr-auto truncate text-sm">工作区</strong>
          ) : (
            <span className="mr-auto sr-only">工作区</span>
          )}
          <button
            type="button"
            className="ob-icon-btn h-8 w-8 shrink-0 md:hidden"
            aria-label="关闭项目侧栏"
            title="关闭项目侧栏"
            onClick={() => setProjectsOpen(false)}
          >
            <X size={16} />
          </button>
          <button
            type="button"
            className="ob-icon-btn hidden h-8 w-8 shrink-0 md:grid"
            title="收起侧栏"
            onClick={() => updatePanelConfig({ canvasPanelCollapsed: true })}
          >
            <PanelLeftClose size={16} />
          </button>
          {panelTab === "projects" ? (
            <>
              <button
                type="button"
                className="ob-icon-btn h-8 w-8 shrink-0"
                title="新建"
                onClick={() => createProject(`画布 ${projects.length + 1}`)}
              >
                <FolderPlus size={16} />
              </button>
              <button
                type="button"
                className="ob-icon-btn h-8 w-8 shrink-0"
                aria-label="管理当前画布配音角色"
                title="当前画布配音角色"
                disabled={!activeProject}
                onClick={() => setAudioRolesOpen(true)}
              >
                <UsersRound size={16} />
              </button>
              <button
                type="button"
                className="ob-icon-btn h-8 w-8 shrink-0"
                title="导入 JSON"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={16} />
              </button>
              <button
                type="button"
                className="ob-icon-btn h-8 w-8 shrink-0"
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
                className="ob-icon-btn h-8 w-8 shrink-0"
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
                className="ob-icon-btn h-8 w-8 shrink-0 !text-[var(--ob-danger)]"
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
            </>
          ) : null}
          {panelTab === "elements" ? (
            <>
              <button
                type="button"
                aria-label="全选元素"
                title="全选元素"
                className="ob-icon-btn h-8 w-8 shrink-0"
                disabled={!activeProject?.nodes.length}
                onClick={() => {
                  const ids = activeProject?.nodes.map((node) => node.id) ?? [];
                  setCheckedNodes(ids);
                  setSelected(ids);
                }}
              >
                <ListChecks size={16} />
              </button>
              <button
                type="button"
                aria-label="导出所选元素"
                title="导出所选元素"
                className="ob-icon-btn h-8 w-8 shrink-0"
                disabled={!checkedNodes.length}
                onClick={() => void exportCheckedNodes().catch((error) =>
                  alert(error instanceof Error ? error.message : String(error)))}
              >
                <Archive size={16} />
              </button>
            </>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept=".json,.openboard,application/json,application/zip"
            className="hidden"
            onChange={async (e) => {
              const input = e.currentTarget;
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const isJson = file.name.toLowerCase().endsWith(".json");
                if (file.size > (isJson ? 32 : 128) * 1024 * 1024) {
                  throw new Error("file too large");
                }
                const data = isJson
                  ? assertPlainProjectImportSafe(parseBoardProject(JSON.parse(await file.text())))
                  : await importProjectBundle(file);
                importProject(data);
              } catch (error) {
                alert(`导入失败：${error instanceof Error ? error.message : "文件格式不正确"}`);
              } finally {
                input.value = "";
              }
            }}
          />
        </div>
        <div role="tablist" aria-label="工作区视图" className="relative grid grid-cols-4 border-b border-[var(--ob-line)] px-2 pt-1">
          {([
            ["projects", "项目"],
            ["elements", "元素"],
            ["assets", "素材"],
            ["prompts", "提示词"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={panelTab === value}
              className={`ob-tab relative z-[1] rounded-lg text-sm border-b-0 ${
                panelTab === value ? "" : ""
              }`}
              onClick={() => changePanelTab(value)}
            >
              {label}
            </button>
          ))}
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-2 h-0.5 w-[calc((100%_-_1rem)/4)] bg-[var(--ob-accent)] transition-transform duration-200 ease-out"
            style={{
              transform: `translateX(${
                ({ projects: 0, elements: 1, assets: 2, prompts: 3 } as const)[panelTab] * 100
              }%)`,
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {panelTab === "projects" ? (
            <>
            {sorted.map((p) => (
            <div
              key={p.id}
              className={`group mb-2 rounded-xl border px-3 py-3 transition-colors duration-150 ${
                p.id === activeProjectId
                  ? "border-[var(--ob-accent)] bg-[var(--ob-accent-soft)] shadow-[var(--ob-elev-1)]"
                  : "border-transparent bg-transparent hover:border-[var(--ob-line)] hover:bg-[var(--ob-canvas)]"
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
            <div className="ob-empty m-2">
              <span className="ob-empty-icon" aria-hidden>
                <FolderPlus size={16} />
              </span>
              <p className="ob-empty-title">还没有项目</p>
              <p className="ob-empty-desc">点击右上角「新建」创建第一个画布，开始编排节点与生成。</p>
            </div>
          ) : null}
            </>
          ) : null}
          {panelTab === "elements" ? (
            activeProject?.nodes.length ? (
              <ul role="list" aria-label="画布元素" className="space-y-1">
                {activeProject.nodes.map((node) => {
                  const checkedNode = checkedNodes.includes(node.id);
                  const selected = selectedIds.includes(node.id);
                  return (
                    <li
                      key={node.id}
                      className={`flex items-center gap-2 rounded-md border px-2 py-2 ${
                        selected
                          ? "border-[var(--ob-accent)] bg-[var(--ob-accent-soft)]"
                          : "border-transparent hover:border-[var(--ob-line)]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        aria-label={`选择${node.title}`}
                        checked={checkedNode}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...checkedNodes, node.id]
                            : checkedNodes.filter((id) => id !== node.id);
                          setCheckedNodes(next);
                          setSelected(next);
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`定位${node.title}`}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => focusNode(node)}
                      >
                        <LocateFixed size={14} className="shrink-0 text-[var(--ob-accent)]" />
                        <span className="min-w-0 flex-1 truncate text-sm">{node.title}</span>
                        <span className="text-[10px] text-[var(--ob-muted)]">{NODE_TYPE_LABELS[node.type]}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="ob-empty m-1 border-0 bg-transparent px-2 py-6">
                <span className="ob-empty-icon" aria-hidden>
                  <LocateFixed size={16} />
                </span>
                <p className="ob-empty-title">当前画布没有元素</p>
                <p className="ob-empty-desc">用顶部工具栏添加文本、图片或媒体节点。</p>
              </div>
            )
          ) : null}
          {panelTab === "assets" ? <CanvasAssetsPanel /> : null}
          {panelTab === "prompts" ? <CanvasPromptsPanel /> : null}
        </div>
        <div
          role="separator"
          aria-label="调整项目侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={420}
          aria-valuenow={panelWidth}
          tabIndex={0}
          className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none select-none hover:bg-[color-mix(in_srgb,var(--ob-accent)_24%,transparent)] focus:bg-[color-mix(in_srgb,var(--ob-accent)_24%,transparent)] md:block"
          onMouseDown={(event) => {
            event.preventDefault();
            panelResizeRef.current = {
              startX: event.clientX,
              startWidth: panelWidthRef.current,
            };
            const move = (moveEvent: MouseEvent) => {
              const resize = panelResizeRef.current;
              if (!resize) return;
              const nextWidth = Math.min(420, Math.max(240, resize.startWidth + moveEvent.clientX - resize.startX));
              panelWidthRef.current = nextWidth;
              setPanelWidth(nextWidth);
            };
            const finish = () => {
              panelResizeRef.current = null;
              window.removeEventListener("mousemove", move);
              updatePanelConfig({ canvasPanelWidth: panelWidthRef.current });
              void flushConfig();
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", finish, { once: true });
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const nextWidth = Math.min(420, Math.max(240, panelWidth + (event.key === "ArrowRight" ? 16 : -16)));
            setPanelWidth(nextWidth);
            panelWidthRef.current = nextWidth;
            updatePanelConfig({ canvasPanelWidth: nextWidth });
            void flushConfig();
          }}
        />
      </aside>

      <div className="min-w-0 flex-1">
        <BoardCanvas />
      </div>
      {audioRolesOpen ? (
        <ProjectAudioRolesDialog open onClose={() => setAudioRolesOpen(false)} />
      ) : null}
    </div>
  );
}
