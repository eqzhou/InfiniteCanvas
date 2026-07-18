import type { AssetItem, BoardProject } from "@/types/board";
import { collectGenerationStorageKeys } from "@/services/generation-jobs";
import { collectStorageKeys, deleteBlob } from "@/services/storage";

export async function deleteAssetBlobIfUnreferenced(
  storageKey: string | undefined,
  projects: BoardProject[],
  remainingAssets: AssetItem[],
): Promise<void> {
  if (!storageKey) return;
  const referenced = collectStorageKeys(projects, remainingAssets);
  for (const key of await collectGenerationStorageKeys()) referenced.add(key);
  if (referenced.has(storageKey)) return;
  await deleteBlob(storageKey.startsWith("media:") ? "media" : "image", storageKey);
}
