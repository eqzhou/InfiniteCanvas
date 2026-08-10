import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { AdminPromptCatalogPanel } from "@/components/admin/AdminPromptCatalogPanel";
import { AdminChannelsPanel } from "@/components/admin/AdminChannelsPanel";
import { AdminStoragePoolPanel } from "@/components/admin/AdminStoragePoolPanel";
import { AdminLibraryPanel } from "@/components/admin/AdminLibraryPanel";
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
const adminTabLabels: Record<Tab, string> = { quota: "团队额度", users: "用户", credits: "算力日志", models: "算力成本", channels: "共享渠道", prompts: "提示词", library: "素材库", storage: "存储池" };

export function AdminPage() {
  const auth = useOptionalAuth();
  const [tab, setTab] = useState<Tab>("quota");
  const role = auth?.localAdmin ? "owner" : auth?.user?.role.toLowerCase() ?? "member";
  if (!canManageAdmin(auth)) {
    return <div className="p-8 text-sm text-[var(--ob-danger)]">需要管理员权限。</div>;
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
        <div><h1 className="text-2xl font-semibold">管理后台</h1><p className="text-sm text-[var(--ob-muted)]">团队生成额度、用户算力余额和模型算力成本分别管理。</p></div>
        <div className="w-full overflow-x-auto pb-1 sm:w-auto">
          <div className="ob-segment min-w-max" role="tablist" aria-label="管理后台栏目">
            {adminTabs.map((item) => (
              <button key={item} id={`admin-tab-${item}`} type="button" role="tab" aria-controls="admin-tabpanel" aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} className="ob-segment-item" data-active={tab === item} onKeyDown={(event) => handleTabKeyDown(event, item)} onClick={() => setTab(item)}>
                {adminTabLabels[item]}
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
      setQuotaDraft(String(value.generationQuotaMonthly)); setSavedQuota(value.generationQuotaMonthly); setUsed(value.generationThisMonth); setError(""); setNotice("团队月度生成额度已保存");
    } catch (cause) { setNotice(""); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const remaining = savedQuota === null ? null : Math.max(0, savedQuota - used);
  return <div className="max-w-xl space-y-4 rounded-xl border border-[var(--ob-line)] p-5" aria-busy={loading || busy}><div><h2 className="text-lg font-semibold">团队月度生成额度</h2><p className="mt-1 text-sm text-[var(--ob-muted)]">整个团队共享，每月重新统计。0 表示额度为零，不能生成，不代表无限制。</p></div>{loading ? <p className="text-sm text-[var(--ob-muted)]">正在读取团队额度…</p> : savedQuota === null ? null : <div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-lg bg-[var(--ob-canvas)] p-3">本月已使用<br /><strong className="text-lg">{used}</strong></div><div className="rounded-lg bg-[var(--ob-canvas)] p-3">当前剩余<br /><strong className="text-lg">{remaining}</strong></div></div>}<label className="block text-sm">本月总额度<input className="ob-field mt-1 max-w-xs" type="text" inputMode="numeric" autoComplete="off" value={quotaDraft} disabled={loading || busy || savedQuota === null} onChange={(e) => { setQuotaDraft(e.target.value); setNotice(""); setError(""); }} /></label>{quotaDraft && quota === null ? <p role="alert" className="text-sm text-[var(--ob-danger)]">请输入 0 到 1000000000 的整数</p> : null}<button type="button" className="ob-btn ob-btn-primary" disabled={loading || busy || savedQuota === null || quota === null || quota === savedQuota} onClick={() => void save()}>{busy ? "保存中…" : "保存团队额度"}</button>{notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}</div>;
}

function UsersAdmin({ actorRole }: { actorRole: string }) {
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
    <div className="flex gap-2"><input className="ob-field max-w-sm" placeholder="搜索邮箱或名称" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(); }} /><button type="button" className="ob-btn" onClick={() => void load()}>搜索</button></div>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    <div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-[var(--ob-canvas)] text-[var(--ob-muted)]"><tr><th className="p-3">用户</th><th>角色</th><th>状态</th><th>算力余额</th><th className="pr-3">操作</th></tr></thead><tbody>
      {items.map((user) => <tr key={user.id} className="border-t border-[var(--ob-line)]"><td className="p-3"><div>{user.displayName || "未命名"}</div><div className="text-xs text-[var(--ob-muted)]">{user.email}</div></td><td><select className="ob-field w-28" value={user.role} disabled={actorRole !== "owner" && user.role === "owner"} onChange={(e) => void change(user, { role: e.target.value as AdminUser["role"] })}><option value="owner">owner</option><option value="admin">admin</option><option value="member">member</option></select></td><td><select className="ob-field w-24" value={user.status} disabled={actorRole !== "owner" && user.role === "owner"} onChange={(e) => void change(user, { status: e.target.value as AdminUser["status"] })}><option value="active">正常</option><option value="ban">停用</option></select></td><td>{user.credits}</td><td className="pr-3"><button type="button" className="ob-btn" onClick={(event) => { adjustmentTriggerRef.current = event.currentTarget; setAdjusting(user); }}>增减算力</button></td></tr>)}
    </tbody></table></div>
    {adjusting ? <CreditAdjustmentDialog user={adjusting} onClose={closeAdjustment} onSaved={(user) => { setItems((current) => current.map((item) => item.id === user.id ? user : item)); closeAdjustment(); }} /> : null}
  </div>;
}

function CreditAdjustmentDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: (user: AdminUser) => void }) {
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
  return <div className="ob-overlay z-[150] p-4"><div role="dialog" aria-modal="true" aria-labelledby="credit-adjustment-title" className="ob-surface mx-auto mt-[12vh] max-w-md p-5" onKeyDown={handleDialogKeyDown}><h2 id="credit-adjustment-title" className="text-lg font-semibold">增减 {user.displayName || user.email} 的算力余额</h2><form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}><label className="block text-sm">算力变化值（增加填正数，扣减填负数）<input autoFocus className="ob-field mt-1" type="number" min={-1_000_000_000} max={1_000_000_000} step={1} value={deltaDraft} disabled={busy} onChange={(e) => { setDeltaDraft(e.target.value); setError(""); }} /></label><label className="block text-sm">调整原因<input className="ob-field mt-1" maxLength={200} value={reason} disabled={busy} onChange={(e) => { setReason(e.target.value); setError(""); }} /></label>{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<div className="flex justify-end gap-2"><button type="button" className="ob-btn" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="ob-btn ob-btn-primary" disabled={!canSubmit}>{busy ? "处理中…" : "确认"}</button></div></form></div></div>;
}

