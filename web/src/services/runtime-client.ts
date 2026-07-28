import { validateJsonObject } from "@/lib/bounded-json";
import { parseBoardProject } from "@/lib/board-document";
import type { BoardEdge, BoardNode, BoardProject, Viewport } from "@/types/board";
import { agentAuthHeaders, normalizeAgentBaseUrl, type AgentConnection } from "@/services/local-agent";

export const RUNTIME_METHODS = [
  "board.get_state",
  "board.get_selection",
  "board.export_snapshot",
  "board.apply_ops",
  "board.create_text_node",
  "board.create_image_prompt_flow",
  "asset.search",
  "asset.insert",
  "prompt.search",
  "prompt.insert",
  "site.navigate",
  "generation_get_status",
] as const;

export type RuntimeMethod = typeof RUNTIME_METHODS[number];
export type RuntimeCommand = {
  id: string;
  method: RuntimeMethod;
  data: Record<string, unknown>;
};

export type BoardOperation =
  | { op: "addNode"; node: BoardNode }
  | { op: "updateNode"; id: string; patch: Partial<BoardNode> }
  | { op: "deleteNodes"; ids: string[] }
  | { op: "addEdge"; edge: BoardEdge }
  | { op: "deleteEdges"; ids: string[] }
  | { op: "setViewport"; viewport: Viewport };

const RUNTIME_ID = /^[A-Za-z0-9_-]{1,128}$/;
const NODE_PATCH_FIELDS = new Set([
  "title", "position", "width", "height", "metadata", "body", "tags", "source", "coverUrl",
]);

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "::1" || hostname === "[::1]";
}

export function resolveRuntimeFileUrl(path: string, baseUrl: string, publicOrigin?: string): string {
  const internal = new URL(path, normalizeAgentBaseUrl(baseUrl));
  if (!publicOrigin) return internal.toString();
  try {
    const publicUrl = new URL(publicOrigin);
    if (isLoopbackHostname(internal.hostname) && isLoopbackHostname(publicUrl.hostname) &&
        (publicUrl.protocol === "http:" || publicUrl.protocol === "https:") &&
        !publicUrl.username && !publicUrl.password) {
      return new URL(`${internal.pathname}${internal.search}`, publicUrl.origin).toString();
    }
  } catch {
    // An invalid public origin must not change the authenticated upload target.
  }
  return internal.toString();
}

export function parseRuntimeCommand(input: string): RuntimeCommand {
  if (input.length > 32 * 1024 * 1024) throw new Error("runtime command is too large");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("runtime command is invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime command must be an object");
  }
  const message = value as Record<string, unknown>;
  if (Object.keys(message).some((key) => !["type", "id", "method", "data"].includes(key))) {
    throw new Error("runtime command field is unsupported");
  }
  if (message.type !== "command") throw new Error("runtime command type is invalid");
  if (typeof message.id !== "string" || !RUNTIME_ID.test(message.id)) {
    throw new Error("runtime command id is invalid");
  }
  if (typeof message.method !== "string" || !RUNTIME_METHODS.includes(message.method as RuntimeMethod)) {
    throw new Error("runtime command method is unsupported");
  }
  return {
    id: message.id,
    method: message.method as RuntimeMethod,
    data: validateJsonObject(message.data ?? {}, {
      label: "runtime command data",
      maxBytes: 32 * 1024 * 1024,
      maxDepth: 32,
      maxEntries: 100_000,
    }),
  };
}

