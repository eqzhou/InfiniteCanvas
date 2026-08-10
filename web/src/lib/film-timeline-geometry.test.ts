import { describe, expect, test } from "bun:test";

import { moveTimelineClip, resizeTimelineClip, timelineDuration, timelineTimeToPercent } from "./film-timeline-geometry";
import type { FilmTimeline, FilmTimelineClip } from "@/types/film";

const clip: FilmTimelineClip = { id: "clip-1", revision: 2, source: "shot:1", order: 0, start: 2, end: 6, trimIn: 1, trimOut: 0.5, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" };

describe("visual Film timeline geometry", () => {
  test("derives a bounded duration and percentage positions", () => {
    const timeline = { tracks: [{ clips: [clip] }, { clips: [{ ...clip, id: "clip-2", end: 14 }] }] } as FilmTimeline;
    expect(timelineDuration(timeline)).toBe(15);
    expect(timelineTimeToPercent(7.5, 15)).toBe(50);
  });

  test("moves clips immutably, snaps to frames and clamps to the timeline", () => {
    const next = moveTimelineClip(clip, -2.49, 10, 2);
    expect(next).toMatchObject({ start: 0, end: 4, trimIn: 1, trimOut: 0.5, revision: 3 });
    expect(clip).toMatchObject({ start: 2, end: 6, revision: 2 });
  });

  test("resizes either edge without crossing one frame and updates source trims", () => {
    const resizedStart = resizeTimelineClip(clip, "start", 3.2, 24);
    expect(resizedStart).toMatchObject({ end: 6, trimOut: 0.5 });
    expect(resizedStart.start).toBeCloseTo(3.2083333333333335);
    expect(resizedStart.trimIn).toBeCloseTo(2.2083333333333335);
    expect(resizeTimelineClip(clip, "end", 3.5, 2)).toMatchObject({ start: 2, end: 3.5, trimIn: 1, trimOut: 0.5 });
    expect(resizeTimelineClip(clip, "end", 2, 2)).toMatchObject({ start: 2, end: 3, trimOut: 0.5 });
  });
});
