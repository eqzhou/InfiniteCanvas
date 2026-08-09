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
  canRegenerateImageFromPrompt,
  imagePromptInheritsFromUpstream,
  initialNodePrompt,
  isNodePromptType,
  nodePromptKind,
  nodePromptPlaceholder,
  nodePromptUsesPromptLibrary,
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
  normalizeImageGenerationForProvider,
} from "@/lib/image-generation";
import { applyCameraPrompt } from "@/lib/camera-prompt";
import { applyServerImagePlaceholders, submitServerImageGeneration } from "@/lib/canvas-server-image";
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
  resolveNodePromptModelChoices,
} from "@/lib/node-prompt-models";
import {
  isServerManagedChannel,
  mergeSharedChannelChoices,
  useSharedChannels,
} from "@/services/shared-channels";
import { placeImageGenerationRun } from "@/lib/image-generation-run";
import { DEFAULT_GENERATION_DEFAULTS } from "@/lib/generation-defaults";
import {
  audioRoleDefaultLabel,
  audioVoiceLabel,
  audioProtocolRequiresKey,
  audioProtocolSupportsServerJobs,
  audioVoiceOptions,
  resolveAudioVoice,
} from "@/lib/audio-provider";

export function NodePromptBar({ node }: { node: BoardNode }) {
  const config = useBoardStore((s) => s.config);
  const prompts = useBoardStore((s) => s.prompts);
  const project = useBoardStore((s) => s.getActive());
  const updateNode = useBoardStore((s) => s.updateNode);
  const updateActive = useBoardStore((s) => s.updateActive);
  const persistNow = useBoardStore((s) => s.persistNow);
  const inheritsUpstreamPrompt = imagePromptInheritsFromUpstream(project, node);
  const [text, setText] = useState(() => initialNodePrompt(node, inheritsUpstreamPrompt));
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
      : config.channels.find((c) => c.id === config.activeChannelId) ?? config.channels[0]);
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
  const modelChoices = useMemo(
    () => resolveNodePromptModelChoices(node, channel, sitePolicy),
    [channel, node, sitePolicy],
  );
  const selectedAudioProvider = channel ? getProvider(channel, "audio") : undefined;
  const selectedAudioProtocol = selectedAudioProvider?.protocol ?? "openai";
  const selectedAudioVoice = resolveAudioVoice({
    roles: project?.audioRoles,
    roleId: node.metadata.audioRoleId,
    protocol: selectedAudioProtocol,
    fallback: config.generationDefaults?.audioVoice ?? DEFAULT_GENERATION_DEFAULTS.audioVoice,
    explicit: node.metadata.voice,
  });

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
    setText(initialNodePrompt(node, inheritsUpstreamPrompt));
  }, [node.id, node.type, node.metadata.content, node.metadata.storageKey, inheritsUpstreamPrompt]);

  if (!promptable) return null;

  const generationBusy =
    busy ||
    (node.metadata.status === "loading" && Boolean(node.metadata.generationJobId));
  const effectivePrompt = text.trim() || (!hasImageContent && node.type === "image" ? upstream.texts.join("\n\n") : "");
  const regenerateImageInPlace = canRegenerateImageFromPrompt(node, inheritsUpstreamPrompt);

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
    const savedChannel = regenerateImageInPlace && node.metadata.generationChannelId
      ? channelChoices.find((choice) => choice.id === node.metadata.generationChannelId)
      : undefined;
    if (regenerateImageInPlace && node.metadata.generationChannelId && !savedChannel) {
      alert("原生成渠道已不可用，无法按修改后的提示词重新生成");
      return;
    }
    const requestChannel = savedChannel ?? channel;
    const requestProvider = requestChannel ? getProvider(requestChannel, kind) : undefined;
    const requiresKey = kind !== "audio" || !requestProvider || audioProtocolRequiresKey(requestProvider.protocol);
    if (!requestChannel || (!isServerManagedChannel(requestChannel, kind) && requiresKey && !requestProvider?.apiKey)) {
      alert("请先在设置中配置 API Key");
      return;
    }
    setBusy(true);
    const rawPrompt = effectivePrompt;
    if (node.type !== "image" || !hasImageContent) {
      updateNode(node.id, { metadata: { prompt: rawPrompt, status: "loading", errorDetails: undefined } });
    } else if (!inheritsUpstreamPrompt) {
      updateNode(node.id, { metadata: { prompt: rawPrompt } });
    }
    try {
      const activeReferences = activePromptReferences(text, references);
      if (node.type === "text") {
        const prompt = node.metadata.content
          ? `原文本：\n${node.metadata.content}\n\n修改要求：${text.trim()}`
          : rawPrompt;
        const out = await generateText({
          channel: requestChannel,
          model: node.metadata.model || getProvider(requestChannel, "text").model,
          prompt,
          images: await resolvePromptReferences(activeReferences, "image", 9),
          systemPrompt: config.systemPrompt,
          reasoningEffort: node.metadata.reasoningEffort,
        });
        if (!node.metadata.content) {
          updateNode(node.id, { metadata: { content: out, status: "success" } });
        } else {
          placeRight([
            createNode(
              "text",
              { x: node.position.x + node.width + 60, y: node.position.y },
              { metadata: {
                content: out,
                reasoningEffort: node.metadata.reasoningEffort,
                status: "success",
              } },
            ),
          ]);
          updateNode(node.id, { metadata: { status: "success" } });
        }
      } else if (node.type === "image") {
        const savedReferenceKeys = regenerateImageInPlace
          ? [...(node.metadata.referenceStorageKeys ?? [])]
          : [];
        if (regenerateImageInPlace && node.metadata.generationType === "image-to-image" && savedReferenceKeys.length === 0) {
          throw new Error("原参考图关系已丢失，无法按修改后的提示词重新生成");
        }
        const imageReferences: PromptReference[] = regenerateImageInPlace
          ? savedReferenceKeys.map((storageKey, index) => ({
              nodeId: `saved-reference-${index}`,
              kind: "image",
              label: `原参考图${index + 1}`,
              title: `原参考图 ${index + 1}`,
              storageKey,
            }))
          : [
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
        const provider = getProvider(requestChannel, "image");
        const generation = createImageGenerationMetadata({
          prompt: rawPrompt,
          model: node.metadata.model || provider.model,
          size: regenerateImageInPlace ? node.metadata.size || config.imageSize : config.imageSize,
          quality: regenerateImageInPlace ? node.metadata.quality || config.imageQuality : config.imageQuality,
          count: regenerateImageInPlace ? 1 : config.imageCount,
          transparentBackground: Boolean(node.metadata.transparentBackground),
          referenceStorageKeys,
          generationChannelId: requestChannel.id,
          cameraPrompt: node.metadata.cameraPrompt,
        });
        const normalizedGeneration = normalizeImageGenerationForProvider(generation, provider.protocol);
        const requestPrompt = applyCameraPrompt(normalizedGeneration.prompt, normalizedGeneration.cameraPrompt);
        if (usesServerGenerationJobs() && (provider.protocol === "openai" || provider.protocol === "gemini" ||
            (provider.protocol === "template" && Boolean(provider.template))) &&
            uniqueImageReferences.every((reference) => Boolean(reference.storageKey))) {
          if (provider.protocol === "gemini" && normalizedGeneration.transparentBackground) {
            throw new Error("Gemini 图片生成不支持透明背景");
          }
          if (provider.protocol === "template" && normalizedGeneration.transparentBackground && !provider.template?.supportsTransparentBackground) {
            throw new Error("当前图片模板不支持透明背景");
          }
          const jobId = uid("job");
          await submitServerImageGeneration({
            createJob: () => createServerImageGenerationJob({
              id: jobId,
              projectId: project?.id,
              prompt: requestPrompt,
              providerId: requestChannel.id,
              model: normalizedGeneration.model,
              parameters: {
                size: normalizedGeneration.size,
                quality: normalizedGeneration.quality,
                count: normalizedGeneration.count,
                transparentBackground: normalizedGeneration.transparentBackground,
                referenceStorageKeys,
              },
            }),
            applyPlaceholders: () => updateActive((current) => applyServerImagePlaceholders(
              current,
              node.id,
              jobId,
              normalizedGeneration,
              { replaceExisting: regenerateImageInPlace },
            )),
            persist: persistNow,
            cancelJob: () => cancelServerGenerationJob(jobId),
            onPersistError: (error) => console.error("Image job created but canvas persistence is pending", error),
          });
          return;
        }
        const urls = await generateImages({
          channel: requestChannel,
          model: normalizedGeneration.model,
          prompt: requestPrompt,
          size: normalizedGeneration.size,
          quality: normalizedGeneration.quality,
          n: normalizedGeneration.count,
          referenceDataUrls: refs,
          transparentBackground: normalizedGeneration.transparentBackground,
          systemPrompt: config.systemPrompt,
        });
        await placeImageResults(node, urls, normalizedGeneration, updateActive, {
          replaceExisting: regenerateImageInPlace,
        });
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
        const videoProvider = getProvider(requestChannel, "video");
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
            providerId: requestChannel.id,
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
          channel: requestChannel,
          model: node.metadata.model || getProvider(requestChannel, "video").model,
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
        const audioProvider = getProvider(requestChannel, "audio");
        const actualVoice = resolveAudioVoice({
          roles: project?.audioRoles,
          roleId: node.metadata.audioRoleId,
          protocol: audioProvider.protocol,
          fallback: config.generationDefaults?.audioVoice ?? DEFAULT_GENERATION_DEFAULTS.audioVoice,
          explicit: node.metadata.voice,
        });
        if (usesServerGenerationJobs() && audioProtocolSupportsServerJobs(audioProvider.protocol)) {
          const job = await createServerAudioGenerationJob({
            projectId: project?.id,
            prompt: rawPrompt,
            providerId: requestChannel.id,
            model: node.metadata.model || audioProvider.model,
            parameters: audioJobParameters(actualVoice, config.generationDefaults),
          });
          try {
            if (!node.metadata.content) {
              updateNode(node.id, { metadata: { status: "loading", prompt: rawPrompt, generationJobId: job.id, resolvedVoice: actualVoice } });
            } else {
              placeRight([createNode("audio", { x: node.position.x + node.width + 60, y: node.position.y }, {
                metadata: {
                  status: "loading",
                  prompt: rawPrompt,
                  generationJobId: job.id,
                  voice: node.metadata.voice,
                  resolvedVoice: actualVoice,
                  audioRoleId: node.metadata.audioRoleId,
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
        const speech = await generateSpeech({
          channel: requestChannel,
          model: node.metadata.model || getProvider(requestChannel, "audio").model,
          input: text.trim(),
          ...audioSpeechOptions(actualVoice, config.generationDefaults),
        });
        const uploaded = await uploadMedia(speech.blob, "media");
        const metadata = {
          content: uploaded.url,
          storageKey: uploaded.storageKey,
          mimeType: speech.mimeType || uploaded.mimeType,
          bytes: uploaded.bytes,
          status: "success" as const,
          prompt: text.trim(),
          voice: node.metadata.voice,
          resolvedVoice: actualVoice,
          audioRoleId: node.metadata.audioRoleId,
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
  const defaultModelLabel = modelChoices.inheritedLabel;

  const appendPromptLibrary = (promptId: string) => {
    const prompt = prompts.find((item) => item.id === promptId);
    if (!prompt) return;
    const body = prompt.body.trim();
    if (!body) return;
    const next = text.trim() ? `${text.trim()}

${body}` : body;
    setText(next);
    if (!(node.type === "image" && inheritsUpstreamPrompt)) {
      updateNode(node.id, { metadata: { prompt: next } }, { history: false });
    }
  };

  return (
    <div
      data-canvas-control
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
          onChange={(event) => {
            const model = event.target.value.trim();
            updateNode(node.id, { metadata: { model: model || undefined } });
          }}
        >
          <option value="">{defaultModelLabel}</option>
          {modelChoices.options.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
          {node.metadata.model && !modelChoices.options.includes(node.metadata.model) ? (
            <option value={node.metadata.model}>{node.metadata.model}</option>
          ) : null}
        </select>
        {nodePromptUsesPromptLibrary(promptType) ? (
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
        ) : null}
      </div>
      {node.type === "image" && !hasImageContent && upstream.texts.length > 0 && !text.trim() ? (
        <p className="text-[10px] text-[var(--ob-muted)]">将使用直接上游文本作为本次图片提示词。</p>
      ) : null}
      {node.type === "image" && hasImageContent && inheritsUpstreamPrompt && node.metadata.prompt ? (
        <div
          className="rounded border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_45%,transparent)] px-2 py-1.5 text-[10px]"
          aria-label="最终实际发送的提示词"
        >
          <div className="mb-1 font-medium text-[var(--ob-muted)]">最终实际发送的提示词（只读）</div>
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed" onWheel={(event) => event.stopPropagation()}>
            {node.metadata.prompt}
          </p>
        </div>
      ) : null}
      {node.type === "audio" ? (
        <div className="grid min-w-0 grid-cols-2 gap-1.5">
          <select
            aria-label="音频角色"
            title="角色来自：项目面板 → 当前画布配音角色"
            className="min-w-0 rounded border border-[var(--ob-line)] bg-transparent px-1.5 py-1 text-[11px]"
            value={node.metadata.audioRoleId ?? ""}
            onChange={(event) => updateNode(node.id, { metadata: {
              audioRoleId: event.target.value || undefined,
              voice: undefined,
            } })}
          >
            <option value="">{audioRoleDefaultLabel(project?.audioRoles)}</option>
            {(project?.audioRoles ?? []).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
          <select
            aria-label="音频声线"
            className="min-w-0 rounded border border-[var(--ob-line)] bg-transparent px-1.5 py-1 text-[11px]"
            value={node.metadata.voice ?? ""}
            onChange={(event) => updateNode(node.id, { metadata: { voice: event.target.value || undefined } })}
          >
            <option value="">跟随角色/默认：{audioVoiceLabel(selectedAudioVoice)}</option>
            {audioVoiceOptions(selectedAudioProtocol).map((voice) => (
              <option key={voice} value={voice}>{audioVoiceLabel(voice)}</option>
            ))}
            {node.metadata.voice && !audioVoiceOptions(selectedAudioProtocol).some((voice) => voice === node.metadata.voice) ? (
              <option value={node.metadata.voice}>{audioVoiceLabel(node.metadata.voice)}</option>
            ) : null}
          </select>
        </div>
      ) : null}
      <div className="flex min-w-0 items-end gap-2">
        <div className="min-w-0 flex-1">
          <PromptChipInput
            placeholder={placeholder}
            value={text}
            references={references}
            onChange={(value) => {
              setText(value);
              if (!(node.type === "image" && inheritsUpstreamPrompt)) {
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
  options: { replaceExisting?: boolean } = {},
) {
  if (options.replaceExisting) {
    const url = urls[0];
    if (!url) throw new Error("图片服务没有返回结果");
    const uploaded = await uploadMedia(url, "image");
    updateActive((project) => ({
      ...project,
      nodes: project.nodes.map((candidate) => candidate.id === node.id ? {
        ...candidate,
        metadata: {
          ...candidate.metadata,
          ...generation,
          content: uploaded.url,
          storageKey: uploaded.storageKey,
          naturalWidth: uploaded.width,
          naturalHeight: uploaded.height,
          bytes: uploaded.bytes,
          mimeType: uploaded.mimeType,
          status: "success",
          errorDetails: undefined,
          generationJobId: undefined,
          generationResultIndex: 0,
        },
      } : candidate),
    }));
    return;
  }

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
