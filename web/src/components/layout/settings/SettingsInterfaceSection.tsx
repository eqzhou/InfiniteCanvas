import { Check, Languages, Monitor, Moon, Sun } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { useI18n } from "@/i18n/I18nProvider";
import { applyTheme } from "@/lib/theme";
import { SettingsField } from "./SettingsField";

export function SettingsInterfaceSection() {
  const { locale, setLocale, t } = useI18n();
  const theme = useBoardStore((state) => state.config.theme);
  const setConfig = useBoardStore((state) => state.setConfig);

  return (
    <section className="ob-settings-section mb-5" data-section-id="interface">
      <div className="ob-settings-section-header">
        <span className="ob-settings-section-icon"><Languages size={14} /></span>
        <div>
          <div className="ob-settings-section-title">{t("settings.interface")}</div>
          <div className="ob-settings-section-desc">{t("settings.interfaceDescription")}</div>
        </div>
      </div>

      <div className="mb-4">
        <span className="ob-micro-label mb-2">{t("settings.theme")}</span>
        <div className="ob-theme-grid" role="radiogroup" aria-label={t("settings.theme")}>
          {(["light", "dark", "system"] as const).map((mode) => {
            const isActive = theme === mode;
            const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
            const label = mode === "light" ? t("settings.themeLight") : mode === "dark" ? t("settings.themeDark") : t("settings.themeSystem");
            const previewClass = mode === "light" ? "ob-theme-preview-light" : mode === "dark" ? "ob-theme-preview-dark" : "ob-theme-preview-system";
            return (
              <button
                key={mode}
                id={`theme-opt-${mode}`}
                type="button"
                role="radio"
                aria-checked={isActive}
                tabIndex={isActive ? 0 : -1}
                data-active={isActive}
                className="ob-theme-card"
                onClick={() => {
                  applyTheme(mode);
                  setConfig({ ...useBoardStore.getState().config, theme: mode });
                }}
                onKeyDown={(event) => {
                  const allModes = ["light", "dark", "system"] as const;
                  const idx = allModes.indexOf(mode);
                  let next = -1;
                  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (idx + 1) % allModes.length;
                  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (idx - 1 + allModes.length) % allModes.length;
                  if (next >= 0) {
                    event.preventDefault();
                    const target = allModes[next];
                    applyTheme(target);
                    setConfig({ ...useBoardStore.getState().config, theme: target });
                    requestAnimationFrame(() => document.getElementById(`theme-opt-${target}`)?.focus());
                  }
                }}
              >
                {isActive ? (
                  <span className="ob-theme-check-badge" aria-hidden>
                    <Check size={10} strokeWidth={3} />
                  </span>
                ) : null}
                <div className={`ob-theme-preview ${previewClass}`} aria-hidden />
                <span className="ob-theme-card-label"><Icon size={14} />{label}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("settings.themeDescription")}</p>
      </div>

      <div className="border-t border-[color-mix(in_srgb,var(--ob-line)_60%,transparent)] pt-3">
        <SettingsField label={t("settings.language")}>
          <select
            className="ob-field max-w-xs"
            aria-label={t("settings.language")}
            value={locale}
            onChange={(event) => setLocale(event.target.value === "en-US" ? "en-US" : "zh-CN")}
          >
            <option value="zh-CN">{t("locale.zhCN")}</option>
            <option value="en-US">{t("locale.enUS")}</option>
          </select>
        </SettingsField>
        <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("settings.languageDescription")}</p>
      </div>
    </section>
  );
}