export function applyBoardOperations(
  project: BoardProject,
  operations: readonly BoardOperation[],
): BoardProject {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 1_000) {
    throw new Error("board operations must contain between 1 and 1000 items");
  }
  let next = structuredClone(project);
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") throw new Error("board operation is invalid");
    switch (operation.op) {
      case "addNode":
        if (next.nodes.some((node) => node.id === operation.node?.id)) {
          throw new Error("board node id already exists");
        }
        next = { ...next, nodes: [...next.nodes, structuredClone(operation.node)] };
        break;
      case "updateNode": {
        const index = next.nodes.findIndex((node) => node.id === operation.id);
        if (index < 0) throw new Error("board node was not found");
        if (!operation.patch || Object.keys(operation.patch).some((key) => !NODE_PATCH_FIELDS.has(key))) {
          throw new Error("board node patch field is unsupported");
        }
        const current = next.nodes[index]!;
        const updated: BoardNode = {
          ...current,
          ...structuredClone(operation.patch),
          id: current.id,
          type: current.type,
          metadata: operation.patch.metadata
            ? { ...current.metadata, ...structuredClone(operation.patch.metadata) }
            : current.metadata,
        };
        next = {
          ...next,
          nodes: next.nodes.map((node, nodeIndex) => nodeIndex === index ? updated : node),
        };
        break;
      }
      case "deleteNodes": {
        if (!Array.isArray(operation.ids) || !operation.ids.length) throw new Error("board node ids are required");
        const deleted = new Set(operation.ids);
        next = {
          ...next,
          nodes: next.nodes.filter((node) => !deleted.has(node.id)).map((node) =>
            node.type === "group"
              ? { ...node, metadata: { ...node.metadata, childIds: node.metadata.childIds?.filter((id) => !deleted.has(id)) } }
              : node),
          edges: next.edges.filter((edge) => !deleted.has(edge.from) && !deleted.has(edge.to)),
        };
        break;
      }
      case "addEdge":
        if (next.edges.some((edge) => edge.id === operation.edge?.id)) throw new Error("board edge id already exists");
        next = { ...next, edges: [...next.edges, structuredClone(operation.edge)] };
        break;
      case "deleteEdges": {
        if (!Array.isArray(operation.ids) || !operation.ids.length) throw new Error("board edge ids are required");
        const deleted = new Set(operation.ids);
        next = { ...next, edges: next.edges.filter((edge) => !deleted.has(edge.id)) };
        break;
      }
      case "setViewport":
        next = { ...next, viewport: structuredClone(operation.viewport) };
        break;
      default:
        throw new Error("board operation is unsupported");
    }
  }
  return parseBoardProject(next);
}

export async function requestRuntimeTicket(
  connection: AgentConnection,
  fetcher: typeof fetch = fetch,
): Promise<{ ticket: string; websocketUrl: string }> {
  const baseUrl = normalizeAgentBaseUrl(connection.baseUrl);
  const headers = agentAuthHeaders(connection);
  const response = await fetcher(`${baseUrl}/api/runtime/ticket`, {
    method: "POST",
    headers,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`runtime ticket failed: HTTP ${response.status}`);
  const value = await response.json() as { ticket?: unknown };
  if (typeof value.ticket !== "string" || !RUNTIME_ID.test(value.ticket)) {
    throw new Error("runtime ticket response is invalid");
  }
  const websocketUrl = new URL(baseUrl);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  websocketUrl.pathname = "/api/runtime/ws";
  websocketUrl.search = new URLSearchParams({ ticket: value.ticket }).toString();
  return { ticket: value.ticket, websocketUrl: websocketUrl.toString() };
}

export async function uploadRuntimeSnapshot(
  connection: AgentConnection,
  dataUrl: string,
  fetcher: typeof fetch = fetch,
  publicOrigin?: string,
): Promise<string> {
  const baseUrl = normalizeAgentBaseUrl(connection.baseUrl);
  const image = await fetch(dataUrl).then((response) => response.blob());
  if (image.type !== "image/png" || image.size === 0 || image.size > 64 * 1024 * 1024) {
    throw new Error("runtime snapshot PNG is invalid or too large");
  }
  const body = new FormData();
  body.append("file", image, "board-snapshot.png");
  const headers = agentAuthHeaders(connection);
  const response = await fetcher(`${baseUrl}/api/files`, {
    method: "POST",
    headers,
    body,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`runtime snapshot upload failed: HTTP ${response.status}`);
  const value = await response.json() as { url?: unknown };
  if (typeof value.url !== "string" || !value.url.startsWith("/api/files/")) {
    throw new Error("runtime snapshot upload response is invalid");
  }
  return resolveRuntimeFileUrl(value.url, baseUrl, publicOrigin);
}
