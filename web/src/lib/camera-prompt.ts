import type { CameraPromptConfig, CameraPromptCamera, CameraPromptLens } from "@/types/board";

export const CAMERA_PROMPT_CAMERAS: ReadonlyArray<{ value: CameraPromptCamera; label: string }> = [
  { value: "cinema", label: "电影摄影机" },
  { value: "mirrorless", label: "无反相机" },
  { value: "dslr", label: "单反相机" },
  { value: "drone", label: "无人机" },
  { value: "action", label: "运动相机" },
];

export const CAMERA_PROMPT_LENSES: ReadonlyArray<{ value: CameraPromptLens; label: string }> = [
  { value: "wide", label: "广角镜头" },
  { value: "standard", label: "标准镜头" },
  { value: "telephoto", label: "长焦镜头" },
  { value: "macro", label: "微距镜头" },
  { value: "anamorphic", label: "变形宽银幕镜头" },
];

const cameraDescriptions: Record<CameraPromptCamera, string> = {
  cinema: "cinema camera",
  mirrorless: "mirrorless camera",
  dslr: "DSLR camera",
  drone: "drone camera",
  action: "action camera",
};

const lensDescriptions: Record<CameraPromptLens, string> = {
  wide: "wide-angle lens",
  standard: "standard lens",
  telephoto: "telephoto lens",
  macro: "macro lens",
  anamorphic: "anamorphic lens",
};

const cameraValues = new Set(CAMERA_PROMPT_CAMERAS.map((item) => item.value));
const lensValues = new Set(CAMERA_PROMPT_LENSES.map((item) => item.value));

export function createDefaultCameraPrompt(): CameraPromptConfig {
  return { enabled: false, camera: "cinema", lens: "standard", focalLength: 50, aperture: 2.8 };
}

function boundedNumber(value: unknown, name: "focalLength" | "aperture", minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`cameraPrompt.${name} is outside the supported range`);
  }
  return Math.round(value * 10) / 10;
}

export function normalizeCameraPrompt(value: unknown): CameraPromptConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cameraPrompt must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean") throw new Error("cameraPrompt.enabled must be a boolean");
  if (typeof input.camera !== "string" || !cameraValues.has(input.camera as CameraPromptCamera)) {
    throw new Error("cameraPrompt.camera is invalid");
  }
  if (typeof input.lens !== "string" || !lensValues.has(input.lens as CameraPromptLens)) {
    throw new Error("cameraPrompt.lens is invalid");
  }
  return {
    enabled: input.enabled,
    camera: input.camera as CameraPromptCamera,
    lens: input.lens as CameraPromptLens,
    focalLength: boundedNumber(input.focalLength, "focalLength", 8, 600),
    aperture: boundedNumber(input.aperture, "aperture", 0.7, 64),
  };
}

export function applyCameraPrompt(prompt: string, value?: CameraPromptConfig): string {
  const base = prompt.trim();
  if (!value?.enabled) return base;
  const config = normalizeCameraPrompt(value);
  const cameraBlock = [
    `Camera: ${cameraDescriptions[config.camera]}`,
    `Lens: ${lensDescriptions[config.lens]}`,
    `Focal length: ${config.focalLength}mm`,
    `Aperture: f/${config.aperture}`,
  ].join("; ") + ".";
  return base ? `${base}\n\n${cameraBlock}` : cameraBlock;
}
