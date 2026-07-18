import {
  cropImageToBlob,
  rotateImageToBlob,
  uploadMedia,
} from "@/services/storage";
import type { BoardNode } from "@/types/board";
import { createNode } from "@/lib/defaults";
import { fitMediaDisplaySize } from "@/lib/geometry";

export async function makeCroppedNode(
  source: BoardNode,
  crop: { x: number; y: number; w: number; h: number },
): Promise<BoardNode> {
  if (!source.metadata.content) throw new Error("无图片");
  const blob = await cropImageToBlob(source.metadata.content, crop);
  const uploaded = await uploadMedia(blob, "image");
  const display = fitMediaDisplaySize(uploaded.width, uploaded.height, 120, 360);
  return createNode(
    "image",
    {
      x: source.position.x + source.width + 48,
      y: source.position.y,
    },
    {
      title: `${source.title} · 裁剪`,
      width: display.width,
      height: display.height,
      metadata: {
        content: uploaded.url,
        storageKey: uploaded.storageKey,
        naturalWidth: uploaded.width,
        naturalHeight: uploaded.height,
        bytes: uploaded.bytes,
        mimeType: uploaded.mimeType,
        status: "success",
      },
    },
  );
}

export async function makeRotatedNode(
  source: BoardNode,
  degrees: number,
): Promise<BoardNode> {
  if (!source.metadata.content) throw new Error("无图片");
  const blob = await rotateImageToBlob(source.metadata.content, degrees);
  const uploaded = await uploadMedia(blob, "image");
  const display = fitMediaDisplaySize(uploaded.width, uploaded.height, 120, 360);
  return createNode(
    "image",
    {
      x: source.position.x + source.width + 48,
      y: source.position.y + 24,
    },
    {
      title: `${source.title} · ${degrees}°`,
      width: display.width,
      height: display.height,
      metadata: {
        content: uploaded.url,
        storageKey: uploaded.storageKey,
        naturalWidth: uploaded.width,
        naturalHeight: uploaded.height,
        bytes: uploaded.bytes,
        mimeType: uploaded.mimeType,
        status: "success",
      },
    },
  );
}
