import type { PluginManifest, Point } from "@/types/board";

export type ContextMenuState = {
  screen: Point;
  world: Point;
  nodeId?: string;
} | null;

export function ContextMenu({
  state,
  multi,
  onClose,
  onAdd,
  onPaste,
  onDelete,
  onDuplicate,
  onBring,
  onAlign,
  onDistribute,
  canGroup,
  canUngroup,
  onGroup,
  onUngroup,
  plugins = [],
}: {
  state: ContextMenuState;
  multi?: boolean;
  onClose: () => void;
  onAdd: (type: "text" | "image" | "config" | "video" | "audio" | "plugin", at: Point, pluginId?: string) => void;
  onPaste: (at: Point) => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onBring?: () => void;
  onAlign?: (mode: "left" | "right" | "top" | "bottom" | "hcenter" | "vcenter") => void;
  onDistribute?: (axis: "x" | "y") => void;
  canGroup?: boolean;
  canUngroup?: boolean;
  onGroup?: () => void;
  onUngroup?: () => void;
  plugins?: PluginManifest[];
}) {
  if (!state) return null;
  type Item = { label: string; action?: () => void; disabled?: boolean };
  const items: Item[] = state.nodeId
    ? [
        { label: "复制/粘贴副本", action: onDuplicate },
        { label: "删除", action: onDelete },
        { label: "适应视图", action: onBring },
        ...(multi
          ? [
              { label: "左对齐", action: () => onAlign?.("left") },
              { label: "右对齐", action: () => onAlign?.("right") },
              { label: "顶对齐", action: () => onAlign?.("top") },
              { label: "底对齐", action: () => onAlign?.("bottom") },
              { label: "水平居中", action: () => onAlign?.("hcenter") },
              { label: "垂直居中", action: () => onAlign?.("vcenter") },
              { label: "水平分布", action: () => onDistribute?.("x") },
              { label: "垂直分布", action: () => onDistribute?.("y") },
            ]
          : []),
      ]
    : [
        { label: "粘贴", action: () => onPaste(state.world) },
        { label: "新建文本", action: () => onAdd("text", state.world) },
        { label: "新建图片", action: () => onAdd("image", state.world) },
        { label: "新建配置", action: () => onAdd("config", state.world) },
        { label: "新建视频", action: () => onAdd("video", state.world) },
        { label: "新建音频", action: () => onAdd("audio", state.world) },
        ...plugins.map((plugin) => ({
          label: `插件 · ${plugin.name}`,
          action: () => onAdd("plugin", state.world, plugin.id),
        })),
      ];
  if (state.nodeId && canGroup) items.unshift({ label: "组合", action: onGroup });
  if (state.nodeId && canUngroup) items.unshift({ label: "取消组合", action: onUngroup });

  return (
    <>
      <div className="fixed inset-0 z-[70]" onPointerDown={onClose} />
      <div
        className="fixed z-[80] min-w-40 overflow-hidden rounded-lg border border-[var(--ob-line)] bg-[var(--ob-panel)] py-1 shadow-[var(--ob-shadow)]"
        style={{ left: state.screen.x, top: state.screen.y }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--ob-accent-soft)] disabled:opacity-40"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action?.();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
