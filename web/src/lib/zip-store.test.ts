import { describe, expect, test } from "bun:test";
import { createZipStore, readZipStore, type ZipStoreInput } from "./zip-store";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function overwriteUint32(source: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = source.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

function findSignature(source: Uint8Array, signature: number): number {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  for (let offset = 0; offset <= source.length - 4; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error("signature not found in test archive");
}

describe("ZIP STORE", () => {
  test("round trips UTF-8 names and Blob-compatible payloads", async () => {
    const entries: ZipStoreInput[] = [
      { name: "board.json", data: "{\"name\":\"画布\"}" },
      { name: "媒体/像素.bin", data: new Uint8Array([0, 1, 127, 255]) },
      { name: "notes/readme.txt", data: new Blob(["hello"]) },
    ];

    const archive = await createZipStore(entries);
    expect(archive.type).toBe("application/zip");

    const result = await readZipStore(archive);
    expect([...result.keys()]).toEqual(entries.map((entry) => entry.name));
    expect(decoder.decode(result.get("board.json"))).toBe("{\"name\":\"画布\"}");
    expect([...result.get("媒体/像素.bin")!]).toEqual([0, 1, 127, 255]);
    expect(decoder.decode(result.get("notes/readme.txt"))).toBe("hello");
  });

  test("writes method 0 entries and the UTF-8 general-purpose flag", async () => {
    const archive = await bytes(await createZipStore([{ name: "数据.txt", data: "ok" }]));
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0);
  });

  test("accepts unflagged ASCII names but rejects ambiguous non-ASCII names", async () => {
    const ascii = await bytes(await createZipStore([{ name: "board.json", data: "{}" }]));
    const asciiView = new DataView(ascii.buffer);
    asciiView.setUint16(6, 0, true);
    asciiView.setUint16(findSignature(ascii, 0x02014b50) + 8, 0, true);
    expect(decoder.decode((await readZipStore(ascii)).get("board.json"))).toBe("{}");

    const unicode = await bytes(await createZipStore([{ name: "画布.json", data: "{}" }]));
    const unicodeView = new DataView(unicode.buffer);
    unicodeView.setUint16(6, 0, true);
    unicodeView.setUint16(findSignature(unicode, 0x02014b50) + 8, 0, true);
    await expect(readZipStore(unicode)).rejects.toThrow(/UTF-8/i);
  });

  test("rejects duplicate and unsafe writer paths", async () => {
    await expect(createZipStore([
      { name: "same.txt", data: "one" },
      { name: "same.txt", data: "two" },
    ])).rejects.toThrow(/duplicate/i);

    for (const name of ["../secret", "a/../../secret", "/root", "C:/secret", "a\\secret", "a//b", "./a", "a\0b"]) {
      await expect(createZipStore([{ name, data: "x" }])).rejects.toThrow(/path|name/i);
    }
  });

  test("rejects duplicate and unsafe reader entries", async () => {
    const duplicate = await bytes(await createZipStore([
      { name: "first.txt", data: "a" },
      { name: "other.txt", data: "b" },
    ]));
    const central = findSignature(duplicate, 0x02014b50);
    const secondCentral = central + 46 + "first.txt".length;
    duplicate.set(encoder.encode("first.txt"), secondCentral + 46);
    await expect(readZipStore(duplicate)).rejects.toThrow(/duplicate/i);

    const unsafe = await bytes(await createZipStore([{ name: "aa.txt", data: "x" }]));
    unsafe.set(encoder.encode("../x.."), 30);
    await expect(readZipStore(unsafe)).rejects.toThrow(/path|name/i);
  });

  test("rejects truncation and malformed central-directory offsets", async () => {
    const archive = await bytes(await createZipStore([{ name: "file.txt", data: "payload" }]));
    await expect(readZipStore(archive.slice(0, -1))).rejects.toThrow(/ZIP|truncated|directory/i);

    const badOffset = overwriteUint32(archive, archive.length - 6, 0xfffffff0);
    await expect(readZipStore(badOffset)).rejects.toThrow(/directory|bounds|offset/i);
  });

  test("rejects payload corruption through CRC32 verification", async () => {
    const archive = await bytes(await createZipStore([{ name: "file.txt", data: "payload" }]));
    const nameLength = new DataView(archive.buffer).getUint16(26, true);
    archive[30 + nameLength] ^= 0xff;
    await expect(readZipStore(archive)).rejects.toThrow(/CRC/i);
  });

  test("rejects writer and reader resource limit violations", async () => {
    await expect(createZipStore([{ name: "large.bin", data: new Uint8Array(5) }], {
      maxEntryBytes: 4,
    })).rejects.toThrow(/limit/i);
    await expect(createZipStore([
      { name: "a", data: "123" },
      { name: "b", data: "456" },
    ], { maxTotalBytes: 5 })).rejects.toThrow(/limit/i);

    const archive = await createZipStore([
      { name: "a", data: "123" },
      { name: "b", data: "456" },
    ]);
    await expect(readZipStore(archive, { maxEntries: 1 })).rejects.toThrow(/limit/i);
    await expect(readZipStore(archive, { maxEntryBytes: 2 })).rejects.toThrow(/limit/i);
    await expect(readZipStore(archive, { maxTotalBytes: 5 })).rejects.toThrow(/limit/i);
    await expect(readZipStore(archive, { maxArchiveBytes: 10 })).rejects.toThrow(/limit/i);
  });
});
