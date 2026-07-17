import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { buildPluginDocument, isPluginReadyMessage, parsePluginPatchMessage } from "@/lib/plugin-runtime";
import { executePluginHostRequest, type PluginHostContext } from "@/lib/plugin-host-executor";
import { parsePluginHostRequest } from "@/lib/plugin-host";
import { consumePluginQuota, createPluginQuota } from "@/lib/plugin-quota";
import { getProvider } from "@/lib/ai-config";
import { useBoardStore } from "@/stores/use-board-store";
import { generateImages, generateText, generateVideo } from "@/services/ai-client";
import { storageKeyToDataUrl, uploadMedia } from "@/services/storage";
import { nowIso, uid } from "@/lib/id";
import type { BoardNode, PluginManifest } from "@/types/board";

const PanoramaPluginNode = lazy(async () => {
  const module = await import("@/components/canvas/PanoramaPluginNode");
  return { default: module.PanoramaPluginNode };
});

type Props = {
  node: BoardNode;
  manifest: PluginManifest;
};

export function PluginNodeFrame({ node, manifest }: Props) {
  if (manifest.id === "openboard.panorama") {
    return (
      <Suspense fallback={<div className="grid h-full place-items-center text-xs text-[var(--ob-muted)]">加载 3D 视图…</div>}>
        <PanoramaPluginNode node={node} />
      </Suspense>
    );
  }
  return <SandboxedPluginNodeFrame node={node} manifest={manifest} />;
}

