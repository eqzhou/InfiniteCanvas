import { applyServerImagePlaceholders } from "@/lib/canvas-server-image";
import { createNode } from "@/lib/defaults";
import { fitMediaDisplaySize } from "@/lib/geometry";
import type { ImageGenerationMetadata } from "@/lib/image-generation";
import type {
  BoardNode,
  BoardProject,
  DirectorShotMetadata,
  DirectorShotSnapshot,
} from "@/types/board";
import { uid } from "@/lib/id";
export { buildDirectorShotPrompt } from "@/lib/director-shot";

export type DirectorShotGenerationSource = {
  kind: "director";
  directorNodeId: string;
  captureId: string;
  cameraId: string;
  configNodeId: string;
};

export function directorShotGenerationContext(project: BoardProject | null | undefined, rootId: string) {
  if (!project) return undefined;
  const root = project.nodes.find((node) => node.id === rootId);
  const config = root?.metadata.directorShot?.role === "config"
    ? root
    : project.nodes.find((node) => node.id === root?.metadata.generationConfigId);
  const shot = config?.metadata.directorShot;
  if (!config || config.type !== "config" || shot?.role !== "config") return undefined;
  return {
    configNodeId: config.id,
    referenceStorageKeys: [...(config.metadata.referenceStorageKeys ?? [])],
    source: {
      kind: "director" as const,
      directorNodeId: shot.directorNodeId,
      captureId: shot.captureId,
      cameraId: shot.snapshot.camera.id,
      configNodeId: config.id,
    } satisfies DirectorShotGenerationSource,
  };
}

export function expandDirectorShotDeletion(project: BoardProject, selectedIds: ReadonlySet<string>) {
  const expanded = new Set(selectedIds);
  const deletedDirectorIds = new Set(
    project.nodes.filter((node) => expanded.has(node.id) && node.type === "director").map((node) => node.id),
  );
  if (!deletedDirectorIds.size) return expanded;
  for (const node of project.nodes) {
    if (node.metadata.directorShot && deletedDirectorIds.has(node.metadata.directorShot.directorNodeId)) {
      expanded.add(node.id);
    }
  }
  return expanded;
}

export function repairDirectorShotDeletion(nodes: BoardNode[], deletedIds: ReadonlySet<string>): BoardNode[] {
  return nodes.map((node) => {
    const clearsOutput = Boolean(node.metadata.generationOutputRootId && deletedIds.has(node.metadata.generationOutputRootId));
    const clearsConfig = Boolean(node.metadata.generationConfigId && deletedIds.has(node.metadata.generationConfigId));
    if (!clearsOutput && !clearsConfig) return node;
    const metadata = { ...node.metadata };
    if (clearsOutput) delete metadata.generationOutputRootId;
    if (clearsConfig) delete metadata.generationConfigId;
    return { ...node, metadata };
  });
}

export function orphanedGenerationJobIdsAfterDeletion(
  project: BoardProject,
  deletedIds: ReadonlySet<string>,
): Set<string> {
  const survivingJobIds = new Set(
    project.nodes
      .filter((node) => !deletedIds.has(node.id))
      .map((node) => node.metadata.generationJobId)
      .filter((value): value is string => Boolean(value)),
  );
  return new Set(
    project.nodes
      .filter((node) => deletedIds.has(node.id))
      .map((node) => node.metadata.generationJobId)
      .filter((value): value is string => typeof value === "string" && value.length > 0 && !survivingJobIds.has(value)),
  );
}

export function generationCleanupNodeIdsAfterDeletion(
  project: BoardProject,
  deletedIds: ReadonlySet<string>,
): Set<string> {
  const orphanedJobIds = orphanedGenerationJobIdsAfterDeletion(project, deletedIds);
  return new Set(
    project.nodes
      .filter((node) => deletedIds.has(node.id))
      .filter((node) => !node.metadata.generationJobId || orphanedJobIds.has(node.metadata.generationJobId))
      .map((node) => node.id),
  );
}

type DirectorShotCapture = {
  id: string;
  cameraId: string;
  cameraName: string;
  createdAt: string;
  shot?: DirectorShotSnapshot;
};

type DirectorShotMedia = {
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};

export function planDirectorShotGeneration(
  project: BoardProject,
  input: {
    directorId: string;
    capture: DirectorShotCapture;
    media: DirectorShotMedia;
    generation: ImageGenerationMetadata;
    jobId: string;
  },
): BoardProject {
  const director = project.nodes.find((node) => node.id === input.directorId);
  const scene = director?.metadata.directorScene;
  if (!director || director.type !== "director" || !scene) throw new Error("导演台节点已不存在");
  const snapshot = input.capture.shot;
  if (!snapshot || snapshot.directorNodeId !== director.id || snapshot.camera.id !== input.capture.cameraId) {
    throw new Error("截图缺少拍摄时机位快照，请重新拍摄当前机位");
  }
  if (!input.media.storageKey || !input.media.mimeType.startsWith("image/") ||
      input.media.width < 1 || input.media.height < 1 || input.media.bytes < 1) {
    throw new Error("导演台截图媒体无效");
  }
  if (input.generation.referenceStorageKeys.length !== 1 ||
      input.generation.referenceStorageKeys[0] !== input.media.storageKey) {
    throw new Error("正式镜头必须且只能引用当前导演台截图");
  }

  const shotBase = {
    version: 1 as const,
    directorNodeId: director.id,
    captureId: input.capture.id,
    capturedAt: input.capture.createdAt,
    snapshot: structuredClone(snapshot),
  };
  const display = fitMediaDisplaySize(input.media.width, input.media.height);
  const captureNode = createNode("image", {
    x: director.position.x + director.width + 80,
    y: director.position.y,
  }, {
    title: `${director.title} · ${input.capture.cameraName} · 拍摄参考`,
    width: display.width,
    height: display.height,
    metadata: {
      content: input.media.url,
      storageKey: input.media.storageKey,
      naturalWidth: input.media.width,
      naturalHeight: input.media.height,
      bytes: input.media.bytes,
      mimeType: input.media.mimeType,
      derivedFromId: director.id,
      status: "success",
      directorShot: { ...shotBase, role: "capture" } satisfies DirectorShotMetadata,
    },
  });
  const configNode = createNode("config", {
    x: captureNode.position.x + captureNode.width + 60,
    y: captureNode.position.y,
  }, {
    title: `${input.capture.cameraName} · 正式镜头配置`,
    metadata: {
      ...input.generation,
      generationMode: "image",
      status: "idle",
      derivedFromId: captureNode.id,
      inputOrder: [captureNode.id],
      directorShot: { ...shotBase, role: "config" } satisfies DirectorShotMetadata,
    },
  });
  const withInputs: BoardProject = {
    ...project,
    nodes: [...project.nodes, captureNode, configNode],
    edges: [
      ...project.edges,
      { id: uid("edge"), from: director.id, to: captureNode.id },
      { id: uid("edge"), from: captureNode.id, to: configNode.id },
    ],
  };
  return applyServerImagePlaceholders(withInputs, configNode.id, input.jobId, input.generation);
}
