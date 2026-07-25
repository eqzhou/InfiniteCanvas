import { describe, expect, test } from "bun:test";

import {
  DIRECTOR_CHARACTER_PRESETS,
  DIRECTOR_POSE_PRESETS,
  DIRECTOR_PRIMITIVES,
  buildDirectorCrowdPlacements,
} from "./director-cast";

describe("director cast catalog", () => {
  test("provides eight independently-authored characters, twenty poses, and bounded geometry presets", () => {
    expect(DIRECTOR_CHARACTER_PRESETS).toHaveLength(8);
    expect(DIRECTOR_POSE_PRESETS).toHaveLength(20);
    expect(DIRECTOR_PRIMITIVES).toHaveLength(6);
    expect(new Set(DIRECTOR_CHARACTER_PRESETS.map((item) => item.id)).size).toBe(8);
    expect(new Set(DIRECTOR_POSE_PRESETS.map((item) => item.id)).size).toBe(20);
    expect(new Set(DIRECTOR_PRIMITIVES.map((item) => item.id)).size).toBe(6);
    expect(DIRECTOR_CHARACTER_PRESETS.every((item) => item.label && item.outfitColor.startsWith("#"))).toBe(true);
    expect(DIRECTOR_POSE_PRESETS.every((item) => Object.keys(item.joints).length >= 4)).toBe(true);
  });

  test("builds a centered deterministic crowd without mutating its configuration", () => {
    const config = {
      preset: "studio" as const,
      pose: "neutral" as const,
      rows: 2,
      columns: 3,
      spacingX: 1.5,
      spacingZ: 2,
      variation: true,
      seed: 42,
    };
    const snapshot = structuredClone(config);
    const first = buildDirectorCrowdPlacements(config);
    const second = buildDirectorCrowdPlacements(config);

    expect(config).toEqual(snapshot);
    expect(first).toEqual(second);
    expect(first).toHaveLength(6);
    expect(first.map(({ x }) => x)).toEqual([-1.5, 0, 1.5, -1.5, 0, 1.5]);
    expect(first.map(({ z }) => z)).toEqual([-1, -1, -1, 1, 1, 1]);
    expect(new Set(first.map(({ preset }) => preset)).size).toBeGreaterThan(1);
    expect(new Set(first.map(({ pose }) => pose)).size).toBeGreaterThan(1);
    expect(first.some(({ preset, pose }) => preset === config.preset && pose === config.pose)).toBe(true);
    expect(buildDirectorCrowdPlacements({ ...config, preset: "future", pose: "celebrate" })).not.toEqual(first);
  });
});
