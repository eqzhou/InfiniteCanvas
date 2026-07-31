import type { AiChannel, BoardNode } from "@/types/board";
import { getProvider } from "@/lib/ai-config";
import {
  resolveSelectableModels,
  type ModelCatalog,
  type ModelCatalogKind,
} from "@/lib/model-catalog";
import { defaultModelForMode } from "@/lib/generation-model";
import { isNodePromptType, nodePromptKind, type NodePromptType } from "@/lib/node-prompt";

export function nodePromptModelKind(type: BoardNode["type"]): ModelCatalogKind | null {
  if (!isNodePromptType(type)) return null;
  return nodePromptKind(type as NodePromptType);
}

/**
 * Models the node prompt bar may offer. Prefer the last pulled endpoint list
 * (persisted on the provider), then fall back to the active default so the
 * select is never empty when a model is already configured.
 */
export function resolveNodePromptModels(
  channel: AiChannel | null | undefined,
  kind: ModelCatalogKind,
  catalog: ModelCatalog | null | undefined = null,
): string[] {
  if (!channel) return [];
  const provider = getProvider(channel, kind);
  const pulled = provider.models ?? [];
  const fallback = provider.model ? [provider.model] : [];
  const channelModels = pulled.length ? pulled : fallback;
  return resolveSelectableModels(catalog, channelModels);
}

export function resolveNodePromptSelectedModel(
  node: BoardNode,
  channel: AiChannel | null | undefined,
): string {
  if (!isNodePromptType(node.type) || !channel) return node.metadata.model ?? "";
  const kind = nodePromptKind(node.type);
  const explicit = (node.metadata.model ?? "").trim();
  if (explicit) return explicit;
  return resolveInheritedNodePromptModel(channel, kind);
}

export function resolveNodePromptModelChoices(
  node: BoardNode,
  channel: AiChannel | null | undefined,
  catalog: ModelCatalog | null | undefined = null,
): { inheritedLabel: string; options: string[] } {
  if (!isNodePromptType(node.type) || !channel) {
    return { inheritedLabel: "跟随渠道默认模型", options: [] };
  }
  const kind = nodePromptKind(node.type);
  const inherited = resolveInheritedNodePromptModel(channel, kind);
  const explicit = (node.metadata.model ?? "").trim();
  const options = [...new Set(resolveNodePromptModels(channel, kind, catalog))]
    .filter((model) => explicit || model !== inherited);
  return {
    inheritedLabel: inherited ? `跟随渠道（${inherited}）` : "跟随渠道默认模型",
    options,
  };
}

function resolveInheritedNodePromptModel(channel: AiChannel, kind: NodePromptType): string {
  if (kind === "audio") return getProvider(channel, "audio").model;
  return defaultModelForMode(channel, kind === "text" || kind === "video" ? kind : "image");
}
