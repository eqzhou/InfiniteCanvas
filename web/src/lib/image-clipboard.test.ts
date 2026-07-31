import { describe, expect, mock, test } from "bun:test";
import { copyImageSourceToClipboard, writeImageBlobToClipboard } from "./image-clipboard";

describe("image clipboard", () => {
  test("writes a PNG blob to the system clipboard", async () => {
    const write = mock(async () => undefined);
    const ClipboardItemCtor = class {
      constructor(readonly items: Record<string, Blob>) {}
    };
    const png = new Blob(["png"], { type: "image/png" });

    await writeImageBlobToClipboard(png, {
      clipboard: { write },
      ClipboardItemCtor,
      convertToPng: mock(async () => {
        throw new Error("PNG should not be converted");
      }),
    });

    expect(write).toHaveBeenCalledTimes(1);
    const [item] = write.mock.calls[0]![0] as InstanceType<typeof ClipboardItemCtor>[];
    expect(await item.items["image/png"]).toBe(png);
  });

  test("converts non-PNG images before writing", async () => {
    const write = mock(async () => undefined);
    const ClipboardItemCtor = class {
      constructor(readonly items: Record<string, Blob>) {}
    };
    const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });
    const png = new Blob(["png"], { type: "image/png" });
    const convertToPng = mock(async () => png);

    await writeImageBlobToClipboard(jpeg, {
      clipboard: { write },
      ClipboardItemCtor,
      convertToPng,
    });

    expect(convertToPng).toHaveBeenCalledWith(jpeg);
    const [item] = write.mock.calls[0]![0] as InstanceType<typeof ClipboardItemCtor>[];
    expect(await item.items["image/png"]).toBe(png);
  });

  test("reports when image clipboard access is unavailable", async () => {
    await expect(writeImageBlobToClipboard(
      new Blob(["png"], { type: "image/png" }),
      { clipboard: undefined, ClipboardItemCtor: undefined, convertToPng: mock(async (blob) => blob) },
    )).rejects.toThrow("当前浏览器不支持复制图片");
  });

  test("starts the clipboard write before an asynchronous image becomes ready", async () => {
    let resolveImage!: (blob: Blob) => void;
    const pendingImage = new Promise<Blob>((resolve) => { resolveImage = resolve; });
    const events: string[] = [];
    const write = mock(async (items: Array<{ items: Record<string, Promise<Blob>> }>) => {
      events.push("write");
      await items[0]!.items["image/png"];
    });
    const ClipboardItemCtor = class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    };

    const result = writeImageBlobToClipboard(pendingImage, {
      clipboard: { write },
      ClipboardItemCtor,
      convertToPng: mock(async (blob) => blob),
    });
    expect(events).toEqual(["write"]);

    resolveImage(new Blob(["png"], { type: "image/png" }));
    await result;
  });

  test("rejects oversized image sources before decoding", async () => {
    const tooLarge = new Blob([new Uint8Array(50 * 1024 * 1024 + 1)], { type: "image/jpeg" });
    await expect(writeImageBlobToClipboard(Promise.resolve(tooLarge), {
      clipboard: { write: mock(async (items) => {
        await (items[0] as { items: Record<string, Promise<Blob>> }).items["image/png"];
      }) },
      ClipboardItemCtor: class { constructor(readonly items: Record<string, Promise<Blob>>) {} },
      convertToPng: mock(async (blob) => blob),
    })).rejects.toThrow("图片过大");
  });

  test("copies a blob URL source and validates its MIME type", async () => {
    const source = URL.createObjectURL(new Blob(["png"], { type: "image/png" }));
    let copied: Blob | undefined;
    try {
      await copyImageSourceToClipboard(source, {
        clipboard: { write: async (items) => {
          copied = await (items[0] as { items: Record<string, Promise<Blob>> }).items["image/png"];
        } },
        ClipboardItemCtor: class { constructor(readonly items: Record<string, Promise<Blob>>) {} },
        convertToPng: mock(async (blob) => blob),
      });
    } finally {
      URL.revokeObjectURL(source);
    }
    expect(copied?.type).toBe("image/png");
  });

  test("rejects a source that is not an image", async () => {
    await expect(copyImageSourceToClipboard("data:text/plain,hello", {
      clipboard: { write: async (items) => {
        await (items[0] as { items: Record<string, Promise<Blob>> }).items["image/png"];
      } },
      ClipboardItemCtor: class { constructor(readonly items: Record<string, Promise<Blob>>) {} },
      convertToPng: mock(async (blob) => blob),
    })).rejects.toThrow("不是可复制的图片");
  });

  test("reports missing and unreadable image sources", async () => {
    const dependencies = {
      clipboard: { write: async (items: unknown[]) => {
        await (items[0] as { items: Record<string, Promise<Blob>> }).items["image/png"];
      } },
      ClipboardItemCtor: class { constructor(readonly items: Record<string, Promise<Blob>>) {} },
      convertToPng: mock(async (blob: Blob) => blob),
    };
    await expect(copyImageSourceToClipboard(null, dependencies))
      .rejects.toThrow("没有可复制的图片");

    const priorFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => new Response("missing", { status: 404 }));
    try {
      await expect(copyImageSourceToClipboard("https://example.invalid/missing.png", dependencies))
        .rejects.toThrow("读取图片失败（404）");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
