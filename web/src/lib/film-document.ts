import { createNode } from "@/lib/defaults";
import type { BoardNode, BoardProject } from "@/types/board";
import type {
  FilmDocument,
  FilmAsset,
  FilmEpisode,
  FilmProjectionCommit,
  FilmQualityIssue,
  FilmQualityReport,
  FilmRepairProposal,
  FilmScene,
  FilmShot,
  FilmStage,
  FilmTimeline,
} from "@/types/film";

const STAGE_IDS: FilmStage["id"][] = [
  "decompose", "script", "storyboard", "first_frame", "audio", "video", "compose", "delivery",
];
const SCENE_HEADING = /^(?:(?:INT|EXT|INT\/EXT|EXT\/INT)\.?\s|(?:内景|外景|内外景)[：:\s]|场景\s*\d+)/i;
const EPISODE_HEADING = /^(?:EPISODE\s+\d+|第\s*[一二三四五六七八九十百0-9]+\s*集)\b/i;

export type FilmDecompositionLimits = {
  episodes: number;
  scenes: number;
  shots: number;
  entities: number;
};

const DEFAULT_DECOMPOSITION_LIMITS: FilmDecompositionLimits = {
  episodes: 10_000,
  scenes: 10_000,
  shots: 10_000,
  entities: 10_000,
};

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}_${stableHash(parts.join("\u001f"))}`;
}

export function defaultFilmTimeline(): FilmTimeline {
  const kinds = ["video", "dialogue", "music", "sfx", "subtitle"] as const;
  return {
    revision: 1,
    width: 1920,
    height: 1080,
    frameRate: 24,
    tracks: kinds.map((kind, index) => ({
      id: `track_${kind}`,
      revision: 1,
      kind,
      title: ["Picture", "Dialogue", "Music", "Sound effects", "Subtitles"][index]!,
      clips: [],
    })),
  };
}

export function createFilmDocument(projectId: string, timestamp = new Date().toISOString()): FilmDocument {
  return {
    schemaVersion: 1,
    projectId,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    aspectRatio: "16:9",
    source: { revision: 0, text: "", format: "text", importedAt: timestamp },
    episodes: [],
    scenes: [],
    shots: [],
    dialogues: [],
    assets: [],
    stages: STAGE_IDS.map((id) => ({ id, revision: 1, status: "draft", updatedAt: timestamp })),
    tasks: [],
    qualityReports: [],
    timeline: defaultFilmTimeline(),
    deliverables: [],
    projectionRevision: 0,
  };
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
}

function shotSentences(body: string): string[] {
  const sentences = body
    .split(/(?<=[.!?。！？])\s+|\n+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  return sentences.length ? sentences.slice(0, 24) : ["Establish the scene and principal action."];
}

export function decomposeFilmSource(
  document: FilmDocument,
  text: string,
  limits: FilmDecompositionLimits = DEFAULT_DECOMPOSITION_LIMITS,
): FilmDocument {
  const normalizedText = text.replace(/\r\n?/g, "\n").trim();
  const lines = normalizeLines(normalizedText);
  const timestamp = document.updatedAt;
  const episodeBlocks: Array<{ title: string; lines: string[] }> = [];
  const appendEpisode = (episode: { title: string; lines: string[] }) => {
    if (episodeBlocks.length >= limits.episodes) throw new Error("Film decomposition episode limit reached");
    episodeBlocks.push(episode);
  };
  let currentEpisode = { title: "Episode 1", lines: [] as string[] };
  for (const line of lines) {
    if (EPISODE_HEADING.test(line)) {
      if (currentEpisode.lines.some(Boolean) || episodeBlocks.length > 0) appendEpisode(currentEpisode);
      currentEpisode = { title: line, lines: [] };
    } else {
      currentEpisode = { ...currentEpisode, lines: [...currentEpisode.lines, line] };
    }
  }
  if (currentEpisode.lines.some(Boolean) || episodeBlocks.length === 0) appendEpisode(currentEpisode);

  const episodes: FilmEpisode[] = [];
  const scenes: FilmScene[] = [];
  const shots: FilmShot[] = [];
  const dialogues: NonNullable<FilmDocument["dialogues"]> = [];
  let parsedSceneCount = 0;
  for (const [episodeIndex, block] of episodeBlocks.entries()) {
    if (episodes.length >= limits.episodes || episodes.length + scenes.length + shots.length >= limits.entities) {
      throw new Error("Film decomposition episode limit reached");
    }
    const episodeId = stableId("episode", document.projectId, episodeIndex, block.title);
    const sceneBlocks: Array<{ heading: string; body: string[] }> = [];
    const appendScene = (scene: { heading: string; body: string[] }) => {
      if (parsedSceneCount >= limits.scenes) throw new Error("Film decomposition scene limit reached");
      sceneBlocks.push(scene);
      parsedSceneCount += 1;
    };
    let currentScene = { heading: "SCENE 1", body: [] as string[] };
    for (const line of block.lines) {
      if (SCENE_HEADING.test(line)) {
        if (currentScene.body.some(Boolean) || sceneBlocks.length > 0) appendScene(currentScene);
        currentScene = { heading: line, body: [] };
      } else if (line) {
        currentScene = { ...currentScene, body: [...currentScene.body, line] };
      }
    }
    if (currentScene.body.some(Boolean) || sceneBlocks.length === 0) appendScene(currentScene);
    const synopsis = sceneBlocks.flatMap((scene) => scene.body).join(" ").slice(0, 600);
    episodes.push({
      id: episodeId,
      revision: 1,
      order: episodeIndex,
      title: block.title,
      synopsis,
      status: "draft",
    });
    for (const [sceneIndex, sceneBlock] of sceneBlocks.entries()) {
      if (scenes.length >= limits.scenes || episodes.length + scenes.length + shots.length >= limits.entities) {
        throw new Error("Film decomposition scene limit reached");
      }
      const sceneId = stableId("scene", episodeId, sceneIndex, sceneBlock.heading);
      const body = sceneBlock.body.join(" ").trim();
      scenes.push({
        id: sceneId,
        revision: 1,
        episodeId,
        order: sceneIndex,
        heading: sceneBlock.heading,
        synopsis: body.slice(0, 1_000),
        status: "draft",
      });
      for (const [shotIndex, sentence] of shotSentences(body).entries()) {
        if (shots.length >= limits.shots || episodes.length + scenes.length + shots.length >= limits.entities) {
          throw new Error("Film decomposition shot limit reached");
        }
        const shotId = stableId("shot", sceneId, shotIndex, sentence);
        shots.push({
          id: shotId,
          revision: 1,
          sceneId,
          order: shotIndex,
          title: `Shot ${shotIndex + 1}`,
          description: sentence,
          status: "draft",
          durationSeconds: 4,
          aspectRatio: document.aspectRatio,
          identityVersionIds: [],
        });
        dialogues.push({ id: stableId("dialogue", shotId, 0), revision: 1, shotId, order: 0, kind: "narration", text: sentence, status: "draft" });
      }
    }
  }

  return {
    ...document,
    revision: document.revision + 1,
    updatedAt: timestamp,
    source: {
      ...document.source,
      revision: document.source.revision + 1,
      text: normalizedText,
      importedAt: timestamp,
    },
    episodes,
    scenes,
    shots,
    dialogues,
    qualityReports: [],
    projectionRevision: document.projectionRevision + 1,
    stages: document.stages.map((stage) => stage.id === "decompose"
      ? { ...stage, revision: stage.revision + 1, status: "needs_review", updatedAt: timestamp }
      : stage),
  };
}

function issue(
  code: FilmQualityIssue["code"],
  targetType: FilmQualityIssue["targetType"],
  targetId: string,
  message: string,
  severity: FilmQualityIssue["severity"] = "warning",
): FilmQualityIssue {
  return { id: stableId("issue", code, targetType, targetId), code, severity, targetType, targetId, message };
}

function repairForShot(qualityIssue: FilmQualityIssue, shot: FilmShot): FilmRepairProposal | null {
  let patch: FilmRepairProposal["patch"] | null = null;
  let summary = "";
  if (qualityIssue.code === "missing_subtitle") {
    patch = { subtitle: shot.description };
    summary = "Use the approved shot description as a subtitle draft.";
  } else if (qualityIssue.code === "duration_invalid") {
    patch = { durationSeconds: 4 };
    summary = "Reset shot duration to four seconds.";
  } else if (qualityIssue.code === "aspect_mismatch") {
    patch = { aspectRatio: "16:9" };
    summary = "Align this shot with the project delivery aspect.";
  } else if (qualityIssue.code === "media_invalid") {
    patch = { status: "draft" };
    summary = "Return the shot to draft so invalid media can be regenerated.";
  } else if (qualityIssue.code === "missing_media") {
    patch = { description: `${shot.description}\nMedia pending.` };
    summary = "Mark the draft description for a new media generation pass.";
  } else if (qualityIssue.code === "missing_audio") {
    patch = { status: "draft" };
    summary = "Return the shot to draft for dialogue or ambience generation.";
  }
  if (!patch) return null;
  return {
    id: stableId("repair", qualityIssue.id),
    issueId: qualityIssue.id,
    targetType: "shot",
    targetId: shot.id,
    expectedRevision: shot.revision,
    patch,
    summary,
    approved: false,
  };
}

export function validateFilmDocument(document: FilmDocument): FilmQualityReport {
  const issues: FilmQualityIssue[] = [];
  const identityIDs = new Set(document.assets.filter((asset) => asset.kind === "identity").map((asset) => asset.id));
  const styleIDs = new Set(document.assets.filter((asset) => asset.kind === "style").map((asset) => asset.id));
  for (const scene of document.scenes) {
    if (!document.shots.some((shot) => shot.sceneId === scene.id)) {
      issues.push(issue("missing_shots", "scene", scene.id, "Scene has no planned shots.", "error"));
    }
  }
  for (const shot of document.shots) {
    if (!shot.imageStorageKey && !shot.videoStorageKey) {
      issues.push(issue("missing_media", "shot", shot.id, "Shot has no image or video media.", "error"));
    }
    if (shot.identityVersionIds.some((id) => !identityIDs.has(id))) {
      issues.push(issue("identity_mismatch", "shot", shot.id, "Shot references an unavailable identity version."));
    }
    if (shot.styleAssetId && !styleIDs.has(shot.styleAssetId)) {
      issues.push(issue("style_mismatch", "shot", shot.id, "Shot references an unavailable style asset."));
    }
    if (shot.aspectRatio !== document.aspectRatio) {
      issues.push(issue("aspect_mismatch", "shot", shot.id, "Shot aspect does not match the project delivery aspect."));
    }
    if (!shot.audioStorageKey) issues.push(issue("missing_audio", "shot", shot.id, "Shot has no dialogue or audio media."));
    if (!Number.isFinite(shot.durationSeconds) || shot.durationSeconds <= 0 || shot.durationSeconds > 900) {
      issues.push(issue("duration_invalid", "shot", shot.id, "Shot duration is outside production limits.", "error"));
    }
    if (!shot.subtitle?.trim()) issues.push(issue("missing_subtitle", "shot", shot.id, "Shot has no subtitle draft."));
    if (shot.mediaMimeType && !/^(image|video|audio)\/(?:[a-z0-9.+-]+)$/i.test(shot.mediaMimeType)) {
      issues.push(issue("media_invalid", "shot", shot.id, "Shot media type is invalid.", "error"));
    }
  }
  const repairs = issues.flatMap((qualityIssue) => {
    if (qualityIssue.targetType !== "shot") return [];
    const shot = document.shots.find((candidate) => candidate.id === qualityIssue.targetId);
    const repair = shot ? repairForShot(qualityIssue, shot) : null;
    return repair ? [repair] : [];
  });
  return {
    id: stableId("quality", document.projectId, document.revision),
    revision: 1,
    createdAt: document.updatedAt,
    issues,
    repairs,
  };
}

const SHOT_REPAIR_FIELDS = new Set(["title", "description", "durationSeconds", "aspectRatio", "subtitle", "status"]);

export function applyApprovedFilmRepair(document: FilmDocument, repairId: string): FilmDocument {
  const repair = document.qualityReports.flatMap((report) => report.repairs)
    .find((candidate) => candidate.id === repairId);
  if (!repair) throw new Error("repair not found");
  if (!repair.approved) throw new Error("repair is not user approved");
  if (repair.targetType !== "shot") throw new Error("repair target is unsupported");
  const shot = document.shots.find((candidate) => candidate.id === repair.targetId);
  if (!shot) throw new Error("repair target not found");
  if (shot.revision !== repair.expectedRevision) throw new Error("repair revision conflict");
  const patch = Object.fromEntries(Object.entries(repair.patch).filter(([key]) => SHOT_REPAIR_FIELDS.has(key)));
  const timestamp = document.updatedAt;
  return {
    ...document,
    revision: document.revision + 1,
    shots: document.shots.map((candidate) => candidate.id === shot.id
      ? { ...candidate, ...patch, revision: candidate.revision + 1 } as FilmShot
      : candidate),
    qualityReports: document.qualityReports.map((report) => ({
      ...report,
      repairs: report.repairs.map((candidate) => candidate.id === repair.id
        ? { ...candidate, appliedAt: timestamp }
        : candidate),
    })),
  };
}

type ProjectionTarget = {
  key: string;
  revision: number;
  type: BoardNode["type"];
  title: string;
  content: string;
  order: number;
};

export type FilmProjectionDiff = {
  projectionKey: string;
  expectedRevision: number;
  before: { title: string; content: string };
  after: { title: string; content: string };
};

export type FilmSceneDirectorNodeResult = {
  project: BoardProject;
  nodeId: string;
  created: boolean;
};

export function ensureFilmSceneDirectorNode(project: BoardProject, scene: FilmScene): FilmSceneDirectorNodeResult {
  const projectionKey = `director:${scene.id}`;
  const existing = project.nodes.find((node) => node.metadata.filmProjectionKey === projectionKey);
  if (existing) {
    const defaults = createNode("director", existing.position);
    return {
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.id === existing.id ? {
          ...node,
          type: "director",
          metadata: {
            ...defaults.metadata,
            ...node.metadata,
            filmProjectionKey: projectionKey,
            filmProjectionRevision: scene.revision,
            filmProjectionArchived: false,
          },
        } : node),
      },
      nodeId: existing.id,
      created: false,
    };
  }
  const sceneNode = project.nodes.find((node) => node.metadata.filmProjectionKey === `scene:${scene.id}`);
  const fallbackX = project.nodes.reduce((maximum, node) => Math.max(maximum, node.position.x + node.width), 0) + 80;
  const position = sceneNode
    ? { x: sceneNode.position.x + sceneNode.width + 80, y: sceneNode.position.y }
    : { x: fallbackX, y: 0 };
  const node = createNode("director", position, {
    id: stableId("filmnode", project.id, projectionKey),
    title: `Director · ${scene.heading}`,
    metadata: {
      filmProjectionKey: projectionKey,
      filmProjectionRevision: scene.revision,
      filmProjectionArchived: false,
    },
  });
  return { project: { ...project, nodes: [...project.nodes, node] }, nodeId: node.id, created: true };
}

function projectionTargets(document: FilmDocument): ProjectionTarget[] {
  return [
    ...document.episodes.map((episode) => ({
      key: `episode:${episode.id}`, revision: episode.revision, type: "text" as const,
      title: episode.title, content: episode.synopsis, order: episode.order * 1000,
    })),
    ...document.scenes.map((scene) => ({
      key: `scene:${scene.id}`, revision: scene.revision, type: "text" as const,
      title: scene.heading, content: scene.synopsis, order: 10_000 + scene.order,
    })),
    ...document.shots.map((shot) => ({
      key: `shot:${shot.id}`, revision: shot.revision, type: "text" as const,
      title: shot.title, content: shot.description, order: 20_000 + shot.order,
    })),
    ...document.assets.map((asset, index) => ({
      key: `asset:${asset.id}`, revision: asset.revision, type: "text" as const,
      title: asset.title, content: asset.description, order: 30_000 + index,
    })),
  ];
}

export function refreshFilmProjection(project: BoardProject, document: FilmDocument): BoardProject {
  const targets = projectionTargets(document);
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const existingByKey = new Map(project.nodes.flatMap((node) =>
    node.metadata.filmProjectionKey ? [[node.metadata.filmProjectionKey, node] as const] : []));
  const refreshed = project.nodes.map((node) => {
    const key = node.metadata.filmProjectionKey;
    if (!key) return node;
    const target = targetByKey.get(key);
    if (!target) {
      return {
        ...node,
        title: node.metadata.filmProjectionArchived ? node.title : `Archived · ${node.title}`,
        metadata: { ...node.metadata, filmProjectionArchived: true },
      };
    }
    return {
      ...node,
      title: target.title,
      type: target.type,
      metadata: {
        ...node.metadata,
        content: target.content,
        filmProjectionRevision: target.revision,
        filmProjectionArchived: false,
      },
    };
  });
  const additions = targets.flatMap((target, index) => {
    if (existingByKey.has(target.key)) return [];
    return [createNode(target.type, { x: (index % 4) * 360, y: Math.floor(index / 4) * 240 }, {
      id: stableId("filmnode", project.id, target.key),
      title: target.title,
      metadata: {
        content: target.content,
        filmProjectionKey: target.key,
        filmProjectionRevision: target.revision,
        filmProjectionArchived: false,
      },
    })];
  });
  return { ...project, nodes: [...refreshed, ...additions] };
}

export function buildFilmProjectionDiffs(project: BoardProject, document: FilmDocument): FilmProjectionDiff[] {
  const targets = new Map(projectionTargets(document).map((target) => [target.key, target]));
  return project.nodes.flatMap((node) => {
    const key = node.metadata.filmProjectionKey;
    const revision = node.metadata.filmProjectionRevision;
    if (!key || node.metadata.filmProjectionArchived || !Number.isSafeInteger(revision)) return [];
    const target = targets.get(key);
    if (!target || target.revision !== revision) return [];
    const after = { title: node.title, content: typeof node.metadata.content === "string" ? node.metadata.content : "" };
    const before = { title: target.title, content: target.content };
    return before.title === after.title && before.content === after.content
      ? []
      : [{ projectionKey: key, expectedRevision: revision!, before, after }];
  });
}

export function commitFilmProjection(document: FilmDocument, commit: FilmProjectionCommit): FilmDocument {
  const [kind, id] = commit.projectionKey.split(":", 2);
  if (!id || !["episode", "scene", "shot", "asset"].includes(kind)) throw new Error("invalid projection key");
  const content = commit.fields.content;
  const title = commit.fields.title;
  if (title !== undefined && title.length > 500) throw new Error("projection title is too long");
  if (content !== undefined && content.length > 100_000) throw new Error("projection content is too long");
  const update = <T extends FilmEpisode | FilmScene | FilmShot | FilmAsset>(items: T[]): T[] => {
    const target = items.find((item) => item.id === id);
    if (!target) throw new Error("projection target not found");
    if (target.revision !== commit.expectedRevision) throw new Error("projection revision conflict");
    return items.map((item) => {
      if (item.id !== id) return item;
      if (kind === "episode") return {
        ...item, ...(title === undefined ? {} : { title }), ...(content === undefined ? {} : { synopsis: content }),
        revision: item.revision + 1,
      } as T;
      if (kind === "scene") return {
        ...item, ...(title === undefined ? {} : { heading: title }), ...(content === undefined ? {} : { synopsis: content }),
        revision: item.revision + 1,
      } as T;
      if (kind === "asset") return {
        ...item, ...(title === undefined ? {} : { title }), ...(content === undefined ? {} : { description: content }),
        revision: item.revision + 1,
      } as T;
      return {
        ...item, ...(title === undefined ? {} : { title }), ...(content === undefined ? {} : { description: content }),
        revision: item.revision + 1,
      } as T;
    });
  };
  return {
    ...document,
    revision: document.revision + 1,
    episodes: kind === "episode" ? update(document.episodes) : document.episodes,
    scenes: kind === "scene" ? update(document.scenes) : document.scenes,
    shots: kind === "shot" ? update(document.shots) : document.shots,
    assets: kind === "asset" ? update(document.assets) : document.assets,
  };
}
