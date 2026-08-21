import { createNode } from "@/lib/defaults";
import { nowIso, uid } from "@/lib/id";
import {
  MAX_PANORAMA_BATCH_BYTES,
  MAX_PANORAMA_BATCH_PIXELS,
  validatePanoramaBlob,
  validatePanoramaDimensions,
  validateProjectPanoramaBudget,
} from "@/lib/panorama";
import { pruneGroupMembership } from "@/lib/grouping";
import type { BoardProject, NodeMetadata } from "@/types/board";

export const PANORAMA_GENERATION_SIZE = "2048x1024";
export const PANORAMA_MAX_RESULTS = 8;
export const PANORAMA_MAX_REFERENCES = 8;
export const PANORAMA_MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
export const PANORAMA_MAX_REFERENCE_TOTAL_BYTES = 24 * 1024 * 1024;

const PANORAMA_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PanoramaReferenceInput = {
  nodeId: string;
  storageKey: string;
  bytes: number;
  mimeType: string;
};

export type PanoramaGeneratedMedia = {
  content: string;
  storageKey: string;
  naturalWidth: number;
  naturalHeight: number;
  bytes: number;
  mimeType: string;
};

export type UploadedPanoramaCandidate = {
  blob: Blob;
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};

export type PanoramaGenerationDescriptor = {
  prompt: string;
  model: string;
  quality: string;
  resolution?: string;
  referenceStorageKeys: string[];
  derivedFromId?: string;
  generationJobId?: string;
  generationJobIds?: string[];
};

export function getPanoramaReferenceInputs(
  project: BoardProject,
  panoramaId: string,
): PanoramaReferenceInput[] {
  const panorama = project.nodes.find((node) => node.id === panoramaId);
  if (!panorama || panorama.type !== "panorama") throw new Error("全景节点不存在");
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const incoming: string[] = [];
  const incomingSet = new Set<string>();
  for (const edge of project.edges) {
    if (edge.to !== panoramaId || incomingSet.has(edge.from)) continue;
    incomingSet.add(edge.from);
    incoming.push(edge.from);
  }
  const order: string[] = [];
  const ordered = new Set<string>();
  for (const id of [...(panorama.metadata.inputOrder ?? []), ...incoming]) {
    if (!incomingSet.has(id) || ordered.has(id)) continue;
    ordered.add(id);
    order.push(id);
  }
  const references = order.flatMap((id): PanoramaReferenceInput[] => {
    const node = nodeById.get(id);
    if (!node || node.type !== "image") return [];
    if (!node.metadata.storageKey || !Number.isSafeInteger(node.metadata.bytes) || !node.metadata.bytes ||
        node.metadata.bytes > PANORAMA_MAX_REFERENCE_BYTES ||
        !node.metadata.mimeType || !PANORAMA_MIME_TYPES.has(node.metadata.mimeType)) {
      throw new Error(`参考图片“${node.title}”不可用`);
    }
    return [{
      nodeId: node.id,
      storageKey: node.metadata.storageKey,
      bytes: node.metadata.bytes,
      mimeType: node.metadata.mimeType,
    }];
  });
  if (references.length > PANORAMA_MAX_REFERENCES) {
    throw new Error(`全景生成最多支持 ${PANORAMA_MAX_REFERENCES} 张参考图片`);
  }
  if (references.reduce((total, reference) => total + reference.bytes, 0) > PANORAMA_MAX_REFERENCE_TOTAL_BYTES) {
    throw new Error("全景生成参考图片总大小超过 24 MB");
  }
  return references;
}

