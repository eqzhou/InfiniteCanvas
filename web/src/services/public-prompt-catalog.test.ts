import { describe, expect, mock, test } from "bun:test";
import type { PromptItem } from "@/types/board";
import {
  loadPublicPromptCatalog,
  mergePublicPromptCatalog,
  PUBLIC_PROMPT_CATALOG_SOURCE_ID,
} from "@/services/public-prompt-catalog";

const personal: PromptItem = { id: "same", title: "Personal", body: "mine", tags: [], source: "local" };

describe("public prompt catalog", () => {
  test("merges server prompts after personal prompts with stable collision-free ids", () => {
    const merged = mergePublicPromptCatalog([personal], {
      version: 1,
      revision: 4,
      categories: [],
      prompts: [{ id: "same", title: "Shared", body: "team", tags: ["shared"] }],
    });
    expect(merged.map((item) => item.id)).toEqual(["same", "catalog:same"]);
    expect(merged[1]?.sourceId).toBe(PUBLIC_PROMPT_CATALOG_SOURCE_ID);
    expect(mergePublicPromptCatalog(merged, { version: 1, revision: 5, categories: [], prompts: [] })).toEqual([personal]);
  });

  test("revalidates by revision and falls back to tenant-scoped cache on errors", async () => {
    const fetcher = mock(async (_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("If-None-Match")).toBeNull();
      return new Response(JSON.stringify({
        version: 1,
        revision: 7,
        categories: [],
        prompts: [{ id: "shared", title: "Shared", body: "cached", tags: [] }],
      }), { status: 200, headers: { ETag: '"prompt-catalog-7"', "Content-Type": "application/json" } });
    });
    const scope = `tenant-a-${crypto.randomUUID()}`;
    const first = await loadPublicPromptCatalog(scope, fetcher);
    expect(first.catalog.revision).toBe(7);
    expect(first.stale).toBe(false);

    const failing = mock(async (_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("If-None-Match")).toBe('"prompt-catalog-7"');
      throw new Error("offline");
    });
    const fallback = await loadPublicPromptCatalog(scope, failing);
    expect(fallback.catalog.prompts[0]?.body).toBe("cached");
    expect(fallback.stale).toBe(true);
    expect(fallback.error).toContain("offline");

    const otherTenant = await loadPublicPromptCatalog(`tenant-b-${crypto.randomUUID()}`, mock(async () => {
      throw new Error("offline");
    }));
    expect(otherTenant.catalog.prompts).toEqual([]);
  });
});
