import type { PromptItem } from "@/types/board";
import { uid } from "@/lib/id";
import { readBoundedResponse } from "@/services/remote-content";
import { normalizeExternalHttpsUrl } from "@/lib/remote-url";

export const PROMPT_SOURCE_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxItems: 1000,
  maxIdChars: 200,
  maxTitleChars: 200,
  maxBodyChars: 20_000,
  maxTags: 20,
  maxTagChars: 64,
  maxSourceChars: 512,
  maxCoverUrlChars: 2048,
  maxResultUrls: 12,
  maxResultUrlChars: 2048,
} as const;

const PROMPT_MIME_TYPES = [
  "application/json",
  "text/plain",
  "text/markdown",
] as const;

/** Clean-room preset catalogs (public raw content URLs / local demos). */
export const BUILTIN_PROMPT_SOURCES: Array<{
  id: string;
  name: string;
  description: string;
  /** When set, fetch this URL. When empty, use local demo catalog. */
  url?: string;
  kind: "remote" | "demo";
}> = [
  {
    id: "openboard-demo",
    name: "OpenBoard 内置示例",
    description: "本地示例提示词（不依赖外网）",
    kind: "demo",
  },
  {
    id: "custom",
    name: "自定义 URL",
    description: "JSON 数组或 Markdown 标题块",
    kind: "remote",
  },
];

export function demoPromptCatalog(): PromptItem[] {
  return [
    {
      id: "demo-product",
      title: "产品棚拍",
      body: "Studio product photo, softbox lighting, seamless backdrop, high detail, commercial catalog style",
      tags: ["product", "studio"],
      source: "openboard-demo",
    },
    {
      id: "demo-cinematic",
      title: "电影静帧",
      body: "Cinematic still, anamorphic lens flare, volumetric light, 35mm film grain, dramatic composition",
      tags: ["cinematic"],
      source: "openboard-demo",
    },
    {
      id: "demo-character",
      title: "角色设定三视图",
      body: "Character design sheet, front side back views, clean line art, consistent proportions, white background",
      tags: ["character"],
      source: "openboard-demo",
    },
    {
      id: "demo-cyber",
      title: "赛博夜景",
      body: "Rainy cyberpunk street, neon reflections, dense atmosphere, ultra detailed night city",
      tags: ["scifi", "city"],
      source: "openboard-demo",
    },
    {
      id: "demo-portrait",
      title: "柔光人像",
      body: "Soft natural window light portrait, shallow depth of field, gentle skin texture, editorial mood",
      tags: ["portrait"],
      source: "openboard-demo",
    },
    {
      id: "demo-poster",
      title: "扁平插画海报",
      body: "Flat vector illustration poster, bold shapes, limited palette, clean typography space",
      tags: ["illustration", "poster"],
      source: "openboard-demo",
    },
  ];
}

function clonePromptItem(item: PromptItem): PromptItem {
  return {
    ...item,
    tags: [...item.tags],
    resultUrls: item.resultUrls ? [...item.resultUrls] : undefined,
  };
}

export function mergePromptSourceItems(
  cached: readonly PromptItem[],
  refreshed: readonly PromptItem[],
): PromptItem[] {
  const key = (item: PromptItem) => `${item.title}::${item.body}`;
  const merged = new Map<string, PromptItem>();
  for (const item of cached) merged.set(key(item), clonePromptItem(item));
  for (const item of refreshed) merged.set(key(item), clonePromptItem(item));
  return [...merged.values()];
}

