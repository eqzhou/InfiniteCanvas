import type {
  AiChannel,
  AiEndpointConfig,
  AiProtocol,
  AiProviderKind,
  AiTemplateConfig,
  AppConfig,
} from "@/types/board";
import { normalizeAppConfig } from "@/lib/app-config";
import { normalizeChannel } from "@/lib/ai-config";
import { normalizeObjectStorage } from "@/lib/object-storage";
import { validateProviderTemplate } from "@/lib/provider-template";
import { sanitizeConfigForPersistence } from "@/services/storage";

const CONFIG_FILE_SCHEMA = "openboard-config";
const CONFIG_FILE_VERSION = 1;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const MAX_CHANNELS = 32;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROVIDER_KINDS: readonly AiProviderKind[] = ["text", "image", "video", "audio"];
const PROTOCOLS = new Set<AiProtocol>(["openai", "ark", "gemini", "template", "apimart", "kie", "azure", "edge"]);

export type OpenBoardConfigFile = Readonly<{
  schema: typeof CONFIG_FILE_SCHEMA;
  version: typeof CONFIG_FILE_VERSION;
  exportedAt: string;
  config: AppConfig;
}>;

export function exportConfigFile(config: AppConfig): OpenBoardConfigFile {
  const sanitized = sanitizeConfigForPersistence(normalizeAppConfig(structuredClone(config)));
  return {
    schema: CONFIG_FILE_SCHEMA,
    version: CONFIG_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    config: {
      ...sanitized,
      // These surfaces can contain executable or installable definitions and
      // remain under their dedicated consent/validation flows.
      promptSources: undefined,
      plugins: undefined,
      disabledPluginIds: undefined,
      pluginRegistryUrl: undefined,
      audioRoles: undefined,
    },
  };
}

export function hasSameChannelConfiguration(first: AppConfig, second: AppConfig): boolean {
  const normalizedChannels = (config: AppConfig) => JSON.stringify(
    config.channels.map((channel) => normalizeChannel(channel)),
  );
  return normalizedChannels(first) === normalizedChannels(second);
}

export function importConfigFile(raw: string, current: AppConfig): AppConfig {
  if (new TextEncoder().encode(raw).byteLength > MAX_CONFIG_FILE_BYTES) {
    throw new Error("配置文件过大");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("配置文件不是有效 JSON");
  }
  if (!isConfigFile(parsed)) throw new Error("配置文件格式无效");

  const imported = parsePortableConfig(parsed.config, current);
  const currentChannels = new Map(current.channels.map((channel) => [
    channel.id,
    normalizeChannel(channel),
  ]));
  const channels = imported.channels.map((rawChannel) => {
    const channel = normalizeChannel(rawChannel);
    const existing = currentChannels.get(channel.id);
    if (!existing) return channel;
    const providers = {
      text: preserveProviderCredential(channel.providers!.text, existing.providers!.text),
      image: preserveProviderCredential(channel.providers!.image, existing.providers!.image),
      video: preserveProviderCredential(channel.providers!.video, existing.providers!.video),
      audio: preserveProviderCredential(channel.providers!.audio, existing.providers!.audio),
    };
    return { ...channel, apiKey: providers.text.apiKey, providers };
  });
  const currentStorage = normalizeObjectStorage(current.objectStorage);
  const importedStorage = normalizeObjectStorage(imported.objectStorage);
  const preserveWebDAVPassword = sameWebDAVDestination(imported, current);
  const preserveStorageCredentials = sameObjectStorageDestination(importedStorage, currentStorage);
  return normalizeAppConfig({
    ...imported,
    channels,
    activeChannelId: channels.some((channel) => channel.id === imported.activeChannelId)
      ? imported.activeChannelId
      : channels[0]?.id ?? null,
    webdavPass: preserveWebDAVPassword ? current.webdavPass ?? "" : "",
    objectStorage: {
      ...importedStorage,
      accessKeyId: preserveStorageCredentials ? currentStorage.accessKeyId : "",
      secretAccessKey: preserveStorageCredentials ? currentStorage.secretAccessKey : "",
      sessionToken: preserveStorageCredentials ? currentStorage.sessionToken : "",
    },
    // Importing preferences must never bypass the dedicated consent and
    // validation flows for plugins or executable prompt-source scripts.
    promptSources: current.promptSources,
    plugins: current.plugins,
    disabledPluginIds: current.disabledPluginIds,
    pluginRegistryUrl: current.pluginRegistryUrl,
  });
}

function preserveProviderCredential(
  imported: AiEndpointConfig,
  current: AiEndpointConfig,
): AiEndpointConfig {
  const sameCredentialRoute = imported.baseUrl === current.baseUrl &&
    imported.protocol === current.protocol &&
    JSON.stringify(imported.template ?? null) === JSON.stringify(current.template ?? null);
  return {
    ...imported,
    apiKey: sameCredentialRoute ? current.apiKey : "",
  };
}

function sameWebDAVDestination(imported: AppConfig, current: AppConfig): boolean {
  return (imported.webdavUrl ?? "").trim() === (current.webdavUrl ?? "").trim() &&
    (imported.webdavUser ?? "").trim() === (current.webdavUser ?? "").trim();
}

