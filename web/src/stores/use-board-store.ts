import { create } from "zustand";
import type {
  AppConfig,
  AssetItem,
  BackgroundMode,
  BoardEdge,
  BoardNode,
  BoardProject,
  ClipboardPayload,
  NodeType,
  Point,
  PromptItem,
  Viewport,
} from "@/types/board";
import {
  WorkspaceReplacementRollbackError,
  type WorkspaceSnapshot,
} from "@/lib/workspace-bundle";
import {
  deleteGenerationJobsForNodeIds,
  deleteGenerationJobsForProject,
  listAllGenerationJobs,
  replaceGenerationJobs,
} from "@/services/generation-jobs";
import {
  loadPersonalWorkflowTemplates,
  replacePersonalWorkflowTemplates,
} from "@/services/workflow-templates";
import { createDefaultConfig, createEmptySession, createNode, createProject } from "@/lib/defaults";
import { normalizeAppConfig } from "@/lib/app-config";
import { HistoryStack } from "@/lib/history";
import { nowIso, uid } from "@/lib/id";
import {
  createGroup,
  expandGroupedSelection,
  pruneGroupMembership,
  ungroupNodes,
} from "@/lib/grouping";
import {
  collectBoardContentStorageKeys,
  collectStorageKeys,
  loadAssets,
  loadConfig,
  deleteProjectsById,
  loadProjects,
  loadPrompts,
  rehydrateAssets,
  rehydrateProjects,
  resetStorageScopeState,
  replaceProjects,
  saveAssets,
  saveConfig,
  saveProjects,
  savePrompts,
  deleteStorageKey,
  uploadMedia,
  resolveObjectUrl,
} from "@/services/storage";
import { ConfigPreconditionError, SecretAuthRequiredError, TenantConfigAdminRequiredError } from "@/services/server-storage";
import { resetSharedChannelCatalog } from "@/services/shared-channels";
import type { GenerationDefaults } from "@/lib/generation-defaults";
import { normalizePluginManifests } from "@/lib/plugin-catalog";
import { fitMediaDisplaySize } from "@/lib/geometry";
import { DEFAULT_NODE_SIZE } from "@/lib/defaults";
import { collectGenerationStorageKeys } from "@/services/generation-jobs";
import {
  loadPublicPromptCatalog,
  mergePublicPromptCatalog,
  stripPublicPromptCatalog,
} from "@/services/public-prompt-catalog";
import { LatestWrite } from "@/lib/latest-write";
import { bindDirectorPanorama, removeEdgeAndReconcilePanorama } from "@/lib/director-panorama";
import {
  chooseLocalTwoToOneImageImportMode,
  readPanoramaBlobDimensions,
  validateProjectPanoramaBudget,
  type LocalImageImportMode,
} from "@/lib/panorama";
import {
  commitPanoramaGeneration as applyPanoramaGeneration,
  type PanoramaGeneratedMedia,
  type PanoramaGenerationDescriptor,
} from "@/lib/panorama-generation";
import { migrateLegacyAudioRoles } from "@/lib/project-audio-roles";
import { parseBoardProject } from "@/lib/board-document";
import {
  expandDirectorShotDeletion,
  generationCleanupNodeIdsAfterDeletion,
  orphanedGenerationJobIdsAfterDeletion,
  repairDirectorShotDeletion,
} from "@/lib/director-shot-generation";

type Snapshot = {
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport: Viewport;
  backgroundMode: BackgroundMode;
  chatSessions: BoardProject["chatSessions"];
  activeChatId: string | null;
};

export class ProjectCommitRollbackError extends AggregateError {
  constructor(commitError: unknown, rollbackError: unknown) {
    super([commitError, rollbackError], "项目提交失败，且回滚尚未持久化");
    this.name = "ProjectCommitRollbackError";
  }
}

export function removeDirectorShotPlan(
  project: BoardProject,
  addedNodeIds: ReadonlySet<string>,
  addedEdgeIds: ReadonlySet<string>,
): BoardProject {
  return {
    ...project,
    nodes: project.nodes.filter((node) => !addedNodeIds.has(node.id)),
    edges: project.edges.filter((edge) => !addedEdgeIds.has(edge.id) &&
      !addedNodeIds.has(edge.from) && !addedNodeIds.has(edge.to)),
    updatedAt: nowIso(),
  };
}

type BoardState = {
  ready: boolean;
  projects: BoardProject[];
  activeProjectId: string | null;
  selectedIds: string[];
  clipboard: ClipboardPayload | null;
  config: AppConfig;
  assets: AssetItem[];
  prompts: PromptItem[];
  connectingFrom: string | null;
  showMinimap: boolean;
  showShortcuts: boolean;
  showLocalAgent: boolean;
  hydrate: (promptCatalogScope?: string) => Promise<void>;
  prepareWorkspaceScopeChange: () => Promise<void>;
  resetWorkspaceScopeRuntime: () => void;
  setActiveProject: (id: string | null) => void;
  createProject: (title?: string) => string;
  renameProject: (id: string, title: string) => void;
  deleteProjects: (ids: string[]) => void;
  importProject: (project: BoardProject) => void;
  replaceProjectFromAgent: (project: BoardProject) => void;
  exportActiveProject: () => BoardProject | null;
  updateActive: (mutator: (project: BoardProject) => BoardProject, opts?: { history?: boolean }) => void;
  getActive: () => BoardProject | null;
  setViewport: (viewport: Viewport, history?: boolean) => void;
  commitViewportRun: () => void;
  setBackground: (mode: BackgroundMode) => void;
  addNode: (type: NodeType, position: Point, partial?: Partial<BoardNode>) => string;
  addConnectedNode: (from: string, type: NodeType, position: Point, partial?: Partial<BoardNode>) => string | null;
  commitDirectorCaptureNodes: (
    projectId: string,
    directorId: string,
    nodes: BoardNode[],
  ) => Promise<void>;
  commitDirectorShotRun: (
    projectId: string,
    directorId: string,
    expectedUpdatedAt: string,
    plannedProject: BoardProject,
  ) => Promise<void>;
  commitWorkflowResultNodes: (
    projectId: string,
    workflowRunId: string,
    nodes: BoardNode[],
  ) => Promise<void>;
  commitPanoramaBatch: (
    projectId: string,
    panoramaId: string,
    results: PanoramaGeneratedMedia[],
    descriptor: PanoramaGenerationDescriptor,
    historyProject: BoardProject,
    cleanupStorageKeys: boolean,
  ) => Promise<void>;
  bindDirectorPanorama: (
    directorId: string,
    panoramaId: string | null,
    opts?: { history?: boolean },
  ) => void;
  updateNode: (
    id: string,
    patch: Partial<BoardNode> | ((n: BoardNode) => BoardNode),
    opts?: { history?: boolean },
  ) => void;
  deleteSelected: () => void;
  setSelected: (ids: string[]) => void;
  toggleSelect: (id: string, additive?: boolean) => void;
  selectAll: () => void;
  moveNodes: (ids: string[], dx: number, dy: number) => void;
  resizeNode: (id: string, width: number, height: number, position?: Point) => void;
  connect: (from: string, to: string) => void;
  setConnectingFrom: (id: string | null) => void;
  deleteEdge: (id: string) => void;
  copySelected: () => void;
  pasteClipboard: (offset?: Point) => void;
  captureHistory: () => void;
  undo: () => void;
  redo: () => void;
  setConfig: (config: AppConfig) => void;
  flushConfig: () => Promise<void>;
  setAssets: (assets: AssetItem[]) => void;
  flushAssets: () => Promise<void>;
  commitAssetUpdate: (update: (assets: AssetItem[]) => AssetItem[]) => Promise<void>;
  setPrompts: (prompts: PromptItem[]) => void;
  flushPrompts: () => Promise<void>;
  addAssetFromNode: (nodeId: string) => Promise<void>;
  insertAsset: (assetId: string, position: Point) => Promise<void>;
  setShowMinimap: (v: boolean) => void;
  setShowShortcuts: (v: boolean) => void;
  setShowLocalAgent: (v: boolean) => void;
  alignSelected: (mode: "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter") => void;
  distributeSelected: (axis: "x" | "y") => void;
  duplicateSelected: () => void;
  groupSelected: () => void;
  ungroupSelected: () => void;
  persist: () => Promise<void>;
  persistNow: () => Promise<void>;
  replaceWorkspace: (snapshot: WorkspaceSnapshot) => Promise<void>;
};

