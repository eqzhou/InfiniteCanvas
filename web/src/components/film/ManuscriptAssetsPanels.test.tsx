import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AIDecompositionPanel, ManuscriptPanel } from "./ManuscriptAssetsPanels";
import { createFilmDocument } from "@/lib/film-document";

describe("AI decomposition panel", () => {
  test("shows frozen generation controls and review-gated candidates", () => {
    const document = createFilmDocument("film-ai", "2026-08-08T00:00:00.000Z");
    document.source.revision = 3;
    document.aiCandidates = [{
      id: "candidate-1", revision: 1, stage: "decompose", status: "ready",
      sourceRevision: 3, sourceSha256: "a".repeat(64), filmRevision: 2,
      taskId: "task-1", generationJobId: "job-1", requestHash: "b".repeat(64),
      decomposition: {
        summary: "A courier follows a hidden signal.", theme: "trust",
        characters: [{ key: "lin", name: "Lin", description: "Courier" }],
        locations: [], timeline: [], episodes: [{ key: "ep", title: "Signal", synopsis: "", scenes: [] }],
      },
      createdAt: document.createdAt,
    }];
    const html = renderToStaticMarkup(<AIDecompositionPanel
      document={document}
      busy={false}
      channels={[{ id: "shared-text", name: "Production text", models: ["gpt-text"] }]}
      channelId="shared-text"
      model="gpt-text"
      onChannel={() => {}}
      onModel={() => {}}
      onRun={() => {}}
      onApply={() => {}}
    />);

    expect(html).toContain("AI 故事拆解");
    expect(html).toContain("Production text");
    expect(html).toContain("A courier follows a hidden signal.");
    expect(html).toContain("采用这个候选");
    expect(html).toContain("先采用候选，再批准拆解阶段");
  });
});

describe("manuscript preflight", () => {
  test("requires a read-only preview before deterministic import", () => {
    const document = createFilmDocument("film-preflight", "2026-08-08T00:00:00.000Z");
    const html = renderToStaticMarkup(<ManuscriptPanel
      document={document}
      capabilities={{
        available: true, reason: "", plainTextImport: true, markdownImport: true, docxImport: true, pdfImport: true,
        fileUploadImport: true, maxImportBytes: 50 * 1024 * 1024, stageGeneration: true, generationJobs: true,
        generationStages: ["storyboard"], assetBundleExport: true, mp4Export: false, mp4Diagnostic: "", agentOperations: [],
      }}
      manuscript="EPISODE 1\nINT. ROOM - DAY"
      busy={false}
      onDraft={() => {}}
      onPreflight={async () => ({
        format: "text", bytes: 25, characters: 25, lineCount: 2,
        episodeCount: 1, sceneCount: 1, summary: "EPISODE 1 INT. ROOM - DAY", warnings: [],
      })}
      onImportText={async () => true}
      onImportFile={async () => true}
    />);

    expect(html).toContain("预检原稿");
    expect(html).toContain("预检不会写入影视事实");
    expect(html).not.toContain("导入并拆解");
  });
});
