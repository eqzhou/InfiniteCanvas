import { useEffect, useMemo, useRef, useState } from "react";
import type { AiChannel, BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import {
  generateImages,
  generateSpeech,
  generateText,
  generateVideo,
  resolveMediaRefs,
  resolveNodeImageDataUrl,
  resolveNodeImageDataUrls,
} from "@/services/ai-client";
import { downloadStorageKey, uploadMedia } from "@/services/storage";
import { displayMediaNodeFields, uploadDisplayMedia } from "@/services/media-preview";
import {
  cancelServerGenerationJob,
  createServerAudioGenerationJob,
  createServerImageGenerationJob,
  createServerVideoGenerationJob,
  usesServerGenerationJobs,
} from "@/services/generation-jobs";
import { generateTextBatch } from "@/services/text-batch";
import { makeCroppedNode, makeRotatedNode } from "@/lib/image-ops";
import { createNode } from "@/lib/defaults";
import { fitMediaDisplaySize } from "@/lib/geometry";
import { nowIso, uid } from "@/lib/id";
import { CropDialog } from "@/components/canvas/CropDialog";
import { AngleDialog } from "@/components/canvas/AngleDialog";
import { ImageToolsDialog, type ImageToolMode } from "@/components/canvas/ImageToolsDialog";
import { splitImageByGuides } from "@/lib/image-advanced";
import { ImageTransformRegistry } from "@/services/image-transform/registry";
import { createLocalCanvasTransformProvider } from "@/services/image-transform/providers/local-canvas";
import {
  createOpenAIImageTransformProvider,
  supportsOpenAIImageTransforms,
} from "@/services/image-transform/providers/openai-images";
import { createRectEditMaskBlob } from "@/services/image-transform/mask-raster";
import { resolveNodeImageTransformSource } from "@/services/image-transform/source";
import { createTransformLineage } from "@/services/image-transform/lineage";
import { applySystemPrompt } from "@/lib/app-config";
import { getProvider } from "@/lib/ai-config";
import { adjustFontSize } from "@/lib/node-format";
import { filenameForMimeType } from "@/lib/download-filename";
import { copyImageSourceToClipboard } from "@/lib/image-clipboard";
import {
  assertResolvedImageReferences,
  canRetryImageResult,
  createImageGenerationMetadata,
  normalizeImageGenerationForProvider,
} from "@/lib/image-generation";
import { normalizeVideoFrameMode } from "@/lib/video-generation";
import {
  normalizeVideoRatioForProvider,
  normalizeVideoResolutionForProvider,
  resolveVideoDurationForProvider,
} from "@/lib/video-generation-options";
import { applyCameraPrompt, createDefaultCameraPrompt } from "@/lib/camera-prompt";
import { applyServerImagePlaceholders, submitServerImageGeneration } from "@/lib/canvas-server-image";
import { resolveConfigPrompt } from "@/lib/config-generation";
import { placeImageGenerationRun } from "@/lib/image-generation-run";
import { directorShotGenerationContext } from "@/lib/director-shot-generation";
import { audioJobParameters, audioSpeechOptions } from "@/lib/audio-generation";
import {
  audioProtocolRequiresKey,
  audioProtocolSupportsServerJobs,
  resolveAudioVoice,
} from "@/lib/audio-provider";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import { imageOutputLimitFor } from "@/lib/image-generation-options";
import { NodeInfoDialog } from "@/components/canvas/NodeInfoDialog";
import {
  isGenerationChannelReady,
  isServerManagedChannel,
  mergeSharedChannelChoices,
  useSharedChannels,
} from "@/services/shared-channels";
import {
  normalizeImageToolbarPreferences,
  orderedVisibleImageActions,
  orderedVisiblePanoramaActions,
  type ImageToolbarAction,
} from "@/lib/image-toolbar-preferences";
import { hasImageSource, shouldShowImageGenerationAction } from "@/lib/node-action-visibility";
import { CameraPromptPanel } from "@/components/canvas/CameraPromptPanel";
import { TextEntryDialog } from "@/components/canvas/TextEntryDialog";
import {
  BookmarkPlus,
  BookmarkCheck,
  Camera,
  Copy,
  Crop,
  Download,
  ImagePlus,
  Info,
  Minus,
  Plus,
  RotateCw,
  Sparkles,
  Square,
  Type,
  Wand2,
} from "lucide-react";
import { toast } from "@/components/common/toast";
import { useI18n } from "@/i18n/I18nProvider";
import {
  resolveMediaCapabilityForRequest,
  type MediaCapability,
  type MediaCapabilityCatalog,
} from "@/services/media-capabilities";

function nodeVideoControls(node: BoardNode, channel: AiChannel, capability?: MediaCapability) {
  const provider = getProvider(channel, "video");
  const model = node.metadata.model || provider.model;
  const requestedRatio = node.metadata.videoRatio || "16:9";
  const requestedResolution = node.metadata.resolution || "720p";
  return {
    seconds: resolveVideoDurationForProvider(Boolean(node.metadata.smartDuration), node.metadata.duration ?? 5, provider.protocol, model, capability?.durations),
    ratio: capability?.ratios.length
      ? capability.ratios.includes(requestedRatio) ? requestedRatio : capability.ratios[0]!
      : normalizeVideoRatioForProvider(requestedRatio, provider.protocol, model),
    resolution: capability?.resolutions.length
      ? capability.resolutions.includes(requestedResolution) ? requestedResolution : capability.resolutions[0]!
      : normalizeVideoResolutionForProvider(requestedResolution, provider.protocol, model),
  };
}

type PromptDialogKind = "rewrite" | "image" | "video" | "audio";

type PromptDialogState = {
  kind: PromptDialogKind;
  title: string;
  label: string;
  initialValue: string;
  placeholder?: string;
  submitLabel: string;
  multiline?: boolean;
};

export function NodeActions({
  node,
  onEditText,
  avoidTopToolbarOverlap = false,
  inlineConfigOnly = false,
  videoCapability,
  mediaCatalog,
}: {
  node: BoardNode;
  onEditText?: () => void;
  avoidTopToolbarOverlap?: boolean;
  inlineConfigOnly?: boolean;
  videoCapability?: MediaCapability;
  mediaCatalog?: MediaCapabilityCatalog | null;
}) {
  const { t } = useI18n();
  const project = useBoardStore((s) => s.getActive());
  const config = useBoardStore((s) => s.config);
  const updateNode = useBoardStore((s) => s.updateNode);
  const updateActive = useBoardStore((s) => s.updateActive);
  const addAssetFromNode = useBoardStore((s) => s.addAssetFromNode);
	const persistNow = useBoardStore((s) => s.persistNow);
  const imageRetryRequestId = useBoardStore((s) => s.imageRetryRequestId);
  const requestImageRetry = useBoardStore((s) => s.requestImageRetry);
  const [cropOpen, setCropOpen] = useState(false);
  const [angleOpen, setAngleOpen] = useState(false);
  const [imageTool, setImageTool] = useState<ImageToolMode | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [assetSaveState, setAssetSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [imageCopyState, setImageCopyState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const [configGenerating, setConfigGenerating] = useState(false);
  const [promptDialog, setPromptDialog] = useState<PromptDialogState | null>(null);
  const cameraAnchorRef = useRef<HTMLSpanElement>(null);
	const sharedChannels = useSharedChannels();
	const channelChoices = useMemo(() => mergeSharedChannelChoices(config.channels, sharedChannels), [config.channels, sharedChannels]);
  const channel = node.metadata.generationChannelId
    ? channelChoices.find((candidate) => candidate.id === node.metadata.generationChannelId)
    : config.activeSharedChannelId
      ? channelChoices.find((candidate) => candidate.id === config.activeSharedChannelId)
      : config.channels.find((candidate) => candidate.id === config.activeChannelId) ?? config.channels[0];
  const cameraAvailable = node.type === "image" || node.type === "video" ||
    (node.type === "config" && (node.metadata.generationMode ?? "image") !== "text");
  const promptForGeneration = (prompt: string) => applyCameraPrompt(prompt, node.metadata.cameraPrompt);
  const serverProviderSupported = (kind: "image" | "video" | "audio", selectedChannel = channel) => {
		if (!selectedChannel || !usesServerGenerationJobs()) return false;
		const provider = getProvider(selectedChannel, kind);
		if (kind === "image") return provider.protocol === "openai" || provider.protocol === "gemini" ||
			(provider.protocol === "template" && Boolean(provider.template)) || provider.protocol === "apimart" || provider.protocol === "kie";
		if (kind === "audio") return audioProtocolSupportsServerJobs(provider.protocol);
		return provider.protocol === "openai" || provider.protocol === "ark" ||
			(provider.protocol === "template" && Boolean(provider.template)) ||
			provider.protocol === "apimart" || provider.protocol === "kie" ||
			provider.baseUrl.includes("/api/v3") || provider.baseUrl.includes("/api/plan/v3");
	};
	const startServerImageGeneration = async (
		rootId: string,
		generation: ReturnType<typeof createImageGenerationMetadata>,
		prompt: string,
		referenceStorageKeys: string[],
		options: { replaceExisting?: boolean } = {},
		selectedChannel = channel,
	) => {
		if (!selectedChannel) throw new Error(t("canvasNodes.imageChannelUnavailable"));
		const provider = getProvider(selectedChannel, "image");
		if (provider.protocol === "gemini" && generation.transparentBackground) {
			throw new Error(t("canvasNodes.geminiTransparentUnsupported"));
		}
		if (provider.protocol === "template" && generation.transparentBackground && !provider.template?.supportsTransparentBackground) {
			throw new Error(t("canvasNodes.templateTransparentUnsupported"));
		}
		const normalizedGeneration = normalizeImageGenerationForProvider(generation, provider.protocol);
		const jobId = uid("job");
		const source = directorShotGenerationContext(project, rootId)?.source;
		return submitServerImageGeneration({
			createJob: () => createServerImageGenerationJob({
				id: jobId,
				projectId: project?.id,
				prompt,
				providerId: selectedChannel.id,
				model: normalizedGeneration.model,
				parameters: {
					size: normalizedGeneration.size,
					quality: normalizedGeneration.quality,
					count: normalizedGeneration.count,
					transparentBackground: normalizedGeneration.transparentBackground,
					referenceStorageKeys,
					source,
				},
			}),
			applyPlaceholders: () => updateActive((current) => applyServerImagePlaceholders(current, rootId, jobId, normalizedGeneration, options)),
			persist: persistNow,
			cancelJob: () => cancelServerGenerationJob(jobId),
			onPersistError: (error) => console.error("Image job created but canvas persistence is pending", error),
		});
	};
	const cancelNodeGeneration = async () => {
		const jobId = node.metadata.generationJobId;
		if (!jobId) return;
		try {
			const job = await cancelServerGenerationJob(jobId);
			updateNode(node.id, { metadata: {
				status: "error",
				errorDetails: job.error || t("canvasNodes.cancelled"),
				generationJobId: job.id,
			} });
		} catch (cause) {
			updateNode(node.id, { metadata: { status: "error", errorDetails: cause instanceof Error ? cause.message : String(cause) } });
		}
	};
  const transformRegistry = useMemo(() => {
    const providers = [createLocalCanvasTransformProvider()];
    // Only register the cloud provider when the channel protocol actually
    // serves the OpenAI edit/upscale endpoints; otherwise the action would be
    // offered and then fail at request time.
    if (channel && !isServerManagedChannel(channel, "image") && supportsOpenAIImageTransforms(channel) &&
      getProvider(channel, "image").apiKey && getProvider(channel, "image").baseUrl) {
      providers.push(createOpenAIImageTransformProvider(channel));
    }
    return new ImageTransformRegistry(providers);
  }, [channel]);
  const transformProviderOptions = useMemo(() => {
    const capability = imageTool === "resize" || imageTool === "ai-upscale" ? "upscale" : "mask";
    const local = transformRegistry.forCapability(capability);
    const cloud = imageTool === "mask" ? transformRegistry.forCapability("inpaint") : [];
    return [...local, ...cloud].map((provider) => ({
      id: provider.id,
      label: provider.kind === "local" && capability === "mask"
        ? `${provider.label} · ${t("canvasNodes.transparentMask")}`
        : provider.label,
      kind: provider.kind,
    }));
  }, [imageTool, t, transformRegistry]);

  const upstream = () => {
    if (!project)
      return {
        texts: [] as string[],
        imageKeys: [] as string[],
        videoKeys: [] as string[],
        audioKeys: [] as string[],
        images: [] as Array<{ storageKey?: string; content?: string }>,
        videos: [] as Array<{ storageKey?: string; content?: string }>,
        audios: [] as Array<{ storageKey?: string; content?: string }>,
      };
    const incoming = project.edges.filter((e) => e.to === node.id).map((e) => e.from);
    const configured = node.metadata.inputOrder?.filter((id) => incoming.includes(id)) ?? [];
    const order = [...configured, ...incoming.filter((id) => !configured.includes(id))];
    const nodes = order
      .map((id) => project.nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n));
    return {
      texts: nodes
        .filter((n) => n.type === "text")
        .map((n) => n.metadata.content ?? "")
        .filter(Boolean),
      imageKeys: nodes
        .filter((n) => n.type === "image" && n.metadata.storageKey)
        .map((n) => n.metadata.storageKey!),
      videoKeys: nodes
        .filter((n) => n.type === "video" && n.metadata.storageKey)
        .map((n) => n.metadata.storageKey!),
      audioKeys: nodes
        .filter((n) => n.type === "audio" && n.metadata.storageKey)
        .map((n) => n.metadata.storageKey!),
      images: nodes
        .filter((n) => n.type === "image")
        .map((n) => ({ storageKey: n.metadata.storageKey, content: n.metadata.content })),
      videos: nodes
        .filter((n) => n.type === "video")
        .map((n) => ({ storageKey: n.metadata.storageKey, content: n.metadata.content })),
      audios: nodes
        .filter((n) => n.type === "audio")
        .map((n) => ({ storageKey: n.metadata.storageKey, content: n.metadata.content })),
    };
  };

  const placeRight = (created: BoardNode[]) => {
    updateActive((p) => {
      const edges = created.map((c) => ({
        id: uid("edge"),
        from: node.id,
        to: c.id,
      }));
      return { ...p, nodes: [...p.nodes, ...created], edges: [...p.edges, ...edges] };
    });
  };

  const placeImageBatch = (
    rootId: string,
    created: BoardNode[],
    generation: ReturnType<typeof createImageGenerationMetadata>,
  ) => {
    updateActive((project) => placeImageGenerationRun(project, {
      sourceId: rootId,
      results: created.map((item) => ({
        ...item,
        metadata: { ...item.metadata, ...generation },
      })),
    }));
  };

  const runConfigGenerate = async () => {
    if (configGenerating || node.metadata.status === "loading") return;
    if (node.metadata.generationChannelId && !channel) {
      toast.warn(t("canvasNodes.originalChannelUnavailable"));
      return;
    }
    const mode = node.metadata.generationMode ?? "image";
    const providerKind = mode === "text" ? "text" : mode === "video" ? "video" : "image";
    if (!isGenerationChannelReady(channel, providerKind)) {
      toast.warn(t("canvasNodes.modelApiKeyRequired"));
      return;
    }
    const inputs = upstream();
    const directorContext = directorShotGenerationContext(project, node.id);
    const usesUpstreamInputs = !(node.metadata.prompt ?? node.metadata.content ?? "").trim();
    const texts = usesUpstreamInputs ? inputs.texts : [];
    const usesStoredDirectorReferences = inputs.imageKeys.length === 0 && Boolean(directorContext);
    const imageKeys = usesStoredDirectorReferences
      ? directorContext!.referenceStorageKeys
      : inputs.imageKeys;
    const images = inputs.images;
    if (usesStoredDirectorReferences && imageKeys.length === 0) {
      toast.warn(t("canvasNodes.directorReferenceMissing"));
      return;
    }
    const prompt = resolveConfigPrompt({
      prompt: node.metadata.prompt ?? node.metadata.content,
      upstreamTexts: texts,
    });
    if (!prompt) {
      toast.warn(t("canvasNodes.promptRequired"));
      return;
    }
    setConfigGenerating(true);
    updateNode(node.id, { metadata: { status: "loading", errorDetails: undefined } });
    try {
      if (mode === "text") {
        const model = node.metadata.model || getProvider(channel, "text").model;
        const outputs = await generateTextBatch({
          channel,
          model,
          prompt,
          images: await resolveNodeImageDataUrls(imageKeys),
          systemPrompt: config.systemPrompt,
          reasoningEffort: node.metadata.reasoningEffort,
          count: node.metadata.count || 1,
        });
        const created = outputs.map((content, index) => createNode(
          "text",
          {
            x: node.position.x + node.width + 60,
            y: node.position.y + index * 40,
          },
          { metadata: {
            content,
            model,
            prompt,
            reasoningEffort: node.metadata.reasoningEffort,
            status: "success",
          } },
        ));
        placeRight(created);
      } else if (mode === "image") {
        const imageProvider = getProvider(channel, "image");
        const imageModel = node.metadata.model || imageProvider.model;
        const generation = createImageGenerationMetadata({
          prompt,
          model: imageModel,
          size: node.metadata.size || config.imageSize,
          quality: node.metadata.quality || config.imageQuality,
          count: Math.min(
            Math.max(1, node.metadata.count || config.imageCount || 1),
            imageOutputLimitFor(imageProvider.protocol, imageModel),
          ),
          transparentBackground: Boolean(node.metadata.transparentBackground),
          referenceStorageKeys: imageKeys,
          generationChannelId: channel.id,
          cameraPrompt: node.metadata.cameraPrompt,
        });
        const normalizedGeneration = normalizeImageGenerationForProvider(generation, imageProvider.protocol);
        const requestPrompt = promptForGeneration(normalizedGeneration.prompt);
        const materializedImages = images.filter((image) => image.storageKey || image.content);
        if (serverProviderSupported("image") &&
            (usesStoredDirectorReferences || imageKeys.length === materializedImages.length)) {
          await startServerImageGeneration(node.id, normalizedGeneration, requestPrompt, imageKeys);
          return;
        }
        const refs = await resolveNodeImageDataUrls(imageKeys);
        assertResolvedImageReferences(imageKeys, refs);
      const urls = await generateImages({
          channel,
          model: normalizedGeneration.model,
          prompt: requestPrompt,
          size: normalizedGeneration.size,
          quality: normalizedGeneration.quality,
          n: normalizedGeneration.count,
          referenceDataUrls: refs,
          transparentBackground: normalizedGeneration.transparentBackground,
          systemPrompt: config.systemPrompt,
        });
        const created: BoardNode[] = [];
        for (const [i, url] of urls.entries()) {
          const uploaded = await uploadDisplayMedia(url, "image");
          const display = fitMediaDisplaySize(uploaded.width, uploaded.height, 120, 360);
          created.push(
            createNode(
              "image",
              {
                x: node.position.x + node.width + 60,
                y: node.position.y + i * 40,
              },
              {
                metadata: {
                  ...displayMediaNodeFields(uploaded),
                  status: "success",
                  cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
                  ...normalizedGeneration,
                },
                width: display.width,
                height: display.height,
              },
            ),
          );
        }
        placeImageBatch(node.id, created, normalizedGeneration);
      } else {
		const { images, videos, audios, imageKeys, videoKeys, audioKeys } = inputs;
		const referenceCount = images.filter((value) => value.storageKey || value.content).length +
			videos.filter((value) => value.storageKey || value.content).length +
			audios.filter((value) => value.storageKey || value.content).length;
		const referenceStorageKeys = [...imageKeys, ...videoKeys, ...audioKeys];
		const resolvedVideoCapability = resolveMediaCapabilityForRequest(
			mediaCatalog, channel.id, "video", node.metadata.model || getProvider(channel, "video").model,
			referenceCount > 0 ? "image_to_video" : "text_to_video",
		);
		if (mediaCatalog && sharedChannels.some((candidate) => candidate.id === channel.id) && !resolvedVideoCapability) {
			throw new Error(t("creative.sharedCapabilityMissing"));
		}
		const requestVideoCapability = resolvedVideoCapability ?? videoCapability;
		if (serverProviderSupported("video") && referenceStorageKeys.length === referenceCount) {
			const job = await createServerVideoGenerationJob({
				projectId: project?.id,
				prompt: promptForGeneration(prompt),
				providerId: channel.id,
				model: node.metadata.model || getProvider(channel, "video").model,
				parameters: {
					size: node.metadata.size,
					...nodeVideoControls(node, channel, requestVideoCapability),
					generateAudio: Boolean(node.metadata.generateAudio),
					watermark: Boolean(node.metadata.watermark),
					frameMode: normalizeVideoFrameMode(node.metadata.videoFrameMode),
					referenceStorageKeys,
				},
			});
			const placeholder = createNode("video", { x: node.position.x + node.width + 60, y: node.position.y }, {
				metadata: {
					status: "loading",
					prompt,
					generationJobId: job.id,
					cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
				},
			});
			placeRight([placeholder]);
			updateNode(node.id, { metadata: { status: "success" } });
			await persistNow();
			return;
		}
        const [referenceImages, referenceVideos, referenceAudios] = await Promise.all([
          resolveMediaRefs(images, 9),
          resolveMediaRefs(videos, 3),
          resolveMediaRefs(audios, 3),
        ]);
        const result = await generateVideo({
          channel,
          model: node.metadata.model || getProvider(channel, "video").model,
          prompt: promptForGeneration(prompt),
          size: node.metadata.size,
          ...nodeVideoControls(node, channel, requestVideoCapability),
          generateAudio: Boolean(node.metadata.generateAudio),
          watermark: Boolean(node.metadata.watermark),
          frameMode: normalizeVideoFrameMode(node.metadata.videoFrameMode),
          referenceImages,
          referenceVideos,
          referenceAudios,
        });
        let content = result.url;
        let storageKey: string | undefined;
        let thumbnailStorageKey: string | undefined;
        let thumbnailUrl: string | undefined;
        if (content?.startsWith("blob:") || content?.startsWith("data:")) {
          const uploaded = await uploadDisplayMedia(content, "media", { previewKind: "video" });
          content = uploaded.url;
          storageKey = uploaded.storageKey;
          thumbnailStorageKey = uploaded.thumbnailStorageKey;
          thumbnailUrl = uploaded.thumbnailUrl;
        } else if (content && /^https?:\/\//i.test(content)) {
          try {
            const uploaded = await uploadDisplayMedia(content, "media", { previewKind: "video" });
            content = uploaded.url;
            storageKey = uploaded.storageKey;
            thumbnailStorageKey = uploaded.thumbnailStorageKey;
            thumbnailUrl = uploaded.thumbnailUrl;
          } catch {
            // keep remote URL if download blocked by CORS
          }
        }
        const created = createNode(
          "video",
          { x: node.position.x + node.width + 60, y: node.position.y },
          {
            metadata: {
              content,
              storageKey,
              thumbnailStorageKey,
              thumbnailUrl,
              status: "success",
              prompt,
              cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
            },
          },
        );
        placeRight([created]);
      }
      updateNode(node.id, { metadata: { status: "success" } });
    } catch (err) {
      updateNode(node.id, {
        metadata: {
          status: "error",
          errorDetails: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      setConfigGenerating(false);
      await persistNow();
    }
  };

  const textToImage = () => {
    const cfg = createNode(
      "config",
      { x: node.position.x + node.width + 60, y: node.position.y },
      {
        metadata: {
          generationMode: "image",
          prompt: "",
          model: channel ? getProvider(channel, "image").model : undefined,
          status: "idle",
          size: config.imageSize,
          count: config.imageCount,
        },
      },
    );
    updateActive((p) => ({
      ...p,
      nodes: [...p.nodes, cfg],
      edges: [...p.edges, { id: uid("edge"), from: node.id, to: cfg.id }],
      updatedAt: nowIso(),
    }));
  };

  const rewriteText = async (instruction: string) => {
    if (!channel || !getProvider(channel, "text").apiKey) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    updateNode(node.id, { metadata: { status: "loading" } });
    try {
      const out = await generateText({
        channel,
        model: node.metadata.model || getProvider(channel, "text").model,
        prompt: t("canvasNodes.originalTextPrompt", { text: node.metadata.content ?? "", instruction }),
        systemPrompt: config.systemPrompt,
        reasoningEffort: node.metadata.reasoningEffort,
      });
      if (!node.metadata.content) {
        updateNode(node.id, { metadata: { content: out, status: "success" } });
      } else {
        const created = createNode(
          "text",
          { x: node.position.x + node.width + 60, y: node.position.y },
          { metadata: {
            content: out,
            reasoningEffort: node.metadata.reasoningEffort,
            status: "success",
          } },
        );
        placeRight([created]);
        updateNode(node.id, { metadata: { status: "success" } });
      }
    } catch (err) {
      updateNode(node.id, {
        metadata: {
          status: "error",
          errorDetails: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  const continueFromImage = async (prompt: string) => {
    if (!isGenerationChannelReady(channel, "image")) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    try {
      const referenceStorageKeys = node.metadata.storageKey ? [node.metadata.storageKey] : [];
      const generation = createImageGenerationMetadata({
        prompt,
        model: node.metadata.model || getProvider(channel, "image").model,
        size: config.imageSize,
        quality: config.imageQuality,
        count: config.imageCount,
        transparentBackground: Boolean(node.metadata.transparentBackground),
        referenceStorageKeys,
        generationChannelId: channel.id,
        cameraPrompt: node.metadata.cameraPrompt,
      });
      const imageProvider = getProvider(channel, "image");
      const normalizedGeneration = normalizeImageGenerationForProvider(generation, imageProvider.protocol);
      const requestPrompt = promptForGeneration(normalizedGeneration.prompt);
      if (serverProviderSupported("image") && (!node.metadata.content || referenceStorageKeys.length === 1)) {
        await startServerImageGeneration(node.id, normalizedGeneration, requestPrompt, referenceStorageKeys);
        return;
      }
      const refs = await resolveNodeImageDataUrls(referenceStorageKeys);
      assertResolvedImageReferences(referenceStorageKeys, refs);
        const urls = await generateImages({
        channel,
        model: normalizedGeneration.model,
        prompt: requestPrompt,
        size: normalizedGeneration.size,
        quality: normalizedGeneration.quality,
        n: normalizedGeneration.count,
        referenceDataUrls: refs,
        transparentBackground: normalizedGeneration.transparentBackground,
        systemPrompt: config.systemPrompt,
      });
      const created: BoardNode[] = [];
      for (const [index, url] of urls.entries()) {
        const uploaded = await uploadDisplayMedia(url, "image");
        const display = fitMediaDisplaySize(uploaded.width, uploaded.height, 120, 360);
        created.push(createNode("image", {
          x: node.position.x + node.width + 60,
          y: node.position.y + index * 36,
        }, {
          title: t("canvasNodes.resultTitle", { index: index + 1 }),
          metadata: {
            ...displayMediaNodeFields(uploaded),
            status: "success",
            ...normalizedGeneration,
          },
          width: display.width,
          height: display.height,
        }));
      }
      updateActive((current) => placeImageGenerationRun(current, {
        sourceId: node.id,
        results: created,
        reuseEmptyImageTarget: !node.metadata.content && !node.metadata.storageKey,
      }));
    } catch (err) {
      if (!node.metadata.content && !node.metadata.storageKey) {
        updateNode(node.id, { metadata: { status: "error", errorDetails: err instanceof Error ? err.message : String(err) } });
      } else {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      await persistNow();
    }
  };

  const retryImageResult = async () => {
    const savedChannelId = node.metadata.generationChannelId;
    const retryChannel = savedChannelId
      ? channelChoices.find((choice) => choice.id === savedChannelId)
      : channel;
    if (savedChannelId && !retryChannel) {
      toast.warn(t("canvasNodes.originalChannelRetryUnavailable"));
      return;
    }
    if (!isGenerationChannelReady(retryChannel, "image")) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    const prompt = node.metadata.prompt?.trim();
    if (!prompt) {
      toast.warn(t("canvasNodes.retrySnapshotMissing"));
      return;
    }
    const referenceStorageKeys = [...(node.metadata.referenceStorageKeys ?? [])];
    const generation = createImageGenerationMetadata({
      prompt,
      model: node.metadata.model || getProvider(retryChannel, "image").model,
      size: node.metadata.size || config.imageSize,
      quality: node.metadata.quality || config.imageQuality,
      count: 1,
      transparentBackground: Boolean(node.metadata.transparentBackground),
      referenceStorageKeys,
      generationChannelId: retryChannel.id,
      cameraPrompt: node.metadata.cameraPrompt,
    });
    const retryProvider = getProvider(retryChannel, "image");
    const normalizedGeneration = normalizeImageGenerationForProvider(generation, retryProvider.protocol);
    const requestPrompt = promptForGeneration(normalizedGeneration.prompt);
    try {
      updateNode(node.id, { metadata: { status: "loading", errorDetails: undefined } });
      if (serverProviderSupported("image", retryChannel)) {
        await startServerImageGeneration(node.id, normalizedGeneration, requestPrompt, referenceStorageKeys, { replaceExisting: true }, retryChannel);
        return;
      }
      const refs = await resolveNodeImageDataUrls(referenceStorageKeys);
      assertResolvedImageReferences(referenceStorageKeys, refs);
      const [url] = await generateImages({
        channel: retryChannel,
        model: normalizedGeneration.model,
        prompt: requestPrompt,
        size: normalizedGeneration.size,
        quality: normalizedGeneration.quality,
        n: normalizedGeneration.count,
        referenceDataUrls: refs,
        transparentBackground: normalizedGeneration.transparentBackground,
        systemPrompt: config.systemPrompt,
      });
      if (!url) throw new Error(t("canvasNodes.imageResultMissing"));
      const uploaded = await uploadDisplayMedia(url, "image");
      updateNode(node.id, { metadata: {
        ...displayMediaNodeFields(uploaded),
        status: "success",
        errorDetails: undefined,
        ...normalizedGeneration,
      } });
    } catch (error) {
      updateNode(node.id, { metadata: { status: "error", errorDetails: error instanceof Error ? error.message : String(error) } });
    } finally {
      await persistNow();
    }
  };
  const retryImageResultRef = useRef(retryImageResult);
  retryImageResultRef.current = retryImageResult;
  useEffect(() => {
    if (useBoardStore.getState().imageRetryRequestId !== node.id) return;
    requestImageRetry(null);
    if (node.type !== "image") return;
    void retryImageResultRef.current();
  }, [imageRetryRequestId, node.id, node.type, requestImageRetry]);

  const reversePrompt = async () => {
    if (!channel || !getProvider(channel, "text").apiKey) {
      toast.warn(t("canvasNodes.visionApiKeyRequired"));
      return;
    }
    updateNode(node.id, { metadata: { status: "loading", errorDetails: undefined } });
    try {
      const image = await resolveNodeImageDataUrl(
        node.metadata.storageKey,
        node.metadata.content,
      );
      const images = image ? [image] : [];
      if (!images.length) throw new Error(t("canvasNodes.imageContentMissing"));
      const text = await generateText({
        channel,
        model: getProvider(channel, "text").model,
        prompt: t("canvasNodes.reversePromptInstruction"),
        images,
        systemPrompt: config.systemPrompt,
      });
      const created = createNode(
        "text",
        { x: node.position.x + node.width + 60, y: node.position.y },
        { title: t("canvasNodes.reversePrompt"), metadata: { content: text, status: "success" } },
      );
      placeRight([created]);
      updateNode(node.id, { metadata: { status: "success" } });
    } catch (error) {
      updateNode(node.id, {
        metadata: {
          status: "error",
          errorDetails: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const generateOnVideo = async (prompt: string) => {
    if (!channel || !getProvider(channel, "video").apiKey) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    updateNode(node.id, { metadata: { status: "loading", prompt, errorDetails: undefined } });
    try {
      const upstreamRefs = project
        ? project.edges
            .filter((e) => e.to === node.id)
            .map((e) => project.nodes.find((n) => n.id === e.from))
            .filter((n): n is NonNullable<typeof n> => Boolean(n))
        : [];
      const refs = [
        ...upstreamRefs,
        ...(node.type === "image" || node.type === "video" || node.type === "audio" ? [node] : []),
      ];
		const materializedRefs = refs.filter((item) => item.metadata.storageKey || item.metadata.content);
		const referenceStorageKeys = materializedRefs
			.map((item) => item.metadata.storageKey)
			.filter((value): value is string => Boolean(value));
		const resolvedVideoCapability = resolveMediaCapabilityForRequest(
			mediaCatalog, channel.id, "video", node.metadata.model || getProvider(channel, "video").model,
			materializedRefs.length > 0 ? "image_to_video" : "text_to_video",
		);
		if (mediaCatalog && sharedChannels.some((candidate) => candidate.id === channel.id) && !resolvedVideoCapability) {
			throw new Error(t("creative.sharedCapabilityMissing"));
		}
		const requestVideoCapability = resolvedVideoCapability ?? videoCapability;
		if (serverProviderSupported("video") && referenceStorageKeys.length === materializedRefs.length) {
			const job = await createServerVideoGenerationJob({
				projectId: project?.id,
				prompt: promptForGeneration(prompt),
				providerId: channel.id,
				model: node.metadata.model || getProvider(channel, "video").model,
				parameters: {
					size: node.metadata.size,
					...nodeVideoControls(node, channel, requestVideoCapability),
					generateAudio: Boolean(node.metadata.generateAudio),
					watermark: Boolean(node.metadata.watermark),
					frameMode: normalizeVideoFrameMode(node.metadata.videoFrameMode),
					referenceStorageKeys,
				},
			});
			if (node.type === "video" && !node.metadata.content) {
				updateNode(node.id, { metadata: { status: "loading", prompt, generationJobId: job.id } });
			} else {
				const placeholder = createNode("video", { x: node.position.x + node.width + 60, y: node.position.y }, {
					metadata: {
						status: "loading",
						prompt,
						generationJobId: job.id,
						cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
					},
				});
				placeRight([placeholder]);
				updateNode(node.id, { metadata: { status: "success" } });
			}
			await persistNow();
			return;
		}
      const [referenceImages, referenceVideos, referenceAudios] = await Promise.all([
        resolveMediaRefs(
          refs.filter((n) => n.type === "image").map((n) => ({
            storageKey: n.metadata.storageKey,
            content: n.metadata.content,
          })),
          9,
        ),
        resolveMediaRefs(
          refs.filter((n) => n.type === "video").map((n) => ({
            storageKey: n.metadata.storageKey,
            content: n.metadata.content,
          })),
          3,
        ),
        resolveMediaRefs(
          refs.filter((n) => n.type === "audio").map((n) => ({
            storageKey: n.metadata.storageKey,
            content: n.metadata.content,
          })),
          3,
        ),
      ]);
      if (node.type === "image" && !referenceImages.length) {
        throw new Error(t("canvasNodes.imageReferenceUnavailable"));
      }
      const result = await generateVideo({
        channel,
        model: node.metadata.model || getProvider(channel, "video").model,
        prompt: promptForGeneration(prompt),
        size: node.metadata.size,
        ...nodeVideoControls(node, channel, requestVideoCapability),
        generateAudio: Boolean(node.metadata.generateAudio),
        watermark: Boolean(node.metadata.watermark),
        frameMode: normalizeVideoFrameMode(node.metadata.videoFrameMode),
        referenceImages,
        referenceVideos,
        referenceAudios,
      });
      let content = result.url;
      let storageKey: string | undefined;
      let thumbnailStorageKey: string | undefined;
      let thumbnailUrl: string | undefined;
      if (content?.startsWith("blob:") || content?.startsWith("data:")) {
        const uploaded = await uploadDisplayMedia(content, "media", { previewKind: "video" });
        content = uploaded.url;
        storageKey = uploaded.storageKey;
        thumbnailStorageKey = uploaded.thumbnailStorageKey;
        thumbnailUrl = uploaded.thumbnailUrl;
      } else if (content && /^https?:\/\//i.test(content)) {
        try {
          const uploaded = await uploadDisplayMedia(content, "media", { previewKind: "video" });
          content = uploaded.url;
          storageKey = uploaded.storageKey;
          thumbnailStorageKey = uploaded.thumbnailStorageKey;
          thumbnailUrl = uploaded.thumbnailUrl;
        } catch {
          // keep remote
        }
      }
      if (node.type === "video" && !node.metadata.content) {
        updateNode(node.id, {
          metadata: {
            content,
            storageKey,
            thumbnailStorageKey,
            thumbnailUrl,
            status: "success",
            prompt,
            cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
          },
        });
      } else {
        const created = createNode(
          "video",
          { x: node.position.x + node.width + 60, y: node.position.y },
          {
            metadata: {
              content,
              storageKey,
              thumbnailStorageKey,
              thumbnailUrl,
              status: "success",
              prompt,
              cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
            },
          },
        );
        placeRight([created]);
        updateNode(node.id, { metadata: { status: "success" } });
      }
    } catch (err) {
      updateNode(node.id, {
        metadata: {
          status: "error",
          errorDetails: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  const downloadNode = async () => {
    if (!node.metadata.storageKey) {
      if (node.metadata.content) {
        const a = document.createElement("a");
        a.href = node.metadata.content;
        a.download = `${node.title || node.type}.bin`;
        a.click();
        return;
      }
      toast.warn(t("canvasNodes.downloadMissing"));
      return;
    }
    try {
      await downloadStorageKey(
        node.metadata.storageKey,
        filenameForMimeType(
          node.title || node.id,
          node.metadata.mimeType,
          node.type === "video" ? "mp4" : node.type === "audio" ? "mp3" : "jpg",
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const copyImageNode = async () => {
    setImageCopyState("copying");
    try {
      const source = resolveNodeImageDataUrl(node.metadata.storageKey, node.metadata.content)
        .then((resolved) => resolved ?? node.metadata.content ?? null);
      await copyImageSourceToClipboard(source);
      setImageCopyState("copied");
      toast.success(t("canvasNodes.imageCopied"));
    } catch (cause) {
      setImageCopyState("error");
      toast.error(cause instanceof Error ? cause.message : t("canvasNodes.copyImageFailed"));
    }
  };

  const inspect = () => setInfoOpen(true);

  const generateOnAudio = async (prompt: string) => {
    const provider = channel ? getProvider(channel, "audio") : undefined;
    if (!channel || !provider || (audioProtocolRequiresKey(provider.protocol) && !provider.apiKey)) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    updateNode(node.id, { metadata: { status: "loading", prompt, errorDetails: undefined } });
    try {
		const actualVoice = resolveAudioVoice({
			roles: project?.audioRoles,
			roleId: node.metadata.audioRoleId,
			protocol: provider.protocol,
			fallback: config.generationDefaults?.audioVoice ?? DEFAULT_GENERATION_DEFAULTS.audioVoice,
			explicit: node.metadata.voice,
		});
		if (serverProviderSupported("audio")) {
			const job = await createServerAudioGenerationJob({
				projectId: project?.id,
				prompt,
				providerId: channel.id,
				model: node.metadata.model || getProvider(channel, "audio").model,
				parameters: audioJobParameters(actualVoice, config.generationDefaults),
			});
			if (!node.metadata.content) {
				updateNode(node.id, { metadata: { status: "loading", prompt, generationJobId: job.id, resolvedVoice: actualVoice } });
			} else {
				const placeholder = createNode("audio", { x: node.position.x + node.width + 60, y: node.position.y }, {
					metadata: {
						status: "loading",
						prompt,
						generationJobId: job.id,
						voice: node.metadata.voice,
						resolvedVoice: actualVoice,
						audioRoleId: node.metadata.audioRoleId,
					},
				});
				placeRight([placeholder]);
				updateNode(node.id, { metadata: { status: "success" } });
			}
			await persistNow();
			return;
		}
      const speech = await generateSpeech({
        channel,
        model: node.metadata.model || getProvider(channel, "audio").model,
        input: prompt,
        ...audioSpeechOptions(actualVoice, config.generationDefaults),
      });
      const uploaded = await uploadMedia(speech.blob, "media");
      if (!node.metadata.content) {
        updateNode(node.id, {
          metadata: {
            content: uploaded.url,
            storageKey: uploaded.storageKey,
            mimeType: speech.mimeType || uploaded.mimeType,
            bytes: uploaded.bytes,
            status: "success",
            prompt,
            voice: node.metadata.voice,
            resolvedVoice: actualVoice,
            audioRoleId: node.metadata.audioRoleId,
          },
        });
      } else {
        const created = createNode(
          "audio",
          { x: node.position.x + node.width + 60, y: node.position.y },
          {
            metadata: {
              content: uploaded.url,
              storageKey: uploaded.storageKey,
              mimeType: speech.mimeType || uploaded.mimeType,
              bytes: uploaded.bytes,
              status: "success",
              prompt,
              voice: node.metadata.voice,
              resolvedVoice: actualVoice,
              audioRoleId: node.metadata.audioRoleId,
            },
          },
        );
        placeRight([created]);
        updateNode(node.id, { metadata: { status: "success" } });
      }
    } catch (err) {
      updateNode(node.id, {
        metadata: {
          status: "error",
          errorDetails: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  const openRewriteDialog = () => {
    if (!channel || !getProvider(channel, "text").apiKey) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    setPromptDialog({
      kind: "rewrite",
      title: t("canvasNodes.rewrite"),
      label: t("canvasNodes.rewriteRequirement"),
      initialValue: t("canvasNodes.rewriteDefault"),
      submitLabel: t("canvasNodes.startRewrite"),
    });
  };

  const openImageGenerationDialog = () => {
    if (!isGenerationChannelReady(channel, "image")) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    const continuing = Boolean(node.metadata.content || node.metadata.storageKey);
    setPromptDialog({
      kind: "image",
      title: continuing ? t("canvasNodes.continueImage") : t("canvasNodes.generateImage"),
      label: continuing ? t("canvasNodes.creationRequirement") : t("canvasNodes.imagePrompt"),
      initialValue: continuing ? "" : node.metadata.prompt || "cinematic still",
      placeholder: continuing ? t("canvasNodes.continueImagePlaceholder") : t("canvasNodes.imagePromptPlaceholder"),
      submitLabel: continuing ? t("canvasNodes.generateNewImage") : t("canvasNodes.generateImage"),
    });
  };

  const openVideoGenerationDialog = () => {
    if (!channel || !getProvider(channel, "video").apiKey) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    setPromptDialog({
      kind: "video",
      title: t("canvasNodes.generateVideo"),
      label: t("canvasNodes.videoPrompt"),
      initialValue: node.type === "text"
        ? node.metadata.content || "cinematic short clip"
        : node.metadata.prompt || "cinematic short clip",
      submitLabel: t("canvasNodes.generateVideo"),
    });
  };

  const openAudioGenerationDialog = () => {
    if (!isGenerationChannelReady(channel, "audio")) {
      toast.warn(t("canvasNodes.apiKeyRequired"));
      return;
    }
    setPromptDialog({
      kind: "audio",
      title: t("canvasNodes.generateSpeech"),
      label: t("canvasNodes.speechText"),
      initialValue: node.metadata.prompt || node.metadata.content || t("canvasNodes.defaultSpeechText"),
      submitLabel: t("canvasNodes.generateSpeech"),
    });
  };

  const submitPromptDialog = (value: string) => {
    const kind = promptDialog?.kind;
    setPromptDialog(null);
    if (kind === "rewrite") void rewriteText(value);
    if (kind === "image") void continueFromImage(value);
    if (kind === "video") void generateOnVideo(value);
    if (kind === "audio") void generateOnAudio(value);
  };

  const imageToolbarPreferences = normalizeImageToolbarPreferences(config.imageToolbar);
  const imageHasSource = hasImageSource(node);
  const imageToolbarActions = orderedVisibleImageActions(imageToolbarPreferences).filter(
    (action) => action !== "generate" || shouldShowImageGenerationAction(node),
  );
  const panoramaToolbarActions = orderedVisiblePanoramaActions(imageToolbarPreferences);
  const imageToolLabel = (label: string) => imageToolbarPreferences.showLabels ? label : undefined;
  const renderImageToolbarAction = (action: ImageToolbarAction) => {
    switch (action) {
      case "generate":
        return <IconBtn key={action} label={imageToolLabel(imageHasSource ? t("canvasNodes.continueShort") : t("canvasNodes.generate"))} title={node.metadata.status === "loading" && node.metadata.generationJobId ? t("canvasNodes.cancelGeneration") : imageHasSource ? t("canvasNodes.continueImage") : t("canvasNodes.generateImage")} onClick={() => void (node.metadata.status === "loading" && node.metadata.generationJobId ? cancelNodeGeneration() : openImageGenerationDialog())}>{node.metadata.status === "loading" && node.metadata.generationJobId ? <Square size={14} /> : <Sparkles size={14} />}</IconBtn>;
      case "video":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.video"))} title={t("canvasNodes.generateVideo")} onClick={openVideoGenerationDialog}><span className="text-[10px] font-semibold">{t("canvasNodes.video")}</span></IconBtn>;
      case "reverse":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.reverseShort"))} title={t("canvasNodes.reversePrompt")} onClick={() => void reversePrompt()}><Type size={14} /></IconBtn>;
      case "crop":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.crop"))} title={t("canvasNodes.crop")} onClick={() => setCropOpen(true)}><Crop size={14} /></IconBtn>;
      case "rotate":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.rotate"))} title={t("canvasNodes.rotate90")} onClick={() => void (async () => {
          try { placeRight([await makeRotatedNode(node, 90)]); }
          catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
        })()}><RotateCw size={14} /></IconBtn>;
      case "angle":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.multiAngle"))} title={t("canvasNodes.multiAngle")} onClick={() => setAngleOpen(true)}><span className="text-[10px] font-semibold">{t("canvasNodes.angleShort")}</span></IconBtn>;
      case "mask":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.mask"))} title={t("canvasNodes.maskEdit")} onClick={() => setImageTool("mask")}><span className="text-[10px] font-semibold">{t("canvasNodes.mask")}</span></IconBtn>;
      case "resize":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.localUpscale"))} title={t("canvasNodes.localSizeUpscale")} onClick={() => setImageTool("resize")}><span className="text-[10px] font-semibold">{t("canvasNodes.sizeShort")}</span></IconBtn>;
      case "ai-upscale": {
        const available = transformRegistry.forCapability("upscale").some((provider) => provider.kind === "cloud");
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.aiUpscale"))} title={available ? t("canvasNodes.aiUpscale") : t("canvasNodes.aiUpscaleUnavailable")} disabled={!available} onClick={() => setImageTool("ai-upscale")}><span className="text-[10px] font-semibold">{t("canvasNodes.aiUpscale")}</span></IconBtn>;
      }
      case "split":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.split"))} title={t("canvasNodes.split")} onClick={() => setImageTool("split")}><span className="text-[10px] font-semibold">{t("canvasNodes.split")}</span></IconBtn>;
      case "copy":
        return <IconBtn key={action} label={imageToolLabel(imageCopyState === "copied" ? t("canvasNodes.copied") : t("canvasNodes.copy"))} title={imageCopyState === "copying" ? t("canvasNodes.copyingImage") : imageCopyState === "copied" ? t("canvasNodes.imageCopied") : imageCopyState === "error" ? t("canvasNodes.copyRetry") : t("canvasNodes.copyImage")} disabled={imageCopyState === "copying" || (!node.metadata.content && !node.metadata.storageKey)} onClick={() => void copyImageNode()}>{imageCopyState === "copied" ? <BookmarkCheck size={14} /> : <Copy size={14} />}</IconBtn>;
      case "download":
        return <IconBtn key={action} label={imageToolLabel(t("canvasNodes.download"))} title={t("canvasNodes.download")} onClick={() => void downloadNode()}><Download size={14} /></IconBtn>;
      case "aspect":
        return <IconBtn key={action} label={imageToolLabel(node.metadata.freeResize ? t("canvasNodes.free") : t("canvasNodes.proportional"))} title={node.metadata.freeResize ? t("canvasNodes.lockAspect") : t("canvasNodes.freeResize")} onClick={() => updateNode(node.id, { metadata: { freeResize: !node.metadata.freeResize } })}><span className="text-[10px] font-semibold">{node.metadata.freeResize ? t("canvasNodes.free") : t("canvasNodes.proportional")}</span></IconBtn>;
    }
  };

  if (inlineConfigOnly) {
    if (node.type !== "config") return null;
    const loading = configGenerating || node.metadata.status === "loading";
    const cancellable = loading && Boolean(node.metadata.generationJobId);
    return (
      <button
        type="button"
        className="ob-btn-primary mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs"
        data-canvas-control
        aria-label={cancellable ? t("canvasNodes.stopConfigGeneration") : t("canvasNodes.configGeneration")}
        aria-busy={loading}
        disabled={loading && !cancellable}
        title={cancellable ? t("canvasNodes.stopCurrentGeneration") : loading ? t("canvasNodes.generating") : node.metadata.generationOutputRootId ? t("canvasNodes.regenerateBatchTitle") : t("canvasNodes.generateBatchTitle")}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => void (cancellable ? cancelNodeGeneration() : runConfigGenerate())}
      >
        {cancellable ? <Square size={13} /> : <Sparkles size={13} />}
        {cancellable ? t("canvasNodes.stopGeneration") : loading ? t("canvasNodes.generatingEllipsis") : node.metadata.generationOutputRootId ? t("canvasNodes.regenerateBatch") : t("canvasNodes.generate")}
      </button>
    );
  }

  return (
    <>
      <div
        data-canvas-control
        className={`ob-chrome absolute left-0 z-30 flex w-[min(360px,calc(100vw-1.5rem))] flex-wrap items-center gap-0.5 overflow-hidden p-1 ${
          avoidTopToolbarOverlap ? "top-12" : "bottom-full mb-8"
        }`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {node.type === "text" ? (
          <>
            <IconBtn title={t("canvasNodes.editText")} onClick={() => onEditText?.()}>
              <Type size={14} />
            </IconBtn>
            <IconBtn title={t("canvasNodes.rewrite")} onClick={openRewriteDialog}>
              <Wand2 size={14} />
            </IconBtn>
            <IconBtn title={t("canvasNodes.textToImage")} onClick={() => void textToImage()}>
              <ImagePlus size={14} />
            </IconBtn>
            <IconBtn title={t("canvasNodes.generateVideo")} onClick={openVideoGenerationDialog}>
              <Sparkles size={14} />
            </IconBtn>
            <IconBtn
              title={t("canvasNodes.decreaseFont")}
              onClick={() =>
                updateNode(node.id, {
                  metadata: { fontSize: adjustFontSize(node.metadata.fontSize, -2) },
                })
              }
            >
              <Minus size={14} />
            </IconBtn>
            <IconBtn
              title={t("canvasNodes.increaseFont")}
              onClick={() =>
                updateNode(node.id, {
                  metadata: { fontSize: adjustFontSize(node.metadata.fontSize, 2) },
                })
              }
            >
              <Plus size={14} />
            </IconBtn>
          </>
        ) : null}
        {node.type === "image" ? (
          <>
            {imageToolbarActions.map(renderImageToolbarAction)}
            {canRetryImageResult(node.metadata) ? (
              <IconBtn
                label={imageToolLabel(t("canvasNodes.retry"))}
                title={t("canvasNodes.retryOriginal")}
                onClick={() => void retryImageResult()}
              >
                <RotateCw size={14} />
              </IconBtn>
            ) : null}
          </>
        ) : null}
        {node.type === "panorama" ? panoramaToolbarActions.map(renderImageToolbarAction) : null}
        {node.type === "video" ? (
          <>
			<IconBtn
				title={node.metadata.status === "loading" && node.metadata.generationJobId ? t("canvasNodes.cancelGeneration") : t("canvasNodes.generateVideo")}
				onClick={() => void (node.metadata.status === "loading" && node.metadata.generationJobId ? cancelNodeGeneration() : openVideoGenerationDialog())}
			>
			  {node.metadata.status === "loading" && node.metadata.generationJobId ? <Square size={14} /> : <Sparkles size={14} />}
			</IconBtn>
            <IconBtn title={t("canvasNodes.download")} onClick={() => void downloadNode()}>
              <Download size={14} />
            </IconBtn>
          </>
        ) : null}
        {node.type === "audio" ? (
          <>
			<IconBtn
				title={node.metadata.status === "loading" && node.metadata.generationJobId ? t("canvasNodes.cancelGeneration") : t("canvasNodes.speechGeneration")}
				onClick={() => void (node.metadata.status === "loading" && node.metadata.generationJobId ? cancelNodeGeneration() : openAudioGenerationDialog())}
			>
			  {node.metadata.status === "loading" && node.metadata.generationJobId ? <Square size={14} /> : <Sparkles size={14} />}
			</IconBtn>
            <IconBtn title={t("canvasNodes.download")} onClick={() => void downloadNode()}>
              <Download size={14} />
            </IconBtn>
          </>
        ) : null}
        {cameraAvailable ? (
          <span ref={cameraAnchorRef} className="inline-flex">
            <IconBtn
              title={node.metadata.cameraPrompt?.enabled ? t("canvasNodes.cameraEnabled") : t("canvasNodes.camera")}
              onClick={() => setCameraOpen((open) => !open)}
            >
              <Camera size={14} className={node.metadata.cameraPrompt?.enabled ? "text-[var(--ob-accent)]" : undefined} />
            </IconBtn>
          </span>
        ) : null}
        {(node.type === "text" || node.type === "image") && (
          <IconBtn
            title={node.type === "image" && !node.metadata.content
              ? t("canvasNodes.assetNotReady")
              : assetSaveState === "saving"
                ? t("canvasNodes.assetSaving")
                : assetSaveState === "saved"
                  ? t("canvasNodes.assetSaved")
                  : assetSaveState === "error"
                    ? t("canvasNodes.assetSaveFailed")
                    : t("canvasNodes.addAsset")}
            disabled={(node.type === "image" && !node.metadata.content) || assetSaveState === "saving"}
            onClick={() => void (async () => {
              setAssetSaveState("saving");
              try {
                await addAssetFromNode(node.id);
                setAssetSaveState("saved");
              } catch {
                setAssetSaveState("error");
              }
            })()}
          >
            {assetSaveState === "saved" ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}
          </IconBtn>
        )}
        <IconBtn title={t("canvasNodes.nodeInfo")} onClick={inspect}>
          <Info size={14} />
        </IconBtn>
      </div>

      {cameraAvailable && cameraOpen ? (
        <CameraPromptPanel
          value={node.metadata.cameraPrompt ?? createDefaultCameraPrompt()}
          anchor={cameraAnchorRef.current}
          onClose={() => setCameraOpen(false)}
          onChange={(cameraPrompt) => updateNode(node.id, { metadata: { cameraPrompt } })}
        />
      ) : null}

      <NodeInfoDialog open={infoOpen} node={node} onClose={() => setInfoOpen(false)} />
      {promptDialog ? (
        <TextEntryDialog
          open
          title={promptDialog.title}
          label={promptDialog.label}
          initialValue={promptDialog.initialValue}
          placeholder={promptDialog.placeholder}
          submitLabel={promptDialog.submitLabel}
          multiline={promptDialog.multiline}
          onClose={() => setPromptDialog(null)}
          onSubmit={submitPromptDialog}
        />
      ) : null}

      {node.type === "image" ? (
        <CropDialog
          node={node}
          open={cropOpen}
          onClose={() => setCropOpen(false)}
          onConfirm={(crop) => {
            void (async () => {
              try {
                const created = await makeCroppedNode(node, crop);
                placeRight([created]);
                setCropOpen(false);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            })();
          }}
        />
      ) : null}
      {node.type === "image" ? (
        <AngleDialog
          node={node}
          open={angleOpen}
          onClose={() => setAngleOpen(false)}
          onConfirm={(degrees) => {
            void (async () => {
              try {
                const created = await makeRotatedNode(node, degrees);
                placeRight([created]);
                setAngleOpen(false);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            })();
          }}
        />
      ) : null}
      {node.type === "image" && imageTool ? (
        <ImageToolsDialog
          node={node}
          mode={imageTool}
          open
          providers={transformProviderOptions}
          onClose={() => setImageTool(null)}
          onMask={async (mask, keep, providerId, prompt, context) => {
            const provider = transformRegistry.get(providerId);
            if (!provider) throw new Error(t("canvasNodes.imageProcessorUnavailable"));
            const source = await resolveNodeImageTransformSource(node, context.signal);
            const isCloud = provider.capabilities.inpaint;
            const result = isCloud
              ? await provider.inpaint?.({
                  image: source.blob,
                  mask: await createRectEditMaskBlob(source.width, source.height, mask),
                  prompt: applySystemPrompt(config.systemPrompt, prompt),
                  width: source.width,
                  height: source.height,
                }, context)
              : await provider.mask?.({
                  image: source.blob,
                  rect: mask,
                  mode: keep ? "keep" : "remove",
                  width: source.width,
                  height: source.height,
                }, context);
            if (!result) throw new Error(t("canvasNodes.operationUnsupported"));
            const uploaded = await uploadDisplayMedia(result.blob, "image");
            const display = fitMediaDisplaySize(
              uploaded.width || node.width,
              uploaded.height || node.height,
              120,
              360,
            );
            placeRight([
              createNode(
                "image",
                { x: node.position.x + node.width + 48, y: node.position.y },
                {
                  title: `${node.title} · ${isCloud ? t("canvasNodes.inpaint") : t("canvasNodes.mask")}`,
                  metadata: {
                    ...displayMediaNodeFields(uploaded),
                    status: "success",
                    ...createTransformLineage(node.id, isCloud ? "inpaint" : "mask", result, {
                      x: mask.x,
                      y: mask.y,
                      width: mask.w,
                      height: mask.h,
                      ...(isCloud ? { prompt } : { mode: keep ? "keep" : "remove" }),
                    }),
                  },
                  width: display.width,
                  height: display.height,
                },
              ),
            ]);
            setImageTool(null);
            await persistNow();
          }}
          onUpscale={async (scale, providerId, operation, context) => {
            const provider = transformRegistry.get(providerId);
            if (!provider?.upscale) throw new Error(t("canvasNodes.upscaleUnsupported"));
            const source = await resolveNodeImageTransformSource(node, context.signal);
            const result = await provider.upscale({
              image: source.blob,
              scale,
              width: source.width,
              height: source.height,
            }, context);
            const uploaded = await uploadDisplayMedia(result.blob, "image");
            const display = fitMediaDisplaySize(
              uploaded.width || node.width,
              uploaded.height || node.height,
            );
            placeRight([
              createNode(
                "image",
                { x: node.position.x + node.width + 48, y: node.position.y },
                {
                  title: `${node.title} · ${operation === "ai-upscale" ? t("canvasNodes.aiUpscale") : t("canvasNodes.localUpscale")} ${scale}x`,
                  metadata: {
                    ...displayMediaNodeFields(uploaded),
                    status: "success",
                    ...createTransformLineage(node.id, operation, result, { scale }),
                  },
                  width: display.width,
                  height: display.height,
                },
              ),
            ]);
            setImageTool(null);
            await persistNow();
          }}
          onSplit={async (vertical, horizontal) => {
            const created = await splitImageByGuides(node, vertical, horizontal);
            placeRight(created);
            setImageTool(null);
            await persistNow();
          }}
        />
      ) : null}
    </>
  );
}

function IconBtn({
  title,
  label,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  label?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`ob-icon-btn h-8 rounded-md ${label ? "w-auto gap-1 px-2" : "w-8"}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {children}
      {label ? <span className="text-[10px] font-medium">{label}</span> : null}
    </button>
  );
}
