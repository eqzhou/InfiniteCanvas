import { describe, expect, test } from "bun:test";

import { createFilmDocument } from "./film-document";
import {
  filmEditorKey,
  isFilmNavigationAway,
  mergeFilmStatusPreservingDrafts,
  resolvePendingFilmResponse,
  shouldConfirmFilmLeave,
} from "./film-drafts";

describe("film workbench drafts", () => {
  test("preserves dirty manuscript and timeline across unrelated API responses", () => {
    const current = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const incoming = { ...current, revision: 2, source: { ...current.source, text: "server" } };
    const localTimeline = { ...current.timeline, width: 1280 };

    const merged = mergeFilmStatusPreservingDrafts(
      { document: { ...current, timeline: localTimeline }, recordRevision: 1 },
      { document: incoming, recordRevision: 2 },
      { manuscript: "local draft", manuscriptDirty: true, timelineDirty: true },
    );

    expect(merged.manuscript).toBe("local draft");
    expect(merged.status.document.timeline.width).toBe(1280);
    expect(merged.status.document.revision).toBe(2);
  });

  test("only prompts on leave when an editor is dirty", () => {
    expect(shouldConfirmFilmLeave(false, false)).toBe(false);
    expect(shouldConfirmFilmLeave(true, false)).toBe(true);
    expect(shouldConfirmFilmLeave(false, true)).toBe(true);
  });

  test("distinguishes in-page sections from application navigation", () => {
    const current = "https://openboard.local/film/film-1#timeline";
    expect(isFilmNavigationAway(current, "#delivery")).toBe(false);
    expect(isFilmNavigationAway(current, "/assets")).toBe(true);
    expect(isFilmNavigationAway(current, "https://example.com/")).toBe(true);
  });

  test("uses drafts edited after an async save started and keeps them dirty", () => {
    const original = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const incoming = { ...original, revision: 2, source: { ...original.source, text: "saved request body" } };
    const localTimeline = { ...original.timeline, width: 1280 };

    const resolved = resolvePendingFilmResponse(
      { document: { ...original, timeline: localTimeline }, recordRevision: 1 },
      { document: incoming, recordRevision: 2 },
      {
        manuscript: "new edit while pending",
        manuscriptDirty: true,
        manuscriptVersion: 3,
        timelineDirty: true,
        timelineVersion: 4,
      },
      { manuscriptVersion: 2, timelineVersion: 3 },
      { clearManuscript: true, clearTimeline: true },
    );

    expect(resolved.manuscript).toBe("new edit while pending");
    expect(resolved.status.document.timeline.width).toBe(1280);
    expect(resolved.manuscriptDirty).toBe(true);
    expect(resolved.timelineDirty).toBe(true);
  });

  test("clears only the draft version that was successfully saved", () => {
    const original = createFilmDocument("film-1", "2026-08-08T00:00:00.000Z");
    const incoming = { ...original, revision: 2, source: { ...original.source, text: "saved" } };
    const resolved = resolvePendingFilmResponse(
      { document: original, recordRevision: 1 },
      { document: incoming, recordRevision: 2 },
      {
        manuscript: "saved",
        manuscriptDirty: true,
        manuscriptVersion: 2,
        timelineDirty: false,
        timelineVersion: 0,
      },
      { manuscriptVersion: 2, timelineVersion: 0 },
      { clearManuscript: true },
    );

    expect(resolved.manuscriptDirty).toBe(false);
    expect(resolved.manuscript).toBe("saved");
  });

  test("keys entity editors by server revision", () => {
    expect(filmEditorKey("shot_1", 3)).toBe("shot_1:3");
    expect(filmEditorKey("shot_1", 4)).not.toBe(filmEditorKey("shot_1", 3));
  });
});
