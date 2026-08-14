import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { dismissToast, subscribeToasts, type ToastItem } from "./toast";
import { useI18n } from "@/i18n/I18nProvider";

const ICON_MAP = {
  neutral: Info,
  success: CheckCircle2,
  danger: AlertCircle,
  warning: AlertTriangle,
};

export function ToastContainer() {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeToasts(setToasts);
  }, []);

  if (!toasts.length) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed bottom-5 right-5 z-[300] flex max-w-sm flex-col gap-2"
    >
      {toasts.map((item) => {
        const Icon = ICON_MAP[item.tone] ?? Info;
        return (
          <div
            key={item.id}
            role="alert"
            data-tone={item.tone}
            className="ob-banner pointer-events-auto ob-view-fade-in flex items-start gap-2.5 rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel-glass)] p-3 shadow-[var(--ob-elev-2)] backdrop-blur-md transition-all duration-200"
          >
            <span
              className={`mt-0.5 shrink-0 ${
                item.tone === "danger"
                  ? "text-[var(--ob-danger)]"
                  : item.tone === "success"
                    ? "text-[var(--ob-success)]"
                    : item.tone === "warning"
                      ? "text-[var(--ob-warning)]"
                      : "text-[var(--ob-accent)]"
              }`}
            >
              <Icon size={16} aria-hidden />
            </span>
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--ob-ink)]">{item.message}</p>
            <button
              type="button"
              className="ob-icon-btn ob-icon-btn-sm shrink-0 text-[var(--ob-muted)] hover:text-[var(--ob-ink)]"
              aria-label={t("common.close")}
              onClick={() => dismissToast(item.id)}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
