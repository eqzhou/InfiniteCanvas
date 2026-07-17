export function resolveVideoDuration(
  smartDuration: boolean,
  duration: number | undefined,
): number | undefined {
  return smartDuration ? undefined : duration;
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
