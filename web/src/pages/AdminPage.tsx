import { useEffect, useMemo, useState } from "react";
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { AdminPromptCatalogPanel } from "@/components/admin/AdminPromptCatalogPanel";
import { AdminChannelsPanel } from "@/components/admin/AdminChannelsPanel";
import { AdminStoragePoolPanel } from "@/components/admin/AdminStoragePoolPanel";
import {
  adjustAdminCredits,
  getAdminModelCosts,
  listAdminCreditLogs,
  listAdminUsers,
  patchAdminUser,
  putAdminModelCosts,
  canManageAdmin,
  type AdminCreditLog,
  type AdminModelCosts,
  type AdminUser,
} from "@/services/admin";

type Tab = "users" | "credits" | "models" | "channels" | "prompts" | "storage";

export function AdminPage() {
  const auth = useOptionalAuth();
  const [tab, setTab] = useState<Tab>("users");
  const role = auth?.localAdmin ? "owner" : auth?.user?.role.toLowerCase() ?? "member";
  if (!canManageAdmin(auth)) {
    return <div className="p-8 text-sm text-[var(--ob-danger)]">需要管理员权限。</div>;
  }
  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-hidden p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">管理后台</h1><p className="text-sm text-[var(--ob-muted)]">用户、额度审计和模型成本。</p></div>
        <div className="ob-segment" role="tablist" aria-label="管理后台栏目">
          {(["users", "credits", "models", "channels", "prompts", "storage"] as const).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} className="ob-segment-item" data-active={tab === item} onClick={() => setTab(item)}>
              {item === "users" ? "用户" : item === "credits" ? "额度日志" : item === "models" ? "模型成本" : item === "channels" ? "共享渠道" : item === "prompts" ? "提示词" : "存储池"}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{tab === "users" ? <UsersAdmin actorRole={role} /> : tab === "credits" ? <CreditsAdmin /> : tab === "models" ? <ModelsAdmin /> : tab === "channels" ? <AdminChannelsPanel /> : tab === "prompts" ? <AdminPromptCatalogPanel /> : <AdminStoragePoolPanel />}</div>
    </div>
  );
}

function UsersAdmin({ actorRole }: { actorRole: string }) {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [adjusting, setAdjusting] = useState<AdminUser | null>(null);
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
    <div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-[var(--ob-canvas)] text-[var(--ob-muted)]"><tr><th className="p-3">用户</th><th>角色</th><th>状态</th><th>额度</th><th className="pr-3">操作</th></tr></thead><tbody>
      {items.map((user) => <tr key={user.id} className="border-t border-[var(--ob-line)]"><td className="p-3"><div>{user.displayName || "未命名"}</div><div className="text-xs text-[var(--ob-muted)]">{user.email}</div></td><td><select className="ob-field w-28" value={user.role} disabled={actorRole !== "owner" && user.role === "owner"} onChange={(e) => void change(user, { role: e.target.value as AdminUser["role"] })}><option value="owner">owner</option><option value="admin">admin</option><option value="member">member</option></select></td><td><select className="ob-field w-24" value={user.status} disabled={actorRole !== "owner" && user.role === "owner"} onChange={(e) => void change(user, { status: e.target.value as AdminUser["status"] })}><option value="active">正常</option><option value="ban">停用</option></select></td><td>{user.credits}</td><td className="pr-3"><button type="button" className="ob-btn" onClick={() => setAdjusting(user)}>调整额度</button></td></tr>)}
    </tbody></table></div>
    {adjusting ? <CreditAdjustmentDialog user={adjusting} onClose={() => setAdjusting(null)} onSaved={(user) => { setItems((current) => current.map((item) => item.id === user.id ? user : item)); setAdjusting(null); }} /> : null}
  </div>;
}

