import { X } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

const rows = [
  ["拖动画布空白", "平移视图"],
  ["滚轮", "缩放"],
  ["Ctrl/Cmd + 拖动", "框选"],
  ["Shift/Ctrl/Cmd + 点击", "追加选择"],
  ["Ctrl/Cmd + A", "全选"],
  ["Ctrl/Cmd + C / V", "复制 / 粘贴"],
  ["Ctrl/Cmd + D", "复制副本"],
  ["Ctrl/Cmd + G", "组合选择节点"],
  ["Ctrl/Cmd + Shift + G", "取消组合"],
  ["Ctrl/Cmd + Z", "撤销"],
  ["Ctrl/Cmd + Shift + Z / Y", "重做"],
  ["Delete / Backspace", "删除"],
  ["Esc", "取消选择"],
  ["拖入图片文件", "上传到画布"],
  ["右键菜单", "对齐/分布/新建节点"],
  ["双击连线", "删除连线"],
  ["单指拖动 / 双指捏合", "触控平移 / 缩放"],
];

export function ShortcutsModal() {
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
              画布快捷键
            </h2>
          </div>
          <button
            type="button"
            className="ob-icon-btn ml-auto"
            aria-label="关闭快捷键"
            title="关闭快捷键"
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
                  <td className="py-2.5 text-[var(--ob-muted)]">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
