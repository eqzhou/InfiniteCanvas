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
  getSessionToken,
  isAuthDisabledError,
  logout as logoutSession,
  me,
  usage,
} from "@/services/auth-session";
import { AuthPanel } from "@/components/auth/AuthPanel";
import {
  keepLocalWorkspaceForSession,
  migrateLocalWorkspace,
  preflightLocalWorkspaceMigration,
  type StorageMigrationPreflight,
} from "@/services/storage";
import {
  LoginMigrationDialog,
  type LoginMigrationPhase,
} from "@/components/auth/LoginMigrationDialog";

type AuthStatus = "loading" | "open" | "authenticated" | "login_required";

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  usageSnapshot: UsageSnapshot | null;
  usageLabel: string | null;
  refreshUsage: () => Promise<void>;
  logout: () => Promise<void>;
  localAdmin: boolean;
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

export async function prepareAuthenticatedWorkspace(
  preflight: () => Promise<StorageMigrationPreflight | null>,
  finishReady: () => void | Promise<void>,
): Promise<StorageMigrationPreflight | null> {
  const result = await preflight();
  if (!result) await finishReady();
  return result;
}

export async function releaseAuthenticatedWorkspace(
  decision: "keep-local" | "migration-complete",
  finishReady: () => void | Promise<void>,
  keepLocal: () => void = keepLocalWorkspaceForSession,
): Promise<void> {
  if (decision === "keep-local") keepLocal();
  await finishReady();
}

