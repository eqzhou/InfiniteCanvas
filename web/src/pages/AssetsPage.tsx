import { useEffect, useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import type { AssetItem } from "@/types/board";
import { nowIso, uid } from "@/lib/id";
import { collectStorageKeys, deleteBlob, downloadStorageKey, uploadMedia } from "@/services/storage";
import { AssetEditorDialog, type AssetEditorValues } from "@/components/assets/AssetEditorDialog";

export function AssetsPage() {
  const assets = useBoardStore((s) => s.assets);
  const setAssets = useBoardStore((s) => s.setAssets);
  const insertAsset = useBoardStore((s) => s.insertAsset);
  const active = useBoardStore((s) => s.getActive());
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "text" | "image">("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const pageSize = 12;

  const filtered = useMemo(() => {
    return assets.filter((a) => {
      if (kind !== "all" && a.kind !== kind) return false;
      if (!q.trim()) return true;
      const s = q.toLowerCase();
      return (
        a.title.toLowerCase().includes(s) ||
        a.tags.some((t) => t.toLowerCase().includes(s)) ||
        (a.content ?? "").toLowerCase().includes(s) ||
        (a.notes ?? "").toLowerCase().includes(s) ||
        (a.source ?? "").toLowerCase().includes(s)
      );
    });
  }, [assets, kind, q]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const addText = () => {
    const title = window.prompt("素材标题", "文本素材");
    if (!title) return;
    const content = window.prompt("内容", "") ?? "";
    const t = nowIso();
    const item: AssetItem = {
      id: uid("asset"),
      kind: "text",
      title,
      content,
      tags: [],
      createdAt: t,
      updatedAt: t,
    };
    setAssets([item, ...useBoardStore.getState().assets]);
  };

  const addImage = async (file: File) => {
    const uploaded = await uploadMedia(file, "image");
    const t = nowIso();
    const item: AssetItem = {
      id: uid("asset"),
      kind: "image",
      title: file.name,
      coverUrl: uploaded.url,
      storageKey: uploaded.storageKey,
      mimeType: uploaded.mimeType,
      tags: [],
      createdAt: t,
      updatedAt: t,
    };
    setAssets([item, ...useBoardStore.getState().assets]);
  };

  const removeOrphanedBlob = async (storageKey: string | undefined, nextAssets: AssetItem[]) => {
    if (!storageKey) return;
    const keys = collectStorageKeys(useBoardStore.getState().projects, nextAssets);
    if (!keys.has(storageKey)) {
      await deleteBlob(storageKey.startsWith("media:") ? "media" : "image", storageKey);
    }
  };

  const saveAsset = async (values: AssetEditorValues) => {
    if (!editing) return;
    const replacement = values.replacement
      ? await uploadMedia(values.replacement, "image")
      : null;
    const latestAssets = useBoardStore.getState().assets;
    const nextAssets = latestAssets.map((asset) =>
      asset.id === editing.id
        ? {
            ...asset,
            title: values.title,
            tags: [...values.tags],
            source: values.source || undefined,
            notes: values.notes || undefined,
            content: asset.kind === "text" ? values.content : asset.content,
            coverUrl: replacement?.url ?? asset.coverUrl,
            storageKey: replacement?.storageKey ?? asset.storageKey,
            mimeType: replacement?.mimeType ?? asset.mimeType,
            updatedAt: nowIso(),
          }
        : asset,
    );
    setAssets(nextAssets);
    if (replacement) await removeOrphanedBlob(editing.storageKey, nextAssets);
    setEditing(null);
  };

  return (
    <div className="mx-auto h-full max-w-6xl overflow-auto p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">我的素材</h1>
        <input
          className="w-full rounded-md border border-[var(--ob-line)] bg-transparent px-3 py-1.5 text-sm sm:ml-auto sm:w-auto"
          placeholder="搜索…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="all">全部</option>
          <option value="text">文本</option>
          <option value="image">图片</option>
        </select>
        <button
          type="button"
          className="rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm"
          onClick={addText}
        >
          新增文本
        </button>
        <label className="cursor-pointer rounded-md border border-[var(--ob-line)] px-3 py-1.5 text-sm">
          上传图片
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void addImage(f);
              e.currentTarget.value = "";
            }}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pageItems.map((a) => (
          <article
            key={a.id}
            className="rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-3 shadow-[var(--ob-shadow)]"
          >
            {a.kind === "image" && a.coverUrl ? (
              <img
                src={a.coverUrl}
                alt={a.title}
                className="mb-2 h-40 w-full rounded object-cover"
              />
            ) : null}
            <h3 className="font-medium">{a.title}</h3>
            {a.source ? <p className="truncate text-xs text-[var(--ob-muted)]">{a.source}</p> : null}
            <p className="mt-1 line-clamp-3 text-sm text-[var(--ob-muted)]">
              {a.kind === "text" ? a.content : a.mimeType}
            </p>
            <div className="mt-3 flex gap-2 text-sm">
              <button
                type="button"
                className="rounded border border-[var(--ob-line)] px-2 py-1"
                onClick={() => {
                  if (!active) {
                    alert("请先打开一个画布项目");
                    return;
                  }
                  void insertAsset(a.id, {
                    x: 80 + Math.random() * 120,
                    y: 80 + Math.random() * 120,
                  });
                  alert("已插入当前画布");
                }}
              >
                插入画布
              </button>
              {a.kind === "text" ? (
                <button
                  type="button"
                  className="rounded border border-[var(--ob-line)] px-2 py-1"
                  onClick={() => void navigator.clipboard.writeText(a.content ?? "")}
                >
                  复制
                </button>
              ) : null}
              {a.kind === "image" && a.storageKey ? (
                <button
                  type="button"
                  className="rounded border border-[var(--ob-line)] px-2 py-1"
                  onClick={() =>
                    void downloadStorageKey(a.storageKey!, `${a.title || a.id}.png`)
                  }
                >
                  下载
                </button>
              ) : null}
              <button
                type="button"
                className="rounded border border-[var(--ob-line)] px-2 py-1"
                onClick={() => setEditing(a)}
              >
                编辑
              </button>
              <button
                type="button"
                className="rounded border border-[var(--ob-line)] px-2 py-1 text-[var(--ob-danger)]"
                onClick={() => {
                  if (!window.confirm(`删除素材“${a.title}”？`)) return;
                  void (async () => {
                    const nextAssets = useBoardStore.getState().assets.filter((item) => item.id !== a.id);
                    setAssets(nextAssets);
                    await removeOrphanedBlob(a.storageKey, nextAssets);
                  })();
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {!filtered.length ? (
        <p className="mt-10 text-center text-[var(--ob-muted)]">暂无素材</p>
      ) : (
        <div className="mt-6 flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            className="rounded border border-[var(--ob-line)] px-3 py-1 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            上一页
          </button>
          <span className="text-[var(--ob-muted)]">
            {page} / {totalPages} · 共 {filtered.length}
          </span>
          <button
            type="button"
            className="rounded border border-[var(--ob-line)] px-3 py-1 disabled:opacity-40"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            下一页
          </button>
        </div>
      )}
      <AssetEditorDialog
        asset={editing}
        onClose={() => setEditing(null)}
        onSave={saveAsset}
      />
    </div>
  );
}
