import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Coins, Cpu, Database, Gauge, Plus, Search, ShieldAlert, SlidersHorizontal, Users, X } from "lucide-react";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { EmptyState, Notice, SectionHeader } from "@/components/admin/AdminSection";
import { AdminPromptCatalogPanel } from "@/components/admin/AdminPromptCatalogPanel";
import { AdminChannelsPanel } from "@/components/admin/AdminChannelsPanel";
import { AdminStoragePoolPanel } from "@/components/admin/AdminStoragePoolPanel";
import { AdminLibraryPanel } from "@/components/admin/AdminLibraryPanel";
import { PlatformAdminPanel } from "@/components/admin/PlatformAdminPanel";
import { TenantPolicyPanel } from "@/components/admin/TenantPolicyPanel";
import { TenantInvitationsPanel } from "@/components/admin/TenantInvitationsPanel";
import { useI18n } from "@/i18n/I18nProvider";
import {
  ADMIN_TAB_ICONS,
  ADMIN_TAB_LABELS,
  adminNavGroupsForCapabilities,
  adminTabsForCapabilities,
  type AdminTab,
} from "@/lib/admin-navigation";
import {
  getAdminModelCosts,
  getAdminTenantQuota,
  listAdminCreditLogs,
  listAdminUsers,
  patchAdminUser,
  putAdminModelCosts,
  canAccessAdminPage,
  hasPlatformAdminCapability,
  hasTenantOwnerCapability,
  type AdminCreditLog,
  type AdminModelCosts,
  type AdminUser,
} from "@/services/admin";

export type { AdminTab };
export { adminTabsForCapabilities };

const QUOTA_WARNING_RATIO = 0.8;

export function AdminPage() {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const [tab, setTab] = useState<AdminTab>("quota");
  const tenantOwner = hasTenantOwnerCapability(auth);
  const platformAdmin = hasPlatformAdminCapability(auth);
  const actorRole = tenantOwner ? "owner" : "user";
  const role = auth?.localAdmin ? t("admin.localOperator") : actorRole;
  const navGroups = useMemo(
    () => adminNavGroupsForCapabilities({ tenantOwner, platformAdmin }),
    [platformAdmin, tenantOwner],
  );
  const visibleTabs = adminTabsForCapabilities({ tenantOwner, platformAdmin });
  const activeTab = visibleTabs.includes(tab) ? tab : visibleTabs[0];
  if (!canAccessAdminPage(auth)) {
    return (
      <div className="ob-page">
        <div className="ob-empty" role="alert">
          <span className="ob-empty-icon" aria-hidden><ShieldAlert size={20} /></span>
          <p className="ob-empty-title">{t("admin.permissionRequired")}</p>
        </div>
      </div>
    );
  }
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: AdminTab) => {
    const currentIndex = visibleTabs.indexOf(current);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? visibleTabs.length - 1 : event.key === "ArrowRight" || event.key === "ArrowDown" ? (currentIndex + 1) % visibleTabs.length : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (currentIndex - 1 + visibleTabs.length) % visibleTabs.length : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = visibleTabs[nextIndex];
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`admin-tab-${next}`)?.focus());
  };
  const renderTabButton = (item: AdminTab, className: string, id?: string) => {
    const Icon = ADMIN_TAB_ICONS[item];
    return (
      <button
        key={item}
        id={id}
        type="button"
        aria-current={activeTab === item ? "page" : undefined}
        className={className}
        data-active={activeTab === item}
        onKeyDown={(event) => handleTabKeyDown(event, item)}
        onClick={() => setTab(item)}
      >
        <Icon size={13} aria-hidden />
        {t(ADMIN_TAB_LABELS[item])}
      </button>
    );
  };
  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col overflow-hidden p-4 sm:p-6">
      <header className="ob-page-header">
        <div className="min-w-0">
          <span className="ob-page-kicker"><SlidersHorizontal size={13} aria-hidden />{t("admin.kicker")}</span>
          <h1 className="ob-page-title">{t("admin.title")}</h1>
          <p className="ob-page-desc">{t("admin.description")}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {platformAdmin ? (
            <span className="ob-chip border-[color-mix(in_srgb,var(--ob-accent)_35%,transparent)] bg-[var(--ob-accent-soft)] text-[var(--ob-accent)] font-medium text-xs">
              <Database size={12} className="mr-1 inline" />
              {t("admin.platformAdmin")}
            </span>
          ) : null}
          <span className="ob-chip text-xs text-[var(--ob-muted)]">
            <Users size={12} className="mr-1 inline" />
            {t("admin.roleLabel")} <strong className="font-semibold text-[var(--ob-ink)]">{role}</strong>
          </span>
        </div>
      </header>
      <nav className="ob-settings-tabbar mb-0" aria-label={t("admin.sections")}>
        {visibleTabs.map((item) => renderTabButton(item, "ob-settings-tabbar-item"))}
      </nav>
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel)]">
        <nav className="ob-settings-sidebar" aria-label={t("admin.sections")}>
          {navGroups.map((group) => (
            <div key={group.id} className="mb-3 last:mb-0">
              <p className="ob-micro-label px-2 pb-1.5 pt-1">{t(group.labelKey)}</p>
              {group.tabs.map((item) => renderTabButton(item, "ob-settings-sidebar-link", `admin-tab-${item}`))}
            </div>
          ))}
        </nav>
        <div id="admin-tabpanel" role="tabpanel" aria-labelledby={`admin-tab-${activeTab}`} className="ob-view-fade-in min-h-0 flex-1 overflow-auto p-4 sm:p-5" key={activeTab}>
          {activeTab === "quota" ? <TenantQuotaAdmin /> : activeTab === "users" ? <UsersAdmin /> : activeTab === "credits" ? <CreditsAdmin /> : activeTab === "policy" ? <TenantPolicyPanel /> : activeTab === "models" ? <ModelsAdmin /> : activeTab === "channels" ? <AdminChannelsPanel /> : activeTab === "prompts" ? <AdminPromptCatalogPanel /> : activeTab === "library" ? <AdminLibraryPanel /> : activeTab === "platform" ? <PlatformAdminPanel /> : <AdminStoragePoolPanel />}
        </div>
      </div>
    </div>
  );
}

