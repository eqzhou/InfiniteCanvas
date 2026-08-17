import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { getProvider } from "@/lib/ai-config";
import { renderCanvasSnapshot } from "@/lib/canvas-export";
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
  AGENT_CONNECTION_CHANGE_EVENT,
  readAgentToken,
  resolveAgentBaseUrl,
  type AgentConnection,
} from "@/services/local-agent";
import type { BoardNode, Point } from "@/types/board";
import {
  getRuntimeOwnerId,
  setRuntimeClientId,
  startRuntimeOwnerLease,
} from "@/services/runtime-identity";
import {
  getGenerationActivities,
  subscribeGenerationActivities,
} from "@/services/generation-activity";
import {
  findInterruptedGenerationJobs,
  getGenerationJob,
  listAllGenerationJobs,
  updateGenerationJob,
} from "@/services/generation-jobs";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator, type AgentHelpTranslator } from "@/i18n/messages/agent-help";

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
  t: AgentHelpTranslator,
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
        generationTasks: getGenerationActivities(),
      };
    case "board.get_selection":
      return {
        ids: [...state.selectedIds],
        nodes: project?.nodes.filter((node) => state.selectedIds.includes(node.id)) ?? [],
      };
    case "board.export_snapshot": {
      const surface = document.querySelector<HTMLElement>('[data-testid="canvas-surface"]');
      if (!surface || !project) throw new Error("active board canvas is unavailable");
      const dataUrl = await renderCanvasSnapshot(surface);
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
        title: typeof command.data.title === "string" ? stringValue(command.data.title, "node title", 500) : t("agent.textNode"),
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
        title: t("agent.imageGeneration"),
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
      await useBoardStore.getState().loadAssetsOnDemand();
      const assets = useBoardStore.getState().assets;
      const query = typeof command.data.query === "string" ? command.data.query.trim().toLocaleLowerCase() : "";
      return assets.filter((asset) => !query || `${asset.title} ${asset.tags.join(" ")}`.toLocaleLowerCase().includes(query)).slice(0, 100);
    }
    case "asset.insert": {
      await useBoardStore.getState().loadAssetsOnDemand();
      const id = stringValue(command.data.id, "asset id", 128);
      const before = new Set(project?.nodes.map((node) => node.id) ?? []);
      await state.insertAsset(id, runtimePosition(command.data));
      const inserted = useBoardStore.getState().getActive()?.nodes.filter((node) => !before.has(node.id)) ?? [];
      await useBoardStore.getState().persistNow();
      return { nodes: inserted };
    }
    case "prompt.search": {
      await useBoardStore.getState().loadPromptsOnDemand();
      const prompts = useBoardStore.getState().prompts;
      const query = typeof command.data.query === "string" ? command.data.query.trim().toLocaleLowerCase() : "";
      return prompts.filter((prompt) => !query || `${prompt.title} ${prompt.body} ${prompt.tags.join(" ")}`.toLocaleLowerCase().includes(query)).slice(0, 100);
    }
    case "prompt.insert": {
      await useBoardStore.getState().loadPromptsOnDemand();
      const id = stringValue(command.data.id, "prompt id", 128);
      const prompt = useBoardStore.getState().prompts.find((item) => item.id === id);
      if (!prompt) throw new Error("prompt was not found");
      const nodeId = state.addNode("text", runtimePosition(command.data), {
        title: prompt.title,
        metadata: { content: prompt.body, status: "success" },
      });
      await useBoardStore.getState().persistNow();
      return useBoardStore.getState().getActive()?.nodes.find((node) => node.id === nodeId);
    }
    case "generation_get_status": {
      const taskId = typeof command.data.taskId === "string"
        ? stringValue(command.data.taskId, "generation task id", 128)
        : "";
      const nodeIds = Array.isArray(command.data.nodeIds)
        ? command.data.nodeIds.map((id) => stringValue(id, "generation node id", 128))
        : [];
      if (!taskId && !nodeIds.length) throw new Error("taskId or nodeIds is required");
      if (nodeIds.length > 100 || new Set(nodeIds).size !== nodeIds.length) {
        throw new Error("generation node ids are invalid");
      }
      const statusForNode = (node: BoardNode) => {
        if (node.metadata.status === "loading") return "running";
        if (node.metadata.status === "success") return "succeeded";
        if (node.metadata.status === "error") return "failed";
        return "queued";
      };
      const nodes = nodeIds.map((id) => {
        const node = project?.nodes.find((item) => item.id === id);
        if (!node) return { nodeId: id, status: "not_found" };
        return {
          nodeId: id,
          status: statusForNode(node),
          kind: node.metadata.generationMode ?? node.type,
          error: node.metadata.errorDetails,
        };
      });
      let task = taskId
        ? getGenerationActivities().find((item) => item.id === taskId)
        : undefined;
      if (taskId && !task) {
        let stored = await getGenerationJob(taskId);
        const owner = stored?.parameters.ownerClientId;
        let visible = stored?.status !== "running" || !owner || owner === getRuntimeOwnerId();
        if (stored && findInterruptedGenerationJobs(
          [stored],
          getRuntimeOwnerId(),
          new Set(),
        ).length > 0) {
          stored = await updateGenerationJob(stored.id, {
            status: "failed",
            error: t("agent.pageRefreshInterrupted"),
          });
          visible = true;
        }
        if (visible) task = stored as typeof task;
      }
      return {
        ...(taskId ? { task: task ?? { id: taskId, status: "not_found" } } : {}),
        ...(nodeIds.length ? { nodes } : {}),
      };
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
  const { locale, t: baseT } = useI18n();
  const t = useMemo(() => createAgentHelpTranslator(baseT, locale), [baseT, locale]);
  const location = useLocation();
  const navigate = useNavigate();
  const ready = useBoardStore((state) => state.ready);
  const baseUrl = useBoardStore((state) => state.config.localAgentUrl ?? DEFAULT_AGENT_BASE_URL);
  const socketRef = useRef<WebSocket | null>(null);
  const stateFrameRef = useRef<number | undefined>(undefined);
  const [connectionRevision, setConnectionRevision] = useState(0);

  useEffect(() => startRuntimeOwnerLease(), []);

  useEffect(() => {
    const reconnect = () => setConnectionRevision((current) => current + 1);
    window.addEventListener(AGENT_CONNECTION_CHANGE_EVENT, reconnect);
    return () => window.removeEventListener(AGENT_CONNECTION_CHANGE_EVENT, reconnect);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const recover = () => {
      void listAllGenerationJobs().then(async (jobs) => {
        const liveIds = new Set(
          getGenerationActivities().filter((item) => item.status === "running").map((item) => item.id),
        );
        const interrupted = findInterruptedGenerationJobs(jobs, getRuntimeOwnerId(), liveIds);
        await Promise.all(interrupted.map((job) => updateGenerationJob(job.id, {
          status: "failed",
          error: t("agent.pageRefreshInterrupted"),
        })));
      }).catch(() => undefined);
    };
    recover();
    const timer = window.setInterval(recover, 60_000);
    return () => window.clearInterval(timer);
  }, [ready, t]);

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
          focused: document.visibilityState === "visible" && document.hasFocus(),
          generationTasks: getGenerationActivities(),
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
    const unsubscribeGeneration = subscribeGenerationActivities(scheduleState);
    window.addEventListener("focus", scheduleState);
    window.addEventListener("blur", scheduleState);
    document.addEventListener("visibilitychange", scheduleState);

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
              const control = JSON.parse(raw) as { type?: unknown; data?: { clientId?: unknown } };
              if (control.type === "ready") {
                setRuntimeClientId(typeof control.data?.clientId === "string" ? control.data.clientId : "");
                sendState();
                return;
              }
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
              const result = await executeRuntimeCommand(command, connection, navigate, t);
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
      unsubscribeGeneration();
      window.removeEventListener("focus", scheduleState);
      window.removeEventListener("blur", scheduleState);
      document.removeEventListener("visibilitychange", scheduleState);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (stateFrameRef.current !== undefined) cancelAnimationFrame(stateFrameRef.current);
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
      setRuntimeClientId("");
    };
  }, [baseUrl, connectionRevision, navigate, ready, t]);

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
        focused: document.visibilityState === "visible" && document.hasFocus(),
        generationTasks: getGenerationActivities(),
      },
    }));
  }, [location.pathname]);

  return null;
}
