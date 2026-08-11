import type { NodeType } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import {
  Bookmark,
  Clapperboard,
  Download,
  Film,
  Focus,
  Grid3X3,
  Globe2,
  ImagePlus,
  Hand,
  Map,
  Music2,
  MousePointer2,
  Redo2,
  Settings2,
  Type,
  Undo2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/i18n/I18nProvider";

export function CanvasToolbar({
  onAdd,
  onImportImages,
  onImportVideos,
  onImportAudios,
  onOpenAssets,
  onFitView,
  onExportSnapshot,
  exportingSnapshot = false,
  reservePanelToggle = false,
}: {
  onAdd: (type: NodeType) => void;
  onImportImages: (files: File[]) => void | Promise<void>;
  onImportVideos?: (files: File[]) => void | Promise<void>;
  onImportAudios?: (files: File[]) => void | Promise<void>;
  onOpenAssets?: () => void;
  onFitView?: () => void;
  onExportSnapshot?: () => void | Promise<void>;
  exportingSnapshot?: boolean;
  reservePanelToggle?: boolean;
}) {
  const { t } = useI18n();
  const undo = useBoardStore((s) => s.undo);
  const redo = useBoardStore((s) => s.redo);
  const backgroundMode = useBoardStore((s) => s.getActive()?.backgroundMode);
  const setBackground = useBoardStore((s) => s.setBackground);
  const showMinimap = useBoardStore((s) => s.showMinimap);
  const setShowMinimap = useBoardStore((s) => s.setShowMinimap);
  const config = useBoardStore((s) => s.config);
  const setConfig = useBoardStore((s) => s.setConfig);

  return (
    <div
      role="toolbar"
      aria-label={t("canvas.toolbar")}
      className={cn(
        "ob-toolbar-scroll z-30 flex min-h-12 w-full min-w-0 max-w-full flex-nowrap items-center gap-1 overflow-x-auto border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] py-1.5 pr-2 shadow-[var(--ob-elev-1)] backdrop-blur-md",
        reservePanelToggle ? "pl-14" : "pl-14 sm:pl-3",
      )}
    >
      <Tool label={t("canvas.select")} onClick={() => setConfig({ ...config, canvasInteractionTool: "select" })} active={(config.canvasInteractionTool ?? "select") === "select"}><MousePointer2 size={16} /></Tool>
      <Tool label={t("canvas.pan")} onClick={() => setConfig({ ...config, canvasInteractionTool: "pan" })} active={config.canvasInteractionTool === "pan"}><Hand size={16} /></Tool>
      <div className="mx-1 h-5 w-px shrink-0 bg-[var(--ob-line)]" />
      <Tool label={t("canvas.text")} onClick={() => onAdd("text")}>
        <Type size={16} />
      </Tool>
      <Tool label={t("canvas.image")} onClick={() => onAdd("image")}>
        <ImagePlus size={16} />
      </Tool>
      <Tool label={t("canvas.config")} onClick={() => onAdd("config")} compact>
        <Settings2 size={16} />
      </Tool>
      <Tool label={t("canvas.video")} onClick={() => onAdd("video")} compact>
        <Film size={16} />
      </Tool>
      <Tool label={t("canvas.audio")} onClick={() => onAdd("audio")} compact>
        <Music2 size={16} />
      </Tool>
      <Tool label={t("canvas.panorama")} onClick={() => onAdd("panorama")} compact>
        <Globe2 size={16} />
      </Tool>
      <Tool label={t("canvas.director")} onClick={() => onAdd("director")} compact>
        <Clapperboard size={16} />
      </Tool>
      <label aria-label={t("canvas.importImage")} title={t("canvas.importImage")} className="ob-file-btn shrink-0">
        <Upload size={16} />
        <span className="sr-only">{t("canvas.importImage")}</span>
        <input
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            void Promise.resolve(onImportImages(files)).catch((error: unknown) => {
              window.alert(error instanceof Error ? error.message : t("canvas.importImageFailed"));
            });
            e.currentTarget.value = "";
          }}
        />
      </label>
      {onImportVideos ? (
        <label aria-label={t("canvas.importVideo")} title={t("canvas.importVideo")} className="ob-file-btn shrink-0">
          <Film size={16} />
          <span className="sr-only">{t("canvas.importVideo")}</span>
          <input
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              void Promise.resolve(onImportVideos(files)).catch((error: unknown) => {
                window.alert(error instanceof Error ? error.message : t("canvas.importVideoFailed"));
              });
              e.currentTarget.value = "";
            }}
          />
        </label>
      ) : null}
      {onImportAudios ? (
        <label aria-label={t("canvas.importAudio")} title={t("canvas.importAudio")} className="ob-file-btn shrink-0">
          <Music2 size={16} />
          <span className="sr-only">{t("canvas.importAudio")}</span>
          <input
            type="file"
            accept="audio/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              void Promise.resolve(onImportAudios(files)).catch((error: unknown) => {
                window.alert(error instanceof Error ? error.message : t("canvas.importAudioFailed"));
              });
              e.currentTarget.value = "";
            }}
          />
        </label>
      ) : null}
      <div className="mx-1.5 h-5 w-px shrink-0 bg-[color-mix(in_srgb,var(--ob-line)_80%,var(--ob-ink)_10%)]" />
      <Tool label={t("canvas.undo")} onClick={undo} compact>
        <Undo2 size={16} />
      </Tool>
      <Tool label={t("canvas.redo")} onClick={redo} compact>
        <Redo2 size={16} />
      </Tool>
      <Tool
        label={t("canvas.background")}
        compact
        onClick={() => {
          const order = ["dots", "lines", "blank"] as const;
          const i = order.indexOf(backgroundMode ?? "dots");
          setBackground(order[(i + 1) % order.length]);
        }}
      >
        <Grid3X3 size={16} />
      </Tool>
      <Tool label={t("canvas.minimap")} onClick={() => setShowMinimap(!showMinimap)} active={showMinimap} compact>
        <Map size={16} />
      </Tool>
      {onOpenAssets ? (
        <Tool label={t("canvas.assets")} onClick={onOpenAssets} compact>
          <Bookmark size={16} />
        </Tool>
      ) : null}
      {onFitView ? (
        <Tool label={t("canvas.fit")} onClick={onFitView} compact>
          <Focus size={16} />
        </Tool>
      ) : null}
      {onExportSnapshot ? (
        <Tool
          label={exportingSnapshot ? t("canvas.exporting") : t("canvas.export")}
          onClick={() => void onExportSnapshot()}
          compact
          disabled={exportingSnapshot}
        >
          <Download size={16} />
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
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
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
