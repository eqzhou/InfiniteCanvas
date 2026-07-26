import { useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  deleteAdminStoragePoolProvider, getAdminStoragePoolStatus, putAdminStoragePool, putAdminStoragePoolSecret,
  type AdminStoragePoolProviderInput, type AdminStoragePoolProviderStatus,
} from "@/services/admin";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value; let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function storageProbeLabel(status: AdminStoragePoolProviderStatus): string {
  if (!status.probeKnown) return "未知（权限中立）";
  return status.probeHealthy ? "探测正常" : "探测失败";
}

export function storageCapacityLabel(status: AdminStoragePoolProviderStatus): string {
  if (!status.capacityKnown || status.totalBytes === undefined || status.availableBytes === undefined) return "未知（提供商未暴露）";
  return `${formatBytes(status.availableBytes)} 可用 / ${formatBytes(status.totalBytes)}`;
}

const blankProvider = (): AdminStoragePoolProviderInput => ({ id: "", endpoint: "https://", bucket: "", region: "auto", prefix: "openboard", weight: 1, healthy: true, allowInsecureLoopback: false });

function editable(items: AdminStoragePoolProviderStatus[]): AdminStoragePoolProviderInput[] {
  return items.filter((item) => item.endpoint !== undefined).map((item) => ({ id: item.id, endpoint: item.endpoint ?? "", bucket: item.bucket ?? "", region: item.region ?? "auto", prefix: item.prefix ?? "openboard", weight: item.weight, healthy: item.healthy ?? item.configuredSelectable, allowInsecureLoopback: item.allowInsecureLoopback ?? false }));
}

export function AdminStoragePoolPanel() {
  const [items, setItems] = useState<AdminStoragePoolProviderStatus[]>([]);
  const [drafts, setDrafts] = useState<AdminStoragePoolProviderInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [secretFor, setSecretFor] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const load = async () => {
    setLoading(true);
    try { const next = await getAdminStoragePoolStatus(); setItems(next); setDrafts(editable(next)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const update = (index: number, patch: Partial<AdminStoragePoolProviderInput>) => setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const save = async () => {
    setLoading(true);
    try { const next = await putAdminStoragePool(drafts); setItems(next); setDrafts(editable(next)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const remove = async (id: string, index: number) => {
    if (!id) { setDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index)); return; }
    setLoading(true);
    try { await deleteAdminStoragePoolProvider(id); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
  };
  const saveSecret = async () => {
    setLoading(true);
    try { await putAdminStoragePoolSecret(secretFor, { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }); setSecretFor(""); setAccessKeyId(""); setSecretAccessKey(""); setSessionToken(""); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
  };

  return <section className="space-y-4" aria-labelledby="storage-pool-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="storage-pool-title" className="text-lg font-semibold">租户存储池</h2><p className="text-sm text-[var(--ob-muted)]">用户单存储优先，其次使用这里的加权池，最后回退到进程存储。凭据加密保存且永不回显。</p></div>
      <div className="flex gap-2"><button type="button" className="ob-btn" disabled={loading} onClick={() => setDrafts((current) => [...current, blankProvider()])}><Plus size={15} />新增</button><button type="button" className="ob-btn" disabled={loading} onClick={() => void save()}><Save size={15} />保存</button><button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新</button></div>
    </div>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    {!loading && drafts.length === 0 ? <div className="ob-surface p-5 text-sm text-[var(--ob-muted)]">尚未配置租户存储池；当前使用进程级存储回退。</div> : null}
    {items.some((item) => item.endpoint === undefined) ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.filter((item) => item.endpoint === undefined).map((item) => <article key={item.id} className="ob-surface space-y-2 p-4"><div className="flex justify-between gap-3"><div><h3 className="font-medium">{item.id}</h3><p className="text-xs text-[var(--ob-muted)]">进程回退 · {item.kind}</p></div><span className="text-xs">权重 {item.weight}</span></div><p className="text-sm">{storageProbeLabel(item)} · {storageCapacityLabel(item)}</p></article>)}</div> : null}
    <div className="space-y-3">
      {drafts.map((item, index) => { const status = items.find((candidate) => candidate.id === item.id); return <article key={`${item.id}-${index}`} className="ob-surface space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm">稳定 ID<input className="ob-input mt-1 w-full" value={item.id} disabled={Boolean(status)} onChange={(event) => update(index, { id: event.target.value })} /></label>
          <label className="text-sm xl:col-span-2">S3/R2 Endpoint<input className="ob-input mt-1 w-full" value={item.endpoint} disabled={Boolean(status)} onChange={(event) => update(index, { endpoint: event.target.value })} /></label>
          <label className="text-sm">Bucket<input className="ob-input mt-1 w-full" value={item.bucket} disabled={Boolean(status)} onChange={(event) => update(index, { bucket: event.target.value })} /></label>
          <label className="text-sm">Region<input className="ob-input mt-1 w-full" value={item.region} disabled={Boolean(status)} onChange={(event) => update(index, { region: event.target.value })} /></label>
          <label className="text-sm">Prefix<input className="ob-input mt-1 w-full" value={item.prefix} disabled={Boolean(status)} onChange={(event) => update(index, { prefix: event.target.value })} /></label>
          <label className="text-sm">权重<input className="ob-input mt-1 w-full" type="number" min={0} max={10000} value={item.weight} onChange={(event) => update(index, { weight: Number(event.target.value) })} /></label>
          <div className="flex items-end gap-4 pb-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={item.healthy} onChange={(event) => update(index, { healthy: event.target.checked })} />参与新写入</label><label className="flex items-center gap-2"><input type="checkbox" checked={item.allowInsecureLoopback} disabled={Boolean(status)} onChange={(event) => update(index, { allowInsecureLoopback: event.target.checked })} />本机 HTTP</label></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--ob-muted)]"><span>{status ? `${storageProbeLabel(status)} · ${storageCapacityLabel(status)} · ${status.secretConfigured ? "凭据已配置" : "凭据缺失"}` : "保存后可配置凭据"}</span><div className="flex gap-2">{status ? <button type="button" className="ob-btn" onClick={() => setSecretFor(item.id)}><KeyRound size={14} />更新凭据</button> : null}<button type="button" className="ob-btn text-[var(--ob-danger)]" onClick={() => void remove(status ? item.id : "", index)}><Trash2 size={14} />删除</button></div></div>
      </article>; })}
    </div>
    {secretFor ? <div className="ob-surface space-y-3 p-4"><h3 className="font-medium">更新 {secretFor} 凭据</h3><div className="grid gap-3 md:grid-cols-3"><input className="ob-input" placeholder="Access Key ID" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} /><input className="ob-input" type="password" placeholder="Secret Access Key" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} /><input className="ob-input" type="password" placeholder="Session Token（可选）" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} /></div><div className="flex gap-2"><button type="button" className="ob-btn ob-btn-primary" onClick={() => void saveSecret()}>加密保存</button><button type="button" className="ob-btn" onClick={() => setSecretFor("")}>取消</button></div></div> : null}
  </section>;
}
