import { describe, expect, mock, test } from "bun:test";

import {
  FILM_STYLE_TEMPLATES,
  applyFilmStyleTemplate,
  copyFilmStyleTemplateAsProject,
} from "./film-style-templates";
import { createFilmDocument } from "@/lib/film-document";
import type { FilmStatus } from "./film-client";

function status(projectId: string): FilmStatus {
  return {
    document: createFilmDocument(projectId, "2026-08-11T00:00:00.000Z"),
    recordRevision: 1,
    capabilities: {
      available: true,
      reason: "",
      plainTextImport: true,
      markdownImport: true,
      docxImport: true,
      pdfImport: true,
      fileUploadImport: true,
      maxImportBytes: 1,
      stageGeneration: true,
      generationJobs: true,
      generationStages: [],
      assetBundleExport: true,
      mp4Export: false,
      mp4Diagnostic: "",
      agentOperations: [],
    },
  };
}

describe("original Film style template catalog", () => {
  test("ships bounded, independent templates with stable ids and production metadata", () => {
    expect(FILM_STYLE_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(FILM_STYLE_TEMPLATES.map((item) => item.id)).size).toBe(FILM_STYLE_TEMPLATES.length);
    for (const template of FILM_STYLE_TEMPLATES) {
      expect(template.origin).toBe("openboard-original");
      expect(template.title.length).toBeGreaterThan(1);
      expect(template.description.length).toBeGreaterThan(8);
      expect(template.stylePrompt.length).toBeGreaterThan(20);
      expect(["16:9", "9:16", "2.39:1", "1:1"]).toContain(template.aspectRatio);
    }
  });

  test("applies a template as one project-local style asset without creating a second fact store", async () => {
    const createAsset = mock(async (projectId: string, input: unknown) => status(projectId));

    const result = await applyFilmStyleTemplate("film-current", "mist-harbor-documentary", { createAsset });

    expect(result.document.projectId).toBe("film-current");
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(createAsset.mock.calls[0]).toEqual(["film-current", {
      kind: "style",
      title: "雾港纪实",
      description: expect.stringContaining("OpenBoard 原创"),
      stylePrompt: expect.any(String),
      aspectRatio: "16:9",
    }]);
  });

  test("copies a template into a new Film project and rolls the project back if initialization fails", async () => {
    const calls: string[] = [];
    const host = {
      createProject: mock((title: string, kind: "film") => { calls.push(`create:${title}:${kind}`); return "film-copy"; }),
      persistProjects: mock(async () => { calls.push("persist"); }),
      removeProject: mock(async (projectId: string) => { calls.push(`remove:${projectId}`); }),
      createProduction: mock(async (projectId: string) => { calls.push(`production:${projectId}`); return status(projectId); }),
      createAsset: mock(async (projectId: string) => { calls.push(`asset:${projectId}`); return status(projectId); }),
    };

    await expect(copyFilmStyleTemplateAsProject("mist-harbor-documentary", host)).resolves.toBe("film-copy");
    expect(calls).toEqual(["create:雾港纪实 影片:film", "persist", "production:film-copy", "asset:film-copy"]);

    calls.length = 0;
    host.createProduction = mock(async () => { throw new Error("offline"); });
    await expect(copyFilmStyleTemplateAsProject("mist-harbor-documentary", host)).rejects.toThrow("offline");
    expect(calls).toEqual(["create:雾港纪实 影片:film", "persist", "remove:film-copy"]);
  });

  test("reports both initialization and rollback failures", async () => {
    await expect(copyFilmStyleTemplateAsProject("mist-harbor-documentary", {
      createProject: () => "film-orphan",
      persistProjects: async () => undefined,
      removeProject: async () => { throw new Error("cleanup unavailable"); },
      createProduction: async () => { throw new Error("initialization unavailable"); },
    })).rejects.toThrow("cleanup unavailable");
  });

  test("rejects unknown template ids before changing project state", async () => {
    const createProject = mock(() => "unexpected");
    await expect(copyFilmStyleTemplateAsProject("missing", {
      createProject,
      persistProjects: async () => undefined,
      removeProject: async () => undefined,
      createProduction: async () => status("unexpected"),
      createAsset: async () => status("unexpected"),
    })).rejects.toThrow("影视风格模板不存在");
    expect(createProject).not.toHaveBeenCalled();
  });
});
