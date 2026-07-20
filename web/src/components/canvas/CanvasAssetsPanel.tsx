import { memo } from "react";
import { Boxes, Image as ImageIcon, Trash2 } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { deleteAssetBlobIfUnreferenced } from "@/services/asset-lifecycle";

export const CanvasAssetsPanel = memo(function CanvasAssetsPanel() {
  const assets = useBoardStore((state) => state.assets);
  const setAssets = useBoardStore((state) => state.setAssets);
  const flushAssets = useBoardStore((state) => state.flushAssets);
  const insertAsset = useBoardStore((state) => state.insertAsset);

  const deleteSidebarAsset = async (assetId: string) => {
    const state = useBoardStore.getState();
    const asset = state.assets.find((item) => item.id === assetId);
    if (!asset) return;
    const nextAssets = state.assets.filter((item) => item.id !== assetId);
    setAssets(nextAssets);
    await flushAssets();
    await deleteAssetBlobIfUnreferenced(asset.storageKey, state.projects, nextAssets);
  };

  if (!assets.length) {
    return (
      <div className="grid place-items-center gap-2 p-6 text-center text-sm text-[var(--ob-muted)]">
        <Boxes size={22} />
        <span>暂无素材</span>
      </div>
    );
  }

  return (
    <ul role="list" aria-label="侧栏素材" className="grid grid-cols-2 gap-2">
      {assets.map((asset) => (
        <li key={asset.id} className="group relative min-h-24 overflow-hidden rounded-md border border-[var(--ob-line)] bg-[var(--ob-canvas)]">
          {asset.kind === "image" && asset.coverUrl ? (
            <img src={asset.coverUrl} alt={asset.title} className="h-24 w-full object-cover" />
          ) : asset.kind === "video" && asset.coverUrl ? (
            <video src={asset.coverUrl} aria-label={asset.title} muted preload="metadata" className="h-24 w-full bg-black object-contain" />
          ) : asset.kind === "audio" && asset.coverUrl ? (
            <div className="grid h-24 place-items-center px-2 text-xs text-[var(--ob-muted)]">音频</div>
          ) : (
            <p className="line-clamp-4 p-2 text-xs leading-relaxed">{asset.content || asset.title}</p>
          )}
          <button
            type="button"
            aria-label={`插入素材 ${asset.title}`}
            title="插入画布"
            className="absolute inset-0 grid place-items-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
            onClick={() => {
              const active = useBoardStore.getState().getActive();
              if (!active) return;
              void insertAsset(asset.id, {
                x: (window.innerWidth / 2 - active.viewport.x) / active.viewport.k,
                y: (window.innerHeight / 2 - active.viewport.y) / active.viewport.k,
              });
            }}
          >
            <ImageIcon size={18} />
          </button>
          <button
            type="button"
            aria-label={`删除素材 ${asset.title}`}
            title="删除素材"
            className="absolute right-1 top-1 z-10 grid h-7 w-7 place-items-center rounded-sm bg-[var(--ob-panel)] text-[var(--ob-danger)] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus:opacity-100"
            onClick={() => {
              if (!confirm(`删除素材“${asset.title}”？`)) return;
              void deleteSidebarAsset(asset.id).catch((error) =>
                alert(error instanceof Error ? error.message : String(error)));
            }}
          >
            <Trash2 size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
});
