const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;
const ALLOWED_MIME = new Set(["", "application/octet-stream", "model/gltf-binary"]);
const ACCESSOR_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export type DirectorGlbLimits = {
  maxBlobBytes: number;
  maxJsonBytes: number;
  maxJsonEntries: number;
  maxJsonDepth: number;
};

const DEFAULT_LIMITS: DirectorGlbLimits = {
  maxBlobBytes: 100 * 1024 * 1024,
  maxJsonBytes: 4 * 1024 * 1024,
  maxJsonEntries: 100_000,
  maxJsonDepth: 64,
};

function inspectManifest(value: unknown, limits: DirectorGlbLimits): void {
  let entries = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > limits.maxJsonDepth) throw new Error("GLB manifest nesting is too deep");
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      entries += 1;
      if (entries > limits.maxJsonEntries) throw new Error("GLB manifest is too complex");
      if (key === "uri" && typeof child === "string") {
        throw new Error("GLB external URI references are unsupported");
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  const manifest = value as Record<string, unknown>;
  const boundedArray = (key: string, max: number): unknown[] => {
    const items = manifest[key];
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > max) throw new Error(`GLB ${key} collection is too complex`);
    return items;
  };
  boundedArray("nodes", 10_000);
  const meshes = boundedArray("meshes", 2_000);
  boundedArray("materials", 1_000);
  boundedArray("textures", 128);
  boundedArray("images", 128);
  const buffers = boundedArray("buffers", 1);
  const bufferViews = boundedArray("bufferViews", 10_000);
  boundedArray("skins", 128);
  boundedArray("animations", 256);
  boundedArray("samplers", 128);
  boundedArray("cameras", 128);
  for (const buffer of buffers) {
    if (!buffer || typeof buffer !== "object" || Array.isArray(buffer)) throw new Error("GLB buffer is invalid");
    const byteLength = (buffer as Record<string, unknown>).byteLength;
    if (!Number.isInteger(byteLength) || (byteLength as number) < 0 || (byteLength as number) > limits.maxBlobBytes) {
      throw new Error("GLB buffer byteLength is invalid");
    }
  }
  for (const bufferView of bufferViews) {
    if (!bufferView || typeof bufferView !== "object" || Array.isArray(bufferView)) throw new Error("GLB bufferView is invalid");
    const item = bufferView as Record<string, unknown>;
    const offset = item.byteOffset === undefined ? 0 : item.byteOffset as number;
    const bufferRecord = buffers[item.buffer as number] as Record<string, unknown> | undefined;
    const bufferLength = bufferRecord?.byteLength as number | undefined;
    if (!Number.isInteger(item.buffer) || (item.buffer as number) < 0 || (item.buffer as number) >= buffers.length ||
        !Number.isInteger(item.byteLength) || (item.byteLength as number) < 0 || (item.byteLength as number) > limits.maxBlobBytes ||
        !Number.isInteger(offset) || offset < 0 || offset + (item.byteLength as number) > (bufferLength ?? -1)) {
      throw new Error("GLB bufferView reference is invalid");
    }
  }
  const accessors = boundedArray("accessors", 10_000);
  const accessorItems: Array<Record<string, unknown>> = [];
  let decodedBytes = 0;
  const vertices = accessors.reduce<number>((total, accessor) => {
    if (!accessor || typeof accessor !== "object" || Array.isArray(accessor)) throw new Error("GLB accessor is invalid");
    const item = accessor as Record<string, unknown>;
    accessorItems.push(item);
    const count = item.count;
    if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 2_000_000) {
      throw new Error("GLB accessor count is invalid");
    }
    if (item.bufferView !== undefined && (!Number.isInteger(item.bufferView) ||
        (item.bufferView as number) < 0 || (item.bufferView as number) >= bufferViews.length)) {
      throw new Error("GLB accessor bufferView is invalid");
    }
    const components = typeof item.type === "string" ? ACCESSOR_COMPONENTS[item.type] : undefined;
    const componentBytes = typeof item.componentType === "number" ? COMPONENT_BYTES[item.componentType] : undefined;
    if (!components || !componentBytes) throw new Error("GLB accessor format is invalid");
    const itemBytes = components * componentBytes;
    decodedBytes += (count as number) * itemBytes;
    if (item.bufferView !== undefined) {
      const view = bufferViews[item.bufferView as number] as Record<string, unknown>;
      const accessorOffset = (item.byteOffset as number | undefined) ?? 0;
      const stride = (view.byteStride as number | undefined) ?? itemBytes;
      if (!Number.isInteger(accessorOffset) || accessorOffset < 0 || !Number.isInteger(stride) || stride < itemBytes ||
          ((count as number) > 0 && accessorOffset + ((count as number) - 1) * stride + itemBytes > (view.byteLength as number))) {
        throw new Error("GLB accessor byte range is invalid");
      }
    }
    if (item.sparse !== undefined) {
      if (!item.sparse || typeof item.sparse !== "object" || Array.isArray(item.sparse)) throw new Error("GLB sparse accessor is invalid");
      const sparseCount = (item.sparse as Record<string, unknown>).count;
      if (!Number.isInteger(sparseCount) || (sparseCount as number) < 0 ||
          (sparseCount as number) > (count as number) || (sparseCount as number) > 250_000) {
        throw new Error("GLB sparse accessor count is invalid");
      }
      decodedBytes += (sparseCount as number) * itemBytes;
    }
    if (decodedBytes > 64 * 1024 * 1024) throw new Error("GLB decoded accessor data is too complex");
    return total + (count as number);
  }, 0);
  if (vertices > 2_000_000) throw new Error("GLB accessor data is too complex");
  let primitiveCount = 0;
  for (const mesh of meshes) {
    if (!mesh || typeof mesh !== "object" || Array.isArray(mesh)) throw new Error("GLB mesh is invalid");
    const primitives = (mesh as Record<string, unknown>).primitives;
    if (!Array.isArray(primitives)) throw new Error("GLB mesh primitives are invalid");
    primitiveCount += primitives.length;
    if (primitiveCount > 5_000) throw new Error("GLB mesh primitives are too complex");
    for (const primitive of primitives) {
      if (!primitive || typeof primitive !== "object" || Array.isArray(primitive)) throw new Error("GLB mesh primitive is invalid");
      const item = primitive as Record<string, unknown>;
      const attributes = item.attributes;
      if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) throw new Error("GLB mesh attributes are invalid");
      for (const accessorIndex of Object.values(attributes as Record<string, unknown>)) {
        if (!Number.isInteger(accessorIndex) || (accessorIndex as number) < 0 || (accessorIndex as number) >= accessorItems.length) {
          throw new Error("GLB mesh accessor reference is invalid");
        }
      }
      if (item.indices !== undefined && (!Number.isInteger(item.indices) ||
          (item.indices as number) < 0 || (item.indices as number) >= accessorItems.length)) {
        throw new Error("GLB mesh index reference is invalid");
      }
    }
  }
  const requiredExtensions = manifest.extensionsRequired;
  if (Array.isArray(requiredExtensions) && requiredExtensions.some((name) =>
    name === "KHR_draco_mesh_compression" || name === "EXT_meshopt_compression" || name === "KHR_texture_basisu"
  )) {
    throw new Error("GLB compressed resources are unsupported");
  }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  return null;
}

