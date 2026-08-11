import { useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  deleteAdminStoragePoolProvider, getAdminStoragePoolStatus, putAdminStoragePool, putAdminStoragePoolSecret,
  AdminStoragePoolError, type AdminStoragePoolErrorCode, type AdminStoragePoolProviderInput, type AdminStoragePoolProviderStatus,
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

const storagePoolErrorKeys: Record<AdminStoragePoolErrorCode, keyof typeof import("@/i18n/messages/admin").adminZhCN> = {
  "invalid-provider": "admin.storage.error.invalidProvider",
  "invalid-endpoint": "admin.storage.error.invalidEndpoint",
  "insecure-endpoint": "admin.storage.error.insecureEndpoint",
  "too-many-providers": "admin.storage.error.tooManyProviders",
  "duplicate-provider-id": "admin.storage.error.duplicateProviderId",
  "invalid-revision": "admin.storage.error.invalidRevision",
  "invalid-response": "admin.storage.error.invalidResponse",
  "invalid-capacity-response": "admin.storage.error.invalidResponse",
  "empty-webdav-credential": "admin.storage.error.emptyWebdavCredential",
  "empty-s3-credential": "admin.storage.error.emptyS3Credential",
  "invalid-request": "admin.storage.error.invalidRequest",
  "authentication-required": "admin.storage.error.authenticationRequired",
  "permission-denied": "admin.storage.error.permissionDenied",
  "not-found": "admin.storage.error.notFound",
  "conflict": "admin.storage.error.conflict",
  "request-too-large": "admin.storage.error.requestTooLarge",
  "rate-limited": "admin.storage.error.rateLimited",
  "server-unavailable": "admin.storage.error.serverUnavailable",
  "request-failed": "admin.storage.error.requestFailed",
};

export function storagePoolErrorMessage(cause: unknown, locale: AppLocale = "zh-CN"): string {
  if (cause instanceof AdminStoragePoolError) return translate(locale, storagePoolErrorKeys[cause.code]);
  return translate(locale, "admin.storage.error.requestFailed");
}

export const blankStorageProvider = (): AdminStoragePoolProviderInput => ({ kind: "s3", id: "", endpoint: "https://", bucket: "", region: "auto", prefix: "openboard", weight: 1, healthy: true, allowPrivate: false, allowInsecureLoopback: false });

export type StorageProviderDraft = Readonly<{
  clientKey: string;
  persistedId?: string;
  value: AdminStoragePoolProviderInput;
}>;

export function newStorageProviderDraft(clientKey: string, value = blankStorageProvider()): StorageProviderDraft {
  return { clientKey, value };
}

export function storageCredentialKind(kind: string): "access-key" | "username-password" {
  return kind === "webdav" ? "username-password" : "access-key";
}

export function blankStorageCredentials() {
  return { accessKeyId: "", secretAccessKey: "", sessionToken: "", username: "", password: "" };
}

export function persistedStorageProviderDrafts(items: AdminStoragePoolProviderStatus[]): StorageProviderDraft[] {
  return items.filter((item) => item.endpoint !== undefined).map((item) => ({
    clientKey: `persisted:${item.id}`,
    persistedId: item.id,
    value: { kind: item.kind === "webdav" ? "webdav" : "s3", id: item.id, endpoint: item.endpoint ?? "", bucket: item.bucket ?? "", region: item.region ?? (item.kind === "webdav" ? "" : "auto"), prefix: item.prefix ?? "openboard", weight: item.weight, healthy: item.healthy ?? item.configuredSelectable, allowPrivate: item.allowPrivate ?? false, allowInsecureLoopback: item.allowInsecureLoopback ?? false },
  }));
}

export function storageDraftStatus(draft: StorageProviderDraft, items: AdminStoragePoolProviderStatus[]): AdminStoragePoolProviderStatus | undefined {
  return draft.persistedId ? items.find((candidate) => candidate.id === draft.persistedId) : undefined;
}

export function storageDeleteTarget(draft: StorageProviderDraft): string | undefined {
  return draft.persistedId;
}

export function AdminStoragePoolPanel() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<AdminStoragePoolProviderStatus[]>([]);
  const [drafts, setDrafts] = useState<StorageProviderDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState("");
  const [webdavEnabled, setWebdavEnabled] = useState(false);
  const [error, setError] = useState("");
  const [secretFor, setSecretFor] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const resetCredentials = () => {
    const blank = blankStorageCredentials();
    setAccessKeyId(blank.accessKeyId); setSecretAccessKey(blank.secretAccessKey); setSessionToken(blank.sessionToken);
    setUsername(blank.username); setPassword(blank.password);
  };
  const closeCredentialEditor = () => { resetCredentials(); setSecretFor(""); };
  const openCredentialEditor = (providerId: string) => { resetCredentials(); setSecretFor(providerId); };
  const load = async () => {
    setLoading(true);
    setLoaded(false);
    try { const result = await getAdminStoragePoolStatus(); setItems(result.items); setDrafts(persistedStorageProviderDrafts(result.items)); setRevision(result.revision); setWebdavEnabled(result.webdavEnabled); setError(""); setLoaded(true); }
    catch (cause) { setError(storagePoolErrorMessage(cause, locale)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const update = (clientKey: string, patch: Partial<AdminStoragePoolProviderInput>) => setDrafts((current) => current.map((draft) => draft.clientKey === clientKey ? { ...draft, value: { ...draft.value, ...patch } } : draft));
  const save = async () => {
    setLoading(true);
    try { const result = await putAdminStoragePool(drafts.map((draft) => draft.value), revision); setItems(result.items); setDrafts(persistedStorageProviderDrafts(result.items)); setRevision(result.revision); setError(""); }
    catch (cause) { setError(storagePoolErrorMessage(cause, locale)); }
    finally { setLoading(false); }
  };
  const remove = async (draft: StorageProviderDraft) => {
    const id = storageDeleteTarget(draft);
    if (!id) { setDrafts((current) => current.filter((item) => item.clientKey !== draft.clientKey)); return; }
    if (!window.confirm(t("admin.storage.confirmDelete", { id }))) return;
    setLoading(true);
    try { setRevision(await deleteAdminStoragePoolProvider(id, revision)); await load(); }
    catch (cause) { setError(storagePoolErrorMessage(cause, locale)); setLoading(false); }
  };
  const saveSecret = async () => {
    setLoading(true);
    const provider = drafts.find((draft) => draft.persistedId === secretFor)?.value;
    try {
      if (storageCredentialKind(provider?.kind ?? "s3") === "username-password") await putAdminStoragePoolSecret(secretFor, { username, password });
      else await putAdminStoragePoolSecret(secretFor, { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) });
	  closeCredentialEditor(); await load();
    }
    catch (cause) { setError(storagePoolErrorMessage(cause, locale)); setLoading(false); }
  };

  return <section className="space-y-4" aria-labelledby="storage-pool-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="storage-pool-title" className="text-lg font-semibold">{t("admin.storage.title")}</h2><p className="text-sm text-[var(--ob-muted)]">{t("admin.storage.description")}</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" className="ob-btn" disabled={loading || !loaded} onClick={() => setDrafts((current) => [...current, newStorageProviderDraft(crypto.randomUUID())])}><Plus size={15} />{t("admin.storage.new")}</button><button type="button" className="ob-btn ob-btn-primary" disabled={loading || !loaded} onClick={() => void save()}><Save size={15} />{t("admin.storage.save")}</button><button type="button" className="ob-btn" disabled={loading} onClick={() => void load()}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />{loaded ? t("common.refresh") : t("admin.channels.reload")}</button></div>
    </div>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    {!loading && loaded && !webdavEnabled ? <p className="text-sm text-[var(--ob-muted)]">{t("admin.storage.webdavDisabled")}</p> : null}
    {!loading && loaded && drafts.length === 0 ? <div className="ob-surface p-5 text-sm text-[var(--ob-muted)]">{t("admin.storage.empty")}</div> : null}
    {items.some((item) => item.endpoint === undefined) ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.filter((item) => item.endpoint === undefined).map((item) => <article key={item.id} className="ob-surface space-y-2 p-4"><div className="flex justify-between gap-3"><div><h3 className="font-medium">{item.id}</h3><p className="text-xs text-[var(--ob-muted)]">{t("admin.storage.fallback", { kind: item.kind })}</p></div><span className="text-xs">{t("admin.storage.weight")} {item.weight}</span></div><p className="text-sm">{storageProbeLabel(item, locale)} · {storageCapacityLabel(item, locale)}</p></article>)}</div> : null}
    <div className="space-y-3">
      {drafts.map((draft) => { const item = draft.value; const status = storageDraftStatus(draft, items); return <article key={draft.clientKey} className="ob-surface space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm">{t("admin.storage.stableId")}<input className="ob-input mt-1 w-full" value={item.id} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { id: event.target.value })} /></label>
          <label className="text-sm">{t("admin.storage.kind")}<select className="ob-input mt-1 w-full" value={item.kind ?? "s3"} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { kind: event.target.value === "webdav" ? "webdav" : "s3", bucket: "", region: event.target.value === "webdav" ? "" : "auto", allowPrivate: false })}><option value="s3">S3 / R2</option><option value="webdav" disabled={!webdavEnabled}>{t("admin.storage.webdav")}</option></select></label>
          <label className="text-sm xl:col-span-2">{item.kind === "webdav" ? t("admin.storage.webdavEndpoint") : t("admin.storage.s3Endpoint")}<input className="ob-input mt-1 w-full" value={item.endpoint} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { endpoint: event.target.value })} /></label>
          {item.kind !== "webdav" ? <><label className="text-sm">{t("admin.storage.bucket")}<input className="ob-input mt-1 w-full" value={item.bucket} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { bucket: event.target.value })} /></label>
          <label className="text-sm">{t("admin.storage.region")}<input className="ob-input mt-1 w-full" value={item.region} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { region: event.target.value })} /></label></> : null}
          <label className="text-sm">{t("admin.storage.prefix")}<input className="ob-input mt-1 w-full" value={item.prefix} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { prefix: event.target.value })} /></label>
          <label className="text-sm">{t("admin.storage.weight")}<input className="ob-input mt-1 w-full" type="number" min={0} max={10000} value={item.weight} onChange={(event) => update(draft.clientKey, { weight: Number(event.target.value) })} /></label>
          <div className="flex flex-wrap items-end gap-4 pb-2 text-sm"><label className="flex min-h-6 items-center gap-2"><input type="checkbox" checked={item.healthy} onChange={(event) => update(draft.clientKey, { healthy: event.target.checked })} />{t("admin.storage.newWrites")}</label><label className="flex min-h-6 items-center gap-2"><input type="checkbox" checked={item.allowInsecureLoopback} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { allowInsecureLoopback: event.target.checked })} />{t("admin.storage.loopback")}</label>{item.kind === "webdav" ? <label className="flex min-h-6 items-center gap-2"><input type="checkbox" checked={item.allowPrivate ?? false} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { allowPrivate: event.target.checked })} />{t("admin.storage.privateHttps")}</label> : null}</div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--ob-muted)]"><span>{status ? `${storageProbeLabel(status, locale)} · ${storageCapacityLabel(status, locale)} · ${status.secretConfigured ? t("admin.storage.credentialConfigured") : t("admin.storage.credentialMissing")}` : t("admin.storage.saveBeforeCredential")}</span><div className="flex flex-wrap gap-2">{status ? <button type="button" className="ob-btn" onClick={() => openCredentialEditor(draft.persistedId!)}><KeyRound size={14} />{t("admin.storage.updateCredential")}</button> : null}<button type="button" className="ob-btn text-[var(--ob-danger)]" onClick={() => void remove(draft)}><Trash2 size={14} />{t("common.delete")}</button></div></div>
      </article>; })}
    </div>
    {secretFor ? <div className="ob-surface space-y-3 p-4" role="region" aria-labelledby="storage-credential-title"><h3 id="storage-credential-title" className="font-medium">{t("admin.storage.update")} {secretFor} {t("admin.storage.credential")}</h3>{storageCredentialKind(drafts.find((draft) => draft.persistedId === secretFor)?.value.kind ?? "s3") === "username-password" ? <div className="grid gap-3 md:grid-cols-2"><label className="text-sm">{t("admin.storage.username")}<input autoFocus className="ob-input mt-1 w-full" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label className="text-sm">{t("admin.storage.password")}<input className="ob-input mt-1 w-full" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></div> : <div className="grid gap-3 md:grid-cols-3"><label className="text-sm">{t("admin.storage.accessKeyId")}<input autoFocus className="ob-input mt-1 w-full" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} /></label><label className="text-sm">{t("admin.storage.secretAccessKey")}<input className="ob-input mt-1 w-full" type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} /></label><label className="text-sm">{t("admin.storage.sessionToken")}<input className="ob-input mt-1 w-full" type="password" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} /></label></div>}<div className="flex flex-wrap gap-2"><button type="button" className="ob-btn ob-btn-primary" onClick={() => void saveSecret()}>{t("admin.storage.encryptSave")}</button><button type="button" className="ob-btn" onClick={closeCredentialEditor}>{t("common.cancel")}</button></div></div> : null}
  </section>;
}