const histories = new Map<string, HistoryStack<Snapshot>>();

/**
 * Project whose camera is mid-run, so consecutive viewport writes collapse into
 * one undo step. A gesture writes the viewport on every animation frame; without
 * coalescing a single wheel zoom would evict the whole history.
 */
let viewportRunProjectId: string | null = null;

function historyFor(id: string): HistoryStack<Snapshot> {
  let h = histories.get(id);
  if (!h) {
    h = new HistoryStack<Snapshot>(100);
    histories.set(id, h);
  }
  return h;
}

function snap(project: BoardProject): Snapshot {
  return {
    nodes: structuredClone(project.nodes),
    edges: structuredClone(project.edges),
    viewport: { ...project.viewport },
    backgroundMode: project.backgroundMode,
    chatSessions: structuredClone(project.chatSessions),
    activeChatId: project.activeChatId,
  };
}

function applySnap(project: BoardProject, s: Snapshot): BoardProject {
  return {
    ...project,
    nodes: s.nodes,
    edges: s.edges,
    viewport: s.viewport,
    backgroundMode: s.backgroundMode,
    chatSessions: s.chatSessions,
    activeChatId: s.activeChatId,
    updatedAt: nowIso(),
  };
}

let hydratePromise: { scope: string; promise: Promise<void> } | undefined;
let activeWorkspaceScope: string | undefined;

/**
 * Forget projects the server reported as deleted. Another device removed them,
 * so this tab's copy is stale rather than authoritative.
 */
function dropTombstonedProjects(ids: readonly string[]): void {
  const gone = new Set(ids);
  useBoardStore.setState((state) => {
    const projects = state.projects.filter((project) => !gone.has(project.id));
    if (projects.length === state.projects.length) return {};
    for (const id of gone) histories.delete(id);
    return {
      projects,
      activeProjectId: state.activeProjectId && gone.has(state.activeProjectId)
        ? (projects[0]?.id ?? null)
        : state.activeProjectId,
    };
  });
}

// The server refuses writes to projects it has tombstoned. Drop those locally
// rather than letting a stale tab retry a write it can never win.
const projectWrites = new LatestWrite(async (projects: BoardProject[]) => {
  const gone = await saveProjects(projects);
  if (gone.length) dropTombstonedProjects(gone);
}, (error) => console.error("OpenBoard project persistence failed", error));
const configWrites = new LatestWrite(saveConfig, (error) => {
  console.error("OpenBoard config persistence failed", error);
  if (error instanceof ConfigPreconditionError && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("openboard:config-conflict", {
      detail: { message: error.message },
    }));
  }
});
const assetWrites = new LatestWrite(saveAssets, (error) =>
  console.error("OpenBoard asset persistence failed", error));
const promptWrites = new LatestWrite(savePrompts, (error) =>
  console.error("OpenBoard prompt persistence failed", error));
let panoramaCommitChain: Promise<void> = Promise.resolve();

export async function saveWorkspaceReplacementConfig(save: () => Promise<void>): Promise<boolean> {
	try {
		await save();
		return true;
	} catch (error) {
		if (error instanceof TenantConfigAdminRequiredError || error instanceof SecretAuthRequiredError) return false;
		throw error;
	}
}

/**
 * Seeds a freshly created video/audio node from the tenant generation defaults.
 * Values the caller already supplied always win, and the input node is never
 * mutated in place.
 */
