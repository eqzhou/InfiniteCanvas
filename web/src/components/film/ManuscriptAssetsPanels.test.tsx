import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AIDecompositionPanel } from "./ManuscriptAssetsPanels";
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
