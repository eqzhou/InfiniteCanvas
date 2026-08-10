import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AIDecompositionPanel, AIScriptPanel, ManuscriptPanel } from "./ManuscriptAssetsPanels";
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

describe("AI episode script panel", () => {
  test("shows per-episode generation and review-gated script candidates", () => {
    const document = createFilmDocument("film-script", "2026-08-08T00:00:00.000Z");
    document.episodes = [{ id: "episode-1", revision: 2, order: 0, title: "Signal", synopsis: "", status: "draft" }];
    document.scriptCandidates = [{
      id: "script-candidate-1", revision: 1, stage: "script", status: "ready",
      sourceRevision: 1, sourceSha256: "a".repeat(64), filmRevision: 3,
      targetEpisodeId: "episode-1", targetRevision: 2, targetSha256: "b".repeat(64),
      taskId: "task-script", generationJobId: "job-script", requestHash: "c".repeat(64),
      script: { summary: "Lin follows the signal.", scenes: [{ key: "scene-1", heading: "INT. STATION - NIGHT", synopsis: "", shots: [] }] },
      createdAt: document.createdAt,
    }];
    const html = renderToStaticMarkup(<AIScriptPanel
      document={document}
      busy={false}
      channels={[{ id: "shared-text", name: "Production text", models: ["gpt-text"] }]}
      channelId="shared-text"
      model="gpt-text"
      episodeId="episode-1"
      onChannel={() => {}}
      onModel={() => {}}
      onEpisode={() => {}}
      onRun={() => {}}
      onApply={() => {}}
    />);

    expect(html).toContain("AI 分集剧本");
    expect(html).toContain("Signal");
    expect(html).toContain("Lin follows the signal.");
    expect(html).toContain("采用这版剧本");
  });
});
