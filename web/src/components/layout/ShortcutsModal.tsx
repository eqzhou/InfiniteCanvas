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
    <div className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="ob-surface-glass w-full max-w-md p-6"
      >
        <div className="mb-4 flex items-center justify-between border-b border-[var(--ob-line)] pb-3">
          <h2 id="shortcuts-title" className="text-lg font-semibold text-[var(--ob-ink)]">
            画布快捷键
          </h2>
          <button
            type="button"
            className="ob-btn-ghost rounded-lg px-2.5 py-1.5 text-sm"
            onClick={() => setShowShortcuts(false)}
          >
            关闭
          </button>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-[var(--ob-line)]">
                <td className="py-2 pr-3 font-medium">{k}</td>
                <td className="py-2 text-[var(--ob-muted)]">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
