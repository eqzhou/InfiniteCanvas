import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { AdminPromptCatalogPanel } from "@/components/admin/AdminPromptCatalogPanel";
import { AdminChannelsPanel } from "@/components/admin/AdminChannelsPanel";
import { AdminStoragePoolPanel } from "@/components/admin/AdminStoragePoolPanel";
import { AdminLibraryPanel } from "@/components/admin/AdminLibraryPanel";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";
import {
  adjustAdminCredits,
  getAdminModelCosts,
  getAdminTenantQuota,
  listAdminCreditLogs,
  listAdminUsers,
  patchAdminUser,
  putAdminModelCosts,
  putAdminTenantQuota,
  canManageAdmin,
  isCreditAdjustmentReady,
  parseTenantQuotaDraft,
  type AdminCreditLog,
  type AdminModelCosts,
  type AdminUser,
} from "@/services/admin";

type Tab = "quota" | "users" | "credits" | "models" | "channels" | "prompts" | "library" | "storage";
const adminTabs: readonly Tab[] = ["quota", "users", "credits", "models", "channels", "prompts", "library", "storage"];
const adminTabLabels: Record<Tab, MessageKey> = { quota: "admin.tab.quota", users: "admin.tab.users", credits: "admin.tab.credits", models: "admin.tab.models", channels: "admin.tab.channels", prompts: "admin.tab.prompts", library: "admin.tab.library", storage: "admin.tab.storage" };

export function AdminPage() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const [tab, setTab] = useState<Tab>("quota");
  const role = auth?.localAdmin ? "owner" : auth?.user?.role.toLowerCase() ?? "member";
  if (!canManageAdmin(auth)) {
    return <div className="p-8 text-sm text-[var(--ob-danger)]">{t("admin.permissionRequired")}</div>;
  }
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    const currentIndex = adminTabs.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? adminTabs.length - 1 : event.key === "ArrowRight" ? (currentIndex + 1) % adminTabs.length : event.key === "ArrowLeft" ? (currentIndex - 1 + adminTabs.length) % adminTabs.length : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = adminTabs[nextIndex];
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`admin-tab-${next}`)?.focus());
  };
  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-hidden p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">{t("admin.title")}</h1><p className="text-sm text-[var(--ob-muted)]">{t("admin.description")}</p></div>
        <div className="w-full overflow-x-auto pb-1 sm:w-auto">
          <div className="ob-segment min-w-max" role="tablist" aria-label={t("admin.sections")}>
            {adminTabs.map((item) => (
              <button key={item} id={`admin-tab-${item}`} type="button" role="tab" aria-controls="admin-tabpanel" aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} className="ob-segment-item" data-active={tab === item} onKeyDown={(event) => handleTabKeyDown(event, item)} onClick={() => setTab(item)}>
                {t(adminTabLabels[item])}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div id="admin-tabpanel" role="tabpanel" aria-labelledby={`admin-tab-${tab}`} className="min-h-0 flex-1 overflow-auto">{tab === "quota" ? <TenantQuotaAdmin /> : tab === "users" ? <UsersAdmin actorRole={role} /> : tab === "credits" ? <CreditsAdmin /> : tab === "models" ? <ModelsAdmin /> : tab === "channels" ? <AdminChannelsPanel /> : tab === "prompts" ? <AdminPromptCatalogPanel /> : tab === "library" ? <AdminLibraryPanel /> : <AdminStoragePoolPanel />}</div>
    </div>
  );
}

