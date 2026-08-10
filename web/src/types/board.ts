export type NodeType = "text" | "image" | "config" | "video" | "audio" | "panorama" | "director" | "group" | "plugin";
export type BackgroundMode = "dots" | "lines" | "blank";
export type GenMode = "text" | "image" | "video";
export type NodeStatus = "idle" | "loading" | "success" | "error";
export type AssistantMode = "ask" | "image";
export type TextReasoningEffort = "low" | "medium" | "high";
export type CameraPromptCamera = "cinema" | "mirrorless" | "dslr" | "drone" | "action";
export type CameraPromptLens = "wide" | "standard" | "telephoto" | "macro" | "anamorphic";
export type CameraPromptConfig = {
  enabled: boolean;
  camera: CameraPromptCamera;
  lens: CameraPromptLens;
  focalLength: number;
  aperture: number;
};

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Viewport = { x: number; y: number; k: number };
export type DirectorVector3 = { x: number; y: number; z: number };
export type DirectorTransform = {
  position: DirectorVector3;
  rotation: DirectorVector3;
  scale: DirectorVector3;
};
export type DirectorCharacterPreset = "studio" | "tall" | "compact" | "athletic" | "broad" | "casual" | "formal" | "future";
export type DirectorPosePreset =
  | "neutral" | "contrapposto" | "arms-crossed" | "hands-hips" | "wave-left"
  | "wave-right" | "point-left" | "point-right" | "walk-left" | "walk-right"
  | "run" | "sit" | "crouch" | "lean" | "reach" | "look-back" | "guard"
  | "celebrate" | "talk" | "camera-ready";
export type DirectorPrimitive = "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane";
export type DirectorCharacterConfig = {
  preset: DirectorCharacterPreset;
  pose: DirectorPosePreset;
  role: "actor" | "extra";
};
export type DirectorCrowdConfig = {
  preset: DirectorCharacterPreset;
  pose: DirectorPosePreset;
  rows: number;
  columns: number;
  spacingX: number;
  spacingZ: number;
  variation: boolean;
  seed: number;
};
export type DirectorObjectKind = "character" | "crowd" | "prop" | "light" | "model";
export type DirectorModelAssetRef = {
  assetId: string;
  fileName: string;
  bytes: number;
};
export type DirectorObject = {
  id: string;
  kind: DirectorObjectKind;
  name: string;
  visible: boolean;
  locked: boolean;
  color: string;
  intensity: number;
  transform: DirectorTransform;
  character?: DirectorCharacterConfig;
  crowd?: DirectorCrowdConfig;
  primitive?: DirectorPrimitive;
  modelAsset?: DirectorModelAssetRef;
};
export type DirectorCamera = {
  id: string;
  name: string;
  position: DirectorVector3;
  target: DirectorVector3;
  focalLength: number;
  aperture: number;
  aspect: "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
};
export type DirectorScene = {
  version: 4;
  background: string;
  showGroundGrid: boolean;
  showRuleOfThirds: boolean;
  showSafeFrame: boolean;
  viewMode: "director" | "camera";
  directorView: {
    position: DirectorVector3;
    target: DirectorVector3;
  };
  selectedObjectId: string | null;
  activeCameraId: string;
  cameras: DirectorCamera[];
  environment: {
    rotationY: number;
    intensity: number;
    /** Active connected image/panorama node id; multi-env edges stay connected. */
    sourceId?: string | null;
  };
  objects: DirectorObject[];
};
export type DirectorShotObjectSnapshot = Pick<DirectorObject,
  "id" | "kind" | "name" | "transform" | "character" | "crowd" | "primitive" | "modelAsset">;
