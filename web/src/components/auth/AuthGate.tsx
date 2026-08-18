import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AuthUser, UsageSnapshot } from "@/services/auth-session";
import {
  AuthHttpError,
  clearSessionToken,
  formatUsageChip,
  consumeOAuthSessionFragment,
  getSessionToken,
  isAuthDisabledError,
  logout as logoutSession,
  me,
  usage,
} from "@/services/auth-session";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

type AuthStatus = "loading" | "open" | "authenticated" | "login_required";

/**
 * Authentication and workspace hydration are separate readiness boundaries.
 * Reveal the authenticated shell first; pages already render their own
 * workspace loading state while the (potentially large) project catalog loads.
 */
export function revealAuthBeforeWorkspaceReady(
  status: Extract<AuthStatus, "open" | "authenticated">,
  reveal: (status: Extract<AuthStatus, "open" | "authenticated">) => void,
  hydrate: () => Promise<void>,
  reportError: (error: unknown) => void = (error) =>
    console.error("OpenBoard workspace hydration failed", error),
): void {
  reveal(status);
  void Promise.resolve().then(hydrate).catch(reportError);
}

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  usageSnapshot: UsageSnapshot | null;
  usageLabel: string | null;
  refreshUsage: () => Promise<void>;
  logout: () => Promise<void>;
  localAdmin: boolean;
  /** True when a guest should be offered a way back to the sign-in form. */
  canLogin: boolean;
  /** Shows the sign-in form. No-op unless `canLogin` is true. */
  requestLogin: () => void;
};

/**
 * Whether an identity is the synthesized guest rather than a real account.
 *
 * In `optional` mode the server answers `/api/auth/me` with 200 and a
 * `role: "guest"` placeholder instead of 401. The SPA still treats that as
 * unsigned and shows the login wall; taking the 200 at face value would hide
 * sign-in while data-plane writes still need a real session.
 */
export function isGuestIdentity(user: (AuthUser & { guest?: boolean }) | null): boolean {
  if (!user) return true;
  return user.guest === true || user.role === "guest" || user.id === "";
}

/**
 * Whether to expose a sign-in entry point.
 *
 * Guests and null identities need a path back to the form when accounts are
 * enabled. Authentication being disabled (`localAdmin`) grants full local
 * access with no account to sign into, and a signed-in user has no use for it.
 */
export function shouldOfferLogin(
  status: AuthStatus,
  user: AuthUser | null,
  localAdmin: boolean,
): boolean {
  if (localAdmin || status === "loading" || status === "login_required") return false;
  return isGuestIdentity(user);
}

/**
 * When authentication is enabled (not localAdmin/auth-off), unsigned visitors
 * must hit the login wall. The current browser URL is left alone so a deep link
 * like /prompts is restored after a successful sign-in.
 */
/** How /api/auth/me failures should land the gate. Only 404 means auth is off. */
export function authMeFailureAction(error: unknown): "auth_off" | "login_required" {
  return isAuthDisabledError(error) ? "auth_off" : "login_required";
}

export function requiresLoginWall(
  status: AuthStatus,
  user: AuthUser | null,
  localAdmin: boolean,
): boolean {
  if (localAdmin) return false;
  if (status === "loading" || status === "authenticated") return false;
  if (status === "login_required") return true;
  // open status with a guest/null identity still needs the wall.
  return isGuestIdentity(user);
}

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
  onReady: (scope: string) => void | Promise<void>;
  onBeforeScopeChange: () => Promise<void>;
  onScopeCredentialsChanged: () => void;
};

export function createScopeReadyCoordinator(
  onReady: (scope: string) => void | Promise<void>,
): (scope: string) => Promise<void> {
  let completedScope: string | undefined;
  let inFlight: { scope: string; promise: Promise<void> } | undefined;
  return async (scope: string) => {
    if (completedScope === scope) return;
    if (inFlight?.scope === scope) return inFlight.promise;
    const promise = Promise.resolve(onReady(scope)).then(() => {
      completedScope = scope;
    }).finally(() => {
      if (inFlight?.promise === promise) inFlight = undefined;
    });
    inFlight = { scope, promise };
    return promise;
  };
}

export async function transitionWorkspaceIdentity(
  flushCurrentScope: () => Promise<void>,
  changeCredentials: () => Promise<void>,
  hydrateNextScope: () => Promise<void>,
): Promise<void> {
  await flushCurrentScope();
  await changeCredentials();
  await hydrateNextScope();
}

