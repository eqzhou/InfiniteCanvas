export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
export type AppLocale = typeof SUPPORTED_LOCALES[number];

const zhCN = {
  "nav.canvas": "画布",
  "nav.assets": "素材",
  "nav.serverLibrary": "服务器素材",
  "nav.aiLogs": "AI 日志",
  "nav.prompts": "提示词",
  "nav.plugins": "插件",
  "nav.workbench": "工作台",
  "nav.tasks": "任务",
  "nav.admin": "管理",
  "settings.kicker": "工作区",
  "settings.title": "设置",
  "settings.subtitle": "工作区配置 · 模型、生成偏好、对象存储与备份",
  "settings.interface": "界面",
  "settings.interfaceDescription": "语言、数字和日期显示偏好",
  "settings.language": "界面语言",
  "settings.languageDescription": "切换后立即生效，并随工作区配置保存。",
  "locale.zhCN": "简体中文",
  "locale.enUS": "English",
  "usage.generations": "团队本月生成 {current}/{limit}",
  "test.zhOnly": "仅中文回退",
} as const;

export type MessageKey = keyof typeof zhCN;
type MessageParams = Readonly<Record<string, string | number>>;

const enUS: Partial<Record<MessageKey, string>> = {
  "nav.canvas": "Canvas",
  "nav.assets": "Assets",
  "nav.serverLibrary": "Server assets",
  "nav.aiLogs": "AI logs",
  "nav.prompts": "Prompts",
  "nav.plugins": "Plugins",
  "nav.workbench": "Workbench",
  "nav.tasks": "Tasks",
  "nav.admin": "Admin",
  "settings.kicker": "Workspace",
  "settings.title": "Settings",
  "settings.subtitle": "Workspace configuration · models, generation, storage, and backups",
  "settings.interface": "Interface",
  "settings.interfaceDescription": "Language, number, and date display preferences",
  "settings.language": "Interface language",
  "settings.languageDescription": "Changes apply immediately and are saved with workspace settings.",
  "locale.zhCN": "简体中文",
  "locale.enUS": "English",
  "usage.generations": "Team generations {current}/{limit}",
};

export function normalizeLocale(value: unknown): AppLocale | undefined {
  return value === "zh-CN" || value === "en-US" ? value : undefined;
}

export function detectSupportedLocale(languages: readonly string[]): AppLocale {
  for (const language of languages) {
    const normalized = language.trim().toLowerCase();
    if (normalized === "en-us" || normalized.startsWith("en-us-")) return "en-US";
    if (normalized === "zh-cn" || normalized.startsWith("zh-hans")) return "zh-CN";
  }
  return "zh-CN";
}

export function translate(locale: AppLocale, key: MessageKey, params: MessageParams = {}): string {
  const template = (locale === "en-US" ? enUS[key] : undefined) ?? zhCN[key];
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}

export function formatNumber(locale: AppLocale, value: number): string {
  return new Intl.NumberFormat(locale).format(Number.isFinite(value) ? value : 0);
}

export function formatBytes(locale: AppLocale, bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.round(safe)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = safe / 1024;
  let unit: typeof units[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}
