import type { AiChannel, AiEndpointConfig, AiProviderKind, AiProviders } from "@/types/board";

export function defaultProviders(channel: AiChannel): AiProviders {
  const base = { baseUrl: channel.baseUrl, apiKey: channel.apiKey, model: "" };
  return {
    text: { ...base, model: channel.defaultTextModel },
    image: { ...base, model: channel.defaultImageModel },
    video: { ...base, model: channel.defaultVideoModel },
    audio: { ...base, model: channel.defaultAudioModel ?? "gpt-4o-mini-tts" },
  };
}

export function getProvider(channel: AiChannel, kind: AiProviderKind): AiEndpointConfig {
  return channel.providers?.[kind] ?? defaultProviders(channel)[kind];
}

export function normalizeChannel(channel: AiChannel): AiChannel {
  const providers = { ...defaultProviders(channel), ...(channel.providers ?? {}) };
  return {
    ...channel,
    providers,
    baseUrl: providers.text.baseUrl,
    apiKey: providers.text.apiKey,
    defaultTextModel: providers.text.model,
    defaultImageModel: providers.image.model,
    defaultVideoModel: providers.video.model,
    defaultAudioModel: providers.audio.model,
  };
}
