import type { BoardNode, BoardProject } from "@/types/board";

export type NodePromptType = Extract<BoardNode["type"], "text" | "image" | "video" | "audio">;

export function isNodePromptType(type: BoardNode["type"]): type is NodePromptType {
  return type === "text" || type === "image" || type === "video" || type === "audio";
}

export function nodePromptKind(type: NodePromptType): NodePromptType {
  return type;
}

export function nodePromptPlaceholder(type: NodePromptType, hasContent: boolean): string {
  if (type === "text") return hasContent ? "描述如何改写这段文本…" : "输入要生成的文本…";
  if (type === "image") return hasContent ? "描述如何基于此图继续创作…" : "输入提示词生成图片…";
  if (type === "video") return "输入视频提示词…";
  return "输入语音文本…";
}

/**
 * Text and config nodes own textual intent. An image connected only to other
 * images still owns its prompt because those inputs provide references, not
 * generation instructions.
 */
export function imagePromptInheritsFromUpstream(
  project: Pick<BoardProject, "nodes" | "edges"> | null | undefined,
  node: Pick<BoardNode, "id" | "type" | "metadata">,
): boolean {
  if (!project || node.type !== "image") return false;
  if (node.metadata.generationConfigId) {
    const config = project.nodes.find((candidate) => candidate.id === node.metadata.generationConfigId);
    if (config?.type === "config") return true;
  }
  const incomingIds = new Set(
    project.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from),
  );
  return project.nodes.some((candidate) =>
    incomingIds.has(candidate.id) && (candidate.type === "text" || candidate.type === "config"));
}

export function initialNodePrompt(
  node: Pick<BoardNode, "type" | "metadata">,
  inheritsFromUpstream = false,
): string {
  if (node.type === "image" && inheritsFromUpstream) return "";
  return node.metadata.prompt ?? "";
}

export function canRegenerateImageFromPrompt(
  node: Pick<BoardNode, "type" | "metadata">,
  inheritsFromUpstream: boolean,
): boolean {
  return node.type === "image" &&
    !inheritsFromUpstream &&
    Boolean(node.metadata.content || node.metadata.storageKey) &&
    Boolean(node.metadata.generationType);
}
