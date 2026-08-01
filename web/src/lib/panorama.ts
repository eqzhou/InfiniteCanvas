import type { BoardNode } from "@/types/board";

const MIN_PANORAMA_EDGE = 64;
const MAX_PANORAMA_EDGE = 8_192;
const MAX_PANORAMA_PIXELS = 40_000_000;
const RATIO_TOLERANCE = 0.002;
const PANORAMA_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_PANORAMA_BATCH_PIXELS = 64_000_000;
export const MAX_PANORAMA_BATCH_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_PANORAMA_NODES = 64;
export const MAX_PROJECT_PANORAMA_PIXELS = 160_000_000;
export const MAX_PROJECT_PANORAMA_BYTES = 256 * 1024 * 1024;

export function validateProjectPanoramaBudget(nodes: BoardNode[]): void {
  const renderable = nodes.filter((node) => node.type === "panorama" && node.metadata.content);
  const pixels = renderable.reduce((total, node) =>
    total + (node.metadata.naturalWidth ?? 0) * (node.metadata.naturalHeight ?? 0), 0);
  const bytes = renderable.reduce((total, node) => total + (node.metadata.bytes ?? 0), 0);
  if (renderable.length > MAX_PROJECT_PANORAMA_NODES ||
      pixels > MAX_PROJECT_PANORAMA_PIXELS || bytes > MAX_PROJECT_PANORAMA_BYTES) {
    throw new Error("project panorama media exceeds aggregate limits");
  }
}

export function isSupportedPanoramaMimeType(value: string | undefined): boolean {
  return Boolean(value && PANORAMA_MIME_TYPES.has(value));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export async function validatePanoramaBlob(blob: Blob): Promise<void> {
  if (!PANORAMA_MIME_TYPES.has(blob.type)) {
    throw new Error("全景图仅支持 JPEG、PNG 或 WebP");
  }
  const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10]
    .every((value, index) => bytes[index] === value);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  const matches = blob.type === "image/png" ? png
    : blob.type === "image/jpeg" ? jpeg
      : webp;
  if (!matches) throw new Error("全景图片内容与声明格式不一致");
}

function uint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function uint32BE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

export async function readPanoramaBlobDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  await validatePanoramaBlob(blob);
  const bytes = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer());
  let width = 0;
  let height = 0;
  if (blob.type === "image/png" && bytes.length >= 24) {
    width = uint32BE(bytes, 16);
    height = uint32BE(bytes, 20);
  } else if (blob.type === "image/jpeg") {
    let offset = 2;
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if (startOfFrame.has(marker)) {
        height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
        break;
      }
      offset += 2 + length;
    }
  } else if (blob.type === "image/webp" && bytes.length >= 30) {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") {
      width = uint24LE(bytes, 24) + 1;
      height = uint24LE(bytes, 27) + 1;
    } else if (chunk === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
      const bits = new DataView(bytes.buffer, bytes.byteOffset + 21, 4).getUint32(0, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = ((bytes[26]! | (bytes[27]! << 8)) & 0x3fff);
      height = ((bytes[28]! | (bytes[29]! << 8)) & 0x3fff);
    }
  }
  if (!width || !height) throw new Error("无法从图片头读取全景尺寸");
  return validatePanoramaDimensions(width, height);
}

export function validatePanoramaDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < MIN_PANORAMA_EDGE || height < MIN_PANORAMA_EDGE ||
      width > MAX_PANORAMA_EDGE || height > MAX_PANORAMA_EDGE ||
      width * height > MAX_PANORAMA_PIXELS) {
    throw new Error("全景图片尺寸无效或超出限制");
  }
  if (Math.abs(width / height - 2) > RATIO_TOLERANCE) {
    throw new Error("全景图片必须是 2:1 等距柱状投影");
  }
  return { width, height };
}


export type LocalImageImportMode = "image" | "panorama";
export type LocalImageImportChoice = LocalImageImportMode | "cancel";

/** Strict 2:1 JPEG/PNG/WebP candidates can be imported as panorama or ordinary image nodes. */
export function isStrictTwoToOnePanoramaCandidate(
  mimeType: string | undefined,
  width: number,
  height: number,
): boolean {
  if (!isSupportedPanoramaMimeType(mimeType)) return false;
  try {
    validatePanoramaDimensions(width, height);
    return true;
  } catch {
    return false;
  }
}

export function resolveLocalTwoToOneImageImportChoice(
  choice: LocalImageImportChoice | undefined,
): LocalImageImportMode | null {
  if (choice === "panorama" || choice === "image") return choice;
  return null;
}

export function chooseLocalTwoToOneImageImportMode(
  prompt: (message: string) => boolean = (message) => window.confirm(message),
): LocalImageImportMode {
  const asPanorama = prompt(
    "检测到严格 2:1 图片。\n\n确定：作为全景图导入\n取消：作为普通图片导入",
  );
  return asPanorama ? "panorama" : "image";
}

export function buildPanoramaPrompt(prompt: string): string {
  const subject = prompt.trim();
  if (!subject) throw new Error("请输入全景场景描述");
  return [
    subject,
    "生成完整的 360° 等距柱状投影全景图，严格 2:1 画幅。",
    "水平覆盖 360°、垂直覆盖 180°，左右边缘无缝衔接，地平线位于垂直中心。",
    "单张连续画面，不要鱼眼圆框、拼图、边框、文字或水印。",
  ].join("\n");
}

export function panoramaGenerationError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const safeServerErrorPrefixes = [
    "图片生成请求超时",
    "连接模型服务超时",
    "模型服务在生成过程中中断了连接",
    "连接模型服务失败",
    "图片生成失败，请检查模型服务配置后重试",
    "模型服务拒绝了图片请求",
    "模型服务鉴权失败",
    "图片请求或参考素材过大",
    "模型服务请求过于频繁",
    "模型服务暂时不可用",
    "图片生成失败（模型服务 HTTP",
  ];
  if (safeServerErrorPrefixes.some((prefix) => message.startsWith(prefix))) return message;
  if (/^生成服务应返回 [1-8] 张全景图片，实际返回 [0-9]+ 张$/.test(message)) return message;
  if (message === "有参考图片已丢失，请重新连接后再生成" ||
      message === "全景生成质量无效" ||
      message === "全景生成张数必须在 1-8 之间" ||
      message === "全景生成最多支持 8 张参考图片" ||
      message === "全景生成参考图片总大小超过 24 MB" ||
      message === "全景生成批次超出 64 MB 或 6400 万像素限制" ||
      message === "全景批次子结果不可独立修改" ||
      message === "全景图生成已取消" ||
      message === "全景生成结果已丢失或内容不一致" ||
      message === "全景生成结果尺寸信息不一致" ||
      message === "无法从图片头读取全景尺寸") return message;
  const known = [
    "请先配置图片生成渠道",
    "生成服务没有返回全景图片",
    "全景图片尺寸无效或超出限制",
    "全景图片必须是 2:1 等距柱状投影",
    "全景图仅支持 JPEG、PNG 或 WebP",
    "全景图片内容与声明格式不一致",
  ].find((candidate) => message.startsWith(candidate));
  if (known) return known;
  const status = message.match(/(?:HTTP|status)\s*[:=]?\s*([1-5][0-9]{2})/i)?.[1];
  return status
    ? `全景图生成失败（HTTP ${status}），请检查模型渠道设置`
    : "全景图生成失败，请检查模型渠道设置";
}
