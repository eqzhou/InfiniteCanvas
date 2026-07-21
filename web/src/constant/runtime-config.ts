// Runtime config: window.__RUNTIME_CONFIG__ (container inject) > VITE_* > empty.
// Analytics only accepts GA4 / Baidu IDs — never arbitrary script URLs.

type RuntimeConfig = {
  ANALYTICS_GA4_ID?: string;
  ANALYTICS_BAIDU_ID?: string;
};

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: RuntimeConfig;
  }
}

const runtime: RuntimeConfig =
  (typeof window !== "undefined" && window.__RUNTIME_CONFIG__) || {};

function read(key: keyof RuntimeConfig, buildTime: string | undefined): string {
  const value = runtime[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof buildTime === "string" && buildTime.trim()) return buildTime.trim();
  return "";
}

export const ANALYTICS_GA4_ID = read(
  "ANALYTICS_GA4_ID",
  import.meta.env.VITE_ANALYTICS_GA4_ID as string | undefined,
);
export const ANALYTICS_BAIDU_ID = read(
  "ANALYTICS_BAIDU_ID",
  import.meta.env.VITE_ANALYTICS_BAIDU_ID as string | undefined,
);
