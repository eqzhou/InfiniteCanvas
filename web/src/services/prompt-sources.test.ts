import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchPromptSource, PROMPT_SOURCE_LIMITS } from "./prompt-sources";

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

  test("rejects oversized fields and unsupported response MIME", async () => {
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
      .rejects.toThrow("MIME");
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
});
