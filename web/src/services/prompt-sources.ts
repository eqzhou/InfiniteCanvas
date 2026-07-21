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
  maxBytes: 4 * 1024 * 1024,
  maxItems: 20_000,
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
  maxScriptChars: 64 * 1024,
} as const;

const PROMPT_MIME_TYPES = [
  "application/json",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/javascript",
  "text/javascript",
  "application/xml",
  "text/xml",
  "application/octet-stream",
] as const;

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIELD_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SIMPLE_SELECTOR = /^[A-Za-z0-9_#.\-\s>\[\]="']+$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const SOURCE_FORMATS = new Set<PromptSourceFormat>(["auto", "json", "markdown", "html", "script"]);

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
  let script: string | undefined;
  if (input.script !== undefined && input.script !== "") {
    if (typeof input.script !== "string") throw new Error("Prompt source script must be text");
    if (input.script.length > PROMPT_SOURCE_LIMITS.maxScriptChars) {
      throw new Error(`Prompt source script exceeds ${PROMPT_SOURCE_LIMITS.maxScriptChars} characters`);
    }
    script = input.script;
  }
  if (format === "script" && !script?.trim()) {
    throw new Error("Script prompt source requires a transform script");
  }
  const lastFetchedAt = typeof input.lastFetchedAt === "string" &&
    !Number.isNaN(Date.parse(input.lastFetchedAt)) ? input.lastFetchedAt : undefined;
  const lastSuccessAt = typeof input.lastSuccessAt === "string" &&
    !Number.isNaN(Date.parse(input.lastSuccessAt)) ? input.lastSuccessAt : undefined;
  const lastError = typeof input.lastError === "string" && input.lastError.trim()
    ? input.lastError.trim().slice(0, 500)
    : undefined;
  const itemCount = typeof input.itemCount === "number" &&
    Number.isInteger(input.itemCount) && input.itemCount >= 0
    ? Math.min(input.itemCount, PROMPT_SOURCE_LIMITS.maxItems)
    : undefined;
  let homepage: string | undefined;
  if (input.homepage !== undefined && input.homepage !== "") {
    if (typeof input.homepage !== "string") throw new Error("Prompt source homepage must be text");
    try {
      homepage = normalizeExternalHttpsUrl(input.homepage.trim());
    } catch {
      // Homepage is display-only; drop invalid values instead of failing the source.
      homepage = undefined;
    }
  }
  return {
    id,
    name: name.trim(),
    url,
    format: format as PromptSourceFormat,
    enabled: input.enabled !== false,
    refreshMinutes: refresh,
    mapping,
    html,
    script,
    homepage,
    lastFetchedAt,
    lastSuccessAt,
    lastError,
    itemCount,
    builtIn: input.builtIn === true,
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

/** Remote prompt fetch: declarative JSON/text/HTML sources, plus local transform scripts. */
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
  if (source.format === "script") {
    return normalizePromptScript(text, source);
  }
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

function scriptHelpers(baseUrl: string) {
  return {
    parseJson(value: string): unknown {
      return JSON.parse(value) as unknown;
    },
    queryAll(html: string, selector: string): Array<{ text: string; html: string; attr: (name: string) => string }> {
      if (typeof DOMParser === "undefined") {
        throw new Error("HTML helpers are unavailable in this runtime");
      }
      if (typeof selector !== "string" || !selector.trim()) {
        throw new Error("queryAll selector is required");
      }
      if (typeof html !== "string") {
        throw new Error("queryAll html must be text");
      }
      const document = new DOMParser().parseFromString(html, "text/html");
      let elements: Element[];
      try {
        elements = [...document.querySelectorAll(selector)];
      } catch (cause) {
        throw new Error(`queryAll selector is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return elements.map((element) => ({
        text: element.textContent?.trim() ?? "",
        html: element.innerHTML,
        attr: (name: string) => {
          if (typeof name !== "string" || !name.trim()) return "";
          return element.getAttribute(name) ?? "";
        },
      }));
    },
    absoluteUrl(value: string): string {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error("absoluteUrl requires a non-empty string");
      }
      return new URL(value, baseUrl).toString();
    },
  };
}

function normalizePromptScript(text: string, source: PromptSourceConfig): PromptItem[] {
  const script = source.script?.trim();
  if (!script) throw new Error("Script prompt source requires a transform script");
  let runner: (content: string, url: string, helpers: ReturnType<typeof scriptHelpers>) => unknown;
  try {
    // Local-only transform: user-authored config. Concatenate (do not template)
    // so script bodies may contain backticks or ${...} safely.
    // eslint-disable-next-line no-new-func
    runner = new Function(
      "text",
      "url",
      "helpers",
      '"use strict";\n' + script,
    ) as typeof runner;
  } catch (cause) {
    throw new Error(`Prompt source script is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  let produced: unknown;
  try {
    produced = runner(text, source.url, scriptHelpers(source.url));
  } catch (cause) {
    throw new Error(`Prompt source script failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  // Scripts must return a synchronous array (or {items|prompts}); async is rejected.
  if (produced && typeof (produced as PromiseLike<unknown>).then === "function") {
    throw new Error("Prompt source script must return items synchronously");
  }

  if (!Array.isArray(produced)) {
    if (produced && typeof produced === "object") {
      const record = produced as { items?: unknown; prompts?: unknown };
      if (Array.isArray(record.items)) produced = record.items;
      else if (Array.isArray(record.prompts)) produced = record.prompts;
      else throw new Error("Prompt source script must return an array of prompt items");
    } else {
      throw new Error("Prompt source script must return an array of prompt items");
    }
  }

  const rows = produced as unknown[];
  if (rows.length > PROMPT_SOURCE_LIMITS.maxItems) {
    throw new Error(`Prompt source has too many entries (limit ${PROMPT_SOURCE_LIMITS.maxItems})`);
  }

  const out: PromptItem[] = [];
  for (const [index, item] of rows.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const title = String(o.title ?? o.name ?? o.label ?? `未命名 ${index + 1}`);
    const body = String(o.body ?? o.prompt ?? o.content ?? o.text ?? "");
    if (!body.trim()) continue;
    const coverUrl = safeBoundedExternalUrl(o.coverUrl ?? o.cover, source.url);
    const resultUrls = normalizeResultUrls(
      firstDefined(o.resultUrls, o.images, o.results),
      source.url,
    );
    out.push(validatePromptItem({
      id: String(o.id ?? `${source.id}-${index + 1}`),
      title,
      body,
      tags: normalizeTags(o.tags),
      source: source.name,
      sourceId: source.id,
      ...(coverUrl ? { coverUrl } : {}),
      ...(resultUrls.length ? { resultUrls } : {}),
    }));
  }
  return out;
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMarkdownImages(block: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    // Community catalogs often include broken or non-HTTPS media; skip them.
    const resolved = safeBoundedExternalUrl(raw, baseUrl);
    if (resolved && !urls.includes(resolved)) urls.push(resolved);
  };
  for (const match of block.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    push(match[1]);
  }
  for (const match of block.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
    push(match[1]);
  }
  return urls.slice(0, PROMPT_SOURCE_LIMITS.maxResultUrls);
}

function extractFencedBodies(block: string): string[] {
  const bodies: string[] = [];
  for (const match of block.matchAll(/```[^\n]*\r?\n([\s\S]*?)\r?\n```/g)) {
    const body = match[1].trim();
    if (body) bodies.push(body);
  }
  return bodies;
}

function extractLabeledPromptBodies(block: string): string[] {
  const bodies: string[] = [];
  const patterns: RegExp[] = [
    /\*\*提示词文本[:：]\*\*\s*`([\s\S]*?)`/g,
    /\*\*提示词[:：]\*\*\s*`([\s\S]*?)`/g,
    /-\s*\*\*提示词文本[:：]\*\*\s*`([\s\S]*?)`/g,
    // Community catalogs often put the prompt body in the next fenced block.
    /\*\*提示词(?:文本)?[:：]\*\*\s*(?:\r?\n)+\s*```[^\n]*\r?\n([\s\S]*?)\r?\n```/g,
    /####[^\n]*提示词[^\n]*\r?\n\s*```[^\n]*\r?\n([\s\S]*?)\r?\n```/g,
  ];
  for (const pattern of patterns) {
    for (const match of block.matchAll(pattern)) {
      const body = match[1].trim();
      if (body) bodies.push(body);
    }
  }
  return bodies;
}

function extractSectionTags(heading: string): string[] {
  const cleaned = heading
    .replace(/[^\p{L}\p{N}/&、与 \-]+/gu, " ")
    .trim();
  if (!cleaned) return [];
  // Skip table-of-contents style headings so they do not become prompt tags.
  if (/^(目录|contents|toc|table of contents|索引|导航)$/i.test(cleaned)) return [];
  return cleaned
    .split(/\s*(?:\/|&|、|与|,|，)\s*/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tag.length <= PROMPT_SOURCE_LIMITS.maxTagChars)
    .slice(0, PROMPT_SOURCE_LIMITS.maxTags);
}

function pushBoundedPrompt(items: PromptItem[], item: PromptItem): void {
  if (items.length >= PROMPT_SOURCE_LIMITS.maxItems) {
    throw new Error(`Prompt source has too many entries (limit ${PROMPT_SOURCE_LIMITS.maxItems})`);
  }
  items.push(validatePromptItem(item));
}

function normalizeStructuredMarkdownSections(
  text: string,
  source: PromptSourceConfig,
): PromptItem[] | null {
  const headingMatches = [...text.matchAll(/^#{2,3}\s+(.+)$/gm)];
  if (headingMatches.length < 2) return null;

  const items: PromptItem[] = [];
  let sectionTags: string[] = [];
  let structuredHits = 0;

  for (let index = 0; index < headingMatches.length; index += 1) {
    const match = headingMatches[index]!;
    const heading = stripMarkdownInline(match[1] ?? "");
    const startOffset = match.index ?? 0;
    const endOffset = index + 1 < headingMatches.length
      ? (headingMatches[index + 1]!.index ?? text.length)
      : text.length;
    const block = text.slice(startOffset, endOffset);
    const level = match[0].startsWith("###") ? 3 : 2;

    if (level === 2) {
      sectionTags = extractSectionTags(heading);
      continue;
    }

    // Structured catalogs require an explicit prompt label. Bare fenced code under
    // ### headings is common in docs and must not become a prompt entry.
    const labeledBodies = extractLabeledPromptBodies(block);
    if (!labeledBodies.length) continue;
    const fencedBodies = extractFencedBodies(block);

    // Prefer the adjacent fenced body when the labeled capture is only a short
    // leftover and a substantial fence exists in the same section.
    let body = labeledBodies[0]!;
    if (fencedBodies.length) {
      const labeled = labeledBodies[0]!;
      if (labeled.length < 24 && fencedBodies[0]!.length > labeled.length) {
        body = fencedBodies[0]!;
      }
    }

    structuredHits += 1;
    const images = extractMarkdownImages(block, source.url);
    const titleMatch = heading.match(/^(?:No\.\s*\d+\s*[:：]\s*)?(.+)$/i);
    const title = stripMarkdownInline(titleMatch?.[1] ?? heading) || `未命名 ${index + 1}`;
    pushBoundedPrompt(items, {
      id: `${source.id}-${structuredHits}`,
      title,
      body,
      tags: [...sectionTags],
      source: source.name,
      sourceId: source.id,
      ...(images[0] ? { coverUrl: images[0] } : {}),
      ...(images.length > 1 ? { resultUrls: images.slice(1) } : {}),
    });
  }

  if (structuredHits === 0) return null;
  return items;
}

function normalizePromptMarkdown(text: string, source: PromptSourceConfig): PromptItem[] {
  const structured = normalizeStructuredMarkdownSections(text, source);
  if (structured) return structured;

  const blocks = text.split(/\n(?=#{1,3}\s+)/);
  if (blocks.length > PROMPT_SOURCE_LIMITS.maxItems) {
    throw new Error(`Prompt source has too many entries (limit ${PROMPT_SOURCE_LIMITS.maxItems})`);
  }
  const items: PromptItem[] = [];
  for (const [index, block] of blocks.entries()) {
    const lines = block.trim().split("\n");
    if (!lines.length) continue;
    const title = stripMarkdownInline(lines[0].replace(/^#+\s*/, "")) || "未命名";
    const body = lines.slice(1).join("\n").trim();
    if (!body) continue;
    const images = extractMarkdownImages(block, source.url);
    items.push(validatePromptItem({
      id: `markdown-${index + 1}`,
      title,
      body,
      tags: [],
      source: source.name,
      sourceId: source.id,
      ...(images[0] ? { coverUrl: images[0] } : {}),
      ...(images.length > 1 ? { resultUrls: images.slice(1) } : {}),
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

/** Soft-skip invalid media URLs so one bad cover/result does not fail a catalog. */
function safeBoundedExternalUrl(value: unknown, baseUrl: string): string | undefined {
  try {
    return boundedExternalUrl(value, baseUrl);
  } catch {
    return undefined;
  }
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
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) continue;
    const resolved = safeBoundedExternalUrl(item, baseUrl);
    if (resolved && !urls.includes(resolved)) urls.push(resolved);
  }
  return urls;
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
      : firstDefined(o.title, o.title_cn, o.title_en, o.name, o.label);
    const rawBody = mapping?.bodyPath
      ? readPath(o, mapping.bodyPath)
      : firstDefined(o.body, o.prompt, o.content, o.text, o.value);
    // If mapped title path is empty, fall back to common bilingual fields.
    const fallbackTitle = firstDefined(o.title, o.title_cn, o.title_en, o.name, o.label);
    const title = String((rawTitle !== undefined && rawTitle !== null && String(rawTitle).trim())
      ? rawTitle
      : (fallbackTitle ?? "未命名"));
    const body = String(rawBody ?? "");
    if (!body) continue;
    const rawTags = mapping?.tagsPath ? readPath(o, mapping.tagsPath) : o.tags;
    const rawResultUrls = mapping?.resultUrlsPath
      ? readPath(o, mapping.resultUrlsPath)
      : firstDefined(o.resultUrls, o.referenceImageUrls, o.images, o.results);
    const rawCover = mapping?.coverUrlPath
      ? readPath(o, mapping.coverUrlPath)
      : firstDefined(o.coverUrl, o.preview, o.cover);
    const rawId = mapping?.idPath ? readPath(o, mapping.idPath) : o.id;
    const coverUrl = safeBoundedExternalUrl(rawCover, source.url);
    const resultUrls = normalizeResultUrls(rawResultUrls, source.url);
    out.push(validatePromptItem({
      id: String(rawId ?? `json-${index + 1}`),
      title,
      body,
      tags: normalizeTags(rawTags),
      source: source.name,
      sourceId: source.id,
      ...(coverUrl ? { coverUrl } : {}),
      ...(resultUrls.length ? { resultUrls } : {}),
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
    const coverUrl = safeBoundedExternalUrl(cover, source.url);
    const resultUrls = normalizeResultUrls(results, source.url);
    return [validatePromptItem({
      id: `${source.id}-${index + 1}`,
      title,
      body,
      tags,
      source: source.name,
      sourceId: source.id,
      ...(coverUrl ? { coverUrl } : {}),
      ...(resultUrls.length ? { resultUrls } : {}),
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
