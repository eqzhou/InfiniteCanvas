import { authFetch } from "@/services/auth-session";
import type { FilmDocument, FilmTimeline } from "@/types/film";

export class FilmAPIError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "FilmAPIError";
  }
}

export type FilmStatus = {
  document: FilmDocument;
  recordRevision: number;
  capabilities?: {
    plainTextImport?: boolean;
    markdownImport?: boolean;
    docxImport?: boolean;
    pdfImport?: boolean;
    mp4Export?: boolean;
    mp4Diagnostic?: string;
  };
};

export type FilmCapabilities = {
  available: boolean;
  reason: string;
  mp4Export: false;
  mp4Diagnostic: string;
};

function filmPath(projectId: string, suffix = ""): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId)) {
    throw new Error("Invalid film project id");
  }
  return `film/projects/${encodeURIComponent(projectId)}${suffix}`;
}

async function readFilmResponse(response: Response): Promise<FilmStatus> {
  const value = await response.json().catch(() => null) as {
    data?: unknown;
    meta?: { recordRevision?: unknown };
    capabilities?: FilmStatus["capabilities"];
    error?: { code?: unknown; message?: unknown };
  } | null;
  if (!response.ok) {
    const code = typeof value?.error?.code === "string" ? value.error.code : "film_request_failed";
    const message = typeof value?.error?.message === "string"
      ? value.error.message
      : `Film request failed: HTTP ${response.status}`;
    throw new FilmAPIError(response.status, code, message);
  }
  const document = value?.data as Partial<FilmDocument> | undefined;
  const recordRevision = value?.meta?.recordRevision;
  if (
    !document || document.schemaVersion !== 1 || typeof document.projectId !== "string" ||
    typeof document.revision !== "number" || !Array.isArray(document.episodes) ||
    !Array.isArray(document.shots) || !Array.isArray(document.assets) ||
    !document.timeline || typeof recordRevision !== "number"
  ) {
    throw new Error("Film server response is invalid");
  }
  return {
    document: document as FilmDocument,
    recordRevision,
    ...(value?.capabilities ? { capabilities: value.capabilities } : {}),
  };
}

async function requestFilm(projectId: string, suffix: string, init?: RequestInit): Promise<FilmStatus> {
  return readFilmResponse(await authFetch(filmPath(projectId, suffix), init));
}

export function loadFilmStatus(projectId: string): Promise<FilmStatus> {
  return requestFilm(projectId, "/status");
}

export async function loadFilmCapabilities(): Promise<FilmCapabilities> {
  const response = await authFetch("film/capabilities");
  const payload = await response.json().catch(() => null) as { data?: Partial<FilmCapabilities> } | null;
  if (!response.ok || typeof payload?.data?.available !== "boolean") {
    throw new Error("Film capabilities are unavailable");
  }
  return {
    available: payload.data.available,
    reason: typeof payload.data.reason === "string" ? payload.data.reason : "",
    mp4Export: false,
    mp4Diagnostic: typeof payload.data.mp4Diagnostic === "string" ? payload.data.mp4Diagnostic : "MP4 export is disabled",
  };
}

export function createFilmProduction(projectId: string): Promise<FilmStatus> {
  return requestFilm(projectId, "", { method: "POST", body: "{}" });
}

export function importFilmManuscript(
  projectId: string,
  input: { revision: number; text: string; format: "text" | "txt" | "markdown"; originalName?: string },
): Promise<FilmStatus> {
  return requestFilm(projectId, "/source/text", { method: "PUT", body: JSON.stringify(input) });
}

export function updateFilmEpisode(
  projectId: string,
  episodeId: string,
  patch: { revision: number; title?: string; synopsis?: string; order?: number },
): Promise<FilmStatus> {
  return requestFilm(projectId, `/episodes/${encodeURIComponent(episodeId)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function createFilmScene(
  projectId: string,
  input: { episodeId: string; heading: string; synopsis?: string; order?: number },
): Promise<FilmStatus> {
  return requestFilm(projectId, "/scenes", { method: "POST", body: JSON.stringify(input) });
}

export function updateFilmScene(
  projectId: string,
  sceneId: string,
  patch: { revision: number; episodeId?: string; heading?: string; synopsis?: string; order?: number },
): Promise<FilmStatus> {
  return requestFilm(projectId, `/scenes/${encodeURIComponent(sceneId)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function deleteFilmScene(projectId: string, sceneId: string, revision: number): Promise<FilmStatus> {
  return requestFilm(projectId, `/scenes/${encodeURIComponent(sceneId)}?revision=${revision}`, { method: "DELETE" });
}

export function updateFilmShot(
  projectId: string,
  shotId: string,
  patch: { revision: number; title?: string; description?: string; durationSeconds?: number; subtitle?: string },
): Promise<FilmStatus> {
  return requestFilm(projectId, `/shots/${encodeURIComponent(shotId)}`, { method: "PUT", body: JSON.stringify(patch) });
}

export function createFilmAsset(
  projectId: string,
  input: { kind: "character" | "identity" | "location" | "prop" | "style" | "voice"; title: string; description?: string },
): Promise<FilmStatus> {
  return requestFilm(projectId, "/assets", { method: "POST", body: JSON.stringify(input) });
}

export function changeFilmStage(
  projectId: string,
  stage: string,
  action: "run" | "approve" | "reject",
  revision: number,
): Promise<FilmStatus> {
  return requestFilm(projectId, `/stages/${encodeURIComponent(stage)}/${action}`, { method: "POST", body: JSON.stringify({ revision }) });
}

export function validateFilm(projectId: string): Promise<FilmStatus> {
  return requestFilm(projectId, "/validate", { method: "POST", body: "{}" });
}

export function applyFilmRepair(projectId: string, repairId: string, revision: number): Promise<FilmStatus> {
  return requestFilm(projectId, `/repairs/${encodeURIComponent(repairId)}/apply`, {
    method: "POST",
    body: JSON.stringify({ revision, approved: true }),
  });
}

export function saveFilmTimeline(projectId: string, timeline: FilmTimeline): Promise<FilmStatus> {
  return requestFilm(projectId, "/timeline", { method: "PUT", body: JSON.stringify(timeline) });
}

export function requestFilmExport(
  projectId: string,
  kind: "manifest" | "srt" | "mp4",
  revision: number,
): Promise<FilmStatus> {
  return requestFilm(projectId, "/exports", { method: "POST", body: JSON.stringify({ kind, revision }) });
}

export function restoreFilmProduction(projectId: string, document: FilmDocument, revision = 0): Promise<FilmStatus> {
  return requestFilm(projectId, "/restore", { method: "PUT", body: JSON.stringify({ revision, document }) });
}

export function filmDeliverableDownloadURL(projectId: string, deliverableId: string): string {
  return `/api/${filmPath(projectId, `/deliverables/${encodeURIComponent(deliverableId)}/download`)}`;
}
