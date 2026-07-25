import { describe, expect, test } from "bun:test";
import type { GenerationJob } from "@/types/board";
import { canvasGenerationPatch } from "@/components/canvas/useCanvasGenerationRecovery";

function job(status: GenerationJob["status"]): GenerationJob {
  return {
    id: "job-video", kind: "video", status, prompt: "move", providerId: "media",
    parameters: { executor: "server" }, result: {},
    createdAt: "2026-07-24T00:00:00Z", updatedAt: "2026-07-24T00:00:01Z",
  };
}

describe("canvas durable generation recovery", () => {
  test("maps a protected terminal result onto its placeholder", () => {
    const succeeded = job("succeeded");
    succeeded.result = { items: [{ storageKey: "media:video", mimeType: "video/mp4", bytes: 24 }] };
    expect(canvasGenerationPatch(succeeded, "blob:resolved")).toEqual({
      content: "blob:resolved",
      storageKey: "media:video",
      mimeType: "video/mp4",
      bytes: 24,
      status: "success",
      errorDetails: undefined,
      generationJobId: "job-video",
    });
  });

  test("keeps sanitized terminal failures retryable", () => {
    const failed = job("failed");
    failed.error = "生成失败，请检查模型服务配置后重试";
    expect(canvasGenerationPatch(failed)).toEqual({
      status: "error",
      errorDetails: "生成失败，请检查模型服务配置后重试",
      generationJobId: "job-video",
    });
  });

  test("maps an indexed image result onto the matching batch placeholder", () => {
    const succeeded = { ...job("succeeded"), id: "job-image", kind: "image" as const };
    succeeded.result = { items: [
      { storageKey: "image:first", mimeType: "image/png", width: 10, height: 20, bytes: 30 },
      { storageKey: "image:second", mimeType: "image/png", width: 40, height: 50, bytes: 60 },
    ] };
    expect(canvasGenerationPatch(succeeded, "blob:second", 1)).toMatchObject({
      content: "blob:second",
      storageKey: "image:second",
      naturalWidth: 40,
      naturalHeight: 50,
      generationJobId: "job-image",
      status: "success",
    });
  });
});
