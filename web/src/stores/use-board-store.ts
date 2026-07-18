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
import type { WorkspaceSnapshot } from "@/lib/workspace-bundle";
import { listAllGenerationJobs, replaceGenerationJobs } from "@/services/generation-jobs";
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
  cleanupUnusedMedia,
  collectStorageKeys,
  loadAssets,
  loadConfig,
  loadProjects,
  loadPrompts,
  rehydrateAssets,
  rehydrateProjects,
  saveAssets,
  saveConfig,
  saveProjects,
  savePrompts,
  uploadMedia,
} from "@/services/storage";
import { normalizePluginManifests } from "@/lib/plugin-catalog";
import { fitMediaDisplaySize } from "@/lib/geometry";
import { collectGenerationStorageKeys } from "@/services/generation-jobs";
import { LatestWrite } from "@/lib/latest-write";

type Snapshot = {
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport: Viewport;
  backgroundMode: BackgroundMode;
  chatSessions: BoardProject["chatSessions"];
  activeChatId: string | null;
};

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
  showAssistant: boolean;
  showShortcuts: boolean;
  showLocalAgent: boolean;
  hydrate: () => Promise<void>;
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
  setBackground: (mode: BackgroundMode) => void;
  addNode: (type: NodeType, position: Point, partial?: Partial<BoardNode>) => string;
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
  resizeNode: (id: string, width: number, height: number) => void;
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
  setPrompts: (prompts: PromptItem[]) => void;
  addAssetFromNode: (nodeId: string) => Promise<void>;
  insertAsset: (assetId: string, position: Point) => Promise<void>;
  setShowMinimap: (v: boolean) => void;
  setShowAssistant: (v: boolean) => void;
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

let persistTimer: number | undefined;
let hydratePromise: Promise<void> | undefined;
const configWrites = new LatestWrite(saveConfig, (error) =>
  console.error("OpenBoard config persistence failed", error));
const assetWrites = new LatestWrite(saveAssets, (error) =>
  console.error("OpenBoard asset persistence failed", error));
