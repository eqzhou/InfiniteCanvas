import type { NodeMetadata } from "@/types/board";

export function resolveConfigPrompt({
  prompt,
  upstreamTexts,
}: Pick<NodeMetadata, "prompt"> & { upstreamTexts: readonly string[] }): string {
  const upstream = upstreamTexts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  const local = prompt?.trim() ?? "";
  return local || upstream;
}
