import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import {
  IMAGE_TOOLBAR_ACTIONS,
  normalizeImageToolbarPreferences,
  type ImageToolbarAction,
  type ImageToolbarPreferences,
} from "@/lib/image-toolbar-preferences";

const labels: Record<ImageToolbarAction, string> = {
  generate: "生成/重试",
  video: "生成视频",
  reverse: "反推提示词",
  crop: "裁剪",
  rotate: "旋转",
  angle: "多角度",
  mask: "遮罩/局部编辑",
  resize: "本地尺寸放大",
  "ai-upscale": "AI 超分",
  split: "切分",
  download: "下载（必显）",
  aspect: "等比/自由缩放",
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
          显示工具名称
        </label>
        <button
          type="button"
          className="ob-btn"
          onClick={() => onChange(normalizeImageToolbarPreferences(undefined))}
        >
          <RotateCcw size={14} /> 恢复默认
        </button>
      </div>
      <div className="grid gap-1 sm:grid-cols-2">
        {preferences.order.map((action, index) => (
          <div key={action} className="flex items-center gap-2 rounded-lg border border-[var(--ob-line)] px-2 py-1.5">
            <input
              aria-label={`显示${labels[action]}`}
              type="checkbox"
              checked={action === "download" || !hidden.has(action)}
              disabled={action === "download"}
              onChange={(event) => onChange({
                ...preferences,
                hidden: event.target.checked
                  ? preferences.hidden.filter((item) => item !== action)
                  : [...preferences.hidden, action],
              })}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{labels[action]}</span>
            <button
              type="button"
              className="ob-icon-btn h-7 w-7"
              aria-label={`上移${labels[action]}`}
              disabled={index === 0}
              onClick={() => onChange(move(preferences, action, -1))}
            >
              <ArrowUp size={13} />
            </button>
            <button
              type="button"
              className="ob-icon-btn h-7 w-7"
              aria-label={`下移${labels[action]}`}
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