const promptWrites = new LatestWrite(savePrompts, (error) =>
  console.error("OpenBoard prompt persistence failed", error));

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
  showAssistant: true,
  showShortcuts: false,
  showLocalAgent: false,

  hydrate: () => {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      try {
      const [rawProjects, config, rawAssets, prompts] = await Promise.all([
        loadProjects(),
        loadConfig(),
        loadAssets(),
        loadPrompts(),
      ]);
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
      set({
        ready: true,
        projects: nextProjects,
        config: hydratedConfig,
        assets,
        prompts,
        activeProjectId,
      });
      await saveProjects(nextProjects);
      await saveAssets(assets);
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
    })();
    return hydratePromise;
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
    set((s) => {
      const projects = s.projects.filter((p) => !ids.includes(p.id));
      const activeProjectId = ids.includes(s.activeProjectId ?? "")
        ? projects[0]?.id ?? null
        : s.activeProjectId;
      for (const id of ids) histories.delete(id);
      return { projects, activeProjectId, selectedIds: [] };
    });
    void get().persist();
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

  setViewport: (viewport, history = false) => {
    get().updateActive((p) => ({ ...p, viewport }), { history });
  },

  setBackground: (mode) => {
    get().updateActive((p) => ({ ...p, backgroundMode: mode }));
  },

  addNode: (type, position, partial) => {
    const node = createNode(type, position, partial);
    get().updateActive((p) => ({ ...p, nodes: [...p.nodes, node] }));
    set({ selectedIds: [node.id] });
    return node.id;
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
    const selected = new Set(selectedIds);
    // cascade: deleting batch root removes children; deleting child updates root list
    if (project) {
      for (const id of [...selected]) {
        const n = project.nodes.find((x) => x.id === id);
        if (!n) continue;
        if (n.metadata.isBatchRoot && n.metadata.batchChildIds?.length) {
          for (const cid of n.metadata.batchChildIds) selected.add(cid);
        }
      }
    }
    get().updateActive((p) => {
      const remaining = pruneGroupMembership(p.nodes, selected)
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
        });
      return {
        ...p,
        nodes: remaining,
        edges: p.edges.filter((e) => !selected.has(e.from) && !selected.has(e.to)),
      };
    });
    set({ selectedIds: [] });
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

  resizeNode: (id, width, height) => {
    get().updateActive(
      (p) => ({
        ...p,
        nodes: p.nodes.map((n) =>
          n.id === id
            ? { ...n, width: Math.max(120, width), height: Math.max(80, height) }
            : n,
        ),
      }),
      { history: false },
    );
  },

  connect: (from, to) => {
    if (from === to) return;
    get().updateActive((p) => {
      if (p.edges.some((e) => e.from === from && e.to === to)) return p;
      const edge: BoardEdge = { id: uid("edge"), from, to };
      return { ...p, edges: [...p.edges, edge] };
    });
    set({ connectingFrom: null });
  },

  setConnectingFrom: (id) => set({ connectingFrom: id }),

  deleteEdge: (id) => {
    get().updateActive((p) => ({
      ...p,
      edges: p.edges.filter((e) => e.id !== id),
    }));
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
    set({ assets });
    assetWrites.enqueue(assets);
  },

  setPrompts: (prompts) => {
    set({ prompts });
    promptWrites.enqueue(prompts);
  },

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
      await saveAssets(assets);
      return;
    }
    if (node.type === "image" && node.metadata.content) {
      const asset: AssetItem = {
        id: uid("asset"),
        kind: "image",
        title: node.title || "图片素材",
        tags: [],
        coverUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
        mimeType: node.metadata.mimeType,
        createdAt: t,
        updatedAt: t,
      };
      const assets = [asset, ...get().assets];
      set({ assets });
      await saveAssets(assets);
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
      return;
    }
    get().addNode("image", position, {
      title: asset.title,
      metadata: {
        content: asset.coverUrl,
        storageKey: asset.storageKey,
        mimeType: asset.mimeType,
        status: "success",
      },
    });
  },

  setShowMinimap: (v) => set({ showMinimap: v }),
  setShowAssistant: (v) => set({ showAssistant: v }),
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
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(async () => {
      await get().persistNow();
    }, 250);
  },

  persistNow: async () => {
    window.clearTimeout(persistTimer);
    const { projects, assets } = get();
    await saveProjects(projects);
    const keys = collectStorageKeys(projects, assets);
    for (const key of await collectGenerationStorageKeys()) keys.add(key);
    await cleanupUnusedMedia(keys);
  },

  replaceWorkspace: async (snapshot) => {
    await Promise.all([
      get().persistNow(),
      get().flushConfig(),
      assetWrites.flush(),
      promptWrites.flush(),
    ]);
    const current = get();
    const previous: WorkspaceSnapshot = {
      projects: structuredClone(current.projects),
      assets: structuredClone(current.assets),
      prompts: structuredClone(current.prompts),
      config: structuredClone(current.config),
      generationJobs: await listAllGenerationJobs(),
    };
    const persistSnapshot = async (value: WorkspaceSnapshot) => {
      await saveProjects(value.projects);
      await saveAssets(value.assets);
      await savePrompts(value.prompts);
      await saveConfig(value.config);
      await replaceGenerationJobs(value.generationJobs);
    };
    try {
      await persistSnapshot(snapshot);
    } catch (error) {
      try {
        await persistSnapshot(previous);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "工作区恢复失败，且原数据回滚未完成");
      }
      throw error;
    }
    histories.clear();
    set({
      projects: structuredClone(snapshot.projects),
      activeProjectId: snapshot.projects[0]?.id ?? null,
      selectedIds: [],
      clipboard: null,
      config: structuredClone(snapshot.config),
      assets: structuredClone(snapshot.assets),
      prompts: structuredClone(snapshot.prompts),
      connectingFrom: null,
    });
  },
}));

export async function attachUploadedImage(
  file: File | Blob,
  position: Point,
): Promise<string> {
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
