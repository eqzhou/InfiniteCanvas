import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { BoardNode } from "@/types/board";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

const NODE_TYPE_KEYS: Record<string, MessageKey> = {
  text: "nodeInfo.text", image: "nodeInfo.image", config: "nodeInfo.config", video: "nodeInfo.video",
  audio: "nodeInfo.audio", panorama: "nodeInfo.panorama", director: "nodeInfo.director",
  group: "nodeInfo.group", plugin: "nodeInfo.plugin",
};

/** Values worth surfacing as readable rows rather than raw JSON. */
function summaryRows(node: BoardNode, t: (key: MessageKey) => string): Array<{ label: string; value: string }> {
  const metadata = node.metadata as Record<string, unknown>;
  const text = (key: string): string => {
    const value = metadata[key];
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "boolean") return value ? t("nodeInfo.yes") : t("nodeInfo.no");
    if (typeof value === "number" || typeof value === "string") return String(value);
    return "";
  };
  const rows: Array<{ label: string; value: string }> = [
    { label: t("nodeInfo.type"), value: NODE_TYPE_KEYS[node.type] ? t(NODE_TYPE_KEYS[node.type]) : node.type },
    { label: t("nodeInfo.titleField"), value: node.title },
    { label: t("nodeInfo.size"), value: `${Math.round(node.width)} × ${Math.round(node.height)}` },
    { label: t("nodeInfo.position"), value: `${Math.round(node.position.x)}, ${Math.round(node.position.y)}` },
    { label: t("nodeInfo.status"), value: text("status") },
    { label: t("nodeInfo.model"), value: text("model") },
    { label: t("nodeInfo.prompt"), value: text("prompt") },
    { label: t("nodeInfo.generatedSize"), value: text("size") },
    { label: t("nodeInfo.quality"), value: text("quality") },
    { label: t("nodeInfo.count"), value: text("count") },
    { label: t("nodeInfo.videoRatio"), value: text("videoRatio") },
    { label: t("nodeInfo.resolution"), value: text("resolution") },
    { label: t("nodeInfo.seconds"), value: text("seconds") },
    { label: t("nodeInfo.voice"), value: text("voice") },
    { label: t("nodeInfo.mimeType"), value: text("mimeType") },
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
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [showRaw, setShowRaw] = useState(false);
  useEscapeDismiss(open, onClose, 100);
  useLayoutEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  const rows = useMemo(() => (open ? summaryRows(node, t) : []), [open, node, t]);
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
      aria-label={t("nodeInfo.aria")}
      tabIndex={-1}
      className="ob-overlay bg-black/60 p-3 sm:p-6"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="ob-surface-glass flex max-h-[80vh] w-full max-w-lg flex-col p-5 shadow-[var(--ob-elev-2)]">
        <header className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t("nodeInfo.title")}</h2>
          <div className="flex items-center gap-2">
            <button type="button" className="ob-btn" onClick={() => setShowRaw((current) => !current)}>
              {showRaw ? t("nodeInfo.basic") : t("nodeInfo.raw")}
            </button>
            <button type="button" className="ob-icon-btn" aria-label={t("nodeInfo.close")} onClick={onClose}>
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
