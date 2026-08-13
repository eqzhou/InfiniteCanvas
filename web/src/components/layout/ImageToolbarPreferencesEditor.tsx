import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import {
  IMAGE_TOOLBAR_ACTIONS,
  normalizeImageToolbarPreferences,
  type ImageToolbarAction,
  type ImageToolbarPreferences,
} from "@/lib/image-toolbar-preferences";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

const labelKeys: Record<ImageToolbarAction, MessageKey> = {
  generate: "toolbar.generate", video: "toolbar.video", reverse: "toolbar.reverse", crop: "toolbar.crop",
  rotate: "toolbar.rotate", angle: "toolbar.angle", mask: "toolbar.mask", resize: "toolbar.resize",
  "ai-upscale": "toolbar.upscale", split: "toolbar.split", copy: "toolbar.copy", download: "toolbar.download",
  aspect: "toolbar.aspect",
};

function move(
  preferences: ImageToolbarPreferences,
  action: ImageToolbarAction,
  offset: -1 | 1,
): ImageToolbarPreferences {
  const index = preferences.order.indexOf(action);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= preferences.order.length) return preferences;
  const order = [...preferences.order];
  [order[index], order[target]] = [order[target]!, order[index]!];
  return { ...preferences, order };
}

export function ImageToolbarPreferencesEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: ImageToolbarPreferences) => void;
}) {
  const { t } = useI18n();
  const preferences = normalizeImageToolbarPreferences(value);
  const hidden = new Set(preferences.hidden);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--ob-muted)]">
          <input
            type="checkbox"
            checked={preferences.showLabels}
            onChange={(event) => onChange({ ...preferences, showLabels: event.target.checked })}
          />
          {t("toolbar.showLabels")}
        </label>
        <button
          type="button"
          className="ob-btn"
          onClick={() => onChange(normalizeImageToolbarPreferences(undefined))}
        >
          <RotateCcw size={14} /> {t("toolbar.reset")}
        </button>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {preferences.order.map((action, index) => (
          <div key={action} className="flex items-center gap-2 rounded-lg border border-[var(--ob-line)] px-2 py-1.5">
            <input
              aria-label={t("toolbar.show", { label: t(labelKeys[action]) })}
              type="checkbox"
              checked={action === "copy" || action === "download" || !hidden.has(action)}
              disabled={action === "copy" || action === "download"}
              onChange={(event) => onChange({
                ...preferences,
                hidden: event.target.checked
                  ? preferences.hidden.filter((item) => item !== action)
                  : [...preferences.hidden, action],
              })}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{t(labelKeys[action])}</span>
            <button
              type="button"
              className="ob-icon-btn h-7 w-7 transition-colors duration-200"
              aria-label={t("toolbar.moveUp", { label: t(labelKeys[action]) })}
              disabled={index === 0}
              onClick={() => onChange(move(preferences, action, -1))}
            >
              <ArrowUp size={13} />
            </button>
            <button
              type="button"
              className="ob-icon-btn h-7 w-7"
              aria-label={t("toolbar.moveDown", { label: t(labelKeys[action]) })}
              disabled={index === IMAGE_TOOLBAR_ACTIONS.length - 1}
              onClick={() => onChange(move(preferences, action, 1))}
            >
              <ArrowDown size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
