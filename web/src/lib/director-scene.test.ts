import { describe, expect, test } from "bun:test";

import {
  addDirectorCamera,
  addDirectorCrowd,
  addDirectorCharacter,
  addDirectorPrimitive,
  addDirectorModel,
  addDirectorObject,
  createDefaultDirectorScene,
  directorTransformFromRadians,
  getActiveDirectorCamera,
  parseDirectorScene,
  removeDirectorCamera,
  removeDirectorObject,
  resetDirectorObjectTransform,
  resetDirectorView,
  relinkDirectorModel,
  renameDirectorCamera,
  selectDirectorCamera,
  setDirectorViewMode,
  setDirectorObjectLocked,
  updateDirectorCamera,
  updateDirectorCharacter,
  updateDirectorCrowd,
  updateDirectorPrimitive,
  updateDirectorView,
  updateDirectorObjectTransform,
} from "./director-scene";

describe("director scene model", () => {
  test("creates a production-ready default scene", () => {
    const scene = createDefaultDirectorScene();

    expect(scene.version).toBe(4);
    expect(scene.objects.some((object) => object.kind === "character")).toBe(true);
    expect(scene.objects.some((object) => object.kind === "light")).toBe(true);
    expect(scene.cameras).toHaveLength(1);
    expect(getActiveDirectorCamera(scene)).toMatchObject({
      name: "主摄像机",
      focalLength: 50,
      aspect: "16:9",
    });
    expect(scene.showRuleOfThirds).toBe(false);
    expect(scene.showSafeFrame).toBe(false);
    expect(scene.viewMode).toBe("director");
    expect(scene.directorView.position).not.toEqual(getActiveDirectorCamera(scene).position);
    expect(scene.environment).toEqual({ rotationY: 0, intensity: 1 });
    expect(scene.objects.every((object) => object.locked === false)).toBe(true);
    expect(scene.objects.find((object) => object.kind === "character")?.character).toEqual({
      preset: "studio",
      pose: "neutral",
      role: "actor",
    });
  });

  test("adds and updates eight character styles and twenty poses immutably", () => {
    const scene = createDefaultDirectorScene();
    const added = addDirectorCharacter(scene, { preset: "future", pose: "celebrate", role: "extra" });
    const character = added.objects.at(-1)!;

    expect(character).toMatchObject({
      kind: "character",
      character: { preset: "future", pose: "celebrate", role: "extra" },
    });
    expect(scene.objects).toHaveLength(2);
    const updated = updateDirectorCharacter(added, character.id, { preset: "athletic", pose: "run", role: "actor" });
    expect(updated.objects.find((object) => object.id === character.id)?.character).toEqual({
      preset: "athletic",
      pose: "run",
      role: "actor",
    });
    expect(character.character).toEqual({ preset: "future", pose: "celebrate", role: "extra" });
  });

  test("places newly added characters in distinct stage slots", () => {
    const scene = createDefaultDirectorScene();
    const second = addDirectorCharacter(scene);
    const third = addDirectorCharacter(second);
    const positions = third.objects
      .filter((object) => object.kind === "character")
      .map((object) => `${object.transform.position.x}:${object.transform.position.z}`);

    expect(new Set(positions).size).toBe(3);
  });

  test("resets a staged object and the independent director view immutably", () => {
    const scene = addDirectorCharacter(createDefaultDirectorScene());
    const selected = scene.objects.at(-1)!;
    const transformed = updateDirectorObjectTransform(scene, selected.id, {
      position: { x: 3, y: 4, z: 5 },
      rotation: { x: -54, y: -72, z: -55 },
      scale: { x: 4, y: 3, z: 2 },
    });
    const movedView = updateDirectorView(transformed, {
      position: { x: -40, y: 20, z: 18 },
      target: { x: 8, y: 3, z: -2 },
    });

    const resetObject = resetDirectorObjectTransform(movedView, selected.id);
    const reset = resetDirectorView(resetObject);
    const object = reset.objects.find((candidate) => candidate.id === selected.id)!;

    expect(object.transform.rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(object.transform.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(object.transform.position).toEqual({ x: 3, y: 4, z: 5 });
    expect(reset.directorView).toEqual(createDefaultDirectorScene().directorView);
    expect(movedView.objects.find((candidate) => candidate.id === selected.id)?.transform.rotation)
      .toEqual({ x: -54, y: -72, z: -55 });
  });

  test("adds editable primitive geometry and crowd arrays within aggregate budgets", () => {
    const scene = createDefaultDirectorScene();
    const withPrimitive = addDirectorPrimitive(scene, "torus");
    const primitive = withPrimitive.objects.at(-1)!;
    expect(primitive).toMatchObject({ kind: "prop", primitive: "torus" });
    const changedPrimitive = updateDirectorPrimitive(withPrimitive, primitive.id, "sphere");
    expect(changedPrimitive.objects.find((object) => object.id === primitive.id)?.primitive).toBe("sphere");

    const withCrowd = addDirectorCrowd(changedPrimitive, {
      preset: "casual",
      pose: "talk",
      rows: 10,
      columns: 10,
      spacingX: 1.25,
      spacingZ: 1.5,
      variation: true,
      seed: 7,
    });
    const crowd = withCrowd.objects.at(-1)!;
    expect(crowd).toMatchObject({ kind: "crowd", crowd: { rows: 10, columns: 10 } });
    const updated = updateDirectorCrowd(withCrowd, crowd.id, { rows: 8, columns: 12, variation: false });
    expect(updated.objects.find((object) => object.id === crowd.id)?.crowd).toMatchObject({
      rows: 8,
      columns: 12,
      variation: false,
    });
    expect(crowd.crowd).toMatchObject({ rows: 10, columns: 10, variation: true });
  });

  test("imports and relinks a local GLB without changing its staged transform", () => {
    const scene = createDefaultDirectorScene();
    const imported = addDirectorModel(scene, {
      assetId: "model_asset_1",
      fileName: "hero.glb",
      bytes: 2048,
    });
    const model = imported.objects.at(-1)!;

    expect(scene.objects).toHaveLength(2);
    expect(model).toMatchObject({
      kind: "model",
      name: "hero",
      locked: false,
      modelAsset: { assetId: "model_asset_1", fileName: "hero.glb", bytes: 2048 },
    });
    expect(imported.selectedObjectId).toBe(model.id);

    const staged = updateDirectorObjectTransform(imported, model.id, {
      position: { x: 3, y: 1, z: -2 },
      rotation: { x: 10, y: 45, z: 0 },
      scale: { x: 2, y: 2, z: 2 },
    });
    const relinked = relinkDirectorModel(staged, model.id, {
      assetId: "model_asset_2",
      fileName: "hero-fixed.glb",
      bytes: 4096,
    });
    const restored = relinked.objects.find((object) => object.id === model.id)!;

    expect(restored.modelAsset).toEqual({
      assetId: "model_asset_2",
      fileName: "hero-fixed.glb",
      bytes: 4096,
    });
    expect(restored.transform).toEqual(staged.objects.find((object) => object.id === model.id)!.transform);
    expect(staged.objects.find((object) => object.id === model.id)!.modelAsset?.fileName).toBe("hero.glb");
  });

  test("locks staged objects immutably so viewport transforms can be disabled", () => {
    const scene = createDefaultDirectorScene();
    const selected = scene.objects.find((object) => object.id === scene.selectedObjectId)!;
    const locked = setDirectorObjectLocked(scene, selected.id, true);

    expect(locked).not.toBe(scene);
    expect(locked.objects).not.toBe(scene.objects);
    expect(locked.objects.find((object) => object.id === selected.id)?.locked).toBe(true);
    expect(scene.objects.find((object) => object.id === selected.id)?.locked).toBe(false);
  });

  test("normalizes a Three transform into bounded scene values", () => {
    expect(directorTransformFromRadians({
      position: { x: Number.POSITIVE_INFINITY, y: -0, z: 100_001 },
      rotation: { x: Math.PI / 2, y: -Math.PI, z: Number.NaN },
      scale: { x: -2, y: 1.23456789, z: 1001 },
    })).toEqual({
      position: { x: -100_000, y: 0, z: 100_000 },
      rotation: { x: 90, y: -180, z: -360 },
      scale: { x: 0.01, y: 1.234568, z: 1000 },
    });
  });

  test("updates transforms immutably", () => {
    const scene = createDefaultDirectorScene();
    const character = scene.objects.find((object) => object.kind === "character")!;
    const next = updateDirectorObjectTransform(scene, character.id, {
      position: { x: 2, y: 1, z: -3 },
    });

    expect(next).not.toBe(scene);
    expect(next.objects).not.toBe(scene.objects);
    expect(scene.objects.find((object) => object.id === character.id)?.transform.position.x).toBe(0);
    expect(next.objects.find((object) => object.id === character.id)?.transform.position).toEqual({
      x: 2,
      y: 1,
      z: -3,
    });
  });

  test("adds uniquely identified objects and removes the selected object safely", () => {
    const scene = createDefaultDirectorScene();
    const withProp = addDirectorObject(scene, "prop");
    const prop = withProp.objects.at(-1)!;

    expect(prop.kind).toBe("prop");
    expect(withProp.selectedObjectId).toBe(prop.id);
    expect(new Set(withProp.objects.map((object) => object.id)).size).toBe(withProp.objects.length);

    const removed = removeDirectorObject(withProp, prop.id);
    expect(removed.objects.some((object) => object.id === prop.id)).toBe(false);
    expect(removed.selectedObjectId).not.toBe(prop.id);
  });

  test("updates camera settings without mutating the original scene", () => {
    const scene = createDefaultDirectorScene();
    const original = getActiveDirectorCamera(scene);
    const next = updateDirectorCamera(scene, {
      focalLength: 85,
      aperture: 4,
      aspect: "4:3",
      position: { x: 4, y: 3, z: 7 },
    });

    expect(getActiveDirectorCamera(next)).not.toBe(original);
    expect(getActiveDirectorCamera(next)).toMatchObject({ focalLength: 85, aperture: 4, aspect: "4:3" });
    expect(original).toMatchObject({ focalLength: 50, aperture: 2.8, aspect: "16:9" });
  });

  test("adds, renames, selects, edits, and removes cameras immutably", () => {
    const scene = createDefaultDirectorScene();
    const first = getActiveDirectorCamera(scene);
    const added = addDirectorCamera(scene);
    const second = getActiveDirectorCamera(added);

    expect(added).not.toBe(scene);
    expect(added.cameras).not.toBe(scene.cameras);
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ name: "机位 2", focalLength: first.focalLength });

    const renamed = renameDirectorCamera(added, second.id, "近景机位");
    const selectedFirst = selectDirectorCamera(renamed, first.id);
    const editedFirst = updateDirectorCamera(selectedFirst, { focalLength: 24 });
    expect(getActiveDirectorCamera(editedFirst)).toMatchObject({ id: first.id, focalLength: 24 });
    expect(editedFirst.cameras.find((camera) => camera.id === second.id)).toMatchObject({
      name: "近景机位",
      focalLength: second.focalLength,
    });

    const removed = removeDirectorCamera(editedFirst, first.id);
    expect(removed.cameras).toHaveLength(1);
    expect(removed.activeCameraId).toBe(second.id);
    expect(removeDirectorCamera(removed, second.id)).toBe(removed);
  });

  test("keeps the director navigation view independent from every shot camera", () => {
    const scene = createDefaultDirectorScene();
    const activeBefore = structuredClone(getActiveDirectorCamera(scene));
    const moved = updateDirectorView(scene, {
      position: { x: 12, y: 10, z: 14 },
      target: { x: 1, y: 2, z: 3 },
    });
    const cameraMode = setDirectorViewMode(moved, "camera");

    expect(moved.directorView.position).toEqual({ x: 12, y: 10, z: 14 });
    expect(getActiveDirectorCamera(moved)).toEqual(activeBefore);
    expect(cameraMode.viewMode).toBe("camera");
    expect(scene.viewMode).toBe("director");
  });

  test("migrates legacy single-camera scenes and validates camera collections", () => {
    const legacy = {
      version: 1,
      background: "#111827",
      showGrid: true,
      selectedObjectId: null,
      camera: {
        position: { x: 6, y: 4, z: 8 },
        target: { x: 0, y: 1, z: 0 },
        focalLength: 85,
        aperture: 4,
        aspect: "4:3",
      },
      environment: { rotationY: 0, intensity: 1 },
      objects: [],
    };
    const migrated = parseDirectorScene(legacy);
    expect(migrated.version).toBe(4);
    expect(migrated.cameras).toHaveLength(1);
    expect(getActiveDirectorCamera(migrated)).toMatchObject({ focalLength: 85, aspect: "4:3" });
    expect(migrated.objects).toEqual([]);

    const duplicated = structuredClone(migrated) as any;
    duplicated.cameras.push(structuredClone(duplicated.cameras[0]));
    expect(() => parseDirectorScene(duplicated)).toThrow("duplicated");

    const missingActive = structuredClone(migrated) as any;
    missingActive.activeCameraId = "missing";
    expect(() => parseDirectorScene(missingActive)).toThrow("activeCameraId");

    const excessive = structuredClone(migrated) as any;
    excessive.cameras = Array.from({ length: 33 }, (_, index) => ({
      ...structuredClone(migrated.cameras[0]),
      id: `camera_${index}`,
    }));
    expect(() => parseDirectorScene(excessive)).toThrow("32");
  });

  test("validates v3 model descriptors and migrates v2 object locks", () => {
    const legacy = createDefaultDirectorScene() as any;
    legacy.version = 2;
    legacy.objects = legacy.objects.map(({ locked: _locked, modelAsset: _asset, ...object }: any) => object);
    const migrated = parseDirectorScene(legacy);
    expect(migrated.version).toBe(4);
    expect(migrated.objects.every((object) => object.locked === false)).toBe(true);

    const withModel = addDirectorModel(migrated, {
      assetId: "asset_safe",
      fileName: "safe.glb",
      bytes: 1024,
    });
    expect(parseDirectorScene(withModel).objects.at(-1)?.kind).toBe("model");

    for (const mutate of [
      (scene: any) => { scene.objects.at(-1).modelAsset.assetId = "../../escape"; },
      (scene: any) => { scene.objects.at(-1).modelAsset.fileName = "../safe.glb"; },
      (scene: any) => { scene.objects.at(-1).modelAsset.bytes = 0; },
      (scene: any) => { scene.objects.at(-1).modelAsset = undefined; },
      (scene: any) => { scene.objects[0].modelAsset = { assetId: "asset_2", fileName: "bad.glb", bytes: 10 }; },
    ]) {
      const invalid = structuredClone(withModel) as any;
      mutate(invalid);
      expect(() => parseDirectorScene(invalid)).toThrow();
    }

    let bounded = migrated;
    for (let index = 0; index < 32; index += 1) {
      bounded = addDirectorModel(bounded, { assetId: `asset_${index}`, fileName: `${index}.glb`, bytes: 20 });
    }
    expect(bounded.objects.filter((object) => object.kind === "model")).toHaveLength(32);
    expect(addDirectorModel(bounded, { assetId: "asset_over", fileName: "over.glb", bytes: 20 })).toBe(bounded);
  });

  test("migrates v3 cast defaults and validates v4 character, primitive, and crowd data", () => {
    const legacy = createDefaultDirectorScene() as any;
    legacy.version = 3;
    legacy.objects = legacy.objects.map(({ character: _character, primitive: _primitive, crowd: _crowd, ...object }: any) => object);
    const migrated = parseDirectorScene(legacy);
    expect(migrated.version).toBe(4);
    expect(migrated.objects.find((object) => object.kind === "character")?.character).toEqual({
      preset: "studio",
      pose: "neutral",
      role: "actor",
    });

    const withCrowd = addDirectorCrowd(migrated, {
      preset: "broad",
      pose: "guard",
      rows: 20,
      columns: 20,
      spacingX: 1,
      spacingZ: 1,
      variation: false,
      seed: 1,
    });
    expect(parseDirectorScene(withCrowd).objects.at(-1)?.kind).toBe("crowd");
    for (const mutate of [
      (scene: any) => { scene.objects.find((object: any) => object.kind === "character").character.preset = "unknown"; },
      (scene: any) => { scene.objects.find((object: any) => object.kind === "character").character.pose = "unknown"; },
      (scene: any) => { scene.objects.find((object: any) => object.kind === "character").character.role = "lead"; },
      (scene: any) => { scene.objects.at(-1).crowd.rows = 65; },
      (scene: any) => { scene.objects.at(-1).crowd.spacingX = 0; },
      (scene: any) => { scene.objects.at(-1).primitive = "sphere"; },
    ]) {
      const invalid = structuredClone(withCrowd) as any;
      mutate(invalid);
      expect(() => parseDirectorScene(invalid)).toThrow();
    }
  });

  test("rejects many small crowds that amplify render batches inside the population budget", () => {
    const scene = createDefaultDirectorScene();
    const crowdTemplate = {
      ...scene.objects[0]!,
      kind: "crowd" as const,
      character: undefined,
      name: "恶意小阵列",
      crowd: {
        preset: "studio" as const,
        pose: "neutral" as const,
        rows: 5,
        columns: 8,
        spacingX: 1,
        spacingZ: 1,
        variation: true,
        seed: 1,
      },
    };
    const amplified = {
      ...scene,
      objects: [scene.objects[0]!, ...Array.from({ length: 4 }, (_, index) => ({
        ...crowdTemplate,
        id: `crowd_attack_${index}`,
        crowd: { ...crowdTemplate.crowd, seed: index + 1 },
      }))],
    };
    expect(() => parseDirectorScene(amplified)).toThrow(/render batches/);

    let bounded = scene;
    for (let index = 0; index < 4; index += 1) {
      bounded = addDirectorCrowd(bounded, { ...crowdTemplate.crowd, seed: index + 1 });
    }
    expect(bounded.objects.filter((object) => object.kind === "crowd")).toHaveLength(3);
  });
});
