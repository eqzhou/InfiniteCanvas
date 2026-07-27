import { uid } from "@/lib/id";
import type {
  DirectorCamera,
  DirectorCharacterConfig,
  DirectorCrowdConfig,
  DirectorModelAssetRef,
  DirectorObject,
  DirectorObjectKind,
  DirectorScene,
  DirectorPrimitive,
  DirectorTransform,
  DirectorVector3,
} from "@/types/board";
import {
  DEFAULT_CHARACTER_CONFIG,
  DEFAULT_CROWD_CONFIG,
  getDirectorCharacterPreset,
  isDirectorCharacterPreset,
  isDirectorPosePreset,
  isDirectorPrimitive,
} from "@/lib/director-cast";

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const MAX_OBJECTS = 200;
const MAX_CAMERAS = 32;
const MAX_MODELS = 32;
const MAX_CROWDS = 32;
const MAX_CROWD_INSTANCES = 1_024;
const MAX_SCENE_POPULATION = 4_096;
const MAX_CROWD_RENDER_BATCHES = 128;
const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,160}\.glb$/i;

const vector = (x: number, y: number, z: number): DirectorVector3 => ({ x, y, z });

function defaultTransform(position = vector(0, 0, 0)): DirectorTransform {
  return {
    position: { ...position },
    rotation: vector(0, 0, 0),
    scale: vector(1, 1, 1),
  };
}

type BuiltInDirectorObjectKind = Exclude<DirectorObjectKind, "model" | "crowd">;

function createObject(kind: BuiltInDirectorObjectKind, index: number): DirectorObject {
  const presets: Record<BuiltInDirectorObjectKind, Omit<DirectorObject, "id" | "kind">> = {
    character: {
      name: `角色 ${index}`,
      visible: true,
      locked: false,
      color: "#d1d5db",
      intensity: 1,
      transform: defaultTransform(vector((index - 1) * 1.5, 0, 0)),
      character: { ...DEFAULT_CHARACTER_CONFIG },
    },
    prop: {
      name: `道具 ${index}`,
      visible: true,
      locked: false,
      color: "#818cf8",
      intensity: 1,
      transform: defaultTransform(vector((index - 1) * 1.25, 0.5, -1)),
      primitive: "box",
    },
    light: {
      name: `灯光 ${index}`,
      visible: true,
      locked: false,
      color: "#fff7d6",
      intensity: 2.5,
      transform: defaultTransform(vector(3, 5, 4)),
    },
  };
  return { id: uid(kind), kind, ...structuredClone(presets[kind]) };
}

export function createDefaultDirectorScene(): DirectorScene {
  const character = createObject("character", 1);
  const light = createObject("light", 1);
  const camera: DirectorCamera = {
    id: "camera_main",
    name: "主摄像机",
    position: vector(6, 4, 8),
    target: vector(0, 1, 0),
    focalLength: 50,
    aperture: 2.8,
    aspect: "16:9",
  };
  return {
    version: 4,
    background: "#111827",
    showGroundGrid: true,
    showRuleOfThirds: false,
    showSafeFrame: false,
    viewMode: "director",
    directorView: {
      position: vector(10, 7, 12),
      target: vector(0, 1, 0),
    },
    selectedObjectId: character.id,
    activeCameraId: camera.id,
    cameras: [camera],
    environment: { rotationY: 0, intensity: 1 },
    objects: [character, light],
  };
}

export function getActiveDirectorCamera(scene: DirectorScene): DirectorCamera {
  return scene.cameras.find((camera) => camera.id === scene.activeCameraId) ?? scene.cameras[0]!;
}

export function addDirectorCamera(scene: DirectorScene): DirectorScene {
  if (scene.cameras.length >= MAX_CAMERAS) return scene;
  const active = getActiveDirectorCamera(scene);
  const camera: DirectorCamera = {
    ...structuredClone(active),
    id: uid("camera"),
    name: `机位 ${scene.cameras.length + 1}`,
  };
  return { ...scene, cameras: [...scene.cameras, camera], activeCameraId: camera.id };
}

export function selectDirectorCamera(scene: DirectorScene, id: string): DirectorScene {
  if (id === scene.activeCameraId || !scene.cameras.some((camera) => camera.id === id)) return scene;
  return { ...scene, activeCameraId: id };
}

