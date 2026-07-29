import type { AiEndpointConfig } from "@/types/board";
import {
  compileProviderTemplate,
  readTemplatePath,
  resolveTemplateEndpoint,
  validateProviderTemplate,
} from "@/lib/provider-template";
import { readBoundedProviderJson } from "@/services/bounded-provider-json";
import { providerFetchUrl, type ProviderAuth } from "@/services/provider-http";

const MAX_PROVIDER_JSON_BYTES = 64 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export async function providerJsonFetch(
  url: string,
  apiKey: string,
  auth: ProviderAuth,
  init: RequestInit,
): Promise<unknown> {
  const response = await providerFetchUrl(url, apiKey, auth, init, {
    maxErrorBytes: MAX_PROVIDER_ERROR_BYTES,
  });
  return readBoundedProviderJson(response, MAX_PROVIDER_JSON_BYTES);
}

export async function generateGeminiText(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  images: string[],
  systemPrompt = "",
): Promise<string> {
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of images) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(image);
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    else parts.push({ fileData: { mimeType: "image/*", fileUri: image } });
  }
  const data = await providerJsonFetch(
    `${normalizeBase(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`,
    apiKey,
    "x-goog-api-key",
    {
      method: "POST",
      body: JSON.stringify({
        ...(systemPrompt.trim()
          ? { systemInstruction: { parts: [{ text: systemPrompt.trim() }] } }
          : {}),
        contents: [{ role: "user", parts }],
      }),
    },
  ) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text).filter((text): text is string => Boolean(text)).join("\n") ?? "";
}

export async function generateGeminiImages(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  references: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const image of references) {
    const match = /^data:([^;,]+);base64,(.+)$/i.exec(image);
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }
  const data = await providerJsonFetch(
    `${normalizeBase(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`,
    apiKey,
    "x-goog-api-key",
    {
      method: "POST",
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal,
    },
  ) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> };
  return (data.candidates ?? []).flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.inlineData?.data
      ? `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`
      : undefined)
    .filter((value): value is string => Boolean(value));
}

export async function generateTemplateImages(
  provider: AiEndpointConfig,
  values: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string[]> {
  const template = provider.template!;
  validateProviderTemplate(template);
  const data = await providerJsonFetch(
    resolveTemplateEndpoint(provider.baseUrl, template),
    provider.apiKey,
    template.auth,
    { method: template.method, body: JSON.stringify(compileProviderTemplate(template, values)), signal },
  );
  const output = readTemplatePath(data, template.responsePath);
  if (!Array.isArray(output) || output.some((item) => typeof item !== "string")) {
    throw new Error("Image template response must resolve to a string array");
  }
  return output as string[];
}
