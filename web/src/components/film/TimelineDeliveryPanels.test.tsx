import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createFilmDocument } from "@/lib/film-document";
import { TimelinePanel } from "./TimelineDeliveryPanels";

describe("visual production timeline", () => {
  test("renders a ruler, playhead and positioned clips alongside precise controls", () => {
    const timeline = createFilmDocument("film-timeline", "2026-08-08T00:00:00.000Z").timeline;
    timeline.tracks[0]!.clips = [{ id: "clip-1", revision: 1, source: "shot:1", order: 0, start: 2, end: 6, trimIn: 0, trimOut: 4, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }];
    const html = renderToStaticMarkup(<TimelinePanel timeline={timeline} mediaSources={[]} dirty={false} busy={false} onChange={() => {}} onSave={() => {}} />);

    expect(html).toContain("可视化剪辑台");
    expect(html).toContain('aria-label="时间线播放头"');
    expect(html).toContain('data-testid="visual-timeline-track-video"');
    expect(html).toContain('data-testid="visual-timeline-clip-clip-1"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('aria-label="拖动片段入点"');
    expect(html).toContain('aria-label="拖动片段出点"');
    expect(html).toContain("左移一帧");
    expect(html).toContain("收缩入点一帧");
  });
});
