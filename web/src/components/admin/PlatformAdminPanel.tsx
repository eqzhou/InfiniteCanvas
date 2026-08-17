import { useEffect, useState } from "react";
import { Building2, RefreshCw, Search, ShieldCheck, Users } from "lucide-react";
import { EmptyState, Notice, SectionHeader } from "@/components/admin/AdminSection";
import { AdminChannelsPanel } from "@/components/admin/AdminChannelsPanel";
import { useI18n } from "@/i18n/I18nProvider";
import {
  getPlatformPolicy,
  updatePlatformPolicy,
  type PlatformPolicy,
} from "@/services/auth-session";
import {
  adjustPlatformCredits,
  listPlatformTenants,
  listPlatformUsers,
  patchPlatformUser,
  putPlatformTenantQuota,
  resetPlatformUserPassword,
  type AdminUser,
  type PlatformTenant,
} from "@/services/admin";
import { PasswordField } from "@/components/auth/PasswordField";
import { PASSWORD_MIN_LENGTH, passwordPolicyError, passwordsMatch } from "@/lib/password-policy";

export function PlatformAdminPanel() {
  const { locale, t } = useI18n();
  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [quotaBusyId, setQuotaBusyId] = useState<string | null>(null);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});

  const load = async () => {
    setBusy(true);
    try {
      const [tenantPage, userPage] = await Promise.all([listPlatformTenants({ q, pageSize: 100 }), listPlatformUsers({ q, pageSize: 100 })]);
      setTenants(tenantPage.items);
      setUsers(userPage.items);
      setQuotaDrafts(Object.fromEntries(tenantPage.items.map((item) => [item.id, String(item.generationQuotaMonthly)])));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const quotaDraftValid = (tenantId: string) => {
    const draft = quotaDrafts[tenantId];
    const value = Number(draft);
    return draft !== undefined && draft !== "" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
  };
  const saveQuota = async (tenant: PlatformTenant) => {
    if (!quotaDraftValid(tenant.id) || quotaBusyId) return;
    setQuotaBusyId(tenant.id);
    setNotice("");
    try {
      const updated = await putPlatformTenantQuota(tenant.id, Number(quotaDrafts[tenant.id]));
      setTenants((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      setError("");
      setNotice(t("admin.platformQuotaSaved"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setQuotaBusyId(null); }
  };

  return (
    <div className="ob-admin-stack" aria-busy={loading || busy}>
      <PlatformPolicySection />

      <div className="ob-toolbar-strip">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t("admin.platformSearch")}</span>
          <input className="ob-field w-full max-w-md" placeholder={t("admin.platformSearch")} value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} />
        </label>
        <button type="button" className="ob-btn" disabled={busy} onClick={() => void load()}><Search size={14} aria-hidden />{t("admin.search")}</button>
        <button type="button" className="ob-icon-btn" aria-label={t("admin.refresh")} title={t("admin.refresh")} disabled={busy} onClick={() => { setQ(""); void load(); }}><RefreshCw size={14} aria-hidden /></button>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <section className="ob-admin-section">
        <SectionHeader
          icon={<Building2 size={16} />}
          title={t("admin.platformTenants")}
          desc={t("admin.platform.tenantsDesc")}
          actions={loading ? null : <span className="ob-micro-label">{t("admin.platform.tenantsCount", { count: tenants.length })}</span>}
        />
        {loading ? <Notice tone="info">{t("admin.platform.loading")}</Notice> : tenants.length === 0 ? (
          <EmptyState title={t("admin.platform.tenantsEmpty")} />
        ) : (
          <div className="ob-table-shell max-h-[46vh]">
            <table className="ob-table min-w-[720px]">
              <thead>
                <tr>
                  <th scope="col">{t("admin.tenantId")}</th>
                  <th scope="col">{t("admin.userCount")}</th>
                  <th scope="col">{t("admin.totalQuota")}</th>
                  <th scope="col">{t("admin.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <div className="font-medium text-[var(--ob-ink)]">{tenant.name}</div>
                      <div className="font-mono text-xs text-[var(--ob-muted)]">{tenant.id}</div>
                    </td>
                    <td data-numeric="true">{(tenant.userCount ?? 0).toLocaleString(locale)}</td>
                    <td>
                      <input
                        className="ob-field w-32 py-1 text-[0.8125rem]"
                        aria-label={`${tenant.name} · ${t("admin.totalQuota")}`}
                        type="number"
                        min={0}
                        max={1_000_000_000}
                        value={quotaDrafts[tenant.id] ?? ""}
                        disabled={quotaBusyId === tenant.id}
                        onChange={(event) => { setNotice(""); setQuotaDrafts((current) => ({ ...current, [tenant.id]: event.target.value })); }}
                      />
                    </td>
                    <td>
                      <button type="button" className="ob-btn" disabled={!quotaDraftValid(tenant.id) || quotaBusyId !== null} onClick={() => void saveQuota(tenant)}>
                        {quotaBusyId === tenant.id ? t("admin.saving") : t("admin.saveTenantQuota")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ob-admin-section">
        <SectionHeader
          icon={<Users size={16} />}
          title={t("admin.platformUsers")}
          desc={t("admin.platform.usersDesc")}
          actions={loading ? null : <span className="ob-micro-label">{t("admin.platform.usersCount", { count: users.length })}</span>}
        />
        {loading ? <Notice tone="info">{t("admin.platform.loading")}</Notice> : users.length === 0 ? (
          <EmptyState title={t("admin.platform.usersEmpty")} />
        ) : (
          <div className="ob-table-shell max-h-[56vh]">
            <table className="ob-table min-w-[900px]">
              <thead>
                <tr>
                  <th scope="col">{t("admin.user")}</th>
                  <th scope="col">{t("admin.tenantId")}</th>
                  <th scope="col">{t("admin.role")}</th>
                  <th scope="col">{t("admin.status")}</th>
                  <th scope="col">{t("admin.creditBalance")}</th>
                  <th scope="col">{t("admin.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <PlatformUserRow
                    key={user.id}
                    user={user}
                    onChange={(next) => setUsers((current) => current.map((item) => item.id === next.id ? next : item))}
                    onError={setError}
                    onNotice={setNotice}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AdminChannelsPanel scope="platform" />
    </div>
  );
}

function PlatformUserRow({ user, onChange, onError, onNotice }: { user: AdminUser; onChange: (user: AdminUser) => void; onError: (error: string) => void; onNotice: (notice: string) => void }) {
  const { locale, t } = useI18n();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const resetPanelId = `platform-reset-password-${user.id}`;
  const deltaValue = Number(delta);
  const canAdjust = delta !== "" && Number.isSafeInteger(deltaValue) && deltaValue !== 0 && reason.trim().length > 0 && !busy;
  const canReset = !busy && !passwordPolicyError(newPassword) && passwordsMatch(newPassword, confirmPassword);
  const saveStatus = async (status: AdminUser["status"]) => {
    if (busy) return;
    setBusy(true);
    try { onChange(await patchPlatformUser(user.id, { status })); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const adjust = async () => {
    if (!canAdjust) return;
    setBusy(true);
    try {
      onChange((await adjustPlatformCredits(user.id, { delta: deltaValue, reason, idempotencyKey: crypto.randomUUID() })).user);
      setDelta(""); setReason("");
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const resetPassword = async () => {
    const policyError = passwordPolicyError(newPassword);
    if (policyError === "too-short") {
      setResetError(t("auth.passwordTooShort"));
      return;
    }
    if (policyError === "too-long") {
      setResetError(t("auth.passwordTooLong"));
      return;
    }
    if (!passwordsMatch(newPassword, confirmPassword)) {
      setResetError(t("auth.passwordMismatch"));
      return;
    }
    if (busy) return;
    setBusy(true);
    setResetError(null);
    try {
      await resetPlatformUserPassword(user.id, newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setResetOpen(false);
      onNotice(t("admin.passwordReset"));
    } catch {
      setResetError(t("admin.passwordResetFailed"));
      onError(t("admin.passwordResetFailed"));
    } finally { setBusy(false); }
  };
  return (
    <tr>
      <td>
        <div className="font-medium text-[var(--ob-ink)]">{user.displayName || user.email}</div>
        <div className="text-xs text-[var(--ob-muted)]">{user.email}</div>
      </td>
      <td className="font-mono text-xs text-[var(--ob-muted)]">{user.tenantId}</td>
      <td>
        <div className="flex flex-wrap gap-1">
          <span className="ob-chip text-xs">{user.role === "owner" ? t("admin.tenantOwner") : t("admin.tenantUser")}</span>
          {user.platformAdmin ? <span className="ob-chip text-xs text-[var(--ob-accent)]">{t("admin.platformAdmin")}</span> : null}
        </div>
      </td>
      <td>
        <span className="ob-status-chip" data-tone={user.status === "active" ? "success" : "warning"}>
          <span className="ob-status-dot" data-status={user.status === "active" ? "succeeded" : "pending"} aria-hidden />
          {user.status === "active" ? t("admin.active") : t("admin.disabled")}
        </span>
        <select className="ob-field mt-1 w-24 py-1 text-[0.8125rem]" aria-label={`${user.email} · ${t("admin.status")}`} value={user.status} disabled={busy} onChange={(event) => void saveStatus(event.target.value as AdminUser["status"])}>
          <option value="active">{t("admin.active")}</option>
          <option value="ban">{t("admin.disabled")}</option>
        </select>
      </td>
      <td data-numeric="true">{user.credits.toLocaleString(locale)}</td>
      <td>
        <div className="flex flex-wrap items-center gap-1">
          <input className="ob-field w-20 py-1 text-[0.8125rem]" aria-label={`${user.email} · ${t("admin.creditDelta")}`} type="number" value={delta} disabled={busy} onChange={(event) => setDelta(event.target.value)} placeholder="+/-" />
          <input className="ob-field w-32 py-1 text-[0.8125rem]" aria-label={`${user.email} · ${t("admin.reason")}`} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} placeholder={t("admin.reason")} />
          <button type="button" className="ob-btn" disabled={!canAdjust} onClick={() => void adjust()}>{busy ? t("admin.processing") : t("admin.adjust")}</button>
          <button
            type="button"
            className="ob-btn"
            disabled={busy}
            aria-expanded={resetOpen}
            aria-controls={resetPanelId}
            onClick={() => setResetOpen((open) => !open)}
          >
            {t("admin.resetPassword")}
          </button>
        </div>
        {resetOpen ? (
          <form id={resetPanelId} className="mt-2 max-w-xs space-y-2" onSubmit={(event) => { event.preventDefault(); void resetPassword(); }}>
            <p className="text-xs text-[var(--ob-muted)]">{t("admin.resetPasswordHint")}</p>
            <PasswordField
              name={`reset-password-${user.id}`}
              label={t("auth.newPassword")}
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              placeholder={t("auth.passwordPlaceholder")}
              disabled={busy}
            />
            <PasswordField
              name={`reset-password-confirm-${user.id}`}
              label={t("auth.confirmPassword")}
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              placeholder={t("auth.passwordPlaceholder")}
              disabled={busy}
            />
            {resetError ? <p role="alert" className="text-xs text-[var(--ob-danger)]">{resetError}</p> : null}
            <div className="flex flex-wrap gap-1">
              <button type="submit" className="ob-btn-primary" disabled={!canReset}>{t("admin.confirmResetPassword")}</button>
              <button type="button" className="ob-btn" disabled={busy} onClick={() => { setResetOpen(false); setNewPassword(""); setConfirmPassword(""); setResetError(null); }}>{t("admin.cancelResetPassword")}</button>
            </div>
          </form>
        ) : null}
      </td>
    </tr>
  );
}

function PlatformPolicySection() {
  const { t } = useI18n();
  const [policy, setPolicy] = useState<PlatformPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void getPlatformPolicy()
      .then((value) => { if (!cancelled) setPolicy(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  const toggleRegistration = async () => {
    if (!policy || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setPolicy(await updatePlatformPolicy({ allowRegister: !policy.allowRegister }));
      setNotice(t("admin.platformPolicySaved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ob-admin-section" aria-busy={policy === null || busy}>
      <SectionHeader
        icon={<ShieldCheck size={16} />}
        title={t("admin.platformPolicy")}
        desc={t("admin.platformPolicyHint")}
      />
      {policy === null && !error ? <Notice tone="info">{t("settings.loadingPolicy")}</Notice> : null}
      {policy ? (
        <label className="ob-toggle-field max-w-xl">
          <button
            type="button"
            role="switch"
            className="ob-switch"
            aria-label={t("settings.allowRegistration")}
            aria-checked={policy.allowRegister}
            data-checked={policy.allowRegister ? "true" : "false"}
            disabled={busy}
            onClick={() => void toggleRegistration()}
          />
          <span className="text-sm text-[var(--ob-ink)]">{t("settings.allowRegistration")}</span>
        </label>
      ) : null}
      <div className="mt-3 space-y-2 empty:mt-0">
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </section>
  );
}
