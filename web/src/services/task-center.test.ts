import { describe, expect, test } from "bun:test";
import type { GenerationJob } from "@/types/board";
import { buildTaskCenterItems, filterTaskCenterItems } from "./task-center";

function job(overrides: Partial<GenerationJob>): GenerationJob {
  return {
    id: "job-1", projectId: "film-1", kind: "image", status: "running", prompt: "private prompt",
    parameters: {}, result: {}, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z", ...overrides,
  };
}

describe("unified task center", () => {
  test("derives Film stages and shots from whitelisted binding fields", () => {
    const items = buildTaskCenterItems([job({ parameters: {
      executor: "server", film: { projectId: "film-1", stage: "storyboard", shotId: "shot-2", taskId: "task-3", requestHash: "secret-hash" },
      sharedChannel: { apiKey: ["must", "not", "leak"].join("-") },
    } })]);
    expect(items[0]).toMatchObject({ projectId: "film-1", stage: "storyboard", shotId: "shot-2", source: "film" });
    expect(JSON.stringify(items)).not.toContain("must-not-leak");
    expect(JSON.stringify(items)).not.toContain("private prompt");
  });

  test("filters by status, kind and project without mutating the source", () => {
    const items = buildTaskCenterItems([
      job({ id: "text", kind: "text", status: "failed" }),
      job({ id: "video", kind: "video", status: "succeeded", projectId: "board-2" }),
    ]);
    expect(filterTaskCenterItems(items, { status: "failed", kind: "text", projectId: "film-1" }).map((item) => item.id)).toEqual(["text"]);
    expect(items).toHaveLength(2);
  });

  test("aggregates durable Film stage parents from their persisted children", () => {
    const items = buildTaskCenterItems([
      job({ id: "parent", kind: "film-stage", status: "queued", parameters: { executor: "film-stage", projectId: "film-1", stage: "storyboard", childJobIds: ["child"] } }),
      job({ id: "child", status: "succeeded", parameters: { executor: "server", film: { projectId: "film-1", stage: "storyboard", shotId: "shot-1", taskId: "task-1", parentGenerationJobId: "parent" } } }),
    ]);

    expect(items.find((item) => item.id === "parent")).toMatchObject({ source: "film", stage: "storyboard", status: "succeeded", title: "影视阶段 · storyboard" });
    expect(items.find((item) => item.id === "child")).toMatchObject({ parentTaskId: "parent", shotId: "shot-1" });
  });

  test("keeps a partially failed parent active while another child is running", () => {
    const items = buildTaskCenterItems([
      job({ id: "parent", kind: "film-stage", status: "running", parameters: { executor: "film-stage", stage: "video", childJobIds: ["failed", "active"] } }),
      job({ id: "failed", status: "failed" }),
      job({ id: "active", status: "running" }),
    ]);
    expect(items.find((item) => item.id === "parent")?.status).toBe("running");
  });

  test("shows bounded Film parent progress and outcome counts without exposing raw results", () => {
    const items = buildTaskCenterItems([job({
      id: "parent", kind: "film-stage", status: "running",
      parameters: { executor: "film-stage", stage: "video", childJobIds: ["a", "b", "c"], estimatedCredits: 12 },
      result: { progress: 0.5, total: 3, succeeded: 1, failed: 1, running: 1, actualCredits: 4, privateProviderPayload: "must-not-leak" },
    })]);
    expect(items[0]).toMatchObject({ progress: 0.5, total: 3, succeeded: 1, failed: 1, estimatedCredits: 12, actualCredits: 4 });
    expect(JSON.stringify(items)).not.toContain("must-not-leak");
  });

  test("shows the frozen quote and terminal net cost for Film text tasks", () => {
    const items = buildTaskCenterItems([job({
      id: "text-film", kind: "text", status: "succeeded",
      parameters: { executor: "server", estimatedCredits: 7, film: { stage: "decompose", taskId: "task-text" } },
    })]);
    expect(items[0]).toMatchObject({ estimatedCredits: 7, actualCredits: 7 });
  });
});
