import { describe, expect, test } from "bun:test";
import { decodeBoundedDataUrl, readBoundedResponse } from "./remote-content";

function response(chunks: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers },
  );
}

describe("bounded remote content", () => {
  test("rejects a declared or streamed body above the byte limit", async () => {
    await expect(readBoundedResponse(response(["small"], {
      "content-length": "101",
      "content-type": "text/plain",
    }), { maxBytes: 100, mimeTypes: ["text/plain"] })).rejects.toThrow("too large");

    await expect(readBoundedResponse(response(["123456", "78901"], {
      "content-type": "text/plain",
    }), { maxBytes: 10, mimeTypes: ["text/plain"] })).rejects.toThrow("too large");
  });

  test("rejects unsupported or missing MIME types", async () => {
    await expect(readBoundedResponse(response(["{}"], {
      "content-type": "text/html; charset=utf-8",
    }), { maxBytes: 100, mimeTypes: ["application/json", "text/plain"] })).rejects.toThrow("MIME");
    await expect(readBoundedResponse(response(["{}"]), {
      maxBytes: 100,
      mimeTypes: ["application/json"],
    })).rejects.toThrow("MIME");
  });

  test("returns bounded bytes and the normalized MIME type", async () => {
    const result = await readBoundedResponse(response(["hello", " world"], {
      "content-type": "text/plain; charset=utf-8",
    }), { maxBytes: 20, mimeTypes: ["text/plain"] });
    expect(new TextDecoder().decode(result.bytes)).toBe("hello world");
    expect(result.mimeType).toBe("text/plain");
  });
});

describe("bounded data URLs", () => {
  test("decodes base64 media without relying on browser fetch", () => {
    const decoded = decodeBoundedDataUrl("data:image/png;base64,aGVsbG8=", {
      maxBytes: 5,
      mimeTypes: ["image/png"],
    });
    expect(decoded.mimeType).toBe("image/png");
    expect(new TextDecoder().decode(decoded.bytes)).toBe("hello");
  });

  test("decodes large embedded media without a recursive regular-expression overflow", () => {
    // A legacy canvas contained an 8.8 MB JPEG fallback. Repeated-group regex
    // validation over its 11.7 million base64 characters overflowed V8's stack
    // before recovery could upload the missing blob.
    const encoded = "AQEB".repeat(3_000_000);
    const decoded = decodeBoundedDataUrl(`data:image/jpeg;base64,${encoded}`, {
      maxBytes: 10 * 1024 * 1024,
      mimeTypes: ["image/jpeg"],
    });

    expect(decoded.bytes.byteLength).toBe(9_000_000);
    expect(decoded.bytes[0]).toBe(1);
    expect(decoded.bytes[decoded.bytes.length - 1]).toBe(1);
  });

  test("rejects invalid MIME, malformed base64, and oversized payloads", () => {
    expect(() => decodeBoundedDataUrl("data:image/svg+xml;base64,PHN2Zz4=", {
      maxBytes: 100,
      mimeTypes: ["image/png"],
    })).toThrow("MIME");
    expect(() => decodeBoundedDataUrl("data:image/png;base64,%%%", {
      maxBytes: 100,
      mimeTypes: ["image/png"],
    })).toThrow("base64");
    expect(() => decodeBoundedDataUrl("data:image/png;base64,aGVsbG8=", {
      maxBytes: 4,
      mimeTypes: ["image/png"],
    })).toThrow("too large");
  });
});
