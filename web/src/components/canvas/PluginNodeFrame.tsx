import { useEffect, useMemo, useRef, useState } from "react";
import { buildPluginDocument, isPluginReadyMessage, parsePluginPatchMessage } from "@/lib/plugin-runtime";
import { consumePluginQuota, createPluginQuota } from "@/lib/plugin-quota";
import { useBoardStore } from "@/stores/use-board-store";
import type { BoardNode, PluginManifest } from "@/types/board";

type Props = {
  node: BoardNode;
  manifest: PluginManifest;
};

export function PluginNodeFrame({ node, manifest }: Props) {
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

    const receive = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (isPluginReadyMessage(event.data, nonce, manifest.id)) {
        const current = nodeRef.current;
        frameWindow.postMessage({
          type: "openboard:init",
          nonce,
          state: manifest.permissions.includes("node:read")
            ? { title: current.title, state: current.metadata.pluginState ?? {} }
            : {},
        }, "*");
        return;
      }
      if (!manifest.permissions.includes("node:write")) return;
      let bytes: number;
      try {
        bytes = new TextEncoder().encode(JSON.stringify(event.data)).byteLength;
      } catch {
        return;
      }
      const consumed = consumePluginQuota(quotaRef.current, performance.now(), bytes, {
        maxMessages: 30,
        maxBytes: 512 * 1024,
        windowMs: 1_000,
      });
      quotaRef.current = consumed.quota;
      if (!consumed.allowed) {
        setQuarantined(true);
        return;
      }
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
