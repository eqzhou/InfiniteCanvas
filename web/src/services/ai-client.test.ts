import { afterEach, describe, expect, mock, test } from "bun:test";
import { generateImages, generateSpeech, generateText, generateVideo, listModels } from "@/services/ai-client";
import type { AiChannel } from "@/types/board";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function channel(baseUrl: string): AiChannel {
  return {
    id: "video-channel",
    name: "Video",
    baseUrl,
    apiKey: "secret",
    defaultTextModel: "text",
    defaultImageModel: "image",
    defaultVideoModel: "video",
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("generateVideo provider contracts", () => {
  test("lists models from the selected provider endpoint and credentials", async () => {
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
      return json({ data: [{ id: "video-z" }, { id: "video-a" }] });
    }) as typeof fetch;
    const c = { ...channel("https://legacy.example/v1"), providers: {
      text: { baseUrl: "https://text.example/v1", apiKey: "text-key", model: "text" },
      image: { baseUrl: "https://image.example/v1", apiKey: "image-key", model: "image" },
      video: { baseUrl: "https://video.example/v1", apiKey: "video-key", model: "video" },
      audio: { baseUrl: "https://audio.example/v1", apiKey: "audio-key", model: "audio" },
    } };

    await expect(listModels(c, "video")).resolves.toEqual(["video-a", "video-z"]);
    expect(requests).toEqual([{ url: "https://video.example/v1/models", auth: "Bearer video-key" }]);
  });

  test("routes each generation kind to its own URL and API key", async () => {
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
      if (String(input).includes("text.example")) return json({ output_text: "ok" });
      if (String(input).includes("image.example")) return json({ data: [{ url: "https://cdn.example/image.png" }] });
      return new Response(new Blob(["audio"], { type: "audio/mpeg" }));
    }) as typeof fetch;
    const c = { ...channel("https://legacy.example/v1"), providers: {
      text: { baseUrl: "https://text.example/v1", apiKey: "text-key", model: "text" },
      image: { baseUrl: "https://image.example/v1", apiKey: "image-key", model: "image" },
      video: { baseUrl: "https://video.example/v1", apiKey: "video-key", model: "video" },
      audio: { baseUrl: "https://audio.example/v1", apiKey: "audio-key", model: "audio" },
    } };

    await generateText({ channel: c, model: "text", prompt: "hello" });
    await generateImages({ channel: c, model: "image", prompt: "hello" });
    await generateSpeech({ channel: c, model: "audio", input: "hello" });

    expect(requests.map((r) => r.url)).toEqual([
      "https://text.example/v1/responses",
      "https://image.example/v1/images/generations",
      "https://audio.example/v1/audio/speech",
    ]);
    expect(requests.map((r) => r.auth)).toEqual(["Bearer text-key", "Bearer image-key", "Bearer audio-key"]);
  });
  test("recognizes the standard Ark /api/v3 endpoint and parses nested task output", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ url: String(input), body: init?.body?.toString() });
      if (requests.length === 1) return json({ data: { id: "ark-task" } });
      return json({
        data: {
          status: "succeeded",
          content: { video_url: { url: "https://cdn.example/video.mp4" } },
        },
      });
    }) as typeof fetch;

    const result = await generateVideo({
      channel: channel("https://ark.cn-beijing.volces.com/api/v3"),
      model: "seedance-1-0-pro",
      prompt: "city",
      referenceImages: ["https://cdn.example/ref.png"],
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      id: "ark-task",
      status: "succeeded",
      url: "https://cdn.example/video.mp4",
    });
    expect(requests[0]?.url).toEndWith("/api/v3/contents/generations/tasks");
    expect(JSON.parse(requests[0]?.body ?? "{}").content).toEqual([
      { type: "text", text: "city" },
      {
        type: "image_url",
        image_url: { url: "https://cdn.example/ref.png" },
        role: "reference_image",
      },
    ]);
  });

  test("accepts vendor-neutral task_id, task_status, camelCase, and video list fields", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return calls === 1
        ? json({ data: { task_id: "task-alias" } })
        : json({ data: { task_status: "finished", output: { videos: [{ videoUrl: "https://cdn.example/alias.mp4" }] } } });
    }) as typeof fetch;
    await expect(generateVideo({
      channel: channel("https://ark.example/api/v3"),
      model: "seedance",
      prompt: "alias",
      pollIntervalMs: 0,
    })).resolves.toEqual({ id: "task-alias", status: "succeeded", url: "https://cdn.example/alias.mp4" });
  });

  test("accepts nested taskId/state and result download aliases", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return calls === 1
        ? json({ data: { taskId: "nested-alias" } })
        : json({ data: { state: "finished", result: { downloadUrl: "https://cdn.example/nested.mp4" } } });
    }) as typeof fetch;
    await expect(generateVideo({
      channel: channel("https://ark.example/api/v3"),
      model: "seedance",
      prompt: "nested",
      pollIntervalMs: 0,
    })).resolves.toEqual({ id: "nested-alias", status: "succeeded", url: "https://cdn.example/nested.mp4" });
  });

  test("recognizes terminal done and cancelled vendor statuses", async () => {
    globalThis.fetch = mock(async () => json({ id: "done-task", status: "done", videoUrl: "https://cdn.example/done.mp4" })) as typeof fetch;
    await expect(generateVideo({
      channel: channel("https://ark.example/api/v3"),
      model: "seedance",
      prompt: "done",
    })).resolves.toMatchObject({ id: "done-task", url: "https://cdn.example/done.mp4" });

    globalThis.fetch = mock(async () => json({ id: "cancel-task", status: "cancelled" })) as typeof fetch;
    await expect(generateVideo({
      channel: channel("https://ark.example/api/v3"),
      model: "seedance",
      prompt: "cancel",
    })).rejects.toThrow("cancelled");
  });

  test("accepts a completed OpenAI video response containing a direct URL", async () => {
    globalThis.fetch = mock(async (_input, init) => {
      if (init?.method === "POST") return json({ id: "oa-task", status: "queued" });
      return json({
        id: "oa-task",
        status: "completed",
        output: { url: "https://cdn.example/openai.mp4" },
      });
    }) as typeof fetch;

    const result = await generateVideo({
      channel: channel("https://api.openai.com/v1"),
      model: "sora-2",
      prompt: "ocean",
      pollIntervalMs: 0,
    });

    expect(result.url).toBe("https://cdn.example/openai.mp4");
  });

  test("downloads content immediately when OpenAI create is already completed", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push(String(input));
      if (init?.method === "POST") return json({ id: "oa-task", status: "completed" });
      return new Response(new Blob(["video"], { type: "video/mp4" }));
    }) as typeof fetch;

    const result = await generateVideo({
      channel: channel("https://api.openai.com/v1"),
      model: "sora-2",
      prompt: "ocean",
      pollIntervalMs: 0,
    });

    expect(result.url).toStartWith("blob:");
    expect(requests).toEqual([
      "https://api.openai.com/v1/videos",
      "https://api.openai.com/v1/videos/oa-task/content",
    ]);
  });

  test("does not probe another video API after authentication failure", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input) => {
      calls.push(String(input));
      return new Response("denied", { status: 401 });
    }) as typeof fetch;

    await expect(generateVideo({
      channel: channel("https://ark.cn-beijing.volces.com/api/v3"),
      model: "seedance-1-0-pro",
      prompt: "city",
      pollIntervalMs: 0,
    })).rejects.toThrow("AI 401");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEndWith("/api/v3/contents/generations/tasks");
  });

  for (const status of [429, 500, 503]) {
    test(`does not retry or fallback after HTTP ${status}`, async () => {
      let calls = 0;
      globalThis.fetch = mock(async () => {
        calls += 1;
        return new Response("upstream error", { status });
      }) as typeof fetch;

      await expect(generateVideo({
        channel: channel("https://api.openai.com/v1"),
        model: "sora-2",
        prompt: "ocean",
        pollIntervalMs: 0,
      })).rejects.toThrow(`AI ${status}`);
      expect(calls).toBe(1);
    });
  }

  test("aborts polling promptly with the caller signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) {
        queueMicrotask(() => controller.abort(new DOMException("Stopped", "AbortError")));
        return json({ id: "oa-task", status: "queued" });
      }
      return json({ id: "oa-task", status: "queued" });
    }) as typeof fetch;

    await expect(generateVideo({
      channel: channel("https://api.openai.com/v1"),
      model: "sora-2",
      prompt: "ocean",
      signal: controller.signal,
      pollIntervalMs: 50,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  test("does not create a task when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return json({ id: "unexpected" });
    }) as typeof fetch;

    await expect(generateVideo({
      channel: channel("https://api.openai.com/v1"),
      model: "sora-2",
      prompt: "ocean",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  test("uses a configurable overall timeout", async () => {
    globalThis.fetch = mock(async (_input, init) => {
      if (init?.method === "POST") return json({ id: "oa-task", status: "queued" });
      return json({ id: "oa-task", status: "queued" });
    }) as typeof fetch;

    await expect(generateVideo({
      channel: channel("https://api.openai.com/v1"),
      model: "sora-2",
      prompt: "ocean",
      timeoutMs: 5,
      pollIntervalMs: 20,
    })).rejects.toThrow("Video generation timeout");
  });

  test("rejects a malformed successful Ark task instead of returning an empty result", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return calls === 1
        ? json({ id: "ark-task" })
        : json({ status: "succeeded", content: {} });
    }) as typeof fetch;

    await expect(generateVideo({
      channel: channel("https://ark.cn-beijing.volces.com/api/v3"),
      model: "seedance-1-0-pro",
      prompt: "city",
      pollIntervalMs: 0,
    })).rejects.toThrow("video URL missing");
  });

  test("surfaces a nested provider failure without polling again", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return calls === 1
        ? json({ data: { id: "ark-task" } })
        : json({ data: { status: "failed" } });
    }) as typeof fetch;

    await expect(generateVideo({
      channel: channel("https://ark.cn-beijing.volces.com/api/v3"),
      model: "seedance-1-0-pro",
      prompt: "city",
      pollIntervalMs: 0,
    })).rejects.toThrow("Video generation failed: failed");
    expect(calls).toBe(2);
  });
});
