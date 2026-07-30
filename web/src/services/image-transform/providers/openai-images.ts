import type { AiChannel } from "@/types/board";
import { getProvider } from "@/lib/ai-config";
import { normalizeExternalHttpsUrl } from "@/lib/remote-url";
import { readBoundedResponse } from "@/services/remote-content";
import { providerFetch } from "@/services/provider-http";
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

interface ProviderOptions {
  fetch?: typeof fetch;
}

/**
 * `/images/edits` and `/images/upscales` are OpenAI-compatible endpoints. Other
 * protocols (Gemini, APIMart, KIE, Ark, Template) do not implement them, so a
 * channel using one of those must not advertise cloud edit or upscale support:
 * offering the action would hand the user a button that can only fail.
 */
export function supportsOpenAIImageTransforms(channel: AiChannel): boolean {
  const protocol = getProvider(channel, "image").protocol;
  return protocol === undefined || protocol === "openai";
}

function imageFileName(blob: Blob, stem: string): string {
  const extension = blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
  return `${stem}.${extension}`;
}

async function postForm(
  fetcher: typeof fetch,
  channel: AiChannel,
  path: string,
  form: FormData,
  context: ImageTransformContext,
): Promise<Response> {
  throwIfAborted(context.signal);
  return providerFetch(getProvider(channel, "image"), path, {
    method: "POST",
    headers: { Accept: "application/json, image/*" },
    body: form,
    signal: context.signal,
  }, {
    fetcher,
    errorPrefix: "Image provider HTTP",
  });
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
  if (!outputResponse.ok) {
    await outputResponse.body?.cancel();
    throw new Error(`Remote image HTTP ${outputResponse.status}`);
  }
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
  form.set("image[]", image, imageFileName(image, "image"));
  if (mask) form.set("mask", mask, "mask.png");
  return form;
}

export function createOpenAIImageTransformProvider(
  channel: AiChannel,
  options: ProviderOptions = {},
): ImageTransformProvider {
  const fetcher = options.fetch ?? fetch;
  const supported = supportsOpenAIImageTransforms(channel);
  const requireSupportedProtocol = () => {
    if (!supported) {
      throw new Error(
        `当前图片渠道协议（${getProvider(channel, "image").protocol}）不提供 /images/edits 与 /images/upscales，无法进行云端局部重绘或超分。`,
      );
    }
  };
  return {
    id: "openai-compatible",
    label: `${channel.name} · 云端`,
    kind: "cloud",
    // Capabilities must reflect what the protocol can actually serve so the UI
    // disables the action instead of failing at request time.
    capabilities: { upscale: supported, inpaint: supported, mask: false },
    async inpaint(request, context) {
      requireSupportedProtocol();
      validateImageInput(request.image, request.width, request.height);
      validateImageInput(request.mask, request.width, request.height);
      const prompt = request.prompt.trim();
      if (!prompt || prompt.length > IMAGE_TRANSFORM_LIMITS.maxPromptChars) throw new Error("Inpaint prompt is invalid");
      const progress = progressReporter(context.onProgress);
      progress(0);
      const response = await postForm(fetcher, channel, "/images/edits", editForm(channel, request.image, prompt, request.mask), context);
      progress(0.55);
      const result = await parseOutput(response, fetcher, context, progress);
      return { ...result, model: getProvider(channel, "image").model };
    },
    async upscale(request, context) {
      requireSupportedProtocol();
      validateUpscaleRequest(request);
      const progress = progressReporter(context.onProgress);
      progress(0);
      const form = new FormData();
      form.set("model", getProvider(channel, "image").model);
      form.set("image", request.image, imageFileName(request.image, "image"));
      form.set("scale", String(request.scale));
      const response = await postForm(fetcher, channel, "/images/upscales", form, context);
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
