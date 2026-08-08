import { describe, expect, test } from "bun:test";

import { createFilmDocument } from "@/lib/film-document";
import { createProject } from "@/lib/defaults";
import { importCompleteProjectBundleWithDependencies } from "./film-bundle";

function dependencies(events: string[], deleteError?: Error) {
  const project = createProject("Imported film", "film");
  return {
    readBundle: async () => ({
      project,
      film: createFilmDocument(project.id, "2026-08-08T00:00:00.000Z"),
      cleanup: async () => { events.push("cleanup-media"); },
    }),
    importProject: () => "imported-film",
    persist: async () => { events.push("persist-board"); },
    restoreFilm: async () => {
      events.push("restore-film");
      throw new Error("restore rejected");
    },
    deleteProjectsDurably: async () => {
      events.push("delete-board-start");
      if (deleteError) throw deleteError;
      events.push("delete-board-done");
    },
  };
}

describe("complete film bundle rollback", () => {
  test("awaits durable board deletion before removing restored media", async () => {
    const events: string[] = [];

    await expect(importCompleteProjectBundleWithDependencies(new Uint8Array(), dependencies(events)))
      .rejects.toThrow("restore rejected");

    expect(events).toEqual([
      "persist-board",
      "restore-film",
      "delete-board-start",
      "delete-board-done",
      "cleanup-media",
    ]);
  });

  test("retains restored media and reports an incomplete rollback when board deletion fails", async () => {
    const events: string[] = [];

    await expect(importCompleteProjectBundleWithDependencies(
      new Uint8Array(),
      dependencies(events, new Error("delete offline")),
    )).rejects.toThrow("rollback incomplete");

    expect(events).toEqual([
      "persist-board",
      "restore-film",
      "delete-board-start",
    ]);
  });
});