export function AuthGate({ children, onReady, onBeforeScopeChange, onScopeCredentialsChanged }: AuthGateProps) {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
  const [localAdmin, setLocalAdmin] = useState(false);
  const readyScopeRef = useRef("open");
  const readyCoordinator = useMemo(() => createScopeReadyCoordinator(onReady), [onReady]);

  const loadUsage = useCallback(async () => {
    try {
      const snapshot = await usage();
      setUsageSnapshot(snapshot);
    } catch {
      setUsageSnapshot(null);
    }
  }, []);

  const finishReady = useCallback(async () => {
    await readyCoordinator(readyScopeRef.current);
  }, [readyCoordinator]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        consumeOAuthSessionFragment();
        const result = await me();
        if (cancelled) return;
        // optional mode answers with a synthetic guest. That is not a signed-in
        // account — force the login wall and keep the deep link for return.
        if (result.guest === true || isGuestIdentity(result.user)) {
          // Auth is enabled: guests may not browse app surfaces. Keep the current
          // URL so login returns the user to the page they tried to open.
          setUser(result.user);
          readyScopeRef.current = "open";
          setLocalAdmin(false);
          setUsageSnapshot(null);
          setStatus("login_required");
          return;
        }
        setUser(result.user);
        readyScopeRef.current = result.user.tenantId;
        setLocalAdmin(false);
        revealAuthBeforeWorkspaceReady("authenticated", setStatus, finishReady);
        void loadUsage();
      } catch (error) {
        if (cancelled) return;
        if (authMeFailureAction(error) === "auth_off") {
          setUser(null);
          readyScopeRef.current = "open";
          setLocalAdmin(true);
          setUsageSnapshot(null);
          revealAuthBeforeWorkspaceReady("open", setStatus, finishReady);
          return;
        }
        const hadSession = Boolean(getSessionToken());
        setUser(null);
        readyScopeRef.current = "open";
        setLocalAdmin(false);
        setUsageSnapshot(null);
        if (hadSession && error instanceof AuthHttpError && error.status === 401) {
          clearSessionToken();
        }
        setStatus("login_required");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [finishReady, loadUsage]);

  const handleAuthSuccess = useCallback(
    async (nextUser: AuthUser) => {
      setStatus("loading");
      onScopeCredentialsChanged();
      setUser(nextUser);
      readyScopeRef.current = nextUser.tenantId;
      setLocalAdmin(false);
      revealAuthBeforeWorkspaceReady("authenticated", setStatus, finishReady);
      void loadUsage();
    },
    [finishReady, loadUsage, onScopeCredentialsChanged],
  );

  const logout = useCallback(async () => {
    setStatus("loading");
    await transitionWorkspaceIdentity(
      onBeforeScopeChange,
      async () => {
        try {
          await logoutSession();
        } catch {
          // Local logout still proceeds when the server is unreachable.
        } finally {
          clearSessionToken();
          onScopeCredentialsChanged();
          setUser(null);
          readyScopeRef.current = "open";
          setLocalAdmin(false);
          setUsageSnapshot(null);
        }
      },
      finishReady,
    );
    setStatus("login_required");
  }, [finishReady, onBeforeScopeChange, onScopeCredentialsChanged]);

  /**
   * Shows the sign-in form to a guest. Guarded by the same rule the entry point
   * uses so a stray call cannot strand a signed-in user on the login wall.
   */
  const requestLogin = useCallback(() => {
    setStatus((current) => (shouldOfferLogin(current, user, localAdmin) ? "login_required" : current));
  }, [localAdmin, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      usageSnapshot,
      usageLabel: usageSnapshot ? formatUsageChip(usageSnapshot) : null,
      refreshUsage: loadUsage,
      logout,
      localAdmin,
      canLogin: shouldOfferLogin(status, user, localAdmin),
      requestLogin,
    }),
    [loadUsage, localAdmin, logout, requestLogin, status, usageSnapshot, user],
  );

  if (status === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--ob-muted)]">
        {t("auth.checking")}
      </div>
    );
  }

  if (status === "login_required") {
    return (
      <AuthContext.Provider value={value}>
        <div className="flex h-full flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 shadow-[var(--ob-elev-1)] backdrop-blur-md">
            <span className="inline-grid h-8 w-8 place-items-center rounded-lg bg-[var(--ob-accent)] text-sm font-bold tracking-tight text-white shadow-[0_2px_8px_color-mix(in_srgb,var(--ob-accent)_40%,transparent)]">
              OB
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--ob-ink)]">OpenBoard</p>
              <p className="truncate text-xs text-[var(--ob-muted)]">{t("auth.continueHint")}</p>
            </div>
          </header>
          <div className="min-h-0 flex-1">
            <AuthPanel
              beforeAuthenticate={onBeforeScopeChange}
              onSuccess={(next) => void handleAuthSuccess(next)}
            />
          </div>
        </div>
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
