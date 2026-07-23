import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AuthUser, UsageSnapshot } from "@/services/auth-session";
import {
  AuthHttpError,
  clearSessionToken,
  formatUsageChip,
  logout as logoutSession,
  me,
  usage,
} from "@/services/auth-session";
import { AuthPanel } from "@/components/auth/AuthPanel";

type AuthStatus = "loading" | "open" | "authenticated" | "login_required";

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  usageSnapshot: UsageSnapshot | null;
  usageLabel: string | null;
  refreshUsage: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthGate");
  }
  return value;
}

/** Safe optional access for surfaces that may render outside AuthGate in tests. */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}

type AuthGateProps = {
  children: ReactNode;
  onReady: () => void | Promise<void>;
};

export function AuthGate({ children, onReady }: AuthGateProps) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  const loadUsage = useCallback(async () => {
    try {
      const snapshot = await usage();
      setUsageSnapshot(snapshot);
    } catch {
      setUsageSnapshot(null);
    }
  }, []);

  const finishReady = useCallback(async () => {
    if (bootstrapped) return;
    setBootstrapped(true);
    await onReady();
  }, [bootstrapped, onReady]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await me();
        if (cancelled) return;
        setUser(result.user);
        setStatus("authenticated");
        await loadUsage();
        await finishReady();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof AuthHttpError && error.status === 401) {
          setUser(null);
          setUsageSnapshot(null);
          setStatus("login_required");
          return;
        }
        // 404 (auth off) or network error → open / backward-compatible mode
        setUser(null);
        setUsageSnapshot(null);
        setStatus("open");
        await finishReady();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [finishReady, loadUsage]);

  const handleAuthSuccess = useCallback(
    async (nextUser: AuthUser) => {
      setUser(nextUser);
      setStatus("authenticated");
      await loadUsage();
      await finishReady();
    },
    [finishReady, loadUsage],
  );

  const logout = useCallback(async () => {
    try {
      await logoutSession();
    } finally {
      clearSessionToken();
      setUser(null);
      setUsageSnapshot(null);
      // hydratePromise is a module singleton — full reload is the reliable reset
      window.location.reload();
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      usageSnapshot,
      usageLabel: usageSnapshot ? formatUsageChip(usageSnapshot) : null,
      refreshUsage: loadUsage,
      logout,
    }),
    [loadUsage, logout, status, usageSnapshot, user],
  );

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ob-muted)]">
        正在检查登录状态…
      </div>
    );
  }

  if (status === "login_required") {
    return (
      <AuthContext.Provider value={value}>
        <AuthPanel onSuccess={(next) => void handleAuthSuccess(next)} />
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
