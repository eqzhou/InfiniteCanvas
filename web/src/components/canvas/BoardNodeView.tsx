import { lazy, Suspense, useMemo, useRef, useState } from "react";
import type { BoardNode } from "@/types/board";
import { cn } from "@/lib/cn";
import { ProjectCommitRollbackError, useBoardStore } from "@/stores/use-board-store";
import { NodeActions } from "@/components/canvas/NodeActions";
import { NodePromptBar } from "@/components/canvas/NodePromptBar";
import { BatchGroupControls } from "@/components/canvas/BatchGroupControls";
import { PluginNodeFrame } from "@/components/canvas/PluginNodeFrame";
import { ImagePreviewDialog } from "@/components/canvas/ImagePreviewDialog";
import { createDefaultDirectorScene, getDirectorPopulation } from "@/lib/director-scene";
import { createNode } from "@/lib/defaults";
import { NODE_RESIZE_CORNERS, type NodeResizeCorner } from "@/lib/node-resize";
import { findPluginManifest } from "@/plugins/builtins";
import { deleteBlob, uploadMedia } from "@/services/storage";
import {
  getDirectorCaptureOwnerScope,
  type DirectorCapture,
} from "@/services/director-capture-store";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { fitMediaDisplaySize } from "@/lib/geometry";
import { defaultModelForMode } from "@/lib/generation-model";
import { normalizeNodeTitle } from "@/lib/node-format";
import { Clapperboard, Globe2, Image, Film, FolderOpen, Music2, Puzzle, Settings2, Type } from "lucide-react";
import { listDirectorEnvironmentOptions, resolveDirectorPanorama } from "@/lib/director-panorama";

const DirectorDialog = lazy(() => import("@/components/director/DirectorDialog").then((module) => ({
  default: module.DirectorDialog,
})));
const PanoramaNodeCard = lazy(() => import("@/components/canvas/PanoramaNodeCard").then((module) => ({
  default: module.PanoramaNodeCard,
})));

// The image action strip can wrap to two rows and normally extends above the node.
const NODE_ACTIONS_TOP_SAFE_AREA = 180;

function moveInput(order: readonly string[], index: number, offset: -1 | 1): string[] {
  const target = index + offset;
  return order.map((id, current) => {
    if (current === index) return order[target] ?? id;
    if (current === target) return order[index] ?? id;
    return id;
  });
}