export function renameDirectorCamera(scene: DirectorScene, id: string, name: string): DirectorScene {
  const normalized = name.trim().slice(0, 100);
  if (!normalized) return scene;
  let changed = false;
  const cameras = scene.cameras.map((camera) => {
    if (camera.id !== id || camera.name === normalized) return camera;
    changed = true;
    return { ...camera, name: normalized };
  });
  return changed ? { ...scene, cameras } : scene;
}

export function removeDirectorCamera(scene: DirectorScene, id: string): DirectorScene {
  if (scene.cameras.length <= 1 || !scene.cameras.some((camera) => camera.id === id)) return scene;
  const cameras = scene.cameras.filter((camera) => camera.id !== id);
  return {
    ...scene,
    cameras,
    activeCameraId: scene.activeCameraId === id ? cameras[0]!.id : scene.activeCameraId,
  };
}

export function setDirectorViewMode(scene: DirectorScene, viewMode: DirectorScene["viewMode"]): DirectorScene {
  return scene.viewMode === viewMode ? scene : { ...scene, viewMode };
}

export function updateDirectorView(
  scene: DirectorScene,
  patch: Partial<DirectorScene["directorView"]>,
): DirectorScene {
  return {
    ...scene,
    directorView: {
      position: patch.position ? { ...patch.position } : { ...scene.directorView.position },
      target: patch.target ? { ...patch.target } : { ...scene.directorView.target },
    },
  };
}

export function addDirectorObject(scene: DirectorScene, kind: BuiltInDirectorObjectKind): DirectorScene {
  if (scene.objects.length >= MAX_OBJECTS) return scene;
  const count = scene.objects.filter((object) => object.kind === kind).length + 1;
  const object = createObject(kind, count);
  return { ...scene, objects: [...scene.objects, object], selectedObjectId: object.id };
}

function normalizeCharacterConfig(value: DirectorCharacterConfig): DirectorCharacterConfig {
  if (!isDirectorCharacterPreset(value.preset)) throw new Error("character.preset is invalid");
  if (!isDirectorPosePreset(value.pose)) throw new Error("character.pose is invalid");
  if (value.role !== "actor" && value.role !== "extra") throw new Error("character.role is invalid");
  return { preset: value.preset, pose: value.pose, role: value.role };
}

function normalizeCrowdConfig(value: DirectorCrowdConfig): DirectorCrowdConfig {
  if (!isDirectorCharacterPreset(value.preset)) throw new Error("crowd.preset is invalid");
  if (!isDirectorPosePreset(value.pose)) throw new Error("crowd.pose is invalid");
  if (!Number.isInteger(value.rows) || value.rows < 1 || value.rows > 64 ||
      !Number.isInteger(value.columns) || value.columns < 1 || value.columns > 64 ||
      value.rows * value.columns > MAX_CROWD_INSTANCES) {
    throw new Error(`crowd layout exceeds ${MAX_CROWD_INSTANCES} people`);
  }
  if (!Number.isFinite(value.spacingX) || value.spacingX < 0.1 || value.spacingX > 100 ||
      !Number.isFinite(value.spacingZ) || value.spacingZ < 0.1 || value.spacingZ > 100) {
    throw new Error("crowd spacing is invalid");
  }
  if (typeof value.variation !== "boolean") throw new Error("crowd.variation must be a boolean");
  if (!Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 0x7fffffff) throw new Error("crowd.seed is invalid");
  return { ...value };
}

export function getDirectorPopulation(scene: DirectorScene): number {
  return scene.objects.reduce((total, object) => total + (object.kind === "character"
    ? 1
    : object.kind === "crowd" && object.crowd
      ? object.crowd.rows * object.crowd.columns
      : 0), 0);
}

function crowdRenderBatches(crowd: DirectorCrowdConfig): number {
  return crowd.variation ? Math.min(crowd.rows * crowd.columns, 41) : 1;
}

function getDirectorCrowdRenderBatches(scene: DirectorScene): number {
  return scene.objects.reduce((total, object) => total + (
    object.kind === "crowd" && object.crowd ? crowdRenderBatches(object.crowd) : 0
  ), 0);
}

