import { describe, expect, test } from "vitest";
import { readAICallRequestDetail } from "./ai-call-log-detail";

describe("AI call log request trace", () => {
  test("reads the actual endpoint and indexed reference storage keys", () => {
    expect(readAICallRequestDetail({
      method: "post",
      endpoint: "https://provider.example/v1/images/edits",
      referenceCount: 2,
      referenceImages: [
        { index: 1, storageKey: "image:generated:source-1:one", mimeType: "image/png", bytes: 42 },
        { index: 2, storageKey: "image:generated:source-2:two" },
      ],
    })).toEqual({
      method: "POST",
      endpoint: "https://provider.example/v1/images/edits",
      referenceCount: 2,
      references: [
        { index: 1, storageKey: "image:generated:source-1:one", mimeType: "image/png", bytes: 42, sourceKnown: true },
        { index: 2, storageKey: "image:generated:source-2:two", mimeType: undefined, bytes: undefined, sourceKnown: true },
      ],
    });
  });

  test("keeps legacy reference counts visible without inventing a source", () => {
    expect(readAICallRequestDetail({ referenceCount: 2 })).toEqual({
      referenceCount: 2,
      references: [
        { index: 1, sourceKnown: false },
        { index: 2, sourceKnown: false },
      ],
    });
  });

  test("accepts media references from video audit rows", () => {
    expect(readAICallRequestDetail({
      referenceCount: 1,
      referenceMedia: [{ index: 1, storageKey: "media:reference:clip-1" }],
    }).references[0]).toMatchObject({ index: 1, storageKey: "media:reference:clip-1", sourceKnown: true });
  });

  test("ignores malformed trace values", () => {
    expect(readAICallRequestDetail({ endpoint: 42, method: "", referenceCount: -1, referenceImages: "bad" })).toEqual({
      referenceCount: 0,
      references: [],
    });
  });
});
