import { memo, useRef, useState } from "react";
import { Boxes, Image as ImageIcon, Trash2, Upload } from "lucide-react";
import type { AssetItem } from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { useBoardStore } from "@/stores/use-board-store";
import { uploadMedia } from "@/services/storage";
import { deleteAssetBlobIfUnreferenced } from "@/services/asset-lifecycle";

export const CanvasAssetsPanel = memo(function CanvasAssetsPanel() {
  const assets = useBoardStore((state) => state.assets);
  const setAssets = useBoardStore((state) => state.setAssets);
  const flushAssets = useBoardStore((state) => state.flushAssets);
  const insertAsset = useBoardStore((state) => state.insertAsset);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteSidebarAsset = async (assetId: string) => {
    const state = useBoardStore.getState();
    const asset = state.assets.find((item) => item.id === assetId);
    if (!asset) return;
    const nextAssets = state.assets.filter((item) => item.id !== assetId);
    // Clone so LatestWrite/server PUT cannot share a mutated array reference.
    setAssets(structuredClone(nextAssets));
    await flushAssets();
    await deleteAssetBlobIfUnreferenced(
      asset.storageKey,
      useBoardStore.getState().projects,
      useBoardStore.getState().assets,
    );
  };

  const addMedia = async (file: File, kind: "image" | "video") => {
    setBusy(true);
    setError(null);
    try {
      const uploaded = await uploadMedia(file, kind === "image" ? "image" : "media");
      const t = nowIso();
      const item: AssetItem = {
        id: uid("asset"),
        kind,
        title: file.name,
        coverUrl: uploaded.url,
        storageKey: uploaded.storageKey,
        mimeType: uploaded.mimeType,
        tags: [],
        createdAt: t,
        updatedAt: t,
      };
      setAssets([item, ...useBoardStore.getState().assets]);
      await flushAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 px-0.5">
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          disabled={busy}
          onClick={() => imageInputRef.current?.click()}
        >
          <Upload size={13} /> 上传图片
        </button>
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          disabled={busy}
          onClick={() => videoInputRef.current?.click()}
        >
          <Upload size={13} /> 上传视频
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label="上传侧栏图片素材"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void addMedia(file, "image");
          }}
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          aria-label="上传侧栏视频素材"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void addMedia(file, "video");
          }}
        />
      </div>
      {error ? <p className="px-0.5 text-xs text-[var(--ob-danger)]">{error}</p> : null}
      {!assets.length ? (
        <div className="ob-empty m-1 border-0 bg-transparent px-2 py-6">
          <span className="ob-empty-icon" aria-hidden>
            <Boxes size={16} />
          </span>
          <p className="ob-empty-title">暂无素材</p>
          <p className="ob-empty-desc">可上传图片/视频，或从素材页添加后在此插入画布。</p>
        </div>
      ) : (
        <ul role="list" aria-label="侧栏素材" className="grid grid-cols-2 gap-2">
          {assets.map((asset) => (
            <li key={asset.id} className="group relative min-h-24 overflow-hidden rounded-xl border border-[var(--ob-line)] bg-[var(--ob-canvas)] shadow-[var(--ob-elev-1)]">
              {asset.kind === "image" && asset.coverUrl ? (
                <img src={asset.coverUrl} alt={asset.title} className="h-24 w-full object-cover" />
              ) : asset.kind === "video" && asset.coverUrl ? (
                <video src={asset.coverUrl} aria-label={asset.title} muted preload="metadata" className="h-24 w-full bg-black object-contain" />
              ) : asset.kind === "audio" && asset.coverUrl ? (
                <div className="grid h-24 place-items-center px-2 text-xs text-[var(--ob-muted)]">音频</div>
              ) : (
                <div className="flex h-24 flex-col p-2">
                  <div data-asset-title className="truncate text-[11px] font-medium text-[var(--ob-ink)]" title={asset.title}>{asset.title}</div>
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-[var(--ob-muted)]">{asset.content || "文本素材"}</p>
                </div>
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
                  }).catch((cause) =>
                    setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                <ImageIcon size={18} />
              </button>
              <button
                type="button"
                aria-label={`删除素材 ${asset.title}`}
                title="删除素材"
                className="absolute right-1 top-1 z-10 grid h-7 w-7 place-items-center rounded-md bg-[var(--ob-panel)] text-[var(--ob-danger)] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus:opacity-100"
                onClick={() => {
                  if (!confirm(`删除素材“${asset.title}”？`)) return;
                  void deleteSidebarAsset(asset.id).catch((cause) =>
                    setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
