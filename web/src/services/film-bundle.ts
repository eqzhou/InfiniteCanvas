import type { BoardProject } from "@/types/board";
import {
  exportProjectBundle,
  importProjectBundlePayload,
  type ImportedProjectBundle,
  type ImportedBundleMedia,
} from "@/lib/project-bundle";
import { FilmAPIError, loadFilmStatus, type FilmRestoreMedia, type FilmRestoreMediaProvenance } from "@/services/film-client";
import { adoptCommittedProject, adoptCommittedWorkspace, useBoardStore } from "@/stores/use-board-store";
import {
  exportWorkspaceBundle,
  importWorkspaceBundle,
  type WorkspaceBundleStorage,
  type ImportedWorkspaceMedia,
  type WorkspaceImportContext,
  type WorkspaceSnapshot,
} from "@/lib/workspace-bundle";
import type { AppConfig } from "@/types/board";
import type { FilmDocument } from "@/types/film";
import { collectGenerationStorageKeysFromJobs, listAllGenerationJobs } from "@/services/generation-jobs";
import { loadPersonalWorkflowTemplates } from "@/services/workflow-templates";
import { nowIso, uid } from "@/lib/id";
import {
  importProjectAtomically,
  replaceCompleteWorkspace,
  type CompleteWorkspaceTransactionInput,
  type ProjectImportTransactionInput,
  type ProjectImportTransactionResult,
  type WorkspaceRestoreReceipt,
} from "@/services/workspace-transactions";

export function prepareFilmRestore(
  document: FilmDocument,
  imported: readonly (ImportedBundleMedia | ImportedWorkspaceMedia)[],
): { document: FilmDocument; media: FilmRestoreMedia[] } {
  const byKey = new Map(imported.map((item) => [item.storageKey, item]));
  const provenance = new Map<string, FilmRestoreMediaProvenance[]>();
  const add = (storageKey: string | undefined, value: FilmRestoreMediaProvenance) => {
    if (!storageKey || !byKey.has(storageKey)) return;
    provenance.set(storageKey, [...(provenance.get(storageKey) ?? []), value]);
  };
  for (const shot of document.shots) {
    add(shot.imageStorageKey, { kind: "shot", entityId: shot.id, field: "imageStorageKey" });
    add(shot.firstFrameStorageKey, { kind: "shot", entityId: shot.id, field: "firstFrameStorageKey" });
    add(shot.audioStorageKey, { kind: "shot", entityId: shot.id, field: "audioStorageKey" });
    add(shot.videoStorageKey, { kind: "shot", entityId: shot.id, field: "videoStorageKey" });
  }
  for (const asset of document.assets) add(asset.mediaStorageKey, { kind: "asset", entityId: asset.id, field: "mediaStorageKey" });
  for (const dialogue of document.dialogues ?? []) add(dialogue.audioStorageKey, { kind: "dialogue", entityId: dialogue.id, field: "audioStorageKey" });
  for (const task of document.tasks) {
    for (const asset of task.snapshot?.identityVersions ?? []) add(asset.mediaStorageKey, { kind: "task", entityId: task.id, field: `identity:${asset.id}` });
    add(task.snapshot?.styleVersion?.mediaStorageKey, { kind: "task", entityId: task.id, field: "style" });
    for (const [index, key] of (task.snapshot?.referenceStorageKeys ?? []).entries()) add(key, { kind: "task", entityId: task.id, field: `reference:${index}` });
  }
  for (const track of document.timeline.tracks) {
    for (const clip of track.clips) add(clip.source, { kind: "timeline", entityId: clip.id, field: "source" });
  }
  for (const deliverable of document.deliverables) add(deliverable.storageKey, { kind: "deliverable", entityId: deliverable.id, field: "storageKey" });
  const versionMediaFields = ["imageStorageKey", "firstFrameStorageKey", "audioStorageKey", "videoStorageKey"] as const;
  for (const version of document.versions ?? []) {
    if (version.entityType !== "shot") continue;
    for (const field of versionMediaFields) {
      const key = version.snapshot[field];
      if (typeof key === "string") add(key, { kind: "version", entityId: version.id, field });
    }
  }
  const identity = (key?: string) => key ? byKey.get(key) : undefined;
  const restoreAssetIdentity = (asset: FilmDocument["assets"][number]) => {
    const item = identity(asset.mediaStorageKey);
    return item ? { ...asset, mediaMimeType: item.mimeType, mediaSha256: item.sha256, mediaObjectVersion: item.objectVersion } : { ...asset };
  };
  const restoredDocument: FilmDocument = {
    ...document,
    shots: document.shots.map((shot) => {
      const image = identity(shot.imageStorageKey), firstFrame = identity(shot.firstFrameStorageKey), video = identity(shot.videoStorageKey), audio = identity(shot.audioStorageKey);
      return { ...shot,
        ...(image ? { imageSha256: image.sha256, imageObjectVersion: image.objectVersion, mediaMimeType: image.mimeType } : {}),
        ...(firstFrame ? { firstFrameSha256: firstFrame.sha256, firstFrameObjectVersion: firstFrame.objectVersion, mediaMimeType: firstFrame.mimeType } : {}),
        ...(video ? { videoSha256: video.sha256, videoObjectVersion: video.objectVersion, mediaMimeType: video.mimeType } : {}),
        ...(audio ? { audioSha256: audio.sha256, audioObjectVersion: audio.objectVersion, mediaMimeType: audio.mimeType } : {}),
      };
    }),
    dialogues: document.dialogues?.map((dialogue) => {
      const item = identity(dialogue.audioStorageKey);
      return item ? { ...dialogue, audioSha256: item.sha256, audioObjectVersion: item.objectVersion } : { ...dialogue };
    }),
    assets: document.assets.map(restoreAssetIdentity),
    tasks: document.tasks.map((task) => !task.snapshot ? task : ({
      ...task,
      snapshot: {
        ...task.snapshot,
        identityVersions: task.snapshot.identityVersions.map(restoreAssetIdentity),
        styleVersion: task.snapshot.styleVersion ? restoreAssetIdentity(task.snapshot.styleVersion) : undefined,
      },
    })),
    deliverables: document.deliverables.map((deliverable) => { const item = identity(deliverable.storageKey); return item ? { ...deliverable, mimeType: item.mimeType, bytes: item.bytes, sha256: item.sha256, objectVersion: item.objectVersion } : { ...deliverable }; }),
    versions: document.versions?.map((version) => {
      if (version.entityType !== "shot") return version;
      const snapshot = { ...version.snapshot };
      const identities = [
        ["imageStorageKey", "imageSha256", "imageObjectVersion"],
        ["firstFrameStorageKey", "firstFrameSha256", "firstFrameObjectVersion"],
        ["audioStorageKey", "audioSha256", "audioObjectVersion"],
        ["videoStorageKey", "videoSha256", "videoObjectVersion"],
      ] as const;
      for (const [keyField, digestField, versionField] of identities) {
        const key = snapshot[keyField];
        const item = typeof key === "string" ? identity(key) : undefined;
        if (item) {
          snapshot[digestField] = item.sha256;
          snapshot[versionField] = item.objectVersion;
          snapshot.mediaMimeType = item.mimeType;
        }
      }
      return { ...version, snapshot };
    }),
  };
  const media = imported.flatMap((item): FilmRestoreMedia[] => {
    const references = provenance.get(item.storageKey);
    return references?.length ? [{ ...item, provenance: references }] : [];
  });
  return { document: restoredDocument, media };
}

