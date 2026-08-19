import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AiChannel, BoardNode, Viewport } from "@/types/board";
import { cn } from "@/lib/cn";
import { ProjectCommitRollbackError, useBoardStore } from "@/stores/use-board-store";
import { NodeActions } from "@/components/canvas/NodeActions";
import { NodePromptBar } from "@/components/canvas/NodePromptBar";
import { BatchGroupControls } from "@/components/canvas/BatchGroupControls";
import { AudioNodePlayer } from "@/components/canvas/AudioNodePlayer";
import { PluginNodeFrame } from "@/components/canvas/PluginNodeFrame";
import { ImagePreviewDialog } from "@/components/canvas/ImagePreviewDialog";
import { createDefaultDirectorScene, getDirectorPopulation } from "@/lib/director-scene";
import { createNode } from "@/lib/defaults";
import { NODE_RESIZE_CORNERS, type NodeResizeCorner } from "@/lib/node-resize";
import { findPluginManifest } from "@/plugins/builtins";
import { deleteBlob, uploadMedia } from "@/services/storage";
import { uploadDisplayMedia } from "@/services/media-preview";
import { MediaView } from "@/components/common/MediaView";
import {
  getDirectorCaptureOwnerScope,
  type DirectorCapture,
} from "@/services/director-capture-store";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { toast } from "@/components/common/toast";
import { isModalDialogOpen } from "@/lib/canvas-overlay";
import { setOpenDirectorNodeId } from "@/lib/open-director-node";
import { fitMediaDisplaySize, viewportsEqual } from "@/lib/geometry";
import { defaultModelForMode } from "@/lib/generation-model";
import { normalizeNodeTitle } from "@/lib/node-format";
import {
  imageSizeOptionsFor,
  imageOutputLimitFor,
  imageQualityOptionsFor,
  normalizeImageQualityForProvider,
  optionsWithCurrentValue,
} from "@/lib/image-generation-options";
import {
  normalizeVideoDuration,
  normalizeVideoDurationForProvider,
  normalizeVideoRatioForProvider,
  normalizeVideoResolutionForProvider,
  optionsWithCurrentVideoValue,
  videoDurationOptionsFor,
  videoRatioOptionsFor,
  videoResolutionLabel,
  videoResolutionOptionsFor,
  videoSizeAfterSelectionChange,
  videoSizeForProvider,
} from "@/lib/video-generation-options";
import { resolveImageSizeForAspect } from "@/lib/workbench-preferences";
import { getProvider } from "@/lib/ai-config";
import { Clapperboard, Globe2, Image, Film, FolderOpen, Music2, Puzzle, Settings2, Type, Upload } from "lucide-react";
import { isSphericalDirectorEnvironment, listDirectorEnvironmentOptions, resolveDirectorPanorama } from "@/lib/director-panorama";
import { shouldRenderFloatingNodeActions, shouldRenderNodePromptBar } from "@/lib/node-action-visibility";
import { buildDirectorShotPrompt, directorShotGenerationContext, planDirectorShotGeneration } from "@/lib/director-shot-generation";
import { createImageGenerationMetadata, normalizeImageGenerationForProvider } from "@/lib/image-generation";
import { createServerImageGenerationJob, cancelServerGenerationJob } from "@/services/generation-jobs";
import { uid } from "@/lib/id";
import { useI18n } from "@/i18n/I18nProvider";
import {
  intersectMediaCapabilities,
  type MediaCapability,
  type MediaCapabilityCatalog,
} from "@/services/media-capabilities";

const DirectorDialog = lazy(() => import("@/components/director/DirectorDialog").then((module) => ({
  default: module.DirectorDialog,
})));
const PanoramaNodeCard = lazy(() => import("@/components/canvas/PanoramaNodeCard").then((module) => ({
  default: module.PanoramaNodeCard,
})));

// The image action strip can wrap to two rows and normally extends above the node.
const NODE_ACTIONS_TOP_SAFE_AREA = 180;

export function moveInput(order: readonly string[], index: number, offset: -1 | 1): string[] {
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
  resizing?: boolean;
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
  /** All personal and currently published shared channels, supplied by the canvas once. */
  generationChannels?: readonly AiChannel[];
  mediaCatalog?: MediaCapabilityCatalog | null;
};

