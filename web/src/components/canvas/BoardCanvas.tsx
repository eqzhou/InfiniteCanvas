import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useBoardStore, attachUploadedImage, attachUploadedVideo, attachUploadedAudio } from "@/stores/use-board-store";
import type { Point } from "@/types/board";
import {
  clamp,
  edgePath,
  fitViewport,
  nodePort,
  rectsIntersect,
  screenToWorld,
  viewportWorldRect,
} from "@/lib/geometry";
import { cn } from "@/lib/cn";
import { BoardNodeView } from "@/components/canvas/BoardNodeView";
import { MiniMap } from "@/components/canvas/MiniMap";
import { ZoomControls } from "@/components/canvas/ZoomControls";
import { CanvasToolbar } from "@/components/canvas/CanvasToolbar";
import { ContextMenu, type ContextMenuState } from "@/components/canvas/ContextMenu";
import { AssetPickerModal } from "@/components/canvas/AssetPickerModal";
import { expandGroupedSelection, reconcileGroupMembership } from "@/lib/grouping";
import {
  createGestureState,
  reduceGesture,
  type GestureState,
} from "@/lib/gesture";
import { createNodeSpatialIndex } from "@/lib/spatial-index";
import { createEdgeGeometryIndex } from "@/lib/edge-index";
import { enabledPluginManifests } from "@/lib/plugin-catalog";
import { BUILTIN_PLUGINS } from "@/plugins/builtins";
import { DEFAULT_NODE_SIZE } from "@/lib/defaults";
import { findOpenNodePosition } from "@/lib/node-placement";
import { useCanvasGenerationRecovery } from "@/components/canvas/useCanvasGenerationRecovery";
import { OPENBOARD_ASSET_DRAG_MIME, readOpenBoardAssetDrag } from "@/lib/asset-drag";
import { resizeFromCorner, type NodeRect, type NodeResizeCorner } from "@/lib/node-resize";
import { mergeSharedChannelChoices, useSharedChannels } from "@/services/shared-channels";
import {
  canvasExportFilename,
  downloadCanvasSnapshot,
  renderCanvasSnapshot,
} from "@/lib/canvas-export";
import { useI18n } from "@/i18n/I18nProvider";

type DragMode =
  | { kind: "pan"; start: Point; origin: Point }
  | { kind: "node"; ids: string[]; rootIds: string[]; start: Point; origins: Record<string, Point> }
  | { kind: "marquee"; start: Point; current: Point }
  | {
      kind: "resize";
      id: string;
      start: Point;
      origin: NodeRect;
      corner: NodeResizeCorner;
      free: boolean;
    }
  | { kind: "connect"; from: string; current: Point };

