import type {
  AiChannel,
  AppConfig,
  AssistantSession,
  BoardNode,
  BoardProject,
  NodeType,
} from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { clonePresetSource, COMMUNITY_PROMPT_SOURCE_PRESETS } from "@/services/prompt-source-presets";
import { createDefaultDirectorScene } from "@/lib/director-scene";
import { normalizeImageToolbarPreferences } from "@/lib/image-toolbar-preferences";

export const DEFAULT_NODE_SIZE: Record<NodeType, { width: number; height: number }> = {
  text: { width: 280, height: 180 },
  image: { width: 320, height: 320 },
  config: { width: 300, height: 300 },
  video: { width: 360, height: 240 },
  audio: { width: 320, height: 120 },
  panorama: { width: 360, height: 280 },
  director: { width: 360, height: 240 },
  group: { width: 480, height: 320 },
  plugin: { width: 320, height: 220 },
};

export function createDefaultChannel(): AiChannel {
  return {
    id: uid("ch"),
    name: "OpenAI Compatible",
    timeoutSeconds: 60,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    defaultTextModel: "gpt-4o-mini",
    defaultImageModel: "gpt-image-1",
    defaultVideoModel: "sora-2",
    defaultAudioModel: "gpt-4o-mini-tts",
    providers: {
      text: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini", protocol: "openai" },
      image: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-image-1", protocol: "openai" },
      video: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "sora-2", protocol: "openai" },
      audio: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini-tts", protocol: "openai" },
    },
  };
}

export function createDefaultConfig(): AppConfig {
  const channel = createDefaultChannel();
  return {
    channels: [channel],
    activeChannelId: channel.id,
    systemPrompt: "",
    imageSize: "1024x1024",
    imageQuality: "auto",
    imageCount: 1,
    preferredModels: {},
    theme: "system",
    webdavUrl: "",
    webdavUser: "",
    webdavPass: "",
    objectStorage: {
      enabled: false,
      endpoint: "",
      bucket: "",
      region: "auto",
      prefix: "openboard",
      accessKeyId: "",
      secretAccessKey: "",
      sessionToken: "",
      allowInsecureLoopback: false,
    },
    promptSources: COMMUNITY_PROMPT_SOURCE_PRESETS.map((preset) => clonePresetSource(preset)),
    plugins: [],
    disabledPluginIds: [],
    localAgentUrl: "http://127.0.0.1:8790",
    canvasPanelWidth: 256,
    canvasPanelCollapsed: false,
    canvasPanelTab: "projects",
    imageToolbar: normalizeImageToolbarPreferences(undefined),
  };
}

export function createEmptySession(title = "新会话"): AssistantSession {
  const t = nowIso();
  return {
    id: uid("chat"),
    title,
    messages: [],
    createdAt: t,
    updatedAt: t,
  };
}

export function createProject(
  title = "未命名画布",
  projectKind: BoardProject["projectKind"] = "canvas",
): BoardProject {
  const t = nowIso();
  const session = createEmptySession();
  return {
    schemaVersion: 3,
    projectKind,
    id: uid("proj"),
    title,
    createdAt: t,
    updatedAt: t,
    nodes: [],
    edges: [],
    chatSessions: [session],
    activeChatId: session.id,
    backgroundMode: "dots",
    viewport: { x: 0, y: 0, k: 1 },
    audioRoles: [],
  };
}

export function createNode(
  type: NodeType,
  position: { x: number; y: number },
  partial?: Partial<BoardNode>,
): BoardNode {
  const size = DEFAULT_NODE_SIZE[type];
  const titles: Record<NodeType, string> = {
    text: "文本",
    image: "图片",
    config: "生成配置",
    video: "视频",
    audio: "音频",
    panorama: "360° 全景",
    director: "3D 导演台",
    group: "分组",
    plugin: "插件",
  };
  const baseMeta =
    type === "config"
      ? {
          generationMode: "image" as const,
          size: "1024x1024",
          count: 1,
          status: "idle" as const,
        }
      : type === "text"
        ? { content: "", fontSize: 14, status: "idle" as const }
        : type === "panorama"
          ? { status: "idle" as const, panoramaProjection: "equirectangular" as const, count: 1 }
        : type === "director"
          ? { status: "idle" as const, directorScene: createDefaultDirectorScene() }
        : { status: "idle" as const };

  return {
    id: partial?.id ?? uid("node"),
    type,
    title: partial?.title ?? titles[type],
    position: partial?.position ?? position,
    width: partial?.width ?? size.width,
    height: partial?.height ?? size.height,
    metadata: {
      ...baseMeta,
      ...partial?.metadata,
    },
  };
}
