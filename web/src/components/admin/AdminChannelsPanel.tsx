import { useEffect, useRef, useState } from "react";
import {
  deleteAdminChannel,
  fetchAdminChannelModels,
  listAdminChannels,
  putAdminChannelSecret,
  putAdminChannels,
  testAdminChannel,
  type AdminChannel,
  type AdminChannelProtocol,
  type AdminMediaCapability,
  type AdminMediaKind,
  type AdminMediaMode,
} from "@/services/admin";
import { invalidateSharedChannelCatalog } from "@/services/shared-channels";
import { uid } from "@/lib/id";
import {
  applyAdminChannelModelSelection,
  adminChannelSecretBindingIsCurrent,
  buildAdminChannelModelDiff,
  mergeSavedAdminChannels,
  shouldDeleteAdminChannel,
  type AdminChannelModelDiff,
} from "@/lib/admin-channel-state";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

const protocols: AdminChannelProtocol[] = ["openai", "gemini", "apimart", "kie", "azure", "edge"];

export function adminChannelCanTest(
  channel: Pick<AdminChannel, "protocol" | "secretConfigured">,
): boolean {
  return channel.protocol === "edge" || channel.secretConfigured;
}

export function emptyAdminChannel(index: number, name = `共享渠道 ${index}`): AdminChannel {
  return {
    id: uid("shared"),
    name,
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai",
    enabled: true,
    allowUserUse: true,
    weight: 1,
    timeoutSeconds: 60,
    models: [],
    mediaCapabilities: [],
    defaultTextModel: "",
    defaultImageModel: "",
    defaultVideoModel: "",
    defaultAudioModel: "",
    secretConfigured: false,
  };
}

