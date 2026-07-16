import { describe, expect, test } from "bun:test";
import { createTransformLineage } from "./lineage";

describe("transform lineage", () => {
  test("captures reproducible provider metadata without mutating parameters", () => {
    const parameters = { scale: 2 };
    const lineage = createTransformLineage("source", "upscale", {
      blob: new Blob(), provider: "cloud", model: "model", requestId: "request-1",
    }, parameters);
    expect(lineage).toEqual({
      derivedFromId: "source",
      transformOperation: "upscale",
      transformProvider: "cloud",
      transformModel: "model",
      transformRequestId: "request-1",
      transformParameters: { scale: 2 },
    });
    expect(lineage.transformParameters).not.toBe(parameters);
  });
});