export function addDirectorCharacter(
  scene: DirectorScene,
  config: DirectorCharacterConfig = DEFAULT_CHARACTER_CONFIG,
): DirectorScene {
  if (scene.objects.length >= MAX_OBJECTS || getDirectorPopulation(scene) >= MAX_SCENE_POPULATION) return scene;
  const safe = normalizeCharacterConfig(config);
  const count = scene.objects.filter((object) => object.kind === "character").length + 1;
  const preset = getDirectorCharacterPreset(safe.preset);
  const object: DirectorObject = {
    id: uid("character"),
    kind: "character",
    name: `${safe.role === "extra" ? "群演" : "角色"} ${count}`,
    visible: true,
    locked: false,
    color: preset.outfitColor,
    intensity: 1,
    transform: defaultTransform(vector((count - 1) * 1.5, 0, 0)),
    character: safe,
  };
  return { ...scene, objects: [...scene.objects, object], selectedObjectId: object.id };
}

export function updateDirectorCharacter(
  scene: DirectorScene,
  id: string,
  patch: Partial<DirectorCharacterConfig>,
): DirectorScene {
  let changed = false;
  const objects = scene.objects.map((object) => {
    if (object.id !== id || object.kind !== "character" || !object.character) return object;
    const character = normalizeCharacterConfig({ ...object.character, ...patch });
    if (JSON.stringify(character) === JSON.stringify(object.character)) return object;
    changed = true;
    return { ...object, character };
  });
  return changed ? { ...scene, objects } : scene;
}

export function addDirectorPrimitive(scene: DirectorScene, primitive: DirectorPrimitive): DirectorScene {
  if (scene.objects.length >= MAX_OBJECTS) return scene;
  if (!isDirectorPrimitive(primitive)) throw new Error("primitive is invalid");
  const count = scene.objects.filter((object) => object.kind === "prop").length + 1;
  const object: DirectorObject = {
    id: uid("prop"),
    kind: "prop",
    name: `几何体 ${count}`,
    visible: true,
    locked: false,
    color: "#818cf8",
    intensity: 1,
    transform: defaultTransform(vector((count - 1) * 1.25, 0.5, -1)),
    primitive,
  };
  return { ...scene, objects: [...scene.objects, object], selectedObjectId: object.id };
}

export function updateDirectorPrimitive(scene: DirectorScene, id: string, primitive: DirectorPrimitive): DirectorScene {
  if (!isDirectorPrimitive(primitive)) throw new Error("primitive is invalid");
  let changed = false;
  const objects = scene.objects.map((object) => {
    if (object.id !== id || object.kind !== "prop" || object.primitive === primitive) return object;
    changed = true;
    return { ...object, primitive };
  });
  return changed ? { ...scene, objects } : scene;
}

export function addDirectorCrowd(
  scene: DirectorScene,
  config: DirectorCrowdConfig = DEFAULT_CROWD_CONFIG,
): DirectorScene {
  if (scene.objects.length >= MAX_OBJECTS || scene.objects.filter((object) => object.kind === "crowd").length >= MAX_CROWDS) return scene;
  const crowd = normalizeCrowdConfig(config);
  if (getDirectorPopulation(scene) + crowd.rows * crowd.columns > MAX_SCENE_POPULATION) return scene;
  if (getDirectorCrowdRenderBatches(scene) + crowdRenderBatches(crowd) > MAX_CROWD_RENDER_BATCHES) return scene;
  const count = scene.objects.filter((object) => object.kind === "crowd").length + 1;
  const object: DirectorObject = {
    id: uid("crowd"),
    kind: "crowd",
    name: `群众阵列 ${count}`,
    visible: true,
    locked: false,
    color: getDirectorCharacterPreset(crowd.preset).outfitColor,
    intensity: 1,
    transform: defaultTransform(vector(0, 0, -2)),
    crowd,
  };
  return { ...scene, objects: [...scene.objects, object], selectedObjectId: object.id };
}

export function updateDirectorCrowd(
  scene: DirectorScene,
  id: string,
  patch: Partial<DirectorCrowdConfig>,
): DirectorScene {
  const target = scene.objects.find((object) => object.id === id && object.kind === "crowd");
  if (!target?.crowd) return scene;
  const crowd = normalizeCrowdConfig({ ...target.crowd, ...patch });
  const priorCount = target.crowd.rows * target.crowd.columns;
  if (getDirectorPopulation(scene) - priorCount + crowd.rows * crowd.columns > MAX_SCENE_POPULATION) return scene;
  if (getDirectorCrowdRenderBatches(scene) - crowdRenderBatches(target.crowd) + crowdRenderBatches(crowd) > MAX_CROWD_RENDER_BATCHES) return scene;
  if (JSON.stringify(crowd) === JSON.stringify(target.crowd)) return scene;
  return {
    ...scene,
    objects: scene.objects.map((object) => object.id === id ? { ...object, crowd } : object),
  };
}

