import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AudioNodePlayer, audioTimelineState } from "./AudioNodePlayer";

describe("AudioNodePlayer", () => {
  test("snaps the progress to the real duration when playback ends", () => {
    expect(audioTimelineState(2.4, 2.9, false)).toEqual({
      currentTime: 2.4,
      duration: 2.9,
      progress: expect.closeTo(82.7586, 3),
      currentLabel: "0:02.4",
      durationLabel: "0:02.9",
    });
    expect(audioTimelineState(2.4, 2.9, true)).toEqual({
      currentTime: 2.9,
      duration: 2.9,
      progress: 100,
      currentLabel: "0:02.9",
      durationLabel: "0:02.9",
    });
  });

  test("does not display the rounded final timestamp before playback actually ends", () => {
    expect(audioTimelineState(2.39, 2.424, false)).toMatchObject({
      progress: expect.closeTo(98.5973, 3),
      currentLabel: "0:02.3",
      durationLabel: "0:02.4",
    });
    expect(audioTimelineState(2.39, 2.424, true)).toMatchObject({
      progress: 100,
      currentLabel: "0:02.4",
      durationLabel: "0:02.4",
    });
  });

  test("keeps invalid or unavailable media timelines at zero", () => {
    expect(audioTimelineState(Number.NaN, Number.POSITIVE_INFINITY, false)).toEqual({
      currentTime: 0,
      duration: 0,
      progress: 0,
      currentLabel: "0:00",
      durationLabel: "0:00",
    });
  });

  test("renders an accessible custom progress control", () => {
    const html = renderToStaticMarkup(<AudioNodePlayer src="/api/blob/audio" />);
    expect(html).toContain('aria-label="播放音频"');
    expect(html).toContain('aria-label="音频播放进度"');
    expect(html).toContain("0:00 / 0:00");
  });
});
