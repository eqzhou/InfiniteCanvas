import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { DirectorObject, DirectorPrimitive, DirectorVector3 } from "@/types/board";
import {
  buildDirectorCrowdPlacements,
  getDirectorCharacterPreset,
  getDirectorPosePreset,
} from "@/lib/director-cast";

function transformed(
  geometry: THREE.BufferGeometry,
  position: DirectorVector3,
  rotation: DirectorVector3 = { x: 0, y: 0, z: 0 },
  scale: DirectorVector3 = { x: 1, y: 1, z: 1 },
): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z),
    )),
    new THREE.Vector3(scale.x, scale.y, scale.z),
  );
  return geometry.applyMatrix4(matrix);
}

function limbGeometry(
  pivot: DirectorVector3,
  rotation: DirectorVector3,
  length: number,
  radius: number,
): THREE.BufferGeometry {
  const geometry = new THREE.CapsuleGeometry(radius, length, 4, 8);
  const matrix = new THREE.Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(rotation.x),
      THREE.MathUtils.degToRad(rotation.y),
      THREE.MathUtils.degToRad(rotation.z),
    )))
    .multiply(new THREE.Matrix4().makeTranslation(0, -(length + radius * 2) / 2, 0));
  return geometry.applyMatrix4(matrix);
}

function characterGeometries(object: DirectorObject): {
  outfit: THREE.BufferGeometry;
  skin: THREE.BufferGeometry;
} {
  if (!object.character) throw new Error("Character configuration is missing");
  const preset = getDirectorCharacterPreset(object.character.preset);
  const pose = getDirectorPosePreset(object.character.pose);
  const yOffset = -(pose.rootY ?? 0);
  const body = preset.bodyScale;
  const outfitParts: THREE.BufferGeometry[] = [
    transformed(
      new THREE.CapsuleGeometry(0.38, 1.05, 6, 12),
      { x: 0, y: 1.22 * body.y + yOffset, z: 0 },
      pose.joints.torso,
      body,
    ),
  ];
  const shoulder = 0.52 * preset.shoulderWidth * body.x;
  const armLength = 0.78 * preset.limbScale * body.y;
  const legLength = 0.82 * preset.limbScale * body.y;
  outfitParts.push(
    limbGeometry({ x: -shoulder, y: 1.72 * body.y + yOffset, z: 0 }, pose.joints.leftArm, armLength, 0.105 * body.x),
    limbGeometry({ x: shoulder, y: 1.72 * body.y + yOffset, z: 0 }, pose.joints.rightArm, armLength, 0.105 * body.x),
    limbGeometry({ x: -0.22 * body.x, y: 0.76 * body.y + yOffset, z: 0 }, pose.joints.leftLeg, legLength, 0.12 * body.x),
    limbGeometry({ x: 0.22 * body.x, y: 0.76 * body.y + yOffset, z: 0 }, pose.joints.rightLeg, legLength, 0.12 * body.x),
  );
  if (preset.accessory === "jacket") {
    outfitParts.push(transformed(new THREE.BoxGeometry(0.9, 0.7, 0.5), { x: 0, y: 1.3 * body.y + yOffset, z: 0 }, pose.joints.torso, { x: body.x, y: body.y, z: body.z }));
  } else if (preset.accessory === "belt") {
    outfitParts.push(transformed(new THREE.TorusGeometry(0.34 * body.x, 0.055, 6, 16), { x: 0, y: 0.92 * body.y + yOffset, z: 0 }, { x: 90, y: 0, z: 0 }));
  } else if (preset.accessory === "visor") {
    outfitParts.push(transformed(new THREE.BoxGeometry(0.5, 0.12, 0.12), { x: 0, y: 2.22 * body.y + yOffset, z: 0.28 }, pose.joints.head));
  }
  const head = transformed(
    new THREE.SphereGeometry(0.34, 16, 12),
    { x: 0, y: 2.18 * body.y + yOffset, z: 0 },
    pose.joints.head,
    { x: preset.headScale, y: preset.headScale, z: preset.headScale },
  );
  const outfit = mergeGeometries(outfitParts, false);
  if (!outfit) throw new Error("Character geometry could not be merged");
  return { outfit, skin: head };
}

