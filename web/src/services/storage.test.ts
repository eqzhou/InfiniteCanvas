import { afterEach, describe, expect, mock, test } from "bun:test";
import { MEDIA_UPLOAD_LIMITS, sanitizeConfigForPersistence, uploadMedia } from "./storage";
import type { AppConfig } from "@/types/board";

const originalFetch = globalThis.fetch;
const testCredential = (label: string) => `${label}-test-credential`;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("config credential persistence", () => {
  test("removes provider and WebDAV secrets without mutating live config", () => {
    const config: AppConfig = {
      channels: [{
        id: "channel",
        name: "Provider",
        baseUrl: "https://api.example/v1",
        apiKey: testCredential("legacy"),
        defaultTextModel: "text",
        defaultImageModel: "image",
        defaultVideoModel: "video",
        providers: {
          text: { baseUrl: "https://text.example/v1", apiKey: testCredential("text"), model: "text" },
          image: { baseUrl: "https://image.example/v1", apiKey: testCredential("image"), model: "image" },
          video: { baseUrl: "https://video.example/v1", apiKey: testCredential("video"), model: "video" },
          audio: { baseUrl: "https://audio.example/v1", apiKey: testCredential("audio"), model: "audio" },
        },
      }],
      activeChannelId: "channel",
      imageSize: "1024x1024",
      imageQuality: "auto",
      imageCount: 1,
      theme: "dark",
      webdavUrl: "https://dav.example",
      webdavUser: "user",
      webdavPass: "dav-secret",
    };

    const persisted = sanitizeConfigForPersistence(config);
    expect(persisted.channels[0]?.apiKey).toBe("");
    expect(Object.values(persisted.channels[0]?.providers ?? {}).every((provider) => provider.apiKey === "")).toBe(true);
    expect(persisted.channels[0]?.providers?.image.baseUrl).toBe("https://image.example/v1");
    expect(persisted.webdavPass).toBe("");
    expect(config.channels[0]?.apiKey).toBe(testCredential("legacy"));
    expect(config.webdavPass).toBe("dav-secret");
  });
});

describe("remote media upload limits", () => {
  test("rejects an image whose declared size exceeds the upload limit", async () => {
    globalThis.fetch = mock(async () => new Response("", {
      headers: {
        "content-length": String(MEDIA_UPLOAD_LIMITS.imageBytes + 1),
        "content-type": "image/png",
      },
    })) as typeof fetch;

    await expect(uploadMedia("https://media.example/huge.png", "image"))
      .rejects.toThrow("too large");
  });

  test("rejects MIME mismatches before persisting the response", async () => {
    globalThis.fetch = mock(async () => new Response("not an image", {
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

    await expect(uploadMedia("https://media.example/not-image", "image"))
      .rejects.toThrow("MIME");
  });

  test("rejects active SVG content from remote image URLs", async () => {
    globalThis.fetch = mock(async () => new Response("<svg></svg>", {
      headers: { "content-type": "image/svg+xml" },
    })) as typeof fetch;

    await expect(uploadMedia("https://media.example/image.svg", "image"))
      .rejects.toThrow("MIME");
  });

  test("omits credentials and refuses redirects for external media", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = mock(async (_input, requestInit) => {
      init = requestInit;
      return new Response(null, {
        headers: {
          "content-type": "image/png",
          "content-length": String(MEDIA_UPLOAD_LIMITS.imageBytes + 1),
        },
      });
    }) as typeof fetch;

    await expect(uploadMedia("https://media.example/image.png", "image")).rejects.toThrow("too large");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.referrerPolicy).toBe("no-referrer");
    await expect(uploadMedia("https://127.0.0.1/image.png", "image")).rejects.toThrow("private");
  });
});
