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
		const safePath = stripInviteFromUrl(path);
		const safeLocation = typeof window !== "undefined" ? stripInviteFromUrl(window.location.href) : path;
		if (active.ga4 && window.gtag) {
			window.gtag("event", "page_view", {
				page_path: safePath,
				page_location: safeLocation,
			});
		}
		if (active.baidu && window._hmt) {
			window._hmt.push(["_trackPageview", safePath]);
    }
  } catch {
    // ignore analytics failures
  }
}

export function stripInviteFromUrl(raw: string, baseHref = typeof window !== "undefined" ? window.location.href : "http://localhost/"): string {
	try {
		const url = new URL(raw, baseHref);
		url.searchParams.delete("invite");
		if (url.hash) {
			const hashParams = new URLSearchParams(url.hash.slice(1));
			if (hashParams.has("invite")) {
				hashParams.delete("invite");
				url.hash = hashParams.toString() ? `#${hashParams.toString()}` : "";
			}
		}
		if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return url.toString();
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return raw;
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
