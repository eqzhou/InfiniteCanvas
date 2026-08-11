import { describe, expect, test } from "bun:test";

import { createFilmDocument } from "@/lib/film-document";
import { collectFilmStorageKeys, remapFilmStorageKeys } from "@/lib/film-media";

describe("film bundle media graph", () => {
  test("collects and immutably remaps current, frozen, and historical media", () => {
    const film = createFilmDocument("film-media", "2026-08-11T00:00:00.000Z");
    const director = {
      revision: 1, targetField: "scene" as const, captureId: "capture", directorNodeId: "director", cameraId: "camera",
      cameraName: "Camera", width: 1920, height: 1080, storageKey: "image:scene", sha256: "a".repeat(64),
      objectVersion: "v1", snapshot: {}, adoptedAt: film.createdAt,
    };
    film.scenes = [{ id: "scene-1", revision: 1, episodeId: "episode-1", order: 0, heading: "Scene", synopsis: "Action", status: "draft", directorSource: director }];
    film.shots = [{ id: "shot-1", revision: 1, sceneId: "scene-1", order: 0, title: "Shot", description: "Action", status: "draft", durationSeconds: 1, aspectRatio: "16:9", identityVersionIds: [], lastFrameStorageKey: "image:last" }];
    film.versions = [
      { id: "asset-version", entityType: "asset", entityId: "asset-1", revision: 1, snapshot: { mediaStorageKey: "image:asset-version" }, reason: "test", createdAt: film.createdAt },
      { id: "timeline-version", entityType: "timeline", entityId: "timeline", revision: 1, snapshot: { tracks: [{ kind: "dialogue", clips: [{ id: "logical", source: "dialogue:line" }, { id: "audio", source: "media:old-audio" }] }] }, reason: "test", createdAt: film.createdAt },
    ];

    expect(new Set(collectFilmStorageKeys(film))).toEqual(new Set(["image:scene", "image:last", "image:asset-version", "media:old-audio"]));

    const remapped = remapFilmStorageKeys(film, (key) => `restored:${key}`);
    expect(remapped.scenes[0]?.directorSource?.storageKey).toBe("restored:image:scene");
    expect(remapped.shots[0]?.lastFrameStorageKey).toBe("restored:image:last");
    expect(remapped.versions?.[0]?.snapshot.mediaStorageKey).toBe("restored:image:asset-version");
    expect(((remapped.versions?.[1]?.snapshot.tracks as Array<{ clips: Array<{ source: string }> }>)[0]?.clips[0]?.source)).toBe("dialogue:line");
    expect(((remapped.versions?.[1]?.snapshot.tracks as Array<{ clips: Array<{ source: string }> }>)[0]?.clips[1]?.source)).toBe("restored:media:old-audio");
    expect(film.scenes[0]?.directorSource?.storageKey).toBe("image:scene");
  });
});
