import { describe, expect, test } from "bun:test";

import {
  addDirectorCameraKeyframe,
  addDirectorCameraMove,
  cameraForDirectorKeyframe,
  evaluateDirectorCameraMove,
  parseDirectorCameraMoves,
  removeDirectorCameraMove,
  sampleDirectorCameraMove,
  stabilizeDirectorLook,
  updateDirectorCameraMove,
} from "./director-camera-move";
import { addDirectorCamera, createDefaultDirectorScene, parseDirectorScene, removeDirectorCamera } from "./director-scene";

describe("director camera look stabilization", () => {
  test("offsets a vertical top-down look so yaw stays defined", () => {
    const look = stabilizeDirectorLook({ x: 0, y: 12, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(look.position).toEqual({ x: 0, y: 12, z: 0 });
    expect(Math.hypot(look.target.x - look.position.x, look.target.z - look.position.z)).toBeGreaterThan(0.04);
    expect(look.target.y).toBe(0);
  });

  test("leaves an already-horizontal look unchanged", () => {
    const position = { x: 6, y: 4, z: 8 };
    const target = { x: 0, y: 1, z: 0 };
    expect(stabilizeDirectorLook(position, target)).toEqual({ position, target });
  });

  test("applies the same guard when adding a top-down camera", () => {
    const scene = createDefaultDirectorScene();
    const topDown = {
      ...scene,
      cameras: scene.cameras.map((camera) => ({
        ...camera,
        position: { x: 0, y: 10, z: 0 },
        target: { x: 0, y: 0, z: 0 },
      })),
    };
    const added = addDirectorCamera(topDown);
    const created = added.cameras.find((camera) => camera.id !== scene.activeCameraId)!;
    expect(Math.hypot(created.target.x - created.position.x, created.target.z - created.position.z)).toBeGreaterThan(0.04);
  });
});

describe("director camera moves", () => {
  test("creates an immutable two-keyframe move from the active camera", () => {
    const scene = createDefaultDirectorScene();
    const next = addDirectorCameraMove(scene);
    expect(next).not.toBe(scene);
    expect(scene.cameraMoves).toEqual([]);
    expect(next.cameraMoves).toHaveLength(1);
    expect(next.activeCameraMoveId).toBe(next.cameraMoves[0]!.id);
    expect(next.cameraMoves[0]!.cameraId).toBe(scene.activeCameraId);
    expect(next.cameraMoves[0]!.keyframes).toHaveLength(2);
    expect(next.cameraMoves[0]!.keyframes[0]!.id).toBeTruthy();
    expect(next.cameraMoves[0]!.keyframes[0]!.id).not.toBe(next.cameraMoves[0]!.keyframes[1]!.id);
    expect(next.cameraMoves[0]!.keyframes[0]!.time).toBe(0);
    expect(next.cameraMoves[0]!.keyframes[1]!.time).toBe(1);
  });

  test("samples ease-in-out slower at the start than a linear move", () => {
    const scene = addDirectorCameraMove(createDefaultDirectorScene());
    const move = scene.cameraMoves[0]!;
    const linear = { ...move, keyframes: move.keyframes.map((frame) => ({ ...frame, ease: "linear" as const })) };
    const eased = { ...move, keyframes: move.keyframes.map((frame) => ({ ...frame, ease: "ease-in-out" as const })) };
    linear.keyframes[1] = { ...linear.keyframes[1]!, position: { x: 10, y: 4, z: 8 } };
    eased.keyframes[1] = { ...eased.keyframes[1]!, position: { x: 10, y: 4, z: 8 } };
    const linearEarly = evaluateDirectorCameraMove(linear, linear.duration * 0.25);
    const easedEarly = evaluateDirectorCameraMove(eased, eased.duration * 0.25);
    expect(easedEarly.position.x).toBeLessThan(linearEarly.position.x);
    expect(sampleDirectorCameraMove(eased, 0).position).toEqual(eased.keyframes[0]!.position);
    expect(sampleDirectorCameraMove(eased, 1).position).toEqual(eased.keyframes[1]!.position);
  });

  test("records the live director view and inserts later keyframes after the last gap", () => {
    const scene = addDirectorCameraMove(createDefaultDirectorScene());
    const moveId = scene.cameraMoves[0]!.id;
    const live = cameraForDirectorKeyframe({
      ...scene,
      viewMode: "director",
      directorView: { position: { x: 9, y: 6, z: 11 }, target: { x: 1, y: 2, z: 3 } },
    }, scene.activeCameraId);
    expect(live.position).toEqual({ x: 9, y: 6, z: 11 });
    const keyed = addDirectorCameraKeyframe(scene, moveId, { camera: live });
    expect(keyed.cameraMoves[0]!.keyframes).toHaveLength(3);
    expect(keyed.cameraMoves[0]!.keyframes.map((frame) => frame.time)).toEqual([0, 2 / 3, 1]);
    expect(keyed.cameraMoves[0]!.keyframes[1]?.position).toEqual(live.position);
  });

  test("adds, updates, and removes moves without mutating the original scene", () => {
    const scene = addDirectorCameraMove(createDefaultDirectorScene());
    const moveId = scene.cameraMoves[0]!.id;
    const keyed = addDirectorCameraKeyframe(scene, moveId, { time: 0.5 });
    expect(keyed.cameraMoves[0]!.keyframes).toHaveLength(3);
    expect(scene.cameraMoves[0]!.keyframes).toHaveLength(2);
    const renamed = updateDirectorCameraMove(keyed, moveId, { name: "Push in", duration: 4 });
    expect(renamed.cameraMoves[0]).toMatchObject({ name: "Push in", duration: 4 });
    const cleared = removeDirectorCameraMove(renamed, moveId);
    expect(cleared.cameraMoves).toEqual([]);
    expect(cleared.activeCameraMoveId).toBeNull();
    expect(updateDirectorCameraMove(scene, moveId, { duration: Number.NaN })).toBe(scene);
  });

  test("round-trips optional camera moves and rejects unknown cameras", () => {
    const scene = addDirectorCameraMove(createDefaultDirectorScene());
    const parsed = parseDirectorScene(JSON.parse(JSON.stringify(scene)));
    expect(parsed.cameraMoves).toHaveLength(1);
    expect(parsed.cameraMoves[0]!.id).toBe(scene.cameraMoves[0]!.id);
    expect(() => parseDirectorCameraMoves([{
      ...scene.cameraMoves[0],
      cameraId: "missing",
    }], new Set(scene.cameras.map((camera) => camera.id)), "directorScene.cameraMoves")).toThrow("cameraId");
  });

  test("drops moves bound to a removed camera", () => {
    const scene = addDirectorCameraMove(createDefaultDirectorScene());
    const extra = addDirectorCamera(scene);
    const withMove = addDirectorCameraMove(extra);
    const extraId = extra.cameras.find((camera) => camera.id !== scene.activeCameraId)!.id;
    expect(withMove.cameraMoves.some((move) => move.cameraId === extraId)).toBe(true);
    const cleared = removeDirectorCamera(withMove, extraId);
    expect(cleared.cameraMoves.every((move) => move.cameraId !== extraId)).toBe(true);
    expect(() => parseDirectorScene(JSON.parse(JSON.stringify(cleared)))).not.toThrow();
  });
});
