import type { BoardNode } from "@/types/board";

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

/** A generated image keeps its original request as a snapshot, never as a draft. */
export function initialNodePrompt(node: Pick<BoardNode, "type" | "metadata">): string {
  if (node.type === "image" && (node.metadata.content || node.metadata.storageKey)) return "";
  return node.metadata.prompt ?? "";
}
