import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { createFilmDocument } from "@/lib/film-document";
import type { FilmStatus } from "@/services/film-client";
import { buildEpisodeProductionView, EpisodeProductionViews } from "./EpisodeProductionViews";

function filmStatus(): FilmStatus {
  const document = createFilmDocument("film-episode-views", "2026-08-11T00:00:00.000Z");
  document.episodes = [
    { id: "episode-1", revision: 1, order: 0, title: "潮汐信号", synopsis: "守塔人发现重复信号。", status: "draft" },
    { id: "episode-2", revision: 1, order: 1, title: "回声", synopsis: "另一条故事线。", status: "draft" },
  ];
  document.scenes = [
    { id: "scene-1", revision: 1, episodeId: "episode-1", order: 0, heading: "外景·雾港·清晨", synopsis: "汽笛穿过浓雾。", status: "draft" },
    { id: "scene-2", revision: 1, episodeId: "episode-2", order: 0, heading: "内景·车站·夜", synopsis: "不属于当前集。", status: "draft" },
  ];
  document.shots = [
    { id: "shot-1", revision: 1, sceneId: "scene-1", order: 0, title: "远景", description: "灯塔从雾中显现。", status: "draft", durationSeconds: 4, aspectRatio: "16:9", identityVersionIds: [], imageStorageKey: "image:storyboard", audioStorageKey: "media:audio", videoStorageKey: "media:video", subtitle: "信号又来了" },
    { id: "shot-2", revision: 1, sceneId: "scene-2", order: 0, title: "他集镜头", description: "不应出现。", status: "draft", durationSeconds: 2, aspectRatio: "16:9", identityVersionIds: [] },
  ];
  document.dialogues = [
    { id: "dialogue-1", revision: 1, shotId: "shot-1", order: 0, kind: "dialogue", text: "记录第七次信号。", status: "draft", audioStorageKey: "media:dialogue" },
    { id: "dialogue-2", revision: 1, shotId: "shot-2", order: 0, kind: "dialogue", text: "不属于当前集。", status: "draft" },
  ];
  document.timeline.tracks[0]!.clips = [{ id: "clip-1", revision: 1, source: "shot:shot-1", order: 0, start: 0, end: 4, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut" }];
  return { document, recordRevision: 1, capabilities: { available: true, reason: "", plainTextImport: true, markdownImport: true, docxImport: true, pdfImport: true, fileUploadImport: true, maxImportBytes: 1, stageGeneration: true, generationJobs: true, generationStages: [], assetBundleExport: true, mp4Export: false, mp4Diagnostic: "", agentOperations: [] } };
}

describe("per-episode production views", () => {
  test("derives every view from the selected episode's existing Film facts", () => {
    const view = buildEpisodeProductionView(filmStatus().document, "episode-1");

    expect(view.scenes.map((item) => item.id)).toEqual(["scene-1"]);
    expect(view.shots.map((item) => item.id)).toEqual(["shot-1"]);
    expect(view.dialogues.map((item) => item.id)).toEqual(["dialogue-1"]);
    expect(view.timelineClips.map((item) => item.id)).toEqual(["clip-1"]);
  });

  test("renders six keyboard-discoverable tabs and a horizontally scrollable mobile layout", () => {
    const html = renderToStaticMarkup(<EpisodeProductionViews status={filmStatus()} busy={false} onSaveEpisode={() => undefined} onSaveShot={() => undefined} onCreateDialogue={() => undefined} onSaveDialogue={() => undefined} onDeleteDialogue={() => undefined} />);

    expect(html).toContain('role="tablist"');
    for (const label of ["剧本", "镜头表", "故事板", "音频", "视频", "合成"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(6);
    expect(html).toContain('id="episode-panel-shots"');
    expect(html).toContain('data-testid="film-shot-shot-1"');
    expect(html).toContain("hidden");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-h-10");
  });

  test("shows selected storyboard and composition facts without leaking another episode", () => {
    const storyboard = renderToStaticMarkup(<EpisodeProductionViews status={filmStatus()} busy={false} initialView="storyboard" onSaveEpisode={() => undefined} onSaveShot={() => undefined} onCreateDialogue={() => undefined} onSaveDialogue={() => undefined} onDeleteDialogue={() => undefined} />);
    const compose = renderToStaticMarkup(<EpisodeProductionViews status={filmStatus()} busy={false} initialView="compose" onSaveEpisode={() => undefined} onSaveShot={() => undefined} onCreateDialogue={() => undefined} onSaveDialogue={() => undefined} onDeleteDialogue={() => undefined} />);

    expect(storyboard).toContain("灯塔从雾中显现");
    expect(storyboard).toContain("image:storyboard");
    expect(storyboard).not.toContain("他集镜头");
    expect(compose).toContain("clip-1");
    expect(compose).toContain("4.0 秒");
  });
});
