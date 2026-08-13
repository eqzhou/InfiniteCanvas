import { useEffect, useState } from "react";
import { HardDrive, KeyRound, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import {
  deleteAdminStoragePoolProvider, getAdminStoragePoolStatus, putAdminStoragePool, putAdminStoragePoolSecret,
  AdminStoragePoolError, type AdminStoragePoolErrorCode, type AdminStoragePoolProviderInput, type AdminStoragePoolProviderStatus,
} from "@/services/admin";
import { useI18n } from "@/i18n/I18nProvider";
import { translate, type AppLocale } from "@/i18n/core";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyState, Notice, SectionHeader } from "@/components/admin/AdminSection";

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

export function storageProbeTone(status: AdminStoragePoolProviderStatus): "success" | "danger" | "info" {
  if (!status.probeKnown) return "info";
  return status.probeHealthy ? "success" : "danger";
}

export function storageCapacityTone(status: AdminStoragePoolProviderStatus): "success" | "info" {
  return status.capacityKnown ? "success" : "info";
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
  const [pendingDelete, setPendingDelete] = useState<StorageProviderDraft | null>(null);
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
    setPendingDelete(null);
    setLoading(true);
    try {
      if (secretFor === id) closeCredentialEditor();
      setRevision(await deleteAdminStoragePoolProvider(id, revision));
      await load();
    }
    catch (cause) { setError(storagePoolErrorMessage(cause, locale)); setLoading(false); }
  };
  const requestRemove = (draft: StorageProviderDraft) => {
    if (!storageDeleteTarget(draft)) {
      setDrafts((current) => current.filter((item) => item.clientKey !== draft.clientKey));
      return;
    }
    setPendingDelete(draft);
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

  const credentialDraft = drafts.find((draft) => draft.persistedId === secretFor);
  const credentialKind = storageCredentialKind(credentialDraft?.value.kind ?? "s3");
  const credentialReady = credentialKind === "username-password"
    ? Boolean(username.trim() && password)
    : Boolean(accessKeyId.trim() && secretAccessKey);
  const fallbackItems = items.filter((item) => item.endpoint === undefined);

  return (
    <div className="ob-admin-stack" aria-busy={loading}>
      <section className="ob-admin-section">
        <SectionHeader
          icon={<HardDrive size={16} />}
          title={t("admin.storage.title")}
          desc={t("admin.storage.description")}
          actions={(
            <>
              <span className="ob-micro-label">{t("admin.storage.count", { count: drafts.length })}</span>
              <button type="button" className="ob-btn ob-btn-ghost ob-btn-sm" disabled={loading || !loaded} onClick={() => void load()}>
                <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden />
                {t("common.refresh")}
              </button>
            </>
          )}
        />

        <div className="space-y-3">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {!loading && loaded && !webdavEnabled ? <Notice tone="warning">{t("admin.storage.webdavDisabled")}</Notice> : null}
          {fallbackItems.length ? (
            <div className="ob-subpanel">
              <div className="ob-subpanel-header">
                <HardDrive size={14} aria-hidden />
                <strong className="ob-subpanel-title">{t("admin.storage.fallbackTitle")}</strong>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {fallbackItems.map((item) => (
                  <article key={item.id} className="ob-record">
                    <div className="ob-record-header">
                      <span className="ob-record-title truncate">{item.id}</span>
                      <span className="ob-chip">{t("admin.storage.fallback", { kind: item.kind })}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      <span className="ob-status-chip" data-tone={storageProbeTone(item)}>
                        <span className="ob-status-dot" data-status={item.probeKnown ? (item.probeHealthy ? "succeeded" : "failed") : "pending"} aria-hidden />
                        {storageProbeLabel(item, locale)}
                      </span>
                      <span className="ob-status-chip" data-tone={storageCapacityTone(item)}>
                        {storageCapacityLabel(item, locale)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {!loading && loaded && drafts.length === 0 ? (
            <EmptyState icon={<HardDrive size={20} />} title={t("admin.storage.empty")} />
          ) : null}

          <fieldset className="contents" disabled={loading || Boolean(pendingDelete)}>
            <div className="space-y-3">
              {drafts.map((draft) => {
                const item = draft.value;
                const status = storageDraftStatus(draft, items);
                return (
                  <article key={draft.clientKey} className="ob-record space-y-3">
                    <div className="ob-record-header">
                      <span className="ob-record-title truncate">{item.id || t("admin.storage.newProvider")}</span>
                      <span className="ob-chip">{item.kind === "webdav" ? t("admin.storage.webdav") : "S3 / R2"}</span>
                      {status ? (
                        <span className="ob-status-chip" data-tone={storageProbeTone(status)}>
                          <span className="ob-status-dot" data-status={status.probeKnown ? (status.probeHealthy ? "succeeded" : "failed") : "pending"} aria-hidden />
                          {storageProbeLabel(status, locale)}
                        </span>
                      ) : <span className="ob-status-chip" data-tone="warning">{t("admin.storage.unsaved")}</span>}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      <label className="block">
                        <span className="ob-micro-label mb-1">{t("admin.storage.stableId")}</span>
                        <input className="ob-field" value={item.id} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { id: event.target.value })} />
                      </label>
                      <label className="block">
                        <span className="ob-micro-label mb-1">{t("admin.storage.kind")}</span>
                        <select className="ob-field" value={item.kind ?? "s3"} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { kind: event.target.value === "webdav" ? "webdav" : "s3", bucket: "", region: event.target.value === "webdav" ? "" : "auto", allowPrivate: false })}>
                          <option value="s3">S3 / R2</option>
                          <option value="webdav" disabled={!webdavEnabled}>{t("admin.storage.webdav")}</option>
                        </select>
                      </label>
                      <label className="block xl:col-span-2">
                        <span className="ob-micro-label mb-1">{item.kind === "webdav" ? t("admin.storage.webdavEndpoint") : t("admin.storage.s3Endpoint")}</span>
                        <input className="ob-field" value={item.endpoint} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { endpoint: event.target.value })} />
                      </label>
                      {item.kind !== "webdav" ? <>
                        <label className="block">
                          <span className="ob-micro-label mb-1">{t("admin.storage.bucket")}</span>
                          <input className="ob-field" value={item.bucket} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { bucket: event.target.value })} />
                        </label>
                        <label className="block">
                          <span className="ob-micro-label mb-1">{t("admin.storage.region")}</span>
                          <input className="ob-field" value={item.region} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { region: event.target.value })} />
                        </label>
                      </> : null}
                      <label className="block">
                        <span className="ob-micro-label mb-1">{t("admin.storage.prefix")}</span>
                        <input className="ob-field" value={item.prefix} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { prefix: event.target.value })} />
                      </label>
                      <label className="block">
                        <span className="ob-micro-label mb-1">{t("admin.storage.weight")}</span>
                        <input className="ob-field" type="number" min={0} max={10000} value={item.weight} onChange={(event) => update(draft.clientKey, { weight: Number(event.target.value) })} />
                      </label>
                    </div>
                    <div className="ob-check-row">
                      <label className="ob-check-chip"><input type="checkbox" checked={item.healthy} onChange={(event) => update(draft.clientKey, { healthy: event.target.checked })} />{t("admin.storage.newWrites")}</label>
                      <label className="ob-check-chip"><input type="checkbox" checked={item.allowInsecureLoopback} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { allowInsecureLoopback: event.target.checked })} />{t("admin.storage.loopback")}</label>
                      {item.kind === "webdav" ? <label className="ob-check-chip"><input type="checkbox" checked={item.allowPrivate ?? false} disabled={Boolean(status)} onChange={(event) => update(draft.clientKey, { allowPrivate: event.target.checked })} />{t("admin.storage.privateHttps")}</label> : null}
                    </div>
                    <div className="ob-record-actions">
                      <div className="min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs text-[var(--ob-muted)] sm:flex">
                        {status ? <>
                          <span className="ob-status-chip" data-tone={storageCapacityTone(status)}>{storageCapacityLabel(status, locale)}</span>
                          <span>{status.secretConfigured ? t("admin.storage.credentialConfigured") : t("admin.storage.credentialMissing")}</span>
                        </> : <span>{t("admin.storage.saveBeforeCredential")}</span>}
                      </div>
                      {status ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => openCredentialEditor(draft.persistedId!)}><KeyRound size={14} aria-hidden />{t("admin.storage.updateCredential")}</button> : null}
                      <button type="button" className="ob-btn ob-btn-danger ob-btn-sm" onClick={() => requestRemove(draft)}><Trash2 size={14} aria-hidden />{t("common.delete")}</button>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="ob-record-actions">
              <button type="button" className="ob-btn" disabled={!loaded || loading} onClick={() => setDrafts((current) => [...current, newStorageProviderDraft(crypto.randomUUID())])}>
                <Plus size={14} aria-hidden />{t("admin.storage.new")}
              </button>
              <span className="ob-record-actions-end" />
              <button type="button" className="ob-btn ob-btn-primary" disabled={!loaded || loading} onClick={() => void save()}>
                <Save size={14} aria-hidden />{t("admin.storage.save")}
              </button>
            </div>
          </fieldset>
        </div>
      </section>

      {secretFor ? (
        <section className="ob-review" role="region" aria-labelledby="storage-credential-title">
          <div className="ob-record-header">
            <span className="ob-admin-section-icon" aria-hidden><KeyRound size={15} /></span>
            <div className="min-w-0">
              <h2 id="storage-credential-title" className="ob-record-title truncate">{t("admin.storage.update")} {secretFor} {t("admin.storage.credential")}</h2>
              <p className="ob-admin-section-desc">{t("admin.storage.credentialHint")}</p>
            </div>
          </div>
          {credentialKind === "username-password" ? (
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block"><span className="ob-micro-label mb-1">{t("admin.storage.username")}</span><input autoFocus className="ob-field" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
              <label className="block"><span className="ob-micro-label mb-1">{t("admin.storage.password")}</span><input className="ob-field" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block"><span className="ob-micro-label mb-1">{t("admin.storage.accessKeyId")}</span><input autoFocus className="ob-field" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} /></label>
              <label className="block"><span className="ob-micro-label mb-1">{t("admin.storage.secretAccessKey")}</span><input className="ob-field" type="password" autoComplete="new-password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} /></label>
              <label className="block"><span className="ob-micro-label mb-1">{t("admin.storage.sessionToken")}</span><input className="ob-field" type="password" autoComplete="new-password" value={sessionToken} onChange={(event) => setSessionToken(event.target.value)} /></label>
            </div>
          )}
          <div className="ob-record-actions">
            <span className="ob-record-actions-end" />
            <button type="button" className="ob-btn" onClick={closeCredentialEditor}><X size={14} aria-hidden />{t("common.cancel")}</button>
            <button type="button" className="ob-btn ob-btn-primary" disabled={!credentialReady || loading} onClick={() => void saveSecret()}>{t("admin.storage.encryptSave")}</button>
          </div>
        </section>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={t("admin.storage.deleteTitle")}
          message={t("admin.storage.confirmDelete", { id: pendingDelete.value.id })}
          confirmLabel={t("common.delete")}
          busy={loading}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void remove(pendingDelete)}
        />
      ) : null}
    </div>
  );
}
