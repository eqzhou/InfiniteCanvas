import { uid } from "@/lib/id";
import type {
  DirectorCamera,
  DirectorCameraEase,
  DirectorCameraKeyframe,
  DirectorCameraMove,
  DirectorScene,
  DirectorVector3,
} from "@/types/board";

function activeCamera(scene: DirectorScene): DirectorCamera {
  return scene.cameras.find((camera) => camera.id === scene.activeCameraId) ?? scene.cameras[0]!;
}

export const MAX_DIRECTOR_CAMERA_MOVES = 16;
export const MAX_DIRECTOR_CAMERA_KEYFRAMES = 16;
export const MIN_DIRECTOR_CAMERA_DURATION = 0.2;
export const MAX_DIRECTOR_CAMERA_DURATION = 120;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const EASES: readonly DirectorCameraEase[] = ["linear", "ease-in", "ease-out", "ease-in-out"];

function cloneVector(value: DirectorVector3): DirectorVector3 {
  return { x: value.x, y: value.y, z: value.z };
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function lerpVector(from: DirectorVector3, to: DirectorVector3, amount: number): DirectorVector3 {
  return {
    x: lerp(from.x, to.x, amount),
    y: lerp(from.y, to.y, amount),
    z: lerp(from.z, to.z, amount),
  };
}

function applyEase(amount: number, ease: DirectorCameraEase): number {
  const t = Math.min(1, Math.max(0, amount));
  if (ease === "ease-in") return t * t * t;
  if (ease === "ease-out") return 1 - (1 - t) ** 3;
  if (ease === "ease-in-out") return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
  return t;
}

export function stabilizeDirectorLook(
  position: DirectorVector3,
  target: DirectorVector3,
): { position: DirectorVector3; target: DirectorVector3 } {
  const horizontal = Math.hypot(target.x - position.x, target.z - position.z);
  if (horizontal >= 0.05) return { position: cloneVector(position), target: cloneVector(target) };
  const downward = target.y <= position.y;
  return {
    position: cloneVector(position),
    target: { x: target.x, y: target.y, z: target.z + (downward ? 0.08 : -0.08) },
  };
}

function cameraKeyframeFromCamera(camera: DirectorCamera, time: number, ease: DirectorCameraEase = "ease-in-out"): DirectorCameraKeyframe {
  const look = stabilizeDirectorLook(camera.position, camera.target);
  return {
    id: uid("kf"),
    time,
    position: look.position,
    target: look.target,
    focalLength: camera.focalLength,
    ease,
  };
}

function sortKeyframes(frames: readonly DirectorCameraKeyframe[]): DirectorCameraKeyframe[] {
  return [...frames].sort((left, right) => left.time - right.time || left.position.x - right.position.x);
}

export function addDirectorCameraMove(scene: DirectorScene): DirectorScene {
  if ((scene.cameraMoves?.length ?? 0) >= MAX_DIRECTOR_CAMERA_MOVES) return scene;
  const camera = activeCamera(scene);
  const move: DirectorCameraMove = {
    id: uid("move"),
    cameraId: camera.id,
    name: `运镜 ${(scene.cameraMoves?.length ?? 0) + 1}`,
    duration: 3,
    loop: false,
    keyframes: [
      cameraKeyframeFromCamera(camera, 0),
      cameraKeyframeFromCamera({
        ...camera,
        position: { x: camera.position.x + 1.5, y: camera.position.y, z: camera.position.z + 1.5 },
      }, 1),
    ],
  };
  return {
    ...scene,
    cameraMoves: [...(scene.cameraMoves ?? []), move],
    activeCameraMoveId: move.id,
  };
}

export function selectDirectorCameraMove(scene: DirectorScene, id: string | null): DirectorScene {
  if (id === scene.activeCameraMoveId) return scene;
  if (id !== null && !(scene.cameraMoves ?? []).some((move) => move.id === id)) return scene;
  return { ...scene, activeCameraMoveId: id };
}

export function updateDirectorCameraMove(
  scene: DirectorScene,
  id: string,
  patch: Partial<Pick<DirectorCameraMove, "name" | "duration" | "loop" | "cameraId">>,
): DirectorScene {
  let changed = false;
  const cameraMoves = (scene.cameraMoves ?? []).map((move) => {
    if (move.id !== id) return move;
    const name = patch.name === undefined ? move.name : patch.name.trim().slice(0, 100);
    const duration = patch.duration === undefined
      ? move.duration
      : !Number.isFinite(patch.duration)
        ? move.duration
        : Math.min(MAX_DIRECTOR_CAMERA_DURATION, Math.max(MIN_DIRECTOR_CAMERA_DURATION, patch.duration));
    const loop = patch.loop ?? move.loop;
    const cameraId = patch.cameraId ?? move.cameraId;
    if (!name || (patch.cameraId && !scene.cameras.some((camera) => camera.id === cameraId))) return move;
    if (name === move.name && duration === move.duration && loop === move.loop && cameraId === move.cameraId) return move;
    changed = true;
    return { ...move, name, duration, loop, cameraId };
  });
  return changed ? { ...scene, cameraMoves } : scene;
}

export function removeDirectorCameraMove(scene: DirectorScene, id: string): DirectorScene {
  const cameraMoves = (scene.cameraMoves ?? []).filter((move) => move.id !== id);
  if (cameraMoves.length === (scene.cameraMoves ?? []).length) return scene;
  return {
    ...scene,
    cameraMoves,
    activeCameraMoveId: scene.activeCameraMoveId === id
      ? cameraMoves[0]?.id ?? null
      : scene.activeCameraMoveId,
  };
}

export function cameraForDirectorKeyframe(
  scene: DirectorScene,
  cameraId: string,
  previewPose?: Pick<DirectorCamera, "position" | "target" | "focalLength"> | null,
): DirectorCamera {
  const bound = scene.cameras.find((camera) => camera.id === cameraId) ?? activeCamera(scene);
  const live = previewPose ?? (scene.viewMode === "director"
    ? { position: scene.directorView.position, target: scene.directorView.target, focalLength: bound.focalLength }
    : { position: bound.position, target: bound.target, focalLength: bound.focalLength });
  return { ...bound, ...live };
}

export function addDirectorCameraKeyframe(
  scene: DirectorScene,
  moveId: string,
  input: { time?: number; camera?: DirectorCamera } = {},
): DirectorScene {
  let changed = false;
  const cameraMoves = (scene.cameraMoves ?? []).map((move) => {
    if (move.id !== moveId || move.keyframes.length >= MAX_DIRECTOR_CAMERA_KEYFRAMES) return move;
    const time = Number.isFinite(input.time)
      ? Math.min(1, Math.max(0, input.time ?? 0.5))
      : Math.min(1, move.keyframes.length / (move.keyframes.length + 1));
    const camera = input.camera ?? activeCamera(scene);
    changed = true;
    return {
      ...move,
      keyframes: sortKeyframes([...move.keyframes, cameraKeyframeFromCamera(camera, time)]),
    };
  });
  return changed ? { ...scene, cameraMoves } : scene;
}

export function updateDirectorCameraKeyframe(
  scene: DirectorScene,
  moveId: string,
  index: number,
  patch: Partial<DirectorCameraKeyframe>,
): DirectorScene {
  let changed = false;
  const cameraMoves = (scene.cameraMoves ?? []).map((move) => {
    if (move.id !== moveId || index < 0 || index >= move.keyframes.length) return move;
    const current = move.keyframes[index]!;
    const next: DirectorCameraKeyframe = {
      id: current.id,
      time: patch.time === undefined || !Number.isFinite(patch.time) ? current.time : Math.min(1, Math.max(0, patch.time)),
      position: patch.position ? cloneVector(patch.position) : cloneVector(current.position),
      target: patch.target ? cloneVector(patch.target) : cloneVector(current.target),
      focalLength: patch.focalLength ?? current.focalLength,
      ease: patch.ease ?? current.ease,
    };
    const look = stabilizeDirectorLook(next.position, next.target);
    if (next.time === current.time && next.focalLength === current.focalLength && next.ease === current.ease
      && look.position.x === current.position.x && look.position.y === current.position.y && look.position.z === current.position.z
      && look.target.x === current.target.x && look.target.y === current.target.y && look.target.z === current.target.z) {
      return move;
    }
    changed = true;
    const keyframes = sortKeyframes(move.keyframes.map((frame, frameIndex) => (
      frameIndex === index ? { ...next, ...look } : frame
    )));
    return { ...move, keyframes };
  });
  return changed ? { ...scene, cameraMoves } : scene;
}

export function removeDirectorCameraKeyframe(scene: DirectorScene, moveId: string, index: number): DirectorScene {
  let changed = false;
  const cameraMoves = (scene.cameraMoves ?? []).map((move) => {
    if (move.id !== moveId || move.keyframes.length <= 2 || index < 0 || index >= move.keyframes.length) return move;
    changed = true;
    return { ...move, keyframes: move.keyframes.filter((_, frameIndex) => frameIndex !== index) };
  });
  return changed ? { ...scene, cameraMoves } : scene;
}

export function evaluateDirectorCameraMove(move: DirectorCameraMove, seconds: number): Pick<DirectorCamera, "position" | "target" | "focalLength"> {
  const duration = Math.max(move.duration, MIN_DIRECTOR_CAMERA_DURATION);
  let progress = seconds / duration;
  if (move.loop) {
    progress = ((progress % 1) + 1) % 1;
  } else {
    progress = Math.min(1, Math.max(0, progress));
  }
  return sampleDirectorCameraMove(move, progress);
}

export function sampleDirectorCameraMove(move: DirectorCameraMove, amount: number): Pick<DirectorCamera, "position" | "target" | "focalLength"> {
  const frames = sortKeyframes(move.keyframes);
  const t = Math.min(1, Math.max(0, amount));
  if (frames.length === 0) {
    return { position: { x: 0, y: 1, z: 1 }, target: { x: 0, y: 1, z: 0 }, focalLength: 50 };
  }
  if (t <= frames[0]!.time) {
    return { position: cloneVector(frames[0]!.position), target: cloneVector(frames[0]!.target), focalLength: frames[0]!.focalLength };
  }
  const last = frames[frames.length - 1]!;
  if (t >= last.time) {
    return { position: cloneVector(last.position), target: cloneVector(last.target), focalLength: last.focalLength };
  }
  const endIndex = frames.findIndex((frame) => frame.time >= t);
  const to = frames[endIndex]!;
  const from = frames[Math.max(0, endIndex - 1)]!;
  const span = Math.max(1e-6, to.time - from.time);
  const local = applyEase((t - from.time) / span, from.ease);
  return {
    position: lerpVector(from.position, to.position, local),
    target: lerpVector(from.target, to.target, local),
    focalLength: lerp(from.focalLength, to.focalLength, local),
  };
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${path} is outside the supported range`);
  }
  return value;
}

function parseVector(value: unknown, path: string): DirectorVector3 {
  const input = objectRecord(value, path);
  return {
    x: finite(input.x, `${path}.x`, -100_000, 100_000),
    y: finite(input.y, `${path}.y`, -100_000, 100_000),
    z: finite(input.z, `${path}.z`, -100_000, 100_000),
  };
}

export function parseDirectorCameraMoves(
  value: unknown,
  cameraIds: ReadonlySet<string>,
  path: string,
): DirectorCameraMove[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DIRECTOR_CAMERA_MOVES) {
    throw new Error(`${path} must contain 0-${MAX_DIRECTOR_CAMERA_MOVES} items`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const movePath = `${path}[${index}]`;
    const input = objectRecord(item, movePath);
    if (typeof input.id !== "string" || !ID_PATTERN.test(input.id) || seen.has(input.id)) {
      throw new Error(`${movePath}.id is invalid or duplicated`);
    }
    seen.add(input.id);
    if (typeof input.cameraId !== "string" || !cameraIds.has(input.cameraId)) {
      throw new Error(`${movePath}.cameraId references an unknown camera`);
    }
    if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.length > 100) {
      throw new Error(`${movePath}.name is invalid`);
    }
    if (typeof input.loop !== "boolean") throw new Error(`${movePath}.loop must be a boolean`);
    if (!Array.isArray(input.keyframes) || input.keyframes.length < 2 || input.keyframes.length > MAX_DIRECTOR_CAMERA_KEYFRAMES) {
      throw new Error(`${movePath}.keyframes must contain 2-${MAX_DIRECTOR_CAMERA_KEYFRAMES} items`);
    }
    const frameIds = new Set<string>();
    const keyframes = input.keyframes.map((frame, frameIndex): DirectorCameraKeyframe => {
      const framePath = `${movePath}.keyframes[${frameIndex}]`;
      const frameInput = objectRecord(frame, framePath);
      if (typeof frameInput.ease !== "string" || !EASES.includes(frameInput.ease as DirectorCameraEase)) {
        throw new Error(`${framePath}.ease is invalid`);
      }
      const look = stabilizeDirectorLook(
        parseVector(frameInput.position, `${framePath}.position`),
        parseVector(frameInput.target, `${framePath}.target`),
      );
      const id = typeof frameInput.id === "string" && ID_PATTERN.test(frameInput.id) && !frameIds.has(frameInput.id)
        ? frameInput.id
        : uid("kf");
      frameIds.add(id);
      return {
        id,
        time: finite(frameInput.time, `${framePath}.time`, 0, 1),
        position: look.position,
        target: look.target,
        focalLength: finite(frameInput.focalLength, `${framePath}.focalLength`, 1, 300),
        ease: frameInput.ease as DirectorCameraEase,
      };
    });
    return {
      id: input.id,
      cameraId: input.cameraId,
      name: input.name.trim(),
      duration: finite(input.duration, `${movePath}.duration`, MIN_DIRECTOR_CAMERA_DURATION, MAX_DIRECTOR_CAMERA_DURATION),
      loop: input.loop,
      keyframes: sortKeyframes(keyframes),
    };
  });
}

export function dropDirectorCameraMovesForCamera(scene: DirectorScene, cameraId: string): DirectorScene {
  const cameraMoves = (scene.cameraMoves ?? []).filter((move) => move.cameraId !== cameraId);
  if (cameraMoves.length === (scene.cameraMoves ?? []).length) return scene;
  return {
    ...scene,
    cameraMoves,
    activeCameraMoveId: cameraMoves.some((move) => move.id === scene.activeCameraMoveId)
      ? scene.activeCameraMoveId
      : cameraMoves[0]?.id ?? null,
  };
}