function validateEmbeddedImages(
  manifest: Record<string, unknown>,
  bytes: ArrayBuffer,
  binaryOffset: number,
  binaryLength: number,
): void {
  const images = Array.isArray(manifest.images) ? manifest.images : [];
  const bufferViews = Array.isArray(manifest.bufferViews) ? manifest.bufferViews : [];
  let totalPixels = 0;
  for (const image of images) {
    if (!image || typeof image !== "object" || Array.isArray(image)) throw new Error("GLB image is invalid");
    const item = image as Record<string, unknown>;
    const viewIndex = item.bufferView;
    const mimeType = item.mimeType;
    if (!Number.isInteger(viewIndex) || (viewIndex as number) < 0 || (viewIndex as number) >= bufferViews.length ||
        (mimeType !== "image/png" && mimeType !== "image/jpeg")) {
      throw new Error("GLB embedded image format is unsupported");
    }
    const view = bufferViews[viewIndex as number] as Record<string, unknown>;
    const offset = (view.byteOffset as number | undefined) ?? 0;
    const length = view.byteLength as number;
    if (offset + length > binaryLength) throw new Error("GLB embedded image range is invalid");
    const source = new Uint8Array(bytes, binaryOffset + offset, length);
    let dimensions: { width: number; height: number } | null = null;
    if (mimeType === "image/png" && source.length >= 24 &&
        source[0] === 0x89 && source[1] === 0x50 && source[2] === 0x4e && source[3] === 0x47) {
      const png = new DataView(source.buffer, source.byteOffset, source.byteLength);
      dimensions = { width: png.getUint32(16), height: png.getUint32(20) };
    } else if (mimeType === "image/jpeg") {
      dimensions = jpegDimensions(source);
    }
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1 ||
        dimensions.width > 8192 || dimensions.height > 8192) {
      throw new Error("GLB embedded image dimensions are invalid");
    }
    totalPixels += dimensions.width * dimensions.height;
    if (totalPixels > 16_000_000) throw new Error("GLB embedded images are too complex");
  }
}

