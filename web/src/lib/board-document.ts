import type {
  AssistantImage,
  AssistantMessage,
  AssistantRef,
  AssistantSession,
  AudioRolePreset,
  BoardEdge,
  BoardNode,
  BoardProject,
  NodeMetadata,
  NodeType,
} from "@/types/board";
import { validateJsonObject } from "@/lib/bounded-json";
import { getDirectorPopulation, parseDirectorScene } from "@/lib/director-scene";
import { parseDirectorShotSnapshot } from "@/lib/director-shot";
import {
  validatePanoramaDimensions,
  validateProjectPanoramaBudget,
} from "@/lib/panorama";
import { normalizeCameraPrompt } from "@/lib/camera-prompt";

const NODE_TYPES = new Set<NodeType>(["text", "image", "config", "video", "audio", "panorama", "director", "group", "plugin"]);
const PANORAMA_BATCH_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const BACKGROUND_MODES = new Set(["dots", "lines", "blank"]);
const GENERATION_MODES = new Set(["text", "image", "video"]);
const VIDEO_RATIOS = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const MAX_NODES = 10_000;
const MAX_EDGES = 30_000;
const MAX_DIRECTOR_OBJECTS_PER_PROJECT = 2_000;
const MAX_DIRECTOR_CAMERAS_PER_PROJECT = 320;
const MAX_DIRECTOR_POPULATION_PER_PROJECT = 20_000;
const AUDIO_ROLE_PROTOCOLS = new Set(["openai", "azure", "edge"]);

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
  for (const localField of ["screenshots", "captureTray", "directorCaptures"]) {
    if (input[localField] !== undefined) {
      throw new Error(`${path}.${localField} is browser-local and unsupported`);
    }
  }
  optionalString(input.content, `${path}.content`, 20_000_000);
  optionalString(input.prompt, `${path}.prompt`, 100_000);
  optionalString(input.generationChannelId, `${path}.generationChannelId`, 128);
  optionalString(input.model, `${path}.model`, 500);
  if (input.reasoningEffort !== undefined &&
      input.reasoningEffort !== "low" && input.reasoningEffort !== "medium" &&
      input.reasoningEffort !== "high") {
    throw new Error(`${path}.reasoningEffort is invalid`);
  }
  optionalString(input.size, `${path}.size`, 100);
  optionalString(input.quality, `${path}.quality`, 100);
  optionalString(input.storageKey, `${path}.storageKey`, 512);
  optionalString(input.thumbnailStorageKey, `${path}.thumbnailStorageKey`, 512);
  optionalString(input.thumbnailUrl, `${path}.thumbnailUrl`, 20_000_000);
  if (typeof input.thumbnailUrl === "string") mediaURL(input.thumbnailUrl, `${path}.thumbnailUrl`);
  optionalString(input.voice, `${path}.voice`, 100);
  optionalString(input.resolvedVoice, `${path}.resolvedVoice`, 100);
  if (input.audioRoleId !== undefined) id(input.audioRoleId, `${path}.audioRoleId`);
  if (input.generationMode !== undefined &&
      (typeof input.generationMode !== "string" || !GENERATION_MODES.has(input.generationMode))) {
    throw new Error(`${path}.generationMode is invalid`);
  }
  if (input.count !== undefined) {
    const count = finite(input.count, `${path}.count`);
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new Error(`${path}.count is outside the supported range`);
    }
  }
  if (input.fontSize !== undefined) {
    const fontSize = finite(input.fontSize, `${path}.fontSize`);
    if (fontSize < 10 || fontSize > 72) throw new Error(`${path}.fontSize is outside the supported range`);
  }
  for (const key of ["splitVertical", "splitHorizontal"] as const) {
    if (input[key] === undefined) continue;
    const guides = array(input[key], `${path}.${key}`, 100);
    let previous = 0;
    for (const [index, guide] of guides.entries()) {
      const value = finite(guide, `${path}.${key}[${index}]`);
      if (value <= 0 || value >= 1 || value <= previous) {
        throw new Error(`${path}.${key} must contain sorted normalized coordinates`);
      }
      previous = value;
    }
  }
  if (input.transparentBackground !== undefined && typeof input.transparentBackground !== "boolean") {
    throw new Error(`${path}.transparentBackground must be a boolean`);
  }
  if (input.smartDuration !== undefined && typeof input.smartDuration !== "boolean") {
    throw new Error(`${path}.smartDuration must be a boolean`);
  }
  if (input.duration !== undefined) {
    const duration = finite(input.duration, `${path}.duration`);
    if (!Number.isSafeInteger(duration) || duration < 4 || duration > 15) {
      throw new Error(`${path}.duration is outside the supported range`);
    }
  }
  if (input.videoRatio !== undefined &&
      (typeof input.videoRatio !== "string" || !VIDEO_RATIOS.has(input.videoRatio))) {
    throw new Error(`${path}.videoRatio is invalid`);
  }
  if (input.resolution !== undefined &&
      (typeof input.resolution !== "string" || !VIDEO_RESOLUTIONS.has(input.resolution))) {
    throw new Error(`${path}.resolution is invalid`);
  }
  for (const key of ["generateAudio", "watermark"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      throw new Error(`${path}.${key} must be a boolean`);
    }
  }
  if (input.videoFrameMode !== undefined &&
      input.videoFrameMode !== "references" && input.videoFrameMode !== "first-last") {
    throw new Error(`${path}.videoFrameMode is invalid`);
  }
  if (input.generationType !== undefined &&
      input.generationType !== "text-to-image" && input.generationType !== "image-to-image") {
    throw new Error(`${path}.generationType is invalid`);
  }
  if (input.referenceStorageKeys !== undefined) {
    array(input.referenceStorageKeys, `${path}.referenceStorageKeys`, 20).forEach((item, index) =>
      string(item, `${path}.referenceStorageKeys[${index}]`, 512),
    );
  }
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
  for (const key of ["isBatchRoot", "imageBatchExpanded"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      throw new Error(`${path}.${key} must be a boolean batch field`);
    }
  }
  if (input.batchRootId !== undefined) id(input.batchRootId, `${path}.batchRootId`);
  if (input.primaryImageId !== undefined) id(input.primaryImageId, `${path}.primaryImageId`);
  if (input.batchChildIds !== undefined) {
    array(input.batchChildIds, `${path}.batchChildIds`, 64).forEach((item, index) =>
      id(item, `${path}.batchChildIds[${index}]`),
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
  const directorScene = input.directorScene === undefined
    ? undefined
    : parseDirectorScene(input.directorScene, `${path}.directorScene`);
  let directorShot: NodeMetadata["directorShot"];
  if (input.directorShot !== undefined) {
    const shot = record(input.directorShot, `${path}.directorShot`);
    if (shot.version !== 1 || (shot.role !== "capture" && shot.role !== "config")) {
      throw new Error(`${path}.directorShot is invalid`);
    }
    const directorNodeId = id(shot.directorNodeId, `${path}.directorShot.directorNodeId`);
    const captureId = id(shot.captureId, `${path}.directorShot.captureId`);
    const capturedAt = string(shot.capturedAt, `${path}.directorShot.capturedAt`, 100);
    if (!Number.isFinite(Date.parse(capturedAt))) throw new Error(`${path}.directorShot.capturedAt is invalid`);
    const snapshot = parseDirectorShotSnapshot(shot.snapshot);
    if (snapshot.directorNodeId !== directorNodeId) throw new Error(`${path}.directorShot snapshot is mismatched`);
    directorShot = {
      version: 1,
      role: shot.role,
      directorNodeId,
      captureId,
      capturedAt: new Date(capturedAt).toISOString(),
      snapshot,
    };
  }
  const cameraPrompt = input.cameraPrompt === undefined
    ? undefined
    : normalizeCameraPrompt(input.cameraPrompt);
  if (input.directorPreview !== undefined) {
    throw new Error(`${path}.directorPreview is unsupported; use managed image storage`);
  }
  if (input.panoramaProjection !== undefined && input.panoramaProjection !== "equirectangular") {
    throw new Error(`${path}.panoramaProjection is invalid`);
  }
  for (const key of [
    "workflowRunId",
    "workflowStepId",
    "workflowTemplateId",
    "generationJobId",
    "generationConfigId",
    "generationRunId",
    "generationOutputRootId",
  ] as const) {
    if (input[key] !== undefined) id(input[key], `${path}.${key}`);
  }
  if (input.generationResultIndex !== undefined &&
      (typeof input.generationResultIndex !== "number" || !Number.isSafeInteger(input.generationResultIndex) ||
        input.generationResultIndex < 0 || input.generationResultIndex > 7)) {
    throw new Error(`${path}.generationResultIndex is invalid`);
  }
  return { ...input, directorScene, directorShot, cameraPrompt } as NodeMetadata;
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
  if (type === "director" && !metadata.directorScene) {
    throw new Error(`${path}.metadata.directorScene is required`);
  }
  if (metadata.directorShot?.role === "capture" && type !== "image") {
    throw new Error(`${path}.metadata.directorShot capture must belong to an image node`);
  }
  if (metadata.directorShot?.role === "config" && type !== "config") {
    throw new Error(`${path}.metadata.directorShot config must belong to a config node`);
  }
  if (type === "panorama" && (metadata.content || metadata.storageKey)) {
    validatePanoramaDimensions(metadata.naturalWidth ?? 0, metadata.naturalHeight ?? 0);
    if (metadata.mimeType && !metadata.mimeType.startsWith("image/")) {
      throw new Error(`${path}.metadata.mimeType must be an image`);
    }
  }
  if (metadata.cameraPrompt && type !== "image" && type !== "video" && type !== "config") {
    throw new Error(`${path}.metadata.cameraPrompt is unsupported for ${type} nodes`);
  }
  if (type === "image" || type === "video" || type === "audio" || type === "panorama") {
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

function parseAudioRoles(value: unknown): AudioRolePreset[] | undefined {
  if (value === undefined) return undefined;
  const roles = array(value, "audioRoles", 32);
  const seen = new Set<string>();
  return roles.map((item, index) => {
    const path = `audioRoles[${index}]`;
    const input = record(item, path);
    const roleID = id(input.id, `${path}.id`);
    if (seen.has(roleID)) throw new Error("audioRoles contains duplicate role ids");
    seen.add(roleID);
    const name = string(input.name, `${path}.name`, 80);
    if (!name.trim()) throw new Error(`${path}.name is empty`);
    const rawVoices = record(input.voices, `${path}.voices`);
    const voices: AudioRolePreset["voices"] = {};
    for (const [protocol, rawVoice] of Object.entries(rawVoices)) {
      if (!AUDIO_ROLE_PROTOCOLS.has(protocol)) {
        throw new Error(`${path}.voices.${protocol} is unsupported`);
      }
      const voice = string(rawVoice, `${path}.voices.${protocol}`, 100);
      if (!voice.trim()) throw new Error(`${path}.voices.${protocol} is empty`);
      voices[protocol as "openai" | "azure" | "edge"] = voice;
    }
    return { id: roleID, name, voices };
  });
}

export function parseBoardProject(value: unknown): BoardProject {
  const input = record(value, "project");
  const schemaVersion = input.schemaVersion ?? 1;
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) {
    throw new Error("schemaVersion is unsupported");
  }
  const nodes = array(input.nodes, "nodes", MAX_NODES).map(parseNode);
  const nodeIDs = new Set(nodes.map((node) => node.id));
  if (nodeIDs.size !== nodes.length) throw new Error("duplicate node id");
  validateProjectPanoramaBudget(nodes);
  const nodeByID = new Map(nodes.map((node) => [node.id, node]));
  const directorObjectCount = nodes.reduce(
    (total, node) => total + (node.metadata.directorScene?.objects.length ?? 0),
    0,
  );
  if (directorObjectCount > MAX_DIRECTOR_OBJECTS_PER_PROJECT) {
    throw new Error("project director scenes exceed aggregate limits");
  }
  const directorCameraCount = nodes.reduce(
    (total, node) => total + (node.metadata.directorScene?.cameras.length ?? 0),
    0,
  );
  if (directorCameraCount > MAX_DIRECTOR_CAMERAS_PER_PROJECT) {
    throw new Error("project director cameras exceed aggregate limits");
  }
  const directorPopulation = nodes.reduce(
    (total, node) => total + (node.metadata.directorScene ? getDirectorPopulation(node.metadata.directorScene) : 0),
    0,
  );
  if (directorPopulation > MAX_DIRECTOR_POPULATION_PER_PROJECT) {
    throw new Error("project director population exceeds aggregate limits");
  }

  const edges = array(input.edges, "edges", MAX_EDGES).map((edge, index) =>
    parseEdge(edge, index, nodeIDs),
  );
  const edgeIDs = new Set(edges.map((edge) => edge.id));
  if (edgeIDs.size !== edges.length) throw new Error("duplicate edge id");
  const edgeEndpoints = new Set(edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  if (edgeEndpoints.size !== edges.length) throw new Error("duplicate edge endpoints");
  const hasEdge = (from: string, to: string) => edgeEndpoints.has(`${from}\u0000${to}`);
  const directorCaptureByID = new Map<string, BoardNode>();
  const directorCaptureKeyByID = new Map<string, string>();
  for (const node of nodes) {
    const shot = node.metadata.directorShot;
    if (!shot) continue;
    const director = nodeByID.get(shot.directorNodeId);
    if (director?.type !== "director") throw new Error(`director shot ${node.id} references an invalid director`);
    const key = `${shot.directorNodeId}\u0000${shot.captureId}`;
    if (shot.role === "capture") {
      if (!hasEdge(director.id, node.id)) {
        throw new Error(`director capture ${node.id} has invalid lineage`);
      }
      directorCaptureByID.set(node.id, node);
      directorCaptureKeyByID.set(node.id, key);
    }
  }
  // Resolve capture -> config edges once. When malformed documents contain
  // multiple capture inputs, retain the first capture in serialized node
  // order, matching the old flatten().find behavior without rescanning all
  // captures for every config node.
  const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const connectedCaptureByConfigID = new Map<string, BoardNode>();
  for (const edge of edges) {
    const capture = directorCaptureByID.get(edge.from);
    const config = nodeByID.get(edge.to);
    if (!capture || config?.metadata.directorShot?.role !== "config") continue;
    const current = connectedCaptureByConfigID.get(config.id);
    if (!current || (nodeOrder.get(capture.id) ?? Number.MAX_SAFE_INTEGER) <
        (nodeOrder.get(current.id) ?? Number.MAX_SAFE_INTEGER)) {
      connectedCaptureByConfigID.set(config.id, capture);
    }
  }
  const resultsByConfigID = new Map<string, BoardNode[]>();
  for (const candidate of nodes) {
    if (candidate.type !== "image" || !candidate.metadata.generationConfigId) continue;
    const results = resultsByConfigID.get(candidate.metadata.generationConfigId) ?? [];
    results.push(candidate);
    resultsByConfigID.set(candidate.metadata.generationConfigId, results);
  }
  for (const node of nodes) {
    const shot = node.metadata.directorShot;
    if (shot?.role !== "config") continue;
    const key = `${shot.directorNodeId}\u0000${shot.captureId}`;
    const connectedCapture = connectedCaptureByConfigID.get(node.id);
    const capture = connectedCapture && directorCaptureKeyByID.get(connectedCapture.id) === key
      ? connectedCapture
      : undefined;
    const results = resultsByConfigID.get(node.id) ?? [];
    if (results.some((result) => !hasEdge(node.id, result.id))) {
      throw new Error(`director config ${node.id} has invalid lineage`);
    }
    // Users may deliberately delete the durable capture node and keep the
    // editable config. If a capture edge remains, its provenance must match.
    if (!connectedCapture) continue;
    if (!capture ||
        capture.metadata.storageKey === undefined ||
        !node.metadata.referenceStorageKeys?.includes(capture.metadata.storageKey) ||
        JSON.stringify(capture.metadata.directorShot?.snapshot) !== JSON.stringify(shot.snapshot)) {
      throw new Error(`director config ${node.id} has invalid lineage`);
    }
  }
  const panoramaReferences = new Map<string, number>();
  for (const edge of edges) {
    if (nodeByID.get(edge.to)?.type !== "panorama" || nodeByID.get(edge.from)?.type !== "image") continue;
    const count = (panoramaReferences.get(edge.to) ?? 0) + 1;
    if (count > 8) throw new Error(`panorama ${edge.to} exceeds 8 image references`);
    panoramaReferences.set(edge.to, count);
  }
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

  const batchOwner = new Map<string, string>();
  const usablePanoramaBatchResult = (node: BoardNode) => node.type === "panorama" &&
    Boolean(node.metadata.storageKey) &&
    Boolean(Number.isSafeInteger(node.metadata.bytes) && (node.metadata.bytes ?? 0) > 0) &&
    node.metadata.panoramaProjection === "equirectangular" &&
    Boolean(node.metadata.mimeType && PANORAMA_BATCH_MIME_TYPES.has(node.metadata.mimeType));
  for (const root of nodes) {
    const childIds = root.metadata.batchChildIds ?? [];
    if (root.metadata.isBatchRoot === true && childIds.length < 1) {
      throw new Error(`batch root ${root.id} has no children`);
    }
    if (childIds.length > 0 && root.metadata.isBatchRoot !== true) {
      throw new Error(`batch root ${root.id} is missing its batch flag`);
    }
    if (new Set(childIds).size !== childIds.length) {
      throw new Error(`batch root ${root.id} contains duplicate children`);
    }
    if (root.type === "panorama" && childIds.length > 7) {
      throw new Error(`panorama batch ${root.id} exceeds 8 results`);
    }
    if (root.type === "panorama" && childIds.length > 0 && !usablePanoramaBatchResult(root)) {
      throw new Error(`panorama batch ${root.id} has an unusable root result`);
    }
    for (const childId of childIds) {
      const child = nodeByID.get(childId);
      if (!child || child.id === root.id || child.metadata.batchRootId !== root.id) {
        throw new Error(`batch root ${root.id} references an invalid child`);
      }
      if (root.type === "panorama" && child.type !== "panorama") {
        throw new Error(`panorama batch ${root.id} contains a non-panorama child`);
      }
      if (root.type === "panorama" && !usablePanoramaBatchResult(child)) {
        throw new Error(`panorama batch ${root.id} contains an unusable result`);
      }
      if (batchOwner.has(childId)) throw new Error(`batch child ${childId} has multiple owners`);
      batchOwner.set(childId, root.id);
    }
    const primaryId = root.metadata.primaryImageId;
    if (primaryId && primaryId !== root.id && !childIds.includes(primaryId)) {
      throw new Error(`batch root ${root.id} has an invalid primary result`);
    }
  }
  for (const child of nodes) {
    if (!child.metadata.batchRootId) continue;
    const owner = nodeByID.get(child.metadata.batchRootId);
    if (!owner?.metadata.batchChildIds?.includes(child.id)) {
      throw new Error(`batch child ${child.id} references an invalid root`);
    }
    if (child.metadata.isBatchRoot || child.metadata.batchChildIds?.length) {
      throw new Error(`nested batch child ${child.id} is unsupported`);
    }
  }

  for (const node of nodes) {
    const configId = node.metadata.generationConfigId;
    if (configId) {
      const config = nodeByID.get(configId);
      if (!config || config.type !== "config") {
        throw new Error(`generation result ${node.id} references an invalid config`);
      }
      if (!node.metadata.generationRunId) {
        throw new Error(`generation result ${node.id} is missing its run id`);
      }
    }
    const outputRootId = node.metadata.generationOutputRootId;
    if (outputRootId) {
      if (node.type !== "config") throw new Error(`non-config node ${node.id} has a generation output root`);
      const output = nodeByID.get(outputRootId);
      if (!output || output.type !== "image" || output.metadata.generationConfigId !== node.id) {
        throw new Error(`config ${node.id} references an invalid generation output root`);
      }
    }
    if (node.metadata.batchRootId) {
      const root = nodeByID.get(node.metadata.batchRootId);
      if (root?.metadata.generationRunId && node.metadata.generationRunId &&
          root.metadata.generationRunId !== node.metadata.generationRunId) {
        throw new Error(`batch child ${node.id} belongs to a different generation run`);
      }
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
  const audioRoles = parseAudioRoles(input.audioRoles);

  return {
    schemaVersion: 3,
    projectKind: input.projectKind === undefined && schemaVersion < 3
      ? "canvas"
      : input.projectKind === "canvas" || input.projectKind === "film"
        ? input.projectKind
        : (() => { throw new Error("projectKind is unsupported"); })(),
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
    ...(audioRoles === undefined ? {} : { audioRoles }),
  };
}