export async function loadPanoramaReferenceBlobs(
  references: PanoramaReferenceInput[],
  read: (storageKey: string) => Promise<Blob | undefined>,
): Promise<Blob[]> {
  const blobs: Blob[] = [];
  let totalBytes = 0;
  for (const reference of references) {
    const blob = await read(reference.storageKey);
    if (!blob || blob.size !== reference.bytes || blob.size > PANORAMA_MAX_REFERENCE_BYTES ||
        blob.type !== reference.mimeType) {
      throw new Error("有参考图片已丢失，请重新连接后再生成");
    }
    await validatePanoramaBlob(blob);
    totalBytes += blob.size;
    if (totalBytes > PANORAMA_MAX_REFERENCE_TOTAL_BYTES) {
      throw new Error("全景生成参考图片总大小超过 24 MB");
    }
    blobs.push(blob);
  }
  return blobs;
}

export function getPanoramaGenerationSettings(
  metadata: Pick<NodeMetadata, "count" | "quality" | "resolution">,
  defaultQuality: string,
  resolvedResolution?: string,
): { count: number; quality: string; resolution: string; size: typeof PANORAMA_GENERATION_SIZE } {
  const count = metadata.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > PANORAMA_MAX_RESULTS) {
    throw new Error(`全景生成张数必须在 1-${PANORAMA_MAX_RESULTS} 之间`);
  }
  const quality = (metadata.quality ?? defaultQuality).trim();
  if (!quality || quality.length > 100) throw new Error("全景生成质量无效");
  const resolution = (resolvedResolution ?? metadata.resolution ?? "").trim();
  if (resolution.length > 20) throw new Error("全景生成分辨率无效");
  return { count, quality, resolution, size: PANORAMA_GENERATION_SIZE };
}

function validateGeneratedMedia(result: PanoramaGeneratedMedia, index: number): void {
  if (!result.content || !result.storageKey || result.bytes < 1 || !Number.isSafeInteger(result.bytes)) {
    throw new Error(`全景结果 ${index + 1} 的媒体信息无效`);
  }
  if (!PANORAMA_MIME_TYPES.has(result.mimeType)) {
    throw new Error(`全景结果 ${index + 1} 的图片格式无效`);
  }
  validatePanoramaDimensions(result.naturalWidth, result.naturalHeight);
}

function validatePanoramaBatchBudget(results: PanoramaGeneratedMedia[]): void {
  const totalBytes = results.reduce((total, result) => total + result.bytes, 0);
  const totalPixels = results.reduce((total, result) =>
    total + result.naturalWidth * result.naturalHeight, 0);
  if (totalBytes > MAX_PANORAMA_BATCH_BYTES || totalPixels > MAX_PANORAMA_BATCH_PIXELS) {
    throw new Error("全景生成批次超出 64 MB 或 6400 万像素限制");
  }
}

export async function stagePanoramaGeneratedMedia(
  urls: string[],
  expectedCount: number,
  upload: (url: string) => Promise<UploadedPanoramaCandidate>,
  remove: (storageKey: string) => Promise<void>,
): Promise<PanoramaGeneratedMedia[]> {
  if (urls.length !== expectedCount || expectedCount < 1 || expectedCount > PANORAMA_MAX_RESULTS) {
    throw new Error(`生成服务应返回 ${expectedCount} 张全景图片，实际返回 ${urls.length} 张`);
  }
  const staged: UploadedPanoramaCandidate[] = [];
  try {
    for (const url of urls) {
      const uploaded = await upload(url);
      staged.push(uploaded);
      await validatePanoramaBlob(uploaded.blob);
      validatePanoramaDimensions(uploaded.width, uploaded.height);
    }
    const results = staged.map((uploaded) => ({
      content: uploaded.url,
      storageKey: uploaded.storageKey,
      naturalWidth: uploaded.width,
      naturalHeight: uploaded.height,
      bytes: uploaded.bytes,
      mimeType: uploaded.mimeType,
    }));
    validatePanoramaBatchBudget(results);
    if (new Set(results.map((result) => result.storageKey)).size !== results.length) {
      throw new Error("全景生成结果包含重复媒体");
    }
    return results;
  } catch (cause) {
    await Promise.all(staged.map((uploaded) => remove(uploaded.storageKey).catch(() => undefined)));
    throw cause;
  }
}

