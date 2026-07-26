import { afterEach, describe, expect, test } from "bun:test";
import type { BoardNode } from "@/types/board";
import { resolveNodeImageTransformSource } from "./source";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("image transform source", () => {
  test("decodes data URLs locally without entering the browser fetch pipeline", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      throw new Error("data URLs must not use fetch");
    }) as typeof fetch;
    const node = {
      id: "image-1",
      type: "image",
      title: "Image",
      position: { x: 0, y: 0 },
      width: 4,
      height: 4,
      metadata: {
        content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        naturalWidth: 1,
        naturalHeight: 1,
      },
    } satisfies BoardNode;

    const source = await resolveNodeImageTransformSource(node);

    expect(requests).toBe(0);
    expect(source.blob.type).toBe("image/png");
    expect(source.blob.size).toBeGreaterThan(0);
    expect({ width: source.width, height: source.height }).toEqual({ width: 1, height: 1 });
  });
});
