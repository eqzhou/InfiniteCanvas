export function resolveVideoDuration(
  smartDuration: boolean,
  duration: number | undefined,
): number | undefined {
  return smartDuration ? undefined : duration;
}

export type VideoFrameMode = "references" | "first-last";

export function normalizeVideoFrameMode(value: unknown): VideoFrameMode {
  return value === "first-last" ? "first-last" : "references";
}

/** Assign Ark image roles for ordered reference images. */
export function arkImageReferenceRoles(
  mode: VideoFrameMode,
  imageCount: number,
): Array<"first_frame" | "last_frame" | "reference_image"> {
  const count = Math.max(0, Math.min(9, Math.floor(imageCount)));
  return Array.from({ length: count }, (_, index) => {
    if (mode === "first-last") {
      if (index === 0) return "first_frame";
      if (index === 1) return "last_frame";
    }
    return "reference_image";
  });
}

export function validateArkVideoRequest(
  model: string,
  resolution: string,
  duration: number | undefined,
): void {
  if (/fast/i.test(model) && resolution === "1080p") {
    throw new Error("Seedance fast 模型不支持 1080p，请选择 720p 或其他模型");
  }
  if (duration !== undefined &&
      (!Number.isSafeInteger(duration) || duration < 4 || duration > 15)) {
    throw new Error("Seedance 视频时长必须为 4-15 秒，或启用智能时长");
  }
}
