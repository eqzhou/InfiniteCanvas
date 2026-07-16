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
