import type { AiChannel } from "@/types/board";

export function resolveWorkbenchRunChannel(
  choices: readonly AiChannel[],
  current: AiChannel | undefined,
  recordedProviderId?: string,
): AiChannel | undefined {
  if (!recordedProviderId) return current;
  const recorded = choices.find((channel) => channel.id === recordedProviderId);
  if (!recorded) {
    throw new Error(`历史任务使用的渠道 ${recordedProviderId} 已不可用，请恢复该渠道后再重试`);
  }
  return recorded;
}
