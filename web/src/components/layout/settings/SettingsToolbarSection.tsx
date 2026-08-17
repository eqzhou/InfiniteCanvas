import { MousePointerClick } from "lucide-react";
import { useBoardStore } from "@/stores/use-board-store";
import { useI18n } from "@/i18n/I18nProvider";
import { ImageToolbarPreferencesEditor } from "@/components/layout/ImageToolbarPreferencesEditor";

export function SettingsToolbarSection() {
  const { t } = useI18n();
  const imageToolbar = useBoardStore((state) => state.config.imageToolbar);
  const setConfig = useBoardStore((state) => state.setConfig);
  return (
    <section className="ob-settings-section mb-5" data-section-id="toolbar">
      <div className="ob-settings-section-header">
        <span className="ob-settings-section-icon"><MousePointerClick size={14} /></span>
        <div>
          <div className="ob-settings-section-title">{t("settings.imageToolbarTitle")}</div>
          <div className="ob-settings-section-desc">{t("settings.imageToolbarDescription")}</div>
        </div>
      </div>
      <p className="mb-3 text-xs text-[var(--ob-muted)]">
        {t("settings.imageToolbarHint")}
      </p>
      <ImageToolbarPreferencesEditor
        value={imageToolbar}
        onChange={(nextToolbar) => setConfig({
          ...useBoardStore.getState().config,
          imageToolbar: nextToolbar,
        })}
      />
    </section>
  );
}
