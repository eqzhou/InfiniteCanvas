export type NodeType = "text" | "image" | "config" | "video" | "audio" | "group" | "plugin";
export type BackgroundMode = "dots" | "lines" | "blank";
export type GenMode = "text" | "image" | "video";
export type NodeStatus = "idle" | "loading" | "success" | "error";
export type AssistantMode = "ask" | "image";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Viewport = { x: number; y: number; k: number };
export type PluginPermission = "node:read" | "node:write";
export type PluginManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  document: string;
  permissions: PluginPermission[];
  defaultSize: Size;
};

export type NodeMetadata = {
  content?: string;
  prompt?: string;
  status?: NodeStatus;
  errorDetails?: string;
  fontSize?: number;
  generationMode?: GenMode;
  model?: string;
  size?: string;
  count?: number;
  quality?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  freeResize?: boolean;
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
  inputOrder?: string[];
  duration?: number;
  videoRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  voice?: string;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  /** audio duration seconds if known */
  audioDuration?: number;
  /** mask/upscale lineage */
  derivedFromId?: string;
  transformOperation?: "upscale" | "inpaint" | "mask";
  transformProvider?: string;
  transformModel?: string;
  transformRequestId?: string;
  transformParameters?: Record<string, string | number | boolean>;
  splitIndex?: number;
  splitCount?: number;
  /** Member nodes for an independently authored group container. */
  childIds?: string[];
  pluginId?: string;
  pluginState?: Record<string, unknown>;
};



export type BoardNode = {
  id: string;
  type: NodeType;
  title: string;
  position: Point;
  width: number;
  height: number;
  metadata: NodeMetadata;
};

export type BoardEdge = {
  id: string;
  from: string;
  to: string;
};

export type AssistantRef = {
  nodeId: string;
  kind: NodeType;
  label: string;
  preview?: string;
  storageKey?: string;
};

export type AssistantImage = {
  id: string;
  url: string;
  storageKey?: string;
};

export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  mode: AssistantMode;
  text: string;
  isLoading?: boolean;
  references?: AssistantRef[];
  images?: AssistantImage[];
};

export type AssistantSession = {
  id: string;
  title: string;
  messages: AssistantMessage[];
  createdAt: string;
  updatedAt: string;
};

export type BoardProject = {
  schemaVersion: 2;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: BoardNode[];
  edges: BoardEdge[];
  chatSessions: AssistantSession[];
  activeChatId: string | null;
  backgroundMode: BackgroundMode;
  viewport: Viewport;
};

export type ProjectSummary = {
  id: string;
  title: string;
  updatedAt: string;
  nodeCount: number;
};

export type AssetItem = {
  id: string;
  kind: "text" | "image";
  title: string;
  tags: string[];
  notes?: string;
  source?: string;
  content?: string;
  coverUrl?: string;
  storageKey?: string;
  mimeType?: string;
  createdAt: string;
  updatedAt: string;
};

export type PromptItem = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
  coverUrl?: string;
};

export type AiChannel = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultTextModel: string;
  defaultImageModel: string;
  defaultVideoModel: string;
  defaultAudioModel?: string;
  providers?: AiProviders;
};

export type AiProviderKind = "text" | "image" | "video" | "audio";
export type AiEndpointConfig = { baseUrl: string; apiKey: string; model: string };
export type AiProviders = Record<AiProviderKind, AiEndpointConfig>;

export type AppConfig = {
  channels: AiChannel[];
  activeChannelId: string | null;
  imageSize: string;
  imageQuality: string;
  imageCount: number;
  theme: "light" | "dark" | "system";
  webdavUrl?: string;
  webdavUser?: string;
  webdavPass?: string;
  promptSources?: string[];
  plugins?: PluginManifest[];
  localAgentUrl?: string;
};

export type ClipboardPayload = {
  nodes: BoardNode[];
  edges: BoardEdge[];
};