export function AuthGate({ children, onReady, onBeforeScopeChange, onScopeCredentialsChanged }: AuthGateProps) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [usageSnapshot, setUsageSnapshot] = useState<UsageSnapshot | null>(null);
  const [localAdmin, setLocalAdmin] = useState(false);
  const readyScopeRef = useRef("open");
  const readyCoordinator = useMemo(() => createScopeReadyCoordinator(onReady), [onReady]);
  const migrationAbortRef = useRef<AbortController | null>(null);
  const [migrationChecking, setMigrationChecking] = useState(false);
  const [migrationPreflight, setMigrationPreflight] = useState<StorageMigrationPreflight | null>(null);
  const [migrationPhase, setMigrationPhase] = useState<LoginMigrationPhase>("idle");
  const [migrationCompleted, setMigrationCompleted] = useState(0);
  const [migrationError, setMigrationError] = useState<string | null>(null);

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

	const checkAuthenticatedMigration = useCallback(async (role: AuthUser["role"]) => {
    setMigrationChecking(true);
    setMigrationError(null);
    try {
      const preflight = await prepareAuthenticatedWorkspace(
			() => preflightLocalWorkspaceMigration({ allowSecrets: role === "owner" || role === "admin" }),
        finishReady,
      );
      setMigrationPreflight(preflight);
      setMigrationCompleted(preflight ? Math.min(
        preflight.inventory.resourceCount,
        preflight.alreadyPresent.length + (preflight.journal?.completedOperationIds.length ?? 0),
      ) : 0);
      setMigrationPhase("idle");
    } catch (cause) {
      keepLocalWorkspaceForSession();
      setMigrationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMigrationChecking(false);
    }
  }, [finishReady]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await me();
        if (cancelled) return;
        setMigrationChecking(true);
        setUser(result.user);
        readyScopeRef.current = result.user.tenantId;
        setLocalAdmin(false);
        setStatus("authenticated");
        await loadUsage();
				await checkAuthenticatedMigration(result.user.role);
      } catch (error) {
        if (cancelled) return;
        // 401 without a stored session means optional/open mode (no login yet).
        // Only require the login wall when a session token exists but is invalid/expired.
        if (error instanceof AuthHttpError && error.status === 401) {
          const hadSession = Boolean(getSessionToken());
          setUser(null);
          readyScopeRef.current = "open";
          setLocalAdmin(false);
          setUsageSnapshot(null);
          if (hadSession) {
            clearSessionToken();
            setStatus("login_required");
            return;
          }
          setStatus("open");
          await finishReady();
          return;
        }
        // 404 (auth off) / network error → open / backward-compatible mode
        setUser(null);
        readyScopeRef.current = "open";
        setLocalAdmin(isAuthDisabledError(error));
        setUsageSnapshot(null);
        setStatus("open");
        await finishReady();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checkAuthenticatedMigration, finishReady, loadUsage]);

  const handleAuthSuccess = useCallback(
    async (nextUser: AuthUser) => {
      setMigrationChecking(true);
      onScopeCredentialsChanged();
      setUser(nextUser);
      readyScopeRef.current = nextUser.tenantId;
      setLocalAdmin(false);
      setStatus("authenticated");
      await loadUsage();
		await checkAuthenticatedMigration(nextUser.role);
    },
    [checkAuthenticatedMigration, loadUsage, onScopeCredentialsChanged],
  );

  const handleMigrate = useCallback(async () => {
    if (!migrationPreflight || migrationPreflight.conflicts.length || migrationPhase === "migrating") return;
    setMigrationPhase("migrating");
    setMigrationError(null);
    const controller = new AbortController();
    migrationAbortRef.current = controller;
    try {
      const result = await migrateLocalWorkspace({
        includeSecrets: migrationPreflight.includeSecrets,
		allowSecrets: migrationPreflight.allowSecrets,
        signal: controller.signal,
        onProgress: (progress) => {
          setMigrationCompleted(Math.min(
            migrationPreflight.inventory.resourceCount,
            migrationPreflight.alreadyPresent.length + progress.completedOperations,
          ));
        },
      });
      if (!result || result.status === "complete") {
        setMigrationCompleted(migrationPreflight.inventory.resourceCount);
        setMigrationPhase("complete");
        return;
      }
      if (result.status === "conflict") {
        const refreshed = await preflightLocalWorkspaceMigration({
          includeSecrets: migrationPreflight.includeSecrets,
					allowSecrets: migrationPreflight.allowSecrets,
        });
        if (refreshed) setMigrationPreflight(refreshed);
        setMigrationPhase("idle");
        setMigrationError("账号数据在迁移期间发生变化，已停止迁移且保留本地副本。");
        return;
      }
      if (result.status === "cancelled") {
        setMigrationPhase("cancelled");
        setMigrationError("迁移已取消。本地副本未清理，稍后可从已完成的批次继续。");
        return;
      }
      setMigrationPhase("error");
      setMigrationError(result.journal.error || "迁移未完成，本地副本已保留，可安全重试。");
    } catch (cause) {
      setMigrationPhase("error");
      setMigrationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (migrationAbortRef.current === controller) migrationAbortRef.current = null;
    }
  }, [migrationPhase, migrationPreflight]);

  const handleIncludeSecretsChange = useCallback(async (includeSecrets: boolean) => {
    if (migrationPhase === "migrating" || !migrationPreflight) return;
    setMigrationChecking(true);
    setMigrationError(null);
    try {
      const refreshed = await preflightLocalWorkspaceMigration({
        includeSecrets: migrationPreflight.allowSecrets && includeSecrets,
        allowSecrets: migrationPreflight.allowSecrets,
      });
      if (refreshed) {
        setMigrationPreflight(refreshed);
        setMigrationCompleted(Math.min(
          refreshed.inventory.resourceCount,
          refreshed.alreadyPresent.length + (refreshed.journal?.completedOperationIds.length ?? 0),
        ));
      }
    } catch (cause) {
      setMigrationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMigrationChecking(false);
    }
  }, [migrationPhase, migrationPreflight]);

  const handleCancelMigration = useCallback(() => {
    migrationAbortRef.current?.abort();
  }, []);

  const handleKeepLocal = useCallback(async () => {
    setMigrationPreflight(null);
    setMigrationError(null);
    await releaseAuthenticatedWorkspace("keep-local", finishReady);
  }, [finishReady]);

  const handleContinue = useCallback(async () => {
    setMigrationPreflight(null);
    setMigrationError(null);
    await releaseAuthenticatedWorkspace("migration-complete", finishReady);
  }, [finishReady]);

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
    setStatus("open");
  }, [finishReady, onBeforeScopeChange, onScopeCredentialsChanged]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      usageSnapshot,
      usageLabel: usageSnapshot ? formatUsageChip(usageSnapshot) : null,
      refreshUsage: loadUsage,
      logout,
      localAdmin,
    }),
    [loadUsage, localAdmin, logout, status, usageSnapshot, user],
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
        <AuthPanel
          beforeAuthenticate={onBeforeScopeChange}
          onSuccess={(next) => void handleAuthSuccess(next)}
        />
      </AuthContext.Provider>
    );
  }

  if (status === "authenticated" && migrationChecking) {
    return (
      <AuthContext.Provider value={value}>
        <div className="flex h-full items-center justify-center text-sm text-[var(--ob-muted)]">
          正在检查本地工作区…
        </div>
      </AuthContext.Provider>
    );
  }

  if (status === "authenticated" && migrationError && !migrationPreflight) {
    return (
      <AuthContext.Provider value={value}>
        <div className="flex min-h-full items-center justify-center p-4">
          <section role="alertdialog" aria-modal="true" className="ob-surface-glass w-full max-w-lg p-6 shadow-[var(--ob-elev-2)]">
            <h1 className="text-lg font-semibold">无法检查本地工作区</h1>
            <p className="mt-2 text-sm text-[var(--ob-danger)]">{migrationError}</p>
            <p className="mt-2 text-sm text-[var(--ob-muted)]">没有迁移或清理任何本地数据。你可以重试检查，或保留本地数据进入账号工作区。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="ob-btn" onClick={() => void handleKeepLocal()}>保留本地并进入</button>
              <button type="button" className="ob-btn-primary" onClick={() => void checkAuthenticatedMigration(user?.role ?? "")}>重试检查</button>
            </div>
          </section>
        </div>
      </AuthContext.Provider>
    );
  }

  if (status === "authenticated" && migrationPreflight) {
    return (
      <AuthContext.Provider value={value}>
        <LoginMigrationDialog
          preflight={migrationPreflight}
          phase={migrationPhase}
          completedOperations={migrationCompleted}
          availableBytes={usageSnapshot
            ? Math.max(0, usageSnapshot.storageQuotaBytes - usageSnapshot.storageBytes)
            : null}
          error={migrationError}
          credentials={migrationPreflight.credentials}
          includeSecrets={migrationPreflight.includeSecrets}
          onIncludeSecretsChange={(include) => void handleIncludeSecretsChange(include)}
          onMigrate={() => void handleMigrate()}
          onCancel={handleCancelMigration}
          onKeepLocal={() => void handleKeepLocal()}
          onContinue={() => void handleContinue()}
        />
      </AuthContext.Provider>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
