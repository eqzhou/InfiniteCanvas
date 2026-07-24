import { useMemo, useState } from "react";
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
import { createOpenAIImageTransformProvider } from "@/services/image-transform/providers/openai-images";
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
import { resolveVideoDuration } from "@/lib/video-generation";
import {
  BookmarkPlus,
  Crop,
  Download,
  ImagePlus,
  Info,
  Minus,
  Plus,
  RotateCw,
  Sparkles,
  Type,
  Wand2,
} from "lucide-react";

export function NodeActions({ node, onEditText }: { node: BoardNode; onEditText?: () => void }) {
  const project = useBoardStore((s) => s.getActive());
  const config = useBoardStore((s) => s.config);
  const updateNode = useBoardStore((s) => s.updateNode);
  const updateActive = useBoardStore((s) => s.updateActive);
  const addAssetFromNode = useBoardStore((s) => s.addAssetFromNode);
  const [cropOpen, setCropOpen] = useState(false);
  const [angleOpen, setAngleOpen] = useState(false);
  const [imageTool, setImageTool] = useState<ImageToolMode | null>(null);
  const channel =
    config.channels.find((c) => c.id === config.activeChannelId) ??
    config.channels[0];
  const transformRegistry = useMemo(() => {
    const providers = [createLocalCanvasTransformProvider()];
    if (channel && getProvider(channel, "image").apiKey && getProvider(channel, "image").baseUrl) {
      providers.push(createOpenAIImageTransformProvider(channel));
    }
    return new ImageTransformRegistry(providers);
  }, [channel]);
  const transformProviderOptions = useMemo(() => {
    const capability = imageTool === "upscale" ? "upscale" : "mask";
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
    const { texts, imageKeys } = upstream();
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
        const refs = await resolveNodeImageDataUrls(imageKeys);
        assertResolvedImageReferences(imageKeys, refs);
        const generation = createImageGenerationMetadata({
          prompt: prompt || "a clean product photo",
          model: node.metadata.model || getProvider(channel, "image").model,
          size: node.metadata.size || config.imageSize,
          quality: node.metadata.quality || config.imageQuality,
          count: node.metadata.count || config.imageCount,
          transparentBackground: Boolean(node.metadata.transparentBackground),
          referenceStorageKeys: imageKeys,
        });
        const urls = await generateImages({
          channel,
          model: generation.model,
          prompt: generation.prompt,
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
        const { images, videos, audios } = upstream();
        const [referenceImages, referenceVideos, referenceAudios] = await Promise.all([
          resolveMediaRefs(images, 9),
          resolveMediaRefs(videos, 3),
          resolveMediaRefs(audios, 3),
        ]);
        const result = await generateVideo({
          channel,
          model: node.metadata.model || getProvider(channel, "video").model,
          prompt,
          size: node.metadata.size,
          seconds: resolveVideoDuration(
            Boolean(node.metadata.smartDuration),
            node.metadata.duration ?? 5,
          ),
          ratio: node.metadata.videoRatio || "16:9",
          resolution: node.metadata.resolution || "720p",
          generateAudio: Boolean(node.metadata.generateAudio),
          watermark: Boolean(node.metadata.watermark),
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
      });
      const urls = await generateImages({
        channel,
        model: generation.model,
        prompt: generation.prompt,
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
      const refs = await resolveNodeImageDataUrls(referenceStorageKeys);
      assertResolvedImageReferences(referenceStorageKeys, refs);
      const generation = createImageGenerationMetadata({
        prompt,
        model: node.metadata.model || getProvider(channel, "image").model,
        size: config.imageSize,
        quality: config.imageQuality,
        count: config.imageCount,
        transparentBackground: Boolean(node.metadata.transparentBackground),
        referenceStorageKeys,
      });
      const urls = await generateImages({
        channel,
        model: generation.model,
        prompt: generation.prompt,
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
        prompt,
        size: node.metadata.size,
        seconds: resolveVideoDuration(
          Boolean(node.metadata.smartDuration),
          node.metadata.duration ?? 5,
        ),
        ratio: node.metadata.videoRatio || "16:9",
        resolution: node.metadata.resolution || "720p",
        generateAudio: Boolean(node.metadata.generateAudio),
        watermark: Boolean(node.metadata.watermark),
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

  const inspect = () => {
    alert(
      JSON.stringify(
        {
          id: node.id,
          type: node.type,
          title: node.title,
          size: { width: node.width, height: node.height },
          position: node.position,
          metadata: node.metadata,
        },
        null,
        2,
      ),
    );
  };


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
      const speech = await generateSpeech({
        channel,
        model: node.metadata.model || getProvider(channel, "audio").model,
        input: prompt,
        voice: node.metadata.voice || "alloy",
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

return (
    <>
      <div
        className="ob-chrome absolute bottom-full left-0 z-30 mb-8 flex max-w-[min(520px,70vw)] flex-wrap items-center gap-0.5 p-1"
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
        {node.type === "image" ? (
          <>
            <IconBtn title="生成/重试" onClick={() => void generateOnImage()}>
              <Sparkles size={14} />
            </IconBtn>
            <IconBtn title="生成视频" onClick={() => void generateOnVideo()}>
              <span className="text-[10px] font-semibold">视频</span>
            </IconBtn>
            <IconBtn title="反推提示词" onClick={() => void reversePrompt()}>
              <Type size={14} />
            </IconBtn>
            <IconBtn title="裁剪" onClick={() => setCropOpen(true)}>
              <Crop size={14} />
            </IconBtn>
            <IconBtn
              title="旋转 90°"
              onClick={() =>
                void (async () => {
                  try {
                    const created = await makeRotatedNode(node, 90);
                    placeRight([created]);
                  } catch (err) {
                    alert(err instanceof Error ? err.message : String(err));
                  }
                })()
              }
            >
              <RotateCw size={14} />
            </IconBtn>
            <IconBtn title="多角度" onClick={() => setAngleOpen(true)}>
              <span className="text-[10px] font-semibold">角</span>
            </IconBtn>
            <IconBtn title="遮罩" onClick={() => setImageTool("mask")}>
              <span className="text-[10px] font-semibold">罩</span>
            </IconBtn>
            <IconBtn title="放大" onClick={() => setImageTool("upscale")}>
              <span className="text-[10px] font-semibold">放</span>
            </IconBtn>
            <IconBtn title="切分" onClick={() => setImageTool("split")}>
              <span className="text-[10px] font-semibold">切</span>
            </IconBtn>
            <IconBtn title="下载" onClick={() => void downloadNode()}>
              <Download size={14} />
            </IconBtn>
            <IconBtn
              title={node.metadata.freeResize ? "锁定比例" : "自由缩放"}
              onClick={() =>
                updateNode(node.id, {
                  metadata: { freeResize: !node.metadata.freeResize },
                })
              }
            >
              <span className="text-[10px] font-semibold">
                {node.metadata.freeResize ? "自由" : "等比"}
              </span>
            </IconBtn>
          </>
        ) : null}
        {node.type === "video" ? (
          <>
            <IconBtn title="生成视频" onClick={() => void generateOnVideo()}>
              <Sparkles size={14} />
            </IconBtn>
            <IconBtn title="下载" onClick={() => void downloadNode()}>
              <Download size={14} />
            </IconBtn>
          </>
        ) : null}
        {node.type === "audio" ? (
          <>
            <IconBtn title="语音生成" onClick={() => void generateOnAudio()}>
              <Sparkles size={14} />
            </IconBtn>
            <IconBtn title="下载" onClick={() => void downloadNode()}>
              <Download size={14} />
            </IconBtn>
          </>
        ) : null}
        {node.type === "config" ? (
          <IconBtn title="运行生成" onClick={() => void runConfigGenerate()}>
            <Sparkles size={14} />
          </IconBtn>
        ) : null}
        {(node.type === "text" || node.type === "image") && (
          <IconBtn title="加入素材" onClick={() => void addAssetFromNode(node.id)}>
            <BookmarkPlus size={14} />
          </IconBtn>
        )}
        <IconBtn title="查看 JSON" onClick={inspect}>
          <Info size={14} />
        </IconBtn>
      </div>

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
          onUpscale={async (scale, providerId, context) => {
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
                  title: `${node.title} · ${scale}x`,
                  metadata: {
                    content: uploaded.url,
                    storageKey: uploaded.storageKey,
                    naturalWidth: uploaded.width,
                    naturalHeight: uploaded.height,
                    bytes: uploaded.bytes,
                    mimeType: uploaded.mimeType,
                    status: "success",
                    ...createTransformLineage(node.id, "upscale", result, { scale }),
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
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="ob-icon-btn h-8 w-8 rounded-md"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