export function BoardNodeView({
  node,
  selected,
  resizing = false,
  related,
  groupHighlighted = false,
  onSelect,
  onDragStart,
  onResizeStart,
  onStartConnect,
  onCompleteConnect,
  onContextMenu,
  generationChannels = [],
  mediaCatalog = null,
}: Props) {
  const { t } = useI18n();
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const directorEditStartedRef = useRef(false);
  const viewportBeforeDirectorRef = useRef<Viewport | null>(null);
  const fallbackDirectorSceneRef = useRef<ReturnType<typeof createDefaultDirectorScene> | null>(null);
  if (node.type === "director" && !node.metadata.directorScene && !fallbackDirectorSceneRef.current) {
    fallbackDirectorSceneRef.current = createDefaultDirectorScene();
  }
  const directorScene = node.metadata.directorScene ?? fallbackDirectorSceneRef.current;
  const restoreViewportBeforeDirector = () => {
    const saved = viewportBeforeDirectorRef.current;
    viewportBeforeDirectorRef.current = null;
    const current = useBoardStore.getState().getActive()?.viewport;
    if (saved && current && !viewportsEqual(saved, current)) {
      useBoardStore.getState().setViewport({ ...saved }, false);
    }
  };
  const updateNode = useBoardStore((s) => s.updateNode);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [playingSource, setPlayingSource] = useState<string | null>(null);
  const videoPlaying = playingSource === node.metadata.content;
  const [directorOpen, setDirectorOpen] = useState(false);
  useEffect(() => {
    if (!directorOpen) {
      setOpenDirectorNodeId(null);
      restoreViewportBeforeDirector();
      return;
    }
    setOpenDirectorNodeId(node.id);
  }, [directorOpen, node.id]);
  useEffect(() => () => {
    setOpenDirectorNodeId(null);
    restoreViewportBeforeDirector();
  }, []);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const project = useBoardStore((s) => s.getActive());
  const videoCapabilityMode = useMemo(() => {
    if (!project) return "text_to_video" as const;
    const incoming = new Set(project.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from));
    const hasIncomingMedia = project.nodes.some((candidate) => incoming.has(candidate.id) &&
      (candidate.type === "image" || candidate.type === "video" || candidate.type === "audio") &&
      Boolean(candidate.metadata.storageKey || candidate.metadata.content));
    const hasOwnMedia = (node.type === "image" || node.type === "video" || node.type === "audio") &&
      Boolean(node.metadata.storageKey || node.metadata.content);
    const hasStoredReferences = Boolean(node.metadata.referenceStorageKeys?.length) ||
      Boolean(directorShotGenerationContext(project, node.id)?.referenceStorageKeys.length);
    return hasIncomingMedia || hasOwnMedia || hasStoredReferences ? "image_to_video" as const : "text_to_video" as const;
  }, [node.id, node.metadata.content, node.metadata.referenceStorageKeys, node.metadata.storageKey, node.type, project]);
  const auth = useOptionalAuth();
  const captureOwnerScope = useMemo(
    () => getDirectorCaptureOwnerScope(auth?.user),
    [auth?.user?.id, auth?.user?.tenantId],
  );
  const directorProjectId = project?.id ?? node.id;
  const config = useBoardStore((s) => s.config);
  const prompts = useBoardStore((s) => s.prompts);
  // Provider/model/option derivation depends only on config, the merged
  // generation channels, and a few node.metadata fields — never on
  // node.position or the viewport. Pan/zoom/drag re-render every visible node
  // each rAF frame; memoizing on the real inputs (primitive metadata fields,
  // not the per-frame-replaced `node` object) keeps these option arrays from
  // being rebuilt N times per frame.
  const {
    activeChannel,
    imageChannel,
    imageProvider,
    imageQualityOptions,
    imageSizeOptions,
    imageOutputLimit,
    imageQuality,
    videoProvider,
    videoCapability,
    videoRatioOptions,
    videoResolutionOptions,
    videoDurationOptions,
    videoDuration,
    videoRatio,
    videoResolution,
    videoSize,
    pluginManifest,
  } = useMemo(() => {
    const installedPlugins = config.plugins ?? [];
    const activeChannel = config.channels.find(
      (channel) => channel.id === config.activeChannelId,
    );
    const configuredGenerationChannel = node.metadata.generationChannelId
      ? generationChannels.find((channel) => channel.id === node.metadata.generationChannelId)
      : undefined;
    const activeGenerationChannel = config.activeSharedChannelId
      ? generationChannels.find((channel) => channel.id === config.activeSharedChannelId)
      : activeChannel;
    const imageChannel = configuredGenerationChannel ?? activeGenerationChannel;
    const imageProvider = imageChannel ? getProvider(imageChannel, "image") : undefined;
    const imageModel = node.metadata.model || imageProvider?.model || "";
    const videoProvider = imageChannel ? getProvider(imageChannel, "video") : undefined;
    const videoModel = node.metadata.model || videoProvider?.model || "";
    const videoCapabilityCandidates = mediaCatalog?.models.filter((item) =>
      item.kind === "video" && item.model === videoModel && item.channelId === imageChannel?.id && item.modes.includes(videoCapabilityMode),
    ) ?? [];
    const videoCapability: MediaCapability | undefined = imageChannel?.id === "shared-auto"
      ? intersectMediaCapabilities(mediaCatalog?.models.filter((item) =>
        item.kind === "video" && item.model === videoModel && item.modes.includes(videoCapabilityMode),
      ) ?? [])
      : videoCapabilityCandidates[0];
    const requestedVideoRatio = node.metadata.videoRatio ?? "16:9";
    const requestedVideoResolution = node.metadata.resolution ?? "720p";
    const videoRatio = videoCapability?.ratios.length
      ? videoCapability.ratios.includes(requestedVideoRatio) ? requestedVideoRatio : videoCapability.ratios[0]!
      : normalizeVideoRatioForProvider(requestedVideoRatio, videoProvider?.protocol, videoModel);
    const videoResolution = videoCapability?.resolutions.length
      ? videoCapability.resolutions.includes(requestedVideoResolution) ? requestedVideoResolution : videoCapability.resolutions[0]!
      : normalizeVideoResolutionForProvider(requestedVideoResolution, videoProvider?.protocol, videoModel);
    const videoDurationOptions = videoCapability?.durations.length
      ? videoCapability.durations
      : videoDurationOptionsFor(videoProvider?.protocol, videoModel);
    const videoDuration = videoCapability?.durations.length
      ? normalizeVideoDuration(node.metadata.duration ?? 5, videoCapability.durations)
      : normalizeVideoDurationForProvider(node.metadata.duration ?? 5, videoProvider?.protocol, videoModel);
    return {
      activeChannel,
      imageChannel,
      imageProvider,
      imageQualityOptions: imageQualityOptionsFor(imageProvider?.protocol, imageModel),
      imageSizeOptions: imageSizeOptionsFor(imageProvider?.protocol, imageModel),
      imageOutputLimit: imageOutputLimitFor(imageProvider?.protocol, imageModel),
      imageQuality: normalizeImageQualityForProvider(
        node.metadata.quality ?? config.imageQuality,
        imageProvider?.protocol,
        imageModel,
      ),
      videoProvider,
      videoCapability,
      videoRatioOptions: videoCapability?.ratios.length
        ? videoCapability.ratios.map((value) => ({ value, label: value }))
        : videoRatioOptionsFor(videoProvider?.protocol, videoModel),
      videoResolutionOptions: videoCapability?.resolutions.length
        ? videoCapability.resolutions.map((value) => ({ value, label: `${videoResolutionLabel(value)} 分辨率` }))
        : videoResolutionOptionsFor(videoProvider?.protocol, videoModel),
      videoDurationOptions,
      videoDuration,
      videoRatio,
      videoResolution,
      videoSize: videoSizeForProvider(videoProvider?.protocol, videoRatio, videoResolution),
      pluginManifest: node.type === "plugin"
        ? config.disabledPluginIds?.includes(node.metadata.pluginId ?? "")
          ? undefined
          : findPluginManifest(node.metadata.pluginId, installedPlugins)
        : undefined,
    };
  }, [
    config,
    generationChannels,
    mediaCatalog,
    videoCapabilityMode,
    node.type,
    node.metadata.generationChannelId,
    node.metadata.model,
    node.metadata.quality,
    node.metadata.videoRatio,
    node.metadata.resolution,
    node.metadata.duration,
    node.metadata.pluginId,
  ]);
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
  const importImageIntoNode = (file: File) => {
    void (async () => {
      const uploaded = await uploadDisplayMedia(file, "image", { validateLargeImage: true });
      const display = fitMediaDisplaySize(uploaded.width, uploaded.height);
      updateNode(node.id, {
        metadata: {
          content: uploaded.url,
          storageKey: uploaded.storageKey,
          thumbnailStorageKey: uploaded.thumbnailStorageKey,
          thumbnailUrl: uploaded.thumbnailUrl,
          naturalWidth: uploaded.width,
          naturalHeight: uploaded.height,
          bytes: uploaded.bytes,
          mimeType: uploaded.mimeType,
          status: "success",
        },
        width: display.width,
        height: display.height,
      });
    })().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : t("canvasNodes.imageImportFailed"));
    });
  };

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
        if (isModalDialogOpen()) return;
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
            data-canvas-control
            aria-label={t("canvasNodes.nodeTitle")}
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
                aria-label={t("canvasNodes.textModel")}
                className="min-w-0 flex-1 truncate rounded border border-[var(--ob-line)] bg-transparent px-1.5 py-0.5 text-[11px]"
                value={node.metadata.model ?? ""}
                title={node.metadata.model || (activeChannel ? defaultModelForMode(activeChannel, "text") : t("canvasNodes.inheritTextModel"))}
                placeholder={activeChannel ? defaultModelForMode(activeChannel, "text") : t("canvasNodes.inheritTextModel")}
                onChange={(event) => updateNode(node.id, { metadata: { model: event.target.value || undefined } })}
              />
              <select
                aria-label={t("canvasNodes.reasoningEffort")}
                title={t("canvasNodes.reasoningEffort")}
                className="w-[4.5rem] shrink-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5 text-[11px]"
                value={node.metadata.reasoningEffort ?? ""}
                onChange={(event) => updateNode(node.id, {
                  metadata: {
                    reasoningEffort: event.target.value === "low" ||
                      event.target.value === "medium" ||
                      event.target.value === "high"
                      ? event.target.value
                      : undefined,
                  },
                })}
              >
                <option value="">{t("canvasNodes.default")}</option>
                <option value="low">{t("canvasNodes.low")}</option>
                <option value="medium">{t("canvasNodes.medium")}</option>
                <option value="high">{t("canvasNodes.high")}</option>
              </select>
              <select
                aria-label={t("canvasNodes.promptLibrary")}
                className="w-[32%] min-w-[4.5rem] shrink-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5 text-[11px]"
                value=""
                onChange={(event) => {
                  const prompt = prompts.find((item) => item.id === event.target.value);
                  if (prompt) updateNode(node.id, { metadata: { content: prompt.body } });
                }}
              >
                <option value="">{t("canvasNodes.promptLibrary")}</option>
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
              placeholder={t("canvasNodes.nodePromptPlaceholder")}
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
            <div className="relative h-full w-full">
              <img
                src={node.metadata.content}
                alt={node.title}
                className="h-full w-full object-contain"
                draggable={false}
                decoding="async"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setImagePreviewOpen(true);
                }}
              />
              {node.metadata.status !== "loading" ? (
                <label
                  aria-label={t("canvasNodes.replaceImage")}
                  title={t("canvasNodes.replaceImage")}
                  className="absolute bottom-2 left-2 inline-flex cursor-pointer items-center gap-1.5 rounded border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-panel)_88%,transparent)] px-2 py-1 text-[11px] text-[var(--ob-ink)] shadow-sm backdrop-blur-sm"
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  <Upload size={13} />
                  {t("canvasNodes.replaceImage")}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    aria-label={t("canvasNodes.replaceImage")}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) importImageIntoNode(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              ) : null}
            </div>
          ) : (
            <div
              className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--ob-muted)]"
              onPointerDown={(event) => event.stopPropagation()}
            >
              {node.metadata.status === "loading" ? (
                t("canvasNodes.generatingEllipsis")
              ) : node.metadata.status === "error" ? (
                <span className="max-w-[90%] break-words text-center">
                  {node.metadata.errorDetails || t("canvasNodes.generationFailed")}
                </span>
              ) : null}
              {node.metadata.status !== "loading" ? (
                <label
                  aria-label={t("canvasNodes.uploadImage")}
                  className="ob-btn inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs"
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <Upload size={14} />
                  {t("canvasNodes.uploadImage")}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    aria-label={t("canvasNodes.uploadImage")}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) importImageIntoNode(file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
              ) : null}
            </div>
          )
        ) : null}

        {node.type === "video" ? (
          <div className="flex h-full flex-col gap-2" onPointerDown={(e) => e.stopPropagation()}>
            {node.metadata.content ? (
              videoPlaying ? (
                <MediaView
                  kind="video"
                  src={node.metadata.content}
                  previewSrc={node.metadata.thumbnailUrl}
                  alt={node.title}
                  fit="contain"
                  controls
                  autoPlay
                  className="min-h-0 flex-1 w-full object-contain"
                />
              ) : (
                <button
                  type="button"
                  data-canvas-control
                  className="relative min-h-0 flex-1 overflow-hidden"
                  aria-label={t("canvasNodes.playVideo")}
                  onClick={() => setPlayingSource(node.metadata.content ?? null)}
                >
                  <MediaView
                    kind="video"
                    src={node.metadata.content}
                    previewSrc={node.metadata.thumbnailUrl}
                    alt={node.title}
                    fit="contain"
                    className="h-full w-full object-contain"
                  />
                  <span className="pointer-events-none absolute inset-0 grid place-items-center">
                    <span className="rounded-full bg-black/65 px-3 py-1 text-xs text-white">
                      {t("canvasNodes.playVideo")}
                    </span>
                  </span>
                </button>
              )
            ) : (
              <div className="grid min-h-0 flex-1 place-items-center text-sm text-[var(--ob-muted)]">
                {node.metadata.status === "loading"
                  ? t("canvasNodes.generatingEllipsis")
                  : node.metadata.status === "error"
                    ? node.metadata.errorDetails || t("canvasNodes.generationFailed")
                    : t("canvasNodes.emptyVideo")}
              </div>
            )}
            {selected ? (
              <div
                data-canvas-control
                className="grid grid-cols-3 gap-1 rounded-md border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-panel)_88%,transparent)] p-1.5 text-[10px] shadow-sm backdrop-blur-sm"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <label className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">{t("canvasNodes.videoRatio")}</span>
                  <select
                    aria-label={t("canvasNodes.videoRatio")}
                    className="min-w-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5"
                    value={videoRatio}
                    onChange={(event) => {
                      const nextRatio = event.target.value;
                      updateNode(node.id, {
                        metadata: {
                          videoRatio: nextRatio,
                          size: videoSizeAfterSelectionChange(
                            videoProvider?.protocol,
                            node.metadata.size,
                            videoRatio,
                            videoResolution,
                            nextRatio,
                            videoResolution,
                          ),
                        },
                      });
                    }}
                  >
                    {optionsWithCurrentVideoValue(videoRatioOptions, videoRatio).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">{t("canvasNodes.resolution")}</span>
                  <select
                    aria-label={t("canvasNodes.resolution")}
                    className="min-w-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5"
                    value={videoResolution}
                    onChange={(event) => {
                      const nextResolution = event.target.value;
                      updateNode(node.id, {
                        metadata: {
                          resolution: nextResolution,
                          size: videoSizeAfterSelectionChange(
                            videoProvider?.protocol,
                            node.metadata.size,
                            videoRatio,
                            videoResolution,
                            videoRatio,
                            nextResolution,
                          ),
                        },
                      });
                    }}
                  >
                    {optionsWithCurrentVideoValue(videoResolutionOptions, videoResolution).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">{t("canvasNodes.durationSeconds")}</span>
                  {videoDurationOptions.length ? (
                    <select
                      aria-label={t("canvasNodes.durationSeconds")}
                      className="min-w-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5"
                      value={videoDuration}
                      onChange={(event) => updateNode(node.id, {
                        metadata: { duration: Number(event.target.value) },
                      })}
                    >
                      {videoDurationOptions.map((value) => (
                        <option key={value} value={value}>
                          {t("workbench.secondsValue", { seconds: value })}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={t("canvasNodes.durationSeconds")}
                      type="number"
                      min={4}
                      max={15}
                      disabled={Boolean(node.metadata.smartDuration)}
                      className="min-w-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5"
                      value={videoDuration}
                      onChange={(event) => updateNode(node.id, {
                        metadata: { duration: Number(event.target.value) || 5 },
                      })}
                    />
                  )}
                </label>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={Boolean(node.metadata.generateAudio)}
                  onChange={(e) => updateNode(node.id, {
                    metadata: { generateAudio: e.target.checked },
                  })}
                />
                {t("canvasNodes.generateAudio")}
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={Boolean(node.metadata.watermark)}
                  onChange={(e) => updateNode(node.id, {
                    metadata: { watermark: e.target.checked },
                  })}
                />
                {t("canvasNodes.watermark")}
              </label>
              <label className="col-span-2 flex flex-col gap-1">
                {t("canvasNodes.referenceMode")}
                <select
                  aria-label={t("canvasNodes.referenceMode")}
                  className="rounded border border-[var(--ob-line)] bg-transparent px-1 py-0.5"
                  value={node.metadata.videoFrameMode ?? "references"}
                  onChange={(e) => updateNode(node.id, {
                    metadata: {
                      videoFrameMode: e.target.value === "first-last" ? "first-last" : "references",
                    },
                  })}
                >
                  <option value="references">{t("canvasNodes.references")}</option>
                  <option value="first-last">{t("canvasNodes.firstLast")}</option>
                </select>
              </label>
            </div>
          </div>
        ) : null}

        {node.type === "audio" ? (
          node.metadata.content ? (
            <div className="flex h-full flex-col justify-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
              <AudioNodePlayer src={node.metadata.content} />
              <div className="truncate text-xs text-[var(--ob-muted)]">
                {node.metadata.mimeType ?? "audio"} · {node.metadata.bytes ? `${Math.round(node.metadata.bytes/1024)}KB` : ""}
              </div>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-sm text-[var(--ob-muted)]">
			  {node.metadata.status === "loading"
				? t("canvasNodes.generatingEllipsis")
				: node.metadata.status === "error"
					? node.metadata.errorDetails || t("canvasNodes.generationFailed")
					: t("canvasNodes.emptyAudio")}
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
              {t("canvasNodes.mode")}
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
                <option value="text">{t("canvasNodes.text")}</option>
                <option value="image">{t("canvasNodes.image")}</option>
                <option value="video">{t("canvasNodes.video")}</option>
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
                {t("canvasNodes.transparentBackground")}
              </label>
            ) : null}
            <label className="flex min-w-0 flex-col gap-1">
              {t("canvasNodes.model")}
              <input
                aria-label={t("canvasNodes.configModel")}
                className="min-w-0 truncate rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                value={node.metadata.model ?? ""}
                title={node.metadata.model || t("canvasNodes.inheritGlobal")}
                placeholder={t("canvasNodes.inheritGlobal")}
                onChange={(e) =>
                  updateNode(node.id, { metadata: { model: e.target.value } })
                }
              />
            </label>
            {(node.metadata.generationMode ?? "image") === "text" ? (
              <label className="flex flex-col gap-1">
                {t("canvasNodes.reasoningEffort")}
                <select
                  aria-label={t("canvasNodes.configReasoning")}
                  className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                  value={node.metadata.reasoningEffort ?? ""}
                  onChange={(event) => updateNode(node.id, {
                    metadata: {
                      reasoningEffort: event.target.value === "low" ||
                        event.target.value === "medium" ||
                        event.target.value === "high"
                        ? event.target.value
                        : undefined,
                    },
                  })}
                >
                  <option value="">{t("canvasNodes.followModel")}</option>
                  <option value="low">{t("canvasNodes.low")}</option>
                  <option value="medium">{t("canvasNodes.medium")}</option>
                  <option value="high">{t("canvasNodes.high")}</option>
                </select>
              </label>
            ) : null}
            <label className="flex min-h-0 flex-1 flex-col gap-1">
              {t("canvasNodes.prompt")}
              <textarea
                aria-label={t("canvasNodes.configPrompt")}
                className="min-h-20 flex-1 resize-none rounded border border-[var(--ob-line)] bg-transparent px-2 py-1 leading-relaxed"
                maxLength={100_000}
                placeholder={t("canvasNodes.configPromptPlaceholder")}
                value={node.metadata.prompt ?? ""}
                onChange={(event) => updateNode(node.id, {
                  metadata: { prompt: event.target.value },
                })}
              />
            </label>
            {(node.metadata.generationMode ?? "image") === "image" ? (
              <>
                <label className="flex flex-col gap-1">
                  {t("canvasNodes.sizeRatio")}
                  <select
                    aria-label={t("canvasNodes.imageSize")}
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={node.metadata.size ?? "1024x1024"}
                    onChange={(event) => updateNode(node.id, {
                      metadata: { size: event.target.value },
                    })}
                  >
                    {optionsWithCurrentValue(
                      imageSizeOptions,
                      node.metadata.size ?? "1024x1024",
                    ).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {!imageSizeOptions.some((option) => option.value === (node.metadata.size ?? "1024x1024")) ? (
                  <label className="flex flex-col gap-1">
                    {t("canvasNodes.customSize")}
                    <input
                      aria-label={t("canvasNodes.customImageSize")}
                      className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                      value={node.metadata.size ?? "1024x1024"}
                      onChange={(event) => updateNode(node.id, {
                        metadata: { size: event.target.value },
                      })}
                    />
                  </label>
                ) : null}
                <label className="flex flex-col gap-1">
                  {t("canvasNodes.imageQuality")}
                  <select
                    aria-label={t("canvasNodes.configImageQuality")}
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={imageQuality}
                    onChange={(event) => updateNode(node.id, {
                      metadata: { quality: event.target.value },
                    })}
                  >
                    {optionsWithCurrentValue(
                      imageQualityOptions,
                      imageQuality,
                    ).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
            <label className="flex flex-col gap-1">
              {t("canvasNodes.count")}
              <input
                type="number"
                min={1}
                max={(node.metadata.generationMode ?? "image") === "image" ? imageOutputLimit : 8}
                className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                value={node.metadata.count ?? 1}
                onChange={(e) =>
                  updateNode(node.id, {
                    metadata: {
                      count: Math.min(
                        (node.metadata.generationMode ?? "image") === "image" ? imageOutputLimit : 8,
                        Math.max(1, Number(e.target.value) || 1),
                      ),
                    },
                  })
                }
              />
            </label>
            {(node.metadata.generationMode ?? "image") === "video" ? (
              <>
                <label className="flex flex-col gap-1">
                  {t("canvasNodes.autoSize")}
                  <input
                    aria-label={t("canvasNodes.videoSize")}
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={node.metadata.size || videoSize}
                    placeholder={t("canvasNodes.videoSizePlaceholder")}
                    onChange={(event) => updateNode(node.id, {
                      metadata: { size: event.target.value },
                    })}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {t("canvasNodes.videoRatio")}
                  <select
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={videoRatio}
                    onChange={(e) =>
                      updateNode(node.id, {
                        metadata: {
                          videoRatio: e.target.value,
                          size: videoSizeAfterSelectionChange(
                            videoProvider?.protocol,
                            node.metadata.size,
                            videoRatio,
                            videoResolution,
                            e.target.value,
                            videoResolution,
                          ),
                        },
                      })
                    }
                  >
                    {optionsWithCurrentVideoValue(videoRatioOptions, videoRatio).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  {t("canvasNodes.resolution")}
                  <select
                    className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                    value={videoResolution}
                    onChange={(e) =>
                      updateNode(node.id, {
                        metadata: {
                          resolution: e.target.value,
                          size: videoSizeAfterSelectionChange(
                            videoProvider?.protocol,
                            node.metadata.size,
                            videoRatio,
                            videoResolution,
                            videoRatio,
                            e.target.value,
                          ),
                        },
                      })
                    }
                  >
                    {optionsWithCurrentVideoValue(videoResolutionOptions, videoResolution).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  {t("canvasNodes.durationSeconds")}
                  {videoDurationOptions.length ? (
                    <select
                      aria-label={t("canvasNodes.durationSeconds")}
                      className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1"
                      value={videoDuration}
                      onChange={(event) => updateNode(node.id, { metadata: { duration: Number(event.target.value) } })}
                    >
                      {videoDurationOptions.map((value) => (
                        <option key={value} value={value}>
                          {t("workbench.secondsValue", { seconds: value })}
                        </option>
                      ))}
                    </select>
                  ) : (
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
                  )}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={videoDurationOptions.length > 0}
                    checked={videoDurationOptions.length === 0 && Boolean(node.metadata.smartDuration)}
                    onChange={(event) => updateNode(node.id, {
                      metadata: { smartDuration: event.target.checked },
                    })}
                  />
                  {t("canvasNodes.smartDuration")}
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
                  {t("canvasNodes.generateAudio")}
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
                  {t("canvasNodes.watermark")}
                </label>
                <label className="flex flex-col gap-1">
                  {t("canvasNodes.referenceMode")}
                  <select
                    aria-label={t("canvasNodes.referenceMode")}
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
                    <option value="references">{t("canvasNodes.references")}</option>
                    <option value="first-last">{t("canvasNodes.firstLast")}</option>
                  </select>
                </label>
                {node.metadata.videoFrameMode === "first-last" ? (
                  <p className="text-[10px] leading-snug text-[var(--ob-muted)]">
                    {t("canvasNodes.firstLastHint")}
                  </p>
                ) : null}
              </>
            ) : null}
            <div className="rounded border border-[var(--ob-line)] p-1.5">
              <div className="mb-1 font-medium">{t("canvasNodes.upstreamInputs")}</div>
              {(() => {
                if (!project) return <div className="text-[var(--ob-muted)]">{t("canvasNodes.none")}</div>;
                const incoming = project.edges
                  .filter((e) => e.to === node.id)
                  .map((e) => e.from);
                const configured = node.metadata.inputOrder?.filter((id) => incoming.includes(id)) ?? [];
                const order = [...configured, ...incoming.filter((id) => !configured.includes(id))];
                if (!order.length) return <div className="text-[var(--ob-muted)]">{t("canvasNodes.noUpstream")}</div>;
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
                            {n.type === "image" && (n.metadata.thumbnailUrl || n.metadata.content) ? (
                              <MediaView
                                kind="image"
                                src={n.metadata.content}
                                previewSrc={n.metadata.thumbnailUrl}
                                alt={t("canvasNodes.referenceImage")}
                                fit="contain"
                                className="mt-1 h-12 w-16 rounded object-contain bg-[var(--ob-canvas)]"
                              />
                            ) : null}
                            {n.type === "video" && (n.metadata.thumbnailUrl || n.metadata.content) ? (
                              <MediaView
                                kind="video"
                                src={n.metadata.content}
                                previewSrc={n.metadata.thumbnailUrl}
                                alt={t("canvasNodes.referenceVideo")}
                                fit="contain"
                                className="mt-1 h-12 w-20 rounded bg-black object-contain"
                              />
                            ) : null}
                            {n.type === "audio" && n.metadata.content ? (
                              <audio
                                src={n.metadata.content}
                                aria-label={t("canvasNodes.referenceAudio")}
                                controls
                                preload="none"
                                className="mt-1 h-8 w-full max-w-44"
                              />
                            ) : null}
                          </div>
                          <button
                            type="button"
                            aria-label={t("canvasNodes.moveInputUp", { index: idx + 1 })}
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
                            aria-label={t("canvasNodes.moveInputDown", { index: idx + 1 })}
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
            <NodeActions node={node} inlineConfigOnly videoCapability={videoCapability} mediaCatalog={mediaCatalog} />
            <div className="text-[var(--ob-muted)]">
              {t("canvasNodes.status", { status: node.metadata.status ?? "idle" })}
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
              <div className="text-sm font-medium">{t("canvasNodes.director")}</div>
              <div className="mt-1 text-[11px] text-slate-400">
                {t("canvasNodes.directorStats", {
                  objects: node.metadata.directorScene?.objects.length ?? 0,
                  people: node.metadata.directorScene ? getDirectorPopulation(node.metadata.directorScene) : 0,
                  cameras: node.metadata.directorScene?.cameras.length ?? 1,
                })}
              </div>
            </div>
            <button
              type="button"
              className="rounded-lg bg-[var(--ob-accent)] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:brightness-110"
              onClick={() => {
                directorEditStartedRef.current = false;
                const viewport = useBoardStore.getState().getActive()?.viewport;
                viewportBeforeDirectorRef.current = viewport ? { ...viewport } : null;
                setOpenDirectorNodeId(node.id);
                setDirectorOpen(true);
              }}
            >
              {t("canvasNodes.openDirector")}
            </button>
          </div>
        ) : null}

        {node.type === "panorama" ? (
          <Suspense fallback={<div className="grid h-full place-items-center bg-slate-950 text-xs text-slate-400">{t("canvasNodes.loadingPanorama")}</div>}>
            <PanoramaNodeCard node={node} />
          </Suspense>
        ) : null}

        {node.type === "group" ? (
          <div className="grid h-full place-items-center text-xs text-[var(--ob-muted)]">
            {t("canvasNodes.nodeCount", { count: node.metadata.childIds?.length ?? 0 })}
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
                <p data-testid="plugin-unavailable">{t("canvasNodes.pluginUnavailable")}</p>
                <p className="mt-1 break-all">{node.metadata.pluginId ?? t("canvasNodes.pluginIdMissing")}</p>
              </div>
            </div>
          )
        ) : null}
      </div>

      {shouldRenderFloatingNodeActions(node.type, selected, resizing) ? (
        <NodeActions
          node={node}
          videoCapability={videoCapability}
          mediaCatalog={mediaCatalog}
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
      {shouldRenderNodePromptBar(selected, resizing) && node.type !== "config" && node.type !== "group" && node.type !== "plugin" && node.type !== "director" && node.type !== "panorama" ? (
        <NodePromptBar node={node} videoCapability={videoCapability} mediaCatalog={mediaCatalog} />
      ) : null}
      {(node.metadata.isBatchRoot || node.metadata.batchRootId) ? (
        <BatchGroupControls node={node} />
      ) : null}
      {node.type !== "group" ? (
        <>
          <button
            type="button"
            className="ob-port absolute top-1/2 -left-2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--ob-panel)] bg-[var(--ob-port)] shadow-sm"
            data-canvas-control
            title={t("canvasNodes.inputPort")}
            onPointerDown={(e) => {
              e.stopPropagation();
              onCompleteConnect();
            }}
            onPointerUp={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="ob-port absolute top-1/2 -right-2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--ob-panel)] bg-[var(--ob-port)] shadow-sm"
            data-canvas-control
            title={t("canvasNodes.outputPort")}
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
        <Suspense fallback={directorOpen && typeof document !== "undefined" ? createPortal(<div role="dialog" aria-modal="true" aria-label={t("canvasNodes.loadingDirector")} className="fixed inset-0 z-[150] grid place-items-center bg-[#111] text-sm text-white" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>{t("canvasNodes.loadingDirectorEllipsis")}</div>, document.body) : null}>
          <DirectorDialog
            open={directorOpen}
            ownerScope={captureOwnerScope}
            projectId={directorProjectId}
            directorNodeId={node.id}
            title={node.title}
            scene={directorScene ?? createDefaultDirectorScene()}
            panoramaOptions={(project ? listDirectorEnvironmentOptions(project, node.id) : []).map((candidate) => ({
              id: candidate.id,
              label: `${candidate.title} (${isSphericalDirectorEnvironment(candidate) ? t("canvasNodes.sphericalPanorama") : t("canvasNodes.flatBackground")})`,
              url: candidate.metadata.content!,
              spherical: isSphericalDirectorEnvironment(candidate),
            }))}
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
              setOpenDirectorNodeId(null);
              restoreViewportBeforeDirector();
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
                throw new Error(t("canvasNodes.directorNodeMissing"));
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
            onGenerateCapture={async (capture: DirectorCapture) => {
              if (!capture.shot) throw new Error(t("canvasNodes.oldCaptureMissingShot"));
              if (!imageChannel || !imageProvider?.model) throw new Error(t("canvasNodes.imageChannelModelRequired"));
              const serverProtocolSupported = imageProvider.protocol === "openai" || imageProvider.protocol === "gemini" ||
                (imageProvider.protocol === "template" && Boolean(imageProvider.template)) ||
                imageProvider.protocol === "apimart" || imageProvider.protocol === "kie";
              if (!serverProtocolSupported) {
                throw new Error(t("canvasNodes.protocolShotUnsupported", { protocol: imageProvider.protocol }));
              }
              const uploaded = await uploadMedia(capture.blob, "image", { requirePersistent: true });
              const store = useBoardStore.getState();
              const active = store.getActive();
              const current = active?.nodes.find((item) => item.id === node.id);
              if (!active || active.id !== directorProjectId || !current || current.type !== "director") {
                await deleteBlob("image", uploaded.storageKey).catch(() => undefined);
                throw new Error(t("canvasNodes.directorFormalShotMissing"));
              }
              let prepared: ReturnType<typeof planDirectorShotGeneration> extends infer Planned
                ? { planned: Planned; generation: ReturnType<typeof createImageGenerationMetadata>; jobId: string; configNode: BoardNode }
                : never;
              try {
                const preferredSize = resolveImageSizeForAspect(
                  capture.shot.camera.aspect,
                  imageProvider.protocol,
                  imageProvider.model,
                );
                const size = imageSizeOptions.some((option) => option.value === preferredSize)
                  ? preferredSize
                  : config.imageSize;
                const generation = normalizeImageGenerationForProvider(createImageGenerationMetadata({
                  prompt: buildDirectorShotPrompt(capture.shot),
                  model: imageProvider.model,
                  size,
                  quality: config.imageQuality,
                  count: 1,
                  transparentBackground: false,
                  referenceStorageKeys: [uploaded.storageKey],
                  generationChannelId: imageChannel.id,
                }), imageProvider.protocol);
                const jobId = uid("job");
                const planned = planDirectorShotGeneration(active, {
                  directorId: current.id,
                  capture,
                  media: uploaded,
                  generation,
                  jobId,
                });
                const configNode = planned.nodes.find((item) =>
                  item.type === "config" && item.metadata.directorShot?.captureId === capture.id);
                if (!configNode) throw new Error(t("canvasNodes.formalShotConfigFailed"));
                prepared = { planned, generation, jobId, configNode };
              } catch (error) {
                await deleteBlob("image", uploaded.storageKey).catch(() => undefined);
                throw error;
              }
              const { planned, generation, jobId, configNode } = prepared;
              try {
                await store.commitDirectorShotRun(active.id, current.id, active.updatedAt, planned);
              } catch (error) {
                if (!(error instanceof ProjectCommitRollbackError)) {
                  await deleteBlob("image", uploaded.storageKey).catch(() => undefined);
                }
                throw error;
              }
              try {
                await createServerImageGenerationJob({
                  id: jobId,
                  projectId: active.id,
                  prompt: generation.prompt,
                  providerId: imageChannel.id,
                  model: generation.model,
                  parameters: {
                    size: generation.size,
                    quality: generation.quality,
                    count: 1,
                    transparentBackground: false,
                    referenceStorageKeys: [uploaded.storageKey],
                    source: {
                      kind: "director",
                      directorNodeId: current.id,
                      captureId: capture.id,
                      cameraId: capture.shot.camera.id,
                      configNodeId: configNode.id,
                    },
                  },
                });
              } catch (error) {
                const details = error instanceof Error ? error.message : String(error);
                useBoardStore.setState((latest) => ({
                  projects: latest.projects.map((project) => project.id === active.id ? {
                    ...project,
                    nodes: project.nodes.map((item) => item.metadata.generationJobId === jobId ? {
                      ...item,
                      metadata: { ...item.metadata, status: "error", errorDetails: details },
                    } : item),
                  } : project),
                }));
                await store.persistNow().catch(() => undefined);
                await cancelServerGenerationJob(jobId).catch(() => undefined);
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
            "absolute z-20 flex items-center justify-center transition-opacity duration-150",
            "h-4 w-4",
            corner === "nw" ? "-left-1.5 -top-1.5 cursor-nw-resize" :
            corner === "ne" ? "-right-1.5 -top-1.5 cursor-ne-resize" :
            corner === "sw" ? "-bottom-1.5 -left-1.5 cursor-sw-resize" :
            "-bottom-1.5 -right-1.5 cursor-se-resize",
            selected ? "opacity-100" : "opacity-0 group-hover/node:opacity-60",
          )}
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e, Boolean(node.metadata.freeResize) || node.type !== "image", corner);
          }}
        >
          <span className="h-2 w-2 rounded-xs border border-[var(--ob-select)] bg-[var(--ob-panel)] shadow-xs transition-transform hover:scale-125" />
        </div>
      ))}
    </div>
  );
}
