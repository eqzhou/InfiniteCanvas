export type NodeType = "text" | "image" | "config" | "video" | "audio" | "group" | "plugin";
export type BackgroundMode = "dots" | "lines" | "blank";
export type GenMode = "text" | "image" | "video";
export type NodeStatus = "idle" | "loading" | "success" | "error";
export type AssistantMode = "ask" | "image";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Viewport = { x: number; y: number; k: number };
export type PluginPermission =
  | "node:read"
  | "node:write"
  | "asset:read"
  | "asset:write"
  | "ai:text"
  | "ai:image"
  | "ai:video"
  | "panel:control";
export type PluginManifest = {
  schemaVersion: 2;
  id: string;
  name: string;
  version: string;
  description: string;
  document: string;
  permissions: PluginPermission[];
  defaultSize: Size;
};

export type PluginRegistryEntry = {
  id: string;
  name: string;
  version: string;
  description: string;
  manifestUrl: string;
};

export type PluginRegistry = {
  schemaVersion: 1;
  plugins: PluginRegistryEntry[];
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
  smartDuration?: boolean;
  videoRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  transparentBackground?: boolean;
  generationType?: "text-to-image" | "image-to-image";
  referenceStorageKeys?: string[];
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
  transformOperation?: "upscale" | "inpaint" | "mask" | "split";
  transformProvider?: string;
  transformModel?: string;
  transformRequestId?: string;
  transformParameters?: Record<string, string | number | boolean>;
  splitIndex?: number;
  splitCount?: number;
  splitVertical?: number[];
  splitHorizontal?: number[];
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
  kind: "text" | "image" | "video" | "audio";
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
  sourceId?: string;
  coverUrl?: string;
  resultUrls?: string[];
};

export type PromptSourceFormat = "auto" | "json" | "markdown" | "html" | "script";
export type PromptSourceMapping = {
  itemsPath?: string;
  idPath?: string;
  titlePath?: string;
  bodyPath?: string;
  tagsPath?: string;
  coverUrlPath?: string;
  resultUrlsPath?: string;
};
export type PromptSourceHtmlMapping = {
  itemSelector: string;
  titleSelector?: string;
  bodySelector: string;
  tagsSelector?: string;
  coverSelector?: string;
  resultSelector?: string;
};
export type PromptSourceConfig = {
  id: string;
  name: string;
  url: string;
  format: PromptSourceFormat;
  enabled: boolean;
  refreshMinutes: number;
  mapping?: PromptSourceMapping;
  html?: PromptSourceHtmlMapping;
  /** Local transform script for format=script. Receives (text, url, helpers). */
  script?: string;
  lastFetchedAt?: string;
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
export type AiProtocol = "openai" | "ark" | "gemini" | "template";
export type AiTemplateConfig = {
  method: "POST" | "PUT";
  path: string;
  auth: "bearer" | "x-api-key";
  request: Record<string, unknown>;
  responsePath: string;
  taskIdPath?: string;
  statusPath?: string;
  resultPath?: string;
  supportsTransparentBackground?: boolean;
};
export type AiEndpointConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: AiProtocol;
  template?: AiTemplateConfig;
};
export type AiProviders = Record<AiProviderKind, AiEndpointConfig>;

export type AppConfig = {
  channels: AiChannel[];
  activeChannelId: string | null;
  systemPrompt: string;
  imageSize: string;
  imageQuality: string;
  imageCount: number;
  theme: "light" | "dark" | "system";
  webdavUrl?: string;
  webdavUser?: string;
  webdavPass?: string;
  promptSources?: PromptSourceConfig[];
  plugins?: PluginManifest[];
  disabledPluginIds?: string[];
  pluginRegistryUrl?: string;
  localAgentUrl?: string;
  canvasPanelWidth?: number;
  canvasPanelCollapsed?: boolean;
  canvasPanelTab?: "projects" | "elements" | "assets" | "prompts";
};

export type ClipboardPayload = {
  nodes: BoardNode[];
  edges: BoardEdge[];
};

export type GenerationKind = "image" | "video";
export type GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type GenerationJob = {
  id: string;
  projectId?: string;
  kind: GenerationKind;
  status: GenerationStatus;
  prompt: string;
  providerId?: string;
  model?: string;
  parameters: Record<string, unknown>;
  result: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type GenerationJobPage = {
  items: GenerationJob[];
  page: number;
  pageSize: number;
  total: number;
};
