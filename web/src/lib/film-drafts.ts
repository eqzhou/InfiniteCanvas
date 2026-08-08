import type { FilmStatus } from "@/services/film-client";

export type FilmDraftState = {
  manuscript: string;
  manuscriptDirty: boolean;
  timelineDirty: boolean;
};

export type VersionedFilmDraftState = FilmDraftState & {
  manuscriptVersion: number;
  timelineVersion: number;
};

export type FilmDraftVersions = Pick<VersionedFilmDraftState, "manuscriptVersion" | "timelineVersion">;

export function shouldConfirmFilmLeave(manuscriptDirty: boolean, timelineDirty: boolean): boolean {
  return manuscriptDirty || timelineDirty;
}

export function isFilmNavigationAway(currentHref: string, targetHref: string): boolean {
  const current = new URL(currentHref);
  const target = new URL(targetHref, current);
  return target.origin !== current.origin || target.pathname !== current.pathname || target.search !== current.search;
}

export function mergeFilmStatusPreservingDrafts(
  current: FilmStatus,
  incoming: FilmStatus,
  drafts: FilmDraftState,
): { status: FilmStatus; manuscript: string } {
  const timeline = drafts.timelineDirty ? current.document.timeline : incoming.document.timeline;
  return {
    status: {
      ...incoming,
      document: { ...incoming.document, timeline },
    },
    manuscript: drafts.manuscriptDirty ? drafts.manuscript : incoming.document.source.text,
  };
}

export function resolvePendingFilmResponse(
  current: FilmStatus,
  incoming: FilmStatus,
  latest: VersionedFilmDraftState,
  started: FilmDraftVersions,
  options: { clearManuscript?: boolean; clearTimeline?: boolean } = {},
): { status: FilmStatus; manuscript: string; manuscriptDirty: boolean; timelineDirty: boolean } {
  const manuscriptDirty = latest.manuscriptDirty && !(
    options.clearManuscript && latest.manuscriptVersion === started.manuscriptVersion
  );
  const timelineDirty = latest.timelineDirty && !(
    options.clearTimeline && latest.timelineVersion === started.timelineVersion
  );
  const merged = mergeFilmStatusPreservingDrafts(current, incoming, {
    manuscript: latest.manuscript,
    manuscriptDirty,
    timelineDirty,
  });
  return { ...merged, manuscriptDirty, timelineDirty };
}

export function filmEditorKey(id: string, revision: number): string {
  return `${id}:${revision}`;
}
