export type FilmEntityStatus =
  | "draft"
  | "running"
  | "needs_review"
  | "approved"
  | "failed"
  | "canceled";

export type FilmAssetKind = "character" | "identity" | "location" | "prop" | "style" | "voice";
export type FilmStageKind = "decompose" | "script" | "storyboard" | "first_frame" | "audio" | "video" | "compose" | "delivery";

export type FilmStyleTemplate = {
  id: string;
  origin: "openboard-original";
  title: string;
  description: string;
  stylePrompt: string;
  aspectRatio: "16:9" | "9:16" | "2.39:1" | "1:1";
  palette: readonly string[];
  lighting: string;
  cameraLanguage: string;
};

export type FilmSource = {
  revision: number;
  text: string;
  format: "text" | "txt" | "markdown" | "docx" | "pdf";
  originalName?: string;
  importedAt: string;
  importStatus?: FilmSourceImportStatus;
};

export type FilmSourceImportStatus = {
  id?: string;
  status: "idle" | "running" | "succeeded" | "failed";
  format?: "txt" | "markdown" | "docx" | "pdf";
  originalName?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
};

export type FilmEpisode = {
  id: string;
  revision: number;
  order: number;
  title: string;
  synopsis: string;
  status: FilmEntityStatus;
};

export type FilmScene = {
  id: string;
  revision: number;
  episodeId: string;
  order: number;
  heading: string;
  synopsis: string;
  status: FilmEntityStatus;
  directorSource?: FilmDirectorSource;
};

export type FilmDirectorSource = {
  revision: number;
  targetField: "scene" | "storyboard" | "first_frame" | "last_frame";
  captureId: string;
  directorNodeId: string;
  cameraId: string;
  cameraName: string;
  width: number;
  height: number;
  storageKey: string;
  sha256: string;
  objectVersion: string;
  snapshot: unknown;
  adoptedAt: string;
};

export type FilmShot = {
  id: string;
  revision: number;
  sceneId: string;
  order: number;
  title: string;
  description: string;
  status: FilmEntityStatus;
  durationSeconds: number;
  aspectRatio: string;
  identityVersionIds: string[];
  styleAssetId?: string;
  imageStorageKey?: string;
  imageSha256?: string;
  imageObjectVersion?: string;
  imageGenerationJobId?: string;
  firstFrameStorageKey?: string;
  firstFrameSha256?: string;
  firstFrameObjectVersion?: string;
  firstFrameGenerationJobId?: string;
  lastFrameStorageKey?: string;
  lastFrameSha256?: string;
  lastFrameObjectVersion?: string;
  lastFrameGenerationJobId?: string;
  videoStorageKey?: string;
  videoSha256?: string;
  videoObjectVersion?: string;
  videoGenerationJobId?: string;
  audioStorageKey?: string;
  audioSha256?: string;
  audioObjectVersion?: string;
  audioGenerationJobId?: string;
  subtitle?: string;
  mediaMimeType?: string;
  storyboardDirectorSource?: FilmDirectorSource;
  firstFrameDirectorSource?: FilmDirectorSource;
  lastFrameDirectorSource?: FilmDirectorSource;
};

export type FilmDialogue = {
  id: string;
  revision: number;
  shotId: string;
  order: number;
  kind: "dialogue" | "narration";
  characterAssetId?: string;
  voiceAssetId?: string;
  emotion?: string;
  text: string;
  status: FilmEntityStatus;
  audioStorageKey?: string;
  audioSha256?: string;
  audioObjectVersion?: string;
  audioGenerationJobId?: string;
};

export type FilmAsset = {
  id: string;
  revision: number;
  kind: FilmAssetKind;
  title: string;
  status: FilmEntityStatus;
  parentAssetId?: string;
  description: string;
  mediaStorageKey?: string;
  mediaMimeType?: string;
  mediaSha256?: string;
  mediaObjectVersion?: string;
  voice?: string;
  stylePrompt?: string;
  aspectRatio?: string;
  ageStage?: string;
  costume?: string;
  storyPeriod?: string;
  isDefault?: boolean;
  episodeIds?: string[];
  sceneIds?: string[];
  shotIds?: string[];
};

export type FilmStage = {
  id: FilmStageKind;
  revision: number;
  status: FilmEntityStatus;
  updatedAt: string;
  error?: string;
};

export type FilmStageWaiver = {
  id: string;
  revision: number;
  stageId: FilmStageKind;
  stageRevision: number;
  reason: string;
  actorId: string;
  actorRole: "owner" | "admin";
  createdAt: string;
  projectRevision: number;
  riskAccepted: true;
  affectedDownstream: FilmStageKind[];
  revokedAt?: string;
  revokedBy?: string;
};

