import { describe, expect, test } from "bun:test";
import { createDefaultChannel, createNode } from "@/lib/defaults";
import {
  resolveNodePromptModelChoices,
  resolveNodePromptModels,
  resolveNodePromptSelectedModel,
} from "@/lib/node-prompt-models";

describe("node prompt model options", () => {
  test("uses pulled provider models and falls back to the active default", () => {
    const channel = createDefaultChannel();
    channel.providers!.image = {
      ...channel.providers!.image,
      model: "gpt-image-1",
      models: ["gpt-image-1", "seedream-4"],
    };
    expect(resolveNodePromptModels(channel, "image")).toEqual(["gpt-image-1", "seedream-4"]);

    const bare = createDefaultChannel();
    bare.providers!.text = { ...bare.providers!.text, model: "gpt-4o-mini", models: undefined };
    expect(resolveNodePromptModels(bare, "text")).toEqual(["gpt-4o-mini"]);
  });

  test("honors the tenant allow list without inventing models", () => {
    const channel = createDefaultChannel();
    channel.providers!.text = {
      ...channel.providers!.text,
      model: "gpt-4o-mini",
      models: ["gpt-4o-mini", "blocked-model"],
    };
    expect(resolveNodePromptModels(channel, "text", { availableModels: ["gpt-4o-mini"] }))
      .toEqual(["gpt-4o-mini"]);
  });

  test("prefers an explicit node model over the channel default", () => {
    const channel = createDefaultChannel();
    const node = createNode("image", { x: 0, y: 0 }, { metadata: { model: "custom-image" } });
    expect(resolveNodePromptSelectedModel(node, channel)).toBe("custom-image");
    const bare = createNode("text", { x: 0, y: 0 });
    expect(resolveNodePromptSelectedModel(bare, channel)).toBe(channel.providers!.text.model);
  });

  test("does not repeat a lone inherited audio model as an explicit choice", () => {
    const channel = createDefaultChannel();
    channel.providers!.audio = {
      ...channel.providers!.audio,
      protocol: "edge",
      model: "edge-tts",
      models: ["edge-tts", "edge-tts"],
    };
    const node = createNode("audio", { x: 0, y: 0 });

    expect(resolveNodePromptModelChoices(node, channel)).toEqual({
      inheritedLabel: "跟随渠道（edge-tts）",
      options: [],
    });
  });
});