export function AdminChannelNameField({
  channel,
  onChange,
}: {
  channel: Pick<AdminChannel, "name">;
  onChange: (name: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field label={t("admin.channels.name")}>
      <input className="ob-field" value={channel.name} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function modelsText(channel: AdminChannel): string {
  return (channel.models ?? []).join("\n");
}

function parseModelsText(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const capabilityModes: Record<AdminMediaKind, Array<{ id: AdminMediaMode; label: MessageKey }>> = {
  image: [{ id: "text_to_image", label: "admin.channels.textToImage" }, { id: "image_to_image", label: "admin.channels.imageToImage" }],
  video: [{ id: "text_to_video", label: "admin.channels.textToVideo" }, { id: "image_to_video", label: "admin.channels.imageToVideo" }],
  audio: [{ id: "text_to_audio", label: "admin.channels.textToAudio" }],
};

function defaultCapability(model: string, kind: AdminMediaKind = "image"): AdminMediaCapability {
  return { model, kind, modes: [capabilityModes[kind][0].id], sizes: [], durations: [], maxReferences: 0 };
}

export function AdminMediaCapabilityEditor({
  models,
  capabilities,
  onChange,
}: {
  models: string[];
  capabilities: AdminMediaCapability[];
  onChange: (capabilities: AdminMediaCapability[]) => void;
}) {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<AdminMediaCapability>) => {
    onChange(capabilities.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };
  return <div className="space-y-2 rounded-lg border border-[var(--ob-line)] p-3">
    <div className="flex flex-wrap items-center gap-2"><strong className="mr-auto text-sm">{t("admin.channels.capabilities")}</strong><span className="text-xs text-[var(--ob-muted)]">{t("admin.channels.capabilitiesHint")}</span></div>
    {capabilities.map((capability, index) => <div key={`${capability.model}:${capability.kind}:${index}`} className="grid gap-2 rounded-lg bg-[var(--ob-surface-2)] p-2 md:grid-cols-[1.2fr_.7fr_1.4fr_1fr_1fr_.6fr_auto]">
      <select aria-label={t("admin.channels.capabilityModel", { index: index + 1 })} className="ob-field" value={capability.model} onChange={(event) => update(index, { model: event.target.value })}><option value="">{t("admin.channels.selectModel")}</option>{models.map((model) => <option key={model}>{model}</option>)}</select>
      <select aria-label={t("admin.channels.capabilityKind", { index: index + 1 })} className="ob-field" value={capability.kind} onChange={(event) => { const kind = event.target.value as AdminMediaKind; update(index, { kind, modes: [capabilityModes[kind][0].id], sizes: [], durations: [], maxReferences: 0 }); }}>{(["image", "video", "audio"] as AdminMediaKind[]).map((kind) => <option key={kind} value={kind}>{kind === "image" ? t("common.image") : kind === "video" ? t("common.video") : t("common.audio")}</option>)}</select>
      <div className="flex flex-wrap items-center gap-2">{capabilityModes[capability.kind].map((mode) => <label key={mode.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={capability.modes.includes(mode.id)} onChange={(event) => update(index, { modes: event.target.checked ? [...capability.modes, mode.id] : capability.modes.filter((item) => item !== mode.id) })} />{t(mode.label)}</label>)}</div>
      <input aria-label={t("admin.channels.capabilitySizes", { index: index + 1 })} className="ob-field" placeholder={t("admin.channels.sizesPlaceholder")} title={t("admin.channels.sizesTitle")} value={capability.sizes.join(",")} onChange={(event) => update(index, { sizes: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} />
      <input aria-label={t("admin.channels.capabilityDuration", { index: index + 1 })} className="ob-field" placeholder={t("admin.channels.durationPlaceholder")} value={capability.durations.join(",")} onChange={(event) => update(index, { durations: event.target.value.split(",").map(Number).filter(Number.isFinite) })} />
      <input aria-label={t("admin.channels.capabilityReferences", { index: index + 1 })} className="ob-field" type="number" min={0} max={16} value={capability.maxReferences} onChange={(event) => update(index, { maxReferences: Number(event.target.value) })} />
      <button type="button" className="ob-btn" onClick={() => onChange(capabilities.filter((_, itemIndex) => itemIndex !== index))}>{t("admin.channels.deleteCapability")}</button>
    </div>)}
    <button type="button" className="ob-btn" disabled={!models.length} onClick={() => onChange([...capabilities, defaultCapability(models[0] ?? "")])}>{t("admin.channels.addCapability")}</button>
  </div>;
}

interface PendingModelReview {
  diff: AdminChannelModelDiff;
  selected: string[];
}

export function AdminChannelsPanel() {
  const { t } = useI18n();
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [modelReviews, setModelReviews] = useState<Record<string, PendingModelReview>>({});
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState("");
  const persistedIdsRef = useRef(new Set<string>());
  const persistedChannelsRef = useRef(new Map<string, AdminChannel>());

  const load = async () => {
    setLoading(true);
    setLoaded(false);
    try {
      setError("");
      const result = await listAdminChannels();
      const loaded = result.items;
      setRevision(result.revision);
      persistedIdsRef.current = new Set(loaded.map((channel) => channel.id));
      persistedChannelsRef.current = new Map(loaded.map((channel) => [channel.id, channel]));
      setModelReviews({});
      setChannels(loaded);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const update = (id: string, patch: Partial<AdminChannel>) => {
    setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, ...patch } : channel));
  };
  const run = async (key: string, operation: () => Promise<string>) => {
    try {
      setBusy(key); setError(""); setNotice(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-4" aria-busy={loading || busy !== ""}>
      <div className="rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface)] p-4 text-sm text-[var(--ob-muted)]">
        {t("admin.channels.description")}
      </div>
      {loading ? <p className="text-sm text-[var(--ob-muted)]">{t("admin.channels.loading")}</p> : null}
      {!loading && !loaded ? <button type="button" className="ob-btn" onClick={() => void load()}>{t("admin.channels.reload")}</button> : null}
      <fieldset className="contents" disabled={busy !== "" || !loaded}>
      {channels.map((channel) => (
        <section key={channel.id} className="space-y-3 rounded-xl border border-[var(--ob-line)] p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <AdminChannelNameField channel={channel} onChange={(name) => update(channel.id, { name })} />
            <Field label={t("admin.channels.protocol")}><select className="ob-field" value={channel.protocol} onChange={(event) => update(channel.id, { protocol: event.target.value as AdminChannelProtocol })}>{protocols.map((protocol) => <option key={protocol}>{protocol}</option>)}</select></Field>
            <Field label={t("admin.channels.baseUrl")}><input className="ob-field" value={channel.baseUrl} onChange={(event) => update(channel.id, { baseUrl: event.target.value })} /></Field>
            <Field label={t("admin.channels.imageModel")}><input className="ob-field" value={channel.defaultImageModel} onChange={(event) => update(channel.id, { defaultImageModel: event.target.value })} /></Field>
            <Field label={t("admin.channels.videoModel")}><input className="ob-field" value={channel.defaultVideoModel} onChange={(event) => update(channel.id, { defaultVideoModel: event.target.value })} /></Field>
            <Field label={t("admin.channels.audioModel")}><input className="ob-field" value={channel.defaultAudioModel} disabled={!(["openai", "azure", "edge"] as AdminChannelProtocol[]).includes(channel.protocol)} onChange={(event) => update(channel.id, { defaultAudioModel: event.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("admin.channels.weight")}><input className="ob-field" type="number" min={1} max={100} value={channel.weight} onChange={(event) => update(channel.id, { weight: Number(event.target.value) })} /></Field>
              <Field label={t("admin.channels.timeout")}><input className="ob-field" type="number" min={1} max={600} value={channel.timeoutSeconds} onChange={(event) => update(channel.id, { timeoutSeconds: Number(event.target.value) })} /></Field>
            </div>
            <Field label={t("admin.channels.availableModels")}>
              <textarea
                className="ob-field min-h-24 font-mono text-xs"
                value={modelsText(channel)}
                disabled={busy === `models:${channel.id}`}
                placeholder={"gpt-image-1\ngpt-image-2\nseedream-4"}
                onChange={(event) => {
                  update(channel.id, { models: parseModelsText(event.target.value) });
                  setModelReviews((current) => {
                    const { [channel.id]: _discarded, ...remaining } = current;
                    return remaining;
                  });
                }}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={channel.enabled} onChange={(event) => update(channel.id, { enabled: event.target.checked })} />{t("admin.channels.enabled")}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={channel.allowUserUse} onChange={(event) => update(channel.id, { allowUserUse: event.target.checked })} />{t("admin.channels.allowUsers")}</label>
            <label className="min-w-60 flex-1 text-sm">{t("admin.channels.apiSecret", { state: channel.protocol === "edge" ? t("admin.channels.edgeNoSecret") : channel.secretConfigured ? t("admin.channels.secretConfigured") : t("admin.channels.secretMissing") })}<input className="ob-field mt-1" type="password" autoComplete="new-password" disabled={channel.protocol === "edge"} value={secrets[channel.id] ?? ""} onChange={(event) => setSecrets((current) => ({ ...current, [channel.id]: event.target.value }))} /></label>
            <button type="button" className="ob-btn" title={adminChannelSecretBindingIsCurrent(channel, persistedChannelsRef.current.get(channel.id)) ? undefined : t("admin.channels.saveConfigFirst")} disabled={busy !== "" || !(secrets[channel.id] ?? "") || !adminChannelSecretBindingIsCurrent(channel, persistedChannelsRef.current.get(channel.id))} onClick={() => void run(`secret:${channel.id}`, async () => {
              await putAdminChannelSecret(channel.id, secrets[channel.id] ?? "", channel.secretBindingId ?? "");
              invalidateSharedChannelCatalog();
              setSecrets((current) => ({ ...current, [channel.id]: "" }));
              setChannels((current) => current.map((item) => item.id === channel.id ? { ...item, secretConfigured: true } : item));
              return t("admin.channels.secretSaved");
            })}>{adminChannelSecretBindingIsCurrent(channel, persistedChannelsRef.current.get(channel.id)) ? t("admin.channels.saveSecret") : t("admin.channels.saveChannelFirst")}</button>
            <button type="button" className="ob-btn" disabled={busy !== "" || !adminChannelCanTest(channel)} onClick={() => void run(`test:${channel.id}`, async () => {
              const result = await testAdminChannel(channel.id); return t("admin.channels.connectionSucceeded", { count: result.modelCount });
            })}>{t("admin.channels.test")}</button>
            <button type="button" className="ob-btn" disabled={busy !== "" || !channel.secretConfigured || !["openai", "apimart"].includes(channel.protocol)} onClick={() => void run(`models:${channel.id}`, async () => {
              const models = await fetchAdminChannelModels(channel.id);
              const diff = buildAdminChannelModelDiff(channel.models ?? [], models);
              setModelReviews((current) => ({
                ...current,
                [channel.id]: { diff, selected: [...diff.selected] },
              }));
              return models.length
                ? t("admin.channels.modelsFetched", { count: models.length })
                : t("admin.channels.modelsEmpty");
            })}>{t("admin.channels.pullModels")}</button>
            <button type="button" className="ob-btn" disabled={busy !== ""} onClick={() => void run(`delete:${channel.id}`, async () => {
              const persisted = shouldDeleteAdminChannel(persistedIdsRef.current, channel.id);
              if (persisted) setRevision(await deleteAdminChannel(channel.id, revision));
              persistedIdsRef.current = new Set([...persistedIdsRef.current].filter((id) => id !== channel.id));
              invalidateSharedChannelCatalog();
              setChannels((current) => current.filter((item) => item.id !== channel.id));
              setModelReviews((current) => {
                const { [channel.id]: _discarded, ...remaining } = current;
                return remaining;
              });
              return persisted ? t("admin.channels.deleted") : t("admin.channels.unsavedRemoved");
            })}>{t("common.delete")}</button>
          </div>
          <AdminMediaCapabilityEditor models={[...new Set([...(channel.models ?? []), channel.defaultImageModel, channel.defaultVideoModel, channel.defaultAudioModel].filter(Boolean))]} capabilities={channel.mediaCapabilities ?? []} onChange={(mediaCapabilities) => update(channel.id, { mediaCapabilities })} />
          {modelReviews[channel.id] ? (
            <AdminChannelModelDiffReview
              diff={modelReviews[channel.id].diff}
              selected={modelReviews[channel.id].selected}
              onToggle={(model) => setModelReviews((current) => {
                const review = current[channel.id];
                if (!review) return current;
                const selected = review.selected.includes(model)
                  ? review.selected.filter((item) => item !== model)
                  : [...review.selected, model];
                return { ...current, [channel.id]: { ...review, selected } };
              })}
              onConfirm={() => {
                const review = modelReviews[channel.id];
                if (!review) return;
                const models = applyAdminChannelModelSelection(review.diff, review.selected);
                update(channel.id, { models });
                setModelReviews((current) => {
                  const { [channel.id]: _confirmed, ...remaining } = current;
                  return remaining;
                });
                setError("");
                setNotice(t("admin.channels.modelsSelected", { count: models.length }));
              }}
              onCancel={() => setModelReviews((current) => {
                const { [channel.id]: _cancelled, ...remaining } = current;
                return remaining;
              })}
            />
          ) : null}
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ob-btn" disabled={!loaded || busy !== ""} onClick={() => setChannels((current) => [...current, emptyAdminChannel(current.length + 1, t("admin.channels.defaultName", { index: current.length + 1 }))])}>{t("admin.channels.add")}</button>
        <button type="button" className="ob-btn ob-btn-primary" disabled={!loaded || busy !== ""} onClick={() => void run("save", async () => {
          const result = await putAdminChannels(channels, revision);
          const saved = result.items;
          setRevision(result.revision);
          persistedIdsRef.current = new Set(saved.map((channel) => channel.id));
          persistedChannelsRef.current = new Map(saved.map((channel) => [channel.id, channel]));
          invalidateSharedChannelCatalog();
          setChannels(mergeSavedAdminChannels(saved));
          return t("admin.channels.saved");
        })}>{t("admin.channels.saveAll")}</button>
      </div>
      </fieldset>
      {notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
    </div>
  );
}

export function AdminChannelModelDiffReview({
  diff,
  selected,
  onToggle,
  onConfirm,
  onCancel,
}: {
  diff: AdminChannelModelDiff;
  selected: readonly string[];
  onToggle: (model: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const selectedIds = new Set(selected);
  const groups = [
    { label: t("admin.channels.added"), models: diff.added, className: "text-emerald-700" },
    { label: t("admin.channels.existing"), models: diff.existing, className: "text-[var(--ob-muted)]" },
    { label: t("admin.channels.removed"), models: diff.removed, className: "text-[var(--ob-danger)]" },
  ];

  return (
    <div className="space-y-3 rounded-lg border border-[var(--ob-line)] bg-[var(--ob-surface)] p-3" aria-label={t("admin.channels.diffLabel")}>
      <div>
        <p className="text-sm font-medium">{t("admin.channels.diffTitle")}</p>
        <p className="text-xs text-[var(--ob-muted)]">
          {diff.selected.length === 0
            ? t("admin.channels.diffEmpty")
            : t("admin.channels.diffHint")}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            <p className={`text-xs font-medium ${group.className}`}>{group.label}（{group.models.length}）</p>
            {group.models.length ? group.models.map((model) => (
              <label key={model} className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selectedIds.has(model)}
                  onChange={() => onToggle(model)}
                />
                <span className="break-all font-mono">{model}</span>
              </label>
            )) : <p className="text-xs text-[var(--ob-muted)]">{t("common.none")}</p>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ob-btn ob-btn-primary" onClick={onConfirm}>{t("admin.channels.confirmModels")}</button>
        <button type="button" className="ob-btn" onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm">{label}<span className="mt-1 block">{children}</span></label>;
}
