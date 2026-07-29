import { describe, expect, test } from "bun:test";
import { createDefaultChannel } from "@/lib/defaults";
import { generateTextBatch } from "@/services/text-batch";

describe("configuration-node text batches", () => {
  test("generates the requested number of ordered text results", async () => {
    const channel = createDefaultChannel();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ output_text: `result-${calls}` }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await expect(generateTextBatch({
        channel,
        model: "batch-text-model",
        prompt: "three alternatives",
        images: [],
        count: 3,
      })).resolves.toEqual(["result-1", "result-2", "result-3"]);
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects counts outside the configuration-node range before requests", async () => {
    const channel = createDefaultChannel();
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response();
    }) as typeof fetch;

    try {
      await expect(generateTextBatch({
        channel,
        model: "batch-text-model",
        prompt: "invalid batch",
        count: 0,
      })).rejects.toThrow("1-8");
      await expect(generateTextBatch({
        channel,
        model: "batch-text-model",
        prompt: "invalid batch",
        count: 9,
      })).rejects.toThrow("1-8");
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("limits one batch to two concurrent text requests", async () => {
    const channel = createDefaultChannel();
    const originalFetch = globalThis.fetch;
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    globalThis.fetch = (async () => {
      const call = ++calls;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(JSON.stringify({ output_text: `result-${call}` }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await expect(generateTextBatch({
        channel,
        model: "batch-text-model",
        prompt: "eight alternatives",
        count: 8,
      })).resolves.toHaveLength(8);
      expect(maximumActive).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
