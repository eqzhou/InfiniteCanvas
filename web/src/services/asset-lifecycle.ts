import type { AssetItem, BoardProject } from "@/types/board";
import { collectGenerationStorageKeys } from "@/services/generation-jobs";
import { collectStorageKeys, deleteBlob } from "@/services/storage";
import { useBoardStore } from "@/stores/use-board-store";

export async function deleteAssetBlobIfUnreferenced(
  storageKey: string | undefined,
  projects: BoardProject[],
  remainingAssets: AssetItem[],
): Promise<void> {
  if (!storageKey) return;
  const store = useBoardStore.getState();
  if (store.projectsState !== "loaded") {
    await store.loadProjectsOnDemand();
  }
  const latest = useBoardStore.getState();
  if (latest.projectsState !== "loaded") return;
  const referenced = collectStorageKeys(
    latest.projects.length ? latest.projects : projects,
    remainingAssets,
  );
  for (const key of await collectGenerationStorageKeys()) referenced.add(key);
  if (referenced.has(storageKey)) return;
  await deleteBlob(storageKey.startsWith("media:") ? "media" : "image", storageKey);
}
