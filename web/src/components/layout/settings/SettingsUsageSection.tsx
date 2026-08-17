import { Database, RefreshCw } from "lucide-react";
import type { UsageSnapshot } from "@/services/auth-session";
import { useI18n } from "@/i18n/I18nProvider";

function formatUsageBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.round(safe)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safe / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${Number(value.toFixed(1))} ${unit}`;
}

export function UsageOverview({ snapshot, onRefresh }: { snapshot: UsageSnapshot | null; onRefresh: () => void }) {
  const { t } = useI18n();
  if (!snapshot) {
    return <div className="rounded-xl border border-[var(--ob-line)] p-4"><p className="text-sm text-[var(--ob-muted)]">{t("settings.usageUnavailable")}</p><button type="button" className="ob-btn mt-3" onClick={onRefresh}><RefreshCw size={14} /> {t("settings.retry")}</button></div>;
  }
  const quotaRatio = snapshot.generationQuotaMonthly > 0
    ? Math.min(1, snapshot.generationThisMonth / snapshot.generationQuotaMonthly)
    : snapshot.generationThisMonth > 0 ? 1 : 0;
  const storageRatio = snapshot.storageQuotaBytes > 0
    ? Math.min(1, snapshot.storageBytes / snapshot.storageQuotaBytes)
    : null;
  const cards = [
    {
      label: t("settings.teamQuota"),
      value: `${snapshot.generationThisMonth} / ${snapshot.generationQuotaMonthly}`,
      note: t("settings.teamQuotaNote"),
      ratio: quotaRatio,
      tone: quotaRatio >= 1 ? "warning" : "accent",
    },
    { label: t("settings.personalCredits"), value: String(snapshot.credits ?? 0), note: t("settings.personalCreditsNote"), ratio: null, tone: undefined },
    {
      label: t("settings.serverStorage"),
      value: `${formatUsageBytes(snapshot.storageBytes)} / ${formatUsageBytes(snapshot.storageQuotaBytes)}`,
      note: t("settings.serverStorageNote"),
      ratio: storageRatio,
      tone: storageRatio !== null && storageRatio >= 0.9 ? "warning" : "accent",
    },
  ] as const;
  return (
    <div>
      <div className="ob-metric-grid">
        {cards.map((card) => (
          <div key={card.label} className="ob-metric" data-tone={card.tone}>
            <span className="ob-metric-label">{card.label}</span>
            <span className="ob-metric-value">{card.value}</span>
            <p className="ob-metric-hint">{card.note}</p>
            {card.ratio !== null ? (
              <div className="ob-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(card.ratio * 100)} aria-label={card.label}>
                <div className="ob-meter-fill" data-tone={card.ratio >= 1 ? "warning" : undefined} style={{ width: `${Math.max(card.ratio * 100, card.ratio > 0 ? 2 : 0)}%` }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="ob-chip">{t("settings.plan", { plan: snapshot.plan || "free" })}</span>
        <button type="button" className="ob-btn" onClick={onRefresh}><RefreshCw size={14} /> {t("settings.refreshUsage")}</button>
      </div>
      <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("settings.usageExplanation")}</p>
    </div>
  );
}

export function SettingsUsageSection({
  snapshot,
  onRefresh,
}: {
  snapshot: UsageSnapshot | null;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="ob-settings-section mb-5" data-section-id="usage">
      <div className="ob-settings-section-header">
        <span className="ob-settings-section-icon"><Database size={14} /></span>
        <div>
          <div className="ob-settings-section-title">{t("settings.usageTitle")}</div>
          <div className="ob-settings-section-desc">{t("settings.usageDescription")}</div>
        </div>
      </div>
      <UsageOverview snapshot={snapshot} onRefresh={onRefresh} />
    </section>
  );
}
