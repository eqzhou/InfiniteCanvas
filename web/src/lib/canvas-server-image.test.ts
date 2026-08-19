import { describe, expect, test } from "bun:test";
import { createNode, createProject } from "./defaults";
import {
  applyServerImagePlaceholders,
  canvasGenerationJobIds,
  canvasInFlightGenerationJobIds,
  nodeReferencesGenerationJob,
  submitServerImageGeneration,
} from "./canvas-server-image";
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
  test("does not expose recoverable placeholders until the server accepts the job", async () => {
    const events: string[] = [];
    await expect(submitServerImageGeneration({
      createJob: async () => {
        events.push("create");
        throw new Error("submission failed");
      },
      applyPlaceholders: () => events.push("placeholders"),
      persist: async () => events.push("persist"),
      cancelJob: async () => events.push("cancel"),
    })).rejects.toThrow("submission failed");

    expect(events).toEqual(["create"]);
  });

  test("persists placeholders only after job creation succeeds", async () => {
    const events: string[] = [];
    await submitServerImageGeneration({
      createJob: async () => { events.push("create"); },
      applyPlaceholders: () => events.push("placeholders"),
      persist: async () => events.push("persist"),
      cancelJob: async () => events.push("cancel"),
    });

    expect(events).toEqual(["create", "placeholders", "persist"]);
  });

  test("keeps an accepted job trackable when canvas persistence is temporarily unavailable", async () => {
    const events: string[] = [];
    const job = await submitServerImageGeneration({
      createJob: async () => { events.push("create"); return { id: "job-real" }; },
      applyPlaceholders: () => events.push("placeholders"),
      persist: async () => { events.push("persist"); throw new Error("save unavailable"); },
      cancelJob: async () => events.push("cancel"),
      onPersistError: () => events.push("persist-error"),
    });

    expect(job).toEqual({ id: "job-real" });
    expect(events).toEqual(["create", "placeholders", "persist", "persist-error"]);
  });

  test("does not hide an accepted job when persistence diagnostics fail", async () => {
    const job = await submitServerImageGeneration({
      createJob: async () => ({ id: "job-real" }),
      applyPlaceholders: () => undefined,
      persist: async () => { throw new Error("save unavailable"); },
      cancelJob: async () => undefined,
      onPersistError: () => { throw new Error("logger unavailable"); },
    });

    expect(job).toEqual({ id: "job-real" });
  });

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
    expect(runRoot.metadata.generationResultIndex).toBeUndefined();
    expect(runRoot.metadata.generationRunId).toBeDefined();
    expect(children).toHaveLength(3);
    expect(children.map((node) => node.metadata.generationResultIndex)).toEqual([0, 1, 2]);
    expect(children.every((node) => node.type === "image" && node.metadata.generationJobId === "job-batch")).toBe(true);
    expect(children.every((node) => node.metadata.batchRootId === runRoot.id)).toBe(true);
    expect(updatedRoot.metadata).toMatchObject({
      status: "loading",
      generationJobId: "job-batch",
      generationOutputRootId: runRoot.id,
    });
    expect(updatedRoot.metadata.isBatchRoot).toBeUndefined();
    expect(next.edges.filter((edge) => edge.from === root.id).map((edge) => edge.to)).toEqual([runRoot.id]);
    expect(next.edges.filter((edge) => edge.from === runRoot.id)).toHaveLength(3);
    expect(project).not.toEqual(next);
    expect(root.metadata.batchChildIds).toBeUndefined();
    expect(parseBoardProject(next)).toMatchObject({ id: project.id });
  });

  test("rejects a job-id list that does not match the requested count", () => {
    const root = createNode("config", { x: 30, y: 40 });
    const project = { ...createProject("Board"), nodes: [root] };
    expect(() => applyServerImagePlaceholders(project, root.id, ["job-a", "job-b"], generation)).toThrow(
      /jobs do not match the requested count/i,
    );
  });

  test("binds each batch slot to its own n=1 job", () => {
    const root = createNode("config", { x: 30, y: 40 });
    const project = { ...createProject("Board"), nodes: [root] };
    const next = applyServerImagePlaceholders(project, root.id, ["job-a", "job-b", "job-c"], generation);
    const runRoot = next.nodes.find((node) => node.metadata.generationConfigId === root.id)!;
    const children = next.nodes.filter((node) => node.metadata.batchRootId === runRoot.id);

    expect(children.map((node) => node.metadata.generationJobId)).toEqual(["job-a", "job-b", "job-c"]);
    expect(children.every((node) => node.metadata.generationResultIndex === 0)).toBe(true);
    expect(canvasGenerationJobIds(next, root.id)).toEqual(["job-a", "job-b", "job-c"]);
    expect(canvasInFlightGenerationJobIds(next, root.id)).toEqual(["job-a", "job-b", "job-c"]);
  });

  test("tracks in-flight jobs from an image source that created a batch", () => {
    const root = createNode("image", { x: 10, y: 20 }, { metadata: { content: "data:image/png;base64,aa" } });
    const project = { ...createProject("Board"), nodes: [root] };
    const next = applyServerImagePlaceholders(project, root.id, ["job-a", "job-b", "job-c"], generation);
    const updatedRoot = next.nodes.find((node) => node.id === root.id)!;

    expect(updatedRoot.metadata.status).not.toBe("loading");
    expect(updatedRoot.metadata.generationOutputRootId).toBeDefined();
    expect(canvasGenerationJobIds(next, root.id)).toEqual(["job-a", "job-b", "job-c"]);
    expect(canvasInFlightGenerationJobIds(next, root.id)).toEqual(["job-a", "job-b", "job-c"]);
  });

  test("treats panorama generationJobIds on a loading root as in-flight", () => {
    const root = createNode("panorama", { x: 10, y: 20 }, {
      metadata: {
        status: "loading",
        generationJobId: "job-a",
        generationJobIds: ["job-a", "job-b"],
      },
    });
    const project = { ...createProject("Board"), nodes: [root] };
    expect(canvasGenerationJobIds(project, root.id)).toEqual(["job-a", "job-b"]);
    expect(canvasInFlightGenerationJobIds(project, root.id)).toEqual(["job-a", "job-b"]);
    expect(nodeReferencesGenerationJob(root.metadata, ["job-b"])).toBe(true);
    expect(nodeReferencesGenerationJob({ generationJobIds: ["job-b"] }, ["job-b"])).toBe(true);
    expect(nodeReferencesGenerationJob({ generationJobId: "job-a" }, ["job-b"])).toBe(false);
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
