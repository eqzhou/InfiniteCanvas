import { describe, expect, test } from "bun:test";
import {
  IMAGE_GENERATION_MAX_COUNT,
  firstSucceededGenerationJob,
  imageGenerationBatchCount,
  imageGenerationSlotParameters,
  workbenchImageCountFromParameters,
} from "./image-generation-batch";

describe("image generation batch fan-out", () => {
  test("treats each requested image as its own n=1 slot", () => {
    const slots = [0, 1, 2, 3].map((index) =>
      imageGenerationSlotParameters(
        { size: "1024x1024", quality: "auto", count: 4, category: "角色" },
        index,
        4,
        "batch_test",
      ),
    );

    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.count)).toEqual([1, 1, 1, 1]);
    expect(slots.map((slot) => slot.batchIndex)).toEqual([1, 2, 3, 4]);
    expect(new Set(slots.map((slot) => slot.batchId))).toEqual(new Set(["batch_test"]));
    expect(slots[0]?.requestedCount).toBe(4);
    expect(slots[0]?.size).toBe("1024x1024");
  });

  test("does not invent a batch id for a single image", () => {
    expect(imageGenerationSlotParameters({ count: 1 }, 0, 1, "batch_unused")).toEqual({
      count: 1,
      requestedCount: 1,
      batchId: "",
      batchIndex: 0,
    });
  });

  test("lifts the old 4/8 model cap to the operational ceiling", () => {
    expect(imageGenerationBatchCount(4)).toBe(4);
    expect(imageGenerationBatchCount(20)).toBe(20);
    expect(imageGenerationBatchCount(IMAGE_GENERATION_MAX_COUNT + 1)).toBe(IMAGE_GENERATION_MAX_COUNT);
    expect(imageGenerationBatchCount(0)).toBe(1);
    expect(imageGenerationBatchCount("nope")).toBe(1);
  });

  test("adopts only the first succeeded film slot", () => {
    expect(firstSucceededGenerationJob([
      { status: "failed" },
      { status: "succeeded", id: "job-a" },
      { status: "succeeded", id: "job-b" },
    ])).toEqual({ status: "succeeded", id: "job-a" });
    expect(firstSucceededGenerationJob([{ status: "failed" }, { status: "cancelled" }])).toBeUndefined();
  });

  test("restores the original requested count from a split history card", () => {
    expect(workbenchImageCountFromParameters({ count: 1, requestedCount: 4 }, 2)).toBe(4);
    expect(workbenchImageCountFromParameters({ count: 3 }, 2)).toBe(3);
    expect(workbenchImageCountFromParameters({}, 2)).toBe(2);
  });
});
