import { describe, expect, test } from "bun:test";

import { navigationAfterDirectorPreviewStart, shouldPersistDirectorView } from "./director-view-persist";

describe("director view persist policy", () => {
  test("persists only a completed user navigation outside preview", () => {
    expect(shouldPersistDirectorView({ previewing: false, cameraInteracted: true })).toBe(true);
    expect(shouldPersistDirectorView({ previewing: true, cameraInteracted: true })).toBe(false);
    expect(shouldPersistDirectorView({ previewing: false, cameraInteracted: false })).toBe(false);
  });

  test("starting a preview cancels a pending orbit persist", () => {
    const pending = { userNavigating: true, cameraInteracted: true };
    const next = { ...pending, ...navigationAfterDirectorPreviewStart() };
    expect(next).toEqual({ userNavigating: false, cameraInteracted: false });
    expect(shouldPersistDirectorView({ previewing: false, cameraInteracted: next.cameraInteracted })).toBe(false);
  });
});
