import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createProject } from "@/lib/defaults";
import { createFilmDocument } from "@/lib/film-document";
import type { FilmStatus } from "@/services/film-client";
import { ProductionPanel, ProjectionPanel } from "./ProductionPanels";

describe("Film Director projection workflow", () => {
  test("offers an on-demand Director node for every Film scene", () => {
    const project = createProject("Film", "film");
    const document = createFilmDocument(project.id, "2026-08-08T00:00:00.000Z");
    document.scenes = [{ id: "scene-1", revision: 1, episodeId: "episode-1", order: 0, heading: "INT. ROOM", synopsis: "Action", status: "draft" }];
    const status: FilmStatus = {
      document, recordRevision: 1,
      capabilities: { available: true, reason: "", plainTextImport: true, markdownImport: true, docxImport: true, pdfImport: true, fileUploadImport: true, maxImportBytes: 1, stageGeneration: true, generationJobs: true, generationStages: [], assetBundleExport: true, mp4Export: false, mp4Diagnostic: "", agentOperations: [] },
    };

    const html = renderToStaticMarkup(<ProjectionPanel project={project} status={status} busy={false} onStatus={() => {}} onRefreshCanvas={async () => {}} onCommitCanvas={async () => {}} onAdopt={async () => {}} onAdoptDirector={async () => {}} onBindDirectorScene={async () => {}} onOpenDirector={() => {}} />);

    expect(html).toContain("创建 / 定位 Director");
    expect(html).toContain("INT. ROOM");
  });

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
    const html = renderToStaticMarkup(<ProjectionPanel project={project} status={status} busy={false} onStatus={() => {}} onRefreshCanvas={async () => {}} onCommitCanvas={async () => {}} onAdopt={async () => {}} onAdoptDirector={async () => {}} onBindDirectorScene={async () => {}} onOpenDirector={() => {}} />);

    expect(html).toContain("Director 正式构图");
    expect(html).toContain("加载 Director 拍摄版本");
    expect(html).toContain("采用为分镜或首帧");
  });
});

describe("Film media capability selection", () => {
  test("fails closed while the server capability catalog is unavailable", () => {
    const document = createFilmDocument("film-catalog", "2026-08-08T00:00:00.000Z");
    const status: FilmStatus = { document, recordRevision: 1, capabilities: { available: true, reason: "", plainTextImport: true, markdownImport: true, docxImport: true, pdfImport: true, fileUploadImport: true, maxImportBytes: 1, stageGeneration: true, generationJobs: true, generationStages: ["storyboard", "video", "audio"], assetBundleExport: true, mp4Export: false, mp4Diagnostic: "", agentOperations: [] } };
    const html = renderToStaticMarkup(<ProductionPanel status={status} busy={false} onLegacyStage={() => {}} onRun={async () => false} onSynced={() => {}} />);
    expect(html).toContain("媒体能力目录");
    expect(html).toContain("目录加载完成前不会猜测模型能力");
    expect(html).toContain("disabled");
  });
});