function CreditsAdmin() {
  const [items, setItems] = useState<AdminCreditLog[]>([]); const [userId, setUserId] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState("");
  const load = async () => { try { setError(""); setItems((await listAdminCreditLogs({ userId, reason, pageSize: 100 })).items); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  useEffect(() => { void load(); }, []);
  return <div className="space-y-3"><div className="flex flex-wrap gap-2"><input className="ob-field max-w-xs" placeholder="用户 ID" value={userId} onChange={(e) => setUserId(e.target.value)} /><input className="ob-field max-w-xs" placeholder="原因" value={reason} onChange={(e) => setReason(e.target.value)} /><button type="button" className="ob-btn" onClick={() => void load()}>筛选</button></div>{error ? <p className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-[var(--ob-canvas)]"><tr><th className="p-3">时间</th><th>用户</th><th>变化</th><th>余额</th><th>原因</th><th>模型</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-t border-[var(--ob-line)]"><td className="p-3">{new Date(item.createdAt).toLocaleString()}</td><td>{item.userId}</td><td className={item.delta >= 0 ? "text-emerald-600" : "text-[var(--ob-danger)]"}>{item.delta > 0 ? "+" : ""}{item.delta}</td><td>{item.balanceAfter}</td><td>{item.reason}</td><td>{item.model || "-"}</td></tr>)}</tbody></table></div></div>;
}

function ModelsAdmin() {
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
    try { setConfig(await putAdminModelCosts(config)); setNotice("模型算力成本已保存"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="max-w-3xl space-y-3" aria-busy={loading || busy}><p className="text-sm text-[var(--ob-muted)]">配置每次成功生成一个结果消耗的用户算力。成本至少为 1，不存在 0 算力无限生成。</p>{loading ? <p className="text-sm text-[var(--ob-muted)]">正在读取模型算力成本…</p> : hasLoaded ? <><label className="block text-sm">未单独配置模型时，每次消耗算力<input className="ob-field mt-1 max-w-xs" type="number" min={1} step={1} value={Number.isNaN(config.defaultCredits) ? "" : config.defaultCredits} disabled={busy} onChange={(e) => { setNotice(""); setConfig((current) => ({ ...current, defaultCredits: e.target.value === "" ? Number.NaN : Number(e.target.value) })); }} /></label>{rows.map((item, index) => <div key={index} className="grid grid-cols-[minmax(0,1fr)_7rem_3rem] gap-2"><input aria-label={`第 ${index + 1} 个模型 ID`} className="ob-field min-w-0" placeholder="模型 ID" value={item.model} disabled={busy} onChange={(e) => { setNotice(""); patchRow(index, { model: e.target.value }); }} /><input aria-label={`${item.model || `第 ${index + 1} 个模型`}每次消耗算力`} className="ob-field min-w-0" type="number" min={1} step={1} value={Number.isNaN(item.credits) ? "" : item.credits} disabled={busy} onChange={(e) => { setNotice(""); patchRow(index, { credits: e.target.value === "" ? Number.NaN : Number(e.target.value) }); }} /><button type="button" className="ob-icon-btn" aria-label="删除模型成本" disabled={busy} onClick={() => { setNotice(""); setConfig((current) => ({ ...current, modelCosts: current.modelCosts.filter((_, rowIndex) => rowIndex !== index) })); }}>×</button></div>)}{!configValid ? <p role="alert" className="text-sm text-[var(--ob-danger)]">模型 ID 不能为空，每次消耗必须是至少为 1 的整数。</p> : null}<div className="flex flex-wrap gap-2"><button type="button" className="ob-btn" disabled={busy} onClick={() => { setNotice(""); setConfig((current) => ({ ...current, modelCosts: [...current.modelCosts, { model: "", credits: 1 }] })); }}>添加模型</button><button type="button" className="ob-btn ob-btn-primary" disabled={busy || !configValid} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></div></> : null}{notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}</div>;
}
