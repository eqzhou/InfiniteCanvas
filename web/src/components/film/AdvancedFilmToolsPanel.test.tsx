import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createFilmDocument } from "@/lib/film-document";
import { normalizeFilmCapabilities, type FilmStatus } from "@/services/film-client";
import { AdvancedFilmToolsPanel } from "./AdvancedFilmToolsPanel";

function statusWithFeatures(features: Partial<FilmStatus["capabilities"]["features"]>): FilmStatus {
  const document = createFilmDocument("film-advanced", "2026-08-11T00:00:00.000Z");
  document.assets = [{
    id: "asset-image", revision: 3, kind: "prop", title: "Station reference", description: "",
    status: "approved", mediaStorageKey: "upload:image", mediaMimeType: "image/png",
    mediaSha256: "a".repeat(64), mediaObjectVersion: "object-v3",
  }];
  Object.assign(document, {
    styleCandidates: [{
      id: "candidate-1", revision: 1, status: "needs_review", sourceAsset: document.assets[0],
      providerId: "shared-text", model: "vision-model", promptVersion: "film-style-extraction-v1",
      outputSchema: "film-style-bible-v1", parameters: { detailLevel: "high", focus: "lighting" },
      taskId: "task-style", generationJobId: "job-style", requestHash: "b".repeat(64),
      bible: { summary: "Noir lighting", stylePrompt: "high contrast", negativePrompt: "flat light", palette: ["#101820"], lighting: "rim light", composition: "centered", camera: "50mm", texture: "grain", tags: ["noir"] },
      createdAt: document.createdAt,
    }],
  });
  const capabilities = normalizeFilmCapabilities({ features });
  return { document, recordRevision: 1, capabilities };
}

describe("advanced film tools", () => {
  test("keeps disabled capabilities explicit and removes actionable forms", () => {
    const html = renderToStaticMarkup(<AdvancedFilmToolsPanel
      status={statusWithFeatures({ advancedVoice: false, styleExtraction: false, localWorkflows: false })}
      channels={[]}
      onFilmStatus={() => {}}
    />);

    expect(html).toContain("风格提取未启用");
    expect(html).toContain("高级声音未启用");
    expect(html).toContain("本地工作流未启用");
    expect(html).not.toContain("manifestId");
  });

  test("exposes versioned style, audited voice, and approved-manifest ComfyUI controls", () => {
    const html = renderToStaticMarkup(<AdvancedFilmToolsPanel
      status={statusWithFeatures({ advancedVoice: true, styleExtraction: true, localWorkflows: true })}
      channels={[{ id: "shared-text", name: "Production text", models: ["vision-model"] }]}
      onFilmStatus={() => {}}
    />);

    expect(html).toContain("Station reference · r3");
    expect(html).toContain("采用候选");
    expect(html).toContain("声音身份");
    expect(html).toContain("同意证据 storageKey");
    expect(html).toContain("已批准 Manifest ID");
    expect(html).toContain("取消任务");
    expect(html).not.toMatch(/API key/i);
    expect(html).not.toMatch(/endpoint/i);
    expect(html).not.toContain("allowPrivate");
  });
});
