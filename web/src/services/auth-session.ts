export type AuthUser = {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: string;
};

export type UsageSnapshot = {
  storageBytes: number;
  generationThisMonth: number;
  storageQuotaBytes: number;
  generationQuotaMonthly: number;
  plan: string;
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

export async function me(): Promise<{ user: AuthUser; authMode: string }> {
  const response = await authFetch("auth/me");
  if (response.status === 404) {
    throw new AuthHttpError(404, "auth unavailable");
  }
  return parseJSON(response);
}

export async function usage(): Promise<UsageSnapshot> {
  return parseJSON(await authFetch("auth/usage"));
}

export function formatUsageChip(snapshot: UsageSnapshot): string {
  const plan = snapshot.plan || "free";
  const used = snapshot.generationThisMonth ?? 0;
  const quota = snapshot.generationQuotaMonthly ?? 0;
  return `${plan} · 本月生成 ${used}/${quota}`;
}
