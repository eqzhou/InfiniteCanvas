export interface BoundedResponseOptions {
  maxBytes: number;
  /** Exact MIME values, or a family prefix ending in slash (for example image/). */
  mimeTypes: readonly string[];
}

export interface BoundedResponse {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

function normalizedMime(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
}

function acceptsMime(actual: string, allowed: readonly string[]): boolean {
  return allowed.some((value) => value.endsWith("/")
    ? actual.startsWith(value)
    : actual === value);
}

export function decodeBoundedDataUrl(
  value: string,
  options: BoundedResponseOptions,
): BoundedResponse {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("Invalid data URL byte limit");
  }
  const comma = value.indexOf(",");
  const header = comma >= 0 ? value.slice(0, comma) : "";
  const headerMatch = /^data:([^;,\s]+);base64$/i.exec(header);
  if (!headerMatch) throw new Error("Invalid base64 data URL");
  const mimeType = headerMatch[1]!.toLowerCase();
  if (!acceptsMime(mimeType, options.mimeTypes)) {
    throw new Error(`Unsupported data URL MIME type: ${mimeType}`);
  }
  const encoded = value.slice(comma + 1);
  if (!isValidBase64(encoded)) {
    throw new Error("Invalid base64 data URL");
  }
  if (encoded.length > Math.ceil(options.maxBytes / 3) * 4 + 4) {
    throw new Error("Data URL is too large");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength > options.maxBytes) throw new Error("Data URL is too large");
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(decodedLength);
  let targetOffset = 0;
  try {
    // Decode in aligned chunks. Besides reducing peak memory, this avoids
    // browser limits on a single multi-megabyte atob invocation.
    const chunkLength = 64 * 1024;
    for (let offset = 0; offset < encoded.length; offset += chunkLength) {
      const binary = atob(encoded.slice(offset, offset + chunkLength));
      for (let index = 0; index < binary.length; index += 1) {
        bytes[targetOffset++] = binary.charCodeAt(index);
      }
    }
  } catch {
    throw new Error("Invalid base64 data URL");
  }
  if (targetOffset !== decodedLength) throw new Error("Invalid base64 data URL");
  return { bytes, mimeType };
}

function isValidBase64(encoded: string): boolean {
  if (encoded.length % 4 !== 0) return false;
  const firstPadding = encoded.indexOf("=");
  const contentLength = firstPadding === -1 ? encoded.length : firstPadding;
  const paddingLength = encoded.length - contentLength;
  if (paddingLength > 2) return false;
  for (let index = contentLength; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) return false;
  }
  for (let index = 0; index < contentLength; index += 1) {
    const code = encoded.charCodeAt(index);
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!valid) return false;
  }
  return true;
}

export async function readBoundedResponse(
  response: Response,
  options: BoundedResponseOptions,
): Promise<BoundedResponse> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("Invalid remote content byte limit");
  }

  const mimeType = normalizedMime(response);
  if (!mimeType || !acceptsMime(mimeType, options.mimeTypes)) {
    throw new Error(`Unsupported remote content MIME type: ${mimeType || "missing"}`);
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (Number.isFinite(size) && size > options.maxBytes) {
      throw new Error(`Remote content is too large (limit ${options.maxBytes} bytes)`);
    }
  }

  if (!response.body) {
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > options.maxBytes) {
      throw new Error(`Remote content is too large (limit ${options.maxBytes} bytes)`);
    }
    return { bytes, mimeType };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > options.maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new Error(`Remote content is too large (limit ${options.maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mimeType };
}
