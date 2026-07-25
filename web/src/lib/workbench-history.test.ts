import { describe, expect, test } from "bun:test";
import type { AssetItem, GenerationJob } from "@/types/board";
import {
  filterWorkbenchJobs,
  formatWorkbenchBytes,
  normalizeWorkbenchCategory,
  normalizeWorkbenchLayout,
  workbenchCategories,
  workbenchImageAssets,
  workbenchReferenceKeys,
} from "./workbench-history";

const job = (id: string, category?: unknown): GenerationJob => ({
  id, kind: "image", status: "succeeded", prompt: id, providerId: "provider", model: "model",
  parameters: category === undefined ? {} : { category }, result: {},
  createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
});

describe("creative workbench history presentation", () => {
  test("normalizes, lists, and filters bounded categories immutably", () => {
    const jobs = [job("a", "  海报  "), job("b"), job("c", "角色"), job("d", "海报")];
    expect(normalizeWorkbenchCategory(" x ")).toBe("x");
    expect(normalizeWorkbenchCategory(" ")).toBe("未分类");
    expect(normalizeWorkbenchCategory("x".repeat(101))).toBe("未分类");
    expect(workbenchCategories(jobs)).toEqual(["全部", "海报", "角色", "未分类"]);
    expect(filterWorkbenchJobs(jobs, "海报").map(({ id }) => id)).toEqual(["a", "d"]);
    expect(filterWorkbenchJobs(jobs, "全部")).toEqual(jobs);
    expect(jobs[0]?.parameters.category).toBe("  海报  ");
  });

  test("formats media sizes and extracts only bounded durable references", () => {
    expect(formatWorkbenchBytes(0)).toBe("0 B");
    expect(formatWorkbenchBytes(1024)).toBe("1 KB");
    expect(formatWorkbenchBytes(1_572_864)).toBe("1.5 MB");
    expect(formatWorkbenchBytes(undefined)).toBe("大小未知");
    const value = job("refs");
    value.parameters.referenceStorageKeys = ["image:one", "", 3, "media:two"];
    expect(workbenchReferenceKeys(value)).toEqual(["image:one", "media:two"]);
  });

  test("selects reusable image assets and normalizes the two layouts", () => {
    const assets: AssetItem[] = [
      { id: "one", kind: "image", title: "One", tags: [], storageKey: "image:one", createdAt: "x", updatedAt: "x" },
      { id: "two", kind: "text", title: "Two", tags: [], content: "text", createdAt: "x", updatedAt: "x" },
      { id: "three", kind: "image", title: "Three", tags: [], createdAt: "x", updatedAt: "x" },
      { id: "legacy", kind: "image", title: "Legacy", tags: [], coverUrl: "data:image/png;base64,AA==", createdAt: "x", updatedAt: "x" },
    ];
    expect(workbenchImageAssets(assets).map(({ id }) => id)).toEqual(["one", "legacy"]);
    expect(normalizeWorkbenchLayout("bottom")).toBe("bottom");
    expect(normalizeWorkbenchLayout("side")).toBe("side");
    expect(normalizeWorkbenchLayout("grid")).toBe("side");
  });
});
