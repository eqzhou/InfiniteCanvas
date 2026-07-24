import type { PluginManifest, Point } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import {
  ClipboardPaste,
  CopyPlus,
  Film,
  Focus,
  FolderMinus,
  FolderPlus,
  ImagePlus,
  Music2,
  Puzzle,
  Settings2,
  Trash2,
  Type,
} from "lucide-react";

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
  useEscapeDismiss(Boolean(state), onClose, 80);
  if (!state) return null;
  type MenuIcon = typeof Type;
  type Item = { label: string; action?: () => void; disabled?: boolean; icon?: MenuIcon };
  const items: Item[] = state.nodeId
    ? [
        { label: "创建副本", action: onDuplicate, icon: CopyPlus },
        { label: "删除", action: onDelete, icon: Trash2 },
        { label: "适应视图", action: onBring, icon: Focus },
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
        { label: "粘贴", action: () => onPaste(state.world), icon: ClipboardPaste },
        { label: "新建文本", action: () => onAdd("text", state.world), icon: Type },
        { label: "新建图片", action: () => onAdd("image", state.world), icon: ImagePlus },
        { label: "新建配置", action: () => onAdd("config", state.world), icon: Settings2 },
        { label: "新建视频", action: () => onAdd("video", state.world), icon: Film },
        { label: "新建音频", action: () => onAdd("audio", state.world), icon: Music2 },
        ...plugins.map((plugin) => ({
          label: `插件 · ${plugin.name}`,
          action: () => onAdd("plugin", state.world, plugin.id),
          icon: Puzzle,
        })),
      ];
  if (state.nodeId && canGroup) items.unshift({ label: "组合", action: onGroup, icon: FolderPlus });
  if (state.nodeId && canUngroup) items.unshift({ label: "取消组合", action: onUngroup, icon: FolderMinus });

  const menuWidth = 176; // keep in sync with w-44
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.max(4, Math.min(state.screen.x, viewportWidth - menuWidth - 4));
  // Prefer opening upward near the bottom edge so the full menu stays in-bounds.
  const opensUpward = state.screen.y > viewportHeight * 0.55;
  const top = opensUpward
    ? Math.min(state.screen.y, viewportHeight - 8)
    : Math.max(8, Math.min(state.screen.y, viewportHeight - 8));
  const maxHeight = Math.max(120, opensUpward ? top - 8 : viewportHeight - top - 8);

  return (
    <>
      <div className="fixed inset-0 z-[70]" onPointerDown={onClose} />
      <div
        role="menu"
        aria-label={state.nodeId ? "节点菜单" : "画布菜单"}
        className="ob-menu fixed z-[80] w-44 overflow-y-auto"
        style={{
          left,
          top,
          maxHeight,
          transform: opensUpward ? "translateY(-100%)" : undefined,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="ob-menu-item"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.action?.();
              }}
            >
              {Icon ? <Icon size={15} className="shrink-0 text-[var(--ob-muted)]" /> : <span className="w-[15px]" />}
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}
