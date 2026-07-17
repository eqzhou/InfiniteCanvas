import { uploadMedia } from "@/services/storage";
import type { BoardNode } from "@/types/board";
import { createNode } from "@/lib/defaults";
import { normalizeSplitGuides, splitSegments } from "@/lib/image-split";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("导出失败"))), "image/png");
  });
}

/** Local upscale via canvas (nearest/smooth). Not a cloud upscaler. */
export async function upscaleImage(
  sourceUrl: string,
  scale: number,
): Promise<{ url: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string }> {
  const img = await loadImage(sourceUrl);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas);
  return uploadMedia(blob, "image");
}

/** Split image into rows x cols grid nodes. */
export async function splitImageGrid(
  source: BoardNode,
  rows: number,
  cols: number,
): Promise<BoardNode[]> {
  return splitImageByGuides(
    source,
    Array.from({ length: Math.max(0, cols - 1) }, (_, index) => (index + 1) / cols),
    Array.from({ length: Math.max(0, rows - 1) }, (_, index) => (index + 1) / rows),
  );
}

export async function splitImageByGuides(
  source: BoardNode,
  verticalGuides: number[],
  horizontalGuides: number[],
): Promise<BoardNode[]> {
  if (!source.metadata.content) throw new Error("无图片");
  const img = await loadImage(source.metadata.content);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const vertical = normalizeSplitGuides(verticalGuides);
  const horizontal = normalizeSplitGuides(horizontalGuides);
  const columns = splitSegments(vertical);
  const rows = splitSegments(horizontal);
  const out: BoardNode[] = [];
  let index = 0;
  for (const [r, row] of rows.entries()) {
    for (const [c, column] of columns.entries()) {
      const sx = Math.round(column.start * w);
      const sy = Math.round(row.start * h);
      const ex = Math.round(column.end * w);
      const ey = Math.round(row.end * h);
      const cellW = Math.max(1, ex - sx);
      const cellH = Math.max(1, ey - sy);
      const canvas = document.createElement("canvas");
      canvas.width = cellW;
      canvas.height = cellH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unavailable");
      ctx.drawImage(
        img,
        sx,
        sy,
        cellW,
        cellH,
        0,
        0,
        cellW,
        cellH,
      );
      const blob = await canvasToBlob(canvas);
      const uploaded = await uploadMedia(blob, "image");
      out.push(
        createNode(
          "image",
          {
            x: source.position.x + source.width + 48 + c * 24,
            y: source.position.y + r * 24 + index,
          },
          {
            title: `${source.title} · ${r + 1}x${c + 1}`,
            width: Math.min(240, cellW),
            height: Math.min(240, cellH),
            metadata: {
              content: uploaded.url,
              storageKey: uploaded.storageKey,
              naturalWidth: uploaded.width,
              naturalHeight: uploaded.height,
              bytes: uploaded.bytes,
              mimeType: uploaded.mimeType,
              status: "success",
              derivedFromId: source.id,
              splitIndex: index,
              splitCount: rows.length * columns.length,
              splitVertical: vertical,
              splitHorizontal: horizontal,
              transformOperation: "split",
            },
          },
        ),
      );
      index += 1;
    }
  }
  return out;
}

/**
 * Apply a simple rectangular soft mask / vignette-like alpha mask region.
 * mask: normalized 0-1 rect kept opaque; outside becomes transparent/white fill.
 */
export async function applyRectMask(
  sourceUrl: string,
  mask: { x: number; y: number; w: number; h: number },
  mode: "keep" | "remove" = "keep",
): Promise<{ url: string; storageKey: string; width: number; height: number; bytes: number; mimeType: string }> {
  const img = await loadImage(sourceUrl);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0);
  const mx = Math.round(mask.x * canvas.width);
  const my = Math.round(mask.y * canvas.height);
  const mw = Math.round(mask.w * canvas.width);
  const mh = Math.round(mask.h * canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const inside = x >= mx && x < mx + mw && y >= my && y < my + mh;
      const clear = mode === "keep" ? !inside : inside;
      if (clear) {
        const i = (y * canvas.width + x) * 4;
        data[i + 3] = 0;
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvasToBlob(canvas);
  return uploadMedia(blob, "image");
}