function collectProjectStorageKeys(project: BoardProject, keys: Set<string>): void {
  for (const node of project.nodes) {
    if (node.metadata.storageKey) keys.add(node.metadata.storageKey);
    for (const key of node.metadata.referenceStorageKeys ?? []) keys.add(key);
  }
  for (const session of project.chatSessions) {
    for (const message of session.messages) {
      for (const image of message.images ?? []) if (image.storageKey) keys.add(image.storageKey);
      for (const reference of message.references ?? []) if (reference.storageKey) keys.add(reference.storageKey);
    }
  }
}

export function collectNonFilmStorageKeys(snapshot: Omit<WorkspaceSnapshot, "films">): Set<string> {
  const keys = new Set<string>();
  for (const project of snapshot.projects) collectProjectStorageKeys(project, keys);
  for (const asset of snapshot.assets) if (asset.storageKey) keys.add(asset.storageKey);
  for (const key of collectGenerationStorageKeysFromJobs(snapshot.generationJobs)) keys.add(key);
  return keys;
}

function unreferencedMigratedKeys(keys: readonly string[], retained: ReadonlySet<string>): string[] {
  return [...new Set(keys)].filter((key) => !retained.has(key));
}

export async function exportCompleteProjectBundle(project: BoardProject): Promise<Blob> {
  const film = project.projectKind === "film"
    ? (await loadFilmStatus(project.id)).document
    : undefined;
  return exportProjectBundle(project, undefined, film);
}

export type FilmBundleImportDependencies = {
  readBundle: (source: Blob | ArrayBuffer | Uint8Array) => Promise<ImportedProjectBundle>;
  prepareProject: (project: BoardProject) => BoardProject;
  commitImport: (input: ProjectImportTransactionInput) => Promise<ProjectImportTransactionResult>;
  adoptProject: (project: BoardProject) => void;
  retainedStorageKeys: (project: BoardProject) => Promise<ReadonlySet<string>>;
};

function prepareImportedProject(project: BoardProject): BoardProject {
  const timestamp = nowIso();
  return { ...structuredClone(project), id: uid("proj"), title: `${project.title} (导入)`, createdAt: timestamp, updatedAt: timestamp };
}

