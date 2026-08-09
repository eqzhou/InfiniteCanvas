import { describe, expect, test } from "bun:test";
import type { AdminChannel } from "@/services/admin";
import {
  applyAdminChannelModelSelection,
  adminChannelSecretBindingIsCurrent,
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

  test("uses the server's authoritative secret presence when rows are saved", () => {
    expect(mergeSavedAdminChannels([channel("b", false), channel("a", false)]))
      .toEqual([channel("b", false), channel("a", false)]);
  });

  test("requires a new channel to be persisted before saving its first secret", () => {
    const draft = channel("new-channel", false);

    expect(adminChannelSecretBindingIsCurrent(draft, undefined)).toBe(false);
  });

  test("accepts the binding returned for the persisted destination", () => {
    const saved = { ...channel("saved-channel", true), secretBindingId: "existing-binding" };

    expect(adminChannelSecretBindingIsCurrent(saved, saved)).toBe(true);
  });

  test("rejects a stale binding after the channel destination changes", () => {
    const persisted = { ...channel("saved-channel", true), secretBindingId: "existing-binding" };

    expect(adminChannelSecretBindingIsCurrent(
      { ...persisted, baseUrl: "https://new.example/v1" },
      persisted,
    )).toBe(false);
    expect(adminChannelSecretBindingIsCurrent(
      { ...persisted, protocol: "gemini" },
      persisted,
    )).toBe(false);
  });

  test("requires policy and model changes to be saved before writing a secret", () => {
    const persisted = {
      ...channel("saved-channel", true),
      secretBindingId: "existing-binding",
      models: ["image-v1"],
    };

    expect(adminChannelSecretBindingIsCurrent(
      { ...persisted, allowUserUse: false },
      persisted,
    )).toBe(false);
    expect(adminChannelSecretBindingIsCurrent(
      { ...persisted, enabled: false },
      persisted,
    )).toBe(false);
    expect(adminChannelSecretBindingIsCurrent(
      { ...persisted, models: ["image-v2"] },
      persisted,
    )).toBe(false);
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
