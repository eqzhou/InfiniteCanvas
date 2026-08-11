import { useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  deleteAdminStoragePoolProvider, getAdminStoragePoolStatus, putAdminStoragePool, putAdminStoragePoolSecret,
  type AdminStoragePoolProviderInput, type AdminStoragePoolProviderStatus,
} from "@/services/admin";
import { useI18n } from "@/i18n/I18nProvider";
import { translate, type AppLocale } from "@/i18n/core";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value; let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function storageProbeLabel(status: AdminStoragePoolProviderStatus, locale: AppLocale = "zh-CN"): string {
  if (!status.probeKnown) return translate(locale, "admin.storage.probeUnknown");
  return status.probeHealthy ? translate(locale, "admin.storage.probeHealthy") : translate(locale, "admin.storage.probeFailed");
}

export function storageCapacityLabel(status: AdminStoragePoolProviderStatus, locale: AppLocale = "zh-CN"): string {
  if (!status.capacityKnown || status.totalBytes === undefined || status.availableBytes === undefined) return translate(locale, "admin.storage.capacityUnknown");
  return translate(locale, "admin.storage.capacity", { available: formatBytes(status.availableBytes), total: formatBytes(status.totalBytes) });
}

export const blankStorageProvider = (): AdminStoragePoolProviderInput => ({ kind: "s3", id: "", endpoint: "https://", bucket: "", region: "auto", prefix: "openboard", weight: 1, healthy: true, allowPrivate: false, allowInsecureLoopback: false });

export function storageCredentialKind(kind: string): "access-key" | "username-password" {
  return kind === "webdav" ? "username-password" : "access-key";
}

function editable(items: AdminStoragePoolProviderStatus[]): AdminStoragePoolProviderInput[] {
  return items.filter((item) => item.endpoint !== undefined).map((item) => ({ kind: item.kind === "webdav" ? "webdav" : "s3", id: item.id, endpoint: item.endpoint ?? "", bucket: item.bucket ?? "", region: item.region ?? (item.kind === "webdav" ? "" : "auto"), prefix: item.prefix ?? "openboard", weight: item.weight, healthy: item.healthy ?? item.configuredSelectable, allowPrivate: item.allowPrivate ?? false, allowInsecureLoopback: item.allowInsecureLoopback ?? false }));
}

