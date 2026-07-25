import { describe, expect, test } from "bun:test";
import * as THREE from "three";

import {
  createDirectorCharacterRoot,
  createDirectorCrowdRoot,
  createDirectorPrimitiveRoot,
  directorObjectRenderSignature,
} from "./director-three-cast";
import {
  addDirectorCharacter,
  addDirectorCrowd,
  addDirectorPrimitive,
  createDefaultDirectorScene,
} from "./director-scene";
import { DIRECTOR_CHARACTER_PRESETS, DIRECTOR_POSE_PRESETS, DIRECTOR_PRIMITIVES } from "./director-cast";

function bounds(root: THREE.Object3D): number[] {
  const box = new THREE.Box3().setFromObject(root);
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].map((value) =>
    Math.round(value * 1000) / 1000
  );
}

describe("director procedural cast renderer", () => {
  test("renders eight distinct character silhouettes and twenty pose signatures", () => {
    const scene = createDefaultDirectorScene();
    const silhouettes = DIRECTOR_CHARACTER_PRESETS.map(({ id }) => {
      const next = addDirectorCharacter(scene, { preset: id, pose: "neutral", role: "actor" });
      return bounds(createDirectorCharacterRoot(next.objects.at(-1)!));
    });
    expect(new Set(silhouettes.map(JSON.stringify)).size).toBe(8);

    const poses = DIRECTOR_POSE_PRESETS.map(({ id }) => {
      const next = addDirectorCharacter(scene, { preset: "studio", pose: id, role: "actor" });
      const object = next.objects.at(-1)!;
      return directorObjectRenderSignature(object);
    });
    expect(new Set(poses).size).toBe(20);
  });

  test("renders every primitive with finite non-empty geometry", () => {
    const scene = createDefaultDirectorScene();
    for (const { id } of DIRECTOR_PRIMITIVES) {
      const object = addDirectorPrimitive(scene, id).objects.at(-1)!;
      const root = createDirectorPrimitiveRoot(object);
      const positions = (root as THREE.Mesh).geometry.getAttribute("position");
      expect(positions.count).toBeGreaterThan(0);
      expect([...positions.array].every(Number.isFinite)).toBe(true);
    }
  });

  test("renders a crowd as instanced meshes with deterministic finite matrices", () => {
    const scene = addDirectorCrowd(createDefaultDirectorScene(), {
      preset: "studio",
      pose: "neutral",
      rows: 4,
      columns: 7,
      spacingX: 1.2,
      spacingZ: 1.4,
      variation: true,
      seed: 33,
    });
    const object = scene.objects.at(-1)!;
    const root = createDirectorCrowdRoot(object);
    const meshes: THREE.InstancedMesh[] = [];
    root.traverse((child) => { if (child instanceof THREE.InstancedMesh) meshes.push(child); });

    expect(root.userData.directorPopulationCount).toBe(28);
    expect(meshes.length).toBeGreaterThan(0);
    expect(meshes.reduce((total, mesh) => total + mesh.count, 0)).toBe(56);
    expect(meshes.every((mesh) => [...mesh.instanceMatrix.array].every(Number.isFinite))).toBe(true);
    expect(meshes.some((mesh) => mesh.count > 1)).toBe(true);
  });
});
