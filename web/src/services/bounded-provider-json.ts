async function readBoundedProviderBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid provider response limit");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new Error(`Provider response is too large (limit ${maxBytes} bytes)`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`Provider response is too large (limit ${maxBytes} bytes)`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("provider response size limit exceeded");
        throw new Error(`Provider response is too large (limit ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedProviderText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedProviderBytes(response, maxBytes));
}

export async function readBoundedProviderJson(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readBoundedProviderText(response, maxBytes)) as unknown;
}