export function applyGenerationDefaultsToNode(
  node: BoardNode,
  defaults: GenerationDefaults | undefined,
): BoardNode {
  if (!defaults) return node;
  if (node.type !== "video" && node.type !== "audio") return node;
  const seeded: Record<string, unknown> = node.type === "video"
    ? {
        videoRatio: defaults.videoRatio,
        resolution: defaults.videoResolution,
        seconds: defaults.videoSeconds,
        generateAudio: defaults.videoGenerateAudio,
        watermark: defaults.videoWatermark,
      }
    : { voice: defaults.audioVoice };
  const metadata = { ...node.metadata } as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(seeded)) {
    if (metadata[key] !== undefined) continue;
    metadata[key] = value;
    changed = true;
  }
  return changed ? { ...node, metadata: metadata as BoardNode["metadata"] } : node;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  ready: false,
  projects: [],
  activeProjectId: null,
  selectedIds: [],
  clipboard: null,
  config: createDefaultConfig(),
  assets: [],
  prompts: [],
  connectingFrom: null,
  showMinimap: true,
  showShortcuts: false,
  showLocalAgent: false,

  hydrate: (promptCatalogScope = "open") => {
    if (hydratePromise?.scope === promptCatalogScope) return hydratePromise.promise;
    if (activeWorkspaceScope === promptCatalogScope && get().ready) return Promise.resolve();

    histories.clear();
    activeWorkspaceScope = promptCatalogScope;
    set({
      ready: false,
      projects: [],
      activeProjectId: null,
      selectedIds: [],
      clipboard: null,
      config: createDefaultConfig(),
      assets: [],
      prompts: [],
      connectingFrom: null,
    });

    const promise = (async () => {
      try {
        const [rawProjects, config, rawAssets, personalPrompts, publicCatalog] = await Promise.all([
          loadProjects(),
          loadConfig(),
          loadAssets(),
          loadPrompts(),
          loadPublicPromptCatalog(promptCatalogScope),
        ]);
        const prompts = mergePublicPromptCatalog(personalPrompts, publicCatalog.catalog);
        const [projects, assets] = await Promise.all([
          rehydrateProjects(rawProjects),
          rehydrateAssets(rawAssets),
        ]);
        let nextProjects = projects;
        let activeProjectId = projects[0]?.id ?? null;
        if (!nextProjects.length) {
          const first = createProject("我的第一个画布");
          nextProjects = [first];
          activeProjectId = first.id;
        }
        const defaults = createDefaultConfig();
        const hydratedConfig = config
          ? normalizeAppConfig({
              ...defaults,
              ...config,
              plugins: normalizePluginManifests(config.plugins),
              disabledPluginIds: Array.isArray(config.disabledPluginIds)
                ? [...new Set(config.disabledPluginIds.filter((id): id is string => typeof id === "string"))]
                : [],
            })
          : defaults;
        const legacyAudioRoleMigration = migrateLegacyAudioRoles(
          nextProjects,
          hydratedConfig.audioRoles,
        );
        nextProjects = legacyAudioRoleMigration.projects;
        const nextConfig = hydratedConfig.audioRoles === undefined
          ? hydratedConfig
          : { ...hydratedConfig, audioRoles: undefined };
        const [gone] = await Promise.all([
          saveProjects(nextProjects),
          saveAssets(assets),
          savePrompts(personalPrompts),
        ]);
        // Retire the legacy copy only after the project document has been
        // durably saved; otherwise a failed project write could lose the cast.
        if (hydratedConfig.audioRoles !== undefined) {
          await saveWorkspaceReplacementConfig(() => saveConfig(nextConfig)).catch((error) => {
            console.error("Failed to retire legacy global audio roles", error);
            return false;
          });
        }
        // A tombstone is authoritative. Drop those ids before the first paint so a
        // tab that still held the pre-delete document does not resurrect them in UI.
        if (gone.length) {
          const tombstoned = new Set(gone);
          nextProjects = nextProjects.filter((project) => !tombstoned.has(project.id));
          if (activeProjectId && tombstoned.has(activeProjectId)) {
            activeProjectId = nextProjects[0]?.id ?? null;
          }
          for (const id of gone) histories.delete(id);
        }
        set({
          ready: true,
          projects: nextProjects,
          config: nextConfig,
          assets,
          prompts,
          activeProjectId,
        });
        if (publicCatalog.stale && publicCatalog.error && typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("openboard:prompt-source-error", {
            detail: { message: `公共提示词库：${publicCatalog.error}` },
          }));
        }
      } catch (err) {
        console.error("OpenBoard hydrate failed", err);
        set({
          ready: true,
          projects: [],
          config: createDefaultConfig(),
          assets: [],
          prompts: [],
          activeProjectId: null,
        });
      }
    })().finally(() => {
      if (hydratePromise?.promise === promise) hydratePromise = undefined;
    });
    hydratePromise = { scope: promptCatalogScope, promise };
    return promise;
  },

  prepareWorkspaceScopeChange: async () => {
    if (hydratePromise) await hydratePromise.promise;
    await panoramaCommitChain;
    await Promise.all([
      projectWrites.flush(),
      configWrites.flush(),
      assetWrites.flush(),
      promptWrites.flush(),
    ]);
    // A panorama completion may enqueue a project write just as its chain settles.
    await projectWrites.flush();
  },

  resetWorkspaceScopeRuntime: () => {
    resetStorageScopeState();
    resetSharedChannelCatalog();
  },

  setActiveProject: (id) => set({ activeProjectId: id, selectedIds: [] }),

  createProject: (title) => {
    const project = createProject(title);
    set((s) => ({
      projects: [project, ...s.projects],
      activeProjectId: project.id,
      selectedIds: [],
    }));
    void get().persist();
    return project.id;
  },

  renameProject: (id, title) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, title, updatedAt: nowIso() } : p,
      ),
    }));
    void get().persist();
  },

  deleteProjects: (ids) => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return;
    set((s) => {
      const projects = s.projects.filter((p) => !unique.includes(p.id));
      const activeProjectId = unique.includes(s.activeProjectId ?? "")
        ? projects[0]?.id ?? null
        : s.activeProjectId;
      for (const id of unique) histories.delete(id);
      return { projects, activeProjectId, selectedIds: [] };
    });
    void (async () => {
      try {
        await deleteProjectsById(unique);
      } catch (error) {
        console.error("Failed to delete projects", error);
      }
      await get().persistNow();
      await Promise.all(unique.map((id) => deleteGenerationJobsForProject(id).catch(() => 0)));
    })();
  },

  importProject: (project) => {
    const imported: BoardProject = {
      ...project,
      id: uid("proj"),
      title: `${project.title} (导入)`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    set((s) => ({
      projects: [imported, ...s.projects],
      activeProjectId: imported.id,
    }));
    void get().persist();
  },

  replaceProjectFromAgent: (project) => {
    set((state) => ({
      projects: state.projects.map((current) =>
        current.id === project.id ? project : current,
      ),
    }));
    void get().persist();
  },

  exportActiveProject: () => get().getActive(),

  getActive: () => {
    const { projects, activeProjectId } = get();
    return projects.find((p) => p.id === activeProjectId) ?? null;
  },

  updateActive: (mutator, opts) => {
    const state = get();
    const current = state.getActive();
    if (!current) return;
    const next = mutator(current);
    if (next === current) return;
    // Any other edit ends the current camera run, so the next viewport write
    // starts a fresh undo step instead of merging into the previous gesture.
    viewportRunProjectId = null;
    if (opts?.history !== false) {
      historyFor(current.id).push(snap(current));
    }
    set({
      projects: state.projects.map((p) =>
        p.id === current.id ? { ...next, updatedAt: nowIso() } : p,
      ),
    });
    void get().persist();
  },

  setViewport: (viewport, history) => {
    const current = get().getActive();
    if (!current) return;
    // Upstream lists the viewport in the undo scope. A gesture writes it on
    // every frame, so only the first write of a run becomes an undo step and
    // the rest merge into it; a bare write outside a run is a step of its own.
    const merging = viewportRunProjectId === current.id;
    const record = history ?? !merging;
    get().updateActive((p) => ({ ...p, viewport }), { history: record });
    // A caller that opted out of the undo scope entirely (a programmatic
    // animation, say) must not leave a run open, or the user's next real
    // gesture would merge into it and never become undoable.
    viewportRunProjectId = history === false ? null : current.id;
  },

  commitViewportRun: () => {
    viewportRunProjectId = null;
  },

  setBackground: (mode) => {
    get().updateActive((p) => ({ ...p, backgroundMode: mode }));
  },

  addNode: (type, position, partial) => {
    const node = applyGenerationDefaultsToNode(
      createNode(type, position, partial), get().config.generationDefaults);
    get().updateActive((p) => ({ ...p, nodes: [...p.nodes, node] }));
    set({ selectedIds: [node.id] });
    return node.id;
  },

  addConnectedNode: (from, type, position, partial) => {
    const node = applyGenerationDefaultsToNode(
      createNode(type, position, partial), get().config.generationDefaults);
    let added = false;
    get().updateActive((project) => {
      if (!project.nodes.some((candidate) => candidate.id === from)) return project;
      added = true;
      return {
        ...project,
        nodes: [...project.nodes, node],
        edges: [...project.edges, { id: uid("edge"), from, to: node.id }],
      };
    });
    if (!added) return null;
    set({ selectedIds: [node.id] });
    return node.id;
  },

  commitDirectorCaptureNodes: async (projectId, directorId, nodes) => {
    const state = get();
    const project = state.projects.find((item) => item.id === projectId);
    const director = project?.nodes.find((item) => item.id === directorId);
    if (!project || state.activeProjectId !== projectId || director?.type !== "director") {
      throw new Error("导演台节点已不存在，无法发送截图");
    }
    if (!nodes.length || nodes.some((node) => node.type !== "image")) {
      throw new Error("导演台截图节点无效");
    }
    const nodeIds = new Set(nodes.map((node) => node.id));
    if (nodeIds.size !== nodes.length || project.nodes.some((node) => nodeIds.has(node.id))) {
      throw new Error("导演台截图节点 ID 冲突");
    }
    const before = snap(project);
    const edges = nodes.map((node) => ({ id: uid("edge"), from: directorId, to: node.id }));
    const nextProject: BoardProject = {
      ...project,
      nodes: [...project.nodes, ...nodes],
      edges: [...project.edges, ...edges],
      updatedAt: nowIso(),
    };
    set({
      projects: state.projects.map((item) => item.id === projectId ? nextProject : item),
    });
    projectWrites.enqueue(structuredClone(get().projects));
    try {
      await projectWrites.flush();
    } catch (error) {
      const latest = get();
      const rolledBackProjects = latest.projects.map((item) => item.id === projectId ? {
        ...item,
        nodes: item.nodes.filter((node) => !nodeIds.has(node.id)),
        edges: item.edges.filter((edge) => !nodeIds.has(edge.from) && !nodeIds.has(edge.to)),
        updatedAt: nowIso(),
      } : item);
      set({ projects: rolledBackProjects });
      projectWrites.enqueue(structuredClone(rolledBackProjects));
      try {
        await projectWrites.flush();
      } catch (rollbackError) {
        throw new ProjectCommitRollbackError(error, rollbackError);
      }
      throw error;
    }
    historyFor(projectId).push(before);
    set({ selectedIds: nodes.map((node) => node.id) });
  },

  commitDirectorShotRun: async (projectId, directorId, expectedUpdatedAt, plannedProject) => {
    const state = get();
    const current = state.projects.find((item) => item.id === projectId);
    const director = current?.nodes.find((item) => item.id === directorId);
    if (!current || state.activeProjectId !== projectId || current.updatedAt !== expectedUpdatedAt || director?.type !== "director") {
      throw new Error("导演台画布已变化，请重新选择截图生成");
    }
    if (plannedProject.id !== current.id || plannedProject.nodes.length !== current.nodes.length + 3 ||
        plannedProject.edges.length !== current.edges.length + 3) {
      throw new Error("正式镜头节点计划无效");
    }
    const currentNodeIds = new Set(current.nodes.map(({ id }) => id));
    const addedNodes = plannedProject.nodes.filter((node) => !currentNodeIds.has(node.id));
    const capture = addedNodes.find((node) => node.type === "image" && node.metadata.directorShot?.role === "capture");
    const configNode = addedNodes.find((node) => node.type === "config" && node.metadata.directorShot?.role === "config");
    const result = addedNodes.find((node) => node.type === "image" && node.metadata.generationConfigId === configNode?.id);
    if (!capture || !configNode || !result || capture.metadata.directorShot?.directorNodeId !== directorId ||
        configNode.metadata.directorShot?.captureId !== capture.metadata.directorShot.captureId ||
        !plannedProject.edges.some((edge) => edge.from === directorId && edge.to === capture.id) ||
        !plannedProject.edges.some((edge) => edge.from === capture.id && edge.to === configNode.id) ||
        !plannedProject.edges.some((edge) => edge.from === configNode.id && edge.to === result.id)) {
      throw new Error("正式镜头关系无效");
    }
    const unchangedNodes = plannedProject.nodes.filter((node) => currentNodeIds.has(node.id));
    if (JSON.stringify(unchangedNodes) !== JSON.stringify(current.nodes) ||
        JSON.stringify(plannedProject.edges.slice(0, current.edges.length)) !== JSON.stringify(current.edges)) {
      throw new Error("正式镜头计划修改了已有画布内容");
    }
    const nextProject = parseBoardProject({ ...plannedProject, updatedAt: nowIso() });
    const addedNodeIds = new Set(addedNodes.map((node) => node.id));
    const addedEdgeIds = new Set(nextProject.edges.slice(current.edges.length).map((edge) => edge.id));
    const nextProjects = state.projects.map((item) => item.id === projectId ? nextProject : item);
    const before = snap(current);
    set({ projects: nextProjects, selectedIds: [configNode.id, result.id] });
    projectWrites.enqueue(structuredClone(nextProjects));
    try {
      await projectWrites.flush();
    } catch (error) {
      const rollback = get().projects.map((item) => item.id === projectId
        ? removeDirectorShotPlan(item, addedNodeIds, addedEdgeIds)
        : item);
      set({ projects: rollback, selectedIds: [] });
      projectWrites.enqueue(structuredClone(rollback));
      try {
        await projectWrites.flush();
      } catch (rollbackError) {
        throw new ProjectCommitRollbackError(error, rollbackError);
      }
      throw error;
    }
    historyFor(projectId).push(before);
  },

  commitWorkflowResultNodes: (projectId, workflowRunId, nodes) => {
    const run = async () => {
      if (!workflowRunId || !nodes.length || nodes.length > 64 ||
          nodes.some((node) => node.type !== "image" || node.metadata.workflowRunId !== workflowRunId ||
            !node.metadata.storageKey || !node.metadata.content)) {
        throw new Error("工作流结果节点无效");
      }
      const ids = new Set(nodes.map((node) => node.id));
      if (ids.size !== nodes.length) throw new Error("工作流结果节点 ID 重复");
      let candidateAttempted = false;
      try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const state = get();
        const project = state.projects.find((item) => item.id === projectId);
        if (!project || state.activeProjectId !== projectId || project.nodes.some((node) => ids.has(node.id))) {
          throw new Error("当前画布已变化，无法插入工作流结果");
        }
        const before = snap(project);
        const nextProject = {
          ...project,
          nodes: [...project.nodes, ...structuredClone(nodes)],
          updatedAt: nowIso(),
        };
        const candidateProjects = state.projects.map((item) => item.id === projectId ? nextProject : item);
        candidateAttempted = true;
        await projectWrites.writeExact(structuredClone(candidateProjects));
        if (get().projects !== state.projects) continue;
        set({ projects: candidateProjects, selectedIds: nodes.map((node) => node.id) });
        historyFor(projectId).push(before);
        return;
      }
      throw new Error("工作流结果插入期间画布持续变化，请重试");
      } catch (error) {
        if (candidateAttempted) {
          try {
            await projectWrites.writeExact(structuredClone(get().projects));
          } catch (rollbackError) {
            throw new ProjectCommitRollbackError(error, rollbackError);
          }
        }
        throw error;
      }
    };
    const pending = panoramaCommitChain.then(run, run);
    panoramaCommitChain = pending.then(() => undefined, () => undefined);
    return pending;
  },

  commitPanoramaBatch: (
    projectId,
    panoramaId,
    results,
    descriptor,
    historyProject,
    cleanupStorageKeys,
  ) => {
    const run = async () => {
    const cleanup = async () => {
      if (!cleanupStorageKeys) return;
      const latest = get();
      const retained = collectStorageKeys(latest.projects, latest.assets);
      for (const history of histories.values()) {
        for (const snapshot of history.snapshots()) {
          for (const key of collectBoardContentStorageKeys(snapshot.nodes, snapshot.chatSessions)) retained.add(key);
        }
      }
      for (const key of await collectGenerationStorageKeys()) retained.add(key);
      await Promise.all(results.filter((result) => !retained.has(result.storageKey))
        .map((result) => deleteStorageKey(result.storageKey).catch(() => undefined)));
    };
    const originalRoot = historyProject.nodes.find((node) => node.id === panoramaId);
    if (historyProject.id !== projectId || originalRoot?.type !== "panorama") {
      await cleanup();
      throw new Error("全景节点已不存在，无法提交生成结果");
    }
    let candidateAttempted = false;
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const state = get();
        const project = state.projects.find((item) => item.id === projectId);
        if (!project || state.activeProjectId !== projectId) throw new Error("全景节点已不存在，无法提交生成结果");
        const beforeCommit = project;
        const nextProject = applyPanoramaGeneration(project, panoramaId, results, descriptor);
        const candidateProjects = state.projects.map((item) => item.id === projectId ? nextProject : item);

        candidateAttempted = true;
        await projectWrites.writeExact(structuredClone(candidateProjects));
        if (get().projects !== state.projects) continue;

        const historyBaseline: BoardProject = {
          ...beforeCommit,
          nodes: beforeCommit.nodes.map((node) => node.id === panoramaId ? {
            ...node,
            metadata: {
              ...node.metadata,
              status: originalRoot.metadata.status,
              errorDetails: originalRoot.metadata.errorDetails,
            },
          } : node),
        };
        set({ projects: candidateProjects });
        historyFor(projectId).push(snap(historyBaseline));
        return;
      }
      throw new Error("全景提交期间项目持续变化，请重试");
    } catch (error) {
      if (candidateAttempted) {
        try {
          await projectWrites.writeExact(structuredClone(get().projects));
        } catch (rollbackError) {
          throw new ProjectCommitRollbackError(error, rollbackError);
        }
      }
      await cleanup();
      throw error;
    }
    };
    const pending = panoramaCommitChain.then(run, run);
    panoramaCommitChain = pending.then(() => undefined, () => undefined);
    return pending;
  },

  bindDirectorPanorama: (directorId, panoramaId, opts) => {
    get().updateActive((project) => bindDirectorPanorama(project, directorId, panoramaId), opts);
  },

  updateNode: (id, patch, opts) => {
    get().updateActive((p) => {
      let changed = false;
      const nodes = p.nodes.map((n) => {
        if (n.id !== id) return n;
        const next = typeof patch === "function" ? patch(n) : {
          ...n,
          ...patch,
          metadata: { ...n.metadata, ...patch.metadata },
        };
        if (next !== n) changed = true;
        return next;
      });
      return changed ? { ...p, nodes } : p;
    }, opts);
  },

  deleteSelected: () => {
    const { selectedIds } = get();
    if (!selectedIds.length) return;
    const project = get().getActive();
    let selected = new Set(selectedIds);
    // cascade: deleting batch root removes children; deleting child updates root list
    if (project) {
      for (const id of [...selected]) {
        const n = project.nodes.find((x) => x.id === id);
        if (!n) continue;
        if (n.metadata.isBatchRoot && n.metadata.batchChildIds?.length) {
          for (const cid of n.metadata.batchChildIds) selected.add(cid);
        }
      }
      selected = expandDirectorShotDeletion(project, selected);
    }
    const nodeJobIds = project
      ? orphanedGenerationJobIdsAfterDeletion(project, selected)
      : new Set<string>();
    const generationCleanupNodeIds = project
      ? generationCleanupNodeIdsAfterDeletion(project, selected)
      : selected;

    get().updateActive((p) => {
      const remaining = repairDirectorShotDeletion(pruneGroupMembership(p.nodes, selected)
        .map((n) => {
          if (!n.metadata.batchChildIds?.length) return n;
          const kids = n.metadata.batchChildIds.filter((id) => !selected.has(id));
          const primary =
            n.metadata.primaryImageId && selected.has(n.metadata.primaryImageId)
              ? kids[0]
              : n.metadata.primaryImageId;
          return {
            ...n,
            metadata: {
              ...n.metadata,
              batchChildIds: kids,
              primaryImageId: primary,
              isBatchRoot: kids.length > 0 ? n.metadata.isBatchRoot : false,
            },
          };
        }), selected);
      return {
        ...p,
        nodes: remaining,
        edges: p.edges.filter((e) => !selected.has(e.from) && !selected.has(e.to)),
      };
    });
    set({ selectedIds: [] });
    void deleteGenerationJobsForNodeIds(project?.id, generationCleanupNodeIds, { nodeJobIds }).catch(() => 0);
  },


  setSelected: (ids) => set({ selectedIds: ids }),

  toggleSelect: (id, additive) => {
    set((s) => {
      if (!additive) return { selectedIds: [id] };
      if (s.selectedIds.includes(id)) {
        return { selectedIds: s.selectedIds.filter((x) => x !== id) };
      }
      return { selectedIds: [...s.selectedIds, id] };
    });
  },

  selectAll: () => {
    const project = get().getActive();
    if (!project) return;
    set({ selectedIds: project.nodes.map((n) => n.id) });
  },

  moveNodes: (ids, dx, dy) => {
    const setIds = new Set(ids);
    get().updateActive(
      (p) => ({
        ...p,
        nodes: p.nodes.map((n) =>
          setIds.has(n.id)
            ? {
                ...n,
                position: { x: n.position.x + dx, y: n.position.y + dy },
              }
            : n,
        ),
      }),
      { history: true },
    );
  },

  resizeNode: (id, width, height, position) => {
    get().updateActive(
      (p) => ({
        ...p,
        nodes: p.nodes.map((n) =>
          n.id === id
            ? {
                ...n,
                width: Math.max(120, width),
                height: Math.max(80, height),
                // Corner drags anchor the opposite corner, so the position moves
                // with the size. Omitted position keeps the node in place.
                ...(position ? { position: { ...position } } : {}),
              }
            : n,
        ),
      }),
      { history: false },
    );
  },

  connect: (from, to) => {
    if (from === to) return;
    get().updateActive((p) => {
      const source = p.nodes.find((node) => node.id === from);
      const target = p.nodes.find((node) => node.id === to);
      if (
        target?.type === "director" &&
        (source?.type === "panorama" || source?.type === "image")
      ) {
        return bindDirectorPanorama(p, to, from);
      }
      if (p.edges.some((e) => e.from === from && e.to === to)) return p;
      const edge: BoardEdge = { id: uid("edge"), from, to };
      return { ...p, edges: [...p.edges, edge] };
    });
    set({ connectingFrom: null });
  },

  setConnectingFrom: (id) => set({ connectingFrom: id }),

  deleteEdge: (id) => {
    get().updateActive((p) => removeEdgeAndReconcilePanorama(p, id));
  },

  copySelected: () => {
    const project = get().getActive();
    if (!project) return;
    const selected = new Set(expandGroupedSelection(project.nodes, get().selectedIds));
    const nodes = project.nodes
      .filter((n) => selected.has(n.id))
      .map((n) => structuredClone(n));
    const edges = project.edges
      .filter((e) => selected.has(e.from) && selected.has(e.to))
      .map((e) => structuredClone(e));
    set({ clipboard: { nodes, edges } });
  },

  pasteClipboard: (offset = { x: 40, y: 40 }) => {
    const { clipboard } = get();
    if (!clipboard?.nodes.length) return;
    const idMap = new Map<string, string>();
    const nodes = clipboard.nodes.map((n) => {
      const id = uid("node");
      idMap.set(n.id, id);
      return {
        ...structuredClone(n),
        id,
        position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      };
    }).map((node) =>
      node.type === "group"
        ? {
            ...node,
            metadata: {
              ...node.metadata,
              childIds: (node.metadata.childIds ?? [])
                .map((childId) => idMap.get(childId))
                .filter((childId): childId is string => Boolean(childId)),
            },
          }
        : node,
    );
    const edges = clipboard.edges
      .map((e) => {
        const from = idMap.get(e.from);
        const to = idMap.get(e.to);
        if (!from || !to) return null;
        return { id: uid("edge"), from, to };
      })
      .filter((e): e is BoardEdge => Boolean(e));
    get().updateActive((p) => ({
      ...p,
      nodes: [...p.nodes, ...nodes],
      edges: [...p.edges, ...edges],
    }));
    set({ selectedIds: nodes.map((n) => n.id) });
  },

  captureHistory: () => {
    const project = get().getActive();
    if (!project) return;
    historyFor(project.id).push(snap(project));
  },

  undo: () => {
    const project = get().getActive();
    if (!project) return;
    const prev = historyFor(project.id).undo(snap(project));
    if (!prev) return;
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === project.id ? applySnap(p, prev) : p,
      ),
    }));
    void get().persist();
  },

  redo: () => {
    const project = get().getActive();
    if (!project) return;
    const next = historyFor(project.id).redo(snap(project));
    if (!next) return;
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === project.id ? applySnap(p, next) : p,
      ),
    }));
    void get().persist();
  },

  setConfig: (config) => {
    const normalized = normalizeAppConfig(config);
    set({ config: normalized });
    configWrites.enqueue(normalized);
  },

  flushConfig: () => configWrites.flush(),

  setAssets: (assets) => {
    const next = structuredClone(assets);
    set({ assets: next });
    assetWrites.enqueue(next);
  },

  flushAssets: () => assetWrites.flush(),

  commitAssetUpdate: async (update) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const baseline = get().assets;
      const next = structuredClone(update(structuredClone(baseline)));
      await assetWrites.writeExact(next);
      if (get().assets !== baseline) continue;
      set({ assets: next });
      return;
    }
    throw new Error("素材列表持续发生变化，请重试");
  },

  setPrompts: (prompts) => {
    const next = structuredClone(prompts);
    set({ prompts: next });
    promptWrites.enqueue(stripPublicPromptCatalog(next));
  },

  flushPrompts: () => promptWrites.flush(),

  addAssetFromNode: async (nodeId) => {
    const project = get().getActive();
    const node = project?.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const t = nowIso();
    if (node.type === "text") {
      const asset: AssetItem = {
        id: uid("asset"),
        kind: "text",
        title: node.title || "文本素材",
        tags: [],
        content: node.metadata.content ?? "",
        createdAt: t,
        updatedAt: t,
      };
      const assets = [asset, ...get().assets];
      set({ assets });
      assetWrites.enqueue(structuredClone(assets));
      await assetWrites.flush();
      return;
    }
    if ((node.type === "image" || node.type === "video" || node.type === "audio") && node.metadata.content) {
      const asset: AssetItem = {
        id: uid("asset"),
        kind: node.type,
        title: node.title || `${node.type === "image" ? "图片" : node.type === "video" ? "视频" : "音频"}素材`,
        tags: [],
        coverUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
        mimeType: node.metadata.mimeType,
        createdAt: t,
        updatedAt: t,
      };
      const assets = [asset, ...get().assets];
      set({ assets });
      assetWrites.enqueue(structuredClone(assets));
      await assetWrites.flush();
    }
  },

  insertAsset: async (assetId, position) => {
    const asset = get().assets.find((a) => a.id === assetId);
    if (!asset) return;
    if (asset.kind === "text") {
      get().addNode("text", position, {
        title: asset.title,
        metadata: { content: asset.content ?? "", status: "success" },
      });
    } else if (
      asset.kind === "image" &&
      (asset.notes === "panoramaProjection:equirectangular" ||
        asset.tags?.includes("panorama"))
    ) {
      let naturalWidth: number | undefined;
      let naturalHeight: number | undefined;
      try {
        const storageKey = (asset.storageKey ?? "").trim();
        const url = storageKey
          ? ((await resolveObjectUrl("image", storageKey, asset.coverUrl)) ?? asset.coverUrl)
          : asset.coverUrl;
        if (url) {
          const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
            const img = new Image();
            const timeout = window.setTimeout(() => reject(new Error("Timed out reading image size")), 2_000);
            img.onload = () => {
              window.clearTimeout(timeout);
              resolve({ width: img.naturalWidth, height: img.naturalHeight });
            };
            img.onerror = () => {
              window.clearTimeout(timeout);
              reject(new Error("Failed to read image size"));
            };
            img.src = url;
          });
          if (dimensions.width > 0 && dimensions.height > 0) {
            naturalWidth = dimensions.width;
            naturalHeight = dimensions.height;
          }
        }
      } catch {
        // Best-effort: panorama validation can still run later when media loads.
      }
      const display =
        naturalWidth && naturalHeight
          ? fitMediaDisplaySize(
              naturalWidth,
              naturalHeight,
              120,
              Math.max(DEFAULT_NODE_SIZE.panorama.width, DEFAULT_NODE_SIZE.panorama.height),
            )
          : undefined;
      get().addNode("panorama", position, {
        title: asset.title || "360° 全景",
        ...(display ? { width: display.width, height: display.height } : {}),
        metadata: {
          content: asset.coverUrl,
          storageKey: asset.storageKey,
          mimeType: asset.mimeType,
          ...(naturalWidth ? { naturalWidth } : {}),
          ...(naturalHeight ? { naturalHeight } : {}),
          panoramaProjection: "equirectangular",
          status: "success",
        },
      });
    } else {
      get().addNode(asset.kind, position, {
        title: asset.title,
        metadata: {
          content: asset.coverUrl,
          storageKey: asset.storageKey,
          mimeType: asset.mimeType,
          status: "success",
        },
      });
    }
    // Ensure formal/server storage has the node before navigations/reloads in E2E and real use.
    await get().persistNow();
  },

  setShowMinimap: (v) => set({ showMinimap: v }),
  setShowShortcuts: (v) => set({ showShortcuts: v }),
  setShowLocalAgent: (v) => set({ showLocalAgent: v }),

  alignSelected: (mode) => {
    const { selectedIds } = get();
    const project = get().getActive();
    if (!project || selectedIds.length < 2) return;
    const nodes = project.nodes.filter((n) => selectedIds.includes(n.id));
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const maxX = Math.max(...nodes.map((n) => n.position.x + n.width));
    const maxY = Math.max(...nodes.map((n) => n.position.y + n.height));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    get().updateActive((p) => ({
      ...p,
      nodes: p.nodes.map((n) => {
        if (!selectedIds.includes(n.id)) return n;
        let x = n.position.x;
        let y = n.position.y;
        if (mode === "left") x = minX;
        if (mode === "right") x = maxX - n.width;
        if (mode === "top") y = minY;
        if (mode === "bottom") y = maxY - n.height;
        if (mode === "hcenter") x = cx - n.width / 2;
        if (mode === "vcenter") y = cy - n.height / 2;
        return { ...n, position: { x, y } };
      }),
    }));
  },

  distributeSelected: (axis) => {
    const { selectedIds } = get();
    const project = get().getActive();
    if (!project || selectedIds.length < 3) return;
    const nodes = project.nodes
      .filter((n) => selectedIds.includes(n.id))
      .sort((a, b) =>
        axis === "x" ? a.position.x - b.position.x : a.position.y - b.position.y,
      );
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (axis === "x") {
      const span =
        last.position.x + last.width - first.position.x - nodes.reduce((s, n) => s + n.width, 0);
      const gap = span / (nodes.length - 1);
      let cursor = first.position.x;
      const pos = new Map<string, number>();
      for (const n of nodes) {
        pos.set(n.id, cursor);
        cursor += n.width + gap;
      }
      get().updateActive((p) => ({
        ...p,
        nodes: p.nodes.map((n) =>
          pos.has(n.id) ? { ...n, position: { ...n.position, x: pos.get(n.id)! } } : n,
        ),
      }));
    } else {
      const span =
        last.position.y + last.height - first.position.y - nodes.reduce((s, n) => s + n.height, 0);
      const gap = span / (nodes.length - 1);
      let cursor = first.position.y;
      const pos = new Map<string, number>();
      for (const n of nodes) {
        pos.set(n.id, cursor);
        cursor += n.height + gap;
      }
      get().updateActive((p) => ({
        ...p,
        nodes: p.nodes.map((n) =>
          pos.has(n.id) ? { ...n, position: { ...n.position, y: pos.get(n.id)! } } : n,
        ),
      }));
    }
  },

  duplicateSelected: () => {
    get().copySelected();
    get().pasteClipboard({ x: 40, y: 40 });
  },

  groupSelected: () => {
    const project = get().getActive();
    if (!project) return;
    const result = createGroup(project.nodes, get().selectedIds, uid("group"));
    if (!result.group) return;
    get().updateActive((current) => ({ ...current, nodes: result.nodes }));
    set({ selectedIds: result.selectedIds });
  },

  ungroupSelected: () => {
    const project = get().getActive();
    if (!project) return;
    const result = ungroupNodes(project.nodes, get().selectedIds);
    if (result.nodes === project.nodes) return;
    get().updateActive((current) => ({ ...current, nodes: result.nodes }));
    set({ selectedIds: result.selectedIds });
  },

  persist: async () => {
    projectWrites.enqueue(structuredClone(get().projects));
  },

  persistNow: async () => {
    projectWrites.enqueue(structuredClone(get().projects));
    await projectWrites.flush();
  },

  replaceWorkspace: async (snapshot) => {
    await Promise.all([
      get().persistNow(),
      get().flushConfig(),
      assetWrites.flush(),
      promptWrites.flush(),
    ]);
    const current = get();
    const rawImported = structuredClone(snapshot);
    const importedAudioRoles = migrateLegacyAudioRoles(
      rawImported.projects,
      rawImported.config.audioRoles,
    );
    const imported: WorkspaceSnapshot = {
      ...rawImported,
      projects: importedAudioRoles.projects,
      config: rawImported.config.audioRoles === undefined
        ? rawImported.config
        : { ...rawImported.config, audioRoles: undefined },
    };
    const previous: WorkspaceSnapshot = {
      projects: structuredClone(current.projects),
      assets: structuredClone(current.assets),
      prompts: structuredClone(current.prompts),
      config: structuredClone(current.config),
      generationJobs: await listAllGenerationJobs(),
      workflowTemplates: await loadPersonalWorkflowTemplates(),
    };
    const persistSnapshot = async (value: WorkspaceSnapshot): Promise<boolean> => {
      await replaceProjects(value.projects);
      await saveAssets(value.assets);
      await savePrompts(value.prompts);
		const configSaved = await saveWorkspaceReplacementConfig(() => saveConfig(value.config));
      await replaceGenerationJobs(value.generationJobs);
      await replacePersonalWorkflowTemplates(value.workflowTemplates);
		return configSaved;
    };
		let importedConfigSaved = true;
    try {
		importedConfigSaved = await persistSnapshot(imported);
    } catch (error) {
      try {
        await persistSnapshot(previous);
      } catch (rollbackError) {
        throw new WorkspaceReplacementRollbackError(error, rollbackError);
      }
      throw error;
    }
    histories.clear();
    set({
      projects: structuredClone(imported.projects),
      activeProjectId: imported.projects[0]?.id ?? null,
      selectedIds: [],
      clipboard: null,
		config: structuredClone(importedConfigSaved ? imported.config : previous.config),
      assets: structuredClone(imported.assets),
      prompts: structuredClone(imported.prompts),
      connectingFrom: null,
    });
  },
}));

