import type { AiChannel } from "@/types/board";
import { generateText } from "@/services/ai-client";

export type TextBatchOptions = {
  channel: AiChannel;
  model: string;
  prompt: string;
  images?: string[];
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
  };
  return Promise.all(
    Array.from({ length: options.count }, () => generateText(request)),
  );
}
