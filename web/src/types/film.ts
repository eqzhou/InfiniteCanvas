export type FilmEntityStatus =
  | "draft"
  | "running"
  | "needs_review"
  | "approved"
  | "failed"
  | "canceled";

export type FilmAssetKind = "character" | "identity" | "location" | "prop" | "style" | "voice";
export type FilmStageKind = "decompose" | "script" | "storyboard" | "audio" | "video" | "compose" | "delivery";

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
  videoStorageKey?: string;
  audioStorageKey?: string;
  subtitle?: string;
  mediaMimeType?: string;
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
  voice?: string;
  stylePrompt?: string;
  aspectRatio?: string;
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
  error?: string;
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
  | "media_invalid";

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
  content?: string;
  bytes?: number;
  diagnostic?: string;
  createdAt: string;
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
  assets: FilmAsset[];
  stages: FilmStage[];
  tasks: FilmTask[];
  qualityReports: FilmQualityReport[];
  timeline: FilmTimeline;
  deliverables: FilmDeliverable[];
  projectionRevision: number;
};

export type FilmProjectionCommit = {
  projectionKey: string;
  expectedRevision: number;
  fields: { title?: string; content?: string };
};
