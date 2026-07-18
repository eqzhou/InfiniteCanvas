import { useMemo, useState } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import type { Point } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

export function AssetPickerModal({
  open,
  at,
  onClose,
}: {
  open: boolean;
  at: Point | null;
  onClose: () => void;
}) {
  const assets = useBoardStore((s) => s.assets);
  const insertAsset = useBoardStore((s) => s.insertAsset);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "text" | "image">("all");
  useEscapeDismiss(open, onClose);

  const filtered = useMemo(
    () =>
      assets.filter((a) => {
        if (kind !== "all" && a.kind !== kind) return false;
        if (!q.trim()) return true;
        const s = q.toLowerCase();
        return (
          a.title.toLowerCase().includes(s) ||
          a.tags.some((t) => t.toLowerCase().includes(s)) ||
          (a.content ?? "").toLowerCase().includes(s)
        );
      }),
    [assets, kind, q],
  );

  if (!open) return null;
  const pos = at ?? { x: 120, y: 120 };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)] shadow-[var(--ob-shadow)]">
        <div className="flex items-center gap-2 border-b border-[var(--ob-line)] px-4 py-3">
          <strong>从素材插入</strong>
          <input
            className="ml-auto rounded border border-[var(--ob-line)] bg-transparent px-2 py-1 text-sm"
            placeholder="搜索…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="rounded border border-[var(--ob-line)] bg-transparent px-2 py-1 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="all">全部</option>
            <option value="text">文本</option>
            <option value="image">图片</option>
          </select>
          <button type="button" className="text-sm text-[var(--ob-muted)]" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {filtered.map((a) => (
              <button
                key={a.id}
                type="button"
                className="rounded-lg border border-[var(--ob-line)] p-2 text-left hover:border-[var(--ob-accent)]"
                onClick={() => {
                  void insertAsset(a.id, pos);
                  onClose();
                }}
              >
                {a.kind === "image" && a.coverUrl ? (
                  <img
                    src={a.coverUrl}
                    alt=""
                    className="mb-2 h-24 w-full rounded object-cover"
                  />
                ) : null}
                <div className="truncate text-sm font-medium">{a.title}</div>
                <div className="truncate text-[11px] text-[var(--ob-muted)]">
                  {a.kind === "text" ? a.content : a.mimeType}
                </div>
              </button>
            ))}
          </div>
          {!filtered.length ? (
            <p className="p-8 text-center text-sm text-[var(--ob-muted)]">暂无素材</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
