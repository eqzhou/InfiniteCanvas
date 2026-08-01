import { describe, expect, test } from "bun:test";

import { flatEnvironmentLayout, isSafeDirectorFrameSphere } from "./director-framing";

describe("director viewport framing", () => {
  test("fits portrait and landscape flat backgrounds inside a bounded stage backdrop", () => {
    expect(flatEnvironmentLayout(1024, 1536)).toEqual({ width: 8, height: 12, y: 6, z: -14 });
    expect(flatEnvironmentLayout(4096, 1024)).toEqual({ width: 24, height: 6, y: 3, z: -14 });
  });

  test("uses a safe fallback for missing image dimensions", () => {
    expect(flatEnvironmentLayout(0, 0)).toEqual({ width: 16, height: 9, y: 4.5, z: -14 });
    expect(flatEnvironmentLayout(1920, 1080, -20).z).toBe(-24);
  });

  test("rejects non-finite and unreasonably large model bounds", () => {
    expect(isSafeDirectorFrameSphere({ x: 12, y: 3, z: -8 }, 24)).toBe(true);
    expect(isSafeDirectorFrameSphere({ x: Number.NaN, y: 0, z: 0 }, 1)).toBe(false);
    expect(isSafeDirectorFrameSphere({ x: 0, y: 0, z: Number.POSITIVE_INFINITY }, 1)).toBe(false);
    expect(isSafeDirectorFrameSphere({ x: 0, y: 0, z: 0 }, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeDirectorFrameSphere({ x: 100_001, y: 0, z: 0 }, 1)).toBe(false);
    expect(isSafeDirectorFrameSphere({ x: 0, y: 0, z: 0 }, 100_001)).toBe(false);
  });
});
