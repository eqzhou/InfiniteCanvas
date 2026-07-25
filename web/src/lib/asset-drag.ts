/** Independent OpenBoard drag payload for canvas left-panel assets. */
export const OPENBOARD_ASSET_DRAG_MIME = "application/x-openboard-asset";

const ASSET_ID_PATTERN = /^asset_[A-Za-z0-9_-]{1,64}$/;

export function isOpenBoardAssetId(value: unknown): value is string {
  return typeof value === "string" && ASSET_ID_PATTERN.test(value);
}

export function encodeOpenBoardAssetDrag(assetId: string): string {
  if (!isOpenBoardAssetId(assetId)) {
    throw new Error("asset id is invalid");
  }
  return assetId;
}

export function readOpenBoardAssetDrag(
  dataTransfer: Pick<DataTransfer, "types" | "getData"> | null | undefined,
): string | null {
  if (!dataTransfer) return null;
  const types = Array.from(dataTransfer.types ?? []);
  if (!types.includes(OPENBOARD_ASSET_DRAG_MIME)) return null;
  try {
    const value = dataTransfer.getData(OPENBOARD_ASSET_DRAG_MIME);
    return isOpenBoardAssetId(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeOpenBoardAssetDrag(
  dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  assetId: string,
): void {
  const payload = encodeOpenBoardAssetDrag(assetId);
  dataTransfer.setData(OPENBOARD_ASSET_DRAG_MIME, payload);
  // Keep a plain-text fallback for accessibility tooling and debugging only.
  dataTransfer.setData("text/plain", payload);
  dataTransfer.effectAllowed = "copy";
}
