import type { BoardProject } from "@/types/board";
import {
  exportProjectBundle,
  importProjectBundlePayload,
  type ImportedProjectBundle,
} from "@/lib/project-bundle";
import { loadFilmStatus, restoreFilmProduction } from "@/services/film-client";
import { useBoardStore } from "@/stores/use-board-store";

export async function exportCompleteProjectBundle(project: BoardProject): Promise<Blob> {
  const film = project.projectKind === "film"
    ? (await loadFilmStatus(project.id)).document
    : undefined;
  return exportProjectBundle(project, undefined, film);
}

export type FilmBundleImportDependencies = {
  readBundle: (source: Blob | ArrayBuffer | Uint8Array) => Promise<ImportedProjectBundle>;
  importProject: (project: BoardProject) => string;
  persist: () => Promise<void>;
  restoreFilm: typeof restoreFilmProduction;
  deleteProjectsDurably: (ids: string[]) => Promise<void>;
};

function defaultImportDependencies(): FilmBundleImportDependencies {
  return {
    readBundle: importProjectBundlePayload,
    importProject: (project) => useBoardStore.getState().importProject(project),
    persist: () => useBoardStore.getState().persistNow(),
    restoreFilm: restoreFilmProduction,
    deleteProjectsDurably: (ids) => useBoardStore.getState().deleteProjectsDurably(ids),
  };
}

export async function importCompleteProjectBundleWithDependencies(
  source: Blob | ArrayBuffer | Uint8Array,
  dependencies: FilmBundleImportDependencies,
): Promise<string> {
  const payload = await dependencies.readBundle(source);
  const importedProjectId = dependencies.importProject(payload.project);
  try {
    await dependencies.persist();
    if (payload.film) {
      await dependencies.restoreFilm(importedProjectId, {
        ...payload.film,
        projectId: importedProjectId,
      });
    }
    return importedProjectId;
  } catch (error) {
    try {
      await dependencies.deleteProjectsDurably([importedProjectId]);
    } catch (rollbackError) {
      const reason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`Film bundle rollback incomplete; restored media was retained: ${reason}`, { cause: error });
    }
    await payload.cleanup();
    throw error;
  }
}

export async function importCompleteProjectBundle(source: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  return importCompleteProjectBundleWithDependencies(source, defaultImportDependencies());
}