function normalizeModelAsset(asset: DirectorModelAssetRef): DirectorModelAssetRef {
  if (!ID_PATTERN.test(asset.assetId)) throw new Error("modelAsset.assetId is invalid");
  const fileName = asset.fileName.trim();
  if (!SAFE_FILE_NAME.test(fileName) || fileName === ".glb") throw new Error("modelAsset.fileName is invalid");
  if (!Number.isInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_MODEL_BYTES) {
    throw new Error("modelAsset.bytes is outside the supported range");
  }
  return { assetId: asset.assetId, fileName, bytes: asset.bytes };
}

export function addDirectorModel(scene: DirectorScene, asset: DirectorModelAssetRef, objectId = uid("model")): DirectorScene {
  if (scene.objects.length >= MAX_OBJECTS || scene.objects.filter((object) => object.kind === "model").length >= MAX_MODELS) return scene;
  if (!ID_PATTERN.test(objectId) || scene.objects.some((object) => object.id === objectId)) {
    throw new Error("model object id is invalid or duplicated");
  }
  const modelAsset = normalizeModelAsset(asset);
  const baseName = modelAsset.fileName.replace(/\.glb$/i, "").trim() || "模型";
  const object: DirectorObject = {
    id: objectId,
    kind: "model",
    name: baseName.slice(0, 100),
    visible: true,
    locked: false,
    color: "#94a3b8",
    intensity: 1,
    transform: defaultTransform(),
    modelAsset,
  };
  return { ...scene, objects: [...scene.objects, object], selectedObjectId: object.id };
}

export function relinkDirectorModel(
  scene: DirectorScene,
  id: string,
  replacement: DirectorModelAssetRef,
): DirectorScene {
  let changed = false;
  const objects = scene.objects.map((object) => {
    if (object.id !== id || object.kind !== "model" || !object.modelAsset) return object;
    const modelAsset = normalizeModelAsset(replacement);
    if (modelAsset.assetId === object.modelAsset.assetId && modelAsset.fileName === object.modelAsset.fileName && modelAsset.bytes === object.modelAsset.bytes) return object;
    changed = true;
    return { ...object, modelAsset };
  });
  return changed ? { ...scene, objects } : scene;
}

export function setDirectorObjectLocked(scene: DirectorScene, id: string, locked: boolean): DirectorScene {
  let changed = false;
  const objects = scene.objects.map((object) => {
    if (object.id !== id || object.locked === locked) return object;
    changed = true;
    return { ...object, locked };
  });
  return changed ? { ...scene, objects } : scene;
}

export function removeDirectorObject(scene: DirectorScene, id: string): DirectorScene {
  const objects = scene.objects.filter((object) => object.id !== id);
  if (objects.length === scene.objects.length) return scene;
  return {
    ...scene,
    objects,
    selectedObjectId: scene.selectedObjectId === id ? objects[0]?.id ?? null : scene.selectedObjectId,
  };
}

export function updateDirectorObjectTransform(
  scene: DirectorScene,
  id: string,
  patch: Partial<DirectorTransform>,
): DirectorScene {
  let changed = false;
  const objects = scene.objects.map((object) => {
    if (object.id !== id) return object;
    changed = true;
    return {
      ...object,
      transform: {
        position: patch.position ? { ...patch.position } : { ...object.transform.position },
        rotation: patch.rotation ? { ...patch.rotation } : { ...object.transform.rotation },
        scale: patch.scale ? { ...patch.scale } : { ...object.transform.scale },
      },
    };
  });
  return changed ? { ...scene, objects } : scene;
}

