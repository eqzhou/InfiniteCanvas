import { describe, expect, test } from "bun:test";

import { readBoundedProviderJson, readBoundedProviderText } from "./bounded-provider-json";

describe("bounded provider responses", () => {
  test("reads bounded JSON and rejects declared or streamed overflow", async () => {
    await expect(readBoundedProviderJson(new Response('{"ok":true}'), 64)).resolves.toEqual({ ok: true });
    await expect(readBoundedProviderJson(new Response("{}", {
      headers: { "Content-Length": "1000" },
    }), 64)).rejects.toThrow(/too large/);
    await expect(readBoundedProviderJson(new Response("x".repeat(100)), 64)).rejects.toThrow(/too large/);
  });

  test("bounds provider error text without requiring a MIME type", async () => {
    await expect(readBoundedProviderText(new Response("detail"), 16)).resolves.toBe("detail");
    await expect(readBoundedProviderText(new Response("x".repeat(20)), 16)).rejects.toThrow(/too large/);
  });
});