export type FilmTask = {
  id: string;
  revision: number;
  stage: FilmStageKind | "style_extraction";
  title: string;
  status: FilmEntityStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  generationJobId?: string;
  shotId?: string;
  dialogueId?: string;
  idempotencyKey?: string;
  requestHash?: string;
  error?: string;
  snapshot?: FilmGenerationSnapshot;
	textSnapshot?: FilmTextGenerationSnapshot;
};

export type FilmTextGenerationSnapshot = {
  sourceRevision: number;
  sourceSha256: string;
  providerId: string;
  model: string;
  capabilityVersion?: string;
  generationMode?: "text_to_image" | "image_to_image" | "text_to_video" | "image_to_video" | "text_to_audio";
  promptVersion: string;
  outputSchema: string;
  scriptMode?: "adaptive" | "literal" | "shooting";
  targetEntityId?: string;
  targetRevision?: number;
  targetSha256?: string;
  estimatedGenerations: number;
  estimatedCredits?: number;
  createdAt: string;
};

export type FilmAIDialogue = { kind: "dialogue" | "narration"; characterKey: string; emotion?: string; text: string };
export type FilmAIShot = { key: string; title: string; description: string; durationSeconds: number; dialogues: FilmAIDialogue[] };
export type FilmAIScene = { key: string; heading: string; synopsis: string; locationKey: string; shots: FilmAIShot[] };
export type FilmAIEpisode = { key: string; title: string; synopsis: string; scenes: FilmAIScene[] };
export type FilmAIDecomposition = {
	summary: string;
	theme: string;
	characters: Array<{ key: string; name: string; description: string }>;
	locations: Array<{ key: string; name: string; description: string }>;
	timeline: string[];
	relationships?: Array<{ fromCharacterKey: string; toCharacterKey: string; relation: string; description: string }>;
	beats?: Array<{ key: string; episodeKey: string; title: string; description: string }>;
	characterArcs?: Array<{ characterKey: string; summary: string }>;
	episodes: FilmAIEpisode[];
};

export type FilmStoryBible = {
  summary?: string;
  theme?: string;
  timeline?: string[];
  relationships?: Array<{ characterAssetId: string; relatedCharacterAssetId: string; relation: string; description?: string }>;
  beats?: Array<{ id: string; episodeId: string; order: number; title: string; description?: string }>;
  characterArcs?: Array<{ characterAssetId: string; summary: string }>;
};

export type FilmStructureVersion = {
  id: string;
  revision: number;
  candidateId: string;
  story: FilmStoryBible;
  episodes: FilmEpisode[];
  scenes: FilmScene[];
  shots: FilmShot[];
  dialogues: FilmDialogue[];
  assets: FilmAsset[];
  createdAt: string;
};
export type FilmAICandidate = {
	id: string;
	revision: number;
	stage: "decompose";
	status: "ready" | "stale" | "rejected" | "applied";
	sourceRevision: number;
	sourceSha256: string;
	filmRevision: number;
	taskId: string;
	generationJobId: string;
	requestHash: string;
	decomposition: FilmAIDecomposition;
	createdAt: string;
	appliedAt?: string;
};

export type FilmAIScriptDialogue = { kind: "dialogue" | "narration"; speaker: string; emotion?: string; text: string };
export type FilmAIScriptShot = { key: string; title: string; description: string; durationSeconds: number; dialogues: FilmAIScriptDialogue[] };
export type FilmAIScriptScene = { key: string; heading: string; synopsis: string; shots: FilmAIScriptShot[] };
export type FilmAIScript = { summary: string; scenes: FilmAIScriptScene[] };
export type FilmAIScriptCandidate = {
  id: string;
  revision: number;
  stage: "script";
  status: "ready" | "stale" | "rejected" | "applied";
  sourceRevision: number;
  sourceSha256: string;
  filmRevision: number;
  targetEpisodeId: string;
  targetRevision: number;
  targetSha256: string;
  taskId: string;
  generationJobId: string;
  requestHash: string;
  script: FilmAIScript;
  createdAt: string;
  appliedAt?: string;
};

export type FilmGenerationSnapshot = {
  shotRevision: number;
  prompt: string;
  providerId: string;
  model: string;
  capabilityVersion?: string;
  generationMode?: string;
  resolvedMode?: "text_to_video" | "first_frame_to_video" | "first_last_frame_to_video" | "reference_to_video";
  config: Record<string, unknown>;
  identityVersions: FilmAsset[];
  styleVersion?: FilmAsset;
  storyboardDirectorSource?: FilmDirectorSource;
  firstFrameDirectorSource?: FilmDirectorSource;
  lastFrameDirectorSource?: FilmDirectorSource;
  referenceStorageKeys: string[];
  estimatedGenerations: number;
  estimatedCredits?: number;
  createdAt: string;
};

export type FilmIssueCode =
  | "missing_shots"
  | "missing_media"
  | "identity_mismatch"
  | "style_mismatch"
  | "aspect_mismatch"
  | "missing_audio"
  | "duration_invalid"
  | "missing_subtitle"
  | "media_invalid"
  | "media_corrupt"
  | "subtitle_overflow"
  | "duration_conflict"
  | "identity_drift"
  | "style_drift";

