import { describe, expect, test } from "bun:test";
import { ImageTransformRegistry } from "./registry";
import type { ImageTransformProvider } from "./types";

function provider(id: string): ImageTransformProvider {
  return {
    id,
    label: id,
    kind: "local",
    capabilities: { upscale: true, inpaint: false, mask: false },
    upscale: async () => { throw new Error("unused"); },
  };
}

describe("ImageTransformRegistry", () => {
  test("rejects duplicate providers and filters by capability without exposing mutable storage", () => {
    const registry = new ImageTransformRegistry([provider("a"), provider("b")]);
    expect(registry.forCapability("upscale").map((item) => item.id)).toEqual(["a", "b"]);
    expect(registry.forCapability("inpaint")).toEqual([]);
    expect(() => registry.register(provider("a"))).toThrow("already registered");
  });
});