export function createDirectorCharacterRoot(object: DirectorObject): THREE.Group {
  if (object.kind !== "character" || !object.character) throw new Error("Expected a character object");
  const preset = getDirectorCharacterPreset(object.character.preset);
  const geometries = characterGeometries(object);
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(geometries.outfit, new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.72 })),
    new THREE.Mesh(geometries.skin, new THREE.MeshStandardMaterial({ color: preset.skinColor, roughness: 0.82 })),
  );
  return group;
}

function primitiveGeometry(primitive: DirectorPrimitive): THREE.BufferGeometry {
  if (primitive === "box") return new THREE.BoxGeometry(1, 1, 1);
  if (primitive === "sphere") return new THREE.SphereGeometry(0.65, 24, 16);
  if (primitive === "cylinder") return new THREE.CylinderGeometry(0.55, 0.55, 1.2, 24);
  if (primitive === "cone") return new THREE.ConeGeometry(0.65, 1.3, 24);
  if (primitive === "torus") return new THREE.TorusGeometry(0.65, 0.2, 12, 32);
  return new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2);
}

export function createDirectorPrimitiveRoot(object: DirectorObject): THREE.Mesh {
  if (object.kind !== "prop" || !object.primitive) throw new Error("Expected a primitive object");
  return new THREE.Mesh(
    primitiveGeometry(object.primitive),
    new THREE.MeshStandardMaterial({ color: object.color, roughness: 0.62, side: THREE.DoubleSide }),
  );
}

export function createDirectorCrowdRoot(object: DirectorObject): THREE.Group {
  if (object.kind !== "crowd" || !object.crowd) throw new Error("Expected a crowd object");
  const root = new THREE.Group();
  const placements = buildDirectorCrowdPlacements(object.crowd);
  root.userData.directorPopulationCount = placements.length;
  const groups = new Map<string, typeof placements>();
  for (const placement of placements) {
    const key = `${placement.preset}|${placement.pose}`;
    const group = groups.get(key);
    if (group) {
      group.push(placement);
    } else {
      groups.set(key, [placement]);
    }
  }
  const matrix = new THREE.Matrix4();
  for (const [key, members] of groups) {
    const [presetId, poseId] = key.split("|") as [typeof members[number]["preset"], typeof members[number]["pose"]];
    const template: DirectorObject = {
      ...object,
      kind: "character",
      character: { preset: presetId, pose: poseId, role: "extra" },
      crowd: undefined,
    };
    const preset = getDirectorCharacterPreset(presetId);
    const geometries = characterGeometries(template);
    const outfit = new THREE.InstancedMesh(
      geometries.outfit,
      new THREE.MeshStandardMaterial({ color: object.crowd.variation ? preset.outfitColor : object.color, roughness: 0.74 }),
      members.length,
    );
    const skin = new THREE.InstancedMesh(
      geometries.skin,
      new THREE.MeshStandardMaterial({ color: preset.skinColor, roughness: 0.82 }),
      members.length,
    );
    members.forEach((member, index) => {
      matrix.compose(
        new THREE.Vector3(member.x, 0, member.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(member.rotationY), 0)),
        new THREE.Vector3(1, 1, 1),
      );
      outfit.setMatrixAt(index, matrix);
      skin.setMatrixAt(index, matrix);
    });
    outfit.instanceMatrix.needsUpdate = true;
    skin.instanceMatrix.needsUpdate = true;
    outfit.computeBoundingBox();
    outfit.computeBoundingSphere();
    skin.computeBoundingBox();
    skin.computeBoundingSphere();
    root.add(outfit, skin);
  }
  return root;
}

export function directorObjectRenderSignature(object: DirectorObject): string {
  if (object.kind === "character") return `character|${object.color}|${JSON.stringify(object.character)}`;
  if (object.kind === "crowd") return `crowd|${object.color}|${JSON.stringify(object.crowd)}`;
  if (object.kind === "prop") return `prop|${object.color}|${object.primitive}`;
  if (object.kind === "light") return `light|${object.color}|${object.intensity}`;
  return `model|${object.modelAsset?.assetId ?? "missing"}`;
}
