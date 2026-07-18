import type { BoardNode } from "@/types/board";
import { filenameForMimeType } from "@/lib/download-filename";
import { createZipStore, type ZipStoreInput } from "@/lib/zip-store";
import { getBlob } from "@/services/storage";

type BlobLoader = (node: BoardNode) => Promise<Blob | undefined>;

function safeStem(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 96);
  return normalized || fallback;
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  while (used.has(`${stem}-${index}${extension}`)) index += 1;
  const result = `${stem}-${index}${extension}`;
  used.add(result);
  return result;
}

async function defaultBlobLoader(node: BoardNode): Promise<Blob | undefined> {
  if (!node.metadata.storageKey) return undefined;
  return getBlob(node.type === "image" ? "image" : "media", node.metadata.storageKey);
}

export async function exportNodeSelection(
  nodes: readonly BoardNode[],
  loadBlob: BlobLoader = defaultBlobLoader,
): Promise<Blob> {
  if (!nodes.length) throw new Error("请选择要导出的画布元素");
  if (nodes.length > 500) throw new Error("单次最多导出 500 个画布元素");

  const entries: ZipStoreInput[] = [];
  const used = new Set<string>();
  for (const node of nodes) {
    const stem = safeStem(node.title, node.id);
    if (node.type === "text") {
      entries.push({
        name: uniqueName(`${stem}.txt`, used),
        data: node.metadata.content ?? "",
      });
      continue;
    }
    if (node.type === "image" || node.type === "video" || node.type === "audio") {
      const blob = await loadBlob(node);
      if (blob) {
        entries.push({
          name: uniqueName(filenameForMimeType(stem, node.metadata.mimeType, node.type === "image" ? "png" : node.type === "video" ? "mp4" : "mp3"), used),
          data: blob,
        });
        continue;
      }
    }
    entries.push({
      name: uniqueName(`${stem}.json`, used),
      data: JSON.stringify(node, null, 2),
    });
  }
  return createZipStore(entries, {
    maxEntries: 500,
    maxEntryBytes: 64 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
    maxArchiveBytes: 128 * 1024 * 1024,
  });
}
