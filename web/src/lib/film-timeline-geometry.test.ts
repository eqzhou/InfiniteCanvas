import { describe, expect, test } from "bun:test";

import { moveTimelineClip, resizeTimelineClip, timelineDuration, timelineTimeToPercent } from "./film-timeline-geometry";
import type { FilmTimeline, FilmTimelineClip } from "@/types/film";

const clip: FilmTimelineClip = { id: "clip-1", revision: 2, source: "shot:1", order: 0, start: 2, end: 6, trimIn: 1, trimOut: 5, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" };

describe("visual Film timeline geometry", () => {
  test("derives a bounded duration and percentage positions", () => {
    const timeline = { tracks: [{ clips: [clip] }, { clips: [{ ...clip, id: "clip-2", end: 14 }] }] } as FilmTimeline;
    expect(timelineDuration(timeline)).toBe(15);
    expect(timelineTimeToPercent(7.5, 15)).toBe(50);
  });

  test("moves clips immutably, snaps to frames and clamps to the timeline", () => {
    const next = moveTimelineClip(clip, -2.49, 10, 2);
    expect(next).toMatchObject({ start: 0, end: 4, trimIn: 1, trimOut: 5, revision: 3 });
    expect(clip).toMatchObject({ start: 2, end: 6, revision: 2 });
  });

  test("resizes either edge without crossing one frame and updates source trims", () => {
    expect(resizeTimelineClip(clip, "start", 3.2, 24)).toMatchObject({ start: 3.2083333333333335, end: 6, trimIn: 2.2083333333333335, trimOut: 5 });
    expect(resizeTimelineClip(clip, "end", 2, 2)).toMatchObject({ start: 2, end: 2.5, trimIn: 1, trimOut: 1.5 });
  });
});
