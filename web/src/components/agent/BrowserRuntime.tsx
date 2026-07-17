import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getProvider } from "@/lib/ai-config";
import { createNode } from "@/lib/defaults";
import { uid } from "@/lib/id";
import { useBoardStore } from "@/stores/use-board-store";
import { generateImages } from "@/services/ai-client";
import { uploadMedia } from "@/services/storage";
import {
  applyBoardOperations,
  parseRuntimeCommand,
  requestRuntimeTicket,
  uploadRuntimeSnapshot,
  type BoardOperation,
  type RuntimeCommand,
} from "@/services/runtime-client";
import {
  DEFAULT_AGENT_BASE_URL,
  readAgentToken,
  resolveAgentBaseUrl,
  type AgentConnection,
} from "@/services/local-agent";
import type { BoardNode, Point } from "@/types/board";

const RECONNECT_MAX_MS = 15_000;

function stringValue(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function runtimePosition(data: Record<string, unknown>): Point {
  const project = useBoardStore.getState().getActive();
  const viewport = project?.viewport ?? { x: 0, y: 0, k: 1 };
  return {
    x: numberValue(data.x, (window.innerWidth / 2 - viewport.x) / viewport.k),
    y: numberValue(data.y, (window.innerHeight / 2 - viewport.y) / viewport.k),
  };
}

async function executeRuntimeCommand(
  command: RuntimeCommand,
  connection: AgentConnection,
  navigate: (path: string) => void,
): Promise<unknown> {
  const state = useBoardStore.getState();
  const project = state.getActive();
  switch (command.method) {
    case "board.get_state":
      return {
        route: window.location.pathname,
        project,
        selection: [...state.selectedIds],
        viewport: project?.viewport ?? null,
      };
    case "board.get_selection":
      return {
        ids: [...state.selectedIds],
        nodes: project?.nodes.filter((node) => state.selectedIds.includes(node.id)) ?? [],
      };
    case "board.export_snapshot": {
      const surface = document.querySelector<HTMLElement>('[data-testid="canvas-surface"]');
      if (!surface || !project) throw new Error("active board canvas is unavailable");
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(surface, {
        cacheBust: true,
        pixelRatio: Math.min(window.devicePixelRatio, 2),
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--ob-bg").trim() || "#ffffff",
      });
      return {
        projectId: project.id,
        url: await uploadRuntimeSnapshot(connection, dataUrl, fetch, window.location.origin),
      };
    }
    case "board.apply_ops": {
      if (!project || !Array.isArray(command.data.operations)) throw new Error("active project and operations are required");
      const next = applyBoardOperations(project, command.data.operations as BoardOperation[]);
      state.updateActive(() => next);
      await useBoardStore.getState().persistNow();
      return useBoardStore.getState().getActive();
    }
    case "board.create_text_node": {
      if (!project) throw new Error("active project is required");
      const content = stringValue(command.data.content, "text content", 512_000);
      const node = createNode("text", runtimePosition(command.data), {
        id: typeof command.data.id === "string" ? stringValue(command.data.id, "node id", 128) : undefined,
        title: typeof command.data.title === "string" ? stringValue(command.data.title, "node title", 500) : "文本",
        metadata: { content, status: "success" },
      });
      state.updateActive((current) => ({ ...current, nodes: [...current.nodes, node] }));
      state.setSelected([node.id]);
      await useBoardStore.getState().persistNow();
      return node;
    }
    case "board.create_image_prompt_flow": {
      if (!project) throw new Error("active project is required");
      const prompt = stringValue(command.data.prompt, "image prompt", 32_000);
      const channel = state.config.channels.find((item) => item.id === state.config.activeChannelId);
      if (!channel) throw new Error("active image provider is required");
      const position = runtimePosition(command.data);
      const configNode = createNode("config", position, {
        title: "图片生成",
        metadata: {
          prompt,
          generationMode: "image",
          model: typeof command.data.model === "string" ? command.data.model : undefined,
          status: "loading",
        },
      });
      state.updateActive((current) => ({ ...current, nodes: [...current.nodes, configNode] }));
      try {
        const urls = await generateImages({
          channel,
          model: configNode.metadata.model || getProvider(channel, "image").model,
          prompt,
          size: typeof command.data.size === "string" ? command.data.size : state.config.imageSize,
          n: Math.min(8, Math.max(1, numberValue(command.data.count, 1))),
          systemPrompt: state.config.systemPrompt,
        });
        const images: BoardNode[] = [];
        for (const [index, url] of urls.entries()) {
          const uploaded = await uploadMedia(url, "image");
          images.push(createNode("image", {
            x: position.x + 360,
            y: position.y + index * 40,
          }, {
            metadata: {
              content: uploaded.url,
              storageKey: uploaded.storageKey,
              mimeType: uploaded.mimeType,
              bytes: uploaded.bytes,
              naturalWidth: uploaded.width,
              naturalHeight: uploaded.height,
              status: "success",
            },
          }));
        }
        state.updateActive((current) => ({
          ...current,
          nodes: current.nodes.map((node) => node.id === configNode.id
            ? { ...node, metadata: { ...node.metadata, status: "success" as const } }
            : node).concat(images),
          edges: current.edges.concat(images.map((image) => ({
            id: uid("edge"),
            from: configNode.id,
            to: image.id,
          }))),
        }));
        await useBoardStore.getState().persistNow();
        return { configNodeId: configNode.id, imageNodeIds: images.map((image) => image.id) };
      } catch (cause) {
        state.updateNode(configNode.id, {
          metadata: {
            ...configNode.metadata,
            status: "error",
            errorDetails: cause instanceof Error ? cause.message : String(cause),
          },
        });
        await useBoardStore.getState().persistNow();
        throw cause;
      }
    }
    case "asset.search": {
      const query = typeof command.data.query === "string" ? command.data.query.trim().toLocaleLowerCase() : "";
      return state.assets.filter((asset) => !query || `${asset.title} ${asset.tags.join(" ")}`.toLocaleLowerCase().includes(query)).slice(0, 100);
    }
    case "asset.insert": {
      const id = stringValue(command.data.id, "asset id", 128);
      const before = new Set(project?.nodes.map((node) => node.id) ?? []);
      await state.insertAsset(id, runtimePosition(command.data));
      const inserted = useBoardStore.getState().getActive()?.nodes.filter((node) => !before.has(node.id)) ?? [];
      await useBoardStore.getState().persistNow();
      return { nodes: inserted };
    }
    case "prompt.search": {
      const query = typeof command.data.query === "string" ? command.data.query.trim().toLocaleLowerCase() : "";
      return state.prompts.filter((prompt) => !query || `${prompt.title} ${prompt.body} ${prompt.tags.join(" ")}`.toLocaleLowerCase().includes(query)).slice(0, 100);
    }
    case "prompt.insert": {
      const id = stringValue(command.data.id, "prompt id", 128);
      const prompt = state.prompts.find((item) => item.id === id);
      if (!prompt) throw new Error("prompt was not found");
      const nodeId = state.addNode("text", runtimePosition(command.data), {
        title: prompt.title,
        metadata: { content: prompt.body, status: "success" },
      });
      await useBoardStore.getState().persistNow();
      return useBoardStore.getState().getActive()?.nodes.find((node) => node.id === nodeId);
    }
    case "site.navigate": {
      const path = stringValue(command.data.path, "site path", 200);
      if (!["/", "/assets", "/prompts", "/plugins", "/workbench/image", "/workbench/video"].includes(path)) {
        throw new Error("site path is unsupported");
      }
      navigate(path);
      return { path };
    }
  }
}

export function BrowserRuntime() {
  const location = useLocation();
  const navigate = useNavigate();
  const ready = useBoardStore((state) => state.ready);
  const baseUrl = useBoardStore((state) => state.config.localAgentUrl ?? DEFAULT_AGENT_BASE_URL);
  const socketRef = useRef<WebSocket | null>(null);
  const stateFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let attempt = 0;
    const responses = new Map<string, string>();
    const token = readAgentToken();
    const connection: AgentConnection = {
      baseUrl: resolveAgentBaseUrl(baseUrl, token, window.location.origin),
      token,
    };

    const sendState = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const state = useBoardStore.getState();
      const project = state.getActive();
      socket.send(JSON.stringify({
        type: "state",
        data: {
          route: window.location.pathname,
          projectId: project?.id ?? null,
          selection: [...state.selectedIds],
          viewport: project?.viewport ?? null,
        },
      }));
    };
    const scheduleState = () => {
      if (stateFrameRef.current !== undefined) return;
      stateFrameRef.current = requestAnimationFrame(() => {
        stateFrameRef.current = undefined;
        sendState();
      });
    };
    const unsubscribe = useBoardStore.subscribe(scheduleState);

    const connect = async () => {
      try {
        const ticket = await requestRuntimeTicket(connection);
        if (stopped) return;
        socket = new WebSocket(ticket.websocketUrl);
        socketRef.current = socket;
        socket.addEventListener("open", () => {
          attempt = 0;
          sendState();
        });
        socket.addEventListener("message", (event) => {
          void (async () => {
            let command: RuntimeCommand | undefined;
            let commandId = "";
            try {
              const raw = String(event.data);
              try {
                const value = JSON.parse(raw) as { id?: unknown };
                if (typeof value?.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)) commandId = value.id;
              } catch {
                // The strict parser below reports the actual protocol error.
              }
              command = parseRuntimeCommand(raw);
              commandId = command.id;
              const cached = responses.get(command.id);
              if (cached) {
                socket?.send(cached);
                return;
              }
              const result = await executeRuntimeCommand(command, connection, navigate);
              const response = JSON.stringify({ type: "result", id: command.id, ok: true, data: result ?? {} });
              responses.set(command.id, response);
              if (responses.size > 256) responses.delete(responses.keys().next().value!);
              socket?.send(response);
              scheduleState();
            } catch (cause) {
              if (!commandId) return;
              const response = JSON.stringify({
                type: "result",
                id: commandId,
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
              });
              responses.set(commandId, response);
              if (responses.size > 256) responses.delete(responses.keys().next().value!);
              socket?.send(response);
            }
          })();
        });
        socket.addEventListener("close", () => {
          if (stopped) return;
          attempt += 1;
          reconnectTimer = window.setTimeout(() => void connect(), Math.min(RECONNECT_MAX_MS, 500 * 2 ** attempt));
        });
      } catch {
        if (stopped) return;
        attempt += 1;
        reconnectTimer = window.setTimeout(() => void connect(), Math.min(RECONNECT_MAX_MS, 500 * 2 ** attempt));
      }
    };
    void connect();
    return () => {
      stopped = true;
      unsubscribe();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (stateFrameRef.current !== undefined) cancelAnimationFrame(stateFrameRef.current);
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [baseUrl, navigate, ready]);

  useEffect(() => {
    const state = useBoardStore.getState();
    const project = state.getActive();
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({
      type: "state",
      data: {
        route: location.pathname,
        projectId: project?.id ?? null,
        selection: [...state.selectedIds],
        viewport: project?.viewport ?? null,
      },
    }));
  }, [location.pathname]);

  return null;
}
