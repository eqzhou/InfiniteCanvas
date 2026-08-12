import { useEffect, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";
import {
  adjustPlatformCredits,
  listPlatformTenants,
  listPlatformUsers,
  patchPlatformUser,
  putPlatformTenantQuota,
  type AdminUser,
  type PlatformTenant,
} from "@/services/admin";

export function PlatformAdminPanel() {
  const { t } = useI18n();
  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    }
  };
  useEffect(() => { void load(); }, []);

  const saveQuota = async (tenant: PlatformTenant) => {
    const value = Number(quotaDrafts[tenant.id]);
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) return;
    try {
      const updated = await putPlatformTenantQuota(tenant.id, value);
      setTenants((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <div className="space-y-5">
    <div><h2 className="text-lg font-semibold">{t("admin.platformTitle")}</h2><p className="mt-1 text-sm text-[var(--ob-muted)]">{t("admin.platformHint")}</p></div>
    <div className="flex flex-wrap gap-2"><input className="ob-field max-w-md" placeholder={t("admin.platformSearch")} value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} /><button type="button" className="ob-btn" disabled={busy} onClick={() => void load()}>{t("admin.refresh")}</button></div>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    <div><h3 className="mb-2 font-semibold">{t("admin.platformTenants")}</h3><div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-[var(--ob-canvas)]"><tr><th className="p-3">{t("admin.tenantId")}</th><th>{t("admin.userCount")}</th><th>{t("admin.totalQuota")}</th><th>{t("admin.actions")}</th></tr></thead><tbody>{tenants.map((tenant) => <tr key={tenant.id} className="border-t border-[var(--ob-line)]"><td className="p-3"><div>{tenant.name}</div><div className="text-xs text-[var(--ob-muted)]">{tenant.id}</div></td><td>{tenant.userCount ?? 0}</td><td><input className="ob-field w-36" type="number" min={0} max={1_000_000_000} value={quotaDrafts[tenant.id] ?? ""} onChange={(event) => setQuotaDrafts((current) => ({ ...current, [tenant.id]: event.target.value }))} /></td><td><button type="button" className="ob-btn" onClick={() => void saveQuota(tenant)}>{t("admin.saveTenantQuota")}</button></td></tr>)}</tbody></table></div></div>
    <div><h3 className="mb-2 font-semibold">{t("admin.platformUsers")}</h3><div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-[var(--ob-canvas)]"><tr><th className="p-3">{t("admin.user")}</th><th>{t("admin.tenantId")}</th><th>{t("admin.role")}</th><th>{t("admin.status")}</th><th>{t("admin.creditBalance")}</th><th>{t("admin.actions")}</th></tr></thead><tbody>{users.map((user) => <PlatformUserRow key={user.id} user={user} onChange={(next) => setUsers((current) => current.map((item) => item.id === next.id ? next : item))} onError={setError} />)}</tbody></table></div></div>
  </div>;
}

function PlatformUserRow({ user, onChange, onError }: { user: AdminUser; onChange: (user: AdminUser) => void; onError: (error: string) => void }) {
  const { t } = useI18n();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const save = async (patch: Partial<Pick<AdminUser, "role" | "status">>) => { try { onChange(await patchPlatformUser(user.id, patch)); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } };
  const adjust = async () => { const value = Number(delta); if (!Number.isSafeInteger(value) || value === 0 || !reason.trim()) return; try { onChange((await adjustPlatformCredits(user.id, { delta: value, reason, idempotencyKey: crypto.randomUUID() })).user); setDelta(""); setReason(""); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); } };
  return <tr className="border-t border-[var(--ob-line)]"><td className="p-3"><div>{user.displayName || user.email}</div><div className="text-xs text-[var(--ob-muted)]">{user.email}</div></td><td className="text-xs">{user.tenantId}</td><td><select className="ob-field w-28" value={user.role} onChange={(event) => void save({ role: event.target.value as AdminUser["role"] })}><option value="owner">owner</option><option value="admin">admin</option><option value="member">member</option></select></td><td><select className="ob-field w-24" value={user.status} onChange={(event) => void save({ status: event.target.value as AdminUser["status"] })}><option value="active">{t("admin.active")}</option><option value="ban">{t("admin.disabled")}</option></select></td><td>{user.credits}</td><td><div className="flex flex-wrap gap-1"><input className="ob-field w-24" type="number" value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="+/-" /><input className="ob-field w-32" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("admin.reason")} /><button type="button" className="ob-btn" onClick={() => void adjust()}>{t("admin.adjust")}</button></div></td></tr>;
}
