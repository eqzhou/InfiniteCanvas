import type {
  PromptItem,
  PromptSourceConfig,
  PromptSourceFormat,
  PromptSourceHtmlMapping,
  PromptSourceMapping,
} from "@/types/board";
import { readBoundedResponse } from "@/services/remote-content";
import { normalizeExternalHttpsUrl, normalizeExternalSourceUrl } from "@/lib/remote-url";

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
  maxSources: 50,
  maxSourceNameChars: 120,
  maxPathChars: 200,
  maxSelectorChars: 240,
} as const;

const PROMPT_MIME_TYPES = [
  "application/json",
  "text/plain",
  "text/markdown",
  "text/html",
] as const;

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIELD_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SIMPLE_SELECTOR = /^[A-Za-z0-9_#.\-\s>\[\]="']+$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCE_FORMATS = new Set<PromptSourceFormat>(["auto", "json", "markdown", "html"]);

function normalizeFieldPath(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > PROMPT_SOURCE_LIMITS.maxPathChars ||
      !FIELD_PATH.test(value) || value.split(".").some((part) => FORBIDDEN_PATH_SEGMENTS.has(part))) {
    throw new Error("Prompt source field path is invalid");
  }
  return value;
}

function normalizeSelector(value: unknown, required: boolean): string | undefined {
  if ((value === undefined || value === "") && !required) return undefined;
  if (typeof value !== "string" || value.length === 0 ||
      value.length > PROMPT_SOURCE_LIMITS.maxSelectorChars || !SIMPLE_SELECTOR.test(value)) {
    throw new Error("Prompt source selector is invalid");
  }
  return value;
}

function normalizeMapping(value: unknown): PromptSourceMapping | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prompt source mapping is invalid");
  }
  const input = value as Record<string, unknown>;
  return {
    itemsPath: normalizeFieldPath(input.itemsPath),
    idPath: normalizeFieldPath(input.idPath),
    titlePath: normalizeFieldPath(input.titlePath),
    bodyPath: normalizeFieldPath(input.bodyPath),
    tagsPath: normalizeFieldPath(input.tagsPath),
    coverUrlPath: normalizeFieldPath(input.coverUrlPath),
    resultUrlsPath: normalizeFieldPath(input.resultUrlsPath),
  };
}

function normalizeHtmlMapping(value: unknown): PromptSourceHtmlMapping | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prompt source HTML mapping is invalid");
  }
  const input = value as Record<string, unknown>;
  return {
    itemSelector: normalizeSelector(input.itemSelector, true)!,
    titleSelector: normalizeSelector(input.titleSelector, false),
    bodySelector: normalizeSelector(input.bodySelector, true)!,
    tagsSelector: normalizeSelector(input.tagsSelector, false),
    coverSelector: normalizeSelector(input.coverSelector, false),
    resultSelector: normalizeSelector(input.resultSelector, false),
  };
}

function sourceNameFromUrl(url: string): string {
  return new URL(url).hostname;
}

