import { describe, expect, test } from "bun:test";
import { DIRECTOR_CHARACTER_PRESETS, DIRECTOR_POSE_PRESETS } from "./director-cast";
import { buildDirectorFigurePreview } from "./director-figure-preview";

describe("director figure visual previews", () => {
  test("projects every character preset into a distinct bounded silhouette", () => {
    const previews = DIRECTOR_CHARACTER_PRESETS.map(({ id }) =>
      buildDirectorFigurePreview(id, "neutral")
    );

    expect(new Set(previews.map((preview) => JSON.stringify(preview))).size).toBe(8);
    for (const preview of previews) {
      expect(preview.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preview.skinColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preview.torso.width).toBeGreaterThan(8);
      expect(preview.torso.height).toBeGreaterThan(18);
      expect(preview.head.radius).toBeGreaterThan(4);
    }
  });

  test("projects all twenty poses into distinct finite limb layouts", () => {
    const previews = DIRECTOR_POSE_PRESETS.map(({ id }) =>
      buildDirectorFigurePreview("studio", id)
    );
    const signatures = previews.map(({ head, torso, limbs }) =>
      JSON.stringify({ head, torso, limbs })
    );

    expect(new Set(signatures).size).toBe(20);
    for (const preview of previews) {
      for (const point of [preview.head, preview.torso, ...preview.limbs.flatMap((limb) => [limb.start, limb.end])]) {
        expect(Object.values(point).every(Number.isFinite)).toBe(true);
      }
    }
  });

  test("returns new preview values without changing catalog definitions", () => {
    const character = structuredClone(DIRECTOR_CHARACTER_PRESETS[0]);
    const pose = structuredClone(DIRECTOR_POSE_PRESETS[0]);
    const first = buildDirectorFigurePreview("studio", "neutral");
    first.limbs[0]!.end.x = -1;

    expect(buildDirectorFigurePreview("studio", "neutral").limbs[0]!.end.x).not.toBe(-1);
    expect(DIRECTOR_CHARACTER_PRESETS[0]).toEqual(character);
    expect(DIRECTOR_POSE_PRESETS[0]).toEqual(pose);
  });
});
