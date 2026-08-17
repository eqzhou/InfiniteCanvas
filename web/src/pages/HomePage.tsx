import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useBoardStore } from "@/stores/use-board-store";
import { BoardCanvas } from "@/components/canvas/BoardCanvas";
import {
  Archive,
  Clapperboard,
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
import { loadFilmCapabilities } from "@/services/film-client";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { exportNodeSelection } from "@/lib/node-export";
import type { BoardNode } from "@/types/board";
import { CanvasAssetsPanel } from "@/components/canvas/CanvasAssetsPanel";
import { CanvasPromptsPanel } from "@/components/canvas/CanvasPromptsPanel";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { hasTenantOwnerCapability } from "@/services/admin";
import {
  directorCaptureStore,
  getDirectorCaptureOwnerScope,
} from "@/services/director-capture-store";
import { directorModelStore } from "@/services/director-model-store";
import { ProjectAudioRolesDialog } from "@/components/canvas/ProjectAudioRolesDialog";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";
import { PageSkeleton } from "@/components/layout/PageSkeleton";
import { WorkspaceLoadError } from "@/components/layout/WorkspaceLoadError";
import { useLazyProjects } from "@/hooks/use-lazy-workspace";

const NODE_TYPE_KEYS: Record<BoardNode["type"], MessageKey> = {
  text: "common.text",
  image: "common.image",
  config: "workspace.config",
  video: "common.video",
  audio: "common.audio",
  panorama: "workspace.panorama",
  director: "workspace.director",
  group: "workspace.group",
  plugin: "nav.plugins",
};

export function HomePage() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const auth = useOptionalAuth();
  const { ready, projectsState, projectsError, loadProjectsOnDemand } = useLazyProjects();
  const projects = useBoardStore((s) => s.projects);
  const activeProjectId = useBoardStore((s) => s.activeProjectId);
  const activeProject = useBoardStore((s) => s.projects.find((project) => project.id === s.activeProjectId) ?? null);
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const setActiveProject = useBoardStore((s) => s.setActiveProject);
  const setSelected = useBoardStore((s) => s.setSelected);
  const setViewport = useBoardStore((s) => s.setViewport);
  const createProject = useBoardStore((s) => s.createProject);
  const renameProject = useBoardStore((s) => s.renameProject);
  const deleteProjectsDurably = useBoardStore((s) => s.deleteProjectsDurably);
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
  const [createOpen, setCreateOpen] = useState(false);
  const [audioRolesOpen, setAudioRolesOpen] = useState(false);
  const [filmCapability, setFilmCapability] = useState<{ available: boolean; reason: string } | null>(null);
  const [panelWidth, setPanelWidth] = useState(config.canvasPanelWidth ?? 256);
  const [confirmDeleteCount, setConfirmDeleteCount] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const tenantOwner = hasTenantOwnerCapability(auth);
  const panelCollapsed = config.canvasPanelCollapsed === true;
  const panelTab = config.canvasPanelTab ?? "projects";
  const panelActionClass = panelWidth < 300
    ? "ob-icon-btn ob-panel-compact-action shrink-0"
    : "ob-icon-btn h-8 w-8 shrink-0";
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
  useEscapeDismiss(createOpen, () => setCreateOpen(false));

  const createNewProject = async (projectKind: "canvas" | "film") => {
    if (projectKind === "film" && !filmCapability?.available) return;
    const count = projects.filter((project) => project.projectKind === projectKind).length + 1;
    const id = createProject(
      projectKind === "film" ? t("workspace.filmName", { count }) : t("workspace.canvasName", { count }),
      projectKind,
    );
    await useBoardStore.getState().persistNow();
    setCreateOpen(false);
    if (projectKind === "film") navigate(`/film/${id}`);
  };

  useEffect(() => {
    if (projectsState !== "loaded") return;
    void directorCaptureStore.prune(captureOwnerScope, captureDirectory).catch(() => undefined);
    void directorModelStore.prune(captureOwnerScope, modelDirectory).catch(() => undefined);
  }, [captureDirectory, captureDirectorySignature, captureOwnerScope, modelDirectory, modelDirectorySignature, projectsState]);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    void loadFilmCapabilities()
      .then((capability) => { if (active) setFilmCapability(capability); })
      .catch(() => { if (active) setFilmCapability({ available: false, reason: t("workspace.filmUnavailable") }); });
    return () => { active = false; };
  }, [ready]);

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
      .querySelector<HTMLElement>(`aside[aria-label="${CSS.escape(t("nav.canvasAgent"))}"]`)
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
    anchor.download = t("workspace.exportElementsName", { count: selected.length });
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const sorted = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects],
  );

  if (!ready || projectsState === "idle" || projectsState === "loading") {
    return <PageSkeleton />;
  }
  if (projectsState === "error" && !projects.length) {
    return (
      <WorkspaceLoadError
        message={t("workspace.loadFailed", { message: projectsError ?? "" })}
        onRetry={() => loadProjectsOnDemand()}
      />
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
        title={panelCollapsed ? t("workspace.expandSidebar") : t("workspace.openSidebar")}
        aria-label={panelCollapsed ? t("workspace.expandSidebar") : t("workspace.openSidebar")}
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
          aria-label={t("workspace.closePanel")}
          onClick={() => setProjectsOpen(false)}
        />
      ) : null}
      <aside
        aria-label={t("workspace.sidebar")}
        className={`${projectsOpen ? "absolute inset-y-0 left-0 z-50 flex" : "hidden"} ${panelCollapsed ? "md:hidden" : "md:relative md:flex"} z-40 w-[min(88vw,320px)] shrink-0 flex-col border-r border-[var(--ob-line)] bg-[var(--ob-panel-glass)] shadow-[var(--ob-elev-1)] backdrop-blur-md transition-opacity duration-200 md:w-[var(--canvas-panel-width)]`}
        style={{ "--canvas-panel-width": `${panelWidth}px` } as React.CSSProperties}
      >
        <div className="ob-toolbar-scroll flex min-h-12 min-w-0 items-center gap-px overflow-x-auto border-b border-[var(--ob-line)] px-1 py-2">
          {panelWidth >= 300 ? (
            <strong className="mr-auto truncate text-sm">{t("workspace.title")}</strong>
          ) : (
            <span className="mr-auto sr-only">{t("workspace.title")}</span>
          )}
          <button
            type="button"
            className={`${panelActionClass} ob-panel-mobile-only`}
            aria-label={t("workspace.closeSidebar")}
            title={t("workspace.closeSidebar")}
            onClick={() => setProjectsOpen(false)}
          >
            <X size={16} />
          </button>
          <button
            type="button"
            className={`${panelActionClass} ob-panel-desktop-only`}
            title={t("workspace.collapseSidebar")}
            onClick={() => updatePanelConfig({ canvasPanelCollapsed: true })}
          >
            <PanelLeftClose size={16} />
          </button>
          {panelTab === "projects" ? (
            <>
              <button
                type="button"
                className={panelActionClass}
                title={t("workspace.new")}
                onClick={() => setCreateOpen(true)}
              >
                <FolderPlus size={16} />
              </button>
              <button
                type="button"
                className={panelActionClass}
                aria-label={t("workspace.manageVoices")}
                title={t("workspace.currentVoices")}
                disabled={!activeProject}
                onClick={() => setAudioRolesOpen(true)}
              >
                <UsersRound size={16} />
              </button>
              <button
                type="button"
                className={panelActionClass}
                title={t("workspace.importJson")}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={16} />
              </button>
              <button
                type="button"
                className={panelActionClass}
                title={t("workspace.exportCurrent")}
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
                className={panelActionClass}
                title={t("workspace.exportBundle")}
                onClick={() => {
                  void (async () => {
                    const project = exportActiveProject();
                    if (!project) return;
                    try {
                      const { exportCompleteProjectBundle } = await import("@/services/film-bundle");
                      const blob = await exportCompleteProjectBundle(project);
                      const url = URL.createObjectURL(blob);
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = `${project.title || "openboard"}.openboard`;
                      anchor.click();
                      URL.revokeObjectURL(url);
                    } catch (error) {
                      setErrorMessage(error instanceof Error ? error.message : String(error));
                    }
                  })();
                }}
              >
                <Archive size={16} />
              </button>
              {tenantOwner ? (
                <button
                  type="button"
                  className={`${panelActionClass} !text-[var(--ob-danger)]`}
                  title={t("workspace.deleteSelected")}
                  aria-label={t("workspace.deleteSelected")}
                  disabled={!checked.length}
                  onClick={() => {
                    if (!checked.length) return;
                    setConfirmDeleteCount(checked.length);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              ) : null}
            </>
          ) : null}
          {panelTab === "elements" ? (
            <>
              <button
                type="button"
                aria-label={t("workspace.selectAllElements")}
                title={t("workspace.selectAllElements")}
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
                aria-label={t("workspace.exportSelectedElements")}
                title={t("workspace.exportSelectedElements")}
                className="ob-icon-btn h-8 w-8 shrink-0"
                disabled={!checkedNodes.length}
                onClick={() => void exportCheckedNodes().catch((error) =>
                  setErrorMessage(error instanceof Error ? error.message : String(error)))}
              >
                <Archive size={16} />
              </button>
            </>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept={tenantOwner ? ".json,.openboard,application/json,application/zip" : ".json,application/json"}
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
                if (isJson) {
                  const data = assertPlainProjectImportSafe(parseBoardProject(JSON.parse(await file.text())));
                  if (data.projectKind === "film") throw new Error("影片项目必须使用包含制作数据的 .openboard 完整包");
                  importProject(data);
                } else {
                  if (!tenantOwner) throw new Error(t("admin.permissionRequired"));
                  const { importCompleteProjectBundle } = await import("@/services/film-bundle");
                  await importCompleteProjectBundle(file);
                }
              } catch (error) {
                setErrorMessage(t("workspace.importFailed", {
                  message: error instanceof Error ? error.message : t("workspace.invalidFile"),
                }));
              } finally {
                input.value = "";
              }
            }}
          />
        </div>
        <div role="tablist" aria-label={t("workspace.views")} className="ob-toolbar-scroll relative flex min-w-0 gap-0 overflow-x-auto border-b border-[var(--ob-line)] px-2 pt-1">
          {([
            ["projects", t("workspace.projects")],
            ["elements", t("workspace.elements")],
            ["assets", t("workspace.assets")],
            ["prompts", t("workspace.prompts")],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={panelTab === value}
              className={`ob-tab relative z-[1] shrink-0 whitespace-nowrap rounded-lg border-b-0 px-2 text-sm ${
                panelTab === value ? "" : ""
              }`}
              onClick={() => changePanelTab(value)}
            >
              {label}
            </button>
          ))}
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
                    if (p.projectKind === "film") navigate(`/film/${p.id}`);
                  }}
                >
                  <input
                    className="w-full bg-transparent font-medium outline-none"
                    value={p.title}
                    onChange={(e) => renameProject(p.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <div className="mt-1 text-[11px] text-[var(--ob-muted)]">
                    {p.projectKind === "film" ? t("workspace.filmProduction") : t("workspace.nodeCount", { count: p.nodes.length })} · {new Date(p.updatedAt).toLocaleString(locale)}
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
              <p className="ob-empty-title">{t("workspace.emptyProjects")}</p>
              <p className="ob-empty-desc">{t("workspace.emptyProjectsDescription")}</p>
            </div>
          ) : null}
            </>
          ) : null}
          {panelTab === "elements" ? (
            activeProject?.nodes.length ? (
              <ul role="list" aria-label={t("workspace.canvasElements")} className="space-y-1">
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
                        aria-label={t("workspace.selectItem", { title: node.title })}
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
                        aria-label={t("workspace.locateItem", { title: node.title })}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => focusNode(node)}
                      >
                        <LocateFixed size={14} className="shrink-0 text-[var(--ob-accent)]" />
                        <span className="min-w-0 flex-1 truncate text-sm">{node.title}</span>
                        <span className="text-[10px] text-[var(--ob-muted)]">{t(NODE_TYPE_KEYS[node.type])}</span>
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
                <p className="ob-empty-title">{t("workspace.emptyElements")}</p>
                <p className="ob-empty-desc">{t("workspace.emptyElementsDescription")}</p>
              </div>
            )
          ) : null}
          {panelTab === "assets" ? <CanvasAssetsPanel /> : null}
          {panelTab === "prompts" ? <CanvasPromptsPanel /> : null}
        </div>
        <div
          role="separator"
          aria-label={t("workspace.resizeSidebar")}
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
        {activeProject?.projectKind === "film" ? (
          <div className="grid h-full place-items-center bg-[var(--ob-canvas)] p-6">
            <div className="ob-card max-w-md p-8 text-center">
              <Clapperboard className="mx-auto mb-4 text-[var(--ob-accent)]" size={36} aria-hidden />
              <h1 className="text-xl font-semibold">{activeProject.title}</h1>
              <p className="mt-2 text-sm text-[var(--ob-muted)]">{t("workspace.filmDescription")}</p>
              {filmCapability?.available ? <button type="button" className="ob-btn ob-btn-primary mt-5" onClick={() => navigate(`/film/${activeProject.id}`)}>
                {t("workspace.openFilm")}
              </button> : <p className="mt-4 text-sm text-[var(--ob-danger)]">{filmCapability?.reason || t("workspace.checkingFilm")}</p>}
            </div>
          </div>
        ) : <BoardCanvas />}
      </div>
      {createOpen ? (
        <div className="ob-overlay z-[100] p-4" onClick={() => setCreateOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-project-title"
            className="ob-surface ob-view-fade-in mx-auto mt-[12vh] w-full max-w-lg p-5 shadow-[var(--ob-elev-2)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-[var(--ob-line)] pb-3">
              <div>
                <p className="ob-page-kicker">{t("workspace.title")}</p>
                <h2 id="create-project-title" className="text-base font-semibold tracking-tight text-[var(--ob-ink)]">{t("workspace.createProject")}</h2>
              </div>
              <button type="button" className="ob-icon-btn ob-icon-btn-sm" aria-label={t("common.close")} onClick={() => setCreateOpen(false)}><X size={16} /></button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                className="group rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-4 text-left transition-all hover:border-[var(--ob-accent)] hover:bg-[var(--ob-panel)] hover:shadow-[var(--ob-elev-1)]"
                onClick={() => void createNewProject("canvas")}
              >
                <div className="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
                  <FolderPlus size={18} aria-hidden />
                </div>
                <strong className="block text-sm font-semibold text-[var(--ob-ink)] group-hover:text-[var(--ob-accent)] transition-colors">{t("workspace.canvasKind")}</strong>
                <span className="mt-1 block text-xs leading-relaxed text-[var(--ob-muted)]">{t("workspace.canvasKindDescription")}</span>
              </button>
              {filmCapability?.available ? (
                <button
                  type="button"
                  className="group rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-4 text-left transition-all hover:border-[var(--ob-accent)] hover:bg-[var(--ob-panel)] hover:shadow-[var(--ob-elev-1)]"
                  onClick={() => void createNewProject("film")}
                >
                  <div className="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]">
                    <Clapperboard size={18} aria-hidden />
                  </div>
                  <strong className="block text-sm font-semibold text-[var(--ob-ink)] group-hover:text-[var(--ob-accent)] transition-colors">{t("workspace.filmKind")}</strong>
                  <span className="mt-1 block text-xs leading-relaxed text-[var(--ob-muted)]">{t("workspace.filmKindDescription")}</span>
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
      {tenantOwner && confirmDeleteCount !== null ? (
        <ConfirmDialog
          title={t("workspace.confirmDeleteProjects", { count: confirmDeleteCount })}
          confirmLabel={t("common.delete")}
          tone="danger"
          onCancel={() => setConfirmDeleteCount(null)}
          onConfirm={() => {
            const projectIDs = [...checked];
            setConfirmDeleteCount(null);
            void deleteProjectsDurably(projectIDs)
              .then(() => setChecked([]))
              .catch((cause) => setErrorMessage(cause instanceof Error ? cause.message : String(cause)));
          }}
        />
      ) : null}
      {errorMessage ? (
        <div className="fixed bottom-4 right-4 z-[200] max-w-md animate-bounce">
          <div role="alert" className="ob-banner shadow-[var(--ob-elev-2)] rounded-xl" data-tone="danger">
            <span className="flex-1 text-xs">{errorMessage}</span>
            <button type="button" className="ob-icon-btn ob-icon-btn-sm" aria-label={t("common.close")} onClick={() => setErrorMessage(null)}>
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
      {audioRolesOpen ? (
        <ProjectAudioRolesDialog open onClose={() => setAudioRolesOpen(false)} />
      ) : null}
    </div>
  );
}
