export type ZipStoreData = string | Blob | ArrayBuffer | Uint8Array;

export interface ZipStoreInput {
  name: string;
  data: ZipStoreData;
}

export interface ZipStoreLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxNameBytes: number;
}

export type ZipStoreOptions = Partial<ZipStoreLimits>;

const DEFAULT_LIMITS: ZipStoreLimits = {
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxNameBytes: 1_024,
};

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface PreparedEntry {
  name: string;
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

function getLimits(options: ZipStoreOptions): ZipStoreLimits {
  const limits = { ...DEFAULT_LIMITS, ...options };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`ZIP ${name} limit must be a non-negative safe integer`);
    }
  }
  return limits;
}

function validateName(name: string, nameBytes: Uint8Array, maxNameBytes: number): void {
  if (name.length === 0 || nameBytes.length === 0 || nameBytes.length > maxNameBytes || nameBytes.length > UINT16_MAX) {
    throw new Error("ZIP entry name exceeds the configured path limit or is empty");
  }
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:\//.test(name)) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
}

async function dataBytes(data: ZipStoreData): Promise<Uint8Array> {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof Uint8Array) return data.slice();
  return new Uint8Array(data.slice(0));
}

function putUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function putUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

function addChecked(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > UINT32_MAX) {
    throw new Error(`ZIP ${label} exceeds the standard 32-bit format limit`);
  }
  return result;
}

export async function createZipStore(
  inputs: readonly ZipStoreInput[],
  options: ZipStoreOptions = {},
): Promise<Blob> {
  const limits = getLimits(options);
  if (inputs.length > limits.maxEntries || inputs.length > UINT16_MAX) {
    throw new Error("ZIP entry count exceeds the configured limit");
  }

  const names = new Set<string>();
  const entries: PreparedEntry[] = [];
  let totalDataBytes = 0;
  let localBytes = 0;

  for (const input of inputs) {
    const nameBytes = encoder.encode(input.name);
    validateName(input.name, nameBytes, limits.maxNameBytes);
    if (names.has(input.name)) throw new Error(`Duplicate ZIP entry: ${input.name}`);
    names.add(input.name);

    const data = await dataBytes(input.data);
    if (data.length > limits.maxEntryBytes) {
      throw new Error(`ZIP entry exceeds the configured size limit: ${input.name}`);
    }
    totalDataBytes += data.length;
    if (totalDataBytes > limits.maxTotalBytes) {
      throw new Error("ZIP contents exceed the configured total size limit");
    }

    const offset = localBytes;
    localBytes = addChecked(localBytes, 30 + nameBytes.length + data.length, "archive");
    entries.push({ name: input.name, nameBytes, data, crc: crc32(data), offset });
  }

  let centralBytes = 0;
  for (const entry of entries) {
    centralBytes = addChecked(centralBytes, 46 + entry.nameBytes.length, "central directory");
  }
  const archiveBytes = addChecked(addChecked(localBytes, centralBytes, "archive"), 22, "archive");
  if (archiveBytes > limits.maxArchiveBytes) {
    throw new Error("ZIP archive exceeds the configured size limit");
  }

  const output = new Uint8Array(archiveBytes);
  const view = new DataView(output.buffer);
  let cursor = 0;
  for (const entry of entries) {
    putUint32(view, cursor, LOCAL_SIGNATURE);
    putUint16(view, cursor + 4, 20);
    putUint16(view, cursor + 6, UTF8_FLAG);
    putUint16(view, cursor + 8, STORE_METHOD);
    putUint16(view, cursor + 10, 0);
    putUint16(view, cursor + 12, 0x21);
    putUint32(view, cursor + 14, entry.crc);
    putUint32(view, cursor + 18, entry.data.length);
    putUint32(view, cursor + 22, entry.data.length);
    putUint16(view, cursor + 26, entry.nameBytes.length);
    putUint16(view, cursor + 28, 0);
    output.set(entry.nameBytes, cursor + 30);
    output.set(entry.data, cursor + 30 + entry.nameBytes.length);
    cursor += 30 + entry.nameBytes.length + entry.data.length;
  }

  const centralOffset = cursor;
  for (const entry of entries) {
    putUint32(view, cursor, CENTRAL_SIGNATURE);
    putUint16(view, cursor + 4, 20);
    putUint16(view, cursor + 6, 20);
    putUint16(view, cursor + 8, UTF8_FLAG);
    putUint16(view, cursor + 10, STORE_METHOD);
    putUint16(view, cursor + 12, 0);
    putUint16(view, cursor + 14, 0x21);
    putUint32(view, cursor + 16, entry.crc);
    putUint32(view, cursor + 20, entry.data.length);
    putUint32(view, cursor + 24, entry.data.length);
    putUint16(view, cursor + 28, entry.nameBytes.length);
    putUint16(view, cursor + 30, 0);
    putUint16(view, cursor + 32, 0);
    putUint16(view, cursor + 34, 0);
    putUint16(view, cursor + 36, 0);
    putUint32(view, cursor + 38, 0);
    putUint32(view, cursor + 42, entry.offset);
    output.set(entry.nameBytes, cursor + 46);
    cursor += 46 + entry.nameBytes.length;
  }

  putUint32(view, cursor, END_SIGNATURE);
  putUint16(view, cursor + 4, 0);
  putUint16(view, cursor + 6, 0);
  putUint16(view, cursor + 8, entries.length);
  putUint16(view, cursor + 10, entries.length);
  putUint32(view, cursor + 12, centralBytes);
  putUint32(view, cursor + 16, centralOffset);
  putUint16(view, cursor + 20, 0);
  return new Blob([output.buffer], { type: "application/zip" });
}

