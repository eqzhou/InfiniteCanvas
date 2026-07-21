import { ANALYTICS_BAIDU_ID, ANALYTICS_GA4_ID } from "@/constant/runtime-config";

type GtagFn = (...args: unknown[]) => void;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: GtagFn;
    _hmt?: unknown[][];
  }
}

let initialized = false;
const active = { ga4: false, baidu: false };

function appendScript(src: string) {
  const el = document.createElement("script");
  el.async = true;
  el.src = src;
  document.head.appendChild(el);
  return el;
}

function initGa4(id: string) {
  window.dataLayer = window.dataLayer || [];
  const gtag: GtagFn = (...args) => {
    window.dataLayer!.push(args);
  };
  window.gtag = gtag;
  appendScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
  gtag("js", new Date());
  gtag("config", id, { send_page_view: false });
  active.ga4 = true;
}

function initBaidu(id: string) {
  window._hmt = window._hmt || [];
  appendScript(`https://hm.baidu.com/hm.js?${encodeURIComponent(id)}`);
  active.baidu = true;
}

/** Safe analytics bootstrap. Empty IDs inject nothing and make no network calls. */
export function initAnalytics() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  if (ANALYTICS_GA4_ID) {
    try {
      initGa4(ANALYTICS_GA4_ID);
    } catch {
      // ignore analytics failures
    }
  }
  if (ANALYTICS_BAIDU_ID) {
    try {
      initBaidu(ANALYTICS_BAIDU_ID);
    } catch {
      // ignore analytics failures
    }
  }
}

export function trackPageview(path: string) {
  try {
    if (active.ga4 && window.gtag) {
      window.gtag("event", "page_view", {
        page_path: path,
        page_location: window.location.href,
      });
    }
    if (active.baidu && window._hmt) {
      window._hmt.push(["_trackPageview", path]);
    }
  } catch {
    // ignore analytics failures
  }
}

/** Test helpers */
export function __resetAnalyticsForTests() {
  initialized = false;
  active.ga4 = false;
  active.baidu = false;
  if (typeof window !== "undefined") {
    delete window.gtag;
    delete window.dataLayer;
    delete window._hmt;
  }
}

export function __analyticsActiveForTests() {
  return { ...active };
}
