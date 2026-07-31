import type { AiChannel, TextReasoningEffort } from "@/types/board";
import { generateText } from "@/services/ai-client";

export type TextBatchOptions = {
  channel: AiChannel;
  model: string;
  prompt: string;
  images?: string[];
  systemPrompt?: string;
  reasoningEffort?: TextReasoningEffort;
  count: number;
};

export async function generateTextBatch(options: TextBatchOptions): Promise<string[]> {
  if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > 8) {
    throw new Error("文本生成数量必须为 1-8");
  }
  const request = {
    channel: options.channel,
    model: options.model,
    prompt: options.prompt,
    images: [...(options.images ?? [])],
    systemPrompt: options.systemPrompt,
    reasoningEffort: options.reasoningEffort,
  };
  let results: string[] = [];
  for (let offset = 0; offset < options.count; offset += 2) {
    const waveSize = Math.min(2, options.count - offset);
    const wave = await Promise.all(
      Array.from({ length: waveSize }, () => generateText(request)),
    );
    results = [...results, ...wave];
  }
  return results;
}
