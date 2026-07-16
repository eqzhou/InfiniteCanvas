import { describe, expect, test } from "bun:test";
import { defaultModelForMode } from "@/lib/generation-model";
import type { AiChannel } from "@/types/board";

const channel: AiChannel = {
  id: "channel",
  name: "AI",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  defaultTextModel: "text-model",
  defaultImageModel: "image-model",
  defaultVideoModel: "video-model",
};

describe("defaultModelForMode", () => {
  test("maps every generation capability to its configured default", () => {
    expect(defaultModelForMode(channel, "text")).toBe("text-model");
    expect(defaultModelForMode(channel, "image")).toBe("image-model");
    expect(defaultModelForMode(channel, "video")).toBe("video-model");
  });
});