function defaultImportDependencies(): FilmBundleImportDependencies {
  return {
    readBundle: importProjectBundlePayload,
    prepareProject: prepareImportedProject,
    commitImport: importProjectAtomically,
    adoptProject: adoptCommittedProject,
    retainedStorageKeys: async (project) => {
      const state = useBoardStore.getState();
      return collectNonFilmStorageKeys({
        projects: [project, ...state.projects],
        assets: state.assets,
        prompts: state.prompts,
        config: state.config,
        generationJobs: await listAllGenerationJobs(),
        workflowTemplates: await loadPersonalWorkflowTemplates(),
      });
    },
  };
}

export async function importCompleteProjectBundleWithDependencies(
  source: Blob | ArrayBuffer | Uint8Array,
  dependencies: FilmBundleImportDependencies,
): Promise<string> {
  const payload = await dependencies.readBundle(source);
  const project = dependencies.prepareProject(payload.project);
  let result: ProjectImportTransactionResult;
  try {
    const film = payload.film
      ? prepareFilmRestore({
        ...payload.film,
        projectId: project.id,
      }, payload.media)
      : undefined;
    result = await dependencies.commitImport({
      project,
      ...(film ? { film: { revision: 0, ...film } } : {}),
    });
  } catch (error) {
    await payload.cleanup();
    throw error;
  }
  dependencies.adoptProject(result.project);
  try {
    const retained = await dependencies.retainedStorageKeys(result.project);
    await payload.cleanupMigrated(unreferencedMigratedKeys(result.migratedStorageKeys, retained));
  } catch {
    // The transaction is committed. Retaining redundant source objects is safer
    // than letting import cleanup delete media now referenced by committed state.
  }
  return result.project.id;
}

export async function importCompleteProjectBundle(source: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  return importCompleteProjectBundleWithDependencies(source, defaultImportDependencies());
}

export async function exportCompleteWorkspaceBundle(
  snapshot: Omit<WorkspaceSnapshot, "films">,
  storage?: WorkspaceBundleStorage,
): Promise<Blob> {
  const filmProjects = snapshot.projects.filter((project) => project.projectKind === "film");
  const films = await Promise.all(filmProjects.map(async (project) => (await loadFilmStatus(project.id)).document));
  return exportWorkspaceBundle({ ...snapshot, films }, storage);
}

export async function importCompleteWorkspaceBundle(
  source: Blob | ArrayBuffer | Uint8Array,
  localConfig: AppConfig,
  storage?: WorkspaceBundleStorage,
): Promise<WorkspaceSnapshot> {
  return importCompleteWorkspaceBundleWithDependencies(source, localConfig, storage, {
    importWorkspace: importWorkspaceBundle,
    loadFilm: loadFilmStatus,
    commitWorkspace: replaceCompleteWorkspace,
    adoptWorkspace: adoptCommittedWorkspace,
  });
}

export type CompleteWorkspaceBundleDependencies = {
  importWorkspace: (
    source: Blob | ArrayBuffer | Uint8Array,
    localConfig: AppConfig,
    storage: WorkspaceBundleStorage | undefined,
    apply?: (snapshot: WorkspaceSnapshot, context: WorkspaceImportContext) => Promise<WorkspaceSnapshot | void>,
  ) => Promise<WorkspaceSnapshot>;
  loadFilm: typeof loadFilmStatus;
  commitWorkspace: (input: CompleteWorkspaceTransactionInput) => Promise<WorkspaceRestoreReceipt>;
  adoptWorkspace: (snapshot: WorkspaceSnapshot) => void;
};

async function currentFilmRevision(projectId: string, load: typeof loadFilmStatus): Promise<number> {
  try { return (await load(projectId)).recordRevision; }
  catch (cause) {
    if (cause instanceof FilmAPIError && cause.status === 404) return 0;
    throw cause;
  }
}

export async function importCompleteWorkspaceBundleWithDependencies(
  source: Blob | ArrayBuffer | Uint8Array,
  localConfig: AppConfig,
  storage: WorkspaceBundleStorage | undefined,
  dependencies: CompleteWorkspaceBundleDependencies,
): Promise<WorkspaceSnapshot> {
  return dependencies.importWorkspace(source, localConfig, storage, async (snapshot, context) => {
    const { films: bundledFilms = [], ...workspace } = snapshot;
    const films = await Promise.all(bundledFilms.map(async (film) => ({
      revision: await currentFilmRevision(film.projectId, dependencies.loadFilm),
      ...prepareFilmRestore(film, context.media),
    })));
    const receipt = await dependencies.commitWorkspace({ snapshot: workspace, films });
    const committed: WorkspaceSnapshot = { ...workspace, films: films.map((item) => item.document) };
    dependencies.adoptWorkspace(committed);
    const retained = collectNonFilmStorageKeys(workspace);
    try {
      await context.cleanupMigrated(unreferencedMigratedKeys(receipt.migratedStorageKeys, retained));
    } catch {
      // Imported objects are retained when post-commit cleanup is uncertain.
    }
    return committed;
  });
}
