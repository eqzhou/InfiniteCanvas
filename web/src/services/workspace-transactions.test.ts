import { afterEach, describe, expect, mock, test } from "bun:test";

import { createDefaultConfig, createProject } from "@/lib/defaults";
import { createFilmDocument } from "@/lib/film-document";
import type { WorkspaceSnapshot } from "@/lib/workspace-bundle";
import type { WorkflowTemplate } from "@/types/workflow";
import {
  importProjectAtomically,
  replaceCompleteWorkspace,
  rollbackWorkspace,
  type FilmRestoreTransactionInput,
} from "./workspace-transactions";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const version = (character: string) => `w1-${character.repeat(64)}`;

describe("transaction contracts", () => {
  test("CAS-imports one project without reading or replacing a client-side workspace snapshot", async () => {
    const project = createProject("Concurrent import", "film");
    const document = createFilmDocument(project.id, "2026-08-09T00:00:00.000Z");
    const film: FilmRestoreTransactionInput = { revision: 0, document, media: [] };
    const fetcher = mock()
      .mockResolvedValueOnce(new Response("[]", { headers: { ETag: `"${version("a")}"` } }))
      .mockResolvedValueOnce(Response.json({ data: {
        version: version("b"), restoreToken: "project-token",
        migratedStorageKeys: ["media:project-migrated"],
      } }));
    globalThis.fetch = fetcher as typeof fetch;

    const result = await importProjectAtomically({ project, film });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/projects");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/projects/import");
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      expectedVersion: version("a"), project, film,
    });
    expect(result.migratedStorageKeys).toEqual(["media:project-migrated"]);
  });

  test("surfaces a concurrent single-project import conflict without retrying a full replacement", async () => {
    const project = createProject("Concurrent loser");
    const fetcher = mock()
      .mockResolvedValueOnce(new Response("[]", { headers: { ETag: `"${version("a")}"` } }))
      .mockResolvedValueOnce(new Response("workspace changed", { status: 409 }));
    globalThis.fetch = fetcher as typeof fetch;

    await expect(importProjectAtomically({ project })).rejects.toThrow("HTTP 409");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/projects/import");
  });

  test("sends tenant workspace data and strict Film media without personal settings", async () => {
    const project = createProject("Film", "film");
    const document = createFilmDocument(project.id, "2026-08-09T00:00:00.000Z");
    document.timeline.tracks[0]!.clips = [{ id: "timeline-only", revision: 1, source: "media:timeline", order: 0, start: 0, end: 1, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }];
    const film: FilmRestoreTransactionInput = {
      revision: 2,
      document,
      media: [{
        storageKey: "media:timeline", mimeType: "audio/mpeg", bytes: 4,
        sha256: "a".repeat(64), objectVersion: "timeline-v1",
        provenance: [{ kind: "timeline", entityId: "timeline-only", field: "source" }],
      }],
    };
    const template: WorkflowTemplate = {
      schemaVersion: 1, id: "workflow-1", revision: 1, scope: "personal", title: "Workflow",
      description: "", category: "test", variables: [], steps: [],
      createdAt: document.createdAt, updatedAt: document.updatedAt,
    };
    const snapshot: Omit<WorkspaceSnapshot, "films"> = {
      projects: [project],
      assets: [{ id: "asset-1", name: "Asset", kind: "audio", coverUrl: "", storageKey: "media:timeline", createdAt: document.createdAt }],
      prompts: [], config: createDefaultConfig(), generationJobs: [], workflowTemplates: [template],
    };
    const templatesBefore = structuredClone(snapshot.workflowTemplates);
    const fetcher = mock()
      .mockResolvedValueOnce(new Response("[]", { headers: { ETag: `"${version("a")}"` } }))
      .mockResolvedValueOnce(Response.json({ data: {
        version: version("b"), restoreToken: "rollback-secret",
        migratedStorageKeys: ["media:workspace-migrated", "media:workspace-migrated"],
      } }));
    globalThis.fetch = fetcher as typeof fetch;

    const receipt = await replaceCompleteWorkspace({ snapshot, films: [film] });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/projects");
    const expectedBody = {
      expectedVersion: version("a"),
      projects: snapshot.projects,
      films: [film],
      assets: snapshot.assets,
      prompts: snapshot.prompts,
      generationJobs: snapshot.generationJobs,
    };
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(
      JSON.parse(JSON.stringify(expectedBody)),
    );
    expect(snapshot.workflowTemplates).toEqual(templatesBefore);
    expect(receipt).toEqual({
      version: version("b"), restoreToken: "rollback-secret",
      migratedStorageKeys: ["media:workspace-migrated"],
    });
  });

  test("sends rollback errors to the caller", async () => {
    const fetcher = mock(async () => new Response("conflict", { status: 409 }));
    globalThis.fetch = fetcher as typeof fetch;

    await expect(rollbackWorkspace({
      version: version("b"), restoreToken: "rollback-secret", migratedStorageKeys: [],
    })).rejects.toThrow("HTTP 409");
  });

  test("does not issue follow-up writes when the complete workspace transaction fails", async () => {
    const snapshot: Omit<WorkspaceSnapshot, "films"> = {
      projects: [], assets: [], prompts: [], config: createDefaultConfig(), generationJobs: [], workflowTemplates: [],
    };
    const fetcher = mock()
      .mockResolvedValueOnce(new Response("[]", { headers: { ETag: `"${version("a")}"` } }))
      .mockResolvedValueOnce(new Response("invalid snapshot", { status: 422 }));
    globalThis.fetch = fetcher as typeof fetch;

    await expect(replaceCompleteWorkspace({ snapshot, films: [] })).rejects.toThrow("HTTP 422");

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
