import { describe, expect, test } from "bun:test";

import { paginateGenerationJobs } from "./generation-jobs";
import type { GenerationJob } from "@/types/board";

const job = (id: string, createdAt: string, kind: "image" | "video" = "image"): GenerationJob => ({
  id,
  kind,
  status: "succeeded",
  prompt: id,
  parameters: {},
  result: {},
  createdAt,
  updatedAt: createdAt,
});

describe("generation job pagination", () => {
  test("filters, sorts newest first, paginates, and leaves input immutable", () => {
    const input = [
      job("old", "2026-07-01T00:00:00Z"),
      job("video", "2026-07-03T00:00:00Z", "video"),
      job("new", "2026-07-02T00:00:00Z"),
    ];
    const page = paginateGenerationJobs(input, { kind: "image", page: 1, pageSize: 1 });
    expect(page.items.map((item) => item.id)).toEqual(["new"]);
    expect(page.total).toBe(2);
    expect(input.map((item) => item.id)).toEqual(["old", "video", "new"]);
  });

  test("rejects invalid pagination", () => {
    expect(() => paginateGenerationJobs([], { page: 0, pageSize: 20 })).toThrow("page");
    expect(() => paginateGenerationJobs([], { page: 1, pageSize: 101 })).toThrow("pageSize");
  });
});