type ZipSource = Blob | ArrayBuffer | Uint8Array;

async function sourceBytes(source: ZipSource, maxArchiveBytes: number): Promise<Uint8Array> {
  const size = source instanceof Blob ? source.size : source.byteLength;
  if (size > maxArchiveBytes) throw new Error("ZIP archive exceeds the configured size limit");
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  if (source instanceof Uint8Array) return source.slice();
  return new Uint8Array(source.slice(0));
}

function requireRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`Truncated ZIP ${label}`);
  }
}

function findEnd(bytes: Uint8Array, view: DataView): number {
  if (bytes.length < 22) throw new Error("Truncated ZIP end record");
  const earliest = Math.max(0, bytes.length - 22 - UINT16_MAX);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) !== END_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("ZIP end record is missing or truncated");
}

function decodeName(nameBytes: Uint8Array): string {
  try {
    return decoder.decode(nameBytes);
  } catch {
    throw new Error("ZIP entry name is not valid UTF-8");
  }
}

export async function readZipStore(
  source: ZipSource,
  options: ZipStoreOptions = {},
): Promise<Map<string, Uint8Array>> {
  const limits = getLimits(options);
  const bytes = await sourceBytes(source, limits.maxArchiveBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEnd(bytes, view);

  if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  const diskEntries = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  if (diskEntries !== entryCount) throw new Error("Inconsistent ZIP entry count");
  if (entryCount > limits.maxEntries) throw new Error("ZIP entry count exceeds the configured limit");

  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP central directory offset or size is outside valid bounds");
  }
  requireRange(bytes, centralOffset, centralSize, "central directory");

  const result = new Map<string, Uint8Array>();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(bytes, cursor, 46, "central directory entry");
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error("Invalid ZIP central directory signature");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const centralEntryLength = 46 + nameLength + extraLength + commentLength;
    requireRange(bytes, cursor, centralEntryLength, "central directory entry");

    if ((flags & 1) !== 0) throw new Error("Encrypted ZIP entries are not supported");
    if (method !== STORE_METHOD) throw new Error("Only ZIP STORE method 0 is supported");
    if (diskStart !== 0) throw new Error("Multi-disk ZIP entries are not supported");
    if (compressedSize !== uncompressedSize) throw new Error("Invalid ZIP STORE entry sizes");
    if (uncompressedSize > limits.maxEntryBytes) throw new Error("ZIP entry exceeds the configured size limit");

    const centralNameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if ((flags & UTF8_FLAG) === 0 && centralNameBytes.some((byte) => byte > 0x7f)) {
      throw new Error("Non-ASCII ZIP entry names must be marked as UTF-8");
    }
    const name = decodeName(centralNameBytes);
    validateName(name, centralNameBytes, limits.maxNameBytes);
    if (result.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);

    requireRange(bytes, localOffset, 30, "local header");
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error("Invalid ZIP local header signature");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localHeaderLength = 30 + localNameLength + localExtraLength;
    requireRange(bytes, localOffset, localHeaderLength, "local header");
    if (localFlags !== flags || localMethod !== method || localCrc !== expectedCrc
      || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
      throw new Error(`ZIP local header does not match central directory for ${name}`);
    }
    const localName = decodeName(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) throw new Error(`ZIP local entry name does not match central directory for ${name}`);

    const dataOffset = localOffset + localHeaderLength;
    requireRange(bytes, dataOffset, compressedSize, `entry data for ${name}`);
    if (dataOffset + compressedSize > centralOffset) throw new Error(`ZIP entry data overlaps the central directory: ${name}`);
    const data = bytes.slice(dataOffset, dataOffset + compressedSize);
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP CRC32 mismatch for ${name}`);
    totalBytes += data.length;
    if (totalBytes > limits.maxTotalBytes) throw new Error("ZIP contents exceed the configured total size limit");
    result.set(name, data);
    cursor += centralEntryLength;
  }
  if (cursor !== endOffset) throw new Error("ZIP central directory size does not match its entries");
  return result;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = UINT32_MAX;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ UINT32_MAX) >>> 0;
}
