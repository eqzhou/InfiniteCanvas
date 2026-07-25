import { describe, expect, test } from "bun:test";
import {
  encodeOpenBoardAssetDrag,
  isOpenBoardAssetId,
  OPENBOARD_ASSET_DRAG_MIME,
  readOpenBoardAssetDrag,
  writeOpenBoardAssetDrag,
} from "./asset-drag";

function fakeDataTransfer(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    types: Object.keys(data),
    effectAllowed: "none",
    setData(type: string, value: string) {
      data[type] = value;
      this.types = Object.keys(data);
    },
    getData(type: string) {
      return data[type] ?? "";
    },
  };
}

describe("openboard asset drag payload", () => {
  test("accepts only bounded asset ids", () => {
    expect(isOpenBoardAssetId("asset_abc123XYZ")).toBe(true);
    expect(isOpenBoardAssetId("node_abc")).toBe(false);
    expect(isOpenBoardAssetId("asset_" + "x".repeat(65))).toBe(false);
    expect(() => encodeOpenBoardAssetDrag("bad")).toThrow("invalid");
  });

  test("writes and reads a custom mime payload", () => {
    const transfer = fakeDataTransfer();
    writeOpenBoardAssetDrag(transfer, "asset_sidebar01");
    expect(transfer.effectAllowed).toBe("copy");
    expect(transfer.getData(OPENBOARD_ASSET_DRAG_MIME)).toBe("asset_sidebar01");
    expect(readOpenBoardAssetDrag(transfer)).toBe("asset_sidebar01");
  });

  test("ignores missing mime types and malformed values", () => {
    expect(readOpenBoardAssetDrag(null)).toBeNull();
    expect(readOpenBoardAssetDrag(fakeDataTransfer({ "text/plain": "asset_sidebar01" }))).toBeNull();
    const bad = fakeDataTransfer();
    bad.setData(OPENBOARD_ASSET_DRAG_MIME, "not-an-asset");
    expect(readOpenBoardAssetDrag(bad)).toBeNull();
  });
});
