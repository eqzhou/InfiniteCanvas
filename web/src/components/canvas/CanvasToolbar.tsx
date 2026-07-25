import type { NodeType } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import {
  Bookmark,
  Clapperboard,
  Film,
  Focus,
  Grid3X3,
  Globe2,
  ImagePlus,
  Map,
  Music2,
  Redo2,
  Settings2,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/cn";

export function CanvasToolbar({
  onAdd,
  onImportImages,
  onImportVideos,
  onImportAudios,
  onOpenAssets,
  onFitView,
  reservePanelToggle = false,
}: {
  onAdd: (type: NodeType) => void;
  onImportImages: (files: File[]) => void | Promise<void>;
  onImportVideos?: (files: File[]) => void | Promise<void>;
  onImportAudios?: (files: File[]) => void | Promise<void>;
  onOpenAssets?: () => void;
  onFitView?: () => void;
  reservePanelToggle?: boolean;
}) {
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);
  const backgroundMode = useBoardStore((s) => s.getActive()?.backgroundMode);
  const setBackground = useBoardStore((s) => s.setBackground);
  const showMinimap = useBoardStore((s) => s.showMinimap);
  const setShowMinimap = useBoardStore((s) => s.setShowMinimap);

  return (
    <div
      role="toolbar"
      aria-label="画布工具栏"
      className={cn(
        "ob-toolbar-scroll z-30 flex min-h-12 w-full min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-x-auto border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] py-1.5 pr-2 shadow-[var(--ob-elev-1)] backdrop-blur-md",
        reservePanelToggle ? "pl-14" : "pl-14 sm:pl-3",
      )}
    >
      <Tool label="文本" onClick={() => onAdd("text")}>
        <Type size={16} />
      </Tool>
      <Tool label="图片" onClick={() => onAdd("image")}>
        <ImagePlus size={16} />
      </Tool>
      <Tool label="配置" onClick={() => onAdd("config")} compact>
        <Settings2 size={16} />
      </Tool>
      <Tool label="视频" onClick={() => onAdd("video")} compact>
        <Film size={16} />
      </Tool>
      <Tool label="音频" onClick={() => onAdd("audio")} compact>
        <Music2 size={16} />
      </Tool>
      <Tool label="全景" onClick={() => onAdd("panorama")} compact>
        <Globe2 size={16} />
      </Tool>
      <Tool label="导演台" onClick={() => onAdd("director")} compact>
        <Clapperboard size={16} />
      </Tool>
      <label aria-label="导入图片" title="导入图片" className="ob-file-btn shrink-0">
        <Upload size={16} />
        <span className="sr-only">导入图片</span>
        <input
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            void Promise.resolve(onImportImages(files)).catch((error: unknown) => {
              window.alert(error instanceof Error ? error.message : "图片导入失败");
            });
            e.currentTarget.value = "";
          }}
        />
      </label>
      {onImportVideos ? (
        <label aria-label="导入视频" title="导入视频" className="ob-file-btn shrink-0">
          <Film size={16} />
          <span className="sr-only">导入视频</span>
          <input
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              void Promise.resolve(onImportVideos(files)).catch((error: unknown) => {
                window.alert(error instanceof Error ? error.message : "视频导入失败");
              });
              e.currentTarget.value = "";
            }}
          />
        </label>
      ) : null}
      {onImportAudios ? (
        <label aria-label="导入音频" title="导入音频" className="ob-file-btn shrink-0">
          <Music2 size={16} />
          <span className="sr-only">导入音频</span>
          <input
            type="file"
            accept="audio/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              void Promise.resolve(onImportAudios(files)).catch((error: unknown) => {
                window.alert(error instanceof Error ? error.message : "音频导入失败");
              });
              e.currentTarget.value = "";
            }}
          />
        </label>
      ) : null}
      <div className="mx-1.5 h-5 w-px shrink-0 bg-[color-mix(in_srgb,var(--ob-line)_80%,var(--ob-ink)_10%)]" />
      <Tool label="撤销" onClick={undo} compact>
        <Undo2 size={16} />
      </Tool>
      <Tool label="重做" onClick={redo} compact>
        <Redo2 size={16} />
      </Tool>
      <Tool
        label="背景"
        compact
        onClick={() => {
          const order = ["dots", "lines", "blank"] as const;
          const i = order.indexOf(backgroundMode ?? "dots");
          setBackground(order[(i + 1) % order.length]);
        }}
      >
        <Grid3X3 size={16} />
      </Tool>
      <Tool label="小地图" onClick={() => setShowMinimap(!showMinimap)} active={showMinimap} compact>
        <Map size={16} />
      </Tool>
      {onOpenAssets ? (
        <Tool label="素材" onClick={onOpenAssets} compact>
          <Bookmark size={16} />
        </Tool>
      ) : null}
      {onFitView ? (
        <Tool label="适应" onClick={onFitView} compact>
          <Focus size={16} />
        </Tool>
      ) : null}
    </div>
  );
}

function Tool({
  label,
  onClick,
  children,
  active,
  compact = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "ob-btn h-9 shrink-0 gap-1 px-2.5",
        active && "border-transparent bg-[var(--ob-accent-soft)] font-semibold text-[var(--ob-accent)] shadow-sm",
      )}
    >
      {children}
      <span className={compact ? "sr-only" : "hidden sm:inline"}>{label}</span>
    </button>
  );
}
