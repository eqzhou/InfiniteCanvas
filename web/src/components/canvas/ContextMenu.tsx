import { useRef } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import type { PluginManifest, Point } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { toast } from "@/components/common/toast";
import {
  ClipboardPaste,
  Clapperboard,
  CopyPlus,
  Film,
  Focus,
  FolderOpen,
  Globe2,
  FolderMinus,
  FolderPlus,
  ImagePlus,
  Music2,
  Puzzle,
  Settings2,
  Trash2,
  Type,
  Upload,
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
  onUploadMedia,
  onOpenAssets,
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
  onAdd: (type: "text" | "image" | "config" | "video" | "audio" | "panorama" | "director" | "plugin", at: Point, pluginId?: string) => void;
  onPaste: (at: Point) => void;
  /** Blank-canvas chooser: upload local media at the menu world position. */
  onUploadMedia?: (files: File[], at: Point) => void | Promise<void>;
  /** Blank-canvas chooser: open the asset library picker at the menu world position. */
  onOpenAssets?: (at: Point) => void;
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
  const { t } = useI18n();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  useEscapeDismiss(Boolean(state), onClose, 80);
  if (!state) return null;
  type MenuIcon = typeof Type;
  type Item = {
    label: string;
    action?: () => void;
    disabled?: boolean;
    icon?: MenuIcon;
    /** When true, clicking opens the hidden media file input instead of running action immediately. */
    upload?: boolean;
  };
  const items: Item[] = state.nodeId
    ? [
        { label: t("context.duplicate"), action: onDuplicate, icon: CopyPlus },
        { label: t("context.delete"), action: onDelete, icon: Trash2 },
        { label: t("context.fit"), action: onBring, icon: Focus },
        ...(multi
          ? [
              { label: t("context.alignLeft"), action: () => onAlign?.("left") },
              { label: t("context.alignRight"), action: () => onAlign?.("right") },
              { label: t("context.alignTop"), action: () => onAlign?.("top") },
              { label: t("context.alignBottom"), action: () => onAlign?.("bottom") },
              { label: t("context.alignCenterHorizontal"), action: () => onAlign?.("hcenter") },
              { label: t("context.alignCenterVertical"), action: () => onAlign?.("vcenter") },
              { label: t("context.distributeHorizontal"), action: () => onDistribute?.("x") },
              { label: t("context.distributeVertical"), action: () => onDistribute?.("y") },
            ]
          : []),
      ]
    : [
        { label: t("context.paste"), action: () => onPaste(state.world), icon: ClipboardPaste },
        { label: t("context.uploadToCanvas"), upload: true, icon: Upload, disabled: !onUploadMedia },
        { label: t("context.insertAsset"), action: () => onOpenAssets?.(state.world), icon: FolderOpen, disabled: !onOpenAssets },
        { label: t("context.newText"), action: () => onAdd("text", state.world), icon: Type },
        { label: t("context.newImage"), action: () => onAdd("image", state.world), icon: ImagePlus },
        { label: t("context.newConfig"), action: () => onAdd("config", state.world), icon: Settings2 },
        { label: t("context.newVideo"), action: () => onAdd("video", state.world), icon: Film },
        { label: t("context.newAudio"), action: () => onAdd("audio", state.world), icon: Music2 },
        { label: t("context.newPanorama"), action: () => onAdd("panorama", state.world), icon: Globe2 },
        { label: t("context.newDirector"), action: () => onAdd("director", state.world), icon: Clapperboard },
        ...plugins.map((plugin) => ({
          label: t("context.plugin", { name: plugin.name }),
          action: () => onAdd("plugin", state.world, plugin.id),
          icon: Puzzle,
        })),
      ];
  if (state.nodeId && canGroup) items.unshift({ label: t("context.group"), action: onGroup, icon: FolderPlus });
  if (state.nodeId && canUngroup) items.unshift({ label: t("context.ungroup"), action: onUngroup, icon: FolderMinus });

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
      <div className="fixed inset-0 z-[70]" data-canvas-control onPointerDown={onClose} />
      <div
        role="menu"
        aria-label={state.nodeId ? t("context.nodeMenu") : t("context.canvasMenu")}
        data-canvas-control
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
                if (item.upload) {
                  // Keep menu world position via state; close after file selection starts.
                  uploadInputRef.current?.click();
                  return;
                }
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
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        className="hidden"
        aria-label={t("context.uploadToCanvas")}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.currentTarget.value = "";
          onClose();
          if (!files.length || !onUploadMedia) return;
          void Promise.resolve(onUploadMedia(files, state.world)).catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : t("context.uploadFailed"));
          });
        }}
      />
    </>
  );
}
