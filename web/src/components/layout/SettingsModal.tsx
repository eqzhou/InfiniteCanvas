import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ShieldCheck, X } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { hasTenantOwnerCapability } from "@/services/admin";
import { DEFAULT_TENANT_POLICY, getTenantPolicy, type TenantPolicy } from "@/services/auth-session";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { useI18n } from "@/i18n/I18nProvider";
import {
  settingsHorizontalScrollTarget,
  settingsScrollTarget,
  settingsSectionsFor,
  settingsWorkspacePermissions,
  type SettingsPolicyLoad,
  type SettingsSectionDefinition,
  type SettingsSectionId,
} from "@/lib/settings-navigation";
import { SettingsFeedbackBar } from "./settings/SettingsFeedbackBar";
import { SettingsInterfaceSection } from "./settings/SettingsInterfaceSection";
import { SettingsModelsSection, SharedChannelManagedNotice } from "./settings/SettingsModelsSection";
import { SettingsGenerationSection } from "./settings/SettingsGenerationSection";
import { SettingsUsageSection, UsageOverview } from "./settings/SettingsUsageSection";
import { SettingsToolbarSection } from "./settings/SettingsToolbarSection";
import { SettingsDataSection } from "./settings/SettingsDataSection";
import type { SettingsFeedback } from "./settings/settings-notices";

