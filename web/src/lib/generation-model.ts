import type { AiChannel, GenMode } from "@/types/board";
import { getProvider } from "@/lib/ai-config";

export function defaultModelForMode(channel: AiChannel, mode: GenMode): string {
  if (mode === "text") return getProvider(channel, "text").model;
  if (mode === "video") return getProvider(channel, "video").model;
  return getProvider(channel, "image").model;
}
