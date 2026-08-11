import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TaskCenterTable } from "./TaskCenterPage";

describe("TaskCenterTable", () => {
  test("renders durable Film and workbench tasks with source navigation", () => {
    const html = renderToStaticMarkup(<MemoryRouter><TaskCenterTable items={[{
      id: "job-1", projectId: "film-1", kind: "video", status: "failed", source: "film", stage: "video", shotId: "shot-1",
      title: "视频 · 镜头 shot-1", createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:00:01Z", sourcePath: "/film/film-1",
    }]} onCancel={() => undefined} /></MemoryRouter>);
    expect(html).toContain("视频 · 镜头 shot-1");
    expect(html).toContain("失败");
    expect(html).toContain("/film/film-1");
  });
});
