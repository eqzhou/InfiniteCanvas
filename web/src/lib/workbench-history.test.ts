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
  workbenchRefillAssetIds,
  workbenchRefillForm,
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

describe("creative workbench history refill", () => {
  const imageJob: GenerationJob = {
    id: "hist-1", kind: "image", status: "succeeded", prompt: "  一只纸雕老虎  ",
    providerId: "channel-b", model: "gpt-image-1",
    parameters: {
      size: "1536x1024", quality: "high", count: 3, transparentBackground: true,
      category: " 海报 ", referenceStorageKeys: ["image:ref-a", "image:ref-b"],
    },
    result: {}, createdAt: "2026-07-25T00:00:00.000Z", updatedAt: "2026-07-25T00:00:00.000Z",
  };

  const currentForm = {
    prompt: "草稿", model: "current-model", providerId: "channel-a",
    size: "1024x1024", quality: "auto", count: 1, transparentBackground: false,
    category: "", referenceStorageKeys: [] as string[],
  };

  test("restores every field the record saved", () => {
    // Upstream lists refill separately from retry: retry re-runs the record
    // as-is, refill puts it back in the form so it can be tweaked first.
    expect(workbenchRefillForm(imageJob, currentForm)).toEqual({
      prompt: "一只纸雕老虎",
      model: "gpt-image-1",
      providerId: "channel-b",
      size: "1536x1024",
      quality: "high",
      count: 3,
      transparentBackground: true,
      category: "海报",
      referenceStorageKeys: ["image:ref-a", "image:ref-b"],
    });
  });

  test("keeps the current form value where the record has nothing usable", () => {
    const sparse: GenerationJob = {
      ...imageJob, prompt: "   ", model: "", providerId: "", parameters: {},
    };
    expect(workbenchRefillForm(sparse, currentForm)).toEqual(currentForm);
  });

  test("rejects out-of-range and malformed record values", () => {
    const hostile: GenerationJob = {
      ...imageJob,
      parameters: {
        size: 42, quality: null, count: 99, transparentBackground: "yes",
        category: "x".repeat(101), referenceStorageKeys: ["ok", "", 7],
      },
    };
    const refilled = workbenchRefillForm(hostile, currentForm);
    expect(refilled.size).toBe(currentForm.size);
    expect(refilled.quality).toBe(currentForm.quality);
    expect(refilled.count).toBe(8);
    expect(refilled.transparentBackground).toBe(false);
    expect(refilled.category).toBe("未分类");
    expect(refilled.referenceStorageKeys).toEqual(["ok"]);
  });

  test("never mutates the record or the current form", () => {
    const jobSnapshot = JSON.stringify(imageJob);
    const formSnapshot = JSON.stringify(currentForm);
    const refilled = workbenchRefillForm(imageJob, currentForm);
    refilled.referenceStorageKeys.push("mutated");
    expect(JSON.stringify(imageJob)).toBe(jobSnapshot);
    expect(JSON.stringify(currentForm)).toBe(formSnapshot);
  });
});

describe("creative workbench refill references", () => {
  const assets: AssetItem[] = [
    { id: "a1", kind: "image", title: "A", tags: [], storageKey: "image:ref-a", createdAt: "x", updatedAt: "x" },
    { id: "a2", kind: "image", title: "B", tags: [], storageKey: "image:ref-b", createdAt: "x", updatedAt: "x" },
    { id: "a3", kind: "text", title: "C", tags: [], storageKey: "text:ref-c", createdAt: "x", updatedAt: "x" },
  ];

  test("maps recorded reference keys back to selectable library assets", () => {
    expect(workbenchRefillAssetIds(["image:ref-b", "image:ref-a"], assets))
      .toEqual({ assetIds: ["a2", "a1"], unresolved: 0 });
  });

  test("reports one-off uploads that no library asset can restore", () => {
    // A reference uploaded straight from disk has no asset behind it, so the
    // form cannot re-select it. Say so instead of dropping it silently.
    expect(workbenchRefillAssetIds(["image:ref-a", "image:gone"], assets))
      .toEqual({ assetIds: ["a1"], unresolved: 1 });
    expect(workbenchRefillAssetIds([], assets)).toEqual({ assetIds: [], unresolved: 0 });
  });

  test("ignores assets that are not reusable images", () => {
    expect(workbenchRefillAssetIds(["text:ref-c"], assets)).toEqual({ assetIds: [], unresolved: 1 });
  });
});