export function commitPanoramaGeneration(
  project: BoardProject,
  panoramaId: string,
  results: PanoramaGeneratedMedia[],
  descriptor: PanoramaGenerationDescriptor,
): BoardProject {
  if (results.length < 1 || results.length > PANORAMA_MAX_RESULTS) {
    throw new Error(`全景生成结果必须包含 1-${PANORAMA_MAX_RESULTS} 张图片`);
  }
  const root = project.nodes.find((node) => node.id === panoramaId);
  if (!root || root.type !== "panorama") throw new Error("全景节点不存在");
  if (root.metadata.batchRootId) throw new Error("全景批次子结果不可独立修改");
  results.forEach(validateGeneratedMedia);
  validatePanoramaBatchBudget(results);
  if (new Set(results.map((result) => result.storageKey)).size !== results.length) {
    throw new Error("全景生成结果包含重复媒体");
  }

  const previousChildren = new Set(root.metadata.batchChildIds ?? []);
  const retainedNodes = pruneGroupMembership(project.nodes, previousChildren);
  const columnStride = Math.max(300, root.width + 48);
  const rowStride = Math.max(300, root.height + 48);
  const children = results.slice(1).map((result, index) => createNode(
    "panorama",
    {
      x: root.position.x + root.width + 48 + (index % 3) * columnStride,
      y: root.position.y + Math.floor(index / 3) * rowStride,
    },
    {
      id: uid("panorama"),
      title: `${root.title} ${index + 2}`,
      width: root.width,
      height: root.height,
      metadata: {
        ...result,
        prompt: descriptor.prompt,
        model: descriptor.model,
        quality: descriptor.quality,
        ...(descriptor.resolution ? { resolution: descriptor.resolution } : {}),
        count: results.length,
        generationType: descriptor.referenceStorageKeys.length > 0 ? "image-to-image" : "text-to-image",
        referenceStorageKeys: [...descriptor.referenceStorageKeys],
        generationJobId: descriptor.generationJobIds?.[index + 1] ?? descriptor.generationJobId,
        generationJobIds: descriptor.generationJobIds ? [...descriptor.generationJobIds] : undefined,
        derivedFromId: descriptor.derivedFromId,
        panoramaProjection: "equirectangular",
        status: "success",
        batchRootId: panoramaId,
      },
    },
  ));
  const childIds = children.map((node) => node.id);
  const first = results[0]!;
  const nextRoot = {
    ...root,
    metadata: {
      ...root.metadata,
      ...first,
      prompt: descriptor.prompt,
      model: descriptor.model,
      quality: descriptor.quality,
      ...(descriptor.resolution ? { resolution: descriptor.resolution } : {}),
      count: results.length,
      generationType: descriptor.referenceStorageKeys.length > 0 ? "image-to-image" as const : "text-to-image" as const,
      referenceStorageKeys: [...descriptor.referenceStorageKeys],
      generationJobId: descriptor.generationJobIds?.[0] ?? descriptor.generationJobId,
      generationJobIds: descriptor.generationJobIds ? [...descriptor.generationJobIds] : undefined,
      derivedFromId: descriptor.derivedFromId,
      panoramaProjection: "equirectangular" as const,
      status: "success" as const,
      errorDetails: undefined,
      isBatchRoot: childIds.length > 0,
      batchChildIds: childIds,
      primaryImageId: childIds.length > 0 ? panoramaId : undefined,
      imageBatchExpanded: childIds.length > 0,
      batchRootId: undefined,
    },
  };
  const nodes = [...retainedNodes.map((node) => node.id === panoramaId ? nextRoot : node), ...children];
  validateProjectPanoramaBudget(nodes);
  const retainedNodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...project,
    nodes,
    edges: project.edges.filter((edge) => retainedNodeIds.has(edge.from) && retainedNodeIds.has(edge.to)),
    updatedAt: nowIso(),
  };
}
