import { useEffect, useMemo, useState } from "react";
import type { BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { audioJobParameters, audioSpeechOptions } from "@/lib/audio-generation";
import {
  generateImages,
  generateSpeech,
  generateText,
  generateVideo,
  resolveMediaRefs,
} from "@/services/ai-client";
import { uploadMedia } from "@/services/storage";
import { createNode } from "@/lib/defaults";
import { uid } from "@/lib/id";
import { Send } from "lucide-react";
import { getProvider } from "@/lib/ai-config";
import {
  initialNodePrompt,
  isNodePromptType,
  nodePromptKind,
  nodePromptPlaceholder,
  type NodePromptType,
} from "@/lib/node-prompt";
import {
  activePromptReferences,
  buildPromptReferences,
  type PromptReference,
} from "@/lib/prompt-references";
import { PromptChipInput } from "@/components/canvas/PromptChipInput";
import {
  createImageGenerationMetadata,
} from "@/lib/image-generation";
import { applyCameraPrompt } from "@/lib/camera-prompt";
import { applyServerImagePlaceholders } from "@/lib/canvas-server-image";
import { normalizeVideoFrameMode, resolveVideoDuration } from "@/lib/video-generation";
import {
  cancelServerGenerationJob,
  createServerAudioGenerationJob,
  createServerImageGenerationJob,
  createServerVideoGenerationJob,
  usesServerGenerationJobs,
} from "@/services/generation-jobs";
import { DEFAULT_SITE_POLICY, getSitePolicy, type SitePolicy } from "@/services/auth-session";
import {
  resolveNodePromptModels,
  resolveNodePromptSelectedModel,
} from "@/lib/node-prompt-models";
import {
  isServerManagedChannel,
  mergeSharedChannelChoices,
  useSharedChannels,
} from "@/services/shared-channels";
import { placeImageGenerationRun } from "@/lib/image-generation-run";

export function NodePromptBar({ node }: { node: BoardNode }) {
  const config = useBoardStore((s) => s.config);
  const prompts = useBoardStore((s) => s.prompts);
  const project = useBoardStore((s) => s.getActive());
  const updateNode = useBoardStore((s) => s.updateNode);
  const updateActive = useBoardStore((s) => s.updateActive);
  const persistNow = useBoardStore((s) => s.persistNow);
  const [text, setText] = useState(() => initialNodePrompt(node));
  const [busy, setBusy] = useState(false);
  const [sitePolicy, setSitePolicy] = useState<SitePolicy>(DEFAULT_SITE_POLICY);
  const sharedChannels = useSharedChannels();
  const channelChoices = useMemo(
    () => mergeSharedChannelChoices(config.channels, sharedChannels),
    [config.channels, sharedChannels],
  );
  const channel =
    (config.activeSharedChannelId
      ? channelChoices.find((c) => c.id === config.activeSharedChannelId)
      : undefined) ??
    config.channels.find((c) => c.id === config.activeChannelId) ??
    config.channels[0];
  const references = buildPromptReferences(project, node.id);
  const hasImageContent = node.type === "image" && Boolean(node.metadata.content || node.metadata.storageKey);
  const upstream = useMemo(() => {
    if (!project) return { texts: [] as string[], images: [] as PromptReference[] };
    const incoming = project.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
    const ordered = node.metadata.inputOrder?.filter((id) => incoming.includes(id)) ?? [];
    const ids = [...ordered, ...incoming.filter((id) => !ordered.includes(id))];
    const nodes = ids.map((id) => project.nodes.find((item) => item.id === id)).filter(Boolean) as BoardNode[];
    return {
      texts: nodes.filter((item) => item.type === "text").map((item) => item.metadata.content ?? "").filter(Boolean),
      images: nodes.filter((item) => item.type === "image" && (item.metadata.content || item.metadata.storageKey)).map((item) => ({
        nodeId: item.id,
        kind: "image" as const,
        label: "上游图片",
        title: item.title,
        ...(item.metadata.storageKey ? { storageKey: item.metadata.storageKey } : {}),
        ...(item.metadata.content ? { content: item.metadata.content } : {}),
      })),
    };
  }, [node.id, node.metadata.inputOrder, project]);

  const promptable = isNodePromptType(node.type);
  const promptType: NodePromptType = isNodePromptType(node.type) ? node.type : "text";
  const modelOptions = useMemo(
    () => (promptable ? resolveNodePromptModels(channel, promptType, sitePolicy) : []),
    [channel, promptable, promptType, sitePolicy],
  );
  const selectedModel = promptable ? resolveNodePromptSelectedModel(node, channel) : "";

  useEffect(() => {
    let cancelled = false;
    void getSitePolicy()
      .then((policy) => {
        if (!cancelled) setSitePolicy(policy);
      })
      .catch(() => {
        if (!cancelled) setSitePolicy(DEFAULT_SITE_POLICY);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setText(initialNodePrompt(node));
  }, [node.id, node.type, node.metadata.content, node.metadata.storageKey]);

  if (!promptable) return null;

  const generationBusy =
    busy ||
    (node.metadata.status === "loading" && Boolean(node.metadata.generationJobId));
  const effectivePrompt = text.trim() || (!hasImageContent && node.type === "image" ? upstream.texts.join("\n\n") : "");

  const placeRight = (created: BoardNode[]) => {
    updateActive((p) => ({
      ...p,
      nodes: [...p.nodes, ...created],
      edges: [
        ...p.edges,
        ...created.map((c) => ({ id: uid("edge"), from: node.id, to: c.id })),
      ],
    }));
  };

  const send = async () => {
    if (!effectivePrompt || generationBusy) return;
    const kind = nodePromptKind(promptType);
    if (
      !channel ||
      (!isServerManagedChannel(channel, kind) && !getProvider(channel, kind).apiKey)
    ) {
      alert("请先在设置中配置 API Key");
      return;
    }
    setBusy(true);
    const rawPrompt = effectivePrompt;
    if (node.type !== "image" || !hasImageContent) {
      updateNode(node.id, { metadata: { prompt: rawPrompt, status: "loading", errorDetails: undefined } });
    }
    try {
      const activeReferences = activePromptReferences(text, references);
      if (node.type === "text") {
        const prompt = node.metadata.content
          ? `原文本：\n${node.metadata.content}\n\n修改要求：${text.trim()}`
          : rawPrompt;
        const out = await generateText({
          channel,
          model: node.metadata.model || getProvider(channel, "text").model,
          prompt,
          images: await resolvePromptReferences(activeReferences, "image", 9),
          systemPrompt: config.systemPrompt,
        });
        if (!node.metadata.content) {
          updateNode(node.id, { metadata: { content: out, status: "success" } });
        } else {
          placeRight([
            createNode(
              "text",
              { x: node.position.x + node.width + 60, y: node.position.y },
              { metadata: { content: out, status: "success" } },
            ),
          ]);
          updateNode(node.id, { metadata: { status: "success" } });
        }
      } else if (node.type === "image") {
        const imageReferences: PromptReference[] = [
          ...(hasImageContent
            ? [{
                nodeId: node.id,
                kind: "image" as const,
                label: "当前图片",
                title: node.title,
                ...(node.metadata.storageKey ? { storageKey: node.metadata.storageKey } : {}),
                ...(node.metadata.content ? { content: node.metadata.content } : {}),
              }]
            : []),
          ...(hasImageContent ? [] : upstream.images),
          ...activeReferences.filter((reference) => reference.kind === "image"),
        ];
        const uniqueImageReferences = [...new Map(imageReferences.map((reference) => [reference.nodeId, reference])).values()];
        const referenceStorageKeys = uniqueImageReferences
          .map((reference) => reference.storageKey)
          .filter((key): key is string => Boolean(key));
        const refs = await resolvePromptReferences(uniqueImageReferences, "image", 9);
        const generation = createImageGenerationMetadata({
          prompt: rawPrompt,
          model: node.metadata.model || getProvider(channel, "image").model,
          size: config.imageSize,
          quality: config.imageQuality,
          count: config.imageCount,
          transparentBackground: Boolean(node.metadata.transparentBackground),
          referenceStorageKeys,
          cameraPrompt: node.metadata.cameraPrompt,
        });
        generation.requestPrompt = applyCameraPrompt(generation.prompt, generation.cameraPrompt);
        const provider = getProvider(channel, "image");
        if (usesServerGenerationJobs() && (provider.protocol === "openai" || provider.protocol === "gemini" ||
            (provider.protocol === "template" && Boolean(provider.template))) &&
            uniqueImageReferences.every((reference) => Boolean(reference.storageKey))) {
          if (provider.protocol === "gemini" && generation.transparentBackground) {
            throw new Error("Gemini 图片生成不支持透明背景");
          }
          if (provider.protocol === "template" && generation.transparentBackground && !provider.template?.supportsTransparentBackground) {
            throw new Error("当前图片模板不支持透明背景");
          }
          const jobId = uid("job");
          let placeholdersApplied = false;
          try {
            updateActive((current) => applyServerImagePlaceholders(current, node.id, jobId, generation));
            placeholdersApplied = true;
            await persistNow();
            await createServerImageGenerationJob({
              id: jobId,
              projectId: project?.id,
              prompt: generation.requestPrompt,
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
          } catch (error) {
            if (placeholdersApplied) {
              updateActive((current) => ({
                ...current,
                nodes: current.nodes.map((item) => item.metadata.generationJobId === jobId ? {
                  ...item,
                  metadata: {
                    ...item.metadata,
                    status: "error" as const,
                    errorDetails: error instanceof Error ? error.message : String(error),
                  },
                } : item),
              }));
              await persistNow().catch(() => undefined);
            }
            await cancelServerGenerationJob(jobId).catch(() => undefined);
            throw error;
          }
          return;
        }
        const urls = await generateImages({
          channel,
          model: generation.model,
          prompt: generation.requestPrompt,
          size: generation.size,
          quality: generation.quality,
          n: generation.count,
          referenceDataUrls: refs,
          transparentBackground: generation.transparentBackground,
          systemPrompt: config.systemPrompt,
        });
        await placeImageResults(node, urls, generation, updateActive);
      } else if (node.type === "video") {
        const ownVideo: PromptReference[] = node.metadata.storageKey || node.metadata.content
          ? [{
              nodeId: node.id,
              kind: "video",
              label: "当前视频",
              title: node.title,
              ...(node.metadata.storageKey ? { storageKey: node.metadata.storageKey } : {}),
              ...(node.metadata.content ? { content: node.metadata.content } : {}),
            }]
          : [];
        const videoProvider = getProvider(channel, "video");
        const durableReferences = [...ownVideo, ...activeReferences];
        const referenceStorageKeys = durableReferences
          .map((reference) => reference.storageKey)
          .filter((value): value is string => Boolean(value));
        const serverVideoSupported = videoProvider.protocol === "openai" || videoProvider.protocol === "ark" ||
          (videoProvider.protocol === "template" && Boolean(videoProvider.template)) ||
          videoProvider.baseUrl.includes("/api/v3") || videoProvider.baseUrl.includes("/api/plan/v3");
        if (usesServerGenerationJobs() && serverVideoSupported && referenceStorageKeys.length === durableReferences.length) {
          const job = await createServerVideoGenerationJob({
            projectId: project?.id,
            prompt: applyCameraPrompt(rawPrompt, node.metadata.cameraPrompt),
            providerId: channel.id,
            model: node.metadata.model || videoProvider.model,
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
          try {
            if (!node.metadata.content) {
              updateNode(node.id, { metadata: {
                status: "loading", prompt: rawPrompt, generationJobId: job.id,
                cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
              } });
            } else {
              placeRight([createNode("video", { x: node.position.x + node.width + 60, y: node.position.y }, {
                metadata: {
                  status: "loading", prompt: rawPrompt, generationJobId: job.id,
                  cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined,
                },
              })]);
              updateNode(node.id, { metadata: { status: "success" } });
            }
            await persistNow();
          } catch (error) {
            await cancelServerGenerationJob(job.id).catch(() => undefined);
            throw error;
          }
          return;
        }
        const result = await generateVideo({
          channel,
          model: node.metadata.model || getProvider(channel, "video").model,
          prompt: applyCameraPrompt(rawPrompt, node.metadata.cameraPrompt),
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
          referenceImages: await resolvePromptReferences(activeReferences, "image", 9),
          referenceVideos: await resolvePromptReferences(
            [...ownVideo, ...activeReferences],
            "video",
            3,
          ),
          referenceAudios: await resolvePromptReferences(activeReferences, "audio", 3),
        });
        let content = result.url;
        let storageKey: string | undefined;
        if (content && (content.startsWith("blob:") || content.startsWith("data:") || /^https?:/i.test(content))) {
          try {
            const uploaded = await uploadMedia(content, "media");
            content = uploaded.url;
            storageKey = uploaded.storageKey;
          } catch {
            // keep remote url
          }
        }
        if (!node.metadata.content) {
          updateNode(node.id, {
            metadata: { content, storageKey, status: "success", prompt: rawPrompt, cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined },
          });
        } else {
          placeRight([
            createNode(
              "video",
              { x: node.position.x + node.width + 60, y: node.position.y },
              { metadata: { content, storageKey, status: "success", prompt: rawPrompt, cameraPrompt: node.metadata.cameraPrompt ? { ...node.metadata.cameraPrompt } : undefined } },
            ),
          ]);
          updateNode(node.id, { metadata: { status: "success" } });
        }
      } else if (node.type === "audio") {
        const audioProvider = getProvider(channel, "audio");
        if (usesServerGenerationJobs() && audioProvider.protocol === "openai") {
          const job = await createServerAudioGenerationJob({
            projectId: project?.id,
            prompt: rawPrompt,
            providerId: channel.id,
            model: node.metadata.model || audioProvider.model,
            parameters: audioJobParameters(node.metadata.voice, config.generationDefaults),
          });
          try {
            if (!node.metadata.content) {
              updateNode(node.id, { metadata: { status: "loading", prompt: rawPrompt, generationJobId: job.id } });
            } else {
              placeRight([createNode("audio", { x: node.position.x + node.width + 60, y: node.position.y }, {
                metadata: { status: "loading", prompt: rawPrompt, generationJobId: job.id },
              })]);
              updateNode(node.id, { metadata: { status: "success" } });
            }
            await persistNow();
          } catch (error) {
            await cancelServerGenerationJob(job.id).catch(() => undefined);
            throw error;
          }
          return;
        }
        const speech = await generateSpeech({
          channel,
          model: node.metadata.model || getProvider(channel, "audio").model,
          input: text.trim(),
          ...audioSpeechOptions(node.metadata.voice, config.generationDefaults),
        });
        const uploaded = await uploadMedia(speech.blob, "media");
        const metadata = {
          content: uploaded.url,
          storageKey: uploaded.storageKey,
          mimeType: speech.mimeType || uploaded.mimeType,
          bytes: uploaded.bytes,
          status: "success" as const,
          prompt: text.trim(),
        };
        if (!node.metadata.content) {
          updateNode(node.id, { metadata });
        } else {
          placeRight([
            createNode(
              "audio",
              { x: node.position.x + node.width + 60, y: node.position.y },
              { metadata },
            ),
          ]);
          updateNode(node.id, { metadata: { status: "success" } });
        }
      }
      // Keep the last prompt so users can refine and resubmit.
    } catch (err) {
      if (node.type === "image" && hasImageContent) {
        alert(err instanceof Error ? err.message : String(err));
      } else {
        updateNode(node.id, {
          metadata: {
            status: "error",
            errorDetails: err instanceof Error ? err.message : String(err),
          },
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const placeholder = nodePromptPlaceholder(promptType, Boolean(node.metadata.content || node.metadata.storageKey));
  const defaultModelLabel = selectedModel || "继承渠道默认模型";

  const appendPromptLibrary = (promptId: string) => {
    const prompt = prompts.find((item) => item.id === promptId);
    if (!prompt) return;
    const body = prompt.body.trim();
    if (!body) return;
    const next = text.trim() ? `${text.trim()}

${body}` : body;
    setText(next);
    if (!(node.type === "image" && hasImageContent)) {
      updateNode(node.id, { metadata: { prompt: next } }, { history: false });
    }
  };

  return (
    <div
      className="ob-composer node-prompt absolute left-0 top-full z-20 mt-2 flex w-[min(420px,calc(100vw-1.5rem))] max-w-full flex-col gap-2 p-2"
      onPointerDown={(e) => e.stopPropagation()}
      role="group"
      aria-label="节点提示词"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <select
          aria-label="节点生成模型"
          className="min-w-0 flex-1 truncate rounded border border-[var(--ob-line)] bg-transparent px-1.5 py-1 text-[11px]"
          value={node.metadata.model ?? ""}
          title={defaultModelLabel}
          disabled={hasImageContent}
          onChange={(event) => {
            const model = event.target.value.trim();
            updateNode(node.id, { metadata: { model: model || undefined } });
          }}
        >
          <option value="">{defaultModelLabel}</option>
          {modelOptions.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
          {node.metadata.model && !modelOptions.includes(node.metadata.model) ? (
            <option value={node.metadata.model}>{node.metadata.model}</option>
          ) : null}
        </select>
        <select
          aria-label="提示词库"
          className="w-[42%] min-w-[6rem] shrink-0 rounded border border-[var(--ob-line)] bg-transparent px-1 py-1 text-[11px]"
          value=""
          onChange={(event) => {
            const id = event.target.value;
            event.currentTarget.value = "";
            if (id) appendPromptLibrary(id);
          }}
        >
          <option value="">提示词库</option>
          {prompts.map((prompt) => (
            <option key={prompt.id} value={prompt.id}>{prompt.title}</option>
          ))}
        </select>
      </div>
      {hasImageContent ? (
        <div className="rounded border border-[var(--ob-line)] bg-[var(--ob-canvas)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--ob-muted)]">
          <div className="font-medium text-[var(--ob-text)]">最终实际发送的提示词（只读）</div>
          <p className="mt-0.5 whitespace-pre-wrap">{node.metadata.requestPrompt || node.metadata.prompt || "未保存历史提示词"}</p>
          <p className="mt-1">{node.metadata.model || "默认模型"} · {node.metadata.size || "默认尺寸"} · {node.metadata.quality || "默认质量"}</p>
        </div>
      ) : null}
      {node.type === "image" && !hasImageContent && upstream.texts.length > 0 && !text.trim() ? (
        <p className="text-[10px] text-[var(--ob-muted)]">将使用直接上游文本作为本次图片提示词。</p>
      ) : null}
      <div className="flex min-w-0 items-end gap-2">
        <div className="min-w-0 flex-1">
          <PromptChipInput
            placeholder={placeholder}
            value={text}
            references={references}
            onChange={(value) => {
              setText(value);
              if (!(node.type === "image" && hasImageContent)) {
                updateNode(node.id, { metadata: { prompt: value } }, { history: false });
              }
            }}
            onSubmit={() => void send()}
          />
        </div>
        <button
          type="button"
          className="ob-btn-primary h-9 w-9 shrink-0 rounded-lg p-0"
          aria-busy={busy}
          aria-label={busy ? "生成中" : "发送提示词"}
          disabled={generationBusy || !effectivePrompt}
          onClick={() => void send()}
          title="发送 (Ctrl/Cmd+Enter)"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}

async function resolvePromptReferences(
  references: readonly PromptReference[],
  kind: PromptReference["kind"],
  limit: number,
): Promise<string[]> {
  const selected = references.filter((reference) => reference.kind === kind).slice(0, limit);
  const resolved = await Promise.all(selected.map((reference) =>
    resolveMediaRefs([{
      storageKey: reference.storageKey,
      content: reference.content,
    }], 1)));
  if (resolved.some((items) => items.length !== 1)) {
    throw new Error("所选媒体引用无法读取，请重新连接或上传素材");
  }
  return resolved.flat();
}

async function placeImageResults(
  node: BoardNode,
  urls: string[],
  generation: ReturnType<typeof createImageGenerationMetadata>,
  updateActive: ReturnType<typeof useBoardStore.getState>["updateActive"],
) {
  const created: BoardNode[] = [];
  for (const [i, url] of urls.entries()) {
    const uploaded = await uploadMedia(url, "image");
    created.push(
      createNode(
        "image",
        {
          x: node.position.x + node.width + 60 + (i % 3) * 28,
          y: node.position.y + Math.floor(i / 3) * 28,
        },
        {
          title: `结果 ${i + 1}`,
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
          width: Math.min(280, uploaded.width || 240),
          height: Math.min(280, uploaded.height || 240),
        },
      ),
    );
  }

  updateActive((project) => placeImageGenerationRun(project, {
    sourceId: node.id,
    results: created,
    reuseEmptyImageTarget: !node.metadata.content && !node.metadata.storageKey,
  }));
}
