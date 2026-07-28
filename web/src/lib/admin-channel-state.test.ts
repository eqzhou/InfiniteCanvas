import { describe, expect, test } from "bun:test";
import type { AdminChannel } from "@/services/admin";
import {
  applyAdminChannelModelSelection,
  buildAdminChannelModelDiff,
  mergeSavedAdminChannels,
  shouldDeleteAdminChannel,
} from "./admin-channel-state";

const channel = (id: string, secretConfigured: boolean): AdminChannel => ({
  id, name: id, baseUrl: "https://api.example/v1", protocol: "openai", enabled: true,
  allowUserUse: true, weight: 1, timeoutSeconds: 60, defaultTextModel: "",
  defaultImageModel: "", defaultVideoModel: "", defaultAudioModel: "", secretConfigured,
});

describe("admin channel persistence state", () => {
  test("deletes any persisted channel even when it has no secret", () => {
    expect(shouldDeleteAdminChannel(new Set(["saved"]), "saved")).toBe(true);
    expect(shouldDeleteAdminChannel(new Set(["saved"]), "draft")).toBe(false);
  });

  test("preserves secret presence by channel ID when the server reorders rows", () => {
    expect(mergeSavedAdminChannels([channel("b", false), channel("a", false)], [channel("a", true), channel("b", false)]))
      .toEqual([channel("b", false), channel("a", true)]);
  });

  test("classifies fetched models without changing the configured catalog", () => {
    const configured = ["gpt-4.1", "legacy-image"];
    const fetched = ["gpt-4.1", "new-video", "new-video"];

    expect(buildAdminChannelModelDiff(configured, fetched)).toEqual({
      added: ["new-video"],
      existing: ["gpt-4.1"],
      removed: ["legacy-image"],
      selected: ["gpt-4.1", "new-video"],
    });
    expect(configured).toEqual(["gpt-4.1", "legacy-image"]);
  });

  test("keeps the fetched order and lets confirmation retain removed models", () => {
    const diff = buildAdminChannelModelDiff(
      ["legacy-image", "gpt-4.1"],
      ["new-video", "gpt-4.1"],
    );

    expect(applyAdminChannelModelSelection(diff, ["legacy-image", "new-video"]))
      .toEqual(["new-video", "legacy-image"]);
  });

  test("trims empty model IDs and applies each selected ID once", () => {
    const diff = buildAdminChannelModelDiff([" old ", ""], [" new ", "NEW", ""]);

    expect(diff).toEqual({
      added: ["new"],
      existing: [],
      removed: ["old"],
      selected: ["new"],
    });
    expect(applyAdminChannelModelSelection(diff, ["new", "new", "unknown", " "]))
      .toEqual(["new"]);
  });

  test("treats model IDs case-insensitively like channel persistence", () => {
    expect(buildAdminChannelModelDiff(["GPT-4.1"], ["gpt-4.1"])).toEqual({
      added: [],
      existing: ["gpt-4.1"],
      removed: [],
      selected: ["gpt-4.1"],
    });
  });
});
