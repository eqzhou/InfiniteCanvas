type ClipboardWriter = {
  write(items: unknown[]): Promise<void>;
};

type ClipboardItemConstructor = new (items: Record<string, Blob | Promise<Blob>>) => unknown;

type ImageClipboardDependencies = {
  clipboard?: ClipboardWriter;
  ClipboardItemCtor?: ClipboardItemConstructor;
  convertToPng: (blob: Blob) => Promise<Blob>;
};

const MAX_CLIPBOARD_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_CLIPBOARD_IMAGE_PIXELS = 100_000_000;

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    throw new Error("当前环境无法转换图片格式");
  }
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width < 1 || bitmap.height < 1 ||
      bitmap.width * bitmap.height > MAX_CLIPBOARD_IMAGE_PIXELS) {
      throw new Error("图片尺寸过大，无法复制");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法转换图片格式");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) => png ? resolve(png) : reject(new Error("图片转换失败")),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}

function browserDependencies(): ImageClipboardDependencies {
  return {
    clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
    ClipboardItemCtor: typeof ClipboardItem === "undefined"
      ? undefined
      : ClipboardItem as unknown as ClipboardItemConstructor,
    convertToPng: convertImageBlobToPng,
  };
}

export async function writeImageBlobToClipboard(
  source: Blob | Promise<Blob>,
  dependencies: ImageClipboardDependencies = browserDependencies(),
): Promise<void> {
  if (!dependencies.clipboard?.write || !dependencies.ClipboardItemCtor) {
    throw new Error("当前浏览器不支持复制图片");
  }
  const png = Promise.resolve(source).then(async (blob) => {
    if (!blob.type.startsWith("image/")) {
      throw new Error("当前节点不是可复制的图片");
    }
    if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new Error("图片过大，无法复制");
    }
    return blob.type === "image/png" ? blob : dependencies.convertToPng(blob);
  });
  const item = new dependencies.ClipboardItemCtor({ "image/png": png });
  return dependencies.clipboard.write([item]);
}

export function copyImageSourceToClipboard(
  source: string | Promise<string | null>,
  dependencies: ImageClipboardDependencies = browserDependencies(),
): Promise<void> {
  const blob = Promise.resolve(source).then(async (resolved) => {
    if (!resolved) throw new Error("没有可复制的图片");
    const response = await fetch(resolved);
    if (!response.ok) throw new Error(`读取图片失败（${response.status}）`);
    return response.blob();
  });
  return writeImageBlobToClipboard(blob, dependencies);
}