export function BoardCanvas() {
  const { t } = useI18n();
  const project = useBoardStore((s) => s.getActive());
	useCanvasGenerationRecovery();
  const configuredChannels = useBoardStore((s) => s.config.channels);
  const sharedChannels = useSharedChannels();
  const generationChannels = useMemo(
    () => mergeSharedChannelChoices(configuredChannels, sharedChannels),
    [configuredChannels, sharedChannels],
  );
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const connectingFrom = useBoardStore((s) => s.connectingFrom);
  const showMinimap = useBoardStore((s) => s.showMinimap);
  const panelCollapsed = useBoardStore((s) => s.config.canvasPanelCollapsed === true);
  const interactionTool = useBoardStore((s) => s.config.canvasInteractionTool ?? "select");
  const setViewport = useBoardStore((s) => s.setViewport);
  const commitViewportRun = useBoardStore((s) => s.commitViewportRun);
  const setSelected = useBoardStore((s) => s.setSelected);
  const toggleSelect = useBoardStore((s) => s.toggleSelect);
  const resizeNode = useBoardStore((s) => s.resizeNode);
  const connect = useBoardStore((s) => s.connect);
  const setConnectingFrom = useBoardStore((s) => s.setConnectingFrom);
  const deleteSelected = useBoardStore((s) => s.deleteSelected);
  const copySelected = useBoardStore((s) => s.copySelected);
  const pasteClipboard = useBoardStore((s) => s.pasteClipboard);
  const captureHistory = useBoardStore((s) => s.captureHistory);
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);
  const selectAll = useBoardStore((s) => s.selectAll);
  const addNode = useBoardStore((s) => s.addNode);
  const insertAsset = useBoardStore((s) => s.insertAsset);
  const configuredPlugins = useBoardStore((s) => s.config.plugins ?? []);
  const disabledPluginIds = useBoardStore((s) => s.config.disabledPluginIds ?? []);
  const installedPlugins = useMemo(
    () => enabledPluginManifests([...BUILTIN_PLUGINS, ...configuredPlugins], disabledPluginIds),
    [configuredPlugins, disabledPluginIds],
  );
  const alignSelected = useBoardStore((s) => s.alignSelected);
  const distributeSelected = useBoardStore((s) => s.distributeSelected);
  const duplicateSelected = useBoardStore((s) => s.duplicateSelected);
  const groupSelected = useBoardStore((s) => s.groupSelected);
  const ungroupSelected = useBoardStore((s) => s.ungroupSelected);
  const deleteEdge = useBoardStore((s) => s.deleteEdge);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const pendingCapturePointerRef = useRef<number | null>(null);
  const interactionActiveRef = useRef(false);
  const touchGestureRef = useRef<GestureState | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const pendingViewportRef = useRef<ReturnType<typeof createGestureState>["viewport"] | null>(null);
  const nodeFrameRef = useRef<number | null>(null);
  const pendingNodeMoveRef = useRef<{
    ids: string[];
    start: Point;
    current: Point;
    origins: Record<string, Point>;
    viewport: { x: number; y: number; k: number };
  } | null>(null);
  const mediaImportQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [drag, setDrag] = useState<DragMode | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const [groupHoverId, setGroupHoverId] = useState<string | null>(null);
  const [assetPicker, setAssetPicker] = useState<{ open: boolean; at: Point | null }>({ open: false, at: null });
  const [exportingSnapshot, setExportingSnapshot] = useState(false);

  const enqueueMediaImport = (operation: () => Promise<void>): Promise<void> => {
    const pending = mediaImportQueueRef.current.then(operation, operation);
    mediaImportQueueRef.current = pending.catch(() => undefined);
    return pending;
  };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current);
      if (nodeFrameRef.current !== null) cancelAnimationFrame(nodeFrameRef.current);
    },
    [],
  );

  const scheduleViewport = useCallback(
    (viewport: { x: number; y: number; k: number }) => {
      pendingViewportRef.current = viewport;
      if (viewportFrameRef.current !== null) return;
      viewportFrameRef.current = requestAnimationFrame(() => {
        viewportFrameRef.current = null;
        const pending = pendingViewportRef.current;
        pendingViewportRef.current = null;
        // No explicit history flag: the store coalesces the frames of one
        // gesture into a single undo step and `commitViewportRun` closes it.
        if (pending) setViewport({ ...pending });
      });
    },
    [setViewport],
  );

  const flushScheduledViewport = useCallback(() => {
    if (viewportFrameRef.current !== null) {
      cancelAnimationFrame(viewportFrameRef.current);
      viewportFrameRef.current = null;
    }
    const pending = pendingViewportRef.current;
    pendingViewportRef.current = null;
    if (pending) setViewport({ ...pending });
  }, [setViewport]);

  const commitScheduledViewport = useCallback(() => {
    flushScheduledViewport();
    commitViewportRun();
  }, [commitViewportRun, flushScheduledViewport]);

  const commitPendingNodeMove = useCallback((reconcileRootIds?: string[]) => {
    if (nodeFrameRef.current !== null) {
      cancelAnimationFrame(nodeFrameRef.current);
      nodeFrameRef.current = null;
    }
    const pending = pendingNodeMoveRef.current;
    pendingNodeMoveRef.current = null;
    if (!pending && !reconcileRootIds) return;
    useBoardStore.getState().updateActive(
      (active) => {
        let movedNodes = active.nodes;
        if (pending) {
          const start = screenToWorld(pending.start, pending.viewport);
          const current = screenToWorld(pending.current, pending.viewport);
          const moveIds = new Set(pending.ids);
          movedNodes = active.nodes.map((node) => {
            const origin = pending.origins[node.id];
            if (!moveIds.has(node.id) || !origin) return node;
            return {
              ...node,
              position: {
                x: origin.x + current.x - start.x,
                y: origin.y + current.y - start.y,
              },
            };
          });
        }
        const nodes = reconcileRootIds
          ? reconcileGroupMembership(movedNodes, reconcileRootIds).nodes
          : movedNodes;
        return { ...active, nodes };
      },
      { history: false },
    );
  }, []);

  const applyCanvasPointerCapture = useCallback((pointerId: number) => {
    const surface = rootRef.current;
    if (!surface) return;
    try {
      if (activePointerIdRef.current !== null && activePointerIdRef.current !== pointerId) {
        surface.releasePointerCapture(activePointerIdRef.current);
      }
    } catch {
      // Capture may already have been released by the browser.
    }
    try {
      surface.setPointerCapture(pointerId);
      activePointerIdRef.current = pointerId;
    } catch {
      activePointerIdRef.current = null;
    }
  }, []);

  // Pointer capture is deferred until the pointer actually moves. Capturing on
  // pointerdown makes browsers retarget the follow-up click/dblclick to the
  // capture element, which swallows node-level interactions such as
  // double-clicking an image to open its preview.
  const captureCanvasPointer = useCallback((pointerId: number) => {
    interactionActiveRef.current = true;
    pendingCapturePointerRef.current = pointerId;
  }, []);

  const releaseCanvasPointer = useCallback((pointerId?: number) => {
    const surface = rootRef.current;
    const activeId = pointerId ?? activePointerIdRef.current;
    pendingCapturePointerRef.current = null;
    if (!surface || activeId === null || activeId === undefined) {
      activePointerIdRef.current = null;
      return;
    }
    try {
      if (surface.hasPointerCapture(activeId)) {
        surface.releasePointerCapture(activeId);
      }
    } catch {
      // Ignore browsers that already cleared capture.
    }
    if (activePointerIdRef.current === activeId) {
      activePointerIdRef.current = null;
    }
  }, []);

  const endDragInteraction = useCallback((pointerId?: number) => {
    interactionActiveRef.current = false;
    if (nodeFrameRef.current !== null) {
      cancelAnimationFrame(nodeFrameRef.current);
      nodeFrameRef.current = null;
    }
    pendingNodeMoveRef.current = null;
    releaseCanvasPointer(pointerId);
    setGroupHoverId(null);
    setDrag(null);
    // A pan or pinch is over, so the next viewport write starts a new undo step
    // instead of merging into the gesture that just finished.
    commitScheduledViewport();
  }, [commitScheduledViewport, releaseCanvasPointer]);

  const exportSnapshot = useCallback(async () => {
    const surface = rootRef.current;
    if (!surface || !project || exportingSnapshot) return;
    setExportingSnapshot(true);
    try {
      const dataUrl = await renderCanvasSnapshot(surface);
      downloadCanvasSnapshot(dataUrl, canvasExportFilename(project.title));
    } catch (error) {
      window.alert(error instanceof Error ? `${t("canvas.export")} ${t("tasks.failed")}：${error.message}` : `${t("canvas.export")} ${t("tasks.failed")}`);
    } finally {
      setExportingSnapshot(false);
    }
  }, [exportingSnapshot, project, t]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.code === "Space") setSpaceDown(true);
      const meta = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (typing) return;

      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
      } else if (meta && e.key.toLowerCase() === "g" && e.shiftKey) {
        e.preventDefault();
        ungroupSelected();
      } else if (meta && e.key.toLowerCase() === "g") {
        e.preventDefault();
        groupSelected();
      } else if (meta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelected();
      } else if (meta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
      } else if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
      } else if (meta && e.key.toLowerCase() === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        void exportSnapshot();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const edgeId = selectedEdgeId;
        if (edgeId) {
          deleteEdge(edgeId);
          setSelectedEdgeId(null);
        } else {
          deleteSelected();
        }
      } else if (e.key === "Escape") {
        setSelected([]);
        setSelectedEdgeId(null);
        setConnectingFrom(null);
        endDragInteraction();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    copySelected,
    deleteEdge,
    deleteSelected,
    duplicateSelected,
    endDragInteraction,
    exportSnapshot,
    pasteClipboard,
    redo,
    selectAll,
    selectedEdgeId,
    setConnectingFrom,
    setSelected,
    undo,
    groupSelected,
    ungroupSelected,
  ]);

  const related = useMemo(() => {
    if (!project || selectedIds.length !== 1) return new Set<string>();
    const id = selectedIds[0];
    const set = new Set<string>([id]);
    for (const e of project.edges) {
      if (e.from === id) set.add(e.to);
      if (e.to === id) set.add(e.from);
    }
    return set;
  }, [project, selectedIds]);

  const nodeById = useMemo(
    () => new Map((project?.nodes ?? []).map((node) => [node.id, node])),
    [project?.nodes],
  );
  const nodeSpatialIndex = useMemo(
    () => createNodeSpatialIndex(project?.nodes ?? []),
    [project?.nodes],
  );
  const visibleWorldRect = useMemo(
    () => project
      ? viewportWorldRect(project.viewport, size.w, size.h)
      : { x: 0, y: 0, w: 0, h: 0 },
    [project, size.h, size.w],
  );
  const visibleNodes = useMemo(
    () =>
      project
        ? nodeSpatialIndex.query(visibleWorldRect)
        : [],
    [nodeSpatialIndex, project, visibleWorldRect],
  );
  const edgeGeometryIndex = useMemo(
    () => createEdgeGeometryIndex(project?.edges ?? [], nodeById),
    [nodeById, project?.edges],
  );
  const visibleEdges = useMemo(
    () => edgeGeometryIndex.intersecting(visibleWorldRect),
    [edgeGeometryIndex, visibleWorldRect],
  );

  const localPoint = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const onWheel = (e: ReactWheelEvent) => {
    if (!project) return;
    e.preventDefault();
    const p = localPoint(e);
    const oldK = project.viewport.k;
    const nextK = clamp(oldK * (e.deltaY > 0 ? 0.9 : 1.1), 0.15, 3);
    const world = screenToWorld(p, project.viewport);
    setViewport({
      k: nextK,
      x: p.x - world.x * nextK,
      y: p.y - world.y * nextK,
    });
  };


  const onPointerDownBackground = (e: ReactPointerEvent) => {
    if (!project) return;
    if (e.target instanceof Element && e.target.closest("[data-canvas-control]")) return;
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;
    const p = localPoint(e);
    captureCanvasPointer(e.pointerId);
    const reverseTool = spaceDown || e.ctrlKey;
    const shouldPan = interactionTool === "pan" ? !reverseTool : reverseTool || e.altKey;
    if (shouldPan) {
      setDrag({
        kind: "pan",
        start: p,
        origin: { ...project.viewport },
      });
      return;
    }
    setConnectingFrom(null);
    setSelected([]);
    setSelectedEdgeId(null);
    setDrag({
      kind: "pan",
      start: p,
      origin: { x: project.viewport.x, y: project.viewport.y },
    });
  };

  const onTouchPointerDownCapture = (e: ReactPointerEvent) => {
    if (!project || e.pointerType !== "touch") return;
    if (e.target instanceof Element && e.target.closest("[data-canvas-control]")) return;
    captureCanvasPointer(e.pointerId);
    const current = touchGestureRef.current ?? createGestureState(project.viewport);
    const next = reduceGesture(current, {
      type: "pointerdown",
      pointerId: e.pointerId,
      point: localPoint(e),
    });
    touchGestureRef.current = next;
    if (next.pointers.length >= 2) setDrag(null);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!interactionActiveRef.current) return;
    if (pendingCapturePointerRef.current !== null) {
      const pending = pendingCapturePointerRef.current;
      pendingCapturePointerRef.current = null;
      applyCanvasPointerCapture(pending);
    }
    if (e.pointerType === "touch" && touchGestureRef.current) {
      const next = reduceGesture(touchGestureRef.current, {
        type: "pointermove",
        pointerId: e.pointerId,
        point: localPoint(e),
      });
      if (drag?.kind === "node" && next.pointers.length === 1) {
        touchGestureRef.current = { ...next, viewport: project?.viewport ?? next.viewport };
      } else {
        touchGestureRef.current = next;
        scheduleViewport(next.viewport);
        return;
      }
    }
    if (!project || !drag) return;
    const p = localPoint(e);
    if (drag.kind === "pan") {
      scheduleViewport({
        ...project.viewport,
        x: drag.origin.x + (p.x - drag.start.x),
        y: drag.origin.y + (p.y - drag.start.y),
      });
    } else if (drag.kind === "node") {
      pendingNodeMoveRef.current = {
        ids: drag.ids,
        start: drag.start,
        current: p,
        origins: drag.origins,
        viewport: project.viewport,
      };
      if (nodeFrameRef.current === null) {
        nodeFrameRef.current = requestAnimationFrame(() => commitPendingNodeMove());
      }
      const start = screenToWorld(drag.start, project.viewport);
      const current = screenToWorld(p, project.viewport);
      const root = drag.rootIds
        .map((id) => nodeById.get(id))
        .find((node) => node?.type !== "group");
      const rootOrigin = root ? drag.origins[root.id] : undefined;
      const candidate = root && rootOrigin
        ? project.nodes.find((node) =>
            node.type === "group" &&
            rootOrigin.x + current.x - start.x <= node.position.x + node.width &&
            rootOrigin.x + current.x - start.x + root.width >= node.position.x &&
            rootOrigin.y + current.y - start.y <= node.position.y + node.height &&
            rootOrigin.y + current.y - start.y + root.height >= node.position.y,
          )
        : undefined;
      setGroupHoverId(candidate?.id ?? null);
    } else if (drag.kind === "marquee") {
      setDrag({ ...drag, current: p });
    } else if (drag.kind === "resize") {
      const worldStart = screenToWorld(drag.start, project.viewport);
      const worldNow = screenToWorld(p, project.viewport);
      const next = resizeFromCorner(
        drag.origin,
        drag.corner,
        { x: worldNow.x - worldStart.x, y: worldNow.y - worldStart.y },
        drag.free,
      );
      resizeNode(drag.id, next.width, next.height, { x: next.x, y: next.y });
    } else if (drag.kind === "connect") {
      setDrag({ ...drag, current: p });
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch" && touchGestureRef.current) {
      const wasMultiTouch = touchGestureRef.current.pointers.length >= 2;
      const next = reduceGesture(touchGestureRef.current, {
        type: "pointerup",
        pointerId: e.pointerId,
      });
      touchGestureRef.current = next.pointers.length ? next : null;
      if (wasMultiTouch || drag?.kind !== "node") {
        scheduleViewport(next.viewport);
        if (drag && drag.kind !== "node") {
          endDragInteraction(e.pointerId);
        } else if (!drag) {
          // A tap without a drag still armed the interaction, so clear the
          // whole interaction state instead of only releasing capture.
          endDragInteraction(e.pointerId);
        }
        return;
      }
    }
    if (!project || !drag) return;
    if (drag.kind === "marquee") {
      const x1 = Math.min(drag.start.x, drag.current.x);
      const y1 = Math.min(drag.start.y, drag.current.y);
      const x2 = Math.max(drag.start.x, drag.current.x);
      const y2 = Math.max(drag.start.y, drag.current.y);
      const world = {
        x: (x1 - project.viewport.x) / project.viewport.k,
        y: (y1 - project.viewport.y) / project.viewport.k,
        w: (x2 - x1) / project.viewport.k,
        h: (y2 - y1) / project.viewport.k,
      };
      const ids = project.nodes
        .filter((n) =>
          rectsIntersect(world, {
            x: n.position.x,
            y: n.position.y,
            w: n.width,
            h: n.height,
          }),
        )
        .map((n) => n.id);
      setSelected(ids);
    } else if (drag.kind === "connect") {
      const releasedAt = localPoint(e);
      const world = screenToWorld(releasedAt, project.viewport);
      const hit = project.nodes.find(
        (n) =>
          n.id !== drag.from &&
          world.x >= n.position.x &&
          world.x <= n.position.x + n.width &&
          world.y >= n.position.y &&
          world.y <= n.position.y + n.height,
      );
      if (hit) {
        connect(drag.from, hit.id);
        setConnectingFrom(null);
      } else {
        const source = project.nodes.find((node) => node.id === drag.from);
        const port = source ? nodePort(source, "right") : null;
        const startedAt = port
          ? {
              x: port.x * project.viewport.k + project.viewport.x,
              y: port.y * project.viewport.k + project.viewport.y,
            }
          : drag.current;
        if (Math.hypot(releasedAt.x - startedAt.x, releasedAt.y - startedAt.y) > 6) {
          setConnectingFrom(null);
        }
      }
    } else if (drag.kind === "node") {
      commitPendingNodeMove(drag.rootIds);
    }
    endDragInteraction(e.pointerId);
  };

  const onPointerCancel = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch" && touchGestureRef.current) {
      const next = reduceGesture(touchGestureRef.current, {
        type: "pointercancel",
        pointerId: e.pointerId,
      });
      touchGestureRef.current = next.pointers.length ? next : null;
      scheduleViewport(next.viewport);
    }
    if (drag?.kind === "node") {
      commitPendingNodeMove(drag.rootIds);
    }
    endDragInteraction(e.pointerId);
  };

  const onLostPointerCapture = (e: ReactPointerEvent) => {
    if (activePointerIdRef.current !== null && activePointerIdRef.current !== e.pointerId) return;
    if (drag?.kind === "node") {
      commitPendingNodeMove(drag.rootIds);
    }
    endDragInteraction(e.pointerId);
  };

  const onDragOverCanvas = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer?.types ?? []);
    const acceptsAsset = types.includes(OPENBOARD_ASSET_DRAG_MIME);
    const acceptsFiles = types.includes("Files");
    if (!acceptsAsset && !acceptsFiles) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = acceptsAsset ? "copy" : e.dataTransfer.dropEffect;
  };

  const onDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!project) return;
    const p = localPoint(e);
    const world = screenToWorld(p, project.viewport);

    const assetId = readOpenBoardAssetDrag(e.dataTransfer);
    if (assetId) {
      const preferred = {
        x: world.x - DEFAULT_NODE_SIZE.image.width / 2,
        y: world.y - DEFAULT_NODE_SIZE.image.height / 2,
      };
      const asset = useBoardStore.getState().assets.find((item) => item.id === assetId);
      const size = asset?.kind === "text"
        ? DEFAULT_NODE_SIZE.text
        : asset?.kind === "video"
          ? DEFAULT_NODE_SIZE.video
          : asset?.kind === "audio"
            ? DEFAULT_NODE_SIZE.audio
            : DEFAULT_NODE_SIZE.image;
      await insertAsset(assetId, findOpenNodePosition(project.nodes, preferred, size));
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    let i = 0;
    for (const file of files) {
      const pos = { x: world.x + i * 30, y: world.y + i * 30 };
      if (file.type.startsWith("image/")) {
        await attachUploadedImage(file, pos);
        i += 1;
      } else if (file.type.startsWith("video/")) {
        await attachUploadedVideo(file, pos);
        i += 1;
      } else if (file.type.startsWith("audio/")) {
        await attachUploadedAudio(file, pos);
        i += 1;
      }
    }
  };

  if (!project) {
    return (
      <div className="grid h-full place-items-center text-[var(--ob-muted)]">
        {t("canvas.projectRequired")}
      </div>
    );
  }

  const bg = backgroundStyle(project.backgroundMode, project.viewport);

  const marquee =
    drag?.kind === "marquee"
      ? {
          left: Math.min(drag.start.x, drag.current.x),
          top: Math.min(drag.start.y, drag.current.y),
          width: Math.abs(drag.current.x - drag.start.x),
          height: Math.abs(drag.current.y - drag.start.y),
        }
      : null;

  const connectPreview =
    drag?.kind === "connect"
      ? edgePath(
          (() => {
            const n = nodeById.get(drag.from)!;
            const pt = nodePort(n, "right");
            return {
              x: pt.x * project.viewport.k + project.viewport.x,
              y: pt.y * project.viewport.k + project.viewport.y,
            };
          })(),
          drag.current,
        )
      : null;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden">
      <CanvasToolbar
        reservePanelToggle={panelCollapsed}
        onAdd={(type) => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          const preferred = {
            x: center.x - 140,
            y: center.y - 100,
          };
          addNode(type, findOpenNodePosition(
            project.nodes,
            preferred,
            DEFAULT_NODE_SIZE[type],
          ));
        }}
        onImportImages={(files) => enqueueMediaImport(async () => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          for (const file of files) {
            const currentNodes = useBoardStore.getState().getActive()?.nodes ?? [];
            await attachUploadedImage(file, findOpenNodePosition(
              currentNodes,
              center,
              DEFAULT_NODE_SIZE.image,
            ));
          }
        })}
        onImportVideos={(files) => enqueueMediaImport(async () => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          for (const file of files) {
            const currentNodes = useBoardStore.getState().getActive()?.nodes ?? [];
            await attachUploadedVideo(file, findOpenNodePosition(
              currentNodes,
              center,
              DEFAULT_NODE_SIZE.video,
            ));
          }
        })}
        onImportAudios={(files) => enqueueMediaImport(async () => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          for (const file of files) {
            const currentNodes = useBoardStore.getState().getActive()?.nodes ?? [];
            await attachUploadedAudio(file, findOpenNodePosition(
              currentNodes,
              center,
              DEFAULT_NODE_SIZE.audio,
            ));
          }
        })}
        onOpenAssets={() => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          setAssetPicker({ open: true, at: center });
        }}
        onFitView={() => {
          const vp = fitViewport(project.nodes, size.w, size.h);
          setViewport(vp);
          // A discrete jump is one undo step on its own, unlike a pan or zoom
          // gesture whose frames merge together.
          commitViewportRun();
        }}
        onExportSnapshot={exportSnapshot}
        exportingSnapshot={exportingSnapshot}
      />
      <div
        ref={rootRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden touch-none",
          spaceDown ? "cursor-grab" : "cursor-default",
        )}
        data-testid="canvas-surface"
        style={{ background: "var(--ob-canvas)", ...bg }}
        onWheel={onWheel}
        onPointerDownCapture={onTouchPointerDownCapture}
        onPointerDown={onPointerDownBackground}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
        onDragOver={onDragOverCanvas}
        onDrop={onDropFiles}
        onContextMenu={(e) => {
          e.preventDefault();
          const p = localPoint(e);
          setMenu({
            screen: { x: e.clientX, y: e.clientY },
            world: screenToWorld(p, project.viewport),
          });
        }}
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return;
          const p = localPoint(e);
          setMenu({
            screen: { x: e.clientX, y: e.clientY },
            world: screenToWorld(p, project.viewport),
          });
        }}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {visibleEdges.map((edge) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            const a = nodePort(from, "right");
            const b = nodePort(to, "left");
            const sa = {
              x: a.x * project.viewport.k + project.viewport.x,
              y: a.y * project.viewport.k + project.viewport.y,
            };
            const sb = {
              x: b.x * project.viewport.k + project.viewport.x,
              y: b.y * project.viewport.k + project.viewport.y,
            };
            const active =
              selectedEdgeId === edge.id ||
              (related.has(edge.from) && related.has(edge.to) && selectedIds.length === 1);
            const d = edgePath(sa, sb);
            return (
              <g key={edge.id}>
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={12}
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    setSelectedEdgeId(edge.id);
                    setSelected([]);
                  }}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation();
                    deleteEdge(edge.id);
                    setSelectedEdgeId(null);
                  }}
                />
                <path
                  d={d}
                  fill="none"
                  stroke={active ? "var(--ob-select)" : "var(--ob-line)"}
                  strokeWidth={active ? 2.5 : 1.5}
                  className="pointer-events-none"
                />
              </g>
            );
          })}
          {connectPreview ? (
            <path
              d={connectPreview}
              fill="none"
              stroke="var(--ob-accent)"
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          ) : null}
        </svg>

        <div
          data-canvas-world
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${project.viewport.x}px, ${project.viewport.y}px) scale(${project.viewport.k})`,
          }}
        >
          {visibleNodes.map((node) => (
            <BoardNodeView
              key={node.id}
              node={node}
              generationChannels={generationChannels}
              selected={selectedIds.includes(node.id)}
              resizing={drag?.kind === "resize" && drag.id === node.id}
              related={related.has(node.id)}
              groupHighlighted={groupHoverId === node.id}
              onSelect={(additive) => toggleSelect(node.id, additive)}
              onDragStart={(client) => {
                if ("pointerId" in client && typeof client.pointerId === "number") {
                  captureCanvasPointer(client.pointerId);
                }
                const p = localPoint(client);
                const reverseTool = spaceDown || ("ctrlKey" in client && client.ctrlKey);
                const shouldPan = interactionTool === "pan" ? !reverseTool : reverseTool;
                if (shouldPan) {
                  setDrag({ kind: "pan", start: p, origin: { ...project.viewport } });
                  return;
                }
                const currentSelectedIds = useBoardStore.getState().selectedIds;
                const selectedForDrag = currentSelectedIds.includes(node.id)
                  ? currentSelectedIds
                  : [node.id];
                const ids = expandGroupedSelection(project.nodes, selectedForDrag);
                if (!currentSelectedIds.includes(node.id)) setSelected([node.id]);
                const origins: Record<string, Point> = {};
                for (const id of ids) {
                  const n = nodeById.get(id);
                  if (n) origins[id] = { ...n.position };
                }
                captureHistory();
                setDrag({ kind: "node", ids, rootIds: selectedForDrag, start: p, origins });
              }}
              onResizeStart={(client, free, corner) => {
                if ("pointerId" in client && typeof client.pointerId === "number") {
                  captureCanvasPointer(client.pointerId);
                }
                const p = localPoint(client);
                captureHistory();
                setDrag({
                  kind: "resize",
                  id: node.id,
                  start: p,
                  origin: { x: node.position.x, y: node.position.y, width: node.width, height: node.height },
                  corner,
                  free,
                });
              }}
              onStartConnect={(client) => {
                if (client && "pointerId" in client && typeof client.pointerId === "number") {
                  captureCanvasPointer(client.pointerId);
                }
                setConnectingFrom(node.id);
                const port = nodePort(node, "right");
                setDrag({
                  kind: "connect",
                  from: node.id,
                  current: {
                    x: port.x * project.viewport.k + project.viewport.x,
                    y: port.y * project.viewport.k + project.viewport.y,
                  },
                });
              }}
              onCompleteConnect={() => {
                if (connectingFrom && connectingFrom !== node.id) {
                  connect(connectingFrom, node.id);
                  setConnectingFrom(null);
                  endDragInteraction();
                }
              }}
              onContextMenu={(e) => {
                const p = localPoint(e);
                setMenu({
                  screen: { x: e.clientX, y: e.clientY },
                  world: screenToWorld(p, project.viewport),
                  nodeId: node.id,
                });
              }}
            />
          ))}
        </div>

        {marquee ? (
          <div
            className="pointer-events-none absolute border border-[var(--ob-select)] bg-[color-mix(in_srgb,var(--ob-select)_15%,transparent)]"
            style={marquee}
          />
        ) : null}

        <ZoomControls
          k={project.viewport.k}
          onChange={(k) => {
            const center = { x: size.w / 2, y: size.h / 2 };
            const currentViewport = useBoardStore.getState().getActive()?.viewport ?? project.viewport;
            const world = screenToWorld(center, currentViewport);
            scheduleViewport({
              k,
              x: center.x - world.x * k,
              y: center.y - world.y * k,
            });
          }}
          onCommit={commitScheduledViewport}
          onReset={() => {
            flushScheduledViewport();
            setViewport({ x: size.w / 2, y: size.h / 2, k: 1 });
            commitViewportRun();
          }}
        />

        {menu ? (
          <ContextMenu
            state={menu}
            multi={selectedIds.length > 1}
            onClose={() => setMenu(null)}
            onAdd={(type, at, pluginId) => {
              if (type === "plugin") {
                const manifest = installedPlugins.find((plugin) => plugin.id === pluginId);
                if (!manifest) return;
                addNode("plugin", at, {
                  title: manifest.name,
                  width: manifest.defaultSize.width,
                  height: manifest.defaultSize.height,
                  metadata: { pluginId: manifest.id, pluginState: {} },
                });
                return;
              }
              addNode(type, at);
            }}
            plugins={installedPlugins}
            onPaste={() => pasteClipboard({ x: 40, y: 40 })}
            onUploadMedia={async (files, at) => {
              for (const file of files) {
                const currentNodes = useBoardStore.getState().getActive()?.nodes ?? [];
                const position = findOpenNodePosition(
                  currentNodes,
                  at,
                  file.type.startsWith("video/")
                    ? DEFAULT_NODE_SIZE.video
                    : file.type.startsWith("audio/")
                      ? DEFAULT_NODE_SIZE.audio
                      : DEFAULT_NODE_SIZE.image,
                );
                if (file.type.startsWith("video/")) {
                  await attachUploadedVideo(file, position);
                } else if (file.type.startsWith("audio/")) {
                  await attachUploadedAudio(file, position);
                } else {
                  await attachUploadedImage(file, position);
                }
              }
            }}
            onOpenAssets={(at) => {
              setAssetPicker({ open: true, at });
            }}
            onDelete={() => {
              if (menu?.nodeId) {
                if (!selectedIds.includes(menu.nodeId)) setSelected([menu.nodeId]);
                // wait state update - use direct ids
                useBoardStore.getState().setSelected(
                  selectedIds.includes(menu.nodeId) ? selectedIds : [menu.nodeId],
                );
                useBoardStore.getState().deleteSelected();
              }
            }}
            onDuplicate={() => {
              if (menu?.nodeId && !selectedIds.includes(menu.nodeId)) {
                setSelected([menu.nodeId]);
              }
              duplicateSelected();
            }}
            onBring={() => {
              if (!project) return;
              const vp = fitViewport(project.nodes, size.w, size.h);
              setViewport(vp);
              commitViewportRun();
            }}
            onAlign={(mode) => alignSelected(mode)}
            onDistribute={(axis) => distributeSelected(axis)}
            canGroup={
              selectedIds.filter(
                (id) => project.nodes.find((node) => node.id === id)?.type !== "group",
              ).length >= 2
            }
            canUngroup={selectedIds.some(
              (id) => project.nodes.find((node) => node.id === id)?.type === "group",
            )}
            onGroup={groupSelected}
            onUngroup={ungroupSelected}
          />
        ) : null}

        <AssetPickerModal
          open={assetPicker.open}
          at={assetPicker.at}
          onClose={() => setAssetPicker({ open: false, at: null })}
        />

        {showMinimap ? (
          <MiniMap
            nodes={project.nodes}
            viewport={project.viewport}
            width={size.w}
            height={size.h}
            onJump={(viewport) => {
              setViewport(viewport);
              commitViewportRun();
            }}
            className={selectedIds.length
              ? "absolute right-3 top-3 z-10 overflow-hidden rounded-md border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-panel)_92%,transparent)] shadow-[var(--ob-shadow)] sm:right-4 sm:top-4 sm:rounded-lg"
              : "absolute bottom-3 right-3 z-10 overflow-hidden rounded-md border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-panel)_92%,transparent)] shadow-[var(--ob-shadow)] sm:bottom-4 sm:right-4 sm:rounded-lg"}
          />
        ) : null}
      </div>
    </div>
  );
}

function backgroundStyle(
  mode: "dots" | "lines" | "blank",
  viewport: { x: number; y: number; k: number },
): React.CSSProperties {
  if (mode === "blank") return {};
  const gap = 24 * viewport.k;
  const ox = viewport.x % gap;
  const oy = viewport.y % gap;
  if (mode === "dots") {
    return {
      backgroundImage: `radial-gradient(circle, var(--ob-grid) 1.2px, transparent 1.3px)`,
      backgroundSize: `${gap}px ${gap}px`,
      backgroundPosition: `${ox}px ${oy}px`,
    };
  }
  return {
    backgroundImage: `
      linear-gradient(var(--ob-grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--ob-grid) 1px, transparent 1px)
    `,
    backgroundSize: `${gap}px ${gap}px`,
    backgroundPosition: `${ox}px ${oy}px`,
  };
}
