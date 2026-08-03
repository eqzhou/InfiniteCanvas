import { describe, expect, test } from "bun:test";

import { createNode, createProject } from "@/lib/defaults";
import { createDefaultDirectorScene, getActiveDirectorCamera } from "@/lib/director-scene";
import { createDirectorShotSnapshot } from "@/lib/director-shot";
import { createImageGenerationMetadata } from "@/lib/image-generation";
import { parseBoardProject } from "@/lib/board-document";
import {
  buildDirectorShotPrompt,
  directorShotGenerationContext,
  expandDirectorShotDeletion,
  generationCleanupNodeIdsAfterDeletion,
  orphanedGenerationJobIdsAfterDeletion,
  planDirectorShotGeneration,
  repairDirectorShotDeletion,
} from "@/lib/director-shot-generation";

describe("director formal shot generation", () => {
  test("builds an editable structural prompt without inventing a visual style", () => {
    const scene = createDefaultDirectorScene();
    const camera = getActiveDirectorCamera(scene);

    const prompt = buildDirectorShotPrompt(createDirectorShotSnapshot(scene, "director_main", camera.id));

    expect(prompt).toContain(camera.name);
    expect(prompt).toContain(`${camera.focalLength}mm`);
    expect(prompt).toContain("保持当前角色与物体的空间关系");
    expect(prompt).not.toMatch(/赛博朋克|电影感|油画|写实风格/);
  });

  test("captures a compact immutable scene snapshot and omits hidden objects", () => {
    const scene = createDefaultDirectorScene();
    scene.objects[0] = { ...scene.objects[0]!, visible: false, name: "隐藏角色" };
    const snapshot = createDirectorShotSnapshot(scene, "director_main");
    scene.cameras[0]!.position.x = 999;
    scene.environment.intensity = 99;

    expect(snapshot.objects.some((object) => object.name === "隐藏角色")).toBe(false);
    expect(snapshot.camera.position.x).not.toBe(999);
    expect(snapshot.environment.intensity).not.toBe(99);
    expect(buildDirectorShotPrompt(snapshot)).not.toContain("隐藏角色");
  });

  test("plans a durable capture -> config -> result chain with director lineage", () => {
    const project = createProject("导演台项目");
    const scene = createDefaultDirectorScene();
    const director = createNode("director", { x: 100, y: 100 }, {
      id: "director_main",
      metadata: { directorScene: scene },
    });
    project.nodes = [director];
    const camera = getActiveDirectorCamera(scene);
    const generation = createImageGenerationMetadata({
      prompt: buildDirectorShotPrompt(createDirectorShotSnapshot(scene, director.id, camera.id)),
      model: "gpt-image-2",
      size: "1536x1024",
      quality: "auto",
      count: 1,
      transparentBackground: false,
      referenceStorageKeys: ["image:director-shot-source"],
      generationChannelId: "channel_image",
    });

    const planned = planDirectorShotGeneration(project, {
      directorId: director.id,
      capture: {
        id: "capture_main",
        cameraId: camera.id,
        cameraName: camera.name,
        createdAt: "2026-08-02T10:00:00.000Z",
        shot: createDirectorShotSnapshot(scene, director.id, camera.id),
      },
      media: {
        url: "blob:http://localhost/director-shot-source",
        storageKey: "image:director-shot-source",
        width: 1600,
        height: 900,
        bytes: 1234,
        mimeType: "image/png",
      },
      generation,
      jobId: "job_director_shot",
    });

    const captureNode = planned.nodes.find((node) => node.metadata.directorShot?.role === "capture");
    const configNode = planned.nodes.find((node) => node.type === "config" && node.metadata.directorShot);
    const resultNode = planned.nodes.find((node) => node.metadata.generationJobId === "job_director_shot" && node.type === "image");
    expect(captureNode?.metadata.storageKey).toBe("image:director-shot-source");
    expect(captureNode?.metadata.directorShot).toMatchObject({
      version: 1,
      role: "capture",
      directorNodeId: director.id,
      captureId: "capture_main",
      snapshot: { camera: { id: camera.id, focalLength: camera.focalLength } },
    });
    expect(configNode?.metadata).toMatchObject({
      prompt: generation.prompt,
      generationType: "image-to-image",
      referenceStorageKeys: ["image:director-shot-source"],
      generationJobId: "job_director_shot",
      directorShot: { role: "config", captureId: "capture_main" },
    });
    expect(resultNode?.metadata.generationConfigId).toBe(configNode?.id);
    expect(planned.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: director.id, to: captureNode?.id }),
      expect.objectContaining({ from: captureNode?.id, to: configNode?.id }),
      expect.objectContaining({ from: configNode?.id, to: resultNode?.id }),
    ]));
    expect(parseBoardProject(structuredClone(planned)).nodes).toHaveLength(planned.nodes.length);
    const invalid = structuredClone(planned);
    const invalidConfig = invalid.nodes.find((item) => item.id === configNode?.id)!;
    invalidConfig.metadata.directorShot!.role = "capture";
    expect(() => parseBoardProject(invalid)).toThrow("capture must belong to an image");

    const mismatchedCapture = structuredClone(planned);
    mismatchedCapture.nodes.find((item) => item.id === configNode?.id)!.metadata.directorShot!.captureId = "capture_other";
    expect(() => parseBoardProject(mismatchedCapture)).toThrow("invalid lineage");

    const missingDirectorEdge = structuredClone(planned);
    missingDirectorEdge.edges = missingDirectorEdge.edges.filter((edge) => edge.to !== captureNode?.id);
    expect(() => parseBoardProject(missingDirectorEdge)).toThrow("invalid lineage");

    const missingConfigResultEdge = structuredClone(planned);
    missingConfigResultEdge.edges = missingConfigResultEdge.edges.filter((edge) =>
      !(edge.from === configNode?.id && edge.to === resultNode?.id));
    expect(() => parseBoardProject(missingConfigResultEdge)).toThrow("invalid lineage");

    const deletedResult = structuredClone(planned);
    deletedResult.nodes = deletedResult.nodes.filter((node) => node.id !== resultNode?.id);
    deletedResult.edges = deletedResult.edges.filter((edge) => edge.to !== resultNode?.id);
    delete deletedResult.nodes.find((node) => node.id === configNode?.id)!.metadata.generationOutputRootId;
    expect(parseBoardProject(deletedResult).nodes.some((node) => node.id === configNode?.id)).toBe(true);

    const deletedCapture = structuredClone(planned);
    deletedCapture.nodes = deletedCapture.nodes.filter((node) => node.id !== captureNode?.id);
    deletedCapture.edges = deletedCapture.edges.filter((edge) => edge.from !== captureNode?.id && edge.to !== captureNode?.id);
    expect(parseBoardProject(deletedCapture).nodes.some((node) => node.id === configNode?.id)).toBe(true);

    expect(directorShotGenerationContext(deletedCapture, configNode!.id)).toEqual({
      configNodeId: configNode!.id,
      referenceStorageKeys: ["image:director-shot-source"],
      source: {
        kind: "director",
        directorNodeId: director.id,
        captureId: "capture_main",
        cameraId: camera.id,
        configNodeId: configNode!.id,
      },
    });
    expect(directorShotGenerationContext(planned, resultNode!.id)?.source.configNodeId).toBe(configNode!.id);

    const withoutResult = structuredClone(planned);
    const resultSelection = new Set([resultNode!.id]);
    withoutResult.nodes = repairDirectorShotDeletion(
      withoutResult.nodes.filter((item) => !resultSelection.has(item.id)),
      resultSelection,
    );
    withoutResult.edges = withoutResult.edges.filter((edge) => !resultSelection.has(edge.from) && !resultSelection.has(edge.to));
    expect(withoutResult.nodes.find((item) => item.id === configNode!.id)?.metadata.generationOutputRootId).toBeUndefined();
    expect(() => parseBoardProject(withoutResult)).not.toThrow();

    const withoutConfig = structuredClone(planned);
    const configSelection = new Set([configNode!.id]);
    expect(orphanedGenerationJobIdsAfterDeletion(planned, configSelection)).toEqual(new Set());
    expect(generationCleanupNodeIdsAfterDeletion(planned, configSelection)).toEqual(new Set());
    withoutConfig.nodes = repairDirectorShotDeletion(
      withoutConfig.nodes.filter((item) => !configSelection.has(item.id)),
      configSelection,
    );
    withoutConfig.edges = withoutConfig.edges.filter((edge) => !configSelection.has(edge.from) && !configSelection.has(edge.to));
    expect(withoutConfig.nodes.find((item) => item.id === resultNode!.id)?.metadata.generationConfigId).toBeUndefined();
    expect(() => parseBoardProject(withoutConfig)).not.toThrow();

    const directorSelection = expandDirectorShotDeletion(planned, new Set([director.id]));
    expect(directorSelection).toEqual(new Set([director.id, captureNode!.id, configNode!.id]));
    expect(orphanedGenerationJobIdsAfterDeletion(planned, directorSelection)).toEqual(new Set());
    expect(generationCleanupNodeIdsAfterDeletion(planned, directorSelection)).toEqual(new Set([director.id, captureNode!.id]));
    const withoutDirector = structuredClone(planned);
    withoutDirector.nodes = repairDirectorShotDeletion(
      withoutDirector.nodes.filter((item) => !directorSelection.has(item.id)),
      directorSelection,
    );
    withoutDirector.edges = withoutDirector.edges.filter((edge) => !directorSelection.has(edge.from) && !directorSelection.has(edge.to));
    expect(withoutDirector.nodes.find((item) => item.id === resultNode!.id)?.metadata.generationConfigId).toBeUndefined();
    expect(() => parseBoardProject(withoutDirector)).not.toThrow();

    const wholeChainSelection = new Set([captureNode!.id, configNode!.id, resultNode!.id]);
    expect(orphanedGenerationJobIdsAfterDeletion(planned, wholeChainSelection)).toEqual(new Set(["job_director_shot"]));
    expect(generationCleanupNodeIdsAfterDeletion(planned, wholeChainSelection)).toEqual(wholeChainSelection);
  });

  test("rejects a capture that does not belong to the selected director camera", () => {
    const project = createProject();
    const director = createNode("director", { x: 0, y: 0 }, {
      id: "director_main",
      metadata: { directorScene: createDefaultDirectorScene() },
    });
    project.nodes = [director];
    expect(() => planDirectorShotGeneration(project, {
      directorId: director.id,
      capture: {
        id: "capture_main",
        cameraId: "camera_missing",
        cameraName: "已删除机位",
        createdAt: "2026-08-02T10:00:00.000Z",
      },
      media: {
        url: "/api/blobs/image%3Asource",
        storageKey: "image:source",
        width: 1600,
        height: 900,
        bytes: 10,
        mimeType: "image/png",
      },
      generation: createImageGenerationMetadata({
        prompt: "镜头",
        model: "image",
        size: "1024x1024",
        quality: "auto",
        count: 1,
        transparentBackground: false,
        referenceStorageKeys: ["image:source"],
      }),
      jobId: "job_director_shot",
    })).toThrow("机位");
  });
});
