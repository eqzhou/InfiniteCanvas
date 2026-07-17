import { describe, expect, test } from "bun:test";
import type { BoardProject } from "@/types/board";
import {
  activePromptReferences,
  buildPromptReferences,
  splitPromptReferenceValue,
} from "@/lib/prompt-references";

const project = {
  schemaVersion: 2,
  id: "project-1",
  title: "Prompt references",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  nodes: [
    {
      id: "image-a",
      type: "image",
      title: "Front",
      position: { x: 0, y: 0 },
      width: 100,
      height: 100,
      metadata: { content: "blob:front", storageKey: "image:front" },
    },
    {
      id: "text-a",
      type: "text",
      title: "Notes",
      position: { x: 0, y: 0 },
      width: 100,
      height: 100,
      metadata: { content: "not a media reference" },
    },
    {
      id: "video-a",
      type: "video",
      title: "Motion",
      position: { x: 0, y: 0 },
      width: 100,
      height: 100,
      metadata: { content: "https://media.example/motion.mp4" },
    },
    {
      id: "image-b",
      type: "image",
      title: "Back",
      position: { x: 0, y: 0 },
      width: 100,
      height: 100,
      metadata: { storageKey: "image:back" },
    },
    {
      id: "target",
      type: "video",
      title: "Target",
      position: { x: 0, y: 0 },
      width: 100,
      height: 100,
      metadata: { inputOrder: ["video-a", "image-b", "image-a", "text-a"] },
    },
  ],
  edges: [
    { id: "e1", from: "image-a", to: "target" },
    { id: "e2", from: "text-a", to: "target" },
    { id: "e3", from: "video-a", to: "target" },
    { id: "e4", from: "image-b", to: "target" },
  ],
  chatSessions: [],
  activeChatId: null,
  backgroundMode: "dots",
  viewport: { x: 0, y: 0, k: 1 },
} satisfies BoardProject;

describe("node prompt media references", () => {
  test("labels connected media by kind while preserving configured input order", () => {
    expect(buildPromptReferences(project, "target")).toEqual([
      {
        nodeId: "video-a",
        kind: "video",
        label: "视频1",
        title: "Motion",
        content: "https://media.example/motion.mp4",
      },
      {
        nodeId: "image-b",
        kind: "image",
        label: "图片1",
        title: "Back",
        storageKey: "image:back",
      },
      {
        nodeId: "image-a",
        kind: "image",
        label: "图片2",
        title: "Front",
        content: "blob:front",
        storageKey: "image:front",
      },
    ]);
  });

  test("activates only references whose labels remain in the serialized prompt", () => {
    const references = buildPromptReferences(project, "target");
    expect(activePromptReferences("让 图片2 跟随 视频1 运镜", references).map((item) => item.nodeId))
      .toEqual(["video-a", "image-a"]);
  });

  test("splits repeated and overlapping labels without losing prompt text", () => {
    const references = Array.from({ length: 10 }, (_, index) => ({
      nodeId: `image-${index + 1}`,
      kind: "image" as const,
      label: `图片${index + 1}`,
      title: `Image ${index + 1}`,
    }));
    expect(splitPromptReferenceValue("参考图片10和图片1，再看图片10", references)).toEqual([
      { type: "text", value: "参考" },
      { type: "reference", reference: references[9] },
      { type: "text", value: "和" },
      { type: "reference", reference: references[0] },
      { type: "text", value: "，再看" },
      { type: "reference", reference: references[9] },
    ]);
    expect(activePromptReferences("只参考图片10", references).map((item) => item.nodeId))
      .toEqual(["image-10"]);
  });
});
