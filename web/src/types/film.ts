export type FilmEntityStatus =
  | "draft"
  | "running"
  | "needs_review"
  | "approved"
  | "failed"
  | "canceled";

export type FilmAssetKind = "character" | "identity" | "location" | "prop" | "style" | "voice";
export type FilmStageKind = "decompose" | "script" | "storyboard" | "first_frame" | "audio" | "video" | "compose" | "delivery";

export type FilmSource = {
  revision: number;
  text: string;
  format: "text" | "txt" | "markdown" | "docx" | "pdf";
  originalName?: string;
  importedAt: string;
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
};

export type FilmDialogue = {
  id: string;
  revision: number;
  shotId: string;
  order: number;
  kind: "dialogue" | "narration";
  characterAssetId?: string;
  voiceAssetId?: string;
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
};

export type FilmStage = {
  id: FilmStageKind;
  revision: number;
  status: FilmEntityStatus;
  updatedAt: string;
  error?: string;
};

export type FilmTask = {
  id: string;
  revision: number;
  stage: FilmStageKind;
  title: string;
  status: FilmEntityStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  generationJobId?: string;
  shotId?: string;
  idempotencyKey?: string;
  requestHash?: string;
  error?: string;
  snapshot?: FilmGenerationSnapshot;
};

export type FilmGenerationSnapshot = {
  shotRevision: number;
  prompt: string;
  providerId: string;
  model: string;
  config: Record<string, unknown>;
  identityVersions: FilmAsset[];
  styleVersion?: FilmAsset;
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
};

export type FilmEntityVersion = {
  id: string;
  entityType: "shot" | "asset" | "timeline";
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
  targetField: "image" | "first_frame" | "video" | "audio" | "media";
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
  adoptedAt: string;
};

export type FilmDocument = {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  aspectRatio: string;
  source: FilmSource;
  episodes: FilmEpisode[];
  scenes: FilmScene[];
  shots: FilmShot[];
  dialogues?: FilmDialogue[];
  assets: FilmAsset[];
  stages: FilmStage[];
  tasks: FilmTask[];
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
