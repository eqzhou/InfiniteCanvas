import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";

/**
 * In-app replacement for `window.confirm`. Native dialogs break out of the
 * theme, cannot be styled for the destructive/neutral distinction, and steal
 * focus in a way we cannot restore — so every irreversible action routes here.
 * Focus is trapped, Escape cancels, and the cancel button is focused first so
 * that a stray Enter never confirms a delete.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  tone = "danger",
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "neutral";
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Restore focus to whatever opened the dialog once it closes.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => openerRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="ob-overlay z-[200]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ob-confirm-title"
        aria-describedby={message ? "ob-confirm-desc" : undefined}
        className="ob-surface w-full max-w-sm p-5"
        onKeyDown={handleKeyDown}
      >
        <div className="ob-admin-section-header !mb-3">
          <span className="ob-admin-section-icon" data-tone={tone} aria-hidden>
            {tone === "danger" ? <AlertTriangle size={16} /> : <HelpCircle size={16} />}
          </span>
          <div className="ob-admin-section-heading">
            <h2 id="ob-confirm-title" className="ob-admin-section-title">{title}</h2>
            {message ? <p id="ob-confirm-desc" className="ob-admin-section-desc">{message}</p> : null}
          </div>
        </div>
        <div className="ob-record-actions justify-end">
          <button ref={cancelRef} type="button" className="ob-btn" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "ob-btn ob-btn-danger" : "ob-btn ob-btn-primary"}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? t("admin.processing") : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