/** Clean-room remote prompt fetch: user-configured raw JSON/text URLs. */
export async function fetchPromptSource(url: string): Promise<PromptItem[]> {
  const normalizedUrl = normalizeExternalHttpsUrl(url);
  const res = await fetch(normalizedUrl, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`拉取失败 ${res.status}`);
  const remote = await readBoundedResponse(res, {
    maxBytes: PROMPT_SOURCE_LIMITS.maxBytes,
    mimeTypes: PROMPT_MIME_TYPES,
  });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(remote.bytes);

  if (
    remote.mimeType === "application/json" ||
    text.trim().startsWith("[") ||
    text.trim().startsWith("{")
  ) {
    const data = JSON.parse(text) as unknown;
    return normalizePromptJson(data, normalizedUrl);
  }

  const blocks = text.split(/\n(?=#{1,3}\s+)/);
  if (blocks.length > PROMPT_SOURCE_LIMITS.maxItems) {
    throw new Error(`Prompt source has too many entries (limit ${PROMPT_SOURCE_LIMITS.maxItems})`);
  }
  const items: PromptItem[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (!lines.length) continue;
    const title = lines[0].replace(/^#+\s*/, "").trim() || "未命名";
    const body = lines.slice(1).join("\n").trim();
    if (!body) continue;
    items.push(validatePromptItem({
      id: uid("prompt"),
      title,
      body,
      tags: [],
      source: safeHost(normalizedUrl),
    }));
  }
  return items;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "remote";
  }
}

function normalizePromptJson(data: unknown, url: string): PromptItem[] {
  const source = safeHost(url);
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { items?: unknown[] }).items)
      ? ((data as { items: unknown[] }).items)
      : data && typeof data === "object" && Array.isArray((data as { prompts?: unknown[] }).prompts)
        ? ((data as { prompts: unknown[] }).prompts)
        : [];

  if (arr.length > PROMPT_SOURCE_LIMITS.maxItems) {
    throw new Error(`Prompt source has too many entries (limit ${PROMPT_SOURCE_LIMITS.maxItems})`);
  }

  const out: PromptItem[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = String(o.title ?? o.name ?? "未命名");
    const body = String(o.body ?? o.prompt ?? o.content ?? o.text ?? "");
    if (!body) continue;
    const tags = Array.isArray(o.tags)
      ? o.tags.map(String)
      : typeof o.tags === "string"
        ? o.tags.split(/[,，\s]+/).filter(Boolean)
        : [];
    const rawResultUrls = Array.isArray(o.resultUrls)
      ? o.resultUrls
      : Array.isArray(o.images)
        ? o.images
        : [];
    out.push(validatePromptItem({
      id: String(o.id ?? uid("prompt")),
      title,
      body,
      tags,
      source: String(o.source ?? source),
      coverUrl: typeof o.coverUrl === "string" ? normalizeExternalHttpsUrl(o.coverUrl) : undefined,
      resultUrls: rawResultUrls
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizeExternalHttpsUrl(value)),
    }));
  }
  return out;
}

function assertField(value: string, field: string, maxChars: number): string {
  if (value.length > maxChars) {
    throw new Error(`Prompt ${field} exceeds ${maxChars} characters`);
  }
  return value;
}

function validatePromptItem(item: PromptItem): PromptItem {
  if (item.tags.length > PROMPT_SOURCE_LIMITS.maxTags) {
    throw new Error(`Prompt tags exceed ${PROMPT_SOURCE_LIMITS.maxTags} entries`);
  }
  const tags = item.tags.map((tag) =>
    assertField(tag, "tag", PROMPT_SOURCE_LIMITS.maxTagChars));
  if ((item.resultUrls?.length ?? 0) > PROMPT_SOURCE_LIMITS.maxResultUrls) {
    throw new Error(`Prompt result images exceed ${PROMPT_SOURCE_LIMITS.maxResultUrls} entries`);
  }
  const resultUrls = item.resultUrls?.map((url) =>
    assertField(url, "result image URL", PROMPT_SOURCE_LIMITS.maxResultUrlChars));
  return {
    ...item,
    id: assertField(item.id, "id", PROMPT_SOURCE_LIMITS.maxIdChars),
    title: assertField(item.title, "title", PROMPT_SOURCE_LIMITS.maxTitleChars),
    body: assertField(item.body, "body", PROMPT_SOURCE_LIMITS.maxBodyChars),
    tags,
    source: item.source
      ? assertField(item.source, "source", PROMPT_SOURCE_LIMITS.maxSourceChars)
      : item.source,
    coverUrl: item.coverUrl
      ? assertField(item.coverUrl, "cover URL", PROMPT_SOURCE_LIMITS.maxCoverUrlChars)
      : item.coverUrl,
    resultUrls,
  };
}