export type { SettingsSectionDefinition };
export {
  settingsHorizontalScrollTarget,
  settingsScrollTarget,
  settingsSectionsFor,
  settingsWorkspacePermissions,
};
export { UsageOverview, SharedChannelManagedNotice };

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const flushConfig = useBoardStore((state) => state.flushConfig);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null);
  const auth = useOptionalAuth();
  const tenantOwner = hasTenantOwnerCapability(auth);
  const [tenantPolicy, setTenantPolicy] = useState<TenantPolicy>(DEFAULT_TENANT_POLICY);
  const [policyLoad, setPolicyLoad] = useState<SettingsPolicyLoad>("loading");
  const settingsSections = useMemo(() => settingsSectionsFor(tenantOwner), [tenantOwner]);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("interface");
  const scrollRef = useRef<HTMLDivElement>(null);
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const scrollFrame = useRef(0);
  const notices = useMemo(() => ({ setError, setFeedback }), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPolicyLoad("loading");
    void getTenantPolicy()
      .then((policy) => {
        if (cancelled) return;
        setTenantPolicy(policy);
        setPolicyLoad("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setTenantPolicy(DEFAULT_TENANT_POLICY);
        setPolicyLoad("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveSection((current) => (
      settingsSections.some((section) => section.id === current) ? current : "interface"
    ));
  }, [open, settingsSections]);

  useEffect(() => {
    if (!open) return;
    const navigation = mobileNavigationRef.current;
    const activeButton = navigation?.querySelector<HTMLElement>(
      `[data-section-nav-id="${activeSection}"]`,
    );
    if (!navigation || !activeButton) return;
    const frame = window.requestAnimationFrame(() => {
      const navigationRect = navigation.getBoundingClientRect();
      const activeRect = activeButton.getBoundingClientRect();
      const maxScrollLeft = Math.max(0, navigation.scrollWidth - navigation.clientWidth);
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      navigation.scrollTo({
        left: settingsHorizontalScrollTarget(
          navigation.scrollLeft,
          navigationRect.left,
          navigationRect.width,
          activeRect.left,
          activeRect.width,
          maxScrollLeft,
        ),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSection, open]);

  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    void flushConfig()
      .then(() => {
        setClosing(false);
        onClose();
      })
      .catch((cause) => {
        setClosing(false);
        setError(cause instanceof Error ? cause.message : t("settings.configSaveFailed"));
      });
  }, [closing, flushConfig, onClose, t]);

  useEscapeDismiss(open, requestClose);

  const scrollToSection = (id: SettingsSectionId) => {
    const container = scrollRef.current;
    const section = container?.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
    if (!container || !section) return;
    setActiveSection(id);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({
      top: settingsScrollTarget(
        container.scrollTop,
        container.getBoundingClientRect().top,
        section.getBoundingClientRect().top,
      ),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const handleScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const container = scrollRef.current;
      if (!container) return;
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
        const lastSection = settingsSections.at(-1)?.id ?? "interface";
        setActiveSection((current) => current === lastSection ? current : lastSection);
        return;
      }
      const containerTop = container.getBoundingClientRect().top;
      let closest: SettingsSectionId = settingsSections[0]?.id ?? "interface";
      let minDistance = Number.POSITIVE_INFINITY;
      for (const section of container.querySelectorAll<HTMLElement>("[data-section-id]")) {
        const distance = Math.abs(section.getBoundingClientRect().top - containerTop - 16);
        const sectionId = settingsSections.find((item) => item.id === section.dataset.sectionId)?.id;
        if (distance < minDistance && sectionId) {
          minDistance = distance;
          closest = sectionId;
        }
      }
      setActiveSection((current) => current === closest ? current : closest);
    });
  };

  useEffect(() => () => {
    if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current);
  }, []);

  if (!open) return null;

  return (
    <div className="ob-overlay z-[120] p-2 sm:p-5">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="ob-dialog ob-surface-glass flex w-full max-w-5xl flex-col overflow-hidden shadow-[var(--ob-elev-2)] transition-all duration-300 ease-out"
      >
        <header className="flex min-h-16 items-center gap-4 border-b border-[var(--ob-line)] px-4 sm:px-6">
          <div>
            <p className="ob-page-kicker">{t("settings.kicker")}</p>
            <h2 id="settings-title" className="text-lg font-semibold tracking-tight">{t("settings.title")}</h2>
            <p className="text-xs text-[var(--ob-muted)]">{t("settings.subtitle")}</p>
          </div>
          <span className="ob-status-chip hidden sm:inline-flex" data-tone="info">{t("settings.autoSave")}</span>
          <div className="ml-auto flex items-center gap-2">
            <kbd className="hidden sm:inline-flex items-center rounded border border-[var(--ob-line)] bg-[var(--ob-surface-2)] px-1.5 py-0.5 text-[0.65rem] font-medium tracking-wide text-[var(--ob-muted)] shadow-xs">ESC</kbd>
            <button
              type="button"
              aria-label={t("settings.close")}
              aria-busy={closing}
              title={closing ? t("settings.saving") : t("settings.close")}
              className="ob-icon-btn transition-colors duration-200 hover:bg-[var(--ob-surface-3)]"
              disabled={closing}
              onClick={requestClose}
            >
              {closing ? <RefreshCw className="animate-spin" size={17} /> : <X size={18} />}
            </button>
          </div>
        </header>

        <SettingsFeedbackBar error={error} feedback={feedback} />

        <nav ref={mobileNavigationRef} className="ob-settings-tabbar" aria-label={t("settings.sections")}>
          {settingsSections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                type="button"
                className="ob-settings-tabbar-item transition-colors duration-200 hover:bg-[var(--ob-panel)] active:bg-[var(--ob-surface-2)]"
                data-active={activeSection === section.id}
                data-section-nav-id={section.id}
                aria-current={activeSection === section.id ? "location" : undefined}
                onClick={() => scrollToSection(section.id)}
              >
                <Icon size={13} />
                {t(section.labelKey)}
              </button>
            );
          })}
        </nav>

        <div className="flex min-h-0 flex-1">
          <nav className="ob-settings-sidebar" aria-label={t("settings.sections")}>
            {settingsSections.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  type="button"
                  className="ob-settings-sidebar-link"
                  data-active={activeSection === section.id}
                  aria-current={activeSection === section.id ? "location" : undefined}
                  onClick={() => scrollToSection(section.id)}
                >
                  <Icon size={14} />
                  {t(section.labelKey)}
                </button>
              );
            })}
          </nav>

          <div
            ref={scrollRef}
            data-settings-scroll-container
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-5 text-sm sm:px-6"
          >
            <SettingsInterfaceSection />
            <SettingsModelsSection
              tenantOwner={tenantOwner}
              policyLoad={policyLoad}
              tenantPolicy={tenantPolicy}
              notices={notices}
            />
            <SettingsGenerationSection />
            <SettingsUsageSection
              snapshot={auth?.usageSnapshot ?? null}
              onRefresh={() => { void auth?.refreshUsage(); }}
            />
            <SettingsToolbarSection />
            <SettingsDataSection
              tenantOwner={tenantOwner}
              policyLoad={policyLoad}
              tenantPolicy={tenantPolicy}
              notices={notices}
            />
            <div className="mt-5 flex items-start gap-2 border-t border-[var(--ob-line)] pt-4 text-xs text-[var(--ob-muted)]">
              <ShieldCheck className="mt-0.5 shrink-0" size={15} />
              <p>{t("settings.securityHint")}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
