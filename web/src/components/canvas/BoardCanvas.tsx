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

type DragMode =
  | { kind: "pan"; start: Point; origin: Point }
  | { kind: "node"; ids: string[]; rootIds: string[]; start: Point; origins: Record<string, Point> }
  | { kind: "marquee"; start: Point; current: Point }
  | {
      kind: "resize";
      id: string;
      start: Point;
      originW: number;
      originH: number;
      free: boolean;
    }
  | { kind: "connect"; from: string; current: Point };

export function BoardCanvas() {
  const project = useBoardStore((s) => s.getActive());
  const selectedIds = useBoardStore((s) => s.selectedIds);
  const connectingFrom = useBoardStore((s) => s.connectingFrom);
  const showMinimap = useBoardStore((s) => s.showMinimap);
  const setViewport = useBoardStore((s) => s.setViewport);
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
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [drag, setDrag] = useState<DragMode | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const [groupHoverId, setGroupHoverId] = useState<string | null>(null);
  const [assetPicker, setAssetPicker] = useState<{ open: boolean; at: Point | null }>({ open: false, at: null });

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
        if (pending) setViewport({ ...pending }, false);
      });
    },
    [setViewport],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
        setDrag(null);
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
    setViewport(
      {
        k: nextK,
        x: p.x - world.x * nextK,
        y: p.y - world.y * nextK,
      },
      false,
    );
  };

  const onPointerDownBackground = (e: ReactPointerEvent) => {
    if (!project) return;
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;
    const p = localPoint(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (spaceDown || e.altKey) {
      setDrag({
        kind: "pan",
        start: p,
        origin: { ...project.viewport },
      });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setDrag({ kind: "marquee", start: p, current: p });
      return;
    }
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
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
        nodeFrameRef.current = requestAnimationFrame(() => {
          nodeFrameRef.current = null;
          const pending = pendingNodeMoveRef.current;
          pendingNodeMoveRef.current = null;
          if (!pending) return;
          const start = screenToWorld(pending.start, pending.viewport);
          const current = screenToWorld(pending.current, pending.viewport);
          const moveIds = new Set(pending.ids);
          useBoardStore.getState().updateActive(
            (active) => ({
              ...active,
              nodes: active.nodes.map((node) => {
                const origin = pending.origins[node.id];
                if (!moveIds.has(node.id) || !origin) return node;
                return {
                  ...node,
                  position: {
                    x: origin.x + current.x - start.x,
                    y: origin.y + current.y - start.y,
                  },
                };
              }),
            }),
            { history: false },
          );
        });
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
      let w = drag.originW + (worldNow.x - worldStart.x);
      let h = drag.originH + (worldNow.y - worldStart.y);
      if (!drag.free) {
        const ratio = drag.originW / Math.max(1, drag.originH);
        if (Math.abs(worldNow.x - worldStart.x) > Math.abs(worldNow.y - worldStart.y)) {
          h = w / ratio;
        } else {
          w = h * ratio;
        }
      }
      resizeNode(drag.id, w, h);
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
      const world = screenToWorld(localPoint(e), project.viewport);
      const hit = project.nodes.find(
        (n) =>
          n.id !== drag.from &&
          world.x >= n.position.x &&
          world.x <= n.position.x + n.width &&
          world.y >= n.position.y &&
          world.y <= n.position.y + n.height,
      );
      if (hit) connect(drag.from, hit.id);
      setConnectingFrom(null);
    } else if (drag.kind === "node") {
      const current = useBoardStore.getState().getActive();
      if (current) {
        const reconciled = reconcileGroupMembership(current.nodes, drag.rootIds);
        if (reconciled.changed) {
          useBoardStore.getState().updateActive(
            (active) => ({ ...active, nodes: reconciled.nodes }),
            { history: false },
          );
        }
      }
    }
    setGroupHoverId(null);
    setDrag(null);
  };

  const onPointerCancel = (e: ReactPointerEvent) => {
    if (e.pointerType !== "touch" || !touchGestureRef.current) {
      setDrag(null);
      setGroupHoverId(null);
      return;
    }
    const next = reduceGesture(touchGestureRef.current, {
      type: "pointercancel",
      pointerId: e.pointerId,
    });
    touchGestureRef.current = next.pointers.length ? next : null;
    scheduleViewport(next.viewport);
  };

  const onDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!project) return;
    const files = Array.from(e.dataTransfer.files);
    const p = localPoint(e);
    const world = screenToWorld(p, project.viewport);
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
        请先创建一个画布项目
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
    <div className="relative flex h-full min-h-0 flex-col">
      <CanvasToolbar
        onAdd={(type) => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          addNode(type, {
            x: center.x - 140,
            y: center.y - 100,
          });
        }}
        onImportImages={async (files) => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          for (const [i, file] of files.entries()) {
            await attachUploadedImage(file, {
              x: center.x + i * 24,
              y: center.y + i * 24,
            });
          }
        }}
        onImportVideos={async (files) => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          for (const [i, file] of files.entries()) {
            await attachUploadedVideo(file, {
              x: center.x + i * 24,
              y: center.y + i * 24,
            });
          }
        }}
        onImportAudios={async (files) => {
          const center = screenToWorld(
            { x: size.w / 2, y: size.h / 2 },
            project.viewport,
          );
          for (const [i, file] of files.entries()) {
            await attachUploadedAudio(file, {
              x: center.x + i * 24,
              y: center.y + i * 24,
            });
          }
        }}
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
        }}
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
        onDragOver={(e) => e.preventDefault()}
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
          className="absolute left-0 top-0 origin-top-left"
          style={{
            transform: `translate(${project.viewport.x}px, ${project.viewport.y}px) scale(${project.viewport.k})`,
          }}
        >
          {visibleNodes.map((node) => (
            <BoardNodeView
              key={node.id}
              node={node}
              selected={selectedIds.includes(node.id)}
              related={related.has(node.id)}
              groupHighlighted={groupHoverId === node.id}
              onSelect={(additive) => toggleSelect(node.id, additive)}
              onDragStart={(client) => {
                const p = localPoint(client);
                const selectedForDrag = selectedIds.includes(node.id)
                  ? selectedIds
                  : [node.id];
                const ids = expandGroupedSelection(project.nodes, selectedForDrag);
                if (!selectedIds.includes(node.id)) setSelected([node.id]);
                const origins: Record<string, Point> = {};
                for (const id of ids) {
                  const n = nodeById.get(id);
                  if (n) origins[id] = { ...n.position };
                }
                captureHistory();
                setDrag({ kind: "node", ids, rootIds: selectedForDrag, start: p, origins });
              }}
              onResizeStart={(client, free) => {
                const p = localPoint(client);
                captureHistory();
                setDrag({
                  kind: "resize",
                  id: node.id,
                  start: p,
                  originW: node.width,
                  originH: node.height,
                  free,
                });
              }}
              onStartConnect={() => {
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
            const world = screenToWorld(center, project.viewport);
            setViewport({
              k,
              x: center.x - world.x * k,
              y: center.y - world.y * k,
            });
          }}
          onReset={() => setViewport({ x: size.w / 2, y: size.h / 2, k: 1 })}
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
            onJump={(viewport) => setViewport(viewport)}
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
