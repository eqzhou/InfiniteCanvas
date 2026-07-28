import { normalizeModelCatalog } from "@/lib/model-catalog";

export type AuthUser = {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: string;
  /** Remaining compute credits. Present once the session is authenticated. */
  credits?: number;
  status?: string;
};

export type UsageSnapshot = {
  storageBytes: number;
  generationThisMonth: number;
  storageQuotaBytes: number;
  generationQuotaMonthly: number;
  plan: string;
  /** Remaining compute credits mirrored from the session user. */
  credits?: number;
};

const SESSION_KEY = "openboard:session";

export class AuthHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthHttpError";
    this.status = status;
  }
}

export function isAuthDisabledError(error: unknown): boolean {
  return error instanceof AuthHttpError && error.status === 404;
}

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  try {
    if (!token) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearSessionToken(): void {
  setSessionToken(null);
}

/** Picks up Linux.do OAuth redirect fragment and stores the session, then strips the hash. */
export function consumeOAuthSessionFragment(
  href: string = typeof window !== "undefined" ? window.location.href : "",
): string | null {
  if (!href || !href.includes("#")) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = (params.get("openboard_session") ?? "").trim();
  if (!token) return null;
  setSessionToken(token);
  params.delete("openboard_session");
  const nextHash = params.toString();
  try {
    const next = `${url.pathname}${url.search}${nextHash ? `#${nextHash}` : ""}`;
    if (typeof window !== "undefined" && typeof window.history?.replaceState === "function") {
      window.history.replaceState(window.history.state, "", next);
    }
  } catch {
    /* ignore history rewrite failures */
  }
  return token;
}


/** Shared fetch for /api with optional user session header. */
export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? undefined);
  const token = getSessionToken();
  if (token) headers.set("X-OpenBoard-Session", token);
  if (init?.body && !headers.has("Content-Type") && !(init.body instanceof FormData) && !(init.body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`/api/${path.replace(/^\/+/, "")}`, {
    ...init,
    headers,
    credentials: "same-origin",
    redirect: "error",
  });
}

export const apiRequest = authFetch;

async function parseJSON<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AuthHttpError(response.status, text || `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function register(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ user: AuthUser; sessionToken: string }> {
  const result = await parseJSON<{ user: AuthUser; sessionToken: string }>(
    await authFetch("auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName }),
    }),
  );
  setSessionToken(result.sessionToken);
  return result;
}

export async function login(
  email: string,
  password: string,
): Promise<{ user: AuthUser; sessionToken: string }> {
  const result = await parseJSON<{ user: AuthUser; sessionToken: string }>(
    await authFetch("auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  );
  setSessionToken(result.sessionToken);
  return result;
}

export async function logout(): Promise<void> {
  try {
    await authFetch("auth/logout", { method: "POST" });
  } finally {
    clearSessionToken();
  }
}

export type MeResponse = {
  user: AuthUser;
  authMode: string;
  /** True when the server synthesized a guest placeholder instead of a real session. */
  guest?: boolean;
};

export async function me(): Promise<MeResponse> {
  const response = await authFetch("auth/me");
  if (response.status === 404) {
    throw new AuthHttpError(404, "auth unavailable");
  }
  return parseJSON(response);
}

export async function usage(): Promise<UsageSnapshot> {
  return parseJSON(await authFetch("auth/usage"));
}

export type CreditEstimate = {
  model: string;
  units: number;
  creditsPerUnit: number;
  totalCredits: number;
  balance: number;
  sufficient: boolean;
};

/**
 * Pre-flight cost for a generation. Mirrors GET /api/billing/estimate so the
 * generate button can show "预计消耗 N 算力" before the request is submitted.
 */
export async function estimateCredits(model: string, units = 1): Promise<CreditEstimate> {
  const cleanModel = model.trim();
  const cleanUnits = Number.isSafeInteger(units) && units >= 1 && units <= 100 ? units : 1;
  const params = new URLSearchParams();
  if (cleanModel) params.set("model", cleanModel);
  params.set("units", String(cleanUnits));
  return parseJSON(await authFetch(`billing/estimate?${params.toString()}`));
}

/** Compact button label fragment, e.g. " · 预计 3 算力". Empty when free/unknown. */
export function formatEstimateSuffix(estimate: CreditEstimate | null | undefined): string {
  if (!estimate) return "";
  if (!Number.isFinite(estimate.totalCredits) || estimate.totalCredits <= 0) return "";
  return ` · 预计 ${estimate.totalCredits} 算力`;
}

export function formatUsageChip(snapshot: UsageSnapshot): string {
  const plan = snapshot.plan || "free";
  const used = snapshot.generationThisMonth ?? 0;
  const quota = snapshot.generationQuotaMonthly ?? 0;
  const base = `${plan} · 本月生成 ${used}/${quota}`;
  // Credits are the balance that actually gates generation (402). Surface them
  // next to the monthly quota so users see a low balance before they click run.
  if (typeof snapshot.credits === "number" && Number.isFinite(snapshot.credits)) {
    return `${base} · 算力 ${snapshot.credits}`;
  }
  return base;
}

export type SitePolicy = {
  allowRegister: boolean;
  allowCustomChannel: boolean;
  allowCloudChannel: boolean;
  /** Tenant model governance. Empty availableModels means "no restriction". */
  availableModels?: string[];
  defaultModel?: string;
  defaultTextModel?: string;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  defaultAudioModel?: string;
};

export const DEFAULT_SITE_POLICY: SitePolicy = {
  allowRegister: true,
  allowCustomChannel: true,
  allowCloudChannel: true,
};

export async function getSitePolicy(): Promise<SitePolicy> {
  try {
    const response = await authFetch("site-policy");
    if (!response.ok) return { ...DEFAULT_SITE_POLICY };
    const data = (await response.json()) as Partial<SitePolicy>;
    return {
      allowRegister: data.allowRegister !== false,
      allowCustomChannel: data.allowCustomChannel !== false,
      allowCloudChannel: data.allowCloudChannel !== false,
      ...normalizeModelCatalog(data),
    };
  } catch {
    return { ...DEFAULT_SITE_POLICY };
  }
}

export async function updateSitePolicy(policy: SitePolicy): Promise<SitePolicy> {
  return parseJSON<SitePolicy>(
    await authFetch("site-policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }),
  );
}
