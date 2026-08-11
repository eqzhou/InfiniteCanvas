import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AuthUser, SitePolicy } from "@/services/auth-session";
import { DEFAULT_SITE_POLICY, getSitePolicy, login, register } from "@/services/auth-session";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator } from "@/i18n/messages/agent-help";

type AuthTab = "login" | "register";

type AuthPanelProps = {
  onSuccess: (user: AuthUser) => void;
  beforeAuthenticate?: () => Promise<void>;
};

export function AuthPanel({ onSuccess, beforeAuthenticate }: AuthPanelProps) {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  const [tab, setTab] = useState<AuthTab>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<SitePolicy>(DEFAULT_SITE_POLICY);
  const [policyLoaded, setPolicyLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSitePolicy()
      .then((next) => {
        if (cancelled) return;
        setPolicy(next);
        if (!next.allowRegister) setTab("login");
      })
      .finally(() => {
        if (!cancelled) setPolicyLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (tab === "register" && !policy.allowRegister) {
      setError(t("auth.registerClosed"));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await beforeAuthenticate?.();
      const result =
        tab === "login"
          ? await login(email, password)
          : await register(email, password, displayName || undefined);
      onSuccess(result.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: AuthTab; label: string }> = policy.allowRegister
    ? [
        { id: "login", label: t("auth.login") },
        { id: "register", label: t("auth.register") },
      ]
    : [{ id: "login", label: t("auth.login") }];

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="ob-surface-glass w-full max-w-md p-6 shadow-[var(--ob-elev-2)] sm:p-8">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 inline-grid h-11 w-11 place-items-center rounded-xl bg-[var(--ob-accent)] text-base font-bold text-white shadow-sm">
            OB
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--ob-ink)]">
            {t("auth.accountTitle")}
          </h1>
          <p className="mt-1 text-sm text-[var(--ob-muted)]">
            {t("auth.accountDescription")}
          </p>
        </div>

        {tabs.length > 1 ? (
          <div
            role="tablist"
            aria-label={t("auth.loginOrRegister")}
            className="mb-5 grid grid-cols-2 gap-1 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-bg)] p-1"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                className={
                  tab === item.id
                    ? "rounded-md bg-[var(--ob-panel)] px-3 py-2 text-sm font-medium text-[var(--ob-ink)] shadow-sm"
                    : "rounded-md px-3 py-2 text-sm font-medium text-[var(--ob-muted)] hover:text-[var(--ob-ink)]"
                }
                onClick={() => {
                  setTab(item.id);
                  setError(null);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="mb-5 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-bg)] px-3 py-2 text-center text-xs text-[var(--ob-muted)]">
            {policyLoaded ? t("auth.loginOnly") : t("auth.loadingPolicy")}
          </p>
        )}

        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          {tab === "register" ? (
            <label className="block space-y-1.5">
              <span className="text-sm text-[var(--ob-muted)]">{t("auth.displayNameOptional")}</span>
              <input
                className="ob-field"
                type="text"
                name="displayName"
                autoComplete="nickname"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("auth.nicknamePlaceholder")}
                disabled={busy}
              />
            </label>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-sm text-[var(--ob-muted)]">{t("auth.email")}</span>
            <input
              className="ob-field"
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              disabled={busy}
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm text-[var(--ob-muted)]">{t("auth.password")}</span>
            <input
              className="ob-field"
              type="password"
              name="password"
              autoComplete={tab === "login" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("auth.passwordPlaceholder")}
              disabled={busy}
            />
          </label>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-[var(--ob-danger)] bg-[color-mix(in_srgb,var(--ob-danger)_10%,transparent)] px-3 py-2 text-sm text-[var(--ob-danger)]"
            >
              {error}
            </div>
          ) : null}

          <button type="submit" className="ob-btn-primary w-full" disabled={busy}>
            {busy ? t("auth.working") : tab === "login" ? t("auth.login") : t("auth.registerAndLogin")}
          </button>
        </form>
      </div>
    </div>
  );
}
