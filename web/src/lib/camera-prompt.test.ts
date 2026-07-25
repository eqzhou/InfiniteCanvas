import { describe, expect, test } from "bun:test";
import {
  applyCameraPrompt,
  createDefaultCameraPrompt,
  normalizeCameraPrompt,
} from "@/lib/camera-prompt";

describe("node camera prompt configuration", () => {
  test("keeps a disabled camera configuration out of the request", () => {
    const config = createDefaultCameraPrompt();
    expect(config.enabled).toBe(false);
    expect(applyCameraPrompt("a quiet street", config)).toBe("a quiet street");
  });

  test("assembles one deterministic camera block without mutating inputs", () => {
    const config = {
      enabled: true,
      camera: "cinema" as const,
      lens: "anamorphic" as const,
      focalLength: 35,
      aperture: 2.8,
    };
    const result = applyCameraPrompt("a quiet street", config);
    expect(result).toBe([
      "a quiet street",
      "",
      "Camera: cinema camera; Lens: anamorphic lens; Focal length: 35mm; Aperture: f/2.8.",
    ].join("\n"));
    expect(config).toEqual({ enabled: true, camera: "cinema", lens: "anamorphic", focalLength: 35, aperture: 2.8 });
    expect(applyCameraPrompt("a quiet street", config)).toBe(result);
  });

  test("normalizes persisted values and rejects unsafe camera documents", () => {
    expect(normalizeCameraPrompt({
      enabled: true,
      camera: "drone",
      lens: "wide",
      focalLength: 24,
      aperture: 4,
    })).toEqual({ enabled: true, camera: "drone", lens: "wide", focalLength: 24, aperture: 4 });
    expect(() => normalizeCameraPrompt({ enabled: true, camera: "unknown", lens: "wide", focalLength: 24, aperture: 4 })).toThrow("camera");
    expect(() => normalizeCameraPrompt({ enabled: true, camera: "cinema", lens: "wide", focalLength: 0, aperture: 4 })).toThrow("focalLength");
    expect(() => normalizeCameraPrompt({ enabled: true, camera: "cinema", lens: "wide", focalLength: 24, aperture: 100 })).toThrow("aperture");
  });
});