const cleanTransformNumber = (value: number, min: number, max: number): number => {
  const bounded = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const rounded = Math.round(bounded * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export function directorTransformFromRadians(input: {
  position: DirectorVector3;
  rotation: DirectorVector3;
  scale: DirectorVector3;
}): DirectorTransform {
  return {
    position: {
      x: cleanTransformNumber(input.position.x, -100_000, 100_000),
      y: cleanTransformNumber(input.position.y, -100_000, 100_000),
      z: cleanTransformNumber(input.position.z, -100_000, 100_000),
    },
    rotation: {
      x: cleanTransformNumber(input.rotation.x * 180 / Math.PI, -360, 360),
      y: cleanTransformNumber(input.rotation.y * 180 / Math.PI, -360, 360),
      z: cleanTransformNumber(input.rotation.z * 180 / Math.PI, -360, 360),
    },
    scale: {
      x: cleanTransformNumber(input.scale.x, 0.01, 1000),
      y: cleanTransformNumber(input.scale.y, 0.01, 1000),
      z: cleanTransformNumber(input.scale.z, 0.01, 1000),
    },
  };
}

export function updateDirectorCamera(scene: DirectorScene, patch: Partial<DirectorCamera>): DirectorScene {
  const activeId = scene.activeCameraId;
  return {
    ...scene,
    cameras: scene.cameras.map((camera) => camera.id === activeId ? {
      ...camera,
      ...patch,
      id: camera.id,
      name: camera.name,
      position: patch.position ? { ...patch.position } : { ...camera.position },
      target: patch.target ? { ...patch.target } : { ...camera.target },
    } : camera),
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

function parseVector(value: unknown, path: string, min = -100_000, max = 100_000): DirectorVector3 {
  const input = objectRecord(value, path);
  return {
    x: finite(input.x, `${path}.x`, min, max),
    y: finite(input.y, `${path}.y`, min, max),
    z: finite(input.z, `${path}.z`, min, max),
  };
}

function parseColor(value: unknown, path: string): string {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) throw new Error(`${path} is invalid`);
  return value;
}

export function parseDirectorScene(value: unknown, path = "directorScene"): DirectorScene {
  const input = objectRecord(value, path);
  if (input.version !== 1 && input.version !== 2 && input.version !== 3 && input.version !== 4) throw new Error(`${path}.version is unsupported`);
  const version = input.version as 1 | 2 | 3 | 4;
  for (const localField of ["screenshots", "captureTray", "directorCaptures", "modelBlobs", "modelUrls", "modelFiles"]) {
    if (input[localField] !== undefined) throw new Error(`${path}.${localField} is browser-local and unsupported`);
  }
  const background = parseColor(input.background, `${path}.background`);
  const parseCamera = (value: unknown, cameraPath: string, fallback?: { id: string; name: string }): DirectorCamera => {
    const cameraInput = objectRecord(value, cameraPath);
    const id = fallback?.id ?? cameraInput.id;
    const name = fallback?.name ?? cameraInput.name;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`${cameraPath}.id is invalid`);
    if (typeof name !== "string" || name.trim().length < 1 || name.length > 100) {
      throw new Error(`${cameraPath}.name is invalid`);
    }
    const aspect = cameraInput.aspect;
    if (aspect !== "16:9" && aspect !== "4:3" && aspect !== "1:1" && aspect !== "3:4" && aspect !== "9:16") {
      throw new Error(`${cameraPath}.aspect is invalid`);
    }
    return {
      id,
      name: name.trim(),
      position: parseVector(cameraInput.position, `${cameraPath}.position`),
      target: parseVector(cameraInput.target, `${cameraPath}.target`),
      focalLength: finite(cameraInput.focalLength, `${cameraPath}.focalLength`, 1, 300),
      aperture: finite(cameraInput.aperture, `${cameraPath}.aperture`, 0.7, 64),
      aspect,
    };
  };
  let cameras: DirectorCamera[];
  let activeCameraId: string;
  let showGroundGrid: boolean;
  let showRuleOfThirds: boolean;
  let showSafeFrame: boolean;
  let viewMode: DirectorScene["viewMode"];
  let directorView: DirectorScene["directorView"];
  if (version === 1) {
    if (typeof input.showGrid !== "boolean") throw new Error(`${path}.showGrid must be a boolean`);
    const camera = parseCamera(input.camera, `${path}.camera`, { id: "camera_main", name: "主摄像机" });
    cameras = [camera];
    activeCameraId = camera.id;
    showGroundGrid = input.showGrid;
    showRuleOfThirds = false;
    showSafeFrame = false;
    viewMode = "director";
    directorView = { position: vector(10, 7, 12), target: { ...camera.target } };
  } else {
    if (typeof input.showGroundGrid !== "boolean") throw new Error(`${path}.showGroundGrid must be a boolean`);
    if (typeof input.showRuleOfThirds !== "boolean") throw new Error(`${path}.showRuleOfThirds must be a boolean`);
    if (typeof input.showSafeFrame !== "boolean") throw new Error(`${path}.showSafeFrame must be a boolean`);
    if (input.viewMode !== "director" && input.viewMode !== "camera") throw new Error(`${path}.viewMode is invalid`);
    const viewInput = objectRecord(input.directorView, `${path}.directorView`);
    directorView = {
      position: parseVector(viewInput.position, `${path}.directorView.position`),
      target: parseVector(viewInput.target, `${path}.directorView.target`),
    };
    if (!Array.isArray(input.cameras) || input.cameras.length < 1 || input.cameras.length > MAX_CAMERAS) {
      throw new Error(`${path}.cameras must contain 1-${MAX_CAMERAS} items`);
    }
    const cameraIds = new Set<string>();
    cameras = input.cameras.map((camera, index) => {
      const parsed = parseCamera(camera, `${path}.cameras[${index}]`);
      if (cameraIds.has(parsed.id)) throw new Error(`${path}.cameras[${index}].id is duplicated`);
      cameraIds.add(parsed.id);
      return parsed;
    });
    if (typeof input.activeCameraId !== "string" || !cameraIds.has(input.activeCameraId)) {
      throw new Error(`${path}.activeCameraId references an unknown camera`);
    }
    activeCameraId = input.activeCameraId;
    showGroundGrid = input.showGroundGrid;
    showRuleOfThirds = input.showRuleOfThirds;
    showSafeFrame = input.showSafeFrame;
    viewMode = input.viewMode;
  }
  const environmentInput = input.environment === undefined
    ? { rotationY: 0, intensity: 1 }
    : objectRecord(input.environment, `${path}.environment`);
  const rawSourceId = environmentInput.sourceId;
  const sourceId = rawSourceId === null || rawSourceId === undefined
    ? null
    : (typeof rawSourceId === "string" && rawSourceId.trim()
      ? rawSourceId.trim().slice(0, 128)
      : null);
  const environment = {
    rotationY: finite(environmentInput.rotationY, `${path}.environment.rotationY`, -360, 360),
    intensity: finite(environmentInput.intensity, `${path}.environment.intensity`, 0, 2),
    sourceId,
  };
  if (!Array.isArray(input.objects) || input.objects.length > MAX_OBJECTS) {
    throw new Error(`${path}.objects exceeds ${MAX_OBJECTS} items`);
  }
  const seen = new Set<string>();
  let modelCount = 0;
  let crowdCount = 0;
  let population = 0;
  let crowdRenderBatchCount = 0;
  const objects = input.objects.map((value, index): DirectorObject => {
    const itemPath = `${path}.objects[${index}]`;
    const object = objectRecord(value, itemPath);
    if (typeof object.id !== "string" || !ID_PATTERN.test(object.id) || seen.has(object.id)) {
      throw new Error(`${itemPath}.id is invalid or duplicated`);
    }
    seen.add(object.id);
    if (object.kind !== "character" && object.kind !== "prop" && object.kind !== "light" &&
        !(version >= 3 && object.kind === "model") && !(version === 4 && object.kind === "crowd")) {
      throw new Error(`${itemPath}.kind is invalid`);
    }
    if (typeof object.name !== "string" || object.name.length < 1 || object.name.length > 100) {
      throw new Error(`${itemPath}.name is invalid`);
    }
    if (typeof object.visible !== "boolean") throw new Error(`${itemPath}.visible must be a boolean`);
    const locked = version >= 3
      ? (() => {
          if (typeof object.locked !== "boolean") throw new Error(`${itemPath}.locked must be a boolean`);
          return object.locked;
        })()
      : false;
    let modelAsset: DirectorModelAssetRef | undefined;
    let character: DirectorCharacterConfig | undefined;
    let crowd: DirectorCrowdConfig | undefined;
    let primitive: DirectorPrimitive | undefined;
    if (object.kind === "character") {
      population += 1;
      character = version === 4
        ? (() => {
            const config = objectRecord(object.character, `${itemPath}.character`);
            return normalizeCharacterConfig({
              preset: config.preset as DirectorCharacterConfig["preset"],
              pose: config.pose as DirectorCharacterConfig["pose"],
              role: config.role as DirectorCharacterConfig["role"],
            });
          })()
        : { ...DEFAULT_CHARACTER_CONFIG };
    } else if (object.character !== undefined) {
      throw new Error(`${itemPath}.character is only supported for character objects`);
    }
    if (object.kind === "crowd") {
      crowdCount += 1;
      if (crowdCount > MAX_CROWDS) throw new Error(`${path}.objects exceeds ${MAX_CROWDS} crowds`);
      const config = objectRecord(object.crowd, `${itemPath}.crowd`);
      for (const derivedField of ["instances", "matrices", "expandedObjects"]) {
        if (config[derivedField] !== undefined) throw new Error(`${itemPath}.crowd.${derivedField} is runtime-only`);
      }
      crowd = normalizeCrowdConfig({
        preset: config.preset as DirectorCrowdConfig["preset"],
        pose: config.pose as DirectorCrowdConfig["pose"],
        rows: config.rows as number,
        columns: config.columns as number,
        spacingX: config.spacingX as number,
        spacingZ: config.spacingZ as number,
        variation: config.variation as boolean,
        seed: config.seed as number,
      });
      population += crowd.rows * crowd.columns;
      crowdRenderBatchCount += crowdRenderBatches(crowd);
    } else if (object.crowd !== undefined) {
      throw new Error(`${itemPath}.crowd is only supported for crowd objects`);
    }
    if (object.kind === "prop") {
      primitive = version === 4
        ? (() => {
            if (!isDirectorPrimitive(object.primitive)) throw new Error(`${itemPath}.primitive is invalid`);
            return object.primitive;
          })()
        : "box";
    } else if (object.primitive !== undefined) {
      throw new Error(`${itemPath}.primitive is only supported for prop objects`);
    }
    if (object.kind === "model") {
      modelCount += 1;
      if (modelCount > MAX_MODELS) throw new Error(`${path}.objects exceeds ${MAX_MODELS} local models`);
      const assetInput = objectRecord(object.modelAsset, `${itemPath}.modelAsset`);
      for (const localField of ["blob", "url", "modelUrl", "fileHandle", "storageKey", "ownerScope"]) {
        if (assetInput[localField] !== undefined) throw new Error(`${itemPath}.modelAsset.${localField} is browser-local and unsupported`);
      }
      modelAsset = normalizeModelAsset({
        assetId: assetInput.assetId as string,
        fileName: assetInput.fileName as string,
        bytes: assetInput.bytes as number,
      });
    } else if (object.modelAsset !== undefined) {
      throw new Error(`${itemPath}.modelAsset is only supported for model objects`);
    }
    const transformInput = objectRecord(object.transform, `${itemPath}.transform`);
    return {
      id: object.id,
      kind: object.kind,
      name: object.name,
      visible: object.visible,
      locked,
      color: parseColor(object.color, `${itemPath}.color`),
      intensity: finite(object.intensity, `${itemPath}.intensity`, 0, 1000),
      transform: {
        position: parseVector(transformInput.position, `${itemPath}.transform.position`),
        rotation: parseVector(transformInput.rotation, `${itemPath}.transform.rotation`, -360, 360),
        scale: parseVector(transformInput.scale, `${itemPath}.transform.scale`, 0.01, 1000),
      },
      character,
      crowd,
      primitive,
      modelAsset,
    };
  });
  if (population > MAX_SCENE_POPULATION) throw new Error(`${path}.objects exceeds ${MAX_SCENE_POPULATION} people`);
  if (crowdRenderBatchCount > MAX_CROWD_RENDER_BATCHES) {
    throw new Error(`${path}.objects exceeds ${MAX_CROWD_RENDER_BATCHES} crowd render batches`);
  }
  if (input.selectedObjectId !== null &&
      (typeof input.selectedObjectId !== "string" || !seen.has(input.selectedObjectId))) {
    throw new Error(`${path}.selectedObjectId references an unknown object`);
  }
  const selectedObjectId = input.selectedObjectId as string | null;
  return {
    version: 4,
    background,
    showGroundGrid,
    showRuleOfThirds,
    showSafeFrame,
    viewMode,
    directorView,
    selectedObjectId,
    activeCameraId,
    cameras,
    environment,
    objects,
  };
}
