import { describe, expect, test } from "bun:test";
import { createNode, createProject } from "./defaults";
import { assertBundlePanoramaMediaManaged, assertPlainProjectImportSafe } from "./plain-project-import";

describe("plain JSON project import", () => {
  test("allows empty panorama drafts but requires bundles for panorama media", () => {
    const project = createProject("Import");
    const draft = { ...project, nodes: [createNode("panorama", { x: 0, y: 0 })] };
    expect(assertPlainProjectImportSafe(draft)).toBe(draft);

    const embedded = {
      ...project,
      nodes: [createNode("panorama", { x: 0, y: 0 }, { metadata: {
        content: "data:image/png;base64,AAAA",
        storageKey: "image:untrusted",
        naturalWidth: 2048,
        naturalHeight: 1024,
      } })],
    };
    expect(() => assertPlainProjectImportSafe(embedded)).toThrow(".openboard");
  });

  test("requires bundle panorama content to have a manifest-backed storage key", () => {
    const project = createProject("Bundle");
    const inline = { ...project, nodes: [createNode("panorama", { x: 0, y: 0 }, { metadata: {
      content: "data:image/png;base64,AAAA",
      naturalWidth: 2048,
      naturalHeight: 1024,
    } })] };
    expect(() => assertBundlePanoramaMediaManaged(inline)).toThrow("manifest");

    const managed = {
      ...inline,
      nodes: inline.nodes.map((node) => ({
        ...node,
        metadata: { ...node.metadata, storageKey: "image:panorama" },
      })),
    };
    expect(assertBundlePanoramaMediaManaged(managed)).toBe(managed);
  });
});