export type FilmQualityIssue = {
  id: string;
  code: FilmIssueCode;
  severity: "warning" | "error";
  targetType: "scene" | "shot" | "asset" | "timeline";
  targetId: string;
  message: string;
};

export type FilmRepairProposal = {
  id: string;
  issueId: string;
  targetType: "scene" | "shot" | "asset" | "timeline";
  targetId: string;
  expectedRevision: number;
  patch: Record<string, string | number | boolean>;
  summary: string;
  approved: boolean;
  appliedAt?: string;
  affectedTargets?: string[];
  estimatedGenerations?: number;
  estimatedCredits?: number;
  regenerationStage?: "storyboard" | "first_frame" | "audio" | "video";
};

export type FilmEntityVersion = {
  id: string;
  entityType: "scene" | "shot" | "dialogue" | "asset" | "timeline";
  entityId: string;
  revision: number;
  snapshot: Record<string, unknown>;
  reason: string;
  createdAt: string;
};

export type FilmQualityReport = {
  id: string;
  revision: number;
  createdAt: string;
  issues: FilmQualityIssue[];
  repairs: FilmRepairProposal[];
};

export type FilmTrackKind = "video" | "dialogue" | "music" | "sfx" | "subtitle";
export type FilmTransition = "cut" | "fade";

export type FilmTimelineClip = {
  id: string;
  revision: number;
  source: string;
  order: number;
  start: number;
  end: number;
  trimIn: number;
  trimOut: number;
  volume: number;
  muted: boolean;
  fadeIn: number;
  fadeOut: number;
  transition: FilmTransition;
  text?: string;
};

export type FilmTimelineTrack = {
  id: string;
  revision: number;
  kind: FilmTrackKind;
  title: string;
  clips: FilmTimelineClip[];
};

export type FilmTimeline = {
  revision: number;
  width: number;
  height: number;
  frameRate: number;
  tracks: FilmTimelineTrack[];
};

export type FilmDeliverable = {
  id: string;
  revision: number;
  kind: "mp4" | "srt" | "manifest" | "asset_bundle";
  status: FilmEntityStatus;
  title: string;
  mimeType: string;
  storageKey?: string;
  sha256?: string;
  objectVersion?: string;
  content?: string;
  bytes?: number;
  diagnostic?: string;
  generationJobId?: string;
  createdAt: string;
};

export type FilmMediaAdoption = {
  id: string;
  revision: number;
  targetType: "shot" | "asset";
  targetId: string;
  targetField: "image" | "first_frame" | "last_frame" | "video" | "audio" | "media";
  targetRevision: number;
  sourceNodeId: string;
  storageKey: string;
  mimeType: string;
  sha256: string;
  objectVersion: string;
  generationJobId?: string;
  prompt?: string;
  providerId?: string;
  model?: string;
  splitSourceStorageKey?: string;
  splitSourceSha256?: string;
  candidateSha256?: string;
  splitCrop?: { x: number; y: number; width: number; height: number };
  adoptedAt: string;
};

export type FilmStyleBible = {
  summary: string;
  stylePrompt: string;
  negativePrompt?: string;
  palette?: string[];
  lighting?: string;
  composition?: string;
  camera?: string;
  texture?: string;
  tags?: string[];
};

export type FilmStyleExtractionCandidate = {
  id: string;
  revision: number;
  status: "needs_review" | "stale" | "rejected" | "applied";
  sourceAsset: FilmAsset;
  providerId: string;
  model: string;
  promptVersion: string;
  outputSchema: string;
  parameters: { detailLevel: "low" | "medium" | "high"; focus?: string };
  taskId: string;
  generationJobId: string;
  requestHash: string;
  bible: FilmStyleBible;
  adoptedAssetId?: string;
  createdAt: string;
  appliedAt?: string;
};

export type FilmDocument = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  aspectRatio: string;
  source: FilmSource;
  story?: FilmStoryBible;
  episodes: FilmEpisode[];
  scenes: FilmScene[];
  shots: FilmShot[];
  dialogues?: FilmDialogue[];
  assets: FilmAsset[];
  stages: FilmStage[];
  stageWaivers?: FilmStageWaiver[];
  tasks: FilmTask[];
  aiCandidates?: FilmAICandidate[];
  scriptCandidates?: FilmAIScriptCandidate[];
  styleCandidates?: FilmStyleExtractionCandidate[];
  structureVersions?: FilmStructureVersion[];
  qualityReports: FilmQualityReport[];
  timeline: FilmTimeline;
  deliverables: FilmDeliverable[];
  adoptions?: FilmMediaAdoption[];
  versions?: FilmEntityVersion[];
  projectionRevision: number;
};

export type FilmProjectionCommit = {
  projectionKey: string;
  expectedRevision: number;
  fields: { title?: string; content?: string };
};
