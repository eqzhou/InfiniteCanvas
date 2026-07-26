import { describe, expect, test } from "bun:test";
import type { AdminChannel } from "@/services/admin";
import { mergeSavedAdminChannels, shouldDeleteAdminChannel } from "./admin-channel-state";

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
});