type Props = {
  node: BoardNode;
  selected: boolean;
  related: boolean;
  groupHighlighted?: boolean;
  onSelect: (additive: boolean) => void;
  onDragStart: (e: { clientX: number; clientY: number; pointerId?: number }) => void;
  onResizeStart: (
    e: { clientX: number; clientY: number; pointerId?: number },
    free: boolean,
    corner: NodeResizeCorner,
  ) => void;
  onStartConnect: (e?: { pointerId?: number }) => void;
  onCompleteConnect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

export function BoardNodeView({
  node,
  selected,
  related,
  groupHighlighted = false,
  onSelect,
  onDragStart,
  onResizeStart,
  onStartConnect,
  onCompleteConnect,
  onContextMenu,
}: Props) {
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const directorEditStartedRef = useRef(false);
  const updateNode = useBoardStore((s) => s.updateNode);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [directorOpen, setDirectorOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const project = useBoardStore((s) => s.getActive());
  const auth = useOptionalAuth();
  const captureOwnerScope = useMemo(
    () => getDirectorCaptureOwnerScope(auth?.user),
    [auth?.user?.id, auth?.user?.tenantId],
  );
  const directorProjectId = project?.id ?? node.id;
  const config = useBoardStore((s) => s.config);
  const prompts = useBoardStore((s) => s.prompts);
  const installedPlugins = config.plugins ?? [];
  const activeChannel = config.channels.find(
    (channel) => channel.id === config.activeChannelId,
  );
  const pluginManifest = node.type === "plugin"
    ? config.disabledPluginIds?.includes(node.metadata.pluginId ?? "")
      ? undefined
      : findPluginManifest(node.metadata.pluginId, installedPlugins)
    : undefined;
  const Icon =
    node.type === "text"
      ? Type
      : node.type === "image"
        ? Image
        : node.type === "panorama"
          ? Globe2
        : node.type === "director"
          ? Clapperboard
        : node.type === "video"
          ? Film
          : node.type === "audio"
            ? Music2
            : node.type === "group"
              ? FolderOpen
              : node.type === "plugin"
                ? Puzzle
            : Settings2;

  return (
    <div
      data-node-id={node.id}
      data-node-type={node.type}
      data-plugin-id={node.type === "plugin" ? node.metadata.pluginId : undefined}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "ob-node-shell group/node absolute flex flex-col overflow-visible border",
        node.type === "group"
          ? groupHighlighted
            ? "border-solid border-[var(--ob-accent)] bg-[color-mix(in_srgb,var(--ob-accent)_18%,transparent)] ring-2 ring-[color-mix(in_srgb,var(--ob-accent)_35%,transparent)]"
            : "border-dashed bg-[color-mix(in_srgb,var(--ob-accent)_8%,transparent)]"
          : "bg-[var(--ob-node)]",
        selected
          ? "border-[var(--ob-select)] ring-2 ring-[color-mix(in_srgb,var(--ob-select)_40%,transparent)]"
          : related
            ? "border-[var(--ob-accent)] ring-1 ring-[color-mix(in_srgb,var(--ob-accent)_28%,transparent)]"
            : "border-[var(--ob-node-border)]",
      )}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: node.width,
        height: node.height,
        zIndex: node.type === "group" ? 0 : selected ? 10 : 1,
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(e.shiftKey || e.metaKey || e.ctrlKey);
        onDragStart(e);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (node.type === "image" && node.metadata.content) {
          setImagePreviewOpen(true);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e);
      }}
    >
      <div
        data-node-title
        className={cn(
          "absolute bottom-full left-0 mb-1 max-w-full text-xs font-medium text-[var(--ob-ink)] transition-opacity duration-150",
          selected || editingTitle ? "opacity-100" : "opacity-0 group-hover/node:opacity-100",
        )}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setTitleDraft(node.title);
          setEditingTitle(true);
        }}
      >
        {editingTitle ? (
          <input
            autoFocus
            aria-label="节点标题"
            className="w-full min-w-32 rounded border border-[var(--ob-select)] bg-[var(--ob-panel)] px-1.5 py-0.5 outline-none"
            maxLength={500}
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => {
              const title = normalizeNodeTitle(titleDraft);
              if (title) updateNode(node.id, { title });
              setEditingTitle(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const title = normalizeNodeTitle(titleDraft);
                if (title) updateNode(node.id, { title });
                setEditingTitle(false);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setTitleDraft(node.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <span className="block max-w-full truncate" title={node.title}>{node.title}</span>
        )}
      </div>
      <div data-node-header className="flex items-center gap-2 border-b border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_55%,transparent)] px-2 py-1.5 text-xs">
        <Icon size={14} className="text-[var(--ob-accent)]" />
        <span className="ml-auto text-[var(--ob-muted)]">
          {node.metadata.isBatchRoot ? "batch" : node.type}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-b-lg p-2">
        {node.type === "text" ? (
          <div className="flex h-full flex-col gap-1" onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex min-w-0 items-center gap-1">
              <input
                aria-label="文本节点模型"
                className="min-w-0 flex-1 truncate rounded border border-[var(--ob-line)] bg-transparent px-1.5 py-0.5 text-[11px]"
                value={node.metadata.model ?? ""}
                title={node.metadata.model || (activeChannel ? defaultModelForMode(activeChannel, "text") : "继承默认文本模型")}
                placeholder={activeChannel ? defaultModelForMode(activeChannel, "text") : "继承默认文本模型"}
                onChange={(event) => updateNode(node.id, { metadata: { model: event.target.value || undefined } })}
              />
              <select
                aria-label="提示词库"
                className="w-[38%] min-w-[5.5rem] shrink-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5 text-[11px]"
                value=""
                onChange={(event) => {
                  const prompt = prompts.find((item) => item.id === event.target.value);
                  if (prompt) updateNode(node.id, { metadata: { content: prompt.body } });
                }}
              >
                <option value="">提示词库</option>
                {prompts.map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>{prompt.title}</option>
                ))}
              </select>
            </div>
            <textarea
              ref={textEditorRef}
              className="min-h-0 flex-1 resize-none border-0 bg-transparent outline-none"
              style={{ fontSize: node.metadata.fontSize ?? 14 }}
              value={node.metadata.content ?? ""}
              placeholder="写下提示词或说明…"
              onChange={(e) =>
                updateNode(node.id, {
                  metadata: { content: e.target.value },
                })
              }
            />
          </div>
        ) : null}

        {node.type === "image" ? (
          node.metadata.content ? (
            <img
              src={node.metadata.content}
              alt={node.title}
              className="h-full w-full object-contain"
              draggable={false}
              onDoubleClick={(event) => {
                event.stopPropagation();
                setImagePreviewOpen(true);
              }}
            />
          ) : (
            <div className="grid h-full place-items-center text-sm text-[var(--ob-muted)]">
              {node.metadata.status === "loading"
                ? "生成中…"
                : node.metadata.status === "error"
                  ? node.metadata.errorDetails || "生成失败"
                  : "空图片节点"}
            </div>
          )
        ) : null}

        {node.type === "video" ? (
          <div className="flex h-full flex-col gap-2" onPointerDown={(e) => e.stopPropagation()}>
            {node.metadata.content ? (
              <video
                src={node.metadata.content}
                className="min-h-0 flex-1 w-full object-contain"
                controls
              />
            ) : (
              <div className="grid min-h-0 flex-1 place-items-center text-sm text-[var(--ob-muted)]">
                {node.metadata.status === "loading"
                  ? "生成中…"
                  : node.metadata.status === "error"
                    ? node.metadata.errorDetails || "生成失败"
                    : "空视频节点"}
              </div>
            )}
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={Boolean(node.metadata.generateAudio)}
                  onChange={(e) => updateNode(node.id, {
                    metadata: { generateAudio: e.target.checked },
                  })}
                />
                生成声音
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={Boolean(node.metadata.watermark)}
                  onChange={(e) => updateNode(node.id, {
                    metadata: { watermark: e.target.checked },
                  })}
                />
                水印
              </label>
              <label className="col-span-2 flex flex-col gap-1">
                图片参考模式
                <select
                  aria-label="图片参考模式"
                  className="rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5"
                  value={node.metadata.videoFrameMode ?? "references"}
                  onChange={(e) => updateNode(node.id, {
                    metadata: {
                      videoFrameMode: e.target.value === "first-last" ? "first-last" : "references",
                    },
                  })}
                >
                  <option value="references">普通参考图</option>
                  <option value="first-last">首尾帧</option>
                </select>
              </label>
            </div>
          </div>
        ) : null}

        {node.type === "audio" ? (
          node.metadata.content ? (
            <div className="flex h-full flex-col justify-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
              <audio src={node.metadata.content} controls className="w-full" />
              <div className="truncate text-xs text-[var(--ob-muted)]">
                {node.metadata.mimeType ?? "audio"} · {node.metadata.bytes ? `${Math.round(node.metadata.bytes/1024)}KB` : ""}
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-sm text-[var(--ob-muted)]">
			  {node.metadata.status === "loading"
				? "生成中…"
				: node.metadata.status === "error"
					? node.metadata.errorDetails || "生成失败"
					: "空音频节点"}
            </div>
          )
        ) : null}

        {node.type === "config" ? (
          <div
            className="flex h-full flex-col gap-2 overflow-y-auto pr-1 text-xs"
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <label className="flex flex-col gap-1">
              模式
              <select
                className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                value={node.metadata.generationMode ?? "image"}
                onChange={(e) => {
                  const generationMode = e.target.value as "text" | "image" | "video";
                  updateNode(node.id, {
                    metadata: {
                      generationMode,
                      model: activeChannel
                        ? defaultModelForMode(activeChannel, generationMode)
                        : undefined,
                    },
                  });
                }}
              >
                <option value="text">文本</option>
                <option value="image">图片</option>
                <option value="video">视频</option>
              </select>
            </label>
            {(node.metadata.generationMode ?? "image") === "image" ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={Boolean(node.metadata.transparentBackground)}
                  onChange={(event) => updateNode(node.id, {
                    metadata: { transparentBackground: event.target.checked },
                  })}
                />
                透明背景
              </label>
            ) : null}
            <label className="flex min-w-0 flex-col gap-1">
              模型
              <input
                aria-label="配置节点模型"
                className="min-w-0 truncate rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                value={node.metadata.model ?? ""}
                title={node.metadata.model || "继承全局默认"}
                placeholder="继承全局默认"
                onChange={(e) =>
                  updateNode(node.id, { metadata: { model: e.target.value } })
                }
              />
            </label>
            <label className="flex min-h-0 flex-1 flex-col gap-1">
              提示词
              <textarea
                aria-label="配置节点提示词"
                className="min-h-20 flex-1 resize-none rounded border border-[var(--ob-line)] bg-transparent px-2 py-1 leading-relaxed"
                maxLength={100_000}
                placeholder="输入或粘贴多行提示词；空行会被保留"
                value={node.metadata.prompt ?? ""}
                onChange={(event) => updateNode(node.id, {
                  metadata: { prompt: event.target.value },
                })}
              />
            </label>
            <label className="flex flex-col gap-1">
              尺寸 / 比例
              <input
                className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                value={node.metadata.size ?? "1024x1024"}
                onChange={(e) =>
                  updateNode(node.id, { metadata: { size: e.target.value } })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              数量
              <input
                type="number"
                min={1}
                max={8}
                className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                value={node.metadata.count ?? 1}
                onChange={(e) =>
                  updateNode(node.id, {
                    metadata: { count: Number(e.target.value) || 1 },
                  })
                }
              />
            </label>
            {(node.metadata.generationMode ?? "image") === "video" ? (
              <>
                <label className="flex flex-col gap-1">
                  视频比例
                  <select
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={node.metadata.videoRatio ?? "16:9"}
                    onChange={(e) =>
                      updateNode(node.id, { metadata: { videoRatio: e.target.value } })
                    }
                  >
                    {["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  清晰度
                  <select
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={node.metadata.resolution ?? "720p"}
                    onChange={(e) =>
                      updateNode(node.id, { metadata: { resolution: e.target.value } })
                    }
                  >
                    {["480p","720p","1080p"].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  时长(秒)
                  <input
                    type="number"
                    min={4}
                    max={15}
                    disabled={Boolean(node.metadata.smartDuration)}
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={node.metadata.duration ?? 5}
                    onChange={(e) =>
                      updateNode(node.id, {
                        metadata: { duration: Number(e.target.value) || 5 },
                      })
                    }
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(node.metadata.smartDuration)}
                    onChange={(event) => updateNode(node.id, {
                      metadata: { smartDuration: event.target.checked },
                    })}
                  />
                  智能时长
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(node.metadata.generateAudio)}
                    onChange={(e) =>
                      updateNode(node.id, {
                        metadata: { generateAudio: e.target.checked },
                      })
                    }
                  />
                  生成声音
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(node.metadata.watermark)}
                    onChange={(e) =>
                      updateNode(node.id, {
                        metadata: { watermark: e.target.checked },
                      })
                    }
                  />
                  水印
                </label>
                <label className="flex flex-col gap-1">
                  图片参考模式
                  <select
                    aria-label="图片参考模式"
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={node.metadata.videoFrameMode ?? "references"}
                    onChange={(e) =>
                      updateNode(node.id, {
                        metadata: {
                          videoFrameMode: e.target.value === "first-last" ? "first-last" : "references",
                        },
                      })
                    }
                  >
                    <option value="references">普通参考图</option>
                    <option value="first-last">首尾帧</option>
                  </select>
                </label>
                {node.metadata.videoFrameMode === "first-last" ? (
                  <p className="text-[10px] leading-snug text-[var(--ob-muted)]">
                    按上游图片顺序：第 1 张为首帧，第 2 张为尾帧；其余仍作为参考图。
                  </p>
                ) : null}
              </>
            ) : null}
            <div className="rounded border border-[var(--ob-line)] p-1.5">
              <div className="mb-1 font-medium">上游输入</div>
              {(() => {
                if (!project) return <div className="text-[var(--ob-muted)]">无</div>;
                const incoming = project.edges
                  .filter((e) => e.to === node.id)
                  .map((e) => e.from);
                const configured = node.metadata.inputOrder?.filter((id) => incoming.includes(id)) ?? [];
                const order = [...configured, ...incoming.filter((id) => !configured.includes(id))];
                if (!order.length) return <div className="text-[var(--ob-muted)]">暂无上游节点</div>;
                return (
                  <ul className="space-y-1">
                    {order.map((id, idx) => {
                      const n = project.nodes.find((x) => x.id === id);
                      if (!n) return null;
                      return (
                        <li key={id} className="flex items-start gap-1">
                          <div className="min-w-0 flex-1">
                            <div className="truncate">{idx + 1}. {n.type}:{n.title}</div>
                            {n.type === "text" && n.metadata.content ? (
                              <p className="line-clamp-2 text-[10px] text-[var(--ob-muted)]">
                                {n.metadata.content}
                              </p>
                            ) : null}
                            {n.type === "image" && n.metadata.content ? (
                              <img
                                src={n.metadata.content}
                                alt="参考图片"
                                className="mt-1 h-12 w-16 rounded object-contain bg-[var(--ob-canvas)]"
                              />
                            ) : null}
                            {n.type === "video" && n.metadata.content ? (
                              <video
                                src={n.metadata.content}
                                aria-label="参考视频"
                                muted
                                preload="metadata"
                                className="mt-1 h-12 w-20 rounded bg-black object-contain"
                              />
                            ) : null}
                            {n.type === "audio" && n.metadata.content ? (
                              <audio
                                src={n.metadata.content}
                                aria-label="参考音频"
                                controls
                                preload="none"
                                className="mt-1 h-8 w-full max-w-44"
                              />
                            ) : null}
                          </div>
                          <button
                            type="button"
                            aria-label={`上移输入 ${idx + 1}`}
                            className="rounded px-1 hover:bg-[var(--ob-accent-soft)]"
                            disabled={idx === 0}
                            onClick={() => {
                              updateNode(node.id, {
                                metadata: { inputOrder: moveInput(order, idx, -1) },
                              });
                            }}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`下移输入 ${idx + 1}`}
                            className="rounded px-1 hover:bg-[var(--ob-accent-soft)]"
                            disabled={idx === order.length - 1}
                            onClick={() => {
                              updateNode(node.id, {
                                metadata: { inputOrder: moveInput(order, idx, 1) },
                              });
                            }}
                          >
                            ↓
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </div>
            <div className="text-[var(--ob-muted)]">
              状态：{node.metadata.status ?? "idle"}
              {node.metadata.errorDetails
                ? ` — ${node.metadata.errorDetails}`
                : ""}
            </div>
          </div>
        ) : null}

        {node.type === "director" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-slate-950 to-slate-900 text-center" onPointerDown={(event) => event.stopPropagation()}>
            <Clapperboard size={30} className="text-[var(--ob-accent)]" />
            <div>
              <div className="text-sm font-medium">3D 导演台</div>
              <div className="mt-1 text-[11px] text-slate-400">
                {node.metadata.directorScene?.objects.length ?? 0} 个舞台元素 · {node.metadata.directorScene ? getDirectorPopulation(node.metadata.directorScene) : 0} 人 · {node.metadata.directorScene?.cameras.length ?? 1} 个机位
              </div>
            </div>
            <button
              type="button"
              className="rounded-lg bg-[var(--ob-accent)] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:brightness-110"
              onClick={() => {
                directorEditStartedRef.current = false;
                setDirectorOpen(true);
              }}
            >
              打开导演台
            </button>
          </div>
        ) : null}

        {node.type === "panorama" ? (
          <Suspense fallback={<div className="grid h-full place-items-center bg-slate-950 text-xs text-slate-400">正在加载全景节点…</div>}>
            <PanoramaNodeCard node={node} />
          </Suspense>
        ) : null}

        {node.type === "group" ? (
          <div className="grid h-full place-items-center text-xs text-[var(--ob-muted)]">
            {node.metadata.childIds?.length ?? 0} 个节点
          </div>
        ) : null}

        {node.type === "plugin" ? (
          pluginManifest ? (
            <PluginNodeFrame
              key={`${node.id}:${node.metadata.pluginId}:enabled`}
              node={node}
              manifest={pluginManifest}
            />
          ) : (
            <div className="grid h-full place-items-center px-4 text-center text-xs text-[var(--ob-muted)]">
              <div>
                <Puzzle className="mx-auto mb-2" size={22} />
                <p data-testid="plugin-unavailable">插件不可用</p>
                <p className="mt-1 break-all">{node.metadata.pluginId ?? "缺少插件 ID"}</p>
              </div>
            </div>
          )
        ) : null}
      </div>

      {selected && node.type !== "group" && node.type !== "plugin" && node.type !== "director" && node.type !== "panorama" ? (
        <NodeActions
          node={node}
          avoidTopToolbarOverlap={Boolean(project && (
            node.position.y * project.viewport.k + project.viewport.y <= NODE_ACTIONS_TOP_SAFE_AREA
          ))}
          onEditText={node.type === "text" ? () => {
            const editor = textEditorRef.current;
            if (!editor) return;
            editor.focus();
            editor.setSelectionRange(editor.value.length, editor.value.length);
          } : undefined}
        />
      ) : null}
      {selected && node.type !== "config" && node.type !== "group" && node.type !== "plugin" && node.type !== "director" && node.type !== "panorama" ? (
        <NodePromptBar node={node} />
      ) : null}
      {(node.metadata.isBatchRoot || node.metadata.batchRootId) ? (
        <BatchGroupControls node={node} />
      ) : null}
      {selected && node.type === "image" ? (
        <label
          className="absolute -bottom-8 left-0 cursor-pointer rounded border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-0.5 text-[11px]"
          onPointerDown={(e) => e.stopPropagation()}
        >
          替换图片
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void (async () => {
                const uploaded = await uploadMedia(file, "image");
                const display = fitMediaDisplaySize(uploaded.width, uploaded.height);
                updateNode(node.id, {
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
              })();
              e.currentTarget.value = "";
            }}
          />
        </label>
      ) : null}

      {node.type !== "group" ? (
        <>
          <button
            type="button"
            className="ob-port absolute top-1/2 -left-2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--ob-panel)] bg-[var(--ob-port)] shadow-sm"
            title="输入端口"
            onPointerDown={(e) => {
              e.stopPropagation();
              onCompleteConnect();
            }}
            onPointerUp={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="ob-port absolute top-1/2 -right-2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--ob-panel)] bg-[var(--ob-port)] shadow-sm"
            title="输出端口 / 拖出连线"
            onPointerDown={(e) => {
              e.stopPropagation();
              onStartConnect(e);
            }}
            onPointerUp={(e) => e.stopPropagation()}
          />
        </>
      ) : null}

      {node.type === "image" && node.metadata.content ? (
        <ImagePreviewDialog
          open={imagePreviewOpen}
          src={node.metadata.content}
          alt={node.title}
          onClose={() => setImagePreviewOpen(false)}
        />
      ) : null}

      {node.type === "director" ? (
        <Suspense fallback={directorOpen ? <div role="dialog" aria-modal="true" aria-label="正在加载 3D 导演台" className="fixed inset-0 z-[150] grid place-items-center bg-[#111] text-sm text-white">正在加载 3D 导演台…</div> : null}>
          <DirectorDialog
            open={directorOpen}
            ownerScope={captureOwnerScope}
            projectId={directorProjectId}
            directorNodeId={node.id}
            title={node.title}
            scene={node.metadata.directorScene ?? createDefaultDirectorScene()}
            panoramaOptions={(project ? listDirectorEnvironmentOptions(project, node.id) : []).map((candidate) => ({ id: candidate.id, label: candidate.type === "image" ? `${candidate.title}（图片）` : candidate.title, url: candidate.metadata.content! }))}
            activePanoramaId={project ? resolveDirectorPanorama(project, node.id)?.id ?? null : null}
            onPanoramaChange={(panoramaId) => {
              const store = useBoardStore.getState();
              if (!directorEditStartedRef.current) {
                store.captureHistory();
                directorEditStartedRef.current = true;
              }
              store.bindDirectorPanorama(node.id, panoramaId, { history: false });
            }}
            onChange={(directorScene) => {
              if (!directorEditStartedRef.current) {
                useBoardStore.getState().captureHistory();
                directorEditStartedRef.current = true;
              }
              updateNode(node.id, { metadata: { directorScene } }, { history: false });
            }}
            onTransformCommit={(directorScene) => {
              useBoardStore.getState().captureHistory();
              directorEditStartedRef.current = true;
              updateNode(node.id, { metadata: { directorScene } }, { history: false });
            }}
            onModelCommit={(directorScene) => {
              useBoardStore.getState().captureHistory();
              directorEditStartedRef.current = true;
              updateNode(node.id, { metadata: { directorScene } }, { history: false });
            }}
            onClose={() => {
              setDirectorOpen(false);
              void useBoardStore.getState().persistNow();
            }}
            onSendCaptures={async (captures: DirectorCapture[]) => {
              const uploaded: Awaited<ReturnType<typeof uploadMedia>>[] = [];
              try {
                for (const capture of captures) uploaded.push(await uploadMedia(capture.blob, "image"));
              } catch (error) {
                await Promise.all(uploaded.map((item) => deleteBlob("image", item.storageKey).catch(() => undefined)));
                throw error;
              }
              const store = useBoardStore.getState();
              const active = store.getActive();
              const current = active?.nodes.find((item) => item.id === node.id);
              if (!active || active.id !== directorProjectId || !current || current.type !== "director") {
                await Promise.all(uploaded.map((item) => deleteBlob("image", item.storageKey).catch(() => undefined)));
                throw new Error("导演台节点已不存在，无法发送截图");
              }
              const existingBottom = active.nodes
                .filter((item) => item.metadata.derivedFromId === current.id && item.type === "image")
                .reduce((bottom, item) => Math.max(bottom, item.position.y + item.height + 24), current.position.y);
              let cursorY = existingBottom;
              const created = uploaded.map((item, index) => {
                const display = fitMediaDisplaySize(item.width, item.height);
                const capture = captures[index]!;
                const createdNode = createNode("image", {
                  x: current.position.x + current.width + 80,
                  y: cursorY,
                }, {
                  title: `${current.title} · ${capture.cameraName}`,
                  width: display.width,
                  height: display.height,
                  metadata: {
                    content: item.url,
                    storageKey: item.storageKey,
                    naturalWidth: item.width,
                    naturalHeight: item.height,
                    bytes: item.bytes,
                    mimeType: item.mimeType,
                    derivedFromId: current.id,
                    status: "success",
                  },
                });
                cursorY += display.height + 24;
                return createdNode;
              });
              try {
                await store.commitDirectorCaptureNodes(directorProjectId, current.id, created);
              } catch (error) {
                if (!(error instanceof ProjectCommitRollbackError)) {
                  await Promise.all(uploaded.map((item) => deleteBlob("image", item.storageKey).catch(() => undefined)));
                }
                throw error;
              }
              directorEditStartedRef.current = false;
            }}
          />
        </Suspense>
      ) : null}

      {NODE_RESIZE_CORNERS.map((corner) => (
        <div
          key={corner}
          role="presentation"
          data-resize-corner={corner}
          className={cn(
            "absolute h-3.5 w-3.5",
            corner === "nw" ? "left-0 top-0 cursor-nw-resize" :
            corner === "ne" ? "right-0 top-0 cursor-ne-resize" :
            corner === "sw" ? "bottom-0 left-0 cursor-sw-resize" :
            "bottom-0 right-0 cursor-se-resize",
            // Only the south-east corner keeps the classic visual notch so the
            // node chrome stays quiet until the pointer is over a corner.
            corner === "se"
              ? "bg-[linear-gradient(135deg,transparent_50%,var(--ob-muted)_50%)]"
              : "opacity-0 group-hover/node:opacity-100",
          )}
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e, Boolean(node.metadata.freeResize) || node.type !== "image", corner);
          }}
        />
      ))}
    </div>
  );
}
