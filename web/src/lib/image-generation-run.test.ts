import { describe, expect, test } from "bun:test";
import { createNode, createProject } from "./defaults";
import { placeImageGenerationRun } from "./image-generation-run";

function image(label: string) {
  return createNode("image", { x: 400, y: 100 }, {
    title: label,
    metadata: { content: `data:image/png;base64,${label}`, status: "success", prompt: label },
  });
}

describe("placeImageGenerationRun", () => {
  test("creates independent result roots for repeated config runs", () => {
    const config = createNode("config", { x: 0, y: 0 });
    const project = { ...createProject("Board"), nodes: [config] };
    const first = placeImageGenerationRun(project, { sourceId: config.id, results: [image("first-a"), image("first-b")] });
    const second = placeImageGenerationRun(first, { sourceId: config.id, results: [image("second-a"), image("second-b")] });
    const roots = second.nodes.filter((node) => node.metadata.generationConfigId === config.id && node.metadata.isBatchRoot);

    expect(roots).toHaveLength(2);
    expect(new Set(roots.map((node) => node.metadata.generationRunId)).size).toBe(2);
    expect(second.nodes.find((node) => node.id === config.id)?.metadata.batchChildIds).toBeUndefined();
    expect(roots.every((root) => root.metadata.batchChildIds?.length === 2)).toBe(true);
  });

  test("uses a fresh empty image as its first result without creating a second root", () => {
    const target = createNode("image", { x: 0, y: 0 });
    const project = { ...createProject("Board"), nodes: [target] };
    const next = placeImageGenerationRun(project, {
      sourceId: target.id,
      results: [image("first"), image("second")],
      reuseEmptyImageTarget: true,
    });

    expect(next.nodes.find((node) => node.id === target.id)?.metadata.content).toContain("first");
    expect(next.nodes.find((node) => node.id === target.id)?.metadata.batchChildIds).toHaveLength(2);
    expect(next.edges.filter((edge) => edge.from === target.id)).toHaveLength(2);
  });
});
