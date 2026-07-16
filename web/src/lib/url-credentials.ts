export interface UrlCredentials {
  apiKey?: string;
  baseUrl?: string;
  provider?: "text" | "image" | "video" | "audio";
}

export interface ConsumedUrlCredentials {
  credentials: UrlCredentials;
  sanitizedPath: string;
  hadSensitiveParams: boolean;
}

/** Consume one-time fragment credentials and scrub legacy query secrets without using them. */
export function consumeUrlCredentials(input: string): ConsumedUrlCredentials {
  const url = new URL(input);
  const hadLegacyQuery = url.searchParams.has("apiKey") || url.searchParams.has("baseUrl");
  const credentials: UrlCredentials = {};
  const fragmentParams = url.hash.startsWith("#connect?")
    ? new URLSearchParams(url.hash.slice("#connect?".length))
    : null;

  if (fragmentParams?.has("apiKey")) credentials.apiKey = fragmentParams.get("apiKey") ?? "";
  if (fragmentParams?.has("baseUrl")) credentials.baseUrl = fragmentParams.get("baseUrl") ?? "";
  const provider = fragmentParams?.get("provider");
  if (provider === "text" || provider === "image" || provider === "video" || provider === "audio") credentials.provider = provider;

  url.searchParams.delete("apiKey");
  url.searchParams.delete("baseUrl");
  if (fragmentParams) url.hash = "";

  return {
    credentials,
    sanitizedPath: `${url.pathname}${url.search}${url.hash}`,
    hadSensitiveParams: hadLegacyQuery || fragmentParams !== null,
  };
}

export function applyChannelUrlCredentials(
  channel: AiChannel,
  credentials: UrlCredentials,
): AiChannel {
  const kind = credentials.provider ?? "text";
  const current = channel.providers?.[kind];
  const baseUrl = credentials.baseUrl === undefined
    ? (current?.baseUrl ?? channel.baseUrl)
    : normalizeProviderBaseUrl(credentials.baseUrl);
  const originChanged = providerOrigin(baseUrl) !== providerOrigin(current?.baseUrl ?? channel.baseUrl);
  const providers = {
    ...(channel.providers ?? {}),
    [kind]: {
      baseUrl,
      apiKey: credentials.apiKey ?? (originChanged ? "" : (current?.apiKey ?? channel.apiKey)),
      model: current?.model ?? (kind === "text" ? channel.defaultTextModel : kind === "image" ? channel.defaultImageModel : kind === "video" ? channel.defaultVideoModel : channel.defaultAudioModel ?? "gpt-4o-mini-tts"),
    },
  } as NonNullable<typeof channel.providers>;
  return {
    ...channel,
    providers,
    baseUrl: kind === "text" ? baseUrl : channel.baseUrl,
    apiKey: kind === "text" ? providers.text.apiKey : channel.apiKey,
  };
}

function normalizeProviderBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Provider Base URL is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Provider Base URL must use HTTPS unless it is loopback");
  }
  if (url.username || url.password) throw new Error("Provider Base URL must not include credentials");
  if (url.search || url.hash) throw new Error("Provider Base URL must not include query or fragment data");
  return url.toString().replace(/\/+$/, "");
}

function providerOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "invalid";
  }
}
import type { AiChannel } from "@/types/board";
