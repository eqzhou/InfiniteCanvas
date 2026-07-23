import { useState } from "react";
import type { BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
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
import { isNodePromptType, nodePromptKind, nodePromptPlaceholder } from "@/lib/node-prompt";
import {
  activePromptReferences,
  buildPromptReferences,
  type PromptReference,
} from "@/lib/prompt-references";
import { PromptChipInput } from "@/components/canvas/PromptChipInput";
import {
  createImageGenerationMetadata,
} from "@/lib/image-generation";

export function NodePromptBar({ node }: { node: BoardNode }) {
  const config = useBoardStore((s) => s.config);
  const project = useBoardStore((s) => s.getActive());
  const updateNode = useBoardStore((s) => s.updateNode);
  const updateActive = useBoardStore((s) => s.updateActive);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const channel =
    config.channels.find((c) => c.id === config.activeChannelId) ??
    config.channels[0];
  const references = buildPromptReferences(project, node.id);

  if (!isNodePromptType(node.type)) return null;
  const promptType = node.type;

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
    if (!text.trim() || busy) return;
    const kind = nodePromptKind(promptType);
    if (!channel || !getProvider(channel, kind).apiKey) {
      alert("请先在设置中配置 API Key");
      return;
    }
    setBusy(true);
    updateNode(node.id, { metadata: { status: "loading", errorDetails: undefined } });
    try {
      const activeReferences = activePromptReferences(text, references);
      if (node.type === "text") {
        const prompt = node.metadata.content
          ? `原文本：\n${node.metadata.content}\n\n修改要求：${text.trim()}`
          : text.trim();
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
          ...(node.metadata.storageKey || node.metadata.content
            ? [{
                nodeId: node.id,
                kind: "image" as const,
                label: "当前图片",
                title: node.title,
                ...(node.metadata.storageKey ? { storageKey: node.metadata.storageKey } : {}),
                ...(node.metadata.content ? { content: node.metadata.content } : {}),
              }]
            : []),
          ...activeReferences.filter((reference) => reference.kind === "image"),
        ];
        const referenceStorageKeys = imageReferences
          .map((reference) => reference.storageKey)
          .filter((key): key is string => Boolean(key));
        const refs = await resolvePromptReferences(imageReferences, "image", 9);
        const generation = createImageGenerationMetadata({
          prompt: text.trim(),
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
        await placeImageResults(node, urls, generation, placeRight, updateNode, updateActive);
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
        const result = await generateVideo({
          channel,
          model: node.metadata.model || getProvider(channel, "video").model,
          prompt: text.trim(),
          seconds: 5,
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
            metadata: { content, storageKey, status: "success", prompt: text.trim() },
          });
        } else {
          placeRight([
            createNode(
              "video",
              { x: node.position.x + node.width + 60, y: node.position.y },
              { metadata: { content, storageKey, status: "success", prompt: text.trim() } },
            ),
          ]);
          updateNode(node.id, { metadata: { status: "success" } });
        }
      } else if (node.type === "audio") {
        const speech = await generateSpeech({
          channel,
          model: node.metadata.model || getProvider(channel, "audio").model,
          input: text.trim(),
          voice: node.metadata.voice || "alloy",
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
      updateNode(node.id, {
        metadata: {
          status: "error",
          errorDetails: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const placeholder = nodePromptPlaceholder(promptType, Boolean(node.metadata.content));

  return (
    <div
      className="ob-surface absolute left-0 top-full z-20 mt-2 flex w-[min(360px,70vw)] items-end gap-2 p-2"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <PromptChipInput
        placeholder={placeholder}
        value={text}
        references={references}
        onChange={setText}
        onSubmit={() => void send()}
      />
      <button
        type="button"
        className="ob-btn-primary p-2 shrink-0"
        disabled={busy || !text.trim()}
        onClick={() => void send()}
        title="发送 (Ctrl/Cmd+Enter)"
      >
        <Send size={14} />
      </button>
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
  placeRight: (nodes: BoardNode[]) => void,
  updateNode: ReturnType<typeof useBoardStore.getState>["updateNode"],
  updateActive: ReturnType<typeof useBoardStore.getState>["updateActive"],
) {
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
            batchRootId: node.id,
          },
          width: Math.min(280, uploaded.width || 240),
          height: Math.min(280, uploaded.height || 240),
        },
      ),
    );
  }

  if (urls.length > 1) {
    // mark current as batch root if empty multi-gen, else just place children
    updateActive((p) => {
      const childIds = created.map((c) => c.id);
      const nodes = p.nodes.map((n) =>
        n.id === node.id
          ? {
              ...n,
              metadata: {
                ...n.metadata,
                isBatchRoot: true,
                batchChildIds: [
                  ...(n.metadata.batchChildIds ?? []),
                  ...childIds,
                ],
                primaryImageId: childIds[0],
                imageBatchExpanded: true,
                status: "success" as const,
                ...generation,
              },
            }
          : n,
      );
      return {
        ...p,
        nodes: [...nodes, ...created],
        edges: [
          ...p.edges,
          ...created.map((c) => ({ id: uid("edge"), from: node.id, to: c.id })),
        ],
      };
    });
  } else {
    placeRight(created);
    updateNode(node.id, { metadata: { status: "success", ...generation } });
  }
}