function sameObjectStorageDestination(
  imported: ReturnType<typeof normalizeObjectStorage>,
  current: ReturnType<typeof normalizeObjectStorage>,
): boolean {
  return imported.endpoint === current.endpoint &&
    imported.bucket === current.bucket &&
    imported.region === current.region &&
    imported.prefix === current.prefix &&
    imported.allowInsecureLoopback === current.allowInsecureLoopback;
}

function parsePortableConfig(value: Record<string, unknown>, current: AppConfig): AppConfig {
  const channels = parseChannels(value.channels);
  const theme = value.theme;
  if (theme !== "light" && theme !== "dark" && theme !== "system") {
    throw new Error("配置文件中的主题无效");
  }
  const imageCount = value.imageCount;
  if (!Number.isSafeInteger(imageCount) || Number(imageCount) < 1 || Number(imageCount) > 100) {
    throw new Error("配置文件中的默认数量无效");
  }
  const imported = {
    ...structuredClone(value),
    channels,
    activeChannelId: value.activeChannelId === null
      ? null
      : readString(value.activeChannelId, 128, "当前渠道"),
    systemPrompt: readString(value.systemPrompt, 20_000, "系统提示词", true),
    imageSize: readString(value.imageSize, 128, "图片尺寸"),
    imageQuality: readString(value.imageQuality, 128, "图片质量"),
    imageCount: Number(imageCount),
    theme,
    webdavUrl: optionalString(value.webdavUrl, 8 * 1024, "WebDAV URL"),
    webdavUser: optionalString(value.webdavUser, 8 * 1024, "WebDAV 用户名"),
    webdavPass: "",
    // Preserve these values here as well as at the final merge so normalizers
    // never inspect executable definitions from the imported document.
    promptSources: current.promptSources,
    plugins: current.plugins,
    disabledPluginIds: current.disabledPluginIds,
    pluginRegistryUrl: current.pluginRegistryUrl,
  } as AppConfig;
  return sanitizeConfigForPersistence(normalizeAppConfig(imported));
}

function parseChannels(value: unknown): AiChannel[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHANNELS) {
    throw new Error("配置文件中的渠道无效");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    try {
      if (!isRecord(item)) throw new Error("not an object");
      const id = readString(item.id, 128, "渠道 ID");
      if (!CHANNEL_ID.test(id) || seen.has(id)) throw new Error("invalid channel ID");
      seen.add(id);
      const legacy: AiChannel = {
        id,
        name: readString(item.name, 120, "渠道名称"),
        timeoutSeconds: item.timeoutSeconds as number | undefined,
        baseUrl: readString(item.baseUrl, 8 * 1024, "渠道 URL", true),
        apiKey: "",
        defaultTextModel: readString(item.defaultTextModel, 512, "文本模型", true),
        defaultImageModel: readString(item.defaultImageModel, 512, "图片模型", true),
        defaultVideoModel: readString(item.defaultVideoModel, 512, "视频模型", true),
        defaultAudioModel: optionalString(item.defaultAudioModel, 512, "音频模型"),
      };
      if (item.providers !== undefined) {
        if (!isRecord(item.providers)) throw new Error("invalid providers");
        const providers = item.providers;
        legacy.providers = Object.fromEntries(PROVIDER_KINDS.map((kind) => [
          kind,
          parseProvider(providers[kind], kind),
        ])) as NonNullable<AiChannel["providers"]>;
      }
      return normalizeChannel(legacy);
    } catch {
      throw new Error("配置文件中的渠道无效");
    }
  });
}

function parseProvider(
  value: unknown,
  kind: AiProviderKind,
): AiEndpointConfig {
  if (!isRecord(value)) throw new Error(`invalid ${kind} provider`);
  const protocol = value.protocol;
  if (typeof protocol !== "string" || !PROTOCOLS.has(protocol as AiProtocol)) {
    throw new Error(`invalid ${kind} protocol`);
  }
  const models = value.models;
  if (models !== undefined && (
    !Array.isArray(models) ||
    models.length > 500 ||
    models.some((model) => typeof model !== "string" || model.length > 512)
  )) {
    throw new Error(`invalid ${kind} models`);
  }
  let template: AiTemplateConfig | undefined;
  if (value.template !== undefined) {
    template = structuredClone(value.template) as AiTemplateConfig;
    validateProviderTemplate(template);
  }
  return {
    baseUrl: readString(value.baseUrl, 8 * 1024, `${kind} URL`, true),
    apiKey: "",
    model: readString(value.model, 512, `${kind} 模型`, true),
    protocol: protocol as AiProtocol,
    ...(models ? { models: [...models] as string[] } : {}),
    ...(template ? { template } : {}),
  };
}

function readString(
  value: unknown,
  maxLength: number,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && value.length === 0)) {
    throw new Error(`配置文件中的${label}无效`);
  }
  return value;
}

function optionalString(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, maxLength, label, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConfigFile(value: unknown): value is {
  schema: typeof CONFIG_FILE_SCHEMA;
  version: typeof CONFIG_FILE_VERSION;
  config: Record<string, unknown>;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== CONFIG_FILE_SCHEMA || candidate.version !== CONFIG_FILE_VERSION) return false;
  if (!candidate.config || typeof candidate.config !== "object" || Array.isArray(candidate.config)) return false;
  return Array.isArray((candidate.config as Record<string, unknown>).channels);
}
