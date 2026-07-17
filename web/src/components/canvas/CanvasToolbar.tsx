import type { NodeType } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import {
  Bookmark,
  Film,
  Focus,
  Grid3X3,
  ImagePlus,
  Map,
  Music2,
  Redo2,
  Settings2,
  Type,
  Undo2,
  Upload,
} from "lucide-react";

export function CanvasToolbar({
  onAdd,
  onImportImages,
  onImportVideos,
  onImportAudios,
  onOpenAssets,
  onFitView,
}: {
  onAdd: (type: NodeType) => void;
  onImportImages: (files: File[]) => void | Promise<void>;
  onImportVideos?: (files: File[]) => void | Promise<void>;
  onImportAudios?: (files: File[]) => void | Promise<void>;
  onOpenAssets?: () => void;
  onFitView?: () => void;
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
      className="flex flex-wrap items-center gap-2 border-b border-[var(--ob-line)] bg-[var(--ob-panel)] py-2 pl-14 pr-3 sm:px-3"
    >
      <Tool label="文本" onClick={() => onAdd("text")}>
        <Type size={16} />
      </Tool>
      <Tool label="图片" onClick={() => onAdd("image")}>
        <ImagePlus size={16} />
      </Tool>
      <Tool label="配置" onClick={() => onAdd("config")}>
        <Settings2 size={16} />
      </Tool>
      <Tool label="视频" onClick={() => onAdd("video")}>
        <Film size={16} />
      </Tool>
      <Tool label="音频" onClick={() => onAdd("audio")}>
        <Music2 size={16} />
      </Tool>
      <label title="导入图片" className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--ob-line)] px-2 py-1.5 text-sm hover:bg-[var(--ob-accent-soft)]">
        <Upload size={16} />
        <span className="hidden sm:inline">导入图片</span>
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
        <label title="导入视频" className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--ob-line)] px-2 py-1.5 text-sm hover:bg-[var(--ob-accent-soft)]">
          <Film size={16} />
          <span className="hidden sm:inline">导入视频</span>
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
        <label title="导入音频" className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--ob-line)] px-2 py-1.5 text-sm hover:bg-[var(--ob-accent-soft)]">
          <Music2 size={16} />
          <span className="hidden sm:inline">导入音频</span>
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
      <div className="mx-1 h-5 w-px bg-[var(--ob-line)]" />
      <Tool label="撤销" onClick={undo}>
        <Undo2 size={16} />
      </Tool>
      <Tool label="重做" onClick={redo}>
        <Redo2 size={16} />
      </Tool>
      <Tool
        label="背景"
        onClick={() => {
          const order = ["dots", "lines", "blank"] as const;
          const i = order.indexOf(backgroundMode ?? "dots");
          setBackground(order[(i + 1) % order.length]);
        }}
      >
        <Grid3X3 size={16} />
      </Tool>
      <Tool label="小地图" onClick={() => setShowMinimap(!showMinimap)} active={showMinimap}>
        <Map size={16} />
      </Tool>
      {onOpenAssets ? (
        <Tool label="素材" onClick={onOpenAssets}>
          <Bookmark size={16} />
        </Tool>
      ) : null}
      {onFitView ? (
        <Tool label="适应" onClick={onFitView}>
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
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-sm ${
        active
          ? "border-[var(--ob-accent)] bg-[var(--ob-accent-soft)]"
          : "border-[var(--ob-line)] hover:bg-[var(--ob-accent-soft)]"
      }`}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
