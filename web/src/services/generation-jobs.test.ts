import { describe, expect, test } from "bun:test";

import {
  collectGenerationStorageKeysFromJobs,
  findUnreferencedGenerationStorageKeys,
  paginateGenerationJobs,
} from "./generation-jobs";
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

describe("generation job media lifecycle", () => {
  test("collects references and results without mutating jobs", () => {
    const input = job("with-media", "2026-07-04T00:00:00Z");
    input.parameters = {
      referenceStorageKeys: ["image:reference", "image:shared"],
    };
    input.result = {
      items: [
        { storageKey: "image:result" },
        { storageKey: "image:shared" },
        { url: "https://example.invalid/result.png" },
      ],
    };
    const snapshot = structuredClone(input);

    expect(collectGenerationStorageKeysFromJobs([input])).toEqual(new Set([
      "image:reference",
      "image:shared",
      "image:result",
    ]));
    expect(input).toEqual(snapshot);
  });

  test("only returns deleted-job media that has no remaining owner", () => {
    const removed = job("removed", "2026-07-04T00:00:00Z");
    removed.parameters = { referenceStorageKeys: ["image:orphan-ref", "image:shared"] };
    removed.result = { items: [{ storageKey: "image:orphan-result" }, { storageKey: "image:on-canvas" }] };
    const remaining = job("remaining", "2026-07-05T00:00:00Z");
    remaining.parameters = { referenceStorageKeys: ["image:shared"] };

    expect(findUnreferencedGenerationStorageKeys(
      removed,
      [remaining],
      new Set(["image:on-canvas"]),
    )).toEqual(new Set(["image:orphan-ref", "image:orphan-result"]));
  });
});