export function parsePromptSourceConfig(value: unknown, index = 0): PromptSourceConfig {
  if (typeof value === "string") {
    const url = normalizeExternalSourceUrl(value);
    return {
      id: `legacy-${index + 1}`,
      name: sourceNameFromUrl(url),
      url,
      format: "auto",
      enabled: true,
      refreshMinutes: 0,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prompt source config is invalid");
  }
  const input = value as Record<string, unknown>;
  const id = input.id;
  const name = input.name;
  const format = input.format ?? "auto";
  const url = normalizeExternalSourceUrl(String(input.url ?? ""));
  if (typeof id !== "string" || !SOURCE_ID.test(id)) {
    throw new Error("Prompt source ID is invalid");
  }
  if (typeof name !== "string") throw new Error("Prompt source name must be text");
  if (!name.trim()) throw new Error("Prompt source name is required");
  if (name.length > PROMPT_SOURCE_LIMITS.maxSourceNameChars) {
    throw new Error(`Prompt source name exceeds ${PROMPT_SOURCE_LIMITS.maxSourceNameChars} characters`);
  }
  if (typeof format !== "string" || !SOURCE_FORMATS.has(format as PromptSourceFormat)) {
    throw new Error("Prompt source format is invalid");
  }
  const refresh = input.refreshMinutes ?? 0;
  if (typeof refresh !== "number" || !Number.isInteger(refresh) ||
      (refresh !== 0 && (refresh < 5 || refresh > 1440))) {
    throw new Error("Prompt source refresh interval is invalid");
  }
  const mapping = normalizeMapping(input.mapping);
  const html = normalizeHtmlMapping(input.html);
  if (format === "html" && !html) throw new Error("HTML prompt source mapping is required");
  const lastFetchedAt = typeof input.lastFetchedAt === "string" &&
    !Number.isNaN(Date.parse(input.lastFetchedAt)) ? input.lastFetchedAt : undefined;
  return {
    id,
    name: name.trim(),
    url,
    format: format as PromptSourceFormat,
    enabled: input.enabled !== false,
    refreshMinutes: refresh,
    mapping,
    html,
    lastFetchedAt,
  };
}

export function normalizePromptSourceConfigs(value: unknown): PromptSourceConfig[] {
  if (!Array.isArray(value)) return [];
  const result: PromptSourceConfig[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.slice(0, PROMPT_SOURCE_LIMITS.maxSources).entries()) {
    try {
      const source = parsePromptSourceConfig(item, index);
      if (ids.has(source.id)) continue;
      ids.add(source.id);
      result.push(source);
    } catch {
      // Invalid persisted entries are isolated instead of breaking hydration.
    }
  }
  return result;
}

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

function stableRemotePromptId(sourceId: string, itemId: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(`${sourceId}\0${itemId}`)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `remote-${sourceId}-${hash.toString(16).padStart(16, "0")}`;
}

export function mergePromptSourceItems(
  cached: readonly PromptItem[],
  refreshed: readonly PromptItem[],
  sourceId: string,
): PromptItem[] {
  if (!SOURCE_ID.test(sourceId)) throw new Error("Prompt source ID is invalid");
  const merged = cached
    .filter((item) => item.sourceId !== sourceId)
    .map(clonePromptItem);
  const ids = new Set(merged.map((item) => item.id));
  for (const item of refreshed) {
    const clone = clonePromptItem(item);
    if (clone.sourceId && clone.sourceId !== sourceId) {
      throw new Error("Prompt source returned an item owned by another source");
    }
    clone.sourceId = sourceId;
    clone.id = stableRemotePromptId(sourceId, clone.id);
    if (ids.has(clone.id)) throw new Error("Prompt source contains duplicate item IDs");
    ids.add(clone.id);
    merged.push(clone);
  }
  return merged;
}

/** Clean-room remote prompt fetch: user-configured declarative JSON/text/HTML sources. */
export async function fetchPromptSource(
  input: string | PromptSourceConfig,
): Promise<PromptItem[]> {
  const source = parsePromptSourceConfig(input, 0);
  const normalizedUrl = source.url;
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
  const format = source.format === "auto"
    ? remote.mimeType === "application/json" || text.trim().startsWith("[") || text.trim().startsWith("{")
      ? "json"
      : remote.mimeType === "text/html" || /^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(text)
        ? "html"
        : "markdown"
    : source.format;

  if (format === "json") {
    const data = JSON.parse(text) as unknown;
    return normalizePromptJson(data, source);
  }
  if (format === "html") return normalizePromptHtml(text, source);
  return normalizePromptMarkdown(text, source);
}

function normalizePromptMarkdown(text: string, source: PromptSourceConfig): PromptItem[] {
  const blocks = text.split(/\n(?=#{1,3}\s+)/);
  if (blocks.length > PROMPT_SOURCE_LIMITS.maxItems) {
    throw new Error(`Prompt source has too many entries (limit ${PROMPT_SOURCE_LIMITS.maxItems})`);
  }
  const items: PromptItem[] = [];
  for (const [index, block] of blocks.entries()) {
    const lines = block.trim().split("\n");
    if (!lines.length) continue;
    const title = lines[0].replace(/^#+\s*/, "").trim() || "未命名";
    const body = lines.slice(1).join("\n").trim();
    if (!body) continue;
    items.push(validatePromptItem({
      id: `markdown-${index + 1}`,
      title,
      body,
      tags: [],
      source: source.name,
      sourceId: source.id,
    }));
  }
  return items;
}

function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) ||
        FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function boundedExternalUrl(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return normalizeExternalHttpsUrl(new URL(value, baseUrl).toString());
}

function normalizeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String)
    : typeof value === "string"
      ? value.split(/[,，\s]+/).filter(Boolean)
      : [];
}

function normalizeResultUrls(value: unknown, baseUrl: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => boundedExternalUrl(item, baseUrl)!)
    .filter(Boolean);
}

