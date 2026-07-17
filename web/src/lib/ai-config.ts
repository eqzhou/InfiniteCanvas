import type { AiChannel, AiEndpointConfig, AiProviderKind, AiProviders } from "@/types/board";

export function defaultProviders(channel: AiChannel): AiProviders {
  const base = { baseUrl: channel.baseUrl, apiKey: channel.apiKey, model: "", protocol: "openai" as const };
  return {
    text: { ...base, model: channel.defaultTextModel },
    image: { ...base, model: channel.defaultImageModel },
    video: { ...base, model: channel.defaultVideoModel },
    audio: { ...base, model: channel.defaultAudioModel ?? "gpt-4o-mini-tts" },
  };
}

export function getProvider(channel: AiChannel, kind: AiProviderKind): AiEndpointConfig {
  const fallback = defaultProviders(channel)[kind];
  return { ...fallback, ...channel.providers?.[kind], protocol: channel.providers?.[kind]?.protocol ?? "openai" };
}

export function normalizeChannel(channel: AiChannel): AiChannel {
  const defaults = defaultProviders(channel);
  const providers = {
    text: { ...defaults.text, ...channel.providers?.text },
    image: { ...defaults.image, ...channel.providers?.image },
    video: { ...defaults.video, ...channel.providers?.video },
    audio: { ...defaults.audio, ...channel.providers?.audio },
  };
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
