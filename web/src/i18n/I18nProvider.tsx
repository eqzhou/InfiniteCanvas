import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useBoardStore } from "@/stores/use-board-store";
import {
  detectSupportedLocale,
  formatBytes,
  formatNumber,
  normalizeLocale,
  translate,
  type AppLocale,
  type MessageKey,
} from "./core";

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;
  number: (value: number) => string;
  bytes: (value: number) => string;
};

const fallbackContext: I18nContextValue = {
  locale: "zh-CN",
  setLocale: () => undefined,
  t: (key, params) => translate("zh-CN", key, params),
  number: (value) => formatNumber("zh-CN", value),
  bytes: (value) => formatBytes("zh-CN", value),
};

const I18nContext = createContext<I18nContextValue>(fallbackContext);

function browserLocale(): AppLocale {
  if (typeof navigator === "undefined") return "zh-CN";
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return detectSupportedLocale(languages);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const config = useBoardStore((state) => state.config);
  const setConfig = useBoardStore((state) => state.setConfig);
  const locale = normalizeLocale(config.locale) ?? browserLocale();

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale: (next) => setConfig({ ...config, locale: next }),
    t: (key, params) => translate(locale, key, params),
    number: (number) => formatNumber(locale, number),
    bytes: (bytes) => formatBytes(locale, bytes),
  }), [config, locale, setConfig]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
