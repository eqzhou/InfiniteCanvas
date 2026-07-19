import type { AiChannel } from "@/types/board";
import { validateArkVideoRequest } from "@/lib/video-generation";
import { getProvider } from "@/lib/ai-config";
import type { AiProviderKind } from "@/types/board";
import { compileProviderTemplate, readTemplatePath, resolveTemplateEndpoint } from "@/lib/provider-template";
import {
  generateGeminiImages,
  generateGeminiText,
  generateTemplateImages,
  providerJsonFetch,
} from "@/services/ai-adapters";
import { applySystemPrompt } from "@/lib/app-config";
import { runTrackedGeneration } from "@/services/generation-activity";
export {
  resolveMediaRefs,
  resolveNodeImageDataUrl,
  resolveNodeImageDataUrls,
} from "@/services/media-references";

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  const base = normalizeBase(baseUrl);
  if (
    base.endsWith("/v1") ||
    base.endsWith("/api/v3") ||
    base.endsWith("/api/plan/v3")
  ) {
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }
  if (path.startsWith("/v1")) return `${base}${path}`;
  return `${base}/v1${path.startsWith("/") ? path : `/${path}`}`;
}

async function authFetch(
  channel: AiChannel,
  path: string,
  init: RequestInit = {},
  kind: AiProviderKind = "text",
): Promise<Response> {
  if (init.signal?.aborted) {
    throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  const headers = new Headers(init.headers);
  const provider = getProvider(channel, kind);
  if (provider.apiKey) {
    if (provider.protocol === "gemini") headers.set("x-goog-api-key", provider.apiKey);
    else if (provider.protocol === "template" && provider.template?.auth === "x-api-key") {
      headers.set("x-api-key", provider.apiKey);
    } else headers.set("Authorization", `Bearer ${provider.apiKey}`);
  }
  if (!headers.has("Content-Type") && init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(joinUrl(provider.baseUrl, path), { ...init, headers, redirect: "error" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI ${res.status}: ${text || res.statusText}`);
  }
  return res;
}

export async function listModels(channel: AiChannel, kind: AiProviderKind = "text"): Promise<string[]> {
  const provider = getProvider(channel, kind);
  if (provider.protocol === "template") return [];
  try {
    if (provider.protocol === "gemini") {
      const data = await providerJsonFetch(
        `${normalizeBase(provider.baseUrl)}/models`,
        provider.apiKey,
        "x-goog-api-key",
        {},
      ) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((item) => item.name?.replace(/^models\//, ""))
        .filter((item): item is string => Boolean(item)).sort();
    }
    const res = await authFetch(channel, "/models", {}, kind);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id).sort();
  } catch {
    return [];
  }
}

type TextGenerationOptions = {
  channel: AiChannel;
  model: string;
  prompt: string;
  images?: string[];
  systemPrompt?: string;
};

export async function generateText(options: TextGenerationOptions): Promise<string> {
  return runTrackedGeneration({
    kind: "text",
    prompt: options.prompt,
    model: options.model,
    providerId: options.channel.id,
  }, () => generateTextRequest(options));
}

async function generateTextRequest(options: TextGenerationOptions): Promise<string> {
  const { channel, model, prompt, images = [], systemPrompt = "" } = options;
  const provider = getProvider(channel, "text");
  if (provider.protocol === "gemini") {
    return generateGeminiText(
      provider.baseUrl,
      provider.apiKey,
      model,
      prompt,
      images,
      systemPrompt,
    );
  }
  if (provider.protocol !== "openai") {
    throw new Error(`${provider.protocol} does not support text generation`);
  }
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
  for (const img of images) {
    content.push({ type: "input_image", image_url: img });
  }

  try {
    const res = await authFetch(channel, "/responses", {
      method: "POST",
      body: JSON.stringify({
        model,
        ...(systemPrompt.trim() ? { instructions: systemPrompt.trim() } : {}),
        input: [{ role: "user", content }],
      }),
    }, "text");
    const data = (await res.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (data.output_text) return data.output_text;
    const chunks =
      data.output
        ?.flatMap((o) => o.content ?? [])
        .map((c) => c.text)
        .filter(Boolean) ?? [];
    if (chunks.length) return chunks.join("\n");
    if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  } catch {
    // fall through
  }

  const messages: Array<{ role: string; content: unknown }> = [
    ...(systemPrompt.trim()
      ? [{ role: "system", content: systemPrompt.trim() }]
      : []),
    {
      role: "user",
      content:
        images.length === 0
          ? prompt
          : [
              { type: "text", text: prompt },
              ...images.map((url) => ({ type: "image_url", image_url: { url } })),
            ],
    },
  ];
  const res = await authFetch(channel, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model, messages }),
  }, "text");
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

type ImageGenerationOptions = {
  channel: AiChannel;
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  n?: number;
  referenceDataUrls?: string[];
  transparentBackground?: boolean;
  systemPrompt?: string;
  signal?: AbortSignal;
  activityId?: string;
  activitySurface?: "canvas" | "image-workbench" | "other";
  deferActivitySuccess?: boolean;
};

export async function generateImages(options: ImageGenerationOptions): Promise<string[]> {
  return runTrackedGeneration({
    id: options.activityId,
    kind: "image",
    prompt: options.prompt,
    model: options.model,
    providerId: options.channel.id,
    surface: options.activitySurface,
    deferSuccess: options.deferActivitySuccess,
  }, () => generateImagesRequest(options));
}

async function generateImagesRequest(options: ImageGenerationOptions): Promise<string[]> {
  const {
    channel,
    model,
    prompt,
    size = "1024x1024",
    quality = "auto",
    n = 1,
    referenceDataUrls = [],
    transparentBackground = false,
    systemPrompt = "",
    signal,
  } = options;
  const effectivePrompt = applySystemPrompt(systemPrompt, prompt);
  const provider = getProvider(channel, "image");
  if (provider.protocol === "gemini") {
    if (transparentBackground) throw new Error("Gemini image generation does not support transparent background");
    return generateGeminiImages(provider.baseUrl, provider.apiKey, model, effectivePrompt, referenceDataUrls, signal);
  }
  if (provider.protocol === "template") {
    if (!provider.template) throw new Error("Image template configuration is missing");
    if (transparentBackground && !provider.template.supportsTransparentBackground) {
      throw new Error("This image template does not support transparent background");
    }
    return generateTemplateImages(provider, {
      prompt: effectivePrompt, model, size, quality, count: n, transparentBackground,
      referenceImages: referenceDataUrls,
    }, signal);
  }
  if (provider.protocol !== "openai") {
    throw new Error(`${provider.protocol} does not support image generation`);
  }

  if (referenceDataUrls.length > 0) {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", effectivePrompt);
    form.set("n", String(n));
    form.set("size", size);
    if (quality) form.set("quality", quality);
    for (const [i, dataUrl] of referenceDataUrls.entries()) {
      const blob = await (await fetch(dataUrl)).blob();
      form.append("image", blob, `ref-${i}.png`);
    }
    const res = await authFetch(channel, "/images/edits", { method: "POST", body: form, signal }, "image");
    const data = (await res.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
    };
    return (data.data ?? [])
      .map((item) =>
        item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url,
      )
      .filter((x): x is string => Boolean(x));
  }

  const res = await authFetch(channel, "/images/generations", {
    method: "POST",
    body: JSON.stringify({
      model,
      prompt: effectivePrompt,
      n,
      size,
      quality,
      ...(transparentBackground ? { background: "transparent" } : {}),
    }),
    signal,
  }, "image");
  const data = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  return (data.data ?? [])
    .map((item) =>
      item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url,
    )
    .filter((x): x is string => Boolean(x));
}

export type VideoGenOptions = {
  channel: AiChannel;
  model: string;
  prompt: string;
  size?: string;
  seconds?: number;
  ratio?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  /** data URLs or https URLs */
  referenceImages?: string[];
  referenceVideos?: string[];
  referenceAudios?: string[];
  /** Cancels creation, polling, and content download. */
  signal?: AbortSignal;
  /** Overall task deadline. Defaults to three minutes. */
  timeoutMs?: number;
  /** Poll cadence. Exposed for provider tuning and deterministic tests. */
  pollIntervalMs?: number;
  activityId?: string;
  activitySurface?: "canvas" | "video-workbench" | "other";
  deferActivitySuccess?: boolean;
};

type VideoResult = { id: string; status: string; url?: string };

const VIDEO_TIMEOUT_MS = 180_000;
const VIDEO_POLL_INTERVAL_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "string" && item.trim() ? item : undefined;
}

function parseTaskId(value: unknown): string | undefined {
  return stringAt(value, "id")
    ?? stringAt(value, "task_id")
    ?? stringAt(value, "taskId")
    ?? stringAt(recordAt(value, "data"), "id")
    ?? stringAt(recordAt(value, "data"), "task_id")
    ?? stringAt(recordAt(value, "data"), "taskId")
    ?? stringAt(recordAt(value, "task"), "id")
    ?? stringAt(recordAt(value, "task"), "task_id")
    ?? stringAt(recordAt(value, "task"), "taskId");
}

function parseTaskStatus(value: unknown): string {
  return (
    stringAt(value, "status") ??
    stringAt(value, "task_status") ??
    stringAt(value, "taskStatus") ??
    stringAt(value, "state") ??
    stringAt(recordAt(value, "data"), "status") ??
    stringAt(recordAt(value, "data"), "task_status") ??
    stringAt(recordAt(value, "data"), "taskStatus") ??
    stringAt(recordAt(value, "data"), "state") ??
    stringAt(recordAt(value, "task"), "status") ??
    stringAt(recordAt(value, "task"), "task_status") ??
    stringAt(recordAt(value, "task"), "taskStatus") ??
    stringAt(recordAt(value, "task"), "state") ??
    ""
  ).toLowerCase();
}

function parseUrlValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  return stringAt(value, "url");
}

function parseVideoUrl(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const data = recordAt(value, "data");
  const candidates: unknown[] = [
    value.url,
    value.video_url,
    value.videoUrl,
    value.output_url,
    value.download_url,
    value.downloadUrl,
    recordAt(value, "output")?.url,
    recordAt(value, "output")?.video_url,
    recordAt(value, "output")?.videoUrl,
    recordAt(value, "content")?.video_url,
    recordAt(value, "content")?.videoUrl,
    recordAt(value, "result")?.url,
    recordAt(value, "result")?.video_url,
    recordAt(value, "result")?.videoUrl,
    recordAt(value, "result")?.download_url,
    recordAt(value, "result")?.downloadUrl,
    data?.url,
    data?.video_url,
    data?.videoUrl,
    data?.output_url,
    recordAt(data, "output")?.url,
    recordAt(data, "output")?.video_url,
    recordAt(data, "output")?.videoUrl,
    recordAt(data, "content")?.video_url,
    recordAt(data, "content")?.videoUrl,
    recordAt(data, "result")?.url,
    recordAt(data, "result")?.video_url,
    recordAt(data, "result")?.videoUrl,
    recordAt(data, "result")?.downloadUrl,
    recordAt(value, "task")?.url,
    recordAt(value, "task")?.video_url,
    recordAt(value, "task")?.videoUrl,
    recordAt(value, "task")?.download_url,
  ];
  const listCandidates = [
    recordAt(value, "output")?.videos,
    recordAt(data, "output")?.videos,
    recordAt(value, "content")?.videos,
    recordAt(data, "content")?.videos,
    recordAt(value, "result")?.videos,
    recordAt(data, "result")?.videos,
    recordAt(recordAt(value, "task"), "output")?.videos,
  ];
  for (const candidate of candidates) {
    const url = parseUrlValue(candidate);
    if (url) return url;
  }
  for (const list of listCandidates) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = parseUrlValue(item) ?? (isRecord(item)
        ? parseUrlValue(item.video_url) ?? parseUrlValue(item.videoUrl)
        : undefined);
      if (url) return url;
    }
  }
  return undefined;
}

function isSuccessfulStatus(status: string): boolean {
  return ["completed", "succeeded", "success", "done", "finished"].includes(status);
}

function isFailedStatus(status: string): boolean {
  return ["failed", "error", "cancelled", "canceled", "expired"].includes(status);
}

function validateTiming(timeoutMs: number, pollIntervalMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Video timeout must be a positive finite number");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error("Video poll interval must be a non-negative finite number");
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createVideoSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(abortReason(external!));
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error("Video generation timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

export async function generateVideo(
  options: VideoGenOptions,
): Promise<VideoResult> {
  return runTrackedGeneration({
    id: options.activityId,
    kind: "video",
    prompt: options.prompt,
    model: options.model,
    providerId: options.channel.id,
    surface: options.activitySurface,
    deferSuccess: options.deferActivitySuccess,
  }, () => generateVideoRequest(options));
}

async function generateVideoRequest(
  options: VideoGenOptions,
): Promise<VideoResult> {
  const {
    channel,
    model,
    prompt,
    size,
    seconds,
    ratio = "16:9",
    resolution = "720p",
    generateAudio = false,
    watermark = false,
    referenceImages = [],
    referenceVideos = [],
    referenceAudios = [],
    signal: externalSignal,
    timeoutMs = VIDEO_TIMEOUT_MS,
    pollIntervalMs = VIDEO_POLL_INTERVAL_MS,
  } = options;
  validateTiming(timeoutMs, pollIntervalMs);
  const provider = getProvider(channel, "video");
  const base = normalizeBase(provider.baseUrl);
  const arkProtocol = provider.protocol === "ark" || base.includes("/api/plan/v3") || base.endsWith("/api/v3");
  if (arkProtocol) validateArkVideoRequest(model, resolution, seconds);
  const deadline = createVideoSignal(externalSignal, timeoutMs);

  try {
    if (provider.protocol === "template") {
      if (!provider.template) throw new Error("Video template configuration is missing");
      const data = await providerJsonFetch(
        resolveTemplateEndpoint(provider.baseUrl, provider.template),
        provider.apiKey,
        provider.template.auth,
        {
          method: provider.template.method,
          body: JSON.stringify(compileProviderTemplate(provider.template, {
            prompt,
            model,
            size,
            duration: seconds,
            ratio,
            resolution,
            referenceImages,
            referenceVideos,
            referenceAudios,
          })),
          signal: deadline.signal,
        },
      );
      const url = readTemplatePath(data, provider.template.responsePath);
      if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
        throw new Error("Video template response must resolve to an HTTPS URL");
      }
      return { id: parseTaskId(data) ?? `template-${Date.now()}`, status: "succeeded", url };
    }
    if (provider.protocol === "gemini") {
      throw new Error("Gemini does not support video generation in OpenBoard");
    }
    if (arkProtocol) {
      return await generateArkVideo({
        channel,
        model,
        prompt,
        seconds,
        ratio,
        resolution,
        generateAudio,
        watermark,
        referenceImages,
        referenceVideos,
        referenceAudios,
        signal: deadline.signal,
        pollIntervalMs,
      });
    }
    return await generateOpenAiVideo({
      channel,
      model,
      prompt,
      size,
      seconds,
      referenceImages,
      signal: deadline.signal,
      pollIntervalMs,
    });
  } finally {
    deadline.cleanup();
  }
}

type VideoRequestContext = {
  channel: AiChannel;
  model: string;
  prompt: string;
  seconds?: number;
  signal: AbortSignal;
  pollIntervalMs: number;
};

async function generateArkVideo(
  options: VideoRequestContext & {
    ratio: string;
    resolution: string;
    generateAudio: boolean;
    watermark: boolean;
    referenceImages: string[];
    referenceVideos: string[];
    referenceAudios: string[];
  },
): Promise<VideoResult> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: options.prompt },
    ...options.referenceImages.slice(0, 9).map((url) => ({
      type: "image_url",
      image_url: { url },
      role: "reference_image",
    })),
    ...options.referenceVideos.slice(0, 3).map((url) => ({
      type: "video_url",
      video_url: { url },
      role: "reference_video",
    })),
    ...options.referenceAudios.slice(0, 3).map((url) => ({
      type: "audio_url",
      audio_url: { url },
      role: "reference_audio",
    })),
  ];
  const create = await authFetch(options.channel, "/contents/generations/tasks", {
    method: "POST",
    body: JSON.stringify({
      model: options.model,
      content,
      ratio: options.ratio,
      resolution: options.resolution,
      duration: options.seconds,
      generate_audio: options.generateAudio,
      watermark: options.watermark,
    }),
    signal: options.signal,
  }, "video");
  const created = await readJson(create, "Video create");
  const id = parseTaskId(created);
  if (!id) throw new Error("Video task id missing");
  const immediate = completedTaskResult(id, created, true);
  if (immediate) return immediate;

  while (true) {
    await abortableSleep(options.pollIntervalMs, options.signal);
    const poll = await authFetch(
      options.channel,
      `/contents/generations/tasks/${encodeURIComponent(id)}`,
      { signal: options.signal }, "video",
    );
    const task = await readJson(poll, "Video task");
    const result = completedTaskResult(id, task, true);
    if (result) return result;
  }
}

function completedTaskResult(
  id: string,
  task: unknown,
  urlRequired: boolean,
): VideoResult | undefined {
  const status = parseTaskStatus(task);
  if (isFailedStatus(status)) {
    throw new Error(`Video generation failed: ${status}`);
  }
  const url = parseVideoUrl(task);
  if (isSuccessfulStatus(status)) {
    if (urlRequired && !url) throw new Error("Video task succeeded but video URL missing");
    return { id, status: "succeeded", url };
  }
  if (url) return { id, status: "succeeded", url };
  return undefined;
}

async function generateOpenAiVideo(
  options: VideoRequestContext & {
    size?: string;
    referenceImages: string[];
  },
): Promise<VideoResult> {
  const createBody: Record<string, unknown> = {
    model: options.model,
    prompt: options.prompt,
  };
  if (options.size) createBody.size = options.size;
  if (options.seconds != null) createBody.seconds = options.seconds;
  if (options.referenceImages[0]) {
    createBody.input_reference = options.referenceImages[0];
  }

  const create = await authFetch(options.channel, "/videos", {
    method: "POST",
    body: JSON.stringify(createBody),
    signal: options.signal,
  }, "video");
  const created = await readJson(create, "Video create");
  const id = parseTaskId(created);
  if (!id) throw new Error("Video task id missing");
  const immediate = completedTaskResult(id, created, false);
  if (immediate?.url) return immediate;
  if (immediate) {
    return downloadOpenAiVideo(options.channel, id, options.signal);
  }

  while (true) {
    await abortableSleep(options.pollIntervalMs, options.signal);
    const poll = await authFetch(options.channel, `/videos/${encodeURIComponent(id)}`, {
      signal: options.signal,
    }, "video");
    const task = await readJson(poll, "Video task");
    const result = completedTaskResult(id, task, false);
    if (result?.url) return result;
    if (result) {
      return downloadOpenAiVideo(options.channel, id, options.signal);
    }
  }
}

async function downloadOpenAiVideo(
  channel: AiChannel,
  id: string,
  signal: AbortSignal,
): Promise<VideoResult> {
  const content = await authFetch(
    channel,
    `/videos/${encodeURIComponent(id)}/content`,
    { signal }, "video",
  );
  const blob = await content.blob();
  if (blob.size === 0) throw new Error("Video content is empty");
  const url = URL.createObjectURL(blob);
  return { id, status: "succeeded", url };
}

/** OpenAI-compatible speech synthesis → audio data URL/blob URL. */
type SpeechGenerationOptions = {
  channel: AiChannel;
  model?: string;
  input: string;
  voice?: string;
  format?: string;
};

export async function generateSpeech(options: SpeechGenerationOptions): Promise<{ url: string; mimeType: string; blob: Blob }> {
  return runTrackedGeneration({
    kind: "audio",
    prompt: options.input,
    model: options.model,
    providerId: options.channel.id,
  }, () => generateSpeechRequest(options));
}

async function generateSpeechRequest(options: SpeechGenerationOptions): Promise<{ url: string; mimeType: string; blob: Blob }> {
  const {
    channel,
    model = "gpt-4o-mini-tts",
    input,
    voice = "alloy",
    format = "mp3",
  } = options;
  const provider = getProvider(channel, "audio");
  if (provider.protocol !== "openai") {
    throw new Error(`${provider.protocol} does not support audio generation`);
  }

  const res = await authFetch(channel, "/audio/speech", {
    method: "POST",
    body: JSON.stringify({
      model,
      input,
      voice,
      response_format: format,
    }),
  }, "audio");
  const blob = await res.blob();
  const mimeType = blob.type || `audio/${format}`;
  const url = URL.createObjectURL(blob);
  return { url, mimeType, blob };
}