export type DirectorShotSnapshot = {
  version: 1;
  directorNodeId: string;
  camera: DirectorCamera;
  background: string;
  environment: DirectorScene["environment"];
  objects: DirectorShotObjectSnapshot[];
  omittedObjectCount: number;
};
export type DirectorShotMetadata = {
  version: 1;
  role: "capture" | "config";
  directorNodeId: string;
  captureId: string;
  capturedAt: string;
  /** Compact immutable state captured with the PNG, not the later live scene. */
  snapshot: DirectorShotSnapshot;
};
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
  reasoningEffort?: TextReasoningEffort;
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
  /** Video reference interpretation: ordered refs or first/last frame pair. */
  videoFrameMode?: "references" | "first-last";
  transparentBackground?: boolean;
  generationType?: "text-to-image" | "image-to-image";
  referenceStorageKeys?: string[];
  /** Explicit per-node voice override. Blank means follow the project role/default. */
  voice?: string;
  /** Voice actually sent on the most recent generation, retained for audit only. */
  resolvedVoice?: string;
  /** Project-level role preset used to resolve the provider-specific voice. */
  audioRoleId?: string;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  /** audio duration seconds if known */
  audioDuration?: number;
  /** mask/upscale lineage */
  derivedFromId?: string;
  transformOperation?: "resize" | "ai-upscale" | "upscale" | "inpaint" | "mask" | "split";
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
  directorScene?: DirectorScene;
  /** Lineage from a director capture into a formal image-generation run. */
  directorShot?: DirectorShotMetadata;
  panoramaProjection?: "equirectangular";
  cameraPrompt?: CameraPromptConfig;
  workflowRunId?: string;
  workflowStepId?: string;
  workflowTemplateId?: string;
  generationJobId?: string;
  generationResultIndex?: number;
  /** Channel used for the original image request, so retries do not silently reroute. */
  generationChannelId?: string;
  /** Configuration node that started this image run, when applicable. */
  generationConfigId?: string;
  /** Stable identity for an image run; a retry gets a new job but not a new run. */
  generationRunId?: string;
  /** Latest output root of a configuration node, used for durable job recovery. */
  generationOutputRootId?: string;
  /** Stable first-party film projection identity. User-created nodes omit it. */
  filmProjectionKey?: string;
  /** Entity revision represented by this managed projection. */
  filmProjectionRevision?: number;
  filmProjectionArchived?: boolean;
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
  schemaVersion: 3;
  projectKind: "canvas" | "film";
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
  /** Reusable cast for this project; audio nodes may bind to one role. */
  audioRoles?: AudioRolePreset[];
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
  /** Local fetch/transform script for format=script. Receives (text, url, helpers); may be async. */
  script?: string;
  /** Homepage or repository URL for display only. */
  homepage?: string;
  lastFetchedAt?: string;
  /** Last successful refresh timestamp (kept when a later refresh fails). */
  lastSuccessAt?: string;
  /** Last refresh error message, cleared on success. */
  lastError?: string;
  /** Prompt count from the last successful refresh. */
  itemCount?: number;
  /** Built-in registry sources cannot be deleted. */
  builtIn?: boolean;
};

export type AiChannel = {
  id: string;
  name: string;
  /** Total provider request deadline for this personal channel. */
  timeoutSeconds?: number;
  baseUrl: string;
  apiKey: string;
  defaultTextModel: string;
  defaultImageModel: string;
  defaultVideoModel: string;
  defaultAudioModel?: string;
  providers?: AiProviders;
};

export type AiProviderKind = "text" | "image" | "video" | "audio";
export type PreferredModels = Record<string, Partial<Record<AiProviderKind, string>>>;
export type AiProtocol = "openai" | "ark" | "gemini" | "template" | "apimart" | "kie" | "azure" | "edge";
export type AudioRolePreset = {
  id: string;
  name: string;
  /** One logical role can map to a different voice on each provider. */
  voices: Partial<Record<AiProtocol, string>>;
};
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
  /** Last pulled model ids for this endpoint; used by node prompt model pickers. */
  models?: string[];
};
export type AiProviders = Record<AiProviderKind, AiEndpointConfig>;

/** Optional per-user/tenant S3-compatible object storage (AWS S3, Cloudflare R2, MinIO). */
export type ObjectStorageConfig = {
  enabled: boolean;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  allowInsecureLoopback?: boolean;
};

export type AppConfig = {
  channels: AiChannel[];
  activeChannelId: string | null;
  /** Safe identifier only; shared URLs and credentials are never persisted in personal config. */
  activeSharedChannelId?: string | null;
  systemPrompt: string;
  imageSize: string;
  imageQuality: string;
  imageCount: number;
  /** Last model selected for each channel and generation kind. */
  preferredModels?: PreferredModels;
  theme: "light" | "dark" | "system";
  webdavUrl?: string;
  webdavUser?: string;
  webdavPass?: string;
  objectStorage?: ObjectStorageConfig;
  promptSources?: PromptSourceConfig[];
  plugins?: PluginManifest[];
  disabledPluginIds?: string[];
  pluginRegistryUrl?: string;
  localAgentUrl?: string;
  canvasPanelWidth?: number;
  canvasPanelCollapsed?: boolean;
  canvasPanelTab?: "projects" | "elements" | "assets" | "prompts";
  canvasInteractionTool?: "select" | "pan";
  imageToolbar?: import("@/lib/image-toolbar-preferences").ImageToolbarPreferences;
  generationDefaults?: import("@/lib/generation-defaults").GenerationDefaults;
  /** @deprecated Legacy global roles are migrated into pre-existing projects. */
  audioRoles?: AudioRolePreset[];
  /** Workflow agent instruction. Blank falls back to the built-in default. */
  workflowAgentSystemPrompt?: string;
};

export type ClipboardPayload = {
  nodes: BoardNode[];
  edges: BoardEdge[];
};

export type GenerationKind = "image" | "video" | "audio" | "workflow" | "export";
export type GenerationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "deleted";
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
