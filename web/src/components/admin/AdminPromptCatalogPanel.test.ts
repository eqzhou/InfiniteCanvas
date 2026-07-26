import { describe, expect, test } from "bun:test";
import { syncRunSummary } from "./AdminPromptCatalogPanel";

describe("AdminPromptCatalogPanel", () => {
  test("shows persisted sync status and bounded safe error text", () => {
    expect(syncRunSummary({ sourceId: "source-1", status: "failed", itemCount: 0, error: "prompt source request failed" }))
      .toBe("source-1 · failed · 0 · prompt source request failed");
  });
});
