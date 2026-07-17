import type {
  AssistantImage,
  AssistantMessage,
  AssistantRef,
  AssistantSession,
  BoardEdge,
  BoardNode,
  BoardProject,
  NodeMetadata,
  NodeType,
} from "@/types/board";
import { validateJsonObject } from "@/lib/bounded-json";

const NODE_TYPES = new Set<NodeType>(["text", "image", "config", "video", "audio", "group", "plugin"]);
const BACKGROUND_MODES = new Set(["dots", "lines", "blank"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MAX_NODES = 10_000;
const MAX_EDGES = 30_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > max) throw new Error(`${path} exceeds ${max} items`);
  return value;
}

function string(value: unknown, path: string, max = 10_000): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${path} must be a string no longer than ${max} characters`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = string(value, path, 128);
  if (!ID_PATTERN.test(result)) throw new Error(`${path} is invalid`);
  return result;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function isoDate(value: unknown, path: string): string {
  const result = string(value, path, 64);
  if (!result || Number.isNaN(Date.parse(result))) throw new Error(`${path} must be an ISO date`);
  return result;
}

function optionalString(value: unknown, path: string, max = 10_000): string | undefined {
  return value === undefined ? undefined : string(value, path, max);
}

function mediaURL(value: string | undefined, path: string): void {
  if (!value) return;
  if (
    value.startsWith("blob:") ||
    value.startsWith("obundle://") ||
    /^data:(image|video|audio)\//i.test(value)
  ) {
    return;
  }
  throw new Error(`${path} uses an unsafe media URL`);
}

function parseMetadata(value: unknown, path: string): NodeMetadata {
  const input = record(value, path);
  optionalString(input.content, `${path}.content`, 20_000_000);
  optionalString(input.prompt, `${path}.prompt`, 100_000);
  optionalString(input.storageKey, `${path}.storageKey`, 512);
  if (input.inputOrder !== undefined) {
    array(input.inputOrder, `${path}.inputOrder`, MAX_NODES).forEach((item, index) =>
      id(item, `${path}.inputOrder[${index}]`),
    );
  }
  if (input.childIds !== undefined) {
    array(input.childIds, `${path}.childIds`, MAX_NODES).forEach((item, index) =>
      id(item, `${path}.childIds[${index}]`),
    );
  }
  if (input.pluginId !== undefined) {
    const pluginId = string(input.pluginId, `${path}.pluginId`, 128);
    if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new Error(`${path}.pluginId is invalid`);
  }
  if (input.pluginState !== undefined) {
    validateJsonObject(input.pluginState, {
      label: `${path}.pluginState`,
      maxBytes: 256 * 1024,
      maxDepth: 20,
      maxEntries: 50_000,
    });
  }
  return input as NodeMetadata;
}

function parseNode(value: unknown, index: number): BoardNode {
  const path = `nodes[${index}]`;
  const input = record(value, path);
  const type = string(input.type, `${path}.type`) as NodeType;
  if (!NODE_TYPES.has(type)) throw new Error(`${path}.type is unsupported`);
  const position = record(input.position, `${path}.position`);
  const width = finite(input.width, `${path}.width`);
  const height = finite(input.height, `${path}.height`);
  if (width < 24 || width > 100_000 || height < 24 || height > 100_000) {
    throw new Error(`${path} dimensions are outside the supported range`);
  }
  const metadata = parseMetadata(input.metadata, `${path}.metadata`);
  if (type === "plugin" && !metadata.pluginId) {
    throw new Error(`${path}.metadata.pluginId is required`);
  }
  if (type === "image" || type === "video" || type === "audio") {
    mediaURL(metadata.content, `${path}.metadata.content`);
  }
  return {
    id: id(input.id, `${path}.id`),
    type,
    title: string(input.title, `${path}.title`, 500),
    position: {
      x: finite(position.x, `${path}.position.x`),
      y: finite(position.y, `${path}.position.y`),
    },
    width,
    height,
    metadata,
  };
}

function parseEdge(value: unknown, index: number, nodeIDs: Set<string>): BoardEdge {
  const path = `edges[${index}]`;
  const input = record(value, path);
  const from = id(input.from, `${path}.from`);
  const to = id(input.to, `${path}.to`);
  if (!nodeIDs.has(from) || !nodeIDs.has(to)) throw new Error(`${path} references an unknown node`);
  return { id: id(input.id, `${path}.id`), from, to };
}

function parseReference(value: unknown, path: string): AssistantRef {
  const input = record(value, path);
  const kind = string(input.kind, `${path}.kind`) as NodeType;
  if (!NODE_TYPES.has(kind)) throw new Error(`${path}.kind is unsupported`);
  const preview = optionalString(input.preview, `${path}.preview`, 20_000_000);
  if (kind === "image" || kind === "video" || kind === "audio") {
    mediaURL(preview, `${path}.preview`);
  }
  return {
    nodeId: id(input.nodeId, `${path}.nodeId`),
    kind,
    label: string(input.label, `${path}.label`, 500),
    preview,
    storageKey: optionalString(input.storageKey, `${path}.storageKey`, 512),
  };
}

function parseImage(value: unknown, path: string): AssistantImage {
  const input = record(value, path);
  const url = string(input.url, `${path}.url`, 20_000_000);
  mediaURL(url, `${path}.url`);
  return {
    id: id(input.id, `${path}.id`),
    url,
    storageKey: optionalString(input.storageKey, `${path}.storageKey`, 512),
  };
}

function parseMessage(value: unknown, path: string): AssistantMessage {
  const input = record(value, path);
  const role = string(input.role, `${path}.role`);
  const mode = string(input.mode, `${path}.mode`);
  if (role !== "user" && role !== "assistant") throw new Error(`${path}.role is invalid`);
  if (mode !== "ask" && mode !== "image") throw new Error(`${path}.mode is invalid`);
  const references = input.references === undefined
    ? undefined
    : array(input.references, `${path}.references`, 1_000).map((item, index) =>
        parseReference(item, `${path}.references[${index}]`),
      );
  const images = input.images === undefined
    ? undefined
    : array(input.images, `${path}.images`, 1_000).map((item, index) =>
        parseImage(item, `${path}.images[${index}]`),
      );
  return {
    id: id(input.id, `${path}.id`),
    role,
    mode,
    text: string(input.text, `${path}.text`, 1_000_000),
    isLoading: input.isLoading === undefined ? undefined : Boolean(input.isLoading),
    references,
    images,
  };
}

function parseSession(value: unknown, index: number): AssistantSession {
  const path = `chatSessions[${index}]`;
  const input = record(value, path);
  return {
    id: id(input.id, `${path}.id`),
    title: string(input.title, `${path}.title`, 500),
    messages: array(input.messages, `${path}.messages`, 10_000).map((item, messageIndex) =>
      parseMessage(item, `${path}.messages[${messageIndex}]`),
    ),
    createdAt: isoDate(input.createdAt, `${path}.createdAt`),
    updatedAt: isoDate(input.updatedAt, `${path}.updatedAt`),
  };
}

export function parseBoardProject(value: unknown): BoardProject {
  const input = record(value, "project");
  const schemaVersion = input.schemaVersion ?? 1;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error("schemaVersion is unsupported");
  }
  const nodes = array(input.nodes, "nodes", MAX_NODES).map(parseNode);
  const nodeIDs = new Set(nodes.map((node) => node.id));
  if (nodeIDs.size !== nodes.length) throw new Error("duplicate node id");
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));

  const edges = array(input.edges, "edges", MAX_EDGES).map((edge, index) =>
    parseEdge(edge, index, nodeIDs),
  );
  const edgeIDs = new Set(edges.map((edge) => edge.id));
  if (edgeIDs.size !== edges.length) throw new Error("duplicate edge id");
  const childOwner = new Map<string, string>();
  for (const node of nodes) {
    if (node.type !== "group") continue;
    const childIds = node.metadata.childIds ?? [];
    if (childIds.length < 1) throw new Error(`group ${node.id} has no children`);
    const uniqueChildren = new Set(childIds);
    if (uniqueChildren.size !== childIds.length) {
      throw new Error(`group ${node.id} contains duplicate children`);
    }
    for (const childId of childIds) {
      const child = nodeByID.get(childId);
      if (!child || child.type === "group") {
        throw new Error(`group ${node.id} references an invalid child`);
      }
      const owner = childOwner.get(childId);
      if (owner) throw new Error(`node ${childId} belongs to multiple groups`);
      childOwner.set(childId, node.id);
    }
  }

  const backgroundMode = string(input.backgroundMode, "backgroundMode");
  if (!BACKGROUND_MODES.has(backgroundMode)) throw new Error("backgroundMode is unsupported");
  const viewport = record(input.viewport, "viewport");
  const zoom = finite(viewport.k, "viewport.k");
  if (zoom < 0.05 || zoom > 8) throw new Error("viewport.k is outside the supported range");

  const chatSessions = array(input.chatSessions, "chatSessions", 1_000).map(parseSession);
  let totalMessages = 0;
  let totalAttachments = 0;
  for (const session of chatSessions) {
    totalMessages += session.messages.length;
    for (const message of session.messages) {
      totalAttachments += (message.images?.length ?? 0) + (message.references?.length ?? 0);
    }
  }
  if (totalMessages > 50_000 || totalAttachments > 50_000) {
    throw new Error("project chat exceeds aggregate limits");
  }
  const activeChatId = input.activeChatId === null ? null : id(input.activeChatId, "activeChatId");
  if (activeChatId && !chatSessions.some((session) => session.id === activeChatId)) {
    throw new Error("activeChatId references an unknown session");
  }

  return {
    schemaVersion: 2,
    id: id(input.id, "id"),
    title: string(input.title, "title", 500),
    createdAt: isoDate(input.createdAt, "createdAt"),
    updatedAt: isoDate(input.updatedAt, "updatedAt"),
    nodes,
    edges,
    chatSessions,
    activeChatId,
    backgroundMode: backgroundMode as BoardProject["backgroundMode"],
    viewport: {
      x: finite(viewport.x, "viewport.x"),
      y: finite(viewport.y, "viewport.y"),
      k: zoom,
    },
  };
}