export type AttachUploadedImageOptions = {
  /** Force ordinary image or panorama import; default auto prompts for strict 2:1 candidates. */
  mode?: LocalImageImportMode | "auto";
  /** Injectable confirm() for tests; only used when mode is auto and the file is a 2:1 candidate. */
  chooseMode?: (message: string) => boolean;
};

async function detectStrictTwoToOneCandidate(
  file: File | Blob,
): Promise<{ width: number; height: number } | null> {
  if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
    return null;
  }
  try {
    return await readPanoramaBlobDimensions(file);
  } catch {
    return null;
  }
}

export async function attachUploadedImage(
  file: File | Blob,
  position: Point,
  options: AttachUploadedImageOptions = {},
): Promise<string> {
  const forced = options.mode ?? "auto";
  let mode: LocalImageImportMode = "image";
  if (forced === "image" || forced === "panorama") {
    mode = forced;
  } else {
    const candidate = await detectStrictTwoToOneCandidate(file);
    if (candidate) {
      mode = chooseLocalTwoToOneImageImportMode(options.chooseMode);
    }
  }

  if (mode === "panorama") {
    const project = useBoardStore.getState().getActive();
    if (!project) throw new Error("请先创建一个画布项目");
    let uploaded: Awaited<ReturnType<typeof uploadMedia>> | undefined;
    try {
      uploaded = await uploadMedia(file, "image", {
        preflightImage: readPanoramaBlobDimensions,
      });
      const display = fitMediaDisplaySize(
        uploaded.width,
        uploaded.height,
        120,
        Math.max(DEFAULT_NODE_SIZE.panorama.width, DEFAULT_NODE_SIZE.panorama.height),
      );
      const provisional = {
        id: "__import_panorama__",
        type: "panorama" as const,
        title: "360° 全景",
        position,
        width: display.width,
        height: display.height,
        metadata: {
          content: uploaded.url,
          storageKey: uploaded.storageKey,
          naturalWidth: uploaded.width,
          naturalHeight: uploaded.height,
          bytes: uploaded.bytes,
          mimeType: uploaded.mimeType,
          panoramaProjection: "equirectangular" as const,
          status: "success" as const,
        },
      };
      validateProjectPanoramaBudget([...project.nodes, provisional as BoardNode]);
      return useBoardStore.getState().addNode("panorama", position, {
        metadata: {
          content: uploaded.url,
          storageKey: uploaded.storageKey,
          naturalWidth: uploaded.width,
          naturalHeight: uploaded.height,
          bytes: uploaded.bytes,
          mimeType: uploaded.mimeType,
          panoramaProjection: "equirectangular",
          status: "success",
        },
        width: display.width,
        height: display.height,
      });
    } catch (error) {
      if (uploaded?.storageKey) {
        await deleteStorageKey(uploaded.storageKey).catch(() => undefined);
      }
      throw error;
    }
  }

  const uploaded = await uploadMedia(file, "image");
  const display = fitMediaDisplaySize(uploaded.width, uploaded.height);
  return useBoardStore.getState().addNode("image", position, {
    metadata: {
      content: uploaded.url,
      storageKey: uploaded.storageKey,
      naturalWidth: uploaded.width,
      naturalHeight: uploaded.height,
      bytes: uploaded.bytes,
      mimeType: uploaded.mimeType,
      status: "success",
    },
    width: display.width,
    height: display.height,
  });
}

export async function attachUploadedVideo(
  file: File | Blob,
  position: Point,
): Promise<string> {
  const uploaded = await uploadMedia(file, "media");
  return useBoardStore.getState().addNode("video", position, {
    metadata: {
      content: uploaded.url,
      storageKey: uploaded.storageKey,
      bytes: uploaded.bytes,
      mimeType: uploaded.mimeType,
      status: "success",
    },
    width: 360,
    height: 240,
  });
}

export async function attachUploadedAudio(
  file: File | Blob,
  position: Point,
): Promise<string> {
  const uploaded = await uploadMedia(file, "media");
  return useBoardStore.getState().addNode("audio", position, {
    metadata: {
      content: uploaded.url,
      storageKey: uploaded.storageKey,
      bytes: uploaded.bytes,
      mimeType: uploaded.mimeType,
      status: "success",
    },
    width: 320,
    height: 120,
  });
}

export function ensureChatSession(project: BoardProject): BoardProject {
  if (project.chatSessions.length && project.activeChatId) return project;
  const session = createEmptySession();
  return {
    ...project,
    chatSessions: [session],
    activeChatId: session.id,
  };
}
