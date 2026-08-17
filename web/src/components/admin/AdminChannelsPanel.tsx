import { useEffect, useRef, useState, type ReactNode } from "react";
import { Cable, Check, Eye, EyeOff, GitCompare, Layers, PlugZap, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  deleteAdminChannel,
  deletePlatformChannel,
  listAdminChannels,
  listPlatformChannels,
  previewAdminChannelModels,
  previewAdminChannelTest,
  previewPlatformChannelModels,
  previewPlatformChannelTest,
  putAdminChannel,
  putAdminChannelSecret,
  putPlatformChannel,
  putPlatformChannelSecret,
  type AdminChannelPreviewInput,
  type AdminChannel,
  type AdminChannelProtocol,
  type AdminMediaCapability,
  type AdminMediaKind,
  type AdminMediaMode,
} from "@/services/admin";
import { invalidateSharedChannelCatalog } from "@/services/shared-channels";
import { uid } from "@/lib/id";
import {
  adminChannelAudienceReady,
  adminChannelCanPreviewModels,
  adminChannelDestinationMatches,
  adminChannelIsDirty,
  applyAdminChannelModelSelection,
  applySavedAdminChannel,
  buildAdminChannelModelDiff,
  nextSelectedChannelId,
  shouldDeleteAdminChannel,
  type AdminChannelModelDiff,
} from "@/lib/admin-channel-state";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { EmptyState, Notice, SectionHeader } from "./AdminSection";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

const protocols: AdminChannelProtocol[] = ["openai", "gemini", "apimart", "kie", "azure", "edge"];
/** Only these adapters carry an audio contract; the audio model field is inert elsewhere. */
const AUDIO_PROTOCOLS: AdminChannelProtocol[] = ["openai", "azure", "edge"];
/** The server clamps the same bounds; mirrored so the inputs cannot offer an invalid value. */
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 100;
const TIMEOUT_MIN_SECONDS = 1;
const TIMEOUT_MAX_SECONDS = 600;
const MAX_REFERENCE_IMAGES = 16;
const MODELS_PLACEHOLDER = "gpt-image-1\ngpt-image-2\nseedream-4";

export function adminChannelCanTest(
  channel: Pick<AdminChannel, "protocol" | "secretConfigured" | "baseUrl">,
  secret = "",
  persisted?: Pick<AdminChannel, "protocol" | "baseUrl" | "secretConfigured">,
): boolean {
  if (channel.protocol === "edge") return true;
  if (secret.trim()) return true;
  return Boolean(persisted?.secretConfigured && adminChannelDestinationMatches(channel, persisted));
}

export function emptyAdminChannel(index: number, name = `共享渠道 ${index}`, publishToAll = false): AdminChannel {
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
    publishToAll,
  };
}

type ChannelScope = "tenant" | "platform";

export function emptyAdminChannelForScope(index: number, name: string, _scope: ChannelScope): AdminChannel {
  // Publishing a platform credential is a separate, explicit decision.
  return emptyAdminChannel(index, name, false);
}

type ChannelService = {
  list: () => Promise<{ items: AdminChannel[]; revision: string }>;
  putOne: (channel: AdminChannel, revision: string) => Promise<{ items: AdminChannel[]; revision: string }>;
  remove: (channelId: string, revision: string) => Promise<string>;
  putSecret: (channelId: string, apiKey: string, secretBindingId: string) => Promise<void>;
  previewModels: (input: AdminChannelPreviewInput) => Promise<string[]>;
  previewTest: (input: AdminChannelPreviewInput) => Promise<{ ok: boolean; modelCount: number }>;
};

const tenantChannelService: ChannelService = {
  list: listAdminChannels,
  putOne: putAdminChannel,
  remove: deleteAdminChannel,
  putSecret: putAdminChannelSecret,
  previewModels: previewAdminChannelModels,
  previewTest: previewAdminChannelTest,
};

const platformChannelService: ChannelService = {
  list: listPlatformChannels,
  putOne: putPlatformChannel,
  remove: deletePlatformChannel,
  putSecret: putPlatformChannelSecret,
  previewModels: previewPlatformChannelModels,
  previewTest: previewPlatformChannelTest,
};

