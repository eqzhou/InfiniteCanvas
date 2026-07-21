import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  fetchPromptSource,
  mergePromptSourceItems,
  normalizePromptSourceConfigs,
  PROMPT_SOURCE_LIMITS,
} from "./prompt-sources";
import {
  clonePresetSource,
  COMMUNITY_PROMPT_SOURCE_PRESETS,
} from "./prompt-source-presets";

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

  test("accepts script sources while rejecting unsafe declarative paths", () => {
    const normalized = normalizePromptSourceConfigs([
      {
        id: "scripted",
        name: "Scripted",
        url: "https://prompts.example/source.json",
        format: "script",
        script: "return helpers.parseJson(text)",
        enabled: true,
        refreshMinutes: 0,
      },
      {
        id: "script-missing",
        name: "Missing script",
        url: "https://prompts.example/source.json",
        format: "script",
      },
      {
        id: "prototype",
        name: "Prototype",
        url: "https://prompts.example/source.json",
        format: "json",
        mapping: { bodyPath: "__proto__.polluted" },
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      id: "scripted",
      format: "script",
      script: "return helpers.parseJson(text)",
    });
  });

  test("executes a local script transform against fetched source text", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      payload: {
        rows: [
          { slug: "a", label: "Alpha", value: "first prompt", marks: ["x"] },
          { slug: "b", label: "Beta", value: "second prompt" },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    const items = await fetchPromptSource({
      id: "scripted",
      name: "Scripted catalog",
      url: "https://prompts.example/custom.json",
      format: "script",
      enabled: true,
      refreshMinutes: 0,
      script: `
        const data = helpers.parseJson(text);
        return data.payload.rows.map((row) => ({
          id: row.slug,
          title: row.label,
          body: row.value,
          tags: row.marks ?? [],
        }));
      `,
    });

    expect(items).toEqual([
      {
        id: "a",
        title: "Alpha",
        body: "first prompt",
        tags: ["x"],
        source: "Scripted catalog",
        sourceId: "scripted",
      },
      {
        id: "b",
        title: "Beta",
        body: "second prompt",
        tags: [],
        source: "Scripted catalog",
        sourceId: "scripted",
      },
    ]);
  });

  test("keeps script bodies with template literals intact", async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify([
      { title: "T", prompt: "body" },
    ]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    const items = await fetchPromptSource({
      id: "tpl",
      name: "Template script",
      url: "https://prompts.example/custom.json",
      format: "script",
      enabled: true,
      refreshMinutes: 0,
      script: "const data = helpers.parseJson(text);\nconst prefix = `id:${data[0].title}`;\nreturn data.map((item) => ({ id: prefix, title: item.title, body: item.prompt }));",
    });

    expect(items).toEqual([{
      id: "id:T",
      title: "T",
      body: "body",
      tags: [],
      source: "Template script",
      sourceId: "tpl",
    }]);
  });

  test("rejects empty or invalid script bodies", async () => {
    globalThis.fetch = mock(async () => new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

    await expect(fetchPromptSource({
      id: "bad-script",
      name: "Bad script",
      url: "https://prompts.example/custom.json",
      format: "script",
      enabled: true,
      refreshMinutes: 0,
      script: "return 42",
    })).rejects.toThrow("array of prompt items");
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

  test("rejects private sources and soft-skips unsafe cover/result URLs", async () => {
    await expect(fetchPromptSource("https://127.0.0.1/catalog.json")).rejects.toThrow("private");
    globalThis.fetch = mock(async () => jsonResponse([{
      title: "Title",
      prompt: "Body",
      coverUrl: "http://covers.example/image.png",
      images: [
        "http://insecure.example/result.png",
        "https://cdn.example/result.png",
        "https://127.0.0.1/private.png",
      ],
    }])) as typeof fetch;
    const [item] = await fetchPromptSource("https://prompts.example/catalog.json");
    expect(item).toMatchObject({
      title: "Title",
      body: "Body",
      resultUrls: ["https://cdn.example/result.png"],
    });
    expect(item.coverUrl).toBeUndefined();
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


describe("community prompt source presets", () => {
  test("exposes Image Prompts registry presets including Banana Prompt Quicker", () => {
    expect(COMMUNITY_PROMPT_SOURCE_PRESETS.length).toBeGreaterThanOrEqual(6);
    const banana = COMMUNITY_PROMPT_SOURCE_PRESETS.find((item) => item.id === "banana-prompt-quicker");
    expect(banana).toBeDefined();
    expect(banana!.source.url).toContain("yukkcat/image-prompts");
    expect(banana!.source.format).toBe("json");
    for (const preset of COMMUNITY_PROMPT_SOURCE_PRESETS) {
      const source = clonePresetSource(preset);
      expect(source.id).toBe(preset.id);
      expect(source.url.startsWith("https://")).toBe(true);
      expect(source.format).toBe("json");
      expect(source.builtIn).toBe(true);
      expect(source.mapping?.bodyPath).toBe("prompt");
      // Preset clones must be independent of the catalog table.
      source.name = "mutated";
      expect(preset.source.name).not.toBe("mutated");
    }
  });
});

describe("structured community markdown catalogs", () => {
  test("parses labeled and fenced community markdown prompt blocks", async () => {
    const markdown = `# Catalog

## 摄影

### 夜景街拍
<img src="https://cdn.example/cover.png" />

**提示词:**
\`\`\`text
rainy neon street at midnight, cinematic still
\`\`\`
**来源:** @demo

### 第二段没有提示词
只是说明文字

## 插画

### 扁平海报
- **提示词文本：** \`flat vector poster, bold shapes, limited palette\`

### No. 3: VR 爆炸图
#### 提示词
\`\`\`
exploded view of a VR headset with callouts
\`\`\`
![result](https://cdn.example/result-one.png)
![result two](https://cdn.example/result-two.png)
`;
    globalThis.fetch = mock(async () => new Response(markdown, {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    })) as typeof fetch;

    const result = await fetchPromptSource({
      id: "community-md",
      name: "Community MD",
      url: "https://prompts.example/catalog.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    });

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      title: "夜景街拍",
      body: "rainy neon street at midnight, cinematic still",
      tags: ["摄影"],
      coverUrl: "https://cdn.example/cover.png",
      source: "Community MD",
      sourceId: "community-md",
    });
    expect(result[1]).toMatchObject({
      title: "扁平海报",
      body: "flat vector poster, bold shapes, limited palette",
      tags: ["插画"],
    });
    expect(result[2]).toMatchObject({
      title: "VR 爆炸图",
      body: "exploded view of a VR headset with callouts",
      coverUrl: "https://cdn.example/result-one.png",
      resultUrls: ["https://cdn.example/result-two.png"],
    });
  });

  test("keeps plain markdown heading fallback for simple catalogs", async () => {
    const markdown = `# Notes
## First
plain body one

## Second
plain body two
`;
    globalThis.fetch = mock(async () => new Response(markdown, {
      headers: { "content-type": "text/markdown" },
    })) as typeof fetch;
    const result = await fetchPromptSource({
      id: "plain-md",
      name: "Plain",
      url: "https://prompts.example/plain.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    });
    expect(result.map((item) => item.title)).toEqual(["First", "Second"]);
    expect(result[0]?.body).toContain("plain body one");
  });

  test("ignores bare fenced code without an explicit prompt label", async () => {
    const markdown = [
      '# Catalog',
      '',
      '## 工具',
      '',
      '### 安装说明',
      '```bash',
      'npm install example',
      '```',
      '',
      '### 真实提示词',
      '**提示词:**',
      '```text',
      'actual prompt body',
      '```',
      ''
    ].join("\n");
    globalThis.fetch = mock(async () => new Response(markdown, {
      headers: { "content-type": "text/markdown" },
    })) as typeof fetch;
    const result = await fetchPromptSource({
      id: "label-only",
      name: "Label only",
      url: "https://prompts.example/labels.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "真实提示词",
      body: "actual prompt body",
      tags: ["工具"],
    });
  });

  test("skips invalid markdown images without rejecting the prompt body", async () => {
    const markdown = [
      "# Catalog",
      "",
      "## 摄影",
      "",
      "### 有坏图",
      "![bad](http://insecure.example/cover.png)",
      "![good](https://cdn.example/cover.png)",
      "**提示词:**",
      "```text",
      "prompt with mixed images",
      "```",
      "",
    ].join("\n");
    globalThis.fetch = mock(async () => new Response(markdown, {
      headers: { "content-type": "text/markdown" },
    })) as typeof fetch;
    const result = await fetchPromptSource({
      id: "mixed-images",
      name: "Mixed",
      url: "https://prompts.example/mixed.md",
      format: "markdown",
      enabled: true,
      refreshMinutes: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "有坏图",
      body: "prompt with mixed images",
      coverUrl: "https://cdn.example/cover.png",
    });
  });

  test("maps bilingual JSON catalogs used by community prompt packs", async () => {
    globalThis.fetch = mock(async () => jsonResponse([
      {
        id: 7,
        title_en: "English title",
        title_cn: "中文标题",
        category_cn: "海报设计",
        prompt: "a clean poster layout with bold type",
      },
    ])) as typeof fetch;

    const result = await fetchPromptSource({
      id: "bilingual-json",
      name: "Bilingual",
      url: "https://prompts.example/prompts.json",
      format: "json",
      enabled: true,
      refreshMinutes: 0,
      mapping: {
        idPath: "id",
        titlePath: "title_cn",
        bodyPath: "prompt",
        tagsPath: "category_cn",
      },
    });

    expect(result).toEqual([{
      id: "7",
      title: "中文标题",
      body: "a clean poster layout with bold type",
      tags: ["海报设计"],
      source: "Bilingual",
      sourceId: "bilingual-json",
    }]);
  });
});

describe("image prompts unified JSON", () => {
  test("maps referenceImageUrls as result gallery by default", async () => {
    globalThis.fetch = mock(async () => jsonResponse([
      {
        id: "banana-prompt-quicker:demo",
        title: "苹果风格海报",
        prompt: "apple style poster",
        coverUrl: "https://cdn.example/apple.png",
        referenceImageUrls: ["https://cdn.example/ref1.jpg"],
        tags: ["工作", "海报"],
      },
    ])) as typeof fetch;

    const result = await fetchPromptSource({
      id: "banana-prompt-quicker",
      name: "Banana Prompt Quicker",
      url: "https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/banana-prompt-quicker.json",
      format: "json",
      enabled: true,
      refreshMinutes: 0,
      mapping: {
        idPath: "id",
        titlePath: "title",
        bodyPath: "prompt",
        tagsPath: "tags",
        coverUrlPath: "coverUrl",
        resultUrlsPath: "referenceImageUrls",
      },
    });

    expect(result).toEqual([{
      id: "banana-prompt-quicker:demo",
      title: "苹果风格海报",
      body: "apple style poster",
      tags: ["工作", "海报"],
      source: "Banana Prompt Quicker",
      sourceId: "banana-prompt-quicker",
      coverUrl: "https://cdn.example/apple.png",
      resultUrls: ["https://cdn.example/ref1.jpg"],
    }]);
  });
});
