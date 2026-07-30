import { describe, expect, test } from "bun:test";
import { createNode, createProject } from "./defaults";
import { applyServerImagePlaceholders } from "./canvas-server-image";
import { createImageGenerationMetadata } from "./image-generation";
import { parseBoardProject } from "./board-document";

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

  test("creates an isolated image run for a config without turning the config into a batch", () => {
    const root = createNode("config", { x: 30, y: 40 });
    const project = { ...createProject("Board"), nodes: [root] };
    const next = applyServerImagePlaceholders(project, root.id, "job-batch", generation);
    const updatedRoot = next.nodes.find((node) => node.id === root.id)!;
    const runRoot = next.nodes.find((node) => node.metadata.generationConfigId === root.id)!;
    const children = next.nodes.filter((node) => node.metadata.batchRootId === runRoot.id);

    expect(runRoot.type).toBe("image");
    expect(runRoot.metadata.generationResultIndex).toBe(0);
    expect(runRoot.metadata.generationRunId).toBeDefined();
    expect(children).toHaveLength(2);
    expect(children.map((node) => node.metadata.generationResultIndex)).toEqual([1, 2]);
    expect(children.every((node) => node.type === "image" && node.metadata.generationJobId === "job-batch")).toBe(true);
    expect(children.every((node) => node.metadata.batchRootId === runRoot.id)).toBe(true);
    expect(updatedRoot.metadata).toMatchObject({
      status: "loading",
      generationJobId: "job-batch",
      generationOutputRootId: runRoot.id,
    });
    expect(updatedRoot.metadata.isBatchRoot).toBeUndefined();
    expect(next.edges.filter((edge) => edge.from === root.id).map((edge) => edge.to)).toEqual([runRoot.id]);
    expect(next.edges.filter((edge) => edge.from === runRoot.id)).toHaveLength(2);
    expect(project).not.toEqual(next);
    expect(root.metadata.batchChildIds).toBeUndefined();
    expect(parseBoardProject(next)).toMatchObject({ id: project.id });
  });

  test("keeps config runs isolated when it is generated twice", () => {
    const root = createNode("config", { x: 30, y: 40 });
    const project = { ...createProject("Board"), nodes: [root] };
    const first = applyServerImagePlaceholders(project, root.id, "job-first", { ...generation, count: 2 });
    const second = applyServerImagePlaceholders(first, root.id, "job-second", { ...generation, count: 2 });
    const runs = second.nodes.filter((node) =>
      node.metadata.generationConfigId === root.id && node.metadata.isBatchRoot,
    );

    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((node) => node.metadata.generationRunId)).size).toBe(2);
    expect(runs.every((node) => Boolean(node.metadata.batchChildIds))).toBe(true);
    expect(second.nodes.find((node) => node.id === root.id)?.metadata.batchChildIds).toBeUndefined();
  });
});
