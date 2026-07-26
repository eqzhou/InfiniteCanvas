import { describe, expect, test } from "bun:test";
import { filterAdminPrompts, retainVisibleSelection, syncRunSummary } from "./AdminPromptCatalogPanel";

describe("AdminPromptCatalogPanel", () => {
  test("shows persisted sync status and bounded safe error text", () => {
    expect(syncRunSummary({ sourceId: "source-1", status: "failed", itemCount: 0, error: "prompt source request failed" }))
      .toBe("source-1 · failed · 0 · prompt source request failed");
  });

  const prompts = [
    { id: "a", title: "产品摄影", body: "studio light", categoryId: "product", tags: ["studio"] },
    { id: "b", title: "人像特写", body: "portrait closeup", categoryId: "people", tags: ["portrait", "studio"] },
    { id: "c", title: "风景", body: "wide landscape", categoryId: "", tags: [] },
  ];

  test("returns every prompt when no filter is active", () => {
    expect(filterAdminPrompts(prompts, { query: "", categoryId: "", tag: "" }).map((item) => item.id))
      .toEqual(["a", "b", "c"]);
  });

  test("drops selected prompts the active filter hides", () => {
    // Bulk delete submits the selection, so anything the admin can no longer
    // see must not stay selected: it would be deleted unseen.
    expect(retainVisibleSelection(["a", "b"], [{ id: "b" }])).toEqual(["b"]);
    expect(retainVisibleSelection(["a"], [])).toEqual([]);
  });

  test("returns the same selection array when nothing is hidden", () => {
    // Preserving identity keeps the state update a no-op and avoids a re-render loop.
    const selection = ["a", "b"];
    expect(retainVisibleSelection(selection, [{ id: "a" }, { id: "b" }])).toBe(selection);
    const empty: string[] = [];
    expect(retainVisibleSelection(empty, [{ id: "a" }])).toBe(empty);
  });

  test("matches the query against title, body and tags case-insensitively", () => {
    expect(filterAdminPrompts(prompts, { query: "PORTRAIT", categoryId: "", tag: "" }).map((item) => item.id))
      .toEqual(["b"]);
    expect(filterAdminPrompts(prompts, { query: "  风景  ", categoryId: "", tag: "" }).map((item) => item.id))
      .toEqual(["c"]);
    expect(filterAdminPrompts(prompts, { query: "studio", categoryId: "", tag: "" }).map((item) => item.id))
      .toEqual(["a", "b"]);
  });

  test("narrows by category and tag independently and together", () => {
    expect(filterAdminPrompts(prompts, { query: "", categoryId: "product", tag: "" }).map((item) => item.id))
      .toEqual(["a"]);
    expect(filterAdminPrompts(prompts, { query: "", categoryId: "", tag: "studio" }).map((item) => item.id))
      .toEqual(["a", "b"]);
    expect(filterAdminPrompts(prompts, { query: "人像", categoryId: "people", tag: "studio" }).map((item) => item.id))
      .toEqual(["b"]);
    // Uncategorized entries are reachable through the explicit sentinel.
    expect(filterAdminPrompts(prompts, { query: "", categoryId: "__none__", tag: "" }).map((item) => item.id))
      .toEqual(["c"]);
  });

  test("never mutates the input collection", () => {
    const snapshot = JSON.stringify(prompts);
    filterAdminPrompts(prompts, { query: "studio", categoryId: "product", tag: "studio" });
    expect(JSON.stringify(prompts)).toBe(snapshot);
  });
});
