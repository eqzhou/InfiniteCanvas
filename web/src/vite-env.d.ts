/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_RELEASES__: import("@/lib/release").ReleaseInfo[];

interface ImportMetaEnv {
  readonly VITE_ANALYTICS_GA4_ID?: string;
  readonly VITE_ANALYTICS_BAIDU_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
