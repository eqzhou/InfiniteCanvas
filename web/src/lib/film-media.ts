import type { FilmDirectorSource, FilmDocument, FilmEntityVersion } from "@/types/film";

export function isFilmStorageKey(value: string): boolean {
  return value.startsWith("image:") || value.startsWith("media:") || value.startsWith("film:");
}

const shotStorageFields = ["imageStorageKey", "firstFrameStorageKey", "lastFrameStorageKey", "videoStorageKey", "audioStorageKey"] as const;
const shotDirectorFields = ["storyboardDirectorSource", "firstFrameDirectorSource", "lastFrameDirectorSource"] as const;

function addDirectorKey(source: FilmDirectorSource | undefined, keys: Set<string>): void {
  if (source?.storageKey) keys.add(source.storageKey);
}

function collectVersionKeys(version: FilmEntityVersion, keys: Set<string>): void {
  const snapshot = version.snapshot;
  if (version.entityType === "scene") {
    const source = snapshot.directorSource as FilmDirectorSource | undefined;
    addDirectorKey(source, keys);
  } else if (version.entityType === "shot") {
    for (const field of shotStorageFields) {
      const key = snapshot[field];
      if (typeof key === "string") keys.add(key);
    }
    for (const field of shotDirectorFields) addDirectorKey(snapshot[field] as FilmDirectorSource | undefined, keys);
  } else if (version.entityType === "dialogue") {
    if (typeof snapshot.audioStorageKey === "string") keys.add(snapshot.audioStorageKey);
  } else if (version.entityType === "asset") {
    if (typeof snapshot.mediaStorageKey === "string") keys.add(snapshot.mediaStorageKey);
  } else if (version.entityType === "timeline") {
    const tracks = Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
    for (const track of tracks) {
      if (!track || typeof track !== "object" || !Array.isArray((track as { clips?: unknown }).clips)) continue;
      for (const clip of (track as { clips: unknown[] }).clips) {
        const source = clip && typeof clip === "object" ? (clip as { source?: unknown }).source : undefined;
        if (typeof source === "string" && isFilmStorageKey(source)) keys.add(source);
      }
    }
  }
}

export function collectFilmStorageKeys(film: FilmDocument): string[] {
  const keys = new Set<string>();
  for (const scene of film.scenes) addDirectorKey(scene.directorSource, keys);
  for (const shot of film.shots) {
    for (const field of shotStorageFields) if (shot[field]) keys.add(shot[field]!);
    for (const field of shotDirectorFields) addDirectorKey(shot[field], keys);
  }
  for (const asset of film.assets) if (asset.mediaStorageKey) keys.add(asset.mediaStorageKey);
  for (const dialogue of film.dialogues ?? []) if (dialogue.audioStorageKey) keys.add(dialogue.audioStorageKey);
  for (const task of film.tasks) {
    for (const asset of task.snapshot?.identityVersions ?? []) if (asset.mediaStorageKey) keys.add(asset.mediaStorageKey);
    if (task.snapshot?.styleVersion?.mediaStorageKey) keys.add(task.snapshot.styleVersion.mediaStorageKey);
    addDirectorKey(task.snapshot?.storyboardDirectorSource, keys);
    addDirectorKey(task.snapshot?.firstFrameDirectorSource, keys);
    addDirectorKey(task.snapshot?.lastFrameDirectorSource, keys);
    for (const key of task.snapshot?.referenceStorageKeys ?? []) keys.add(key);
  }
  for (const track of film.timeline.tracks) for (const clip of track.clips) if (isFilmStorageKey(clip.source)) keys.add(clip.source);
  for (const deliverable of film.deliverables) if (deliverable.storageKey) keys.add(deliverable.storageKey);
  for (const version of film.versions ?? []) collectVersionKeys(version, keys);
  return [...keys];
}

function remapDirectorSource(source: FilmDirectorSource | undefined, replace: (key: string) => string): FilmDirectorSource | undefined {
  return source ? { ...source, storageKey: replace(source.storageKey) } : undefined;
}

