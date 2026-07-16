import { describe, expect, test } from "bun:test";

import { buildBackupBundle, mergeBackupConfig } from "./webdav";
import type { AppConfig } from "@/types/board";

const config = (): AppConfig => ({
  channels: [
    {
      id: "channel_1",
      name: "Primary",
      baseUrl: "https://api.example/v1",
      apiKey: "sk-secret",
      defaultTextModel: "text-model",
      defaultImageModel: "image-model",
      defaultVideoModel: "video-model",
      providers: {
        text: { baseUrl: "https://text.example/v1", apiKey: "sk-text", model: "text-model" },
        image: { baseUrl: "https://image.example/v1", apiKey: "sk-image", model: "image-model" },
        video: { baseUrl: "https://video.example/v1", apiKey: "sk-video", model: "video-model" },
        audio: { baseUrl: "https://audio.example/v1", apiKey: "sk-audio", model: "audio-model" },
      },
    },
  ],
  activeChannelId: "channel_1",
  imageSize: "1024x1024",
  imageQuality: "auto",
  imageCount: 1,
  theme: "dark",
  webdavUrl: "https://dav.example",
  webdavUser: "user",
  webdavPass: "dav-secret",
  promptSources: [],
});

describe("WebDAV backup credentials", () => {
  test("backup bundles omit API keys and the WebDAV password", () => {
    const bundle = buildBackupBundle({
      projects: [],
      assets: [],
      prompts: [],
      config: config(),
    });
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("dav-secret");
    expect(serialized).toContain("https://text.example/v1");
    expect(serialized).toContain("https://video.example/v1");
    expect(serialized).not.toContain("sk-text");
    expect(serialized).not.toContain("sk-video");
    expect(serialized).not.toContain("https://dav.example");
    expect("apiKey" in bundle.config.channels[0]!).toBe(false);
    expect("webdavPass" in bundle.config).toBe(false);
  });

  test("restoring preferences keeps local credentials", () => {
    const local = config();
    const backup = buildBackupBundle({
      projects: [],
      assets: [],
      prompts: [],
      config: { ...config(), imageCount: 4, theme: "light" },
    });
    const restored = mergeBackupConfig(local, backup.config);

    expect(restored.imageCount).toBe(4);
    expect(restored.theme).toBe("light");
    expect(restored.channels[0]?.apiKey).toBe("sk-secret");
    expect(restored.channels[0]?.baseUrl).toBe("https://api.example/v1");
    expect(restored.webdavUrl).toBe("https://dav.example");
    expect(restored.webdavPass).toBe("dav-secret");
  });
});
