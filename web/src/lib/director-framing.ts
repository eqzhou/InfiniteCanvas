export type FlatEnvironmentLayout = {
  width: number;
  height: number;
  y: number;
  z: number;
};

const FLAT_BACKDROP_MAX_WIDTH = 24;
const FLAT_BACKDROP_MAX_HEIGHT = 12;
const FLAT_BACKDROP_Z = -14;
const FALLBACK_ASPECT = 16 / 9;
const MAX_SAFE_FRAME_COORDINATE = 100_000;

export function isSafeDirectorFrameSphere(
  center: { x: number; y: number; z: number },
  radius: number,
): boolean {
  return [center.x, center.y, center.z, radius].every((value) =>
    Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_FRAME_COORDINATE,
  ) && radius >= 0;
}

/** Keeps ordinary photos usable as a backdrop without swallowing the stage. */
export function flatEnvironmentLayout(width: number, height: number, foregroundMinZ = -10): FlatEnvironmentLayout {
  const z = Math.min(FLAT_BACKDROP_Z, Number.isFinite(foregroundMinZ) ? foregroundMinZ - 4 : FLAT_BACKDROP_Z);
  const hasDimensions = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  if (!hasDimensions) return { width: 16, height: 9, y: 4.5, z };
  const aspect = width / height || FALLBACK_ASPECT;
  const fittedWidth = Math.min(FLAT_BACKDROP_MAX_WIDTH, FLAT_BACKDROP_MAX_HEIGHT * aspect);
  const fittedHeight = fittedWidth / aspect;
  const safeWidth = Number(fittedWidth.toFixed(4));
  const safeHeight = Number(fittedHeight.toFixed(4));
  return {
    width: safeWidth,
    height: safeHeight,
    y: Number((safeHeight / 2).toFixed(4)),
    z,
  };
}
