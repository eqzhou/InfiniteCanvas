import { describe, expect, test } from "bun:test";
import { createOpenAIImageTransformProvider } from "./providers/openai-images";

const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

function channel() {
  return {
    id: "channel",
    name: "Cloud",
    baseUrl: "https://images.example/v1",
    apiKey: "secret",
    defaultTextModel: "text",
    defaultImageModel: "image-model",
    defaultVideoModel: "video",
  };
}

describe("OpenAI-compatible image transform provider", () => {
  test("sends inpaint as multipart with an exact mask and reports monotonic progress", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const progress: number[] = [];
    const provider = createOpenAIImageTransformProvider(channel(), { fetch: fetcher });
    const result = await provider.inpaint!({
      image,
      mask: image,
      prompt: "replace the selected area",
      width: 8,
      height: 8,
    }, { onProgress: (value) => progress.push(value) });

    expect(calls[0]?.url).toBe("https://images.example/v1/images/edits");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
    const form = calls[0]?.init?.body as FormData;
    expect(form.get("model")).toBe("image-model");
    expect(form.get("prompt")).toBe("replace the selected area");
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.get("mask")).toBeInstanceOf(Blob);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    expect(result.provider).toBe("openai-compatible");
    expect(result.blob.type).toBe("image/png");
  });

  test("falls back from an unsupported upscale endpoint, but not from auth or rate errors", async () => {
    const paths: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      paths.push(new URL(String(input)).pathname);
      if (paths.length === 1) return new Response("unsupported", { status: 404 });
      return new Response(JSON.stringify({ data: [{ b64_json: "AQID" }] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const provider = createOpenAIImageTransformProvider(channel(), { fetch: fetcher });
    await provider.upscale!({ image, scale: 2, width: 16, height: 12 }, {});
    expect(paths).toEqual(["/v1/images/upscales", "/v1/images/edits"]);

    for (const status of [401, 429, 500]) {
      let count = 0;
      const failing = createOpenAIImageTransformProvider(channel(), {
        fetch: async () => { count += 1; return new Response("no", { status }); },
      });
      await expect(failing.upscale!({ image, scale: 2, width: 16, height: 12 }, {})).rejects.toThrow(String(status));
      expect(count).toBe(1);
    }
  });

  test("honors cancellation and rejects redirects, invalid MIME and oversized remote output", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = createOpenAIImageTransformProvider(channel(), {
      fetch: async (_input, init) => {
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return new Response();
      },
    });
    await expect(aborted.inpaint!({ image, mask: image, prompt: "x", width: 8, height: 8 }, {
      signal: controller.signal,
    })).rejects.toThrow();

    const remoteResponse = (response: Response) => createOpenAIImageTransformProvider(channel(), {
      fetch: async (input) => String(input).includes("cdn.example")
        ? response
        : new Response(JSON.stringify({ data: [{ url: "https://cdn.example/output" }] }), {
            headers: { "content-type": "application/json" },
          }),
    });
    await expect(remoteResponse(new Response(null, {
      status: 302,
      headers: { location: "https://other.example/image.png", "content-type": "image/png" },
    })).inpaint!({ image, mask: image, prompt: "x", width: 8, height: 8 }, {})).rejects.toThrow("redirect");
    await expect(remoteResponse(new Response("html", {
      headers: { "content-type": "text/html" },
    })).inpaint!({ image, mask: image, prompt: "x", width: 8, height: 8 }, {})).rejects.toThrow("MIME");
    await expect(remoteResponse(new Response(new Uint8Array(10), {
      headers: { "content-type": "image/png", "content-length": String(33 * 1024 * 1024) },
    })).inpaint!({ image, mask: image, prompt: "x", width: 8, height: 8 }, {})).rejects.toThrow("too large");
  });

  test("validates scale and output pixel limits before making a request", async () => {
    let calls = 0;
    const provider = createOpenAIImageTransformProvider(channel(), {
      fetch: async () => { calls += 1; return new Response(); },
    });
    await expect(provider.upscale!({ image, scale: 0.5, width: 10, height: 10 }, {})).rejects.toThrow("scale");
    await expect(provider.upscale!({ image, scale: 4, width: 10_000, height: 10_000 }, {})).rejects.toThrow("pixel limit");
    expect(calls).toBe(0);
  });
});
