import { describe, expect, test } from "bun:test";
import { usesServerGenerationJobs } from "./generation-jobs";
import { canMintPublicMediaReferences } from "./media-references";
import { directorModelStore } from "./director-model-store";

describe("database-only runtime storage", () => {
  test("always uses server generation history", () => {
    expect(usesServerGenerationJobs()).toBe(true);
  });

  test("never disables server media references through a browser build flag", () => {
    expect(canMintPublicMediaReferences("https://canvas.example.com")).toBe(true);
  });

  test("loads director GLB bytes from protected server storage", async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      return new Response(new Blob([new Uint8Array(20)], { type: "application/octet-stream" }));
    }) as typeof fetch;
    try {
      const records = await directorModelStore.list("user:tenant:user", "project-a", "director-a", [{
        ownerScope: "user:tenant:user",
        projectId: "project-a",
        directorNodeId: "director-a",
        objectId: "model-a",
        assetId: "asset-a",
        fileName: "character.glb",
        bytes: 20,
      }]);
      expect(records).toHaveLength(1);
      expect(records[0]?.blob.type).toBe("model/gltf-binary");
      expect(requests).toEqual(["/api/blobs/director-model%3Aasset-a"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
