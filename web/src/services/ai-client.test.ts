import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  generateImages,
  generateSpeech,
  generateText,
  generateVideo,
  listModels,
  resolveMediaRefs,
  resolveNodeImageDataUrl,
} from "@/services/ai-client";
import type { AiChannel } from "@/types/board";
import { sharedChannelAsAI } from "@/services/shared-channels";

const originalFetch = globalThis.fetch;
const fixtureCredential = ["test", "credential"].join("-");

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uses an inline image when persistent blob storage is unavailable", async () => {
  const dataUrl = "data:image/png;base64,cGl4ZWw=";
  await expect(resolveNodeImageDataUrl(undefined, dataUrl)).resolves.toBe(dataUrl);
  await expect(resolveNodeImageDataUrl(undefined, "blob:temporary")).resolves.toBeNull();
});

test("falls back to inline media when a persisted reference is temporarily unavailable", async () => {
  const dataUrl = "data:image/png;base64,cGl4ZWw=";
  await expect(resolveMediaRefs([{
    storageKey: "image:missing",
    content: dataUrl,
  }], 1)).resolves.toEqual([dataUrl]);
});

test("rejects an excessive image batch before contacting a provider", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    return json({ data: [] });
  }) as typeof fetch;
  await expect(generateImages({
    channel: channel("https://api.example/v1"),
    model: "image",
    prompt: "scene",
    n: 9,
  })).rejects.toThrow("between 1 and 8");
  expect(calls).toBe(0);
});

test("rejects APIMart browser image execution before contacting the provider", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => {
    calls += 1;
    return json({});
  }) as typeof fetch;
  const c = channel("https://api.apimart.ai");
  c.providers = {
    ...defaultProvidersForTest(c),
    image: { baseUrl: "https://api.apimart.ai", apiKey: fixtureCredential, model: "gpt-image-1-official", protocol: "apimart" },
  };
  await expect(generateImages({ channel: c, model: "gpt-image-1-official", prompt: "draw" }))
    .rejects.toThrow("requires the protected server runtime");
  expect(calls).toBe(0);
});

