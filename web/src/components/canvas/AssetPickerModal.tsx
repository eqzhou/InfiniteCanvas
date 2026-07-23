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
    <div className="ob-overlay z-[90] p-4 bg-black/40">
      <div className="ob-dialog flex-col max-h-[80vh] w-full max-w-2xl">
        <div className="flex items-center gap-2 border-b border-[var(--ob-line)] px-4 py-3">
          <strong>从素材插入</strong>
          <input
            className="ob-field ml-auto px-2 py-1 text-sm max-w-48"
            placeholder="搜索…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="ob-field px-2 py-1 text-sm"
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
                className="ob-card p-2 text-left"
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
