import { X } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

const rows: ReadonlyArray<readonly [string, MessageKey]> = [
  ["Mouse drag on empty canvas", "shortcuts.panView"],
  ["Space / Alt + drag", "shortcuts.panNodes"],
  ["Mouse wheel", "shortcuts.zoom"],
  ["Ctrl/Cmd + drag", "shortcuts.marquee"],
  ["Shift/Ctrl/Cmd + click", "shortcuts.toggleSelection"],
  ["Ctrl/Cmd + A", "shortcuts.selectAll"],
  ["Ctrl/Cmd + C / V", "shortcuts.copyPaste"],
  ["Ctrl/Cmd + D", "shortcuts.duplicate"],
  ["Ctrl/Cmd + G", "shortcuts.group"],
  ["Ctrl/Cmd + Shift + G", "shortcuts.ungroup"],
  ["Ctrl/Cmd + Z", "shortcuts.undo"],
  ["Ctrl/Cmd + Shift + Z / Y", "shortcuts.redo"],
  ["Ctrl/Cmd + Shift + E", "shortcuts.exportPng"],
  ["Delete / Backspace", "shortcuts.delete"],
  ["Esc", "shortcuts.dismiss"],
  ["Drop image files", "shortcuts.upload"],
  ["Context menu", "shortcuts.contextMenu"],
  ["Double-click connection", "shortcuts.deleteEdge"],
  ["One-finger drag / pinch", "shortcuts.touch"],
];

export function ShortcutsModal() {
  const { t } = useI18n();
  const open = useBoardStore((s) => s.showShortcuts);
  const setShowShortcuts = useBoardStore((s) => s.setShowShortcuts);
  useEscapeDismiss(open, () => setShowShortcuts(false));
  if (!open) return null;
  return (
    <div className="ob-overlay z-[120] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="ob-dialog ob-surface-glass w-full max-w-md p-0 shadow-[var(--ob-elev-2)]"
      >
        <div className="flex items-center gap-3 border-b border-[var(--ob-line)] px-5 py-4">
          <div className="min-w-0">
            <p className="ob-page-kicker">Canvas</p>
            <h2 id="shortcuts-title" className="text-lg font-semibold tracking-tight text-[var(--ob-ink)]">
              {t("shortcuts.title")}
            </h2>
          </div>
          <button
            type="button"
            className="ob-icon-btn ml-auto"
            aria-label={t("shortcuts.close")}
            title={t("shortcuts.close")}
            onClick={() => setShowShortcuts(false)}
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[min(70vh,32rem)] overflow-y-auto px-5 py-2">
          <table className="w-full text-sm">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} className="border-t border-[color-mix(in_srgb,var(--ob-line)_80%,transparent)] first:border-t-0">
                  <td className="py-2.5 pr-3">
                    <kbd className="rounded-md border border-[var(--ob-line)] bg-[var(--ob-canvas)] px-1.5 py-0.5 text-[12px] font-medium text-[var(--ob-ink)] shadow-[var(--ob-elev-1)]">
                      {k}
                    </kbd>
                  </td>
                  <td className="py-2.5 text-[var(--ob-muted)]">{t(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
