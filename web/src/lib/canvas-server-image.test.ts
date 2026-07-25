import { describe, expect, test } from "bun:test";
import { createNode, createProject } from "./defaults";
import { applyServerImagePlaceholders } from "./canvas-server-image";
import { createImageGenerationMetadata } from "./image-generation";

const generation = createImageGenerationMetadata({
  prompt: "durable image",
  model: "gemini-image",
  size: "1024x1024",
  quality: "auto",
  count: 3,
  transparentBackground: false,
  referenceStorageKeys: ["image:reference"],
});

describe("canvas server image placeholders", () => {
  test("uses an empty single image node as its own durable target", () => {
    const root = createNode("image", { x: 10, y: 20 });
    const project = { ...createProject("Board"), nodes: [root] };
    const next = applyServerImagePlaceholders(project, root.id, "job-image", { ...generation, count: 1 });

    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.metadata).toMatchObject({
      status: "loading",
      generationJobId: "job-image",
      generationResultIndex: 0,
      prompt: "durable image",
    });
    expect(project.nodes[0]?.metadata.generationJobId).toBeUndefined();
  });

  test("creates indexed batch children without mutating a config root", () => {
    const root = createNode("config", { x: 30, y: 40 });
    const project = { ...createProject("Board"), nodes: [root] };
    const next = applyServerImagePlaceholders(project, root.id, "job-batch", generation);
    const updatedRoot = next.nodes.find((node) => node.id === root.id)!;
    const children = next.nodes.filter((node) => node.id !== root.id);

    expect(children).toHaveLength(3);
    expect(children.map((node) => node.metadata.generationResultIndex)).toEqual([0, 1, 2]);
    expect(children.every((node) => node.type === "image" && node.metadata.generationJobId === "job-batch")).toBe(true);
    expect(children.every((node) => node.metadata.batchRootId === root.id)).toBe(true);
    expect(updatedRoot.metadata).toMatchObject({
      status: "loading",
      generationJobId: "job-batch",
      isBatchRoot: true,
      batchChildIds: children.map((node) => node.id),
    });
    expect(next.edges.filter((edge) => edge.from === root.id)).toHaveLength(3);
    expect(project).not.toEqual(next);
    expect(root.metadata.batchChildIds).toBeUndefined();
  });
});