function remapVersion(version: FilmEntityVersion, replace: (key: string) => string): FilmEntityVersion {
  const snapshot = { ...version.snapshot };
  if (version.entityType === "scene") {
    snapshot.directorSource = remapDirectorSource(snapshot.directorSource as FilmDirectorSource | undefined, replace);
  } else if (version.entityType === "shot") {
    for (const field of shotStorageFields) if (typeof snapshot[field] === "string") snapshot[field] = replace(snapshot[field] as string);
    for (const field of shotDirectorFields) snapshot[field] = remapDirectorSource(snapshot[field] as FilmDirectorSource | undefined, replace);
  } else if (version.entityType === "dialogue" && typeof snapshot.audioStorageKey === "string") {
    snapshot.audioStorageKey = replace(snapshot.audioStorageKey);
  } else if (version.entityType === "asset" && typeof snapshot.mediaStorageKey === "string") {
    snapshot.mediaStorageKey = replace(snapshot.mediaStorageKey);
  } else if (version.entityType === "timeline" && Array.isArray(snapshot.tracks)) {
    snapshot.tracks = snapshot.tracks.map((track) => {
      if (!track || typeof track !== "object" || !Array.isArray((track as { clips?: unknown }).clips)) return track;
      return { ...track, clips: (track as { clips: unknown[] }).clips.map((clip) => {
        if (!clip || typeof clip !== "object") return clip;
        const source = (clip as { source?: unknown }).source;
        return typeof source === "string" && isFilmStorageKey(source) ? { ...clip, source: replace(source) } : clip;
      }) };
    });
  }
  return { ...version, snapshot };
}

export function remapFilmStorageKeys(film: FilmDocument, replace: (key: string) => string): FilmDocument {
  const remapAsset = (asset: FilmDocument["assets"][number]) => ({ ...asset, mediaStorageKey: asset.mediaStorageKey ? replace(asset.mediaStorageKey) : undefined });
  return {
    ...film,
    scenes: film.scenes.map((scene) => ({ ...scene, directorSource: remapDirectorSource(scene.directorSource, replace) })),
    shots: film.shots.map((shot) => ({
      ...shot,
      ...Object.fromEntries(shotStorageFields.map((field) => [field, shot[field] ? replace(shot[field]!) : undefined])),
      storyboardDirectorSource: remapDirectorSource(shot.storyboardDirectorSource, replace),
      firstFrameDirectorSource: remapDirectorSource(shot.firstFrameDirectorSource, replace),
      lastFrameDirectorSource: remapDirectorSource(shot.lastFrameDirectorSource, replace),
    })),
    dialogues: film.dialogues?.map((dialogue) => ({ ...dialogue, audioStorageKey: dialogue.audioStorageKey ? replace(dialogue.audioStorageKey) : undefined })),
    assets: film.assets.map(remapAsset),
    tasks: film.tasks.map((task) => !task.snapshot ? task : ({ ...task, snapshot: {
      ...task.snapshot,
      identityVersions: task.snapshot.identityVersions.map(remapAsset),
      styleVersion: task.snapshot.styleVersion ? remapAsset(task.snapshot.styleVersion) : undefined,
      storyboardDirectorSource: remapDirectorSource(task.snapshot.storyboardDirectorSource, replace),
      firstFrameDirectorSource: remapDirectorSource(task.snapshot.firstFrameDirectorSource, replace),
      lastFrameDirectorSource: remapDirectorSource(task.snapshot.lastFrameDirectorSource, replace),
      referenceStorageKeys: task.snapshot.referenceStorageKeys.map(replace),
    } })),
    timeline: { ...film.timeline, tracks: film.timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => ({ ...clip, source: isFilmStorageKey(clip.source) ? replace(clip.source) : clip.source })) })) },
    deliverables: film.deliverables.map((deliverable) => ({ ...deliverable, storageKey: deliverable.storageKey ? replace(deliverable.storageKey) : undefined })),
    versions: film.versions?.map((version) => remapVersion(version, replace)),
  };
}
