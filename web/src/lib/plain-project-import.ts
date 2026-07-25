import type { BoardProject } from "@/types/board";

export function assertPlainProjectImportSafe(project: BoardProject): BoardProject {
  const hasPanoramaMedia = project.nodes.some((node) =>
    node.type === "panorama" && Boolean(node.metadata.content || node.metadata.storageKey));
  if (hasPanoramaMedia) {
    throw new Error("包含全景媒体的项目必须使用 .openboard 完整包导入");
  }
  return project;
}

export function assertBundlePanoramaMediaManaged(project: BoardProject): BoardProject {
  const inlinePanorama = project.nodes.some((node) =>
    node.type === "panorama" && Boolean(node.metadata.content) && !node.metadata.storageKey);
  if (inlinePanorama) {
    throw new Error("Bundle panorama media must be managed by the manifest");
  }
  return project;
}