function TenantQuotaAdmin() {
  const { t } = useI18n();
  const [quotaDraft, setQuotaDraft] = useState("");
  const [savedQuota, setSavedQuota] = useState<number | null>(null);
  const [used, setUsed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { void getAdminTenantQuota().then((value) => { setQuotaDraft(String(value.generationQuotaMonthly)); setSavedQuota(value.generationQuotaMonthly); setUsed(value.generationThisMonth); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false)); }, []);
  const quota = parseTenantQuotaDraft(quotaDraft);
  const save = async () => {
    if (quota === null || busy) return;
    setBusy(true);
    try {
      const value = await putAdminTenantQuota(quota);
      setQuotaDraft(String(value.generationQuotaMonthly)); setSavedQuota(value.generationQuotaMonthly); setUsed(value.generationThisMonth); setError(""); setNotice(t("admin.quotaSaved"));
    } catch (cause) { setNotice(""); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const remaining = savedQuota === null ? null : Math.max(0, savedQuota - used);
  return <div className="max-w-xl space-y-4 rounded-xl border border-[var(--ob-line)] p-5" aria-busy={loading || busy}><div><h2 className="text-lg font-semibold">{t("admin.teamQuota")}</h2><p className="mt-1 text-sm text-[var(--ob-muted)]">{t("admin.teamQuotaHint")}</p></div>{loading ? <p className="text-sm text-[var(--ob-muted)]">{t("admin.loadingQuota")}</p> : savedQuota === null ? null : <div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-[var(--ob-canvas)] p-3">{t("admin.usedThisMonth")}<br /><strong className="text-lg">{used}</strong></div><div className="rounded-lg bg-[var(--ob-canvas)] p-3">{t("admin.remaining")}<br /><strong className="text-lg">{remaining}</strong></div></div>}<label className="block text-sm">{t("admin.totalQuota")}<input className="ob-field mt-1 max-w-xs" type="text" inputMode="numeric" autoComplete="off" value={quotaDraft} disabled={loading || busy || savedQuota === null} onChange={(e) => { setQuotaDraft(e.target.value); setNotice(""); setError(""); }} /></label>{quotaDraft && quota === null ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{t("admin.integerRange")}</p> : null}<button type="button" className="ob-btn ob-btn-primary" disabled={loading || busy || savedQuota === null || quota === null || quota === savedQuota} onClick={() => void save()}>{busy ? t("admin.saving") : t("admin.saveQuota")}</button>{notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}</div>;
}

function UsersAdmin({ actorRole }: { actorRole: string }) {
  const { t } = useI18n();
  const [items, setItems] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [adjusting, setAdjusting] = useState<AdminUser | null>(null);
  const adjustmentTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeAdjustment = () => {
    setAdjusting(null);
    requestAnimationFrame(() => adjustmentTriggerRef.current?.focus());
  };
  const load = async () => {
    try { setError(""); setItems((await listAdminUsers({ q, pageSize: 100 })).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void load(); }, []);
  const change = async (user: AdminUser, patch: Partial<Pick<AdminUser, "role" | "status">>) => {
    try {
      const updated = await patchAdminUser(user.id, patch);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="space-y-3">
    <div className="flex gap-2"><input className="ob-field max-w-sm" placeholder={t("admin.searchUsers")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} /><button type="button" className="ob-btn" onClick={() => void load()}>{t("admin.search")}</button></div>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    <div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-[var(--ob-canvas)] text-[var(--ob-muted)]"><tr><th className="p-3">{t("admin.user")}</th><th>{t("admin.role")}</th><th>{t("admin.status")}</th><th>{t("admin.creditBalance")}</th><th className="pr-3">{t("admin.actions")}</th></tr></thead><tbody>
      {items.map((user) => <tr key={user.id} className="border-t border-[var(--ob-line)]"><td className="p-3"><div>{user.displayName || t("admin.unnamed")}</div><div className="text-xs text-[var(--ob-muted)]">{user.email}</div></td><td><select className="ob-field w-28" value={user.role} disabled={actorRole !== "owner" && user.role === "owner"} onChange={(e) => void change(user, { role: e.target.value as AdminUser["role"] })}><option value="owner">owner</option><option value="admin">admin</option><option value="member">member</option></select></td><td><select className="ob-field w-24" value={user.status} disabled={actorRole !== "owner" && user.role === "owner"} onChange={(e) => void change(user, { status: e.target.value as AdminUser["status"] })}><option value="active">{t("admin.active")}</option><option value="ban">{t("admin.disabled")}</option></select></td><td>{user.credits}</td><td className="pr-3"><button type="button" className="ob-btn" onClick={(event) => { adjustmentTriggerRef.current = event.currentTarget; setAdjusting(user); }}>{t("admin.adjustCredits")}</button></td></tr>)}
    </tbody></table></div>
    {adjusting ? <CreditAdjustmentDialog user={adjusting} onClose={closeAdjustment} onSaved={(user) => { setItems((current) => current.map((item) => item.id === user.id ? user : item)); closeAdjustment(); }} /> : null}
  </div>;
}

function CreditAdjustmentDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: (user: AdminUser) => void }) {
  const { t } = useI18n();
  const [deltaDraft, setDeltaDraft] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const requestIdentityRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const delta = Number(deltaDraft);
  const canSubmit = deltaDraft !== "" && isCreditAdjustmentReady(delta, reason) && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    const fingerprint = `${delta}\n${reason.trim()}`;
    if (requestIdentityRef.current?.fingerprint !== fingerprint) requestIdentityRef.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setError("");
    try { onSaved((await adjustAdminCredits(user.id, { delta, reason, idempotencyKey: requestIdentityRef.current.key })).user); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  };
  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="ob-overlay z-[150] p-4"><div role="dialog" aria-modal="true" aria-labelledby="credit-adjustment-title" className="ob-surface mx-auto mt-[12vh] max-w-md p-5" onKeyDown={handleDialogKeyDown}><h2 id="credit-adjustment-title" className="text-lg font-semibold">{t("admin.adjustUserCredits", { name: user.displayName || user.email })}</h2><form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label className="block text-sm">{t("admin.creditDelta")}<input autoFocus className="ob-field mt-1" type="number" min={-1_000_000_000} max={1_000_000_000} step={1} value={deltaDraft} disabled={busy} onChange={(e) => { setDeltaDraft(e.target.value); setError(""); }} /></label><label className="block text-sm">{t("admin.reason")}<input className="ob-field mt-1" maxLength={200} value={reason} disabled={busy} onChange={(e) => { setReason(e.target.value); setError(""); }} /></label>{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<div className="flex justify-end gap-2"><button type="button" className="ob-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button type="submit" className="ob-btn ob-btn-primary" disabled={!canSubmit}>{busy ? t("admin.processing") : t("admin.confirm")}</button></div></form></div></div>;
}

function CreditsAdmin() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<AdminCreditLog[]>([]); const [userId, setUserId] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState("");
  const load = async () => { try { setError(""); setItems((await listAdminCreditLogs({ userId, reason, pageSize: 100 })).items); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  useEffect(() => { void load(); }, []);
  return <div className="space-y-3"><div className="flex flex-wrap gap-2"><input className="ob-field max-w-xs" placeholder={t("admin.userId")} value={userId} onChange={(e) => setUserId(e.target.value)} /><input className="ob-field max-w-xs" placeholder={t("admin.reason")} value={reason} onChange={(e) => setReason(e.target.value)} /><button type="button" className="ob-btn" onClick={() => void load()}>{t("admin.filter")}</button></div>{error ? <p className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-[var(--ob-canvas)]"><tr><th className="p-3">{t("admin.time")}</th><th>{t("admin.user")}</th><th>{t("admin.change")}</th><th>{t("admin.balance")}</th><th>{t("admin.reason")}</th><th>{t("admin.model")}</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-t border-[var(--ob-line)]"><td className="p-3">{new Date(item.createdAt).toLocaleString(locale)}</td><td>{item.userId}</td><td className={item.delta >= 0 ? "text-emerald-600" : "text-[var(--ob-danger)]"}>{item.delta > 0 ? "+" : ""}{item.delta}</td><td>{item.balanceAfter}</td><td>{item.reason}</td><td>{item.model || "-"}</td></tr>)}</tbody></table></div></div>;
}

function ModelsAdmin() {
  const { t } = useI18n();
  const [config, setConfig] = useState<AdminModelCosts>({ modelCosts: [], defaultCredits: 1 });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getAdminModelCosts().then((value) => { setConfig(value); setHasLoaded(true); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false)); }, []);
  const rows = useMemo(() => config.modelCosts, [config.modelCosts]);
  const normalizedModels = rows.map((item) => item.model.trim().toLowerCase());
  const configValid = Number.isSafeInteger(config.defaultCredits) && config.defaultCredits >= 1 && config.defaultCredits <= 1_000_000_000 && new Set(normalizedModels).size === normalizedModels.length && rows.every((item) => item.model.trim() && Number.isSafeInteger(item.credits) && item.credits >= 1 && item.credits <= 1_000_000_000);
  const patchRow = (index: number, patch: Partial<AdminModelCosts["modelCosts"][number]>) => {
    setConfig((current) => ({
      ...current,
      modelCosts: current.modelCosts.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    }));
  };
  const save = async () => {
    if (busy) return;
    setBusy(true); setNotice(""); setError("");
    try { setConfig(await putAdminModelCosts(config)); setNotice(t("admin.modelCostsSaved")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="max-w-3xl space-y-3" aria-busy={loading || busy}><p className="text-sm text-[var(--ob-muted)]">{t("admin.modelCostHint")}</p>{loading ? <p className="text-sm text-[var(--ob-muted)]">{t("admin.loadingModelCosts")}</p> : hasLoaded ? <><label className="block text-sm">{t("admin.defaultModelCost")}<input className="ob-field mt-1 max-w-xs" type="number" min={1} step={1} value={Number.isNaN(config.defaultCredits) ? "" : config.defaultCredits} disabled={busy} onChange={(e) => { setNotice(""); setConfig((current) => ({ ...current, defaultCredits: e.target.value === "" ? Number.NaN : Number(e.target.value) })); }} /></label>{rows.map((item, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_7rem_3rem] gap-2"><input aria-label={t("admin.modelIdAt", { index: index + 1 })} className="ob-field min-w-0" placeholder={t("admin.modelId")} value={item.model} disabled={busy} onChange={(e) => { setNotice(""); patchRow(index, { model: e.target.value }); }} /><input aria-label={`${item.model || t("admin.modelIdAt", { index: index + 1 })} · ${t("admin.modelCredits")}`} className="ob-field min-w-0" type="number" min={1} step={1} value={Number.isNaN(item.credits) ? "" : item.credits} disabled={busy} onChange={(e) => { setNotice(""); patchRow(index, { credits: e.target.value === "" ? Number.NaN : Number(e.target.value) }); }} /><button type="button" className="ob-icon-btn" aria-label={t("admin.deleteModelCost")} disabled={busy} onClick={() => { setNotice(""); setConfig((current) => ({ ...current, modelCosts: current.modelCosts.filter((_, rowIndex) => rowIndex !== index) })); }}>×</button></div>)}{!configValid ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{t("admin.invalidModelCost")}</p> : null}<div className="flex flex-wrap gap-2"><button type="button" className="ob-btn" disabled={busy} onClick={() => { setNotice(""); setConfig((current) => ({ ...current, modelCosts: [...current.modelCosts, { model: "", credits: 1 }] })); }}>{t("admin.addModel")}</button><button type="button" className="ob-btn ob-btn-primary" disabled={busy || !configValid} onClick={() => void save()}>{busy ? t("admin.saving") : t("admin.save")}</button></div></> : null}{notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}</div>;
}