test("never sends a server-managed shared credential to a browser provider", async () => {
  let calls = 0;
  globalThis.fetch = mock(async () => { calls += 1; return json({}); }) as typeof fetch;
  const managed = sharedChannelAsAI({ id: "shared", name: "Shared", protocol: "openai", defaultImageModel: "image" });
  await expect(generateImages({ channel: managed, model: "image", prompt: "draw" })).rejects.toThrow("受保护的服务端");
  expect(calls).toBe(0);
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
  test("routes remote text generation through the same-origin provider gateway", async () => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    globalThis.fetch = mock(async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      if (!url.startsWith("/api/")) throw new TypeError("Failed to fetch");
      return json({ text: "gateway response" });
    }) as typeof fetch;

    await expect(generateText({
      channel: channel("https://api.example/v1"),
      model: "text",
      prompt: "hello",
      systemPrompt: "Be concise",
      reasoningEffort: "high",
    })).resolves.toBe("gateway response");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/api/provider-text");
    expect(requests[0]?.headers.has("Authorization")).toBe(false);
    expect(requests[0]?.body).toEqual({
      channelId: "video-channel",
      model: "text",
      prompt: "hello",
      images: [],
      systemPromptProfile: "global",
      reasoningEffort: "high",
    });
  });

  test("does not fall back to a remote browser request when the text gateway fails", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input) => {
      requests.push(String(input));
      return new Response("文本模型服务暂时不可用", { status: 503 });
    }) as typeof fetch;

    await expect(generateText({
      channel: channel("https://api.example/v1"),
      model: "text",
      prompt: "hello",
    })).rejects.toThrow("文本模型服务暂时不可用");
    expect(requests).toEqual(["/api/provider-text"]);
  });

  test("keeps loopback text providers browser-direct in server storage mode", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return json({ output_text: "local response" });
    }) as typeof fetch;

    await expect(generateText({
      channel: channel("http://127.0.0.1:11434/v1"),
      model: "local-model",
      prompt: "hello",
      reasoningEffort: "medium",
    })).resolves.toBe("local response");
    expect(requests).toEqual([{
      url: "http://127.0.0.1:11434/v1/responses",
      authorization: "Bearer secret",
      body: {
        model: "local-model",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        reasoning: { effort: "medium" },
      },
    }]);
  });

  test("applies a global system prompt to OpenAI text and image requests", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = mock(async (input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return String(input) === "/api/provider-text"
        ? json({ text: "ok" })
        : json({ data: [{ url: "https://cdn.example/system.png" }] });
    }) as typeof fetch;

    await generateText({
      channel: channel("https://api.example/v1"),
      model: "text",
      prompt: "user request",
      systemPrompt: "Keep the result concise.",
    });
    await generateImages({
      channel: channel("https://api.example/v1"),
      model: "image",
      prompt: "draw a lighthouse",
      systemPrompt: "Use a transparent editorial style.",
    });

    expect(bodies[0]).toMatchObject({ systemPromptProfile: "global" });
    expect(bodies[1]).toMatchObject({
      prompt: "Use a transparent editorial style.\n\ndraw a lighthouse",
    });
  });

  test("uses Gemini text and image contracts with header credentials", async () => {
    const requests: Array<{ url: string; apiKey: string | null; body: unknown }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get("x-goog-api-key"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return String(input) === "/api/provider-text"
        ? json({ text: "gemini text" })
        : json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "YWJj" } }] } }] });
    }) as typeof fetch;
    const c = channel("https://legacy.example/v1");
    c.providers = {
      ...defaultProvidersForTest(c),
      text: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: fixtureCredential, model: "gemini-2.5-flash", protocol: "gemini" },
      image: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: fixtureCredential, model: "gemini-2.5-flash-image", protocol: "gemini" },
    };

    await expect(generateText({ channel: c, model: c.providers.text.model, prompt: "hello", systemPrompt: "Be concise" })).resolves.toBe("gemini text");
    await expect(generateImages({ channel: c, model: c.providers.image.model, prompt: "draw", systemPrompt: "Use clean lines", n: 2 })).resolves.toEqual([
      "data:image/png;base64,YWJj",
      "data:image/png;base64,YWJj",
    ]);
    expect(requests.map((item) => item.apiKey)).toEqual([null, fixtureCredential, fixtureCredential]);
    expect(requests[0]?.url).toBe("/api/provider-text");
    expect(requests[0]?.body).toMatchObject({ channelId: c.id, systemPromptProfile: "global" });
    expect(requests[1]?.body).toMatchObject({ contents: [{ parts: [{ text: "Use clean lines\n\ndraw" }] }] });
    expect(requests[2]?.body).toMatchObject({ contents: [{ parts: [{ text: "Use clean lines\n\ndraw" }] }] });
  });

  test("executes a safe image template and rejects unsupported transparency before fetch", async () => {
    let calls = 0;
    globalThis.fetch = mock(async (_input, init) => {
      calls += 1;
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${fixtureCredential}`);
      expect(JSON.parse(String(init?.body))).toEqual({ prompt: "draw", model: "relay-image", transparent: false });
      return json({ output: { images: ["https://cdn.example/template.png"] } });
    }) as typeof fetch;
    const c = channel("https://legacy.example/v1");
    c.providers = {
      ...defaultProvidersForTest(c),
      image: {
        baseUrl: "https://relay.example/api",
        apiKey: fixtureCredential,
        model: "relay-image",
        protocol: "template",
        template: {
          method: "POST",
          path: "/generate",
          auth: "bearer",
          request: { prompt: "{{prompt}}", model: "{{model}}", transparent: "{{transparentBackground}}" },
          responsePath: "output.images",
        },
      },
    };
    await expect(generateImages({ channel: c, model: "relay-image", prompt: "draw" })).resolves.toEqual(["https://cdn.example/template.png"]);
    await expect(generateImages({ channel: c, model: "relay-image", prompt: "draw", transparentBackground: true })).rejects.toThrow("transparent");
    expect(calls).toBe(1);
  });

  test("maps transparent background to OpenAI image generation", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ data: [{ url: "https://cdn.example/transparent.png" }] });
    }) as typeof fetch;
    await generateImages({ channel: channel("https://api.example/v1"), model: "image", prompt: "logo", transparentBackground: true });
    expect(body.background).toBe("transparent");
  });

  test("uses the OpenAI generations endpoint for text-to-image requests", async () => {
    const requests: Array<{ url: string; method?: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body)),
      });
      return json({ data: [{ url: "https://cdn.example/generated.png" }] });
    }) as typeof fetch;

    await expect(generateImages({
      channel: channel("https://api.example/v1"),
      model: "gpt-image-1",
      prompt: "draw a lighthouse",
      size: "1536x1024",
      quality: "high",
      n: 2,
    })).resolves.toEqual(["https://cdn.example/generated.png"]);

    expect(requests).toEqual([{
      url: "https://api.example/v1/images/generations",
      method: "POST",
      body: {
        model: "gpt-image-1",
        prompt: "draw a lighthouse",
        n: 2,
        size: "1536x1024",
        quality: "high",
      },
    }]);
  });

  test("normalizes legacy ratio values before direct OpenAI image requests", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ data: [{ url: "https://cdn.example/legacy.png" }] });
    }) as typeof fetch;

    await generateImages({
      channel: channel("https://api.example/v1"),
      model: "gpt-image-1",
      prompt: "legacy ratio",
      size: "3:2",
    });

    expect(body.size).toBe("1536x1024");
  });

  test("keeps invalid direct output counts rejected after provider normalization", async () => {
    let requests = 0;
    globalThis.fetch = mock(async () => {
      requests += 1;
      return json({ data: [{ url: "https://cdn.example/should-not-run.png" }] });
    }) as typeof fetch;

    await expect(generateImages({
      channel: channel("https://api.example/v1"),
      model: "gpt-image-1",
      prompt: "invalid count",
      n: 0,
    })).rejects.toThrow("between 1 and 8");
    expect(requests).toBe(0);
  });

  test("uses the OpenAI edits endpoint and image[] multipart fields for image-to-image requests", async () => {
    const requests: Array<{ url: string; method?: string; body: FormData }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        body: init?.body as FormData,
      });
      return json({ data: [{ url: "https://cdn.example/edited.png" }] });
    }) as typeof fetch;

    await expect(generateImages({
      channel: channel("https://api.example/v1"),
      model: "gpt-image-1",
      prompt: "add a rainbow",
      size: "1024x1024",
      quality: "medium",
      referenceDataUrls: ["data:image/jpeg;base64,cGl4ZWw="],
      referenceBlobs: [new Blob(["second reference"], { type: "image/webp" })],
      transparentBackground: true,
    })).resolves.toEqual(["https://cdn.example/edited.png"]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example/v1/images/edits");
    expect(requests[0]?.method).toBe("POST");

    const body = requests[0]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect(body?.get("model")).toBe("gpt-image-1");
    expect(body?.get("prompt")).toBe("add a rainbow");
    expect(body?.get("n")).toBe("1");
    expect(body?.get("size")).toBe("1024x1024");
    expect(body?.get("quality")).toBe("medium");
    expect(body?.get("background")).toBe("transparent");
    const references = body?.getAll("image[]") as File[];
    expect(references).toHaveLength(2);
    expect(body?.getAll("image")).toHaveLength(0);
    expect(references.every((entry) => entry instanceof Blob)).toBe(true);
    expect(references.map((entry) => ({ name: entry.name, type: entry.type }))).toEqual([
      { name: "ref-0.jpg", type: "image/jpeg" },
      { name: "ref-1.webp", type: "image/webp" },
    ]);
  });

  test("rejects transparent background for gpt-image-2 before contacting OpenAI", async () => {
    let requests = 0;
    globalThis.fetch = mock(async () => {
      requests += 1;
      return json({ data: [] });
    }) as typeof fetch;

    await expect(generateImages({
      channel: channel("https://api.example/v1"),
      model: "gpt-image-2",
      prompt: "draw a transparent logo",
      transparentBackground: true,
    })).rejects.toThrow("does not support transparent");
    expect(requests).toBe(0);
  });

  test("executes a synchronous declarative video relay", async () => {
    globalThis.fetch = mock(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ prompt: "motion", duration: 6 });
      return json({ data: { url: "https://cdn.example/relay.mp4" } });
    }) as typeof fetch;
    const c = channel("https://legacy.example/v1");
    c.providers = {
      ...defaultProvidersForTest(c),
      video: {
        baseUrl: "https://relay.example/api",
        apiKey: fixtureCredential,
        model: "relay-video",
        protocol: "template",
        template: {
          method: "POST",
          path: "/video",
          auth: "x-api-key",
          request: { prompt: "{{prompt}}", duration: "{{duration}}" },
          responsePath: "data.url",
        },
      },
    };
    await expect(generateVideo({ channel: c, model: "relay-video", prompt: "motion", seconds: 6 })).resolves.toMatchObject({
      status: "succeeded",
      url: "https://cdn.example/relay.mp4",
    });
  });
  test("lists models from the selected provider endpoint and credentials", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return json({ models: ["video-z", "video-a"] });
    }) as typeof fetch;
    const c = { ...channel("https://legacy.example/v1"), providers: {
      text: { baseUrl: "https://text.example/v1", apiKey: "text-key", model: "text" },
      image: { baseUrl: "https://image.example/v1", apiKey: "image-key", model: "image" },
      video: { baseUrl: "https://video.example/v1", apiKey: "video-key", model: "video" },
      audio: { baseUrl: "https://audio.example/v1", apiKey: "audio-key", model: "audio" },
    } };

    await expect(listModels(c, "video")).resolves.toEqual(["video-a", "video-z"]);
    expect(requests).toEqual([{
      url: "/api/provider-models",
      body: {
        channelId: "video-channel",
        kind: "video",
      },
    }]);
  });

  test("preserves model discovery failures instead of reporting an empty catalog", async () => {
    globalThis.fetch = mock(async () =>
      new Response("provider authentication failed", { status: 422 })
    ) as typeof fetch;

    await expect(listModels(channel("https://api.example/v1"), "text"))
      .rejects.toThrow("provider authentication failed");
  });

  test("does not fall back to a cross-origin model request when the server gateway is unavailable", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input) => {
      requests.push(String(input));
      if (String(input).startsWith("/api/")) throw new TypeError("Failed to fetch");
      return json({ data: [{ id: "should-not-be-requested" }] });
    }) as typeof fetch;

    await expect(listModels(channel("https://api.example/v1"), "text"))
      .rejects.toThrow("模型列表服务不可用");
    expect(requests).toEqual(["/api/provider-models"]);
  });

  test("discovers loopback provider models in the browser without proxying through the server", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input) => {
      requests.push(String(input));
      return json({ data: [{ id: "local-model" }] });
    }) as typeof fetch;
    const local = channel("http://127.0.0.1:11434/v1");

    await expect(listModels(local, "text")).resolves.toEqual(["local-model"]);
    expect(requests).toEqual(["http://127.0.0.1:11434/v1/models"]);
  });

  test("routes each generation kind to its own URL and API key", async () => {
    const requests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization") });
      if (String(input) === "/api/provider-text") return json({ text: "ok" });
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
      "/api/provider-text",
      "https://image.example/v1/images/generations",
      "https://audio.example/v1/audio/speech",
    ]);
    expect(requests.map((r) => r.auth)).toEqual([null, "Bearer image-key", "Bearer audio-key"]);
  });

  test("does not retry text generation after an authentication failure", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return new Response("invalid key", { status: 401 });
    }) as typeof fetch;

    await expect(generateText({
      channel: channel("https://api.example/v1"),
      model: "text",
      prompt: "hello",
    })).rejects.toThrow("invalid key");
    expect(calls).toBe(1);
  });

  test("does not bypass the server gateway when the provider contract is unsupported", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input) => {
      urls.push(String(input));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await expect(generateText({
      channel: channel("https://api.example/v1"),
      model: "text",
      prompt: "hello",
    })).rejects.toThrow("not found");
    expect(urls).toEqual(["/api/provider-text"]);
  });

  test("forwards audio speed and instructions and rejects out-of-range speed", async () => {
    const bodies: string[] = [];
    globalThis.fetch = mock(async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(new Blob(["audio"], { type: "audio/mpeg" }));
    }) as typeof fetch;
    const c = channel("https://audio.example/v1");

    await generateSpeech({ channel: c, model: "audio", input: "hello", voice: "verse", format: "wav", speed: 1.5, instructions: "轻快地朗读" });
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      model: "audio", input: "hello", voice: "verse", response_format: "wav",
      speed: 1.5, instructions: "轻快地朗读",
    });

    // Omitted optional parameters must not appear at all, so provider defaults win.
    await generateSpeech({ channel: c, model: "audio", input: "hello" });
    const plain = JSON.parse(bodies[1]!) as Record<string, unknown>;
    expect("speed" in plain).toBe(false);
    expect("instructions" in plain).toBe(false);

    for (const speed of [0.2, 4.5, Number.NaN]) {
      await expect(generateSpeech({ channel: c, model: "audio", input: "hello", speed }))
        .rejects.toThrow();
    }
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

  test("maps ordered Ark image references into first and last frame roles", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    globalThis.fetch = mock(async (input, init) => {
      requests.push({ url: String(input), body: init?.body?.toString() });
      if (requests.length === 1) return json({ data: { id: "frame-task" } });
      return json({
        data: {
          status: "succeeded",
          content: { video_url: { url: "https://cdn.example/frames.mp4" } },
        },
      });
    }) as typeof fetch;

    await generateVideo({
      channel: channel("https://ark.cn-beijing.volces.com/api/v3"),
      model: "seedance-1-0-pro",
      prompt: "from start to finish",
      frameMode: "first-last",
      referenceImages: [
        "https://cdn.example/first.png",
        "https://cdn.example/last.png",
        "https://cdn.example/extra.png",
      ],
      pollIntervalMs: 0,
    });

    expect(JSON.parse(requests[0]?.body ?? "{}").content).toEqual([
      { type: "text", text: "from start to finish" },
      {
        type: "image_url",
        image_url: { url: "https://cdn.example/first.png" },
        role: "first_frame",
      },
      {
        type: "image_url",
        image_url: { url: "https://cdn.example/last.png" },
        role: "last_frame",
      },
      {
        type: "image_url",
        image_url: { url: "https://cdn.example/extra.png" },
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

function defaultProvidersForTest(c: AiChannel): NonNullable<AiChannel["providers"]> {
  const endpoint = (model: string) => ({ baseUrl: c.baseUrl, apiKey: c.apiKey, model, protocol: "openai" as const });
  return { text: endpoint("text"), image: endpoint("image"), video: endpoint("video"), audio: endpoint("audio") };
}