function normalizePromptJson(data: unknown, source: PromptSourceConfig): PromptItem[] {
  const mappedItems = readPath(data, source.mapping?.itemsPath);
  const arr = Array.isArray(mappedItems)
    ? mappedItems
    : Array.isArray(data)
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
  for (const [index, item] of arr.entries()) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const mapping = source.mapping;
    const rawTitle = mapping?.titlePath
      ? readPath(o, mapping.titlePath)
      : firstDefined(o.title, o.name);
    const rawBody = mapping?.bodyPath
      ? readPath(o, mapping.bodyPath)
      : firstDefined(o.body, o.prompt, o.content, o.text);
    const title = String(rawTitle ?? "未命名");
    const body = String(rawBody ?? "");
    if (!body) continue;
    const rawTags = mapping?.tagsPath ? readPath(o, mapping.tagsPath) : o.tags;
    const rawResultUrls = mapping?.resultUrlsPath
      ? readPath(o, mapping.resultUrlsPath)
      : firstDefined(o.resultUrls, o.images);
    const rawCover = mapping?.coverUrlPath ? readPath(o, mapping.coverUrlPath) : o.coverUrl;
    const rawId = mapping?.idPath ? readPath(o, mapping.idPath) : o.id;
    out.push(validatePromptItem({
      id: String(rawId ?? `json-${index + 1}`),
      title,
      body,
      tags: normalizeTags(rawTags),
      source: source.name,
      sourceId: source.id,
      coverUrl: boundedExternalUrl(rawCover, source.url),
      resultUrls: normalizeResultUrls(rawResultUrls, source.url),
    }));
  }
  return out;
}

function elementValue(element: Element | null): string {
  if (!element) return "";
  return element.getAttribute("src") ?? element.getAttribute("data-src") ??
    element.getAttribute("href") ?? element.textContent?.trim() ?? "";
}

function normalizePromptHtml(text: string, source: PromptSourceConfig): PromptItem[] {
  if (!source.html) throw new Error("HTML prompt source mapping is required");
  if (typeof DOMParser === "undefined") {
    throw new Error("HTML prompt source parsing is unavailable");
  }
  const document = new DOMParser().parseFromString(text, "text/html");
  const elements = [...document.querySelectorAll(source.html.itemSelector)];
  if (elements.length > PROMPT_SOURCE_LIMITS.maxItems) {
    throw new Error(`Prompt source has too many entries (limit ${PROMPT_SOURCE_LIMITS.maxItems})`);
  }
  return elements.flatMap((element, index): PromptItem[] => {
    const body = elementValue(element.querySelector(source.html!.bodySelector));
    if (!body) return [];
    const title = source.html!.titleSelector
      ? elementValue(element.querySelector(source.html!.titleSelector))
      : `未命名 ${index + 1}`;
    const tags = source.html!.tagsSelector
      ? [...element.querySelectorAll(source.html!.tagsSelector)].map((item) => item.textContent?.trim() ?? "").filter(Boolean)
      : [];
    const cover = source.html!.coverSelector
      ? elementValue(element.querySelector(source.html!.coverSelector))
      : "";
    const results = source.html!.resultSelector
      ? [...element.querySelectorAll(source.html!.resultSelector)].map(elementValue).filter(Boolean)
      : [];
    return [validatePromptItem({
      id: `${source.id}-${index + 1}`,
      title,
      body,
      tags,
      source: source.name,
      sourceId: source.id,
      coverUrl: boundedExternalUrl(cover, source.url),
      resultUrls: normalizeResultUrls(results, source.url),
    })];
  });
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
    sourceId: item.sourceId
      ? assertField(item.sourceId, "source ID", 64)
      : item.sourceId,
    coverUrl: item.coverUrl
      ? assertField(item.coverUrl, "cover URL", PROMPT_SOURCE_LIMITS.maxCoverUrlChars)
      : item.coverUrl,
    resultUrls,
  };
}
