import { useState } from "react";
import type { BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import {
  generateImages,
  generateText,
  generateVideo,
  resolveNodeImageDataUrls,
} from "@/services/ai-client";
import { uploadMedia } from "@/services/storage";
import { createNode } from "@/lib/defaults";
import { uid } from "@/lib/id";
import { isSubmitShortcut } from "@/lib/keyboard";
import { Send } from "lucide-react";
import { getProvider } from "@/lib/ai-config";

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

  if (node.type === "config") return null;

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
    const kind = node.type === "image" ? "image" : node.type === "video" ? "video" : "text";
    if (!channel || !getProvider(channel, kind).apiKey) {
      alert("请先在设置中配置 API Key");
      return;
    }
    setBusy(true);
    updateNode(node.id, { metadata: { status: "loading", errorDetails: undefined } });
    try {
      if (node.type === "text") {
        const prompt = node.metadata.content
          ? `原文本：\n${node.metadata.content}\n\n修改要求：${text.trim()}`
          : text.trim();
        const out = await generateText({
          channel,
          model: node.metadata.model || getProvider(channel, "text").model,
          prompt,
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
        const refs = node.metadata.storageKey
          ? await resolveNodeImageDataUrls([node.metadata.storageKey])
          : [];
        const urls = await generateImages({
          channel,
          model: node.metadata.model || getProvider(channel, "image").model,
          prompt: text.trim(),
          size: config.imageSize,
          quality: config.imageQuality,
          n: config.imageCount,
          referenceDataUrls: refs,
        });
        await placeImageResults(node, urls, text.trim(), placeRight, updateNode, updateActive);
      } else if (node.type === "video") {
        const result = await generateVideo({
          channel,
          model: node.metadata.model || getProvider(channel, "video").model,
          prompt: text.trim(),
          seconds: 5,
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
      }
      setText("");
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

  const placeholder =
    node.type === "text"
      ? node.metadata.content
        ? "描述如何改写这段文本…"
        : "输入要生成的文本…"
      : node.type === "image"
        ? "输入提示词生成/改图…"
        : "输入视频提示词…";

  // silence unused
  void project;

  return (
    <div
      className="absolute left-0 top-full z-20 mt-2 flex w-[min(360px,70vw)] items-end gap-2 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-2 shadow-[var(--ob-shadow)]"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        className="min-h-[56px] flex-1 resize-none rounded-md border border-[var(--ob-line)] bg-transparent p-2 text-xs"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (
            isSubmitShortcut({
              key: e.key,
              ctrlKey: e.ctrlKey,
              metaKey: e.metaKey,
              isComposing: e.nativeEvent.isComposing,
            })
          ) {
            void send();
          }
        }}
      />
      <button
        type="button"
        className="rounded-md bg-[var(--ob-accent)] p-2 text-white disabled:opacity-50"
        disabled={busy || !text.trim()}
        onClick={() => void send()}
        title="发送 (Ctrl/Cmd+Enter)"
      >
        <Send size={14} />
      </button>
    </div>
  );
}

async function placeImageResults(
  node: BoardNode,
  urls: string[],
  prompt: string,
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
        prompt,
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
            prompt,
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
                prompt,
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
    updateNode(node.id, { metadata: { status: "success", prompt } });
  }
}