/** Field shell: uppercase micro-label above the control, matching the rest of the admin console. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="ob-micro-label mb-1">{label}</span>
      {children}
    </label>
  );
}

/** Labelled cluster of related fields, separated from its siblings by a hairline. */
function FieldGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className="ob-field-group">
      <span className="ob-micro-label">{label}</span>
      <div className={className ?? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"}>{children}</div>
    </section>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div
      className="ob-toggle-field"
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button[role='switch']")) return;
        onChange(!checked);
      }}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="ob-switch"
        data-checked={checked ? "true" : "false"}
        onClick={() => onChange(!checked)}
      />
      <span>{label}</span>
    </div>
  );
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

/** Immutable key removal — reviews are discarded whenever their channel changes underneath them. */
function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

function capabilityModelOptions(channel: AdminChannel): string[] {
  return [
    ...new Set(
      [
        ...(channel.models ?? []),
        channel.defaultImageModel,
        channel.defaultVideoModel,
        channel.defaultAudioModel,
      ].filter(Boolean),
    ),
  ];
}

const capabilityModes: Record<AdminMediaKind, Array<{ id: AdminMediaMode; label: MessageKey }>> = {
  image: [{ id: "text_to_image", label: "admin.channels.textToImage" }, { id: "image_to_image", label: "admin.channels.imageToImage" }],
  video: [{ id: "text_to_video", label: "admin.channels.textToVideo" }, { id: "image_to_video", label: "admin.channels.imageToVideo" }],
  audio: [{ id: "text_to_audio", label: "admin.channels.textToAudio" }],
};

function defaultCapability(model: string, kind: AdminMediaKind = "image"): AdminMediaCapability {
  return { model, kind, modes: [capabilityModes[kind][0].id], sizes: [], durations: [], maxReferences: 0 };
}

function parseCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function clampChannelInt(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function parseCapabilityDurations(value: string): number[] {
  return value.split(",").flatMap((item) => {
    const duration = Number(item.trim());
    if (!Number.isInteger(duration) || duration < 1 || duration > 900) return [];
    return [duration];
  });
}

function CapabilityRow({
  capability,
  index,
  models,
  onChange,
  onRemove,
}: {
  capability: AdminMediaCapability;
  index: number;
  models: string[];
  onChange: (patch: Partial<AdminMediaCapability>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const position = index + 1;
  const modelOptions = [...new Set([capability.model, ...models].filter(Boolean))];
  return (
    <li className="ob-capability">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]">
        <Field label={t("admin.channels.labelModel")}>
          <select
            aria-label={t("admin.channels.capabilityModel", { index: position })}
            className="ob-field"
            value={capability.model}
            onChange={(event) => onChange({ model: event.target.value })}
          >
            <option value="">{t("admin.channels.selectModel")}</option>
            {modelOptions.map((model) => <option key={model}>{model}</option>)}
          </select>
        </Field>
        <Field label={t("admin.channels.labelKind")}>
          <select
            aria-label={t("admin.channels.capabilityKind", { index: position })}
            className="ob-field"
            value={capability.kind}
            onChange={(event) => {
              const kind = event.target.value as AdminMediaKind;
              onChange({ kind, modes: [capabilityModes[kind][0].id], sizes: [], durations: [], maxReferences: 0 });
            }}
          >
            {(["image", "video", "audio"] as AdminMediaKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {kind === "image" ? t("common.image") : kind === "video" ? t("common.video") : t("common.audio")}
              </option>
            ))}
          </select>
        </Field>
        <button
          type="button"
          className="ob-icon-btn ob-icon-btn-sm self-end"
          aria-label={t("admin.channels.deleteCapability")}
          title={t("admin.channels.deleteCapability")}
          onClick={onRemove}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
      <div>
        <span className="ob-micro-label mb-1.5">{t("admin.channels.labelModes")}</span>
        <div className="flex flex-wrap gap-1.5">
          {capabilityModes[capability.kind].map((mode) => (
            <label key={mode.id} className="ob-check-chip">
              <input
                type="checkbox"
                checked={capability.modes.includes(mode.id)}
                onChange={(event) => onChange({
                  modes: event.target.checked
                    ? [...capability.modes, mode.id]
                    : capability.modes.filter((item) => item !== mode.id),
                })}
              />
              {t(mode.label)}
            </label>
          ))}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Field label={t("admin.channels.labelSizes")}>
          <input
            aria-label={t("admin.channels.capabilitySizes", { index: position })}
            className="ob-field"
            placeholder={t("admin.channels.sizesPlaceholder")}
            title={t("admin.channels.sizesTitle")}
            value={capability.sizes.join(",")}
            onChange={(event) => onChange({ sizes: parseCsv(event.target.value) })}
          />
        </Field>
        {capability.kind === "image" ? null : (
          <Field label={t("admin.channels.labelDuration")}>
            <input
              aria-label={t("admin.channels.capabilityDuration", { index: position })}
              className="ob-field"
              placeholder={t("admin.channels.durationPlaceholder")}
              value={capability.durations.join(",")}
              onChange={(event) => onChange({ durations: parseCapabilityDurations(event.target.value) })}
            />
          </Field>
        )}
        <Field label={t("admin.channels.labelReferences")}>
          <input
            aria-label={t("admin.channels.capabilityReferences", { index: position })}
            className="ob-field"
            type="number"
            min={0}
            max={MAX_REFERENCE_IMAGES}
            value={capability.maxReferences}
            onChange={(event) => onChange({ maxReferences: clampChannelInt(event.target.value, 0, MAX_REFERENCE_IMAGES) })}
          />
        </Field>
      </div>
    </li>
  );
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
  return (
    <details className="ob-subpanel" open={capabilities.length > 0}>
      <summary className="ob-subpanel-header cursor-pointer select-none">
        <Layers size={14} aria-hidden />
        <strong className="ob-subpanel-title">{t("admin.channels.capabilities")}</strong>
        <span className="ob-micro-label ml-auto">{t("admin.channels.capabilityCount", { count: capabilities.length })}</span>
      </summary>
      <p className="ob-subpanel-hint">{t("admin.channels.capabilitiesHint")}</p>
      {capabilities.length ? (
        <ul role="list" className="m-0 flex list-none flex-col gap-2 p-0">
          {capabilities.map((capability, index) => (
            <CapabilityRow
              key={`${capability.model}:${capability.kind}:${index}`}
              capability={capability}
              index={index}
              models={models}
              onChange={(patch) => update(index, patch)}
              onRemove={() => onChange(capabilities.filter((_, itemIndex) => itemIndex !== index))}
            />
          ))}
        </ul>
      ) : (
        <p className="ob-subpanel-hint">{t("admin.channels.capabilityEmpty")}</p>
      )}
      <button
        type="button"
        className="ob-btn ob-btn-sm self-start"
        disabled={!models.length}
        onClick={() => onChange([...capabilities, defaultCapability(models[0] ?? "")])}
      >
        <Plus size={14} aria-hidden />
        {t("admin.channels.addCapability")}
      </button>
    </details>
  );
}

interface PendingModelReview {
  diff: AdminChannelModelDiff;
  selected: string[];
}

interface ChannelHandlers {
  update: (patch: Partial<AdminChannel>) => void;
  changeModelsText: (value: string) => void;
  setSecret: (value: string) => void;
  save: () => void;
  test: () => void;
  fetchModels: () => void;
  requestDelete: () => void;
  toggleReviewModel: (model: string) => void;
  confirmReview: () => void;
  cancelReview: () => void;
}

function ChannelListItem({
  channel,
  selected,
  persisted,
  onSelect,
}: {
  channel: AdminChannel;
  selected: boolean;
  persisted: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="ob-channel-list-item"
      data-active={selected}
      data-channel-id={channel.id}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="ob-channel-list-title">{channel.name.trim() || t("admin.unnamed")}</span>
      <span className="ob-channel-list-meta">
        <span className="ob-chip">{channel.protocol}</span>
        <span className="ob-status-chip" data-tone={channel.enabled ? "success" : undefined}>
          {channel.enabled ? t("admin.channels.enabled") : t("admin.channels.disabled")}
        </span>
        {channel.protocol === "edge" ? (
          <span className="ob-chip">{t("admin.channels.edgeNoSecret")}</span>
        ) : (
          <span className="ob-status-chip" data-tone={channel.secretConfigured ? "success" : "warning"}>
            {channel.secretConfigured ? t("admin.channels.secretOk") : t("admin.channels.noSecret")}
          </span>
        )}
        {persisted ? null : <span className="ob-status-chip" data-tone="warning">{t("admin.channels.unsaved")}</span>}
      </span>
    </button>
  );
}

function ChannelHeader({ channel, persisted }: { channel: AdminChannel; persisted: boolean }) {
  const { t } = useI18n();
  return (
    <div className="ob-record-header">
      <span className="ob-record-title">{channel.name.trim() || t("admin.unnamed")}</span>
      <span className="ob-status-chip" data-tone={channel.enabled ? "success" : undefined}>
        <span className="ob-status-dot" data-status={channel.enabled ? "succeeded" : "disabled"} aria-hidden />
        {channel.enabled ? t("admin.channels.enabled") : t("admin.channels.disabled")}
      </span>
      <span className="ob-chip">{channel.protocol}</span>
      {persisted ? null : <span className="ob-status-chip" data-tone="warning">{t("admin.channels.unsaved")}</span>}
    </div>
  );
}

function ConnectionGroup({ channel, handlers }: { channel: AdminChannel; handlers: ChannelHandlers }) {
  const { t } = useI18n();
  return (
    <FieldGroup label={t("admin.channels.groupConnection")}>
      <AdminChannelNameField channel={channel} onChange={(name) => handlers.update({ name })} />
      <Field label={t("admin.channels.protocol")}>
        <select
          className="ob-field"
          value={channel.protocol}
          onChange={(event) => {
            const protocol = event.target.value as AdminChannelProtocol;
            handlers.update({
              protocol,
              ...(AUDIO_PROTOCOLS.includes(protocol) ? {} : { defaultAudioModel: "" }),
            });
          }}
        >
          {protocols.map((protocol) => <option key={protocol}>{protocol}</option>)}
        </select>
      </Field>
      <Field label={t("admin.channels.baseUrl")}>
        <input className="ob-field" value={channel.baseUrl} onChange={(event) => handlers.update({ baseUrl: event.target.value })} />
      </Field>
    </FieldGroup>
  );
}

function DefaultModelsGroup({ channel, handlers }: { channel: AdminChannel; handlers: ChannelHandlers }) {
  const { t } = useI18n();
  return (
    <FieldGroup label={t("admin.channels.groupDefaults")}>
      <Field label={t("admin.channels.imageModel")}>
        <input className="ob-field" value={channel.defaultImageModel} onChange={(event) => handlers.update({ defaultImageModel: event.target.value })} />
      </Field>
      <Field label={t("admin.channels.videoModel")}>
        <input className="ob-field" value={channel.defaultVideoModel} onChange={(event) => handlers.update({ defaultVideoModel: event.target.value })} />
      </Field>
      <Field label={t("admin.channels.audioModel")}>
        <input
          className="ob-field"
          value={channel.defaultAudioModel}
          disabled={!AUDIO_PROTOCOLS.includes(channel.protocol)}
          onChange={(event) => handlers.update({ defaultAudioModel: event.target.value })}
        />
      </Field>
    </FieldGroup>
  );
}

function RoutingGroup({ channel, handlers, modelsBusy }: { channel: AdminChannel; handlers: ChannelHandlers; modelsBusy: boolean }) {
  const { t } = useI18n();
  return (
    <FieldGroup label={t("admin.channels.groupRouting")} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[9rem_9rem]">
        <Field label={t("admin.channels.weight")}>
          <input
            className="ob-field"
            type="number"
            min={WEIGHT_MIN}
            max={WEIGHT_MAX}
            value={channel.weight}
            onChange={(event) => handlers.update({ weight: clampChannelInt(event.target.value, WEIGHT_MIN, WEIGHT_MAX) })}
          />
        </Field>
        <Field label={t("admin.channels.timeout")}>
          <input
            className="ob-field"
            type="number"
            min={TIMEOUT_MIN_SECONDS}
            max={TIMEOUT_MAX_SECONDS}
            value={channel.timeoutSeconds}
            onChange={(event) => handlers.update({ timeoutSeconds: clampChannelInt(event.target.value, TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS) })}
          />
        </Field>
      </div>
      <Field label={t("admin.channels.availableModels")}>
        <textarea
          className="ob-field min-h-24 font-mono text-xs"
          value={modelsText(channel)}
          disabled={modelsBusy}
          placeholder={MODELS_PLACEHOLDER}
          onChange={(event) => handlers.changeModelsText(event.target.value)}
        />
      </Field>
    </FieldGroup>
  );
}

function AccessGroup({
  channel,
  secret,
  handlers,
  scope,
}: {
  channel: AdminChannel;
  secret: string;
  handlers: ChannelHandlers;
  scope: ChannelScope;
}) {
  const { t } = useI18n();
  const [showSecret, setShowSecret] = useState(false);
  const state = channel.protocol === "edge"
    ? t("admin.channels.edgeNoSecret")
    : channel.secretConfigured
      ? t("admin.channels.secretConfigured")
      : t("admin.channels.secretMissing");
  return (
    <FieldGroup label={t("admin.channels.groupAccess")} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <ToggleField label={t("admin.channels.enabled")} checked={channel.enabled} onChange={(enabled) => handlers.update({ enabled })} />
        <ToggleField label={t("admin.channels.allowUsers")} checked={channel.allowUserUse} onChange={(allowUserUse) => handlers.update({ allowUserUse })} />
      </div>
      {scope === "platform" ? (
        <div className="space-y-2">
          <ToggleField
            label={t("admin.channels.publishToAll")}
            checked={channel.publishToAll === true}
            onChange={(publishToAll) => handlers.update({ publishToAll })}
          />
          {channel.publishToAll === true ? null : (
            <Field label={t("admin.channels.tenantIds")}>
              <input
                className="ob-field"
                value={(channel.tenantIds ?? []).join(",")}
                placeholder={t("admin.channels.tenantIdsPlaceholder")}
                onChange={(event) => handlers.update({ tenantIds: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })}
              />
            </Field>
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-60 flex-1">
          <span className="ob-micro-label mb-1">{t("admin.channels.apiSecret", { state })}</span>
          <div className="relative flex items-center">
            <input
              className="ob-field pr-9"
              type={showSecret ? "text" : "password"}
              autoComplete="new-password"
              disabled={channel.protocol === "edge"}
              value={secret}
              onChange={(event) => handlers.setSecret(event.target.value)}
            />
            {channel.protocol !== "edge" ? (
              <button
                type="button"
                className="ob-icon-btn ob-icon-btn-sm absolute right-1 text-[var(--ob-muted)] hover:text-[var(--ob-ink)]"
                aria-label={showSecret ? t("admin.channels.hideSecret") : t("admin.channels.showSecret")}
                title={showSecret ? t("admin.channels.hideSecret") : t("admin.channels.showSecret")}
                onClick={() => setShowSecret(!showSecret)}
              >
                {showSecret ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
              </button>
            ) : null}
          </div>
        </label>
      </div>
    </FieldGroup>
  );
}

function ChannelActions({
  channel,
  secret,
  persisted,
  reviewing,
  busy,
  scope,
  handlers,
}: {
  channel: AdminChannel;
  secret: string;
  persisted?: AdminChannel;
  reviewing: boolean;
  busy: boolean;
  scope: ChannelScope;
  handlers: ChannelHandlers;
}) {
  const { t } = useI18n();
  const canFetchModels = adminChannelCanPreviewModels(channel, secret, persisted);
  const audienceReady = adminChannelAudienceReady(channel, scope);
  const saveBlockedReason = reviewing
    ? t("admin.channels.confirmModelsFirst")
    : audienceReady
      ? undefined
      : t("admin.channels.audienceRequired");
  return (
    <div className="space-y-2">
      <div className="ob-record-actions">
        <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !adminChannelCanTest(channel, secret, persisted) || ((channel.protocol === "azure" || channel.protocol === "edge") && !(channel.defaultAudioModel ?? "").trim())} onClick={handlers.test}>
          <PlugZap size={14} aria-hidden />
          {t("admin.channels.test")}
        </button>
        <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !canFetchModels} onClick={handlers.fetchModels}>
          <RefreshCw size={14} aria-hidden />
          {t("admin.channels.pullModels")}
        </button>
        <button
          type="button"
          className="ob-btn ob-btn-primary ob-btn-sm"
          disabled={busy || reviewing || !audienceReady}
          title={saveBlockedReason}
          onClick={handlers.save}
        >
          <Save size={14} aria-hidden />
          {t("admin.channels.saveOne")}
        </button>
        <span className="ob-record-actions-end" />
        <button
          type="button"
          className="ob-btn ob-btn-danger ob-btn-sm"
          disabled={busy}
          aria-label={t("admin.channels.deleteChannel", { name: channel.name })}
          onClick={handlers.requestDelete}
        >
          <Trash2 size={14} aria-hidden />
          {t("common.delete")}
        </button>
      </div>
      <p className="ob-subpanel-hint">{t("admin.channels.previewHint")}</p>
    </div>
  );
}

function ChannelRecord({
  channel,
  secret,
  persisted,
  persistedChannel,
  modelsBusy,
  review,
  busy,
  handlers,
  scope,
}: {
  channel: AdminChannel;
  secret: string;
  persisted: boolean;
  persistedChannel?: AdminChannel;
  modelsBusy: boolean;
  review?: PendingModelReview;
  busy: boolean;
  handlers: ChannelHandlers;
  scope: ChannelScope;
}) {
  return (
    <article className="ob-record space-y-3">
      <ChannelHeader channel={channel} persisted={persisted} />
      <ConnectionGroup channel={channel} handlers={handlers} />
      <DefaultModelsGroup channel={channel} handlers={handlers} />
      <RoutingGroup channel={channel} handlers={handlers} modelsBusy={modelsBusy} />
      <AccessGroup channel={channel} secret={secret} handlers={handlers} scope={scope} />
      <AdminMediaCapabilityEditor
        models={capabilityModelOptions(channel)}
        capabilities={channel.mediaCapabilities ?? []}
        onChange={(mediaCapabilities) => handlers.update({ mediaCapabilities })}
      />
      {review ? (
        <AdminChannelModelDiffReview
          diff={review.diff}
          selected={review.selected}
          onToggle={handlers.toggleReviewModel}
          onConfirm={handlers.confirmReview}
          onCancel={handlers.cancelReview}
        />
      ) : null}
      <ChannelActions
        channel={channel}
        secret={secret}
        persisted={persistedChannel}
        reviewing={Boolean(review)}
        busy={busy}
        scope={scope}
        handlers={handlers}
      />
    </article>
  );
}

export function AdminChannelsPanel({ scope = "tenant" }: { scope?: ChannelScope } = {}) {
  const { t } = useI18n();
  const service = scope === "platform" ? platformChannelService : tenantChannelService;
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [modelReviews, setModelReviews] = useState<Record<string, PendingModelReview>>({});
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState("");
  const [pendingDelete, setPendingDelete] = useState<AdminChannel | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const persistedIdsRef = useRef(new Set<string>());
  const persistedChannelsRef = useRef(new Map<string, AdminChannel>());
  const busyRef = useRef(false);
  const loadGenerationRef = useRef(0);

  const load = async () => {
    if (busyRef.current) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setLoaded(false);
    try {
      setError("");
      const result = await service.list();
      if (generation !== loadGenerationRef.current) return;
      const loaded = result.items;
      setRevision(result.revision);
      persistedIdsRef.current = new Set(loaded.map((channel) => channel.id));
      persistedChannelsRef.current = new Map(loaded.map((channel) => [channel.id, channel]));
      setModelReviews({});
      setChannels(loaded);
      setSelectedId((current) => nextSelectedChannelId(loaded, current));
      setLoaded(true);
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const update = (id: string, patch: Partial<AdminChannel>) => {
    setChannels((current) => current.map((channel) => channel.id === id ? { ...channel, ...patch } : channel));
  };
  const discardReview = (id: string) => setModelReviews((current) => omit(current, id));
  const run = async (key: string, operation: () => Promise<string>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setBusy(key); setError(""); setNotice(""); setNotice(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  };

  const previewPayload = (channel: AdminChannel): AdminChannelPreviewInput => ({
    id: channel.id,
    baseUrl: channel.baseUrl,
    protocol: channel.protocol,
    timeoutSeconds: channel.timeoutSeconds,
    ...((channel.defaultAudioModel ?? "").trim() ? { defaultAudioModel: channel.defaultAudioModel } : {}),
    ...(secrets[channel.id]?.trim() ? { apiKey: secrets[channel.id] } : {}),
  });

  const saveOne = (channel: AdminChannel) => void run(`save:${channel.id}`, async () => {
    const result = await service.putOne(channel, revision);
    const saved = result.items.find((item) => item.id === channel.id);
    if (!saved) throw new Error(t("admin.channels.saveFailed"));
    loadGenerationRef.current += 1;
    setLoading(false);
    setLoaded(true);
    setRevision(result.revision);
    persistedIdsRef.current = new Set([...persistedIdsRef.current, saved.id]);
    persistedChannelsRef.current = new Map(persistedChannelsRef.current).set(saved.id, saved);
    discardReview(channel.id);
    setChannels((current) => applySavedAdminChannel(current, saved));
    invalidateSharedChannelCatalog();
    const draftSecret = secrets[channel.id]?.trim() ?? "";
    if (draftSecret) {
      try {
        await service.putSecret(saved.id, draftSecret, saved.secretBindingId ?? "");
      } catch {
        throw new Error(t("admin.channels.secretSaveFailed"));
      }
      const nextSaved = { ...saved, secretConfigured: true };
      persistedChannelsRef.current = new Map(persistedChannelsRef.current).set(nextSaved.id, nextSaved);
      setSecrets((current) => ({ ...current, [channel.id]: "" }));
      setChannels((current) => applySavedAdminChannel(current, nextSaved));
    }
    return t("admin.channels.savedOne", { name: saved.name || t("admin.unnamed") });
  });

  const testConnection = (channel: AdminChannel) => void run(`test:${channel.id}`, async () => {
    const result = await service.previewTest(previewPayload(channel));
    return t("admin.channels.connectionSucceeded", { count: result.modelCount });
  });

  const fetchModels = (channel: AdminChannel) => void run(`models:${channel.id}`, async () => {
    const models = await service.previewModels(previewPayload(channel));
    const diff = buildAdminChannelModelDiff(channel.models ?? [], models);
    setModelReviews((current) => ({ ...current, [channel.id]: { diff, selected: [...diff.selected] } }));
    return models.length
      ? t("admin.channels.modelsFetched", { count: models.length })
      : t("admin.channels.modelsEmpty");
  });

  const removeChannel = (channel: AdminChannel) => void run(`delete:${channel.id}`, async () => {
    const persisted = shouldDeleteAdminChannel(persistedIdsRef.current, channel.id);
    if (persisted) setRevision(await service.remove(channel.id, revision));
    loadGenerationRef.current += 1;
    setLoading(false);
    setLoaded(true);
    persistedIdsRef.current = new Set([...persistedIdsRef.current].filter((id) => id !== channel.id));
    invalidateSharedChannelCatalog();
    setChannels((current) => {
      const remaining = current.filter((item) => item.id !== channel.id);
      setSelectedId((currentId) => nextSelectedChannelId(remaining, currentId));
      return remaining;
    });
    discardReview(channel.id);
    setPendingDelete(null);
    return persisted ? t("admin.channels.deleted") : t("admin.channels.unsavedRemoved");
  });

  const confirmReview = (channel: AdminChannel) => {
    const review = modelReviews[channel.id];
    if (!review) return;
    const models = applyAdminChannelModelSelection(review.diff, review.selected);
    update(channel.id, { models });
    discardReview(channel.id);
    setError("");
    setNotice(t("admin.channels.modelsSelected", { count: models.length }));
  };

  const handlersFor = (channel: AdminChannel): ChannelHandlers => ({
    update: (patch) => update(channel.id, patch),
    changeModelsText: (value) => {
      update(channel.id, { models: parseModelsText(value) });
      discardReview(channel.id);
    },
    setSecret: (value) => setSecrets((current) => ({ ...current, [channel.id]: value })),
    save: () => saveOne(channel),
    test: () => testConnection(channel),
    fetchModels: () => fetchModels(channel),
    requestDelete: () => {
      if (shouldDeleteAdminChannel(persistedIdsRef.current, channel.id)) setPendingDelete(channel);
      else removeChannel(channel);
    },
    toggleReviewModel: (model) => setModelReviews((current) => {
      const review = current[channel.id];
      if (!review) return current;
      const selected = review.selected.includes(model)
        ? review.selected.filter((item) => item !== model)
        : [...review.selected, model];
      return { ...current, [channel.id]: { ...review, selected } };
    }),
    confirmReview: () => confirmReview(channel),
    cancelReview: () => discardReview(channel.id),
  });

  const addChannel = () => {
    const created = emptyAdminChannelForScope(
      channels.length + 1,
      t("admin.channels.defaultName", { index: channels.length + 1 }),
      scope,
    );
    setChannels((current) => [...current, created]);
    setSelectedId(created.id);
  };
  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? null;

  return (
    <div className="ob-admin-stack" aria-busy={loading || busy !== ""}>
      <section className="ob-admin-section">
        <SectionHeader
          icon={<Cable size={16} />}
          title={scope === "platform" ? t("admin.platformChannelsTitle") : t("admin.tab.channels")}
          desc={scope === "platform" ? undefined : t("admin.channels.shortDesc")}
          actions={
            <>
              <span className="ob-micro-label">{t("admin.channels.count", { count: channels.length })}</span>
              <button type="button" className="ob-btn ob-btn-ghost ob-btn-sm" disabled={loading || busy !== ""} onClick={() => void load()}>
                <RefreshCw size={14} aria-hidden />
                {t("admin.channels.reload")}
              </button>
              <button type="button" className="ob-btn ob-btn-sm" disabled={!loaded || busy !== ""} onClick={addChannel}>
                <Plus size={14} aria-hidden />
                {t("admin.channels.add")}
              </button>
            </>
          }
        />
        <div className="space-y-3">
          <details className="ob-help">
            <summary>{t("admin.channels.helpToggle")}</summary>
            <p className="ob-help-body">{scope === "platform" ? t("admin.platformChannelsDescription") : t("admin.channels.description")}</p>
          </details>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {notice ? <Notice tone="success">{notice}</Notice> : null}
          {loading ? <Notice tone="info">{t("admin.channels.loading")}</Notice> : null}
          <fieldset className="contents" disabled={busy !== "" || !loaded}>
            {loaded && !channels.length ? (
              <EmptyState icon={<Cable size={20} />} title={t("admin.channels.empty")} desc={t("admin.channels.emptyDesc")} />
            ) : (
              <div className="ob-admin-split">
                <aside className="ob-channel-list" aria-label={t("admin.channels.list")}>
                  {channels.map((channel) => (
                    <ChannelListItem
                      key={channel.id}
                      channel={channel}
                      selected={channel.id === selectedChannel?.id}
                      persisted={!adminChannelIsDirty(channel, persistedChannelsRef.current.get(channel.id), secrets[channel.id])}
                      onSelect={() => setSelectedId(channel.id)}
                    />
                  ))}
                </aside>
                <div className="ob-channel-editor">
                  {selectedChannel ? (
                    <ChannelRecord
                      key={selectedChannel.id}
                      channel={selectedChannel}
                      secret={secrets[selectedChannel.id] ?? ""}
                      persisted={!adminChannelIsDirty(selectedChannel, persistedChannelsRef.current.get(selectedChannel.id), secrets[selectedChannel.id])}
                      persistedChannel={persistedChannelsRef.current.get(selectedChannel.id)}
                      modelsBusy={busy === `models:${selectedChannel.id}`}
                      review={modelReviews[selectedChannel.id]}
                      busy={busy !== ""}
                      handlers={handlersFor(selectedChannel)}
                      scope={scope}
                    />
                  ) : (
                    <EmptyState title={t("admin.channels.selectPrompt")} />
                  )}
                </div>
              </div>
            )}
          </fieldset>
        </div>
      </section>
      {pendingDelete ? (
        <ConfirmDialog
          title={t("admin.channels.deleteTitle")}
          message={t("admin.channels.deleteMessage", { name: pendingDelete.name || t("admin.unnamed") })}
          confirmLabel={t("common.delete")}
          busy={busy === `delete:${pendingDelete.id}`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => removeChannel(pendingDelete)}
        />
      ) : null}
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
    { label: t("admin.channels.added"), models: diff.added, tone: "var(--ob-success)" },
    { label: t("admin.channels.existing"), models: diff.existing, tone: "var(--ob-muted)" },
    { label: t("admin.channels.removed"), models: diff.removed, tone: "var(--ob-danger)" },
  ];

  return (
    <div className="ob-review space-y-3" role="group" aria-label={t("admin.channels.diffLabel")}>
      <div className="flex items-start gap-2">
        <GitCompare size={14} className="mt-0.5 shrink-0 text-[var(--ob-accent)]" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-[var(--ob-ink)]">{t("admin.channels.diffTitle")}</p>
          <p className="ob-subpanel-hint">
            {diff.selected.length === 0
              ? t("admin.channels.diffEmpty")
              : t("admin.channels.diffHint")}
          </p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            <p className="ob-micro-label" style={{ color: group.tone }}>{group.label}（{group.models.length}）</p>
            {group.models.length ? group.models.map((model) => (
              <label key={model} className="ob-check-row">
                <input
                  type="checkbox"
                  checked={selectedIds.has(model)}
                  onChange={() => onToggle(model)}
                />
                <span className="break-all font-mono">{model}</span>
              </label>
            )) : <p className="ob-subpanel-hint">{t("common.none")}</p>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ob-btn ob-btn-primary ob-btn-sm" onClick={onConfirm}>
          <Check size={14} aria-hidden />
          {t("admin.channels.confirmModels")}
        </button>
        <button type="button" className="ob-btn ob-btn-sm" onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}
