import { useI18n } from "@/i18n/I18nProvider";

export function PageSkeleton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      className={compact ? "space-y-2 p-2" : "ob-page space-y-5"}
      role="status"
      aria-label={t("common.loading")}
      data-testid="page-skeleton"
    >
      <div className="h-5 w-28 animate-pulse rounded bg-[var(--ob-surface-2)]" />
      <div className="h-10 w-full max-w-xl animate-pulse rounded-xl bg-[var(--ob-surface-2)]" />
      <div className={compact ? "grid grid-cols-2 gap-2" : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
        {Array.from({ length: compact ? 4 : 6 }, (_, index) => (
          <div
            key={index}
            className="h-28 animate-pulse rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)]"
          />
        ))}
      </div>
    </div>
  );
}
