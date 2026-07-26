import { useMemo, useRef, useState } from "react";
import type { BoardNode } from "@/types/board";
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
import {
  assertResolvedImageReferences,
  createImageGenerationMetadata,
} from "@/lib/image-generation";
import { normalizeVideoFrameMode, resolveVideoDuration } from "@/lib/video-generation";
import { applyCameraPrompt, createDefaultCameraPrompt } from "@/lib/camera-prompt";
import { applyServerImagePlaceholders } from "@/lib/canvas-server-image";
import { audioJobParameters, audioSpeechOptions } from "@/lib/audio-generation";
import { NodeInfoDialog } from "@/components/canvas/NodeInfoDialog";
import { isServerManagedChannel, mergeSharedChannelChoices, useSharedChannels } from "@/services/shared-channels";
import {
  normalizeImageToolbarPreferences,
  orderedVisibleImageActions,
  type ImageToolbarAction,
} from "@/lib/image-toolbar-preferences";
import { CameraPromptPanel } from "@/components/canvas/CameraPromptPanel";
import {
  BookmarkPlus,
  BookmarkCheck,
  Camera,
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

export function NodeActions({
  node,
  onEditText,
  avoidTopToolbarOverlap = false,
}: {
  node: BoardNode;
  onEditText?: () => void;
  avoidTopToolbarOverlap?: boolean;
}) {
  const project = useBoardStore((s) => s.getActive());
  const config = useBoardStore((s) => s.config);
  const updateNode = useBoardStore((s) => s.updateNode);
  const updateActive = useBoardStore((s) => s.updateActive);
  const addAssetFromNode = useBoardStore((s) => s.addAssetFromNode);
	const persistNow = useBoardStore((s) => s.persistNow);
  const [cropOpen, setCropOpen] = useState(false);
  const [angleOpen, setAngleOpen] = useState(false);
  const [imageTool, setImageTool] = useState<ImageToolMode | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [assetSaveState, setAssetSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const cameraAnchorRef = useRef<HTMLSpanElement>(null);
	const sharedChannels = useSharedChannels();
	const channelChoices = useMemo(() => mergeSharedChannelChoices(config.channels, sharedChannels), [config.channels, sharedChannels]);
  const channel =
		(config.activeSharedChannelId ? channelChoices.find((c) => c.id === config.activeSharedChannelId) : undefined) ??
    config.channels.find((c) => c.id === config.activeChannelId) ??
    config.channels[0];
  const cameraAvailable = node.type === "image" || node.type === "video" ||
    (node.type === "config" && (node.metadata.generationMode ?? "image") !== "text");
  const promptForGeneration = (prompt: string) => applyCameraPrompt(prompt, node.metadata.cameraPrompt);
	const serverProviderSupported = (kind: "image" | "video" | "audio") => {
		if (!channel || !usesServerGenerationJobs()) return false;
		const provider = getProvider(channel, kind);
		if (kind === "image") return provider.protocol === "openai" || provider.protocol === "gemini" ||
			(provider.protocol === "template" && Boolean(provider.template)) || provider.protocol === "apimart" || provider.protocol === "kie";
		if (kind === "audio") return provider.protocol === "openai";
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
	) => {
		if (!channel) throw new Error("图片生成渠道不可用");
		const provider = getProvider(channel, "image");
		if (provider.protocol === "gemini" && generation.transparentBackground) {
			throw new Error("Gemini 图片生成不支持透明背景");
		}
		if (provider.protocol === "template" && generation.transparentBackground && !provider.template?.supportsTransparentBackground) {
			throw new Error("当前图片模板不支持透明背景");
		}
		const job = await createServerImageGenerationJob({
			projectId: project?.id,
			prompt,
			providerId: channel.id,
			model: generation.model,
			parameters: {
				size: generation.size,
				quality: generation.quality,
				count: generation.count,
				transparentBackground: generation.transparentBackground,
				referenceStorageKeys,
			},
		});
		try {
			updateActive((current) => applyServerImagePlaceholders(current, rootId, job.id, generation));
			await persistNow();
		} catch (error) {
			await cancelServerGenerationJob(job.id).catch(() => undefined);
			throw error;
		}
		return job;
	};
	const cancelNodeGeneration = async () => {
		const jobId = node.metadata.generationJobId;
		if (!jobId) return;
		try {
			const job = await cancelServerGenerationJob(jobId);
			updateNode(node.id, { metadata: {
				status: "error",
				errorDetails: job.error || "已取消",
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
        ? `${provider.label} · 透明遮罩`
        : provider.label,
      kind: provider.kind,
    }));
  }, [imageTool, transformRegistry]);

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
    if (created.length <= 1) {
      updateActive((project) => ({
        ...project,
        nodes: [
          ...project.nodes.map((item) => item.id === rootId
            ? {
                ...item,
                metadata: {
                  ...item.metadata,
                  ...generation,
                  status: "success" as const,
                  errorDetails: undefined,
                },
              }
            : item),
          ...created,
        ],
        edges: [
          ...project.edges,
          ...created.map((item) => ({ id: uid("edge"), from: rootId, to: item.id })),
        ],
      }));
      return;
    }
    updateActive((project) => {
      const childIds = created.map((item) => item.id);
      return {
        ...project,
        nodes: [
          ...project.nodes.map((item) => item.id === rootId
            ? {
                ...item,
                metadata: {
                  ...item.metadata,
                  ...generation,
                  status: "success" as const,
                  isBatchRoot: true,
                  batchChildIds: [...(item.metadata.batchChildIds ?? []), ...childIds],
                  primaryImageId: item.metadata.primaryImageId ?? childIds[0],
                  imageBatchExpanded: true,
                },
              }
            : item),
          ...created.map((item) => ({
            ...item,
            metadata: { ...item.metadata, batchRootId: rootId },
          })),
        ],
        edges: [
          ...project.edges,
          ...created.map((item) => ({ id: uid("edge"), from: rootId, to: item.id })),
        ],
      };
    });
  };

  const runConfigGenerate = async () => {
    const mode = node.metadata.generationMode ?? "image";
    if (!channel || !getProvider(channel, mode === "text" ? "text" : mode === "video" ? "video" : "image").apiKey) {
      alert("请先在设置中配置对应模型服务的 API Key");
      return;
    }
    const { texts, imageKeys, images } = upstream();
    const prompt =
      texts.join("\n\n") || node.metadata.prompt || node.metadata.content || "";
    if (!prompt && mode !== "image") {
      alert("需要上游文本或节点内提示词");
      return;
    }
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
          count: node.metadata.count || 1,
        });
        const created = outputs.map((content, index) => createNode(
          "text",
          {
            x: node.position.x + node.width + 60,
            y: node.position.y + index * 40,
          },
          { metadata: { content, model, prompt, status: "success" } },
        ));
        placeRight(created);
      } else if (mode === "image") {
        const generation = createImageGenerationMetadata({
          prompt: prompt || "a clean product photo",
          model: node.metadata.model || getProvider(channel, "image").model,
          size: node.metadata.size || config.imageSize,
          quality: node.metadata.quality || config.imageQuality,
          count: node.metadata.count || config.imageCount,
          transparentBackground: Boolean(node.metadata.transparentBackground),
          referenceStorageKeys: imageKeys,
          cameraPrompt: node.metadata.cameraPrompt,
        });
        const materializedImages = images.filter((image) => image.storageKey || image.content);
        if (serverProviderSupported("image") && imageKeys.length === materializedImages.length) {
          await startServerImageGeneration(node.id, generation, promptForGeneration(generation.prompt), imageKeys);
          return;
        }
        const refs = await resolveNodeImageDataUrls(imageKeys);
        assertResolvedImageReferences(imageKeys, refs);
      const urls = await generateImages({
          channel,
          model: generation.model,
          prompt: promptForGeneration(generation.prompt),
          size: generation.size,
          quality: generation.quality,
          n: generation.count,
          referenceDataUrls: refs,
          transparentBackground: generation.transparentBackground,
          systemPrompt: config.systemPrompt,
        });
        const created: BoardNode[] = [];
        for (const [i, url] of urls.entries()) {
          const uploaded = await uploadMedia(url, "image");
          created.push(
            createNode(
              "image",
              {
                x: node.position.x + node.width + 60,
                y: node.position.y + i * 40,
              },
              {
                metadata: {
                  content: uploaded.url,
                  storageKey: uploaded.storageKey,
                  naturalWidth: uploaded.width,
                  naturalHeight: uploaded.height,
                  bytes: uploaded.bytes,
                  mimeType: uploaded.mimeType,
                  status: "success",
                  cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
                  ...generation,
                },
                width: Math.min(360, uploaded.width || 320),
                height: Math.min(360, uploaded.height || 320),
              },
            ),
          );
        }
        placeImageBatch(node.id, created, generation);
      } else {
		const { images, videos, audios, imageKeys, videoKeys, audioKeys } = upstream();
		const referenceCount = images.filter((value) => value.storageKey || value.content).length +
			videos.filter((value) => value.storageKey || value.content).length +
			audios.filter((value) => value.storageKey || value.content).length;
		const referenceStorageKeys = [...imageKeys, ...videoKeys, ...audioKeys];
		if (serverProviderSupported("video") && referenceStorageKeys.length === referenceCount) {
			const job = await createServerVideoGenerationJob({
				projectId: project?.id,
				prompt: promptForGeneration(prompt),
				providerId: channel.id,
				model: node.metadata.model || getProvider(channel, "video").model,
				parameters: {
					size: node.metadata.size,
					seconds: resolveVideoDuration(Boolean(node.metadata.smartDuration), node.metadata.duration ?? 5),
					ratio: node.metadata.videoRatio || "16:9",
					resolution: node.metadata.resolution || "720p",
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
          seconds: resolveVideoDuration(
            Boolean(node.metadata.smartDuration),
            node.metadata.duration ?? 5,
          ),
          ratio: node.metadata.videoRatio || "16:9",
          resolution: node.metadata.resolution || "720p",
          generateAudio: Boolean(node.metadata.generateAudio),
          watermark: Boolean(node.metadata.watermark),
          frameMode: normalizeVideoFrameMode(node.metadata.videoFrameMode),
          referenceImages,
          referenceVideos,
          referenceAudios,
        });
        let content = result.url;
        let storageKey: string | undefined;
        if (content?.startsWith("blob:") || content?.startsWith("data:")) {
          const uploaded = await uploadMedia(content, "media");
          content = uploaded.url;
          storageKey = uploaded.storageKey;
        } else if (content && /^https?:\/\//i.test(content)) {
          try {
            const uploaded = await uploadMedia(content, "media");
            content = uploaded.url;
            storageKey = uploaded.storageKey;
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
    }
  };

  const textToImage = async () => {
    const cfg = createNode(
      "config",
      { x: node.position.x + node.width + 60, y: node.position.y },
      {
        metadata: {
          generationMode: "image",
          prompt: node.metadata.content,
          status: "loading",
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
    try {
      if (!channel || !getProvider(channel, "image").apiKey) {
        throw new Error("请先在设置中配置图片模型服务的 API Key");
      }
      const prompt = node.metadata.content?.trim() || "a clean product photo";
      const generation = createImageGenerationMetadata({
        prompt,
        model: getProvider(channel, "image").model,
        size: cfg.metadata.size || config.imageSize,
        quality: config.imageQuality,
        count: cfg.metadata.count || config.imageCount,
        transparentBackground: Boolean(cfg.metadata.transparentBackground),
        referenceStorageKeys: [],
        cameraPrompt: node.metadata.cameraPrompt,
      });
      if (serverProviderSupported("image")) {
        await startServerImageGeneration(cfg.id, generation, promptForGeneration(generation.prompt), []);
        return;
      }
      const urls = await generateImages({
        channel,
        model: generation.model,
        prompt: promptForGeneration(generation.prompt),
        size: generation.size,
        quality: generation.quality,
        n: generation.count,
        transparentBackground: generation.transparentBackground,
        systemPrompt: config.systemPrompt,
      });
      const created: BoardNode[] = [];
      for (const [index, url] of urls.entries()) {
        const uploaded = await uploadMedia(url, "image");
        created.push(createNode(
          "image",
          { x: cfg.position.x + cfg.width + 60, y: cfg.position.y + index * 40 },
          {
            metadata: {
              content: uploaded.url,
              storageKey: uploaded.storageKey,
              naturalWidth: uploaded.width,
              naturalHeight: uploaded.height,
              bytes: uploaded.bytes,
              mimeType: uploaded.mimeType,
              status: "success",
              ...generation,
            },
            width: Math.min(360, uploaded.width || 320),
            height: Math.min(360, uploaded.height || 320),
          },
        ));
      }
      placeImageBatch(cfg.id, created, generation);
    } catch (error) {
      updateNode(cfg.id, {
        metadata: {
          status: "error",
          errorDetails: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const rewriteText = async () => {
    if (!channel || !getProvider(channel, "text").apiKey) {
      alert("请先在设置中配置 API Key");
      return;
    }
    const instruction = window.prompt("希望如何改写这段文本？", "更具体、更适合生图");
    if (!instruction) return;
    updateNode(node.id, { metadata: { status: "loading" } });
    try {
      const out = await generateText({
        channel,
        model: node.metadata.model || getProvider(channel, "text").model,
        prompt: `原文本：\n${node.metadata.content ?? ""}\n\n改写要求：${instruction}`,
        systemPrompt: config.systemPrompt,
      });
      if (!node.metadata.content) {
        updateNode(node.id, { metadata: { content: out, status: "success" } });
      } else {
        const created = createNode(
          "text",
          { x: node.position.x + node.width + 60, y: node.position.y },
          { metadata: { content: out, status: "success" } },
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

  const generateOnImage = async () => {
    if (!channel || !getProvider(channel, "image").apiKey) {
      alert("请先在设置中配置 API Key");
      return;
    }
    const prompt =
      window.prompt("生图提示词", node.metadata.prompt || "cinematic still") || "";
    if (!prompt) return;
    updateNode(node.id, { metadata: { status: "loading", prompt } });
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
        cameraPrompt: node.metadata.cameraPrompt,
      });
      if (serverProviderSupported("image") && (!node.metadata.content || referenceStorageKeys.length === 1)) {
        await startServerImageGeneration(node.id, generation, promptForGeneration(generation.prompt), referenceStorageKeys);
        return;
      }
      const refs = await resolveNodeImageDataUrls(referenceStorageKeys);
      assertResolvedImageReferences(referenceStorageKeys, refs);
        const urls = await generateImages({
        channel,
        model: generation.model,
        prompt: promptForGeneration(generation.prompt),
        size: generation.size,
        quality: generation.quality,
        n: generation.count,
        referenceDataUrls: refs,
        transparentBackground: generation.transparentBackground,
        systemPrompt: config.systemPrompt,
      });
      if (urls.length === 1 && !node.metadata.content) {
        const uploaded = await uploadMedia(urls[0], "image");
        updateNode(node.id, {
          metadata: {
            content: uploaded.url,
            storageKey: uploaded.storageKey,
            naturalWidth: uploaded.width,
            naturalHeight: uploaded.height,
            bytes: uploaded.bytes,
            mimeType: uploaded.mimeType,
            status: "success",
            cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
            ...generation,
          },
        });
      } else {
        const created: BoardNode[] = [];
        for (const [i, url] of urls.entries()) {
          const uploaded = await uploadMedia(url, "image");
          created.push(
            createNode(
              "image",
              {
                x: node.position.x + node.width + 60,
                y: node.position.y + i * 36,
              },
              {
                metadata: {
                  content: uploaded.url,
                  storageKey: uploaded.storageKey,
                  status: "success",
                  cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
                  ...generation,
                },
              },
            ),
          );
        }
        if (created.length > 1) {
          updateActive((p) => {
            const childIds = created.map((c) => c.id);
            return {
              ...p,
              nodes: [
                ...p.nodes.map((n) =>
                  n.id === node.id
                    ? {
                        ...n,
                        metadata: {
                          ...n.metadata,
                          isBatchRoot: true,
                          batchChildIds: childIds,
                          primaryImageId: childIds[0],
                          imageBatchExpanded: true,
                          status: "success" as const,
                          ...generation,
                        },
                      }
                    : n,
                ),
                ...created.map((c) => ({
                  ...c,
                  metadata: { ...c.metadata, batchRootId: node.id },
                })),
              ],
              edges: [
                ...p.edges,
                ...created.map((c) => ({
                  id: uid("edge"),
                  from: node.id,
                  to: c.id,
                })),
              ],
            };
          });
        } else {
          placeRight(created);
          updateNode(node.id, { metadata: { status: "success", ...generation } });
        }
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

  const reversePrompt = async () => {
    if (!channel || !getProvider(channel, "text").apiKey) {
      alert("请先在设置中配置文本视觉模型服务的 API Key");
      return;
    }
    updateNode(node.id, { metadata: { status: "loading", errorDetails: undefined } });
    try {
      const image = await resolveNodeImageDataUrl(
        node.metadata.storageKey,
        node.metadata.content,
      );
      const images = image ? [image] : [];
      if (!images.length) throw new Error("当前图片没有可读取的内容");
      const text = await generateText({
        channel,
        model: getProvider(channel, "text").model,
        prompt: "分析这张图片并输出可复现其主体、构图、光线、色彩和风格的详细生图提示词。只输出提示词。",
        images,
        systemPrompt: config.systemPrompt,
      });
      const created = createNode(
        "text",
        { x: node.position.x + node.width + 60, y: node.position.y },
        { title: "反推提示词", metadata: { content: text, status: "success" } },
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

  const generateOnVideo = async () => {
    if (!channel || !getProvider(channel, "video").apiKey) {
      alert("请先在设置中配置 API Key");
      return;
    }
    const prompt =
      window.prompt(
        "视频提示词",
        node.type === "text"
          ? node.metadata.content || "cinematic short clip"
          : node.metadata.prompt || "cinematic short clip",
      ) ||
      "";
    if (!prompt) return;
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
		if (serverProviderSupported("video") && referenceStorageKeys.length === materializedRefs.length) {
			const job = await createServerVideoGenerationJob({
				projectId: project?.id,
				prompt: promptForGeneration(prompt),
				providerId: channel.id,
				model: node.metadata.model || getProvider(channel, "video").model,
				parameters: {
					size: node.metadata.size,
					seconds: resolveVideoDuration(Boolean(node.metadata.smartDuration), node.metadata.duration ?? 5),
					ratio: node.metadata.videoRatio || "16:9",
					resolution: node.metadata.resolution || "720p",
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
        throw new Error("当前图片参考内容不可用，请重新导入图片后再生成视频");
      }
      const result = await generateVideo({
        channel,
        model: node.metadata.model || getProvider(channel, "video").model,
        prompt: promptForGeneration(prompt),
        size: node.metadata.size,
        seconds: resolveVideoDuration(
          Boolean(node.metadata.smartDuration),
          node.metadata.duration ?? 5,
        ),
        ratio: node.metadata.videoRatio || "16:9",
        resolution: node.metadata.resolution || "720p",
        generateAudio: Boolean(node.metadata.generateAudio),
        watermark: Boolean(node.metadata.watermark),
        frameMode: normalizeVideoFrameMode(node.metadata.videoFrameMode),
        referenceImages,
        referenceVideos,
        referenceAudios,
      });
      let content = result.url;
      let storageKey: string | undefined;
      if (content?.startsWith("blob:") || content?.startsWith("data:")) {
        const uploaded = await uploadMedia(content, "media");
        content = uploaded.url;
        storageKey = uploaded.storageKey;
      } else if (content && /^https?:\/\//i.test(content)) {
        try {
          const uploaded = await uploadMedia(content, "media");
          content = uploaded.url;
          storageKey = uploaded.storageKey;
        } catch {
          // keep remote
        }
      }
      if (node.type === "video" && !node.metadata.content) {
        updateNode(node.id, {
          metadata: {
            content,
            storageKey,
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
      alert("没有可下载的文件");
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
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const inspect = () => setInfoOpen(true);

  const generateOnAudio = async () => {
    if (!channel || !getProvider(channel, "audio").apiKey) {
      alert("请先在设置中配置 API Key");
      return;
    }
    const prompt =
      window.prompt("语音文本", node.metadata.prompt || node.metadata.content || "你好，OpenBoard") ||
      "";
    if (!prompt) return;
    updateNode(node.id, { metadata: { status: "loading", prompt, errorDetails: undefined } });
    try {
		if (serverProviderSupported("audio")) {
			const job = await createServerAudioGenerationJob({
				projectId: project?.id,
				prompt,
				providerId: channel.id,
				model: node.metadata.model || getProvider(channel, "audio").model,
				parameters: audioJobParameters(node.metadata.voice, config.generationDefaults),
			});
			if (!node.metadata.content) {
				updateNode(node.id, { metadata: { status: "loading", prompt, generationJobId: job.id } });
			} else {
				const placeholder = createNode("audio", { x: node.position.x + node.width + 60, y: node.position.y }, {
					metadata: { status: "loading", prompt, generationJobId: job.id },
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
        ...audioSpeechOptions(node.metadata.voice, config.generationDefaults),
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

  const imageToolbarPreferences = normalizeImageToolbarPreferences(config.imageToolbar);
  const imageToolbarActions = orderedVisibleImageActions(imageToolbarPreferences);
  const imageToolLabel = (label: string) => imageToolbarPreferences.showLabels ? label : undefined;
  const renderImageToolbarAction = (action: ImageToolbarAction) => {
    switch (action) {
      case "generate":
        return <IconBtn key={action} label={imageToolLabel("生成")} title={node.metadata.status === "loading" && node.metadata.generationJobId ? "取消生成" : "生成/重试"} onClick={() => void (node.metadata.status === "loading" && node.metadata.generationJobId ? cancelNodeGeneration() : generateOnImage())}>{node.metadata.status === "loading" && node.metadata.generationJobId ? <Square size={14} /> : <Sparkles size={14} />}</IconBtn>;
      case "video":
        return <IconBtn key={action} label={imageToolLabel("视频")} title="生成视频" onClick={() => void generateOnVideo()}><span className="text-[10px] font-semibold">视频</span></IconBtn>;
      case "reverse":
        return <IconBtn key={action} label={imageToolLabel("反推")} title="反推提示词" onClick={() => void reversePrompt()}><Type size={14} /></IconBtn>;
      case "crop":
        return <IconBtn key={action} label={imageToolLabel("裁剪")} title="裁剪" onClick={() => setCropOpen(true)}><Crop size={14} /></IconBtn>;
      case "rotate":
        return <IconBtn key={action} label={imageToolLabel("旋转")} title="旋转 90°" onClick={() => void (async () => {
          try { placeRight([await makeRotatedNode(node, 90)]); }
          catch (error) { alert(error instanceof Error ? error.message : String(error)); }
        })()}><RotateCw size={14} /></IconBtn>;
      case "angle":
        return <IconBtn key={action} label={imageToolLabel("多角度")} title="多角度" onClick={() => setAngleOpen(true)}><span className="text-[10px] font-semibold">角</span></IconBtn>;
      case "mask":
        return <IconBtn key={action} label={imageToolLabel("遮罩")} title="遮罩/局部编辑" onClick={() => setImageTool("mask")}><span className="text-[10px] font-semibold">罩</span></IconBtn>;
      case "resize":
        return <IconBtn key={action} label={imageToolLabel("本地放大")} title="本地尺寸放大" onClick={() => setImageTool("resize")}><span className="text-[10px] font-semibold">尺寸</span></IconBtn>;
      case "ai-upscale": {
        const available = transformRegistry.forCapability("upscale").some((provider) => provider.kind === "cloud");
        return <IconBtn key={action} label={imageToolLabel("AI 超分")} title={available ? "AI 超分" : "当前渠道不支持 AI 超分"} disabled={!available} onClick={() => setImageTool("ai-upscale")}><span className="text-[10px] font-semibold">超分</span></IconBtn>;
      }
      case "split":
        return <IconBtn key={action} label={imageToolLabel("切分")} title="切分" onClick={() => setImageTool("split")}><span className="text-[10px] font-semibold">切</span></IconBtn>;
      case "download":
        return <IconBtn key={action} label={imageToolLabel("下载")} title="下载" onClick={() => void downloadNode()}><Download size={14} /></IconBtn>;
      case "aspect":
        return <IconBtn key={action} label={imageToolLabel(node.metadata.freeResize ? "自由" : "等比")} title={node.metadata.freeResize ? "锁定比例" : "自由缩放"} onClick={() => updateNode(node.id, { metadata: { freeResize: !node.metadata.freeResize } })}><span className="text-[10px] font-semibold">{node.metadata.freeResize ? "自由" : "等比"}</span></IconBtn>;
    }
  };

return (
    <>
      <div
        className={`ob-chrome absolute left-0 z-30 flex w-[min(360px,calc(100vw-1.5rem))] flex-wrap items-center gap-0.5 overflow-hidden p-1 ${
          avoidTopToolbarOverlap ? "top-12" : "bottom-full mb-8"
        }`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {node.type === "text" ? (
          <>
            <IconBtn title="编辑文字" onClick={() => onEditText?.()}>
              <Type size={14} />
            </IconBtn>
            <IconBtn title="AI 改写" onClick={() => void rewriteText()}>
              <Wand2 size={14} />
            </IconBtn>
            <IconBtn title="生图" onClick={() => void textToImage()}>
              <ImagePlus size={14} />
            </IconBtn>
            <IconBtn title="生成视频" onClick={() => void generateOnVideo()}>
              <Sparkles size={14} />
            </IconBtn>
            <IconBtn
              title="减小字号"
              onClick={() =>
                updateNode(node.id, {
                  metadata: { fontSize: adjustFontSize(node.metadata.fontSize, -2) },
                })
              }
            >
              <Minus size={14} />
            </IconBtn>
            <IconBtn
              title="增大字号"
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
        {node.type === "image" ? imageToolbarActions.map(renderImageToolbarAction) : null}
        {node.type === "video" ? (
          <>
			<IconBtn
				title={node.metadata.status === "loading" && node.metadata.generationJobId ? "取消生成" : "生成视频"}
				onClick={() => void (node.metadata.status === "loading" && node.metadata.generationJobId ? cancelNodeGeneration() : generateOnVideo())}
			>
			  {node.metadata.status === "loading" && node.metadata.generationJobId ? <Square size={14} /> : <Sparkles size={14} />}
			</IconBtn>
            <IconBtn title="下载" onClick={() => void downloadNode()}>
              <Download size={14} />
            </IconBtn>
          </>
        ) : null}
        {node.type === "audio" ? (
          <>
			<IconBtn
				title={node.metadata.status === "loading" && node.metadata.generationJobId ? "取消生成" : "语音生成"}
				onClick={() => void (node.metadata.status === "loading" && node.metadata.generationJobId ? cancelNodeGeneration() : generateOnAudio())}
			>
			  {node.metadata.status === "loading" && node.metadata.generationJobId ? <Square size={14} /> : <Sparkles size={14} />}
			</IconBtn>
            <IconBtn title="下载" onClick={() => void downloadNode()}>
              <Download size={14} />
            </IconBtn>
          </>
        ) : null}
        {node.type === "config" ? (
          <IconBtn
            title={node.metadata.status === "loading" && node.metadata.generationJobId ? "取消生成" : "运行生成"}
            onClick={() => void (node.metadata.status === "loading" && node.metadata.generationJobId ? cancelNodeGeneration() : runConfigGenerate())}
          >
            {node.metadata.status === "loading" && node.metadata.generationJobId ? <Square size={14} /> : <Sparkles size={14} />}
          </IconBtn>
        ) : null}
        {cameraAvailable ? (
          <span ref={cameraAnchorRef} className="inline-flex">
            <IconBtn
              title={node.metadata.cameraPrompt?.enabled ? "摄像机设置（已启用）" : "摄像机设置"}
              onClick={() => setCameraOpen((open) => !open)}
            >
              <Camera size={14} className={node.metadata.cameraPrompt?.enabled ? "text-[var(--ob-accent)]" : undefined} />
            </IconBtn>
          </span>
        ) : null}
        {(node.type === "text" || node.type === "image") && (
          <IconBtn
            title={node.type === "image" && !node.metadata.content
              ? "素材尚未就绪"
              : assetSaveState === "saving"
                ? "正在加入素材"
                : assetSaveState === "saved"
                  ? "已加入素材"
                  : assetSaveState === "error"
                    ? "加入素材失败"
                    : "加入素材"}
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
        <IconBtn title="节点信息" onClick={inspect}>
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
                alert(err instanceof Error ? err.message : String(err));
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
                alert(err instanceof Error ? err.message : String(err));
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
            if (!provider) throw new Error("图像处理方式不可用");
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
            if (!result) throw new Error("所选处理方式不支持此操作");
            const uploaded = await uploadMedia(result.blob, "image");
            placeRight([
              createNode(
                "image",
                { x: node.position.x + node.width + 48, y: node.position.y },
                {
                  title: `${node.title} · ${isCloud ? "局部重绘" : "遮罩"}`,
                  metadata: {
                    content: uploaded.url,
                    storageKey: uploaded.storageKey,
                    naturalWidth: uploaded.width,
                    naturalHeight: uploaded.height,
                    bytes: uploaded.bytes,
                    mimeType: uploaded.mimeType,
                    status: "success",
                    ...createTransformLineage(node.id, isCloud ? "inpaint" : "mask", result, {
                      x: mask.x,
                      y: mask.y,
                      width: mask.w,
                      height: mask.h,
                      ...(isCloud ? { prompt } : { mode: keep ? "keep" : "remove" }),
                    }),
                  },
                  width: Math.min(360, uploaded.width || node.width),
                  height: Math.min(360, uploaded.height || node.height),
                },
              ),
            ]);
            setImageTool(null);
          }}
          onUpscale={async (scale, providerId, operation, context) => {
            const provider = transformRegistry.get(providerId);
            if (!provider?.upscale) throw new Error("所选处理方式不支持放大");
            const source = await resolveNodeImageTransformSource(node, context.signal);
            const result = await provider.upscale({
              image: source.blob,
              scale,
              width: source.width,
              height: source.height,
            }, context);
            const uploaded = await uploadMedia(result.blob, "image");
            placeRight([
              createNode(
                "image",
                { x: node.position.x + node.width + 48, y: node.position.y },
                {
                  title: `${node.title} · ${operation === "ai-upscale" ? "AI 超分" : "本地放大"} ${scale}x`,
                  metadata: {
                    content: uploaded.url,
                    storageKey: uploaded.storageKey,
                    naturalWidth: uploaded.width,
                    naturalHeight: uploaded.height,
                    bytes: uploaded.bytes,
                    mimeType: uploaded.mimeType,
                    status: "success",
                    ...createTransformLineage(node.id, operation, result, { scale }),
                  },
                  width: Math.min(420, uploaded.width || node.width),
                  height: Math.min(420, uploaded.height || node.height),
                },
              ),
            ]);
            setImageTool(null);
          }}
          onSplit={async (vertical, horizontal) => {
            const created = await splitImageByGuides(node, vertical, horizontal);
            placeRight(created);
            setImageTool(null);
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
