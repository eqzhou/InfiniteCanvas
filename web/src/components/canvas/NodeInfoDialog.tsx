import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { BoardNode } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

const NODE_TYPE_LABELS: Record<string, string> = {
  text: "文本",
  image: "图片",
  config: "生成配置",
  video: "视频",
  audio: "音频",
  panorama: "全景图",
  director: "3D 导演台",
  group: "分组",
  plugin: "插件",
};

/** Values worth surfacing as readable rows rather than raw JSON. */
function summaryRows(node: BoardNode): Array<{ label: string; value: string }> {
  const metadata = node.metadata as Record<string, unknown>;
  const text = (key: string): string => {
    const value = metadata[key];
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "boolean") return value ? "是" : "否";
    if (typeof value === "number" || typeof value === "string") return String(value);
    return "";
  };
  const rows: Array<{ label: string; value: string }> = [
    { label: "类型", value: NODE_TYPE_LABELS[node.type] ?? node.type },
    { label: "标题", value: node.title },
    { label: "尺寸", value: `${Math.round(node.width)} × ${Math.round(node.height)}` },
    { label: "位置", value: `${Math.round(node.position.x)}, ${Math.round(node.position.y)}` },
    { label: "状态", value: text("status") },
    { label: "模型", value: text("model") },
    { label: "提示词", value: text("prompt") },
    { label: "生成尺寸", value: text("size") },
    { label: "质量", value: text("quality") },
    { label: "数量", value: text("count") },
    { label: "视频比例", value: text("videoRatio") },
    { label: "清晰度", value: text("resolution") },
    { label: "时长（秒）", value: text("seconds") },
    { label: "声音", value: text("voice") },
    { label: "媒体类型", value: text("mimeType") },
  ];
  return rows.filter((row) => row.value !== "");
}

/**
 * Structured node inspector. The readable summary is the default view and the
 * raw document stays available for debugging and bug reports.
 */
export function NodeInfoDialog({
  open,
  node,
  onClose,
}: {
  open: boolean;
  node: BoardNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [showRaw, setShowRaw] = useState(false);
  useEscapeDismiss(open, onClose, 100);
  useLayoutEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  const rows = useMemo(() => (open ? summaryRows(node) : []), [open, node]);
  const raw = useMemo(() => (open ? JSON.stringify({
    id: node.id,
    type: node.type,
    title: node.title,
    size: { width: node.width, height: node.height },
    position: node.position,
    metadata: node.metadata,
  }, null, 2) : ""), [open, node]);

  if (!open) return null;
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="节点信息"
      tabIndex={-1}
      className="ob-overlay bg-black/60 p-3 sm:p-6"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="ob-surface-glass flex max-h-[80vh] w-full max-w-lg flex-col p-5 shadow-[var(--ob-elev-2)]">
        <header className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">节点信息</h2>
          <div className="flex items-center gap-2">
            <button type="button" className="ob-btn" onClick={() => setShowRaw((current) => !current)}>
              {showRaw ? "基础信息" : "查看 JSON"}
            </button>
            <button type="button" className="ob-icon-btn" aria-label="关闭节点信息" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>
        {showRaw ? (
          <pre className="min-h-0 flex-1 overflow-auto rounded-lg bg-[var(--ob-canvas)] p-3 text-xs leading-relaxed">{raw}</pre>
        ) : (
          <dl className="min-h-0 flex-1 overflow-auto text-sm">
            {rows.map((row) => (
              <div key={row.label} className="flex gap-3 border-b border-[var(--ob-line)] py-1.5 last:border-b-0">
                <dt className="w-24 shrink-0 text-[var(--ob-muted)]">{row.label}</dt>
                <dd className="min-w-0 flex-1 break-words">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>,
    document.body,
  );
}