export function AdminStoragePoolPanel() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<AdminStoragePoolProviderStatus[]>([]);
  const [drafts, setDrafts] = useState<AdminStoragePoolProviderInput[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState("");
  const [error, setError] = useState("");
  const [secretFor, setSecretFor] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const load = async () => {
    setLoading(true);
    setLoaded(false);
    try { const result = await getAdminStoragePoolStatus(); setItems(result.items); setDrafts(editable(result.items)); setRevision(result.revision); setError(""); setLoaded(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const update = (index: number, patch: Partial<AdminStoragePoolProviderInput>) => setDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const save = async () => {
    setLoading(true);
    try { const result = await putAdminStoragePool(drafts, revision); setItems(result.items); setDrafts(editable(result.items)); setRevision(result.revision); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const remove = async (id: string, index: number) => {
    if (!id) { setDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index)); return; }
    setLoading(true);
    try { setRevision(await deleteAdminStoragePoolProvider(id, revision)); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
  };
  const saveSecret = async () => {
    setLoading(true);
    const provider = drafts.find((item) => item.id === secretFor);
    try {
      if (storageCredentialKind(provider?.kind ?? "s3") === "username-password") await putAdminStoragePoolSecret(secretFor, { username, password });
      else await putAdminStoragePoolSecret(secretFor, { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) });
      setSecretFor(""); setAccessKeyId(""); setSecretAccessKey(""); setSessionToken(""); setUsername(""); setPassword(""); await load();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
  };

  return <section className="space-y-4" aria-labelledby="storage-pool-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="storage-pool-title" className="text-lg font-semibold">{t("admin.storage.title")}</h2><p className="text-sm text-[var(--ob-muted)]">{t("admin.storage.description")}</p></div>
      <div className="flex gap-2"><button type="button" className="ob-btn" disabled={loading || !loaded} onClick={() => setDrafts((current) => [...current, blankStorageProvider()])}><Plus size={15} />{t("admin.storage.new")}</button><button type="button" className="ob-btn ob-btn-primary" disabled={loading || !loaded} onClick={() => void save()}><Save size={15} />{t("admin.storage.save")}</button><button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />{loaded ? t("common.refresh") : t("admin.channels.reload")}</button></div>
    </div>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    {!loading && loaded && drafts.length === 0 ? <div className="ob-surface p-5 text-sm text-[var(--ob-muted)]">{t("admin.storage.empty")}</div> : null}
    {items.some((item) => item.endpoint === undefined) ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.filter((item) => item.endpoint === undefined).map((item) => <article key={item.id} className="ob-surface space-y-2 p-4"><div className="flex justify-between gap-3"><div><h3 className="font-medium">{item.id}</h3><p className="text-xs text-[var(--ob-muted)]">{t("admin.storage.fallback", { kind: item.kind })}</p></div><span className="text-xs">{t("admin.storage.weight")} {item.weight}</span></div><p className="text-sm">{storageProbeLabel(item, locale)} · {storageCapacityLabel(item, locale)}</p></article>)}</div> : null}
    <div className="space-y-3">
      {drafts.map((item, index) => { const status = items.find((candidate) => candidate.id === item.id); return <article key={index} className="ob-surface space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm">{t("admin.storage.stableId")}<input className="ob-input mt-1 w-full" value={item.id} disabled={Boolean(status)} onChange={(event) => update(index, { id: event.target.value })} /></label>
          <label className="text-sm">{t("admin.storage.kind")}<select className="ob-input mt-1 w-full" value={item.kind ?? "s3"} disabled={Boolean(status)} onChange={(event) => update(index, { kind: event.target.value === "webdav" ? "webdav" : "s3", bucket: "", region: event.target.value === "webdav" ? "" : "auto", allowPrivate: false })}><option value="s3">S3 / R2</option><option value="webdav">{t("admin.storage.webdav")}</option></select></label>
          <label className="text-sm xl:col-span-2">{item.kind === "webdav" ? "WebDAV Endpoint" : "S3/R2 Endpoint"}<input className="ob-input mt-1 w-full" value={item.endpoint} disabled={Boolean(status)} onChange={(event) => update(index, { endpoint: event.target.value })} /></label>
          {item.kind !== "webdav" ? <><label className="text-sm">Bucket<input className="ob-input mt-1 w-full" value={item.bucket} disabled={Boolean(status)} onChange={(event) => update(index, { bucket: event.target.value })} /></label>
          <label className="text-sm">Region<input className="ob-input mt-1 w-full" value={item.region} disabled={Boolean(status)} onChange={(event) => update(index, { region: event.target.value })} /></label></> : null}
          <label className="text-sm">Prefix<input className="ob-input mt-1 w-full" value={item.prefix} disabled={Boolean(status)} onChange={(event) => update(index, { prefix: event.target.value })} /></label>
          <label className="text-sm">{t("admin.storage.weight")}<input className="ob-input mt-1 w-full" type="number" min={0} max={10000} value={item.weight} onChange={(event) => update(index, { weight: Number(event.target.value) })} /></label>
          <div className="flex items-end gap-4 pb-2 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={item.healthy} onChange={(event) => update(index, { healthy: event.target.checked })} />{t("admin.storage.newWrites")}</label><label className="flex items-center gap-2"><input type="checkbox" checked={item.allowInsecureLoopback} disabled={Boolean(status)} onChange={(event) => update(index, { allowInsecureLoopback: event.target.checked })} />{t("admin.storage.loopback")}</label>{item.kind === "webdav" ? <label className="flex items-center gap-2"><input type="checkbox" checked={item.allowPrivate ?? false} disabled={Boolean(status)} onChange={(event) => update(index, { allowPrivate: event.target.checked })} />{t("admin.storage.privateHttps")}</label> : null}</div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--ob-muted)]"><span>{status ? `${storageProbeLabel(status, locale)} · ${storageCapacityLabel(status, locale)} · ${status.secretConfigured ? t("admin.storage.credentialConfigured") : t("admin.storage.credentialMissing")}` : t("admin.storage.saveBeforeCredential")}</span><div className="flex gap-2">{status ? <button type="button" className="ob-btn" onClick={() => setSecretFor(item.id)}><KeyRound size={14} />{t("admin.storage.updateCredential")}</button> : null}<button type="button" className="ob-btn text-[var(--ob-danger)]" onClick={() => void remove(status ? item.id : "", index)}><Trash2 size={14} />{t("common.delete")}</button></div></div>
      </article>; })}
    </div>
    {secretFor ? <div className="ob-surface space-y-3 p-4"><h3 className="font-medium">{t("admin.storage.update")} {secretFor} {t("admin.storage.credential")}</h3>{storageCredentialKind(drafts.find((item) => item.id === secretFor)?.kind ?? "s3") === "username-password" ? <div className="grid gap-3 md:grid-cols-2"><input className="ob-input" placeholder={t("admin.storage.username")} value={username} onChange={(event) => setUsername(event.target.value)} /><input className="ob-input" type="password" autoComplete="new-password" placeholder={t("admin.storage.password")} value={password} onChange={(event) => setPassword(event.target.value)} /></div> : <div className="grid gap-3 md:grid-cols-3"><input className="ob-input" placeholder="Access Key ID" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} /><input className="ob-input" type="password" placeholder="Secret Access Key" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} /><input className="ob-input" type="password" placeholder={t("admin.storage.sessionToken")} value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} /></div>}<div className="flex gap-2"><button type="button" className="ob-btn ob-btn-primary" onClick={() => void saveSecret()}>{t("admin.storage.encryptSave")}</button><button type="button" className="ob-btn" onClick={() => setSecretFor("")}>{t("common.cancel")}</button></div></div> : null}
  </section>;
}
