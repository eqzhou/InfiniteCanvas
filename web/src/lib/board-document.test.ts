import { describe, expect, test } from "bun:test";

import { parseBoardProject } from "./board-document";
import { createNode, createProject } from "./defaults";
import { createDefaultDirectorScene } from "./director-scene";

const validProject = () => ({
  id: "project_1",
  title: "Imported board",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
  nodes: [
    {
      id: "node_1",
      type: "text",
      title: "Text",
      position: { x: 10, y: 20 },
      width: 320,
      height: 180,
      metadata: { content: "hello" },
    },
  ],
  edges: [],
  chatSessions: [],
  activeChatId: null,
  backgroundMode: "dots",
  viewport: { x: 0, y: 0, k: 1 },
});

describe("parseBoardProject", () => {
  test("accepts a complete valid document without mutating it", () => {
    const input = validProject();
    const parsed = parseBoardProject(input);
    expect(parsed).toEqual({ ...input, schemaVersion: 2 });
    expect("schemaVersion" in input).toBe(false);
  });

  test("accepts schema v2 and rejects unknown future schemas", () => {
    const current = { ...validProject(), schemaVersion: 2 };
    expect(parseBoardProject(current)).toEqual(current);
    expect(() => parseBoardProject({ ...current, schemaVersion: 3 })).toThrow(
      "schemaVersion",
    );
  });

  test("rejects non-finite geometry", () => {
    const input = validProject();
    input.nodes[0]!.position.x = Number.NaN;
    expect(() => parseBoardProject(input)).toThrow("position.x");
  });

  test("validates video generation metadata at the import boundary", () => {
    const withMetadata = (metadata: Record<string, unknown>) => ({
      ...validProject(),
      nodes: [{
        ...validProject().nodes[0]!,
        type: "config",
        metadata: { generationMode: "video", ...metadata },
      }],
    });
    const valid = withMetadata({
      duration: 8,
      smartDuration: false,
      videoRatio: "21:9",
      resolution: "1080p",
      generateAudio: true,
      watermark: false,
      videoFrameMode: "first-last",
    });
    expect(parseBoardProject(valid).nodes[0]?.metadata.generateAudio).toBe(true);
    expect(parseBoardProject(valid).nodes[0]?.metadata.videoFrameMode).toBe("first-last");

    for (const [metadata, field] of [
      [{ generationMode: "script" }, "generationMode"],
      [{ duration: 16 }, "duration"],
      [{ videoRatio: "2:1" }, "videoRatio"],
      [{ resolution: "4k" }, "resolution"],
      [{ generateAudio: "yes" }, "generateAudio"],
      [{ watermark: 1 }, "watermark"],
      [{ videoFrameMode: "middle" }, "videoFrameMode"],
    ] as const) {
      expect(() => parseBoardProject(withMetadata(metadata))).toThrow(field);
    }
  });

  test("validates durable batch result indexes at the import boundary", () => {
    const input = validProject();
    input.nodes[0]!.type = "image";
    input.nodes[0]!.metadata = { status: "loading", generationJobId: "job_image", generationResultIndex: 7 };
    expect(parseBoardProject(input).nodes[0]?.metadata.generationResultIndex).toBe(7);
    for (const value of [-1, 8, 1.5, "1"]) {
      input.nodes[0]!.metadata.generationResultIndex = value;
      expect(() => parseBoardProject(input)).toThrow("generationResultIndex");
    }
  });

  test("rejects duplicate node ids", () => {
    const input = validProject();
    input.nodes.push({ ...input.nodes[0]! });
    expect(() => parseBoardProject(input)).toThrow("duplicate node id");
  });

  test("rejects edges whose endpoints do not exist", () => {
    const input = validProject();
    input.edges.push({ id: "edge_1", from: "node_1", to: "missing" });
    expect(() => parseBoardProject(input)).toThrow("unknown node");
  });

  test("rejects duplicate directed edge endpoints", () => {
    const input = validProject();
    input.nodes.push({ ...structuredClone(input.nodes[0]!), id: "node_2" });
    input.edges = [
      { id: "edge_1", from: "node_1", to: "node_2" },
      { id: "edge_2", from: "node_1", to: "node_2" },
    ];
    expect(() => parseBoardProject(input)).toThrow("duplicate edge endpoints");
  });

  test("rejects more than eight image references into one panorama", () => {
    const input = validProject();
    const panorama = {
      ...structuredClone(input.nodes[0]!),
      id: "panorama_target",
      type: "panorama",
      metadata: { panoramaProjection: "equirectangular", count: 1 },
    };
    const images = Array.from({ length: 9 }, (_, index) => ({
      ...structuredClone(input.nodes[0]!),
      id: `image_${index}`,
      type: "image",
      metadata: {},
    }));
    input.nodes = [...images, panorama];
    input.edges = images.map((image, index) => ({ id: `edge_${index}`, from: image.id, to: panorama.id }));
    expect(() => parseBoardProject(input)).toThrow("exceeds 8 image references");
  });

  test("rejects a project above the aggregate panorama rendering budget", () => {
    const input = validProject();
    input.nodes = Array.from({ length: 65 }, (_, index) => ({
      id: `panorama_${index}`,
      type: "panorama",
      title: `Panorama ${index}`,
      position: { x: index * 10, y: 0 },
      width: 320,
      height: 180,
      metadata: {
        content: `blob:panorama-${index}`,
        storageKey: `image:panorama-${index}`,
        mimeType: "image/png",
        bytes: 1024,
        naturalWidth: 2048,
        naturalHeight: 1024,
        panoramaProjection: "equirectangular",
      },
    } as typeof input.nodes[number]));
    expect(() => parseBoardProject(input)).toThrow(/aggregate limits/);
  });

  test("rejects unsupported node and background modes", () => {
    const nodeInput = validProject();
    nodeInput.nodes[0]!.type = "script";
    expect(() => parseBoardProject(nodeInput)).toThrow("nodes[0].type");

    const backgroundInput = validProject();
    backgroundInput.backgroundMode = "image";
    expect(() => parseBoardProject(backgroundInput)).toThrow("backgroundMode");
  });

  test("accepts a plugin node with bounded JSON state", () => {
    const input = validProject();
    input.nodes[0] = {
      ...input.nodes[0]!,
      type: "plugin",
      title: "Checklist",
      metadata: {
        pluginId: "openboard.checklist",
        pluginState: { items: [{ label: "Ship", done: false }], count: 1 },
      },
    };

    expect(parseBoardProject(input).nodes[0]?.metadata.pluginState).toEqual(
      input.nodes[0]!.metadata.pluginState,
    );
  });

  test("accepts a director node with a bounded scene and rejects invalid camera settings", () => {
    const input = validProject();
    input.nodes[0] = {
      ...input.nodes[0]!,
      type: "director",
      title: "Shot 01",
      metadata: {
        directorScene: {
          version: 1,
          background: "#111827",
          showGrid: true,
          selectedObjectId: "actor_1",
          camera: {
            position: { x: 6, y: 4, z: 8 },
            target: { x: 0, y: 1, z: 0 },
            focalLength: 50,
            aperture: 2.8,
            aspect: "16:9",
          },
          objects: [{
            id: "actor_1",
            kind: "character",
            name: "角色 1",
            visible: true,
            color: "#d1d5db",
            intensity: 1,
            transform: {
              position: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
          }],
        },
      },
    };

    const parsedScene = parseBoardProject(input).nodes[0]?.metadata.directorScene;
    expect(parsedScene?.version).toBe(4);
    expect(parsedScene?.cameras.find((camera) => camera.id === parsedScene.activeCameraId)?.focalLength).toBe(50);

    const invalid = structuredClone(input);
    invalid.nodes[0]!.metadata.directorScene.camera.focalLength = 0;
    expect(() => parseBoardProject(invalid)).toThrow("focalLength");

    const localCaptureLeak = structuredClone(input);
    (localCaptureLeak.nodes[0]!.metadata.directorScene as any).captureTray = [{
      id: "capture_1",
      content: "data:image/png;base64,AAAA",
    }];
    expect(() => parseBoardProject(localCaptureLeak)).toThrow("browser-local");

    const rootCaptureLeak = structuredClone(input);
    (rootCaptureLeak.nodes[0]!.metadata as any).directorCaptures = [{
      id: "capture_1",
      content: "data:image/png;base64,AAAA",
    }];
    expect(() => parseBoardProject(rootCaptureLeak)).toThrow("browser-local");

    for (const mutate of [
      (scene: any) => { scene.objects.push(structuredClone(scene.objects[0])); },
      (scene: any) => { scene.selectedObjectId = "missing"; },
      (scene: any) => { scene.objects[0].transform.position.x = Number.NaN; },
      (scene: any) => { scene.camera.aperture = 0; },
      (scene: any) => { scene.camera.aspect = "2:1"; },
    ]) {
      const malformed = structuredClone(input);
      mutate(malformed.nodes[0]!.metadata.directorScene);
      expect(() => parseBoardProject(malformed)).toThrow();
    }
  });

  test("rejects aggregate director scene complexity across a project", () => {
    const input = validProject();
    const objects = Array.from({ length: 200 }, (_, index) => ({
      id: `actor_${index}`,
      kind: "character",
      name: `角色 ${index}`,
      visible: true,
      color: "#d1d5db",
      intensity: 1,
      transform: {
        position: { x: index, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    }));
    input.nodes = Array.from({ length: 11 }, (_, nodeIndex) => ({
      id: `director_${nodeIndex}`,
      type: "director",
      title: `Shot ${nodeIndex}`,
      position: { x: nodeIndex * 20, y: 0 },
      width: 360,
      height: 240,
      metadata: {
        directorScene: {
          version: 1,
          background: "#111827",
          showGrid: true,
          selectedObjectId: `n${nodeIndex}_actor_0`,
          camera: {
            position: { x: 6, y: 4, z: 8 },
            target: { x: 0, y: 1, z: 0 },
            focalLength: 50,
            aperture: 2.8,
            aspect: "16:9",
          },
          objects: objects.map((object) => ({ ...structuredClone(object), id: `n${nodeIndex}_${object.id}` })),
        },
      },
    }));
    expect(() => parseBoardProject(input)).toThrow("aggregate limits");
  });

  test("rejects aggregate director camera complexity across a project", () => {
    const input = validProject();
    input.nodes = Array.from({ length: 11 }, (_, nodeIndex) => {
      const scene = createDefaultDirectorScene();
      scene.cameras = Array.from({ length: 30 }, (_, cameraIndex) => ({
        ...structuredClone(scene.cameras[0]!),
        id: `camera_${nodeIndex}_${cameraIndex}`,
        name: `机位 ${cameraIndex + 1}`,
      }));
      scene.activeCameraId = scene.cameras[0]!.id;
      return {
        id: `director_${nodeIndex}`,
        type: "director",
        title: `Director ${nodeIndex}`,
        position: { x: nodeIndex * 20, y: 0 },
        width: 360,
        height: 240,
        metadata: { directorScene: scene },
      };
    });
    expect(() => parseBoardProject(input)).toThrow("director cameras exceed aggregate limits");
  });

  test("rejects aggregate director population complexity across a project", () => {
    const input = validProject();
    input.nodes = Array.from({ length: 5 }, (_, nodeIndex) => {
      const scene = createDefaultDirectorScene();
      scene.objects = Array.from({ length: 4 }, (_, crowdIndex) => ({
        id: `crowd_${nodeIndex}_${crowdIndex}`,
        kind: "crowd" as const,
        name: `群众 ${crowdIndex + 1}`,
        visible: true,
        locked: false,
        color: "#2563eb",
        intensity: 1,
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
        crowd: {
          preset: "studio" as const,
          pose: "neutral" as const,
          rows: 32,
          columns: 32,
          spacingX: 1,
          spacingZ: 1,
          variation: false,
          seed: crowdIndex,
        },
      }));
      scene.selectedObjectId = scene.objects[0]!.id;
      return {
        id: `director_${nodeIndex}`,
        type: "director",
        title: `Crowd ${nodeIndex}`,
        position: { x: nodeIndex * 20, y: 0 },
        width: 360,
        height: 240,
        metadata: { directorScene: scene },
      };
    });
    expect(() => parseBoardProject(input)).toThrow("population exceeds aggregate limits");
  });

  test("accepts a native 2:1 panorama and validates director environment references", () => {
    const input = validProject();
    input.nodes[0] = {
      ...input.nodes[0]!,
      type: "panorama",
      title: "城市全景",
      width: 360,
      height: 280,
      metadata: {
        content: "blob:panorama",
        storageKey: "image:panorama",
        naturalWidth: 2048,
        naturalHeight: 1024,
        panoramaProjection: "equirectangular",
      },
    };
    expect(parseBoardProject(input).nodes[0]?.type).toBe("panorama");

    const invalidRatio = structuredClone(input);
    invalidRatio.nodes[0]!.metadata.naturalWidth = 1920;
    invalidRatio.nodes[0]!.metadata.naturalHeight = 1080;
    expect(() => parseBoardProject(invalidRatio)).toThrow("2:1");
  });

  test("validates persisted panorama batch relationships", () => {
    const input = createProject("Panorama batch") as any;
    const root = createNode("panorama", { x: 0, y: 0 }, {
      id: "panorama_root",
      metadata: {
        content: "blob:root",
        storageKey: "image:root",
        naturalWidth: 2048,
        naturalHeight: 1024,
        bytes: 1024,
        mimeType: "image/png",
        panoramaProjection: "equirectangular",
        isBatchRoot: true,
        batchChildIds: ["panorama_child"],
        primaryImageId: "panorama_root",
        imageBatchExpanded: true,
      },
    });
    const child = createNode("panorama", { x: 400, y: 0 }, {
      id: "panorama_child",
      metadata: {
        content: "blob:child",
        storageKey: "image:child",
        naturalWidth: 2048,
        naturalHeight: 1024,
        bytes: 1024,
        mimeType: "image/png",
        panoramaProjection: "equirectangular",
        batchRootId: "panorama_root",
      },
    });
    input.nodes = [root, child];
    expect(parseBoardProject(input).nodes).toHaveLength(2);

    const persisted = structuredClone(input);
    delete persisted.nodes[0].metadata.content;
    delete persisted.nodes[1].metadata.content;
    expect(parseBoardProject(persisted).nodes).toHaveLength(2);

    for (const mutate of [
      (project: any) => { project.nodes[0].metadata.batchChildIds = ["panorama_child", "panorama_child"]; },
      (project: any) => { project.nodes[0].metadata.primaryImageId = "missing"; },
      (project: any) => { project.nodes[1].metadata.batchRootId = "missing"; },
      (project: any) => { project.nodes[1].type = "image"; },
      (project: any) => { project.nodes[0].metadata.isBatchRoot = "yes"; },
      (project: any) => { delete project.nodes[0].metadata.storageKey; },
      (project: any) => { project.nodes[1].metadata.mimeType = "image/svg+xml"; },
    ]) {
      const invalid = structuredClone(input);
      mutate(invalid);
      expect(() => parseBoardProject(invalid)).toThrow(/batch/i);
    }
  });

  test("accepts bounded node camera prompts and rejects them on unsupported nodes", () => {
    const input = validProject();
    input.nodes[0]!.type = "image";
    input.nodes[0]!.metadata.content = undefined;
    input.nodes[0]!.metadata.cameraPrompt = {
      enabled: true,
      camera: "mirrorless",
      lens: "telephoto",
      focalLength: 85,
      aperture: 1.8,
    };
    expect(parseBoardProject(input).nodes[0]?.metadata.cameraPrompt?.focalLength).toBe(85);

    const unsupported = structuredClone(input);
    unsupported.nodes[0]!.type = "text";
    expect(() => parseBoardProject(unsupported)).toThrow("cameraPrompt");

    const invalid = structuredClone(input);
    invalid.nodes[0]!.metadata.cameraPrompt.focalLength = 1000;
    expect(() => parseBoardProject(invalid)).toThrow("focalLength");
  });

  test("rejects plugin nodes without a valid plugin id", () => {
    const input = validProject();
    input.nodes[0] = {
      ...input.nodes[0]!,
      type: "plugin",
      metadata: { pluginId: "../unsafe", pluginState: {} },
    };
    expect(() => parseBoardProject(input)).toThrow("pluginId");

    input.nodes[0]!.metadata = { pluginState: {} };
    expect(() => parseBoardProject(input)).toThrow("pluginId");
  });

  test("rejects unsafe, deeply nested, and oversized plugin state", () => {
    const makePlugin = (pluginState: unknown) => {
      const input = validProject();
      input.nodes[0] = {
        ...input.nodes[0]!,
        type: "plugin",
        metadata: { pluginId: "openboard.note", pluginState },
      };
      return input;
    };

    const unsafe = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');
    expect(() => parseBoardProject(makePlugin(unsafe))).toThrow("unsafe key");

    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 24; i += 1) deep = { child: deep };
    expect(() => parseBoardProject(makePlugin(deep))).toThrow("depth");

    expect(() =>
      parseBoardProject(makePlugin({ body: "x".repeat(256 * 1024) })),
    ).toThrow("256 KiB");
  });

  test("accepts groups only when every child is a real non-group node", () => {
    const input = validProject();
    input.nodes.unshift({
      id: "group_1",
      type: "group",
      title: "Group",
      position: { x: 0, y: 0 },
      width: 500,
      height: 300,
      metadata: { childIds: ["node_1"] },
    });
    expect(parseBoardProject(input).nodes[0]?.metadata.childIds).toEqual(["node_1"]);

    input.nodes[0]!.metadata.childIds = ["missing"];
    expect(() => parseBoardProject(input)).toThrow("invalid child");
  });

  test("rejects duplicate group membership", () => {
    const input = validProject();
    input.nodes.unshift(
      {
        id: "group_1",
        type: "group",
        title: "One",
        position: { x: 0, y: 0 },
        width: 500,
        height: 300,
        metadata: { childIds: ["node_1"] },
      },
      {
        id: "group_2",
        type: "group",
        title: "Two",
        position: { x: 0, y: 0 },
        width: 500,
        height: 300,
        metadata: { childIds: ["node_1"] },
      },
    );
    expect(() => parseBoardProject(input)).toThrow("multiple groups");
  });

  test("rejects active and local-file media URL schemes", () => {
    const input = validProject();
    input.nodes[0]!.type = "image";
    input.nodes[0]!.metadata.content = "javascript:alert(1)";
    expect(() => parseBoardProject(input)).toThrow("unsafe media URL");
  });

  test("validates font, transparency, model, and normalized split metadata", () => {
    const input = validProject();
    input.nodes[0]!.metadata = { fontSize: 9 };
    expect(() => parseBoardProject(input)).toThrow("fontSize");
    input.nodes[0]!.metadata = { transparentBackground: "yes" };
    expect(() => parseBoardProject(input)).toThrow("transparentBackground");
    input.nodes[0]!.metadata = { splitVertical: [0.7, 0.2] };
    expect(() => parseBoardProject(input)).toThrow("sorted normalized");
    input.nodes[0]!.metadata = { model: "x".repeat(501) };
    expect(() => parseBoardProject(input)).toThrow("model");
  });
});
