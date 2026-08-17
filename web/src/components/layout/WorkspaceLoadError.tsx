import { useI18n } from "@/i18n/I18nProvider";

export function WorkspaceLoadError({
  message,
  onRetry,
  compact = false,
}: {
  message: string | null;
  onRetry: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={compact ? "p-2" : "ob-page p-6"} data-testid="workspace-load-error">
      <div role="alert" className="ob-banner rounded-xl" data-tone="danger">
        <span className="min-w-0 flex-1">{message || t("workspace.loadFailed", { message: "" })}</span>
        <button type="button" className="ob-btn" onClick={() => void onRetry()}>
          {t("workspace.retry")}
        </button>
      </div>
    </div>
  );
}
