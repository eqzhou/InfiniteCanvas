import type { NodeMetadata } from "@/types/board";

/**
 * Resolve the prompt at the configuration-node boundary.  This deliberately
 * keeps a connected text node from silently replacing an independently edited
 * prompt, which was the source of several hard-to-reproduce canvas requests.
 */
export function resolveConfigPrompt({
  promptSource,
  prompt,
  upstreamTexts,
}: Pick<NodeMetadata, "promptSource" | "prompt"> & { upstreamTexts: readonly string[] }): string {
  const upstream = upstreamTexts.filter(Boolean).join("\n\n");
  const local = prompt?.trim() ?? "";
  if (promptSource === "independent") return local;
  if (promptSource === "upstream") return upstream || local;
  // Existing boards used upstream text when present. Preserve that legacy
  // behaviour until a user explicitly chooses a source mode.
  return upstream || local;
}
