import type { AiChannel } from "@/types/board";
import { getProvider } from "@/lib/ai-config";
import { normalizeExternalHttpsUrl } from "@/lib/remote-url";
import { readBoundedResponse } from "@/services/remote-content";
import {
  IMAGE_TRANSFORM_LIMITS,
  progressReporter,
  throwIfAborted,
  validateImageInput,
  validateUpscaleRequest,
  type ImageTransformContext,
  type ImageTransformProvider,
  type ImageTransformResult,
} from "../types";

const JSON_LIMIT_BYTES = Math.ceil(IMAGE_TRANSFORM_LIMITS.maxOutputBytes * 4 / 3) + 1024 * 1024;
const IMAGE_MIME_TYPES = ["image/avif", "image/jpeg", "image/png", "image/webp"] as const;
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

interface ProviderOptions {
  fetch?: typeof fetch;
}

function endpoint(baseUrl: string, path: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("Image provider URL is invalid");
  }
  if (base.username || base.password || base.hash) throw new Error("Image provider URL contains forbidden credentials or fragment");
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "::1";
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) {
    throw new Error("Image provider URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  const pathname = base.pathname.replace(/\/+$/, "");
  const versionedBase = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  base.pathname = `${versionedBase}/${path.replace(/^\/+/, "")}`;
  base.search = "";
  return base.toString();
}

function imageFileName(blob: Blob, stem: string): string {
  const extension = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  return `${stem}.${extension}`;
}

function requestHeaders(channel: AiChannel): Headers {
  const headers = new Headers({ Accept: "application/json, image/*" });
  const provider = getProvider(channel, "image");
  if (provider.apiKey) headers.set("Authorization", `Bearer ${provider.apiKey}`);
  return headers;
}

async function postForm(
  fetcher: typeof fetch,
  channel: AiChannel,
  path: string,
  form: FormData,
  context: ImageTransformContext,
): Promise<Response> {
  throwIfAborted(context.signal);
  const response = await fetcher(endpoint(getProvider(channel, "image").baseUrl, path), {
    method: "POST",
    headers: requestHeaders(channel),
    body: form,
    redirect: "error",
    signal: context.signal,
  });
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    throw new Error("Image provider redirect was rejected");
  }
  return response;
}

async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel();
  throw new Error(`Image provider HTTP ${response.status} ${response.statusText}`.trim());
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error("Image provider returned invalid base64");
  const estimatedBytes = Math.floor(value.length * 3 / 4);
  if (estimatedBytes > IMAGE_TRANSFORM_LIMITS.maxOutputBytes) throw new Error("Image provider output is too large");
  const decoded = atob(value);
  if (decoded.length > IMAGE_TRANSFORM_LIMITS.maxOutputBytes) throw new Error("Image provider output is too large");
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function parseOutput(
  response: Response,
  fetcher: typeof fetch,
  context: ImageTransformContext,
  progress: (value: number) => void,
): Promise<ImageTransformResult> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.toLowerCase();
  if (contentType.startsWith("image/")) {
    const remote = await readBoundedResponse(response, {
      maxBytes: IMAGE_TRANSFORM_LIMITS.maxOutputBytes,
      mimeTypes: IMAGE_MIME_TYPES,
    });
    progress(1);
    return { blob: new Blob([remote.bytes], { type: remote.mimeType }), provider: "openai-compatible", requestId };
  }

  const json = await readBoundedResponse(response, {
    maxBytes: JSON_LIMIT_BYTES,
    mimeTypes: ["application/json"],
  });
  const payload = JSON.parse(new TextDecoder().decode(json.bytes)) as {
    id?: unknown;
    data?: Array<{ b64_json?: unknown; url?: unknown }>;
  };
  const item = payload.data?.[0];
  if (!item) throw new Error("Image provider returned no output");
  const resolvedRequestId = typeof payload.id === "string" ? payload.id : requestId;
  progress(0.75);
  if (typeof item.b64_json === "string") {
    const bytes = decodeBase64(item.b64_json);
    progress(1);
    return {
      blob: new Blob([bytes], { type: "image/png" }),
      provider: "openai-compatible",
      requestId: resolvedRequestId,
    };
  }
  if (typeof item.url !== "string") throw new Error("Image provider returned an invalid output");
  const url = normalizeExternalHttpsUrl(item.url);
  const outputResponse = await fetcher(url, { redirect: "error", signal: context.signal });
  if (outputResponse.redirected || (outputResponse.status >= 300 && outputResponse.status < 400)) {
    await outputResponse.body?.cancel();
    throw new Error("Remote image redirect was rejected");
  }
  await requireSuccess(outputResponse);
  const remote = await readBoundedResponse(outputResponse, {
    maxBytes: IMAGE_TRANSFORM_LIMITS.maxOutputBytes,
    mimeTypes: IMAGE_MIME_TYPES,
  });
  progress(1);
  return {
    blob: new Blob([remote.bytes], { type: remote.mimeType }),
    provider: "openai-compatible",
    requestId: resolvedRequestId,
  };
}

function editForm(channel: AiChannel, image: Blob, prompt: string, mask?: Blob): FormData {
  const form = new FormData();
  form.set("model", getProvider(channel, "image").model);
  form.set("prompt", prompt);
  form.set("image", image, imageFileName(image, "image"));
  if (mask) form.set("mask", mask, "mask.png");
  return form;
}

export function createOpenAIImageTransformProvider(
  channel: AiChannel,
  options: ProviderOptions = {},
): ImageTransformProvider {
  const fetcher = options.fetch ?? fetch;
  return {
    id: "openai-compatible",
    label: `${channel.name} · 云端`,
    kind: "cloud",
    capabilities: { upscale: true, inpaint: true, mask: false },
    async inpaint(request, context) {
      validateImageInput(request.image, request.width, request.height);
      validateImageInput(request.mask, request.width, request.height);
      const prompt = request.prompt.trim();
      if (!prompt || prompt.length > IMAGE_TRANSFORM_LIMITS.maxPromptChars) throw new Error("Inpaint prompt is invalid");
      const progress = progressReporter(context.onProgress);
      progress(0);
      const response = await postForm(fetcher, channel, "/images/edits", editForm(channel, request.image, prompt, request.mask), context);
      await requireSuccess(response);
      progress(0.55);
      const result = await parseOutput(response, fetcher, context, progress);
      return { ...result, model: getProvider(channel, "image").model };
    },
    async upscale(request, context) {
      validateUpscaleRequest(request);
      const progress = progressReporter(context.onProgress);
      progress(0);
      const form = new FormData();
      form.set("model", getProvider(channel, "image").model);
      form.set("image", request.image, imageFileName(request.image, "image"));
      form.set("scale", String(request.scale));
      let response = await postForm(fetcher, channel, "/images/upscales", form, context);
      if (UNSUPPORTED_STATUSES.has(response.status)) {
        await response.body?.cancel();
        progress(0.2);
        const fallback = editForm(
          channel,
          request.image,
          `Upscale this image by ${request.scale}x while preserving its content and visual style.`,
        );
        fallback.set("size", `${Math.round(request.width * request.scale)}x${Math.round(request.height * request.scale)}`);
        response = await postForm(fetcher, channel, "/images/edits", fallback, context);
      }
      await requireSuccess(response);
      progress(0.55);
      const result = await parseOutput(response, fetcher, context, progress);
      return {
        ...result,
        model: getProvider(channel, "image").model,
        width: Math.round(request.width * request.scale),
        height: Math.round(request.height * request.scale),
      };
    },
  };
}
