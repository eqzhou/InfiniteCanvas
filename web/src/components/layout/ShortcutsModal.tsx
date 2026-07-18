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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">画布快捷键</h2>
          <button type="button" onClick={() => setShowShortcuts(false)}>
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
