import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import type { Point } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";

export function AssetPickerModal({
  open,
  at,
  onClose,
}: {
  open: boolean;
  at: Point | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
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
    <div className="ob-overlay z-[90] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-picker-title"
        className="ob-dialog flex max-h-[min(80vh,40rem)] w-full max-w-2xl flex-col p-0"
      >
        <header className="ob-dialog-header flex-wrap gap-2 px-4 py-3">
          <div className="min-w-0">
            <p className="ob-page-kicker">Assets</p>
            <h2 id="asset-picker-title" className="text-base font-semibold tracking-tight">{t("canvas.assetPickerTitle")}</h2>
          </div>
          <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none">
            <input
              className="ob-field max-w-full px-2.5 py-1.5 text-sm sm:max-w-48"
              placeholder={t("canvas.search")}
              aria-label={t("canvas.searchAssets")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              className="ob-field w-auto cursor-pointer px-2.5 py-1.5 text-sm"
              value={kind}
              aria-label={t("canvas.assetType")}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="all">{t("canvas.all")}</option>
              <option value="text">{t("canvas.text")}</option>
              <option value="image">{t("canvas.image")}</option>
            </select>
            <button type="button" className="ob-icon-btn" aria-label={t("canvas.closeAssetPicker")} title={t("canvas.close")} onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
        <div className="ob-dialog-body min-h-0 flex-1 overflow-auto !pt-3">
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
                    className="mb-2 h-24 w-full rounded-lg object-cover"
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
            <div className="ob-empty border-0 bg-transparent py-10">
              <p className="ob-empty-title">{t("canvas.noAssets")}</p>
              <p className="ob-empty-desc">{t("canvas.noAssetsHint")}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
