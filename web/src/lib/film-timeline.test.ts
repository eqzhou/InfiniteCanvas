import { describe, expect, test } from "bun:test";

import { defaultFilmTimeline } from "./film-document";
import {
  addFilmTimelineClip,
  moveFilmTimelineClip,
  updateFilmTimelineClip,
  validateFilmTimelineDraft,
} from "./film-timeline";

describe("film timeline editing", () => {
  test("adds and edits clips immutably on all production track kinds", () => {
    const original = defaultFilmTimeline();
    const withClips = original.tracks.reduce((timeline, track, index) => addFilmTimelineClip(timeline, track.id, {
      source: `${track.kind}-${index}`,
      start: index,
      end: index + 2,
      ...(track.kind === "subtitle" ? { text: "A subtitle" } : {}),
    }), original);
    const dialogue = withClips.tracks.find((track) => track.kind === "dialogue")!;
    const edited = updateFilmTimelineClip(withClips, dialogue.id, dialogue.clips[0]!.id, {
      trimIn: 0.25,
      trimOut: 0.25,
      volume: 0.7,
      muted: true,
      fadeIn: 0.2,
      fadeOut: 0.3,
      transition: "fade",
    });

    expect(original.tracks.every((track) => track.clips.length === 0)).toBe(true);
    expect(edited.tracks.map((track) => track.kind)).toEqual(["video", "dialogue", "music", "sfx", "subtitle"]);
    expect(edited.tracks.find((track) => track.kind === "dialogue")?.clips[0]).toMatchObject({
      trimIn: 0.25, trimOut: 0.25, volume: 0.7, muted: true, fadeIn: 0.2, fadeOut: 0.3, transition: "fade",
    });
  });

  test("reorders clips without mutating the source timeline", () => {
    const timeline = addFilmTimelineClip(
      addFilmTimelineClip(defaultFilmTimeline(), "track_video", { source: "one", start: 0, end: 2 }),
      "track_video",
      { source: "two", start: 2, end: 4 },
    );
    const secondId = timeline.tracks[0]!.clips[1]!.id;
    const moved = moveFilmTimelineClip(timeline, "track_video", secondId, -1);

    expect(timeline.tracks[0]!.clips.map((clip) => clip.source)).toEqual(["one", "two"]);
    expect(moved.tracks[0]!.clips.map((clip) => [clip.source, clip.order])).toEqual([["two", 0], ["one", 1]]);
  });

  test("returns explicit validation errors for invalid bounds, fades, volume, and subtitles", () => {
    const timeline = addFilmTimelineClip(defaultFilmTimeline(), "track_subtitle", {
      source: "manual", start: 4, end: 3, text: "",
    });
    const clipId = timeline.tracks.find((track) => track.kind === "subtitle")!.clips[0]!.id;
    const invalid = updateFilmTimelineClip(timeline, "track_subtitle", clipId, {
      volume: 3,
      fadeIn: 2,
      fadeOut: 2,
    });
    const errors = validateFilmTimelineDraft({ ...invalid, width: 100, frameRate: 0 });

    expect(errors.join(" ")).toContain("宽度");
    expect(errors.join(" ")).toContain("帧率");
    expect(errors.join(" ")).toContain("入点必须早于出点");
    expect(errors.join(" ")).toContain("音量");
    expect(errors.join(" ")).toContain("字幕文本");
  });
});