function SandboxedPluginNodeFrame({ node, manifest }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const updateNode = useBoardStore((state) => state.updateNode);
  const [nonce] = useState(() => crypto.randomUUID());
  const [quarantined, setQuarantined] = useState(false);
  const sourceDocument = useMemo(
    () => buildPluginDocument(manifest, nonce),
    [manifest, nonce],
  );
  const nodeRef = useRef(node);
  const quotaRef = useRef(createPluginQuota(performance.now()));
  const pendingPatchRef = useRef<{ title?: string; state?: Record<string, unknown> } | null>(null);
  const patchFrameRef = useRef<number | null>(null);

  useEffect(() => {
    nodeRef.current = node;
  }, [node]);

  useEffect(() => {
    const flushPatch = () => {
      patchFrameRef.current = null;
      const patch = pendingPatchRef.current;
      pendingPatchRef.current = null;
      if (!patch) return;
      updateNode(nodeRef.current.id, (current) => {
        const title = patch.title ?? current.title;
        const sameState = patch.state === undefined ||
          JSON.stringify(patch.state) === JSON.stringify(current.metadata.pluginState ?? {});
        if (title === current.title && sameState) return current;
        return {
          ...current,
          title,
          metadata: patch.state === undefined
            ? current.metadata
            : { ...current.metadata, pluginState: patch.state },
        };
      }, { history: false });
    };

    const consumeMessage = (value: unknown): boolean => {
      let bytes: number;
      try {
        bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      } catch {
        return false;
      }
      const consumed = consumePluginQuota(quotaRef.current, performance.now(), bytes, {
        maxMessages: 30,
        maxBytes: 512 * 1024,
        windowMs: 1_000,
      });
      quotaRef.current = consumed.quota;
      if (!consumed.allowed) setQuarantined(true);
      return consumed.allowed;
    };

    const hostContext = (): PluginHostContext => ({
      getNode: () => ({
        title: nodeRef.current.title,
        state: { ...(nodeRef.current.metadata.pluginState ?? {}) },
      }),
      patchNode: (patch) => {
        const current = nodeRef.current;
        const next = {
          ...current,
          title: patch.title ?? current.title,
          metadata: patch.state === undefined
            ? current.metadata
            : { ...current.metadata, pluginState: { ...patch.state } },
        };
        nodeRef.current = next;
        updateNode(current.id, next, { history: false });
        return { title: next.title, state: { ...(next.metadata.pluginState ?? {}) } };
      },
      listAssets: (query) => {
        const needle = query.trim().toLocaleLowerCase();
        return useBoardStore.getState().assets
          .filter((asset) => !needle || `${asset.title} ${asset.tags.join(" ")}`.toLocaleLowerCase().includes(needle))
          .slice(0, 100)
          .map((asset) => ({
            id: asset.id,
            kind: asset.kind,
            title: asset.title,
            content: asset.content,
            coverUrl: asset.coverUrl,
            tags: [...asset.tags],
          }));
      },
      createAsset: async (input) => {
        const timestamp = nowIso();
        const base = {
          id: uid("asset"),
          kind: input.kind,
          title: input.title,
          tags: [...(input.tags ?? [])],
          createdAt: timestamp,
          updatedAt: timestamp,
          source: `plugin:${manifest.id}`,
        };
        const asset = input.kind === "image"
          ? await (async () => {
              if (!input.content.startsWith("data:image/")) {
                throw new Error("plugin image asset must use a data URL");
              }
              const uploaded = await uploadMedia(input.content, "image");
              return {
                ...base,
                kind: "image" as const,
                coverUrl: uploaded.url,
                storageKey: uploaded.storageKey,
                mimeType: uploaded.mimeType,
              };
            })()
          : { ...base, kind: "text" as const, content: input.content };
        const store = useBoardStore.getState();
        store.setAssets([asset, ...store.assets]);
        return {
          id: asset.id,
          kind: asset.kind,
          title: asset.title,
          content: "content" in asset ? asset.content : undefined,
          coverUrl: "coverUrl" in asset ? asset.coverUrl : undefined,
          tags: [...asset.tags],
        };
      },
      generateText: async (options) => {
        const state = useBoardStore.getState();
        const channel = state.config.channels.find((item) => item.id === state.config.activeChannelId);
        if (!channel) throw new Error("no active AI channel");
        const text = await generateText({
          channel,
          model: options.model || getProvider(channel, "text").model,
          prompt: options.prompt,
          images: options.images,
        });
        return { text };
      },
      generateImage: async (options) => {
        const state = useBoardStore.getState();
        const channel = state.config.channels.find((item) => item.id === state.config.activeChannelId);
        if (!channel) throw new Error("no active AI channel");
        const generated = await generateImages({
          channel,
          model: options.model || getProvider(channel, "image").model,
          prompt: options.prompt,
          size: options.size || state.config.imageSize,
          n: options.count ?? 1,
        });
        const images: string[] = [];
        for (const result of generated) {
          if (result.startsWith("data:image/")) {
            images.push(result);
            continue;
          }
          const uploaded = await uploadMedia(result, "image");
          const data = await storageKeyToDataUrl("image", uploaded.storageKey);
          if (data && data.length <= 8 * 1024 * 1024) images.push(data);
          else if (data) throw new Error("plugin image result exceeds the 8MB bridge limit");
        }
        return { images };
      },
      generateVideo: async (options) => {
        const state = useBoardStore.getState();
        const channel = state.config.channels.find((item) => item.id === state.config.activeChannelId);
        if (!channel) throw new Error("no active AI channel");
        const result = await generateVideo({
          channel,
          model: options.model || getProvider(channel, "video").model,
          prompt: options.prompt,
          ratio: options.ratio,
          seconds: options.seconds,
        });
        return { id: result.id, url: result.url };
      },
      setPanelOpen: (open) => {
        window.dispatchEvent(new CustomEvent("openboard:plugin-panel", {
          detail: { pluginId: manifest.id, nodeId: nodeRef.current.id, open },
        }));
        return { open };
      },
    });

    const receive = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (isPluginReadyMessage(event.data, nonce, manifest.id)) {
        const current = nodeRef.current;
        frameWindow.postMessage({
          type: "openboard:init",
          nonce,
          pluginId: manifest.id,
          state: manifest.permissions.includes("node:read")
            ? { title: current.title, state: current.metadata.pluginState ?? {} }
            : {},
        }, "*");
        return;
      }
      if (!consumeMessage(event.data)) return;
      const type = event.data && typeof event.data === "object" && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>).type
        : undefined;
      if (type === "openboard:request") {
        void (async () => {
          const rawRequestId = event.data && typeof event.data === "object" && !Array.isArray(event.data)
            ? (event.data as Record<string, unknown>).requestId
            : undefined;
          let requestId = typeof rawRequestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(rawRequestId)
            ? rawRequestId
            : "";
          try {
            const request = parsePluginHostRequest(
              event.data,
              nonce,
              manifest.id,
              manifest.permissions,
            );
            requestId = request.requestId;
            const result = await executePluginHostRequest(request, hostContext());
            frameWindow.postMessage({
              type: "openboard:response",
              nonce,
              pluginId: manifest.id,
              requestId,
              ok: true,
              result,
            }, "*");
          } catch (error) {
            frameWindow.postMessage({
              type: "openboard:response",
              nonce,
              pluginId: manifest.id,
              requestId,
              ok: false,
              error: error instanceof Error ? error.message : "plugin host request failed",
            }, "*");
          }
        })();
        return;
      }
      if (type !== "openboard:patch" || !manifest.permissions.includes("node:write")) return;
      try {
        const patch = parsePluginPatchMessage(event.data, nonce, manifest.id);
        pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
        if (patchFrameRef.current === null) {
          patchFrameRef.current = requestAnimationFrame(flushPatch);
        }
      } catch {
        // Untrusted messages are rejected at the iframe boundary.
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (patchFrameRef.current !== null) cancelAnimationFrame(patchFrameRef.current);
    };
  }, [manifest, nonce, updateNode]);

  if (quarantined) {
    return (
      <div className="grid h-full place-items-center px-4 text-center text-xs text-[var(--ob-danger)]">
        插件消息超过资源配额，已停止运行。
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      title={`${manifest.name} 插件`}
      sandbox="allow-scripts"
      srcDoc={sourceDocument}
      className="h-full w-full border-0 bg-transparent"
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}
