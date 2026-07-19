import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  fetchPromptSource,
  mergePromptSourceItems,
  normalizePromptSourceConfigs,
  PROMPT_SOURCE_LIMITS,
} from "./prompt-sources";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

describe("remote prompt source limits", () => {
  test("refresh replaces matching cached prompts without mutating either input", () => {
    const cached = [{
      id: "cached",
      title: "Title",
      body: "Body",
      tags: ["old"],
      source: "prompts.example",
      sourceId: "catalog",
      coverUrl: "https://cdn.example/old.png",
    }];
    const refreshed = [{
      id: "remote",
      title: "Title",
      body: "Body",
      tags: ["new"],
      source: "prompts.example",
      sourceId: "catalog",
      coverUrl: "https://cdn.example/new.png",
    }];

    const result = mergePromptSourceItems(cached, refreshed, "catalog");

    expect(result).toEqual([{ ...refreshed[0], id: result[0].id }]);
    expect(result[0]).not.toBe(refreshed[0]);
    expect(cached[0].tags).toEqual(["old"]);
    expect(refreshed[0].tags).toEqual(["new"]);
  });

  test("replaces one remote source by stable identity without overwriting local prompts", () => {
    const cached = [
      { id: "local-one", title: "Shared", body: "Same", tags: [], source: "local" },
      { id: "remote-old", title: "Remote", body: "Old", tags: [], source: "Catalog", sourceId: "catalog-one" },
      { id: "other", title: "Other", body: "Keep", tags: [], source: "Other", sourceId: "catalog-two" },
    ];
    const refreshed = [
      { id: "entry-one", title: "Shared", body: "Same", tags: ["remote"], source: "Catalog", sourceId: "catalog-one" },
      { id: "entry-two", title: "Remote", body: "New", tags: [], source: "Catalog", sourceId: "catalog-one" },
    ];

    const merged = mergePromptSourceItems(cached, refreshed, "catalog-one");
    expect(merged.find((item) => item.id === "local-one")?.source).toBe("local");
    expect(merged.some((item) => item.body === "Old")).toBe(false);
    expect(merged.some((item) => item.id === "other")).toBe(true);
    expect(merged.filter((item) => item.sourceId === "catalog-one")).toHaveLength(2);
    expect(new Set(merged.map((item) => item.id)).size).toBe(merged.length);

    const second = mergePromptSourceItems(merged, [{
      id: "entry-two", title: "Remote", body: "Newest", tags: [], source: "Catalog", sourceId: "catalog-one",
    }], "catalog-one");
    expect(second.filter((item) => item.sourceId === "catalog-one")).toHaveLength(1);
    expect(second.find((item) => item.sourceId === "catalog-one")?.body).toBe("Newest");
    expect(second.find((item) => item.sourceId === "catalog-one")?.id)
      .toBe(merged.find((item) => item.body === "New")?.id);
  });

  test("an empty source clears only its tagged items and preserves unowned catalogs", () => {
    const cached = [
      { id: "builtin", title: "Built in", body: "Keep", tags: [], source: "Catalog" },
      { id: "remote", title: "Remote", body: "Remove", tags: [], source: "Catalog", sourceId: "catalog-one" },
      { id: "other", title: "Other", body: "Keep", tags: [], source: "Other", sourceId: "catalog-two" },
    ];

    const merged = mergePromptSourceItems(cached, [], "catalog-one");

    expect(merged.map((item) => item.id)).toEqual(["builtin", "other"]);
    expect(cached.map((item) => item.id)).toEqual(["builtin", "remote", "other"]);
  });

  test("preserves ambiguous unowned legacy prompts during a source refresh", () => {
    const legacy = { id: "legacy", title: "Legacy", body: "Keep", tags: ["old"], source: "prompts.example" };
    const refreshed = {
      id: "remote", title: "Legacy", body: "Updated", tags: [], source: "prompts.example", sourceId: "legacy-1",
    };

    const merged = mergePromptSourceItems([legacy], [refreshed], "legacy-1");

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(legacy);
    expect(merged[0]).not.toHaveProperty("sourceId");
    expect(legacy).not.toHaveProperty("sourceId");
  });

  test("accepts a bounded JSON catalog", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_input, requestInit) => {
      init = requestInit;
      return jsonResponse([
        { id: "one", title: "Title", prompt: "Body", tags: ["tag"] },
      ]);
    }) as typeof fetch;

    const result = await fetchPromptSource("https://prompts.example/catalog.json");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "one", title: "Title", body: "Body" });
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
  });

  test("applies bounded declarative paths to nested JSON catalogs", async () => {
    globalThis.fetch = mock(async () => jsonResponse({
      payload: {
        entries: [{
          slug: "nested-one",
          label: "Nested title",
          value: "Nested body",
          metadata: { tags: ["nested", "custom"] },
          media: { cover: "https://cdn.example/cover.png", results: ["https://cdn.example/result.png"] },
        }],
      },
    })) as typeof fetch;

    const result = await fetchPromptSource({
      id: "nested",
      name: "Nested source",
      url: "https://prompts.example/nested.json",
      format: "json",
      enabled: true,
      refreshMinutes: 0,
      mapping: {
        itemsPath: "payload.entries",
        idPath: "slug",
        titlePath: "label",
        bodyPath: "value",
        tagsPath: "metadata.tags",
        coverUrlPath: "media.cover",
        resultUrlsPath: "media.results",
      },
    });

    expect(result).toEqual([{
      id: "nested-one",
      title: "Nested title",
      body: "Nested body",
      tags: ["nested", "custom"],
      source: "Nested source",
      sourceId: "nested",
      coverUrl: "https://cdn.example/cover.png",
      resultUrls: ["https://cdn.example/result.png"],
    }]);
  });

  test("rejects executable and unsafe declarative source fields", () => {
    const normalized = normalizePromptSourceConfigs([
      {
        id: "scripted",
        name: "Scripted",
        url: "https://prompts.example/source.json",
        format: "script",
        script: "return fetch(url)",
      },
      {
        id: "prototype",
        name: "Prototype",
        url: "https://prompts.example/source.json",
        format: "json",
        mapping: { bodyPath: "__proto__.polluted" },
      },
    ]);

    expect(normalized).toEqual([]);
  });

  test("preserves the first bounded sources when persisted input exceeds the limit", () => {
    const normalized = normalizePromptSourceConfigs(Array.from(
      { length: PROMPT_SOURCE_LIMITS.maxSources + 1 },
      (_, index) => ({
        id: `source-${index}`,
        name: `Source ${index}`,
        url: `https://source-${index}.example/catalog.json`,
        format: "json",
        enabled: true,
        refreshMinutes: 0,
      }),
    ));

    expect(normalized).toHaveLength(PROMPT_SOURCE_LIMITS.maxSources);
    expect(normalized[0]?.id).toBe("source-0");
    expect(normalized.at(-1)?.id).toBe(`source-${PROMPT_SOURCE_LIMITS.maxSources - 1}`);
  });

  test("rejects excessive entries instead of silently truncating", async () => {
    globalThis.fetch = mock(async () => jsonResponse(
      Array.from({ length: PROMPT_SOURCE_LIMITS.maxItems + 1 }, (_, index) => ({
        title: `T${index}`,
        prompt: "Body",
      })),
    )) as typeof fetch;

    await expect(fetchPromptSource("https://prompts.example/catalog.json"))
      .rejects.toThrow("entries");
  });

  test("rejects oversized fields and HTML without a declarative mapping", async () => {
    globalThis.fetch = mock(async () => jsonResponse([{
      title: "x".repeat(PROMPT_SOURCE_LIMITS.maxTitleChars + 1),
      prompt: "Body",
    }])) as typeof fetch;
    await expect(fetchPromptSource("https://prompts.example/catalog.json"))
      .rejects.toThrow("title");

    globalThis.fetch = mock(async () => new Response("<html></html>", {
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
    await expect(fetchPromptSource("https://prompts.example/catalog.json"))
      .rejects.toThrow("mapping");
  });

  test("rejects excessive tag counts and tag field sizes", async () => {
    globalThis.fetch = mock(async () => jsonResponse([{
      title: "Title",
      prompt: "Body",
      tags: Array.from({ length: PROMPT_SOURCE_LIMITS.maxTags + 1 }, () => "tag"),
    }])) as typeof fetch;
    await expect(fetchPromptSource("https://prompts.example/catalog.json"))
      .rejects.toThrow("tags");

    globalThis.fetch = mock(async () => jsonResponse([{
      title: "Title",
      prompt: "Body",
      tags: ["x".repeat(PROMPT_SOURCE_LIMITS.maxTagChars + 1)],
    }])) as typeof fetch;
    await expect(fetchPromptSource("https://prompts.example/catalog.json"))
      .rejects.toThrow("tag");
  });

  test("rejects private sources and unsafe cover URLs", async () => {
    await expect(fetchPromptSource("https://127.0.0.1/catalog.json")).rejects.toThrow("private");
    globalThis.fetch = mock(async () => jsonResponse([{
      title: "Title",
      prompt: "Body",
      coverUrl: "http://covers.example/image.png",
    }])) as typeof fetch;
    await expect(fetchPromptSource("https://prompts.example/catalog.json")).rejects.toThrow("HTTPS");
  });

  test("normalizes a bounded result image gallery", async () => {
    globalThis.fetch = mock(async () => jsonResponse([{
      title: "Title",
      prompt: "Body",
      images: ["https://cdn.example/one.png", "https://cdn.example/two.png"],
    }])) as typeof fetch;
    const [item] = await fetchPromptSource("https://prompts.example/catalog.json");
    expect(item.resultUrls).toEqual([
      "https://cdn.example/one.png",
      "https://cdn.example/two.png",
    ]);

    globalThis.fetch = mock(async () => jsonResponse([{
      title: "Title",
      prompt: "Body",
      images: Array.from(
        { length: PROMPT_SOURCE_LIMITS.maxResultUrls + 1 },
        (_, index) => `https://cdn.example/${index}.png`,
      ),
    }])) as typeof fetch;
    await expect(fetchPromptSource("https://prompts.example/catalog.json"))
      .rejects.toThrow("result images");
  });
});