function TenantQuotaAdmin() {
  const { locale, t } = useI18n();
  const [savedQuota, setSavedQuota] = useState<number | null>(null);
  const [used, setUsed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { void getAdminTenantQuota().then((value) => { setSavedQuota(value.generationQuotaMonthly); setUsed(value.generationThisMonth); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setLoading(false)); }, []);
  const remaining = savedQuota === null ? null : Math.max(0, savedQuota - used);
  const ratio = savedQuota === null ? 0 : savedQuota > 0 ? Math.min(1, used / savedQuota) : used > 0 ? 1 : 0;
  const meterTone = ratio >= 1 ? "danger" : ratio >= QUOTA_WARNING_RATIO ? "warning" : "accent";
  const figure = (value: number) => value.toLocaleString(locale);
  return (
    <div className="ob-admin-stack max-w-2xl" aria-busy={loading}>
      <section className="ob-admin-section">
        <SectionHeader icon={<Gauge size={16} />} title={t("admin.teamQuota")} desc={t("admin.teamQuotaHint")} />
        {loading ? <Notice tone="info">{t("admin.loadingQuota")}</Notice> : savedQuota === null ? null : (
          <>
            <div className="ob-metric-grid">
              <div className="ob-metric">
                <span className="ob-metric-label">{t("admin.usedThisMonth")}</span>
                <span className="ob-metric-value">{figure(used)}<span className="ob-metric-unit">{t("admin.unitRuns")}</span></span>
              </div>
              <div className="ob-metric" data-tone={remaining === 0 ? "warning" : "accent"}>
                <span className="ob-metric-label">{t("admin.remaining")}</span>
                <span className="ob-metric-value">{figure(remaining ?? 0)}<span className="ob-metric-unit">{t("admin.unitRuns")}</span></span>
              </div>
              <div className="ob-metric">
                <span className="ob-metric-label">{t("admin.totalQuota")}</span>
                <span className="ob-metric-value">{figure(savedQuota)}<span className="ob-metric-unit">{t("admin.unitRuns")}</span></span>
              </div>
            </div>
            <div className="mt-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="ob-micro-label">{t("admin.quotaUsage")}</span>
                <span className="text-xs tabular-nums text-[var(--ob-muted)]">{Math.round(ratio * 100)}%</span>
              </div>
              <div className="ob-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label={t("admin.quotaUsage")}>
                <div className="ob-meter-fill" data-tone={meterTone} style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%` }} />
              </div>
            </div>
          </>
        )}
        <div className="mt-3 space-y-2 empty:mt-0">
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      </section>
    </div>
  );
}

function UsersAdmin() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try { setError(""); setItems((await listAdminUsers({ q, pageSize: 100 })).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const change = async (user: AdminUser, patch: Partial<Pick<AdminUser, "role" | "status">>) => {
    try {
      const updated = await patchAdminUser(user.id, patch);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <div className="ob-admin-stack" aria-busy={loading}>
      <TenantInvitationsPanel />
      <section className="ob-admin-section">
        <SectionHeader
          icon={<Users size={16} />}
          title={t("admin.users.title")}
          desc={t("admin.users.desc")}
          actions={<span className="ob-micro-label">{t("admin.users.count", { count: items.length })}</span>}
        />
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="ob-field max-w-xs" aria-label={t("admin.searchUsers")} placeholder={t("admin.searchUsers")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} />
          <button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}><Search size={14} aria-hidden />{t("admin.search")}</button>
        </div>
        {error ? <div className="mb-3"><Notice tone="danger">{error}</Notice></div> : null}
        {loading ? <Notice tone="info">{t("admin.loadingUsers")}</Notice> : items.length === 0 ? (
          <EmptyState title={t("admin.users.empty")} />
        ) : (
          <div className="ob-table-shell max-h-[62vh]">
            <table className="ob-table min-w-[760px]">
              <thead><tr><th scope="col">{t("admin.user")}</th><th scope="col">{t("admin.role")}</th><th scope="col">{t("admin.status")}</th><th scope="col">{t("admin.creditBalance")}</th></tr></thead>
              <tbody>
                {items.map((user) => {
                  return (
                    <tr key={user.id}>
                      <td>
                        <div className="font-medium text-[var(--ob-ink)]">{user.displayName || t("admin.unnamed")}</div>
                        <div className="text-xs text-[var(--ob-muted)]">{user.email}</div>
                      </td>
                      <td>
                        <select className="ob-field w-28 py-1 text-[0.8125rem]" aria-label={`${user.email} · ${t("admin.role")}`} value={user.role === "owner" ? "owner" : "user"} onChange={(e) => void change(user, { role: e.target.value as AdminUser["role"] })}>
                          <option value="owner">owner</option>
                          <option value="user">user</option>
                        </select>
                      </td>
                      <td>
                        <span className="ob-status-chip" data-tone={user.status === "active" ? "success" : "warning"}>
                          <span className="ob-status-dot" data-status={user.status === "active" ? "succeeded" : "pending"} aria-hidden />
                          {user.status === "active" ? t("admin.active") : t("admin.disabled")}
                        </span>
                        <select className="ob-field mt-1 w-24 py-1 text-[0.8125rem]" aria-label={`${user.email} · ${t("admin.status")}`} value={user.status} onChange={(e) => void change(user, { status: e.target.value as AdminUser["status"] })}>
                          <option value="active">{t("admin.active")}</option>
                          <option value="ban">{t("admin.disabled")}</option>
                        </select>
                      </td>
                      <td data-numeric="true">{user.credits.toLocaleString(locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function CreditsAdmin() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<AdminCreditLog[]>([]); const [userId, setUserId] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try { setError(""); setItems((await listAdminCreditLogs({ userId, reason, pageSize: 100 })).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  return (
    <div className="ob-admin-stack" aria-busy={loading}>
      <section className="ob-admin-section">
        <SectionHeader
          icon={<Coins size={16} />}
          title={t("admin.credits.title")}
          desc={t("admin.credits.desc")}
          actions={<span className="ob-micro-label">{t("admin.credits.count", { count: items.length })}</span>}
        />
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="ob-field max-w-xs" aria-label={t("admin.userId")} placeholder={t("admin.userId")} value={userId} onChange={(e) => setUserId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} />
          <input className="ob-field max-w-xs" aria-label={t("admin.reason")} placeholder={t("admin.reason")} value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} />
          <button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}><Search size={14} aria-hidden />{t("admin.filter")}</button>
        </div>
        {error ? <div className="mb-3"><Notice tone="danger">{error}</Notice></div> : null}
        {loading ? <Notice tone="info">{t("admin.loadingCredits")}</Notice> : items.length === 0 ? (
          <EmptyState title={t("admin.credits.empty")} />
        ) : (
          <div className="ob-table-shell max-h-[62vh]">
            <table className="ob-table min-w-[760px]">
              <thead><tr><th scope="col">{t("admin.time")}</th><th scope="col">{t("admin.user")}</th><th scope="col">{t("admin.change")}</th><th scope="col">{t("admin.balance")}</th><th scope="col">{t("admin.reason")}</th><th scope="col">{t("admin.model")}</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="whitespace-nowrap text-[var(--ob-muted)]" data-numeric="true">{new Date(item.createdAt).toLocaleString(locale)}</td>
                    <td className="font-mono text-xs">{item.userId}</td>
                    <td data-numeric="true"><span className="ob-delta" data-sign={item.delta >= 0 ? "up" : "down"}>{item.delta > 0 ? "+" : ""}{item.delta.toLocaleString(locale)}</span></td>
                    <td data-numeric="true">{item.balanceAfter.toLocaleString(locale)}</td>
                    <td>{item.reason}</td>
                    <td className="text-[var(--ob-muted)]">{item.model || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
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
  return (
    <div className="ob-admin-stack max-w-3xl" aria-busy={loading || busy}>
      <section className="ob-admin-section">
        <SectionHeader
          icon={<Cpu size={16} />}
          title={t("admin.models.title")}
          desc={t("admin.modelCostHint")}
          actions={hasLoaded ? <span className="ob-micro-label">{t("admin.models.count", { count: rows.length })}</span> : null}
        />
        {loading ? <Notice tone="info">{t("admin.loadingModelCosts")}</Notice> : !hasLoaded ? null : (
          <>
            <label className="block max-w-xs">
              <span className="ob-micro-label mb-1">{t("admin.defaultModelCost")}</span>
              <input className="ob-field" type="number" min={1} step={1} value={Number.isNaN(config.defaultCredits) ? "" : config.defaultCredits} disabled={busy} onChange={(e) => { setNotice(""); setConfig((current) => ({ ...current, defaultCredits: e.target.value === "" ? Number.NaN : Number(e.target.value) })); }} />
            </label>
            <div className="mt-4">
              <span className="ob-micro-label mb-1.5">{t("admin.models.overrides")}</span>
              {rows.length === 0 ? (
                <p className="ob-notice" data-tone="info">{t("admin.models.empty")}</p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem_2.25rem] gap-2 px-0.5">
                    <span className="ob-micro-label">{t("admin.modelId")}</span>
                    <span className="ob-micro-label">{t("admin.modelCredits")}</span>
                    <span />
                  </div>
                  {rows.map((item, index) => (
                    <div key={index} className="grid grid-cols-[minmax(0,1fr)_7rem_2.25rem] items-center gap-2">
                      <input aria-label={t("admin.modelIdAt", { index: index + 1 })} className="ob-field min-w-0" placeholder={t("admin.modelId")} value={item.model} disabled={busy} onChange={(e) => { setNotice(""); patchRow(index, { model: e.target.value }); }} />
                      <input aria-label={`${item.model || t("admin.modelIdAt", { index: index + 1 })} · ${t("admin.modelCredits")}`} className="ob-field min-w-0" type="number" min={1} step={1} value={Number.isNaN(item.credits) ? "" : item.credits} disabled={busy} onChange={(e) => { setNotice(""); patchRow(index, { credits: e.target.value === "" ? Number.NaN : Number(e.target.value) }); }} />
                      <button type="button" className="ob-icon-btn" aria-label={t("admin.deleteModelCost")} title={t("admin.deleteModelCost")} disabled={busy} onClick={() => { setNotice(""); setConfig((current) => ({ ...current, modelCosts: current.modelCosts.filter((_, rowIndex) => rowIndex !== index) })); }}><X size={14} aria-hidden /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="ob-record-actions">
              <button type="button" className="ob-btn" disabled={busy} onClick={() => { setNotice(""); setConfig((current) => ({ ...current, modelCosts: [...current.modelCosts, { model: "", credits: 1 }] })); }}><Plus size={14} aria-hidden />{t("admin.addModel")}</button>
              <span className="ob-record-actions-end" />
              <button type="button" className="ob-btn ob-btn-primary" disabled={busy || !configValid} onClick={() => void save()}>{busy ? t("admin.saving") : t("admin.save")}</button>
            </div>
          </>
        )}
        <div className="mt-3 space-y-2 empty:mt-0">
          {hasLoaded && !configValid ? <Notice tone="danger">{t("admin.invalidModelCost")}</Notice> : null}
          {notice ? <Notice tone="success">{notice}</Notice> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      </section>
    </div>
  );
}
