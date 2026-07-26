import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AuthUser, SitePolicy } from "@/services/auth-session";
import { DEFAULT_SITE_POLICY, getSitePolicy, login, register } from "@/services/auth-session";

type AuthTab = "login" | "register";

type AuthPanelProps = {
  onSuccess: (user: AuthUser) => void;
  beforeAuthenticate?: () => Promise<void>;
};

export function AuthPanel({ onSuccess, beforeAuthenticate }: AuthPanelProps) {
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
      setError("管理员已关闭开放注册");
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
        { id: "login", label: "登录" },
        { id: "register", label: "注册" },
      ]
    : [{ id: "login", label: "登录" }];

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="ob-surface-glass w-full max-w-md p-6 shadow-[var(--ob-elev-2)] sm:p-8">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 inline-grid h-11 w-11 place-items-center rounded-xl bg-[var(--ob-accent)] text-base font-bold text-white shadow-sm">
            OB
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--ob-ink)]">
            OpenBoard 账号
          </h1>
          <p className="mt-1 text-sm text-[var(--ob-muted)]">
            登录后同步画布、素材与生成历史
          </p>
        </div>

        {tabs.length > 1 ? (
          <div
            role="tablist"
            aria-label="登录或注册"
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
            {policyLoaded ? "当前站点仅允许登录，开放注册已由管理员关闭。" : "正在加载站点策略…"}
          </p>
        )}

        <form className="space-y-3" onSubmit={(event) => void submit(event)}>
          {tab === "register" ? (
            <label className="block space-y-1.5">
              <span className="text-sm text-[var(--ob-muted)]">显示名称（可选）</span>
              <input
                className="ob-field"
                type="text"
                name="displayName"
                autoComplete="nickname"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="昵称"
                disabled={busy}
              />
            </label>
          ) : null}

          <label className="block space-y-1.5">
            <span className="text-sm text-[var(--ob-muted)]">邮箱</span>
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
            <span className="text-sm text-[var(--ob-muted)]">密码</span>
            <input
              className="ob-field"
              type="password"
              name="password"
              autoComplete={tab === "login" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 6 位"
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
            {busy ? "请稍候…" : tab === "login" ? "登录" : "注册并登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
