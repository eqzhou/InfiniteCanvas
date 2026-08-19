import { describe, expect, test } from "bun:test";

import {
  buildBackupBundle,
  mergeBackupConfig,
  webdavGet,
  webdavGetBlob,
  webdavPut,
  webdavPutBlob,
} from "./webdav";
import type { AppConfig } from "@/types/board";
import { afterEach, mock } from "bun:test";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

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

  test("never rebinds local credentials to imported provider routes", () => {
    const local = config();
    const backup = buildBackupBundle({
      projects: [],
      assets: [],
      prompts: [],
      config: config(),
    });
    const hostile = structuredClone(backup.config);
    hostile.channels[0]!.baseUrl = "https://attacker.example/v1";
    hostile.channels[0]!.providers!.image.baseUrl = "https://attacker.example/v1";
    hostile.channels[0]!.providers!.text.protocol = "template";

    const restored = mergeBackupConfig(local, hostile);
    expect(restored.channels[0]?.baseUrl).toBe("https://attacker.example/v1");
    expect(restored.channels[0]?.apiKey).toBe("");
    expect(restored.channels[0]?.providers?.image.apiKey).toBe("");
    expect(restored.channels[0]?.providers?.text.apiKey).toBe("");
    expect(restored.channels[0]?.providers?.video.apiKey).toBe("sk-video");
  });
});

describe("WebDAV transport boundaries", () => {
  test("accepts loopback HTTP and sends Basic auth for JSON PUT/GET", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return init?.method === "GET"
        ? new Response("hello", { status: 200, headers: { "Content-Type": "text/plain" } })
        : new Response(null, { status: 204 });
    }) as typeof fetch;

    const local = { ...config(), webdavUrl: "http://localhost:9876///", webdavUser: "u", webdavPass: "p" };
    await expect(webdavPut(local, "/backup.json", "{}" as string)).resolves.toBeUndefined();
    await expect(webdavGet(local, "nested/backup.json")).resolves.toBe("hello");

    expect(requests[0]?.url).toBe("http://localhost:9876/backup.json");
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
      `Basic ${btoa("u:p")}`,
    );
    expect(requests[1]?.url).toBe("http://localhost:9876/nested/backup.json");
    expect(new Headers(requests[1]?.init?.headers).get("Authorization")).toBe(`Basic ${btoa("u:p")}`);
  });

  test("rejects unsafe WebDAV URLs before issuing a request", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(webdavGet({ ...config(), webdavUrl: "" }, "backup.json")).rejects.toThrow("未配置 WebDAV URL");
    await expect(webdavGet({ ...config(), webdavUrl: "http://dav.example" }, "backup.json"))
      .rejects.toThrow("必须使用 HTTPS");
    await expect(webdavGet({ ...config(), webdavUrl: "ftp://dav.example" }, "backup.json"))
      .rejects.toThrow("必须使用 HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("handles streamed text, invalid UTF-8, and bounded response headers", async () => {
    const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(stream([new TextEncoder().encode("hel"), new TextEncoder().encode("lo")]), { status: 200 });
      }
      if (calls === 2) {
        return new Response(stream([new Uint8Array([0xc3, 0x28])]), { status: 200 });
      }
      return new Response("ignored", {
        status: 200,
        headers: { "Content-Length": String(33 * 1024 * 1024) },
      });
    }) as typeof fetch;

    await expect(webdavGet(config(), "stream.json")).resolves.toBe("hello");
    await expect(webdavGet(config(), "invalid.json")).rejects.toThrow();
    await expect(webdavGet(config(), "large.json")).rejects.toThrow("response is too large");
  });

  test("cancels an oversized streamed response and accepts a streamed blob", async () => {
    let cancelled = false;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("too-large.bin")) {
        const oversized = new ReadableStream<Uint8Array>({
          start(controller) {
            // limitedResponseBytes only needs byteLength before cancelling;
            // model a 128 MB + 1 byte chunk without allocating it.
            const chunk = new Uint8Array(1);
            Object.defineProperty(chunk, "byteLength", { value: 128 * 1024 * 1024 + 1 });
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(oversized, { status: 200 });
      }
      const small = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });
      return new Response(small, { status: 200, headers: { "Content-Type": "image/png" } });
    }) as typeof fetch;

    await expect(webdavGetBlob(config(), "too-large.bin")).rejects.toThrow("response is too large");
    await expect(webdavGetBlob(config(), "ok.bin")).resolves.toMatchObject({ type: "image/png", size: 3 });
    expect(cancelled).toBe(true);
  });

  test("uploads JSON blobs, preserves their MIME type, and surfaces HTTP errors", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let fail = false;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (fail) return new Response(null, { status: 507 });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const blob = new Blob(["zip"], { type: "application/zip" });
    await expect(webdavPutBlob({ ...config(), webdavUser: undefined, webdavPass: undefined }, "backup.zip", blob))
      .resolves.toBeUndefined();
    expect(requests[0]?.url).toBe("https://dav.example/backup.zip");
    expect(new Headers(requests[0]?.init?.headers).get("Content-Type")).toBe("application/zip");
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBeNull();

    fail = true;
    await expect(webdavPutBlob(config(), "backup.zip", blob)).rejects.toThrow("WebDAV PUT 507");
    await expect(webdavPut(config(), "backup.json", "{}")).rejects.toThrow("WebDAV PUT 507");
  });

  test("rejects a blob larger than the 128 MB WebDAV bundle limit", async () => {
    const body = new Blob(["x"]);
    Object.defineProperty(body, "size", { configurable: true, value: 128 * 1024 * 1024 + 1 });
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(webdavPutBlob(config(), "huge.zip", body)).rejects.toThrow("bundle is too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("restores matching provider credentials but falls back safely for missing routes", () => {
    const local = config();
    const backup = structuredClone(buildBackupBundle({ projects: [], assets: [], prompts: [], config: config() }).config);
    backup.channels.push({
      id: "new-channel",
      name: "New",
      baseUrl: "",
      defaultTextModel: "",
      defaultImageModel: "",
      defaultVideoModel: "",
    });
    const restored = mergeBackupConfig(local, backup);
    expect(restored.channels[0]?.providers?.text?.apiKey).toBe("sk-text");
    expect(restored.channels[1]).toMatchObject({ id: "new-channel", apiKey: "", baseUrl: "" });
    expect(restored.objectStorage).toBe(local.objectStorage);
  });
});
