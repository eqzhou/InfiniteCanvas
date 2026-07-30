import { describe, expect, test } from "bun:test";
import { batchResultCount } from "./BatchGroupControls";

describe("batch result count", () => {
  test("does not count a generated preview root as an extra result", () => {
    expect(batchResultCount({
      content: "blob:preview",
      generationRunId: "run-1",
      batchChildIds: ["one", "two"],
    }, 2)).toBe(2);
  });

  test("keeps legacy roots that are actual results in the count", () => {
    expect(batchResultCount({
      content: "blob:root-result",
      batchChildIds: ["two"],
    }, 1)).toBe(2);
  });
});
