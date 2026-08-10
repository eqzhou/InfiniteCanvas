import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createProject } from "@/lib/defaults";
import { createFilmDocument } from "@/lib/film-document";
import type { FilmStatus } from "@/services/film-client";
import { ProjectionPanel } from "./ProductionPanels";

describe("Film Director projection workflow", () => {
  test("offers verified Director captures only when the Film canvas has a Director node", () => {
    const project = createProject("Film", "film");
    project.id = "film-director";
    project.nodes = [{ id: "director-main", type: "director", title: "正式构图", position: { x: 0, y: 0 }, width: 640, height: 480, metadata: {} }];
    const document = createFilmDocument(project.id, "2026-08-08T00:00:00.000Z");
    document.shots = [{ id: "shot-1", revision: 2, sceneId: "scene-1", order: 0, title: "镜头一", description: "", status: "draft", durationSeconds: 3, aspectRatio: "16:9", identityVersionIds: [] }];
    const status: FilmStatus = {
      document, recordRevision: 1,
      capabilities: { available: true, reason: "", plainTextImport: true, markdownImport: true, docxImport: true, pdfImport: true, fileUploadImport: true, maxImportBytes: 1, stageGeneration: true, generationJobs: true, generationStages: [], assetBundleExport: true, mp4Export: false, mp4Diagnostic: "", agentOperations: [] },
    };
    const html = renderToStaticMarkup(<ProjectionPanel project={project} status={status} busy={false} onStatus={() => {}} onRefreshCanvas={async () => {}} onCommitCanvas={async () => {}} onAdopt={async () => {}} onAdoptDirector={async () => {}} />);

    expect(html).toContain("Director 正式构图");
    expect(html).toContain("加载 Director 拍摄版本");
    expect(html).toContain("采用为分镜或首帧");
  });
});