export async function validateDirectorGlb(
  blob: Blob,
  overrides: Partial<DirectorGlbLimits> = {},
): Promise<{ version: 2; manifest: Record<string, unknown>; bytes: ArrayBuffer }> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (!(blob instanceof Blob) || !ALLOWED_MIME.has(blob.type.toLowerCase())) {
    throw new Error("GLB MIME type is unsupported");
  }
  if (blob.size < 20 || blob.size > limits.maxBlobBytes) {
    throw new Error(`GLB file must contain 20-${limits.maxBlobBytes} bytes`);
  }
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error("GLB header is invalid");
  if (view.getUint32(4, true) !== 2) throw new Error("Only GLB version 2 is supported");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error("GLB declared length is invalid");

  let offset = 12;
  let manifest: Record<string, unknown> | null = null;
  let binaryOffset = 0;
  let binaryLength = 0;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("GLB chunk header is truncated");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || offset + length > bytes.byteLength) throw new Error("GLB chunk length is invalid");
    if (chunkIndex === 0) {
      if (type !== JSON_CHUNK || length < 2 || length > limits.maxJsonBytes) {
        throw new Error("GLB JSON chunk is invalid");
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes, offset, length));
      } catch {
        throw new Error("GLB JSON chunk is not valid UTF-8");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded.replace(/[\u0000\u0020]+$/g, ""));
      } catch {
        throw new Error("GLB JSON chunk is malformed");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("GLB manifest must be an object");
      manifest = parsed as Record<string, unknown>;
      const asset = manifest.asset;
      if (!asset || typeof asset !== "object" || (asset as Record<string, unknown>).version !== "2.0") {
        throw new Error("GLB manifest asset version is unsupported");
      }
    }
    if (chunkIndex === 1 && type === BINARY_CHUNK) {
      binaryOffset = offset;
      binaryLength = length;
    } else if (chunkIndex > 0) {
      throw new Error("GLB chunk structure is unsupported");
    }
    offset += length;
    chunkIndex += 1;
  }
  if (!manifest || offset !== bytes.byteLength) throw new Error("GLB file is incomplete");
  inspectManifest(manifest, limits);
  const buffers = Array.isArray(manifest.buffers) ? manifest.buffers : [];
  const declaredBinaryLength = buffers[0] && typeof buffers[0] === "object"
    ? (buffers[0] as Record<string, unknown>).byteLength as number
    : 0;
  if (declaredBinaryLength > binaryLength) throw new Error("GLB binary chunk is truncated");
  if (Array.isArray(manifest.images) && manifest.images.length) {
    if (!binaryLength) throw new Error("GLB embedded image data is missing");
    validateEmbeddedImages(manifest, bytes, binaryOffset, binaryLength);
  }
  return { version: 2, manifest, bytes };
}
