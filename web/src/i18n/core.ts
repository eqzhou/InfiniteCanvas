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
  "usage.credits": "个人算力 {credits}",
  "common.close": "关闭",
  "common.loading": "正在加载…",
  "app.connectionParamsInvalid": "连接参数无效：{message}",
  "app.promptSourceRefreshFailed": "提示词来源自动刷新失败：{message}",
  "app.configConflictUnsaved": "{message}，当前修改尚未保存。",
  "app.reloadLatestConfig": "刷新并载入最新配置",
  "nav.mobile": "移动端导航",
  "nav.closeMenu": "关闭导航菜单",
  "nav.openMenu": "打开导航菜单",
  "nav.page": "{label}页面",
  "nav.tools": "工具",
  "nav.exportCanvas": "导出当前画布",
  "nav.exportCanvasBundle": "导出当前画布包",
  "nav.canvasAgent": "画布 Agent",
  "nav.shortcuts": "快捷键",
  "nav.help": "使用帮助",
  "nav.openHelp": "打开使用帮助",
  "nav.theme": "主题",
  "nav.toggleTheme": "切换主题",
  "nav.globalTools": "全局工具",
  "nav.more": "更多",
  "nav.moreActions": "更多操作",
  "nav.closeMoreActions": "关闭更多操作",
  "nav.accountSettings": "账号与设置",
  "nav.signOut": "退出登录",
  "nav.signIn": "登录",
  "nav.settings": "设置",
  "nav.openSettings": "打开设置",
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
  "usage.credits": "Personal credits {credits}",
  "common.close": "Close",
  "common.loading": "Loading…",
  "app.connectionParamsInvalid": "Invalid connection parameters: {message}",
  "app.promptSourceRefreshFailed": "Prompt source refresh failed: {message}",
  "app.configConflictUnsaved": "{message}. Your current changes have not been saved.",
  "app.reloadLatestConfig": "Reload latest configuration",
  "nav.mobile": "Mobile navigation",
  "nav.closeMenu": "Close navigation menu",
  "nav.openMenu": "Open navigation menu",
  "nav.page": "{label} page",
  "nav.tools": "Tools",
  "nav.exportCanvas": "Export current canvas",
  "nav.exportCanvasBundle": "Export current canvas bundle",
  "nav.canvasAgent": "Canvas Agent",
  "nav.shortcuts": "Keyboard shortcuts",
  "nav.help": "Help",
  "nav.openHelp": "Open help",
  "nav.theme": "Theme",
  "nav.toggleTheme": "Toggle theme",
  "nav.globalTools": "Global tools",
  "nav.more": "More",
  "nav.moreActions": "More actions",
  "nav.closeMoreActions": "Close more actions",
  "nav.accountSettings": "Account and settings",
  "nav.signOut": "Sign out",
  "nav.signIn": "Sign in",
  "nav.settings": "Settings",
  "nav.openSettings": "Open settings",
};

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
    .map((match) => match[1]!)
    .sort();
}

export function catalogDiagnostics(): {
  missingEnglish: MessageKey[];
  placeholderMismatches: MessageKey[];
} {
  const keys = Object.keys(zhCN) as MessageKey[];
  return {
    missingEnglish: keys.filter((key) => !enUS[key]),
    placeholderMismatches: keys.filter((key) =>
      placeholders(zhCN[key]).join("\0") !== placeholders(enUS[key] ?? "").join("\0")),
  };
}

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
