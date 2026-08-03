import type {
  DirectorCamera,
  DirectorObject,
  DirectorScene,
  DirectorShotSnapshot,
  DirectorVector3,
} from "@/types/board";
import { parseDirectorScene } from "@/lib/director-scene";

const MAX_SHOT_OBJECTS = 64;

export function createDirectorShotSnapshot(
  scene: DirectorScene,
  directorNodeId: string,
  cameraId = scene.activeCameraId,
): DirectorShotSnapshot {
  const camera = scene.cameras.find((candidate) => candidate.id === cameraId);
  if (!camera) throw new Error("当前机位不存在");
  const visible = scene.objects.filter((object) => object.visible);
  return {
    version: 1,
    directorNodeId,
    camera: structuredClone(camera),
    background: scene.background.slice(0, 100),
    environment: structuredClone(scene.environment),
    objects: visible.slice(0, MAX_SHOT_OBJECTS).map((object) => ({
      id: object.id,
      kind: object.kind,
      name: object.name.slice(0, 100),
      transform: structuredClone(object.transform),
      character: object.character ? structuredClone(object.character) : undefined,
      crowd: object.crowd ? structuredClone(object.crowd) : undefined,
      primitive: object.primitive,
      modelAsset: object.modelAsset ? structuredClone(object.modelAsset) : undefined,
    })),
    omittedObjectCount: Math.max(0, visible.length - MAX_SHOT_OBJECTS),
  };
}

/** Reuse the strict scene parser by embedding the compact snapshot in a bounded scene shell. */
export function parseDirectorShotSnapshot(value: unknown): DirectorShotSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导演台镜头快照无效");
  const input = value as Partial<DirectorShotSnapshot>;
  if (input.version !== 1 || typeof input.directorNodeId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(input.directorNodeId) ||
      typeof input.background !== "string" || input.background.length > 100 ||
      !Number.isSafeInteger(input.omittedObjectCount) || input.omittedObjectCount! < 0 ||
      input.omittedObjectCount! > 10_000 || !Array.isArray(input.objects) || input.objects.length > MAX_SHOT_OBJECTS ||
      !input.camera || !input.environment) {
    throw new Error("导演台镜头快照无效");
  }
  const camera = input.camera as DirectorCamera;
  const objects = input.objects as DirectorObject[];
  const shell = parseDirectorScene({
    version: 4,
    background: input.background,
    showGroundGrid: false,
    showRuleOfThirds: false,
    showSafeFrame: false,
    viewMode: "camera",
    directorView: { position: camera.position, target: camera.target },
    selectedObjectId: null,
    activeCameraId: camera.id,
    cameras: [camera],
    environment: input.environment,
    objects: objects.map((object) => ({ ...object, visible: true, locked: false, color: "#ffffff", intensity: 1 })),
  });
  return {
    version: 1,
    directorNodeId: input.directorNodeId,
    camera: structuredClone(shell.cameras[0]!),
    background: shell.background,
    environment: structuredClone(shell.environment),
    objects: shell.objects.map(({ id, kind, name, transform, character, crowd, primitive, modelAsset }) => ({
      id, kind, name, transform, character, crowd, primitive, modelAsset,
    })),
    omittedObjectCount: input.omittedObjectCount!,
  };
}

function vector(value: DirectorVector3): string {
  return `(${value.x.toFixed(2)}, ${value.y.toFixed(2)}, ${value.z.toFixed(2)})`;
}

export function buildDirectorShotPrompt(snapshot: DirectorShotSnapshot): string {
  const camera = snapshot.camera;
  const objectSummary = snapshot.objects.map((object) =>
    `${object.name}（${object.kind}，位置 ${vector(object.transform.position)}）`);
  const omitted = snapshot.omittedObjectCount > 0 ? `；另有 ${snapshot.omittedObjectCount} 个可见对象` : "";
  return [
    "以导演台截图作为构图和角色关系参考，生成可用于后续制作的正式镜头。",
    `机位：${camera.name}，${camera.focalLength}mm，光圈 f/${camera.aperture}，画幅 ${camera.aspect}。`,
    `摄像机位置 ${vector(camera.position)}，朝向目标 ${vector(camera.target)}。`,
    objectSummary.length ? `场景对象：${objectSummary.join("；")}${omitted}。` : "场景中没有可见角色或物体。",
    "保持当前角色与物体的空间关系、镜头方向和画面主体位置；除非用户补充，不额外指定视觉风格。",
  ].join("\n").slice(0, 20_000);
}
