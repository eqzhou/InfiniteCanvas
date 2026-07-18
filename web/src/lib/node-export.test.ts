import { describe, expect, test } from "bun:test";
import { createNode } from "@/lib/defaults";
import { exportNodeSelection } from "@/lib/node-export";
import { readZipStore } from "@/lib/zip-store";

describe("canvas element batch export", () => {
  test("exports text, media bytes, and structured nodes without mutating inputs", async () => {
    const text = createNode("text", { x: 0, y: 0 }, {
      title: "Campaign brief",
      metadata: { content: "Launch copy" },
    });
    const image = createNode("image", { x: 20, y: 20 }, {
      title: "Hero/image",
      metadata: { storageKey: "image:hero", mimeType: "image/png" },
    });
    const config = createNode("config", { x: 40, y: 40 }, { title: "Generation config" });
    const nodes = [text, image, config];
    const before = structuredClone(nodes);

    const archive = await exportNodeSelection(nodes, async (node) =>
      node.id === image.id ? new Blob(["png-bytes"], { type: "image/png" }) : undefined);
    const entries = await readZipStore(archive);
    const decoder = new TextDecoder();

    expect([...entries.keys()]).toEqual([
      "Campaign brief.txt",
      "Hero-image.png",
      "Generation config.json",
    ]);
    expect(decoder.decode(entries.get("Campaign brief.txt"))).toBe("Launch copy");
    expect(decoder.decode(entries.get("Hero-image.png"))).toBe("png-bytes");
    expect(JSON.parse(decoder.decode(entries.get("Generation config.json")))?.id).toBe(config.id);
    expect(nodes).toEqual(before);
  });

  test("rejects empty and excessive selections", async () => {
    await expect(exportNodeSelection([])).rejects.toThrow(/选择/);
    const node = createNode("text", { x: 0, y: 0 });
    await expect(exportNodeSelection(Array.from({ length: 501 }, () => node))).rejects.toThrow(/500/);
  });
});