function CreditAdjustmentDialog({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: (user: AdminUser) => void }) {
  const [delta, setDelta] = useState(0); const [reason, setReason] = useState(""); const [error, setError] = useState("");
  return <div className="ob-overlay z-[150] p-4"><div role="dialog" aria-modal="true" aria-label="调整额度" className="ob-surface mx-auto mt-[12vh] max-w-md p-5"><h2 className="text-lg font-semibold">调整 {user.displayName || user.email} 的额度</h2><div className="mt-4 space-y-3"><label className="block text-sm">变化值<input className="ob-field mt-1" type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} /></label><label className="block text-sm">原因<input className="ob-field mt-1" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>{error ? <p className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<div className="flex justify-end gap-2"><button type="button" className="ob-btn" onClick={onClose}>取消</button><button type="button" className="ob-btn is-primary" onClick={() => void adjustAdminCredits(user.id, { delta, reason, idempotencyKey: crypto.randomUUID() }).then((result) => onSaved(result.user)).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>确认</button></div></div></div></div>;
}

function CreditsAdmin() {
  const [items, setItems] = useState<AdminCreditLog[]>([]); const [userId, setUserId] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState("");
  const load = async () => { try { setError(""); setItems((await listAdminCreditLogs({ userId, reason, pageSize: 100 })).items); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  useEffect(() => { void load(); }, []);
  return <div className="space-y-3"><div className="flex flex-wrap gap-2"><input className="ob-field max-w-xs" placeholder="用户 ID" value={userId} onChange={(e) => setUserId(e.target.value)} /><input className="ob-field max-w-xs" placeholder="原因" value={reason} onChange={(e) => setReason(e.target.value)} /><button type="button" className="ob-btn" onClick={() => void load()}>筛选</button></div>{error ? <p className="text-sm text-[var(--ob-danger)]">{error}</p> : null}<div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]"><table className="w-full min-w-[760px] text-left text-sm"><thead className="bg-[var(--ob-canvas)]"><tr><th className="p-3">时间</th><th>用户</th><th>变化</th><th>余额</th><th>原因</th><th>模型</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-t border-[var(--ob-line)]"><td className="p-3">{new Date(item.createdAt).toLocaleString()}</td><td>{item.userId}</td><td className={item.delta >= 0 ? "text-emerald-600" : "text-[var(--ob-danger)]"}>{item.delta > 0 ? "+" : ""}{item.delta}</td><td>{item.balanceAfter}</td><td>{item.reason}</td><td>{item.model || "-"}</td></tr>)}</tbody></table></div></div>;
}

function ModelsAdmin() {
  const [config, setConfig] = useState<AdminModelCosts>({ modelCosts: [], defaultCredits: 0 });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { void getAdminModelCosts().then(setConfig).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, []);
  const rows = useMemo(() => config.modelCosts, [config.modelCosts]);
  const patchRow = (index: number, patch: Partial<AdminModelCosts["modelCosts"][number]>) => {
    setConfig((current) => ({
      ...current,
      modelCosts: current.modelCosts.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row),
    }));
  };
  return <div className="max-w-3xl space-y-3"><label className="block text-sm">未知模型默认成本<input className="ob-field mt-1 max-w-xs" type="number" min={0} value={config.defaultCredits} onChange={(e) => setConfig((current) => ({ ...current, defaultCredits: Number(e.target.value) }))} /></label>{rows.map((item, index) => <div key={`${item.model}-${index}`} className="grid grid-cols-[1fr_8rem_3rem] gap-2"><input className="ob-field" placeholder="模型 ID" value={item.model} onChange={(e) => patchRow(index, { model: e.target.value })} /><input className="ob-field" type="number" min={0} value={item.credits} onChange={(e) => patchRow(index, { credits: Number(e.target.value) })} /><button type="button" className="ob-icon-btn" aria-label="删除模型成本" onClick={() => setConfig((current) => ({ ...current, modelCosts: current.modelCosts.filter((_, rowIndex) => rowIndex !== index) }))}>×</button></div>)}<div className="flex gap-2"><button type="button" className="ob-btn" onClick={() => setConfig((current) => ({ ...current, modelCosts: [...current.modelCosts, { model: "", credits: 0 }] }))}>添加模型</button><button type="button" className="ob-btn is-primary" onClick={() => void putAdminModelCosts(config).then((saved) => { setConfig(saved); setNotice("已保存"); setError(""); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))}>保存</button></div>{notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}{error ? <p className="text-sm text-[var(--ob-danger)]">{error}</p> : null}</div>;
}
