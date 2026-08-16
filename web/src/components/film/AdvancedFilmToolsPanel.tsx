import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, RefreshCw, Sparkles, Square, Volume2, Workflow } from "lucide-react";

import { useOptionalAuth } from "@/components/auth/AuthGate";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";
import {
  addFilmVoiceSample,
  adoptFilmStyleCandidate,
  cancelFilmAdvancedGenerationJob,
  createFilmComfyUIJob,
  createFilmVoiceClone,
  createFilmVoiceConsent,
  createFilmVoiceIdentity,
  getFilmAdvancedGenerationJob,
  listFilmVoiceConsents,
  listFilmVoiceIdentities,
  listFilmVoiceSamples,
  listFilmVoiceVersions,
  loadFilmStatus,
  requestFilmStyleExtraction,
  syncFilmVoiceVersion,
  type FilmStatus,
  type FilmVoiceConsent,
  type FilmVoiceIdentity,
  type FilmVoiceSample,
  type FilmVoiceVersion,
} from "@/services/film-client";
import type { GenerationJob } from "@/types/board";
import { WorkbenchSection } from "./WorkbenchSection";

export type FilmAdvancedChannel = { id: string; name: string; models: string[] };

type PanelProps = {
  status: FilmStatus;
  channels: FilmAdvancedChannel[];
  onFilmStatus: (status: FilmStatus) => void;
};

function FeatureUnavailable({ children }: { children: ReactNode }) {
  return <p className="rounded border border-dashed border-[var(--ob-line)] p-3 text-sm text-[var(--ob-muted)]">{children}</p>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs text-[var(--ob-muted)]">{label}{children}</label>;
}

function cleanList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function newJobId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

type Translator = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

const advancedStatusKeys: Readonly<Record<string, MessageKey>> = {
  draft: "film.advanced.statusDraft", queued: "film.advanced.statusQueued", running: "film.advanced.statusRunning",
  needs_review: "film.advanced.statusNeedsReview", approved: "film.advanced.statusApproved", ready: "film.advanced.statusReady",
  succeeded: "film.advanced.statusSucceeded", failed: "film.advanced.statusFailed", canceled: "film.advanced.statusCanceled",
  cancelled: "film.advanced.statusCanceled", self: "film.advanced.rightsSelf", licensed: "film.advanced.rightsLicensed",
  authorized: "film.advanced.rightsAuthorized",
};

const advancedErrorKeys: Readonly<Record<string, MessageKey>> = {
  COMFYUI_INVALID_JOB: "film.advanced.errorInvalidJob",
  COMFYUI_EXECUTOR_UNAVAILABLE: "film.advanced.errorExecutorUnavailable",
  COMFYUI_EXECUTOR_REVOKED: "film.advanced.errorExecutorRevoked",
  COMFYUI_INPUT_INVALID: "film.advanced.errorInputInvalid",
  COMFYUI_EXECUTION_FAILED: "film.advanced.errorExecutionFailed",
  COMFYUI_EXECUTION_TIMEOUT: "film.advanced.errorExecutionTimeout",
  COMFYUI_OUTPUT_INVALID: "film.advanced.errorOutputInvalid",
};

export function localizeAdvancedFilmStatus(t: Translator, status: string): string {
  const key = advancedStatusKeys[status];
  return key ? t(key) : status;
}

export function localizeAdvancedFilmError(t: Translator, error: string): string {
  const key = advancedErrorKeys[error];
  return key ? t(key) : error;
}

export function createLatestRequestGate() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (candidate: number) => candidate === generation,
  };
}

function StyleExtractionPanel({ status, channels, onFilmStatus }: PanelProps) {
  const { t } = useI18n();
  const imageAssets = status.document.assets.filter((asset) =>
    Boolean(asset.mediaStorageKey && asset.mediaMimeType?.startsWith("image/") && asset.mediaSha256 && asset.mediaObjectVersion),
  );
  const [assetId, setAssetId] = useState(imageAssets[0]?.id ?? "");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  const [model, setModel] = useState(selectedChannel?.models[0] ?? "");
  const [detailLevel, setDetailLevel] = useState<"low" | "medium" | "high">("medium");
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!imageAssets.some((asset) => asset.id === assetId)) setAssetId(imageAssets[0]?.id ?? "");
  }, [assetId, imageAssets.map((asset) => `${asset.id}:${asset.revision}`).join("|")]);
  useEffect(() => {
    const channel = channels.find((item) => item.id === channelId) ?? channels[0];
    if (!channel) { setChannelId(""); setModel(""); return; }
    if (channel.id !== channelId) setChannelId(channel.id);
    if (!channel.models.includes(model)) setModel(channel.models[0] ?? "");
  }, [channelId, channels, model]);

  if (!status.capabilities.features.styleExtraction) return <FeatureUnavailable>{t("film.advanced.styleDisabled")}</FeatureUnavailable>;

  const run = async (operation: () => Promise<FilmStatus>, success: string) => {
    setBusy(true); setError(""); setNotice("");
    try { const next = await operation(); onFilmStatus(next); setNotice(success); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!assetId || !channelId || !model.trim()) return;
    void run(() => requestFilmStyleExtraction(status.document.projectId, {
      revision: status.document.revision,
      sourceAssetId: assetId,
      providerId: channelId,
      model: model.trim(),
      idempotencyKey: newJobId("style-extract"),
      parameters: { detailLevel, focus: focus.trim() },
    }), t("film.advanced.styleQueued"));
  };
  const candidates = [...(status.document.styleCandidates ?? [])].reverse();
  const tasks = status.document.tasks.filter((task) => task.stage === "style_extraction").slice(-5).reverse();

  return <div className="space-y-3">
    <div className="flex items-center gap-2"><Sparkles size={16} /><h3 className="font-medium">{t("film.advanced.styleTitle")}</h3></div>
    <form className="grid gap-2 sm:grid-cols-2" onSubmit={submit}>
      <Field label={t("film.advanced.sourceAsset")}><select className="ob-input mt-1 w-full" value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="">{t("film.advanced.noVersionedImage")}</option>{imageAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.title} · r{asset.revision}</option>)}</select></Field>
      <Field label={t("film.advanced.provider")}><select className="ob-input mt-1 w-full" value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">{t("film.advanced.noProvider")}</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></Field>
      <Field label={t("film.advanced.model")}><input className="ob-input mt-1 w-full" value={model} onChange={(event) => setModel(event.target.value)} list="film-style-models" /><datalist id="film-style-models">{selectedChannel?.models.map((item) => <option key={item} value={item} />)}</datalist></Field>
      <Field label={t("film.advanced.detail")}><select className="ob-input mt-1 w-full" value={detailLevel} onChange={(event) => setDetailLevel(event.target.value as typeof detailLevel)}><option value="low">{t("film.advanced.low")}</option><option value="medium">{t("film.advanced.medium")}</option><option value="high">{t("film.advanced.high")}</option></select></Field>
      <Field label={t("film.advanced.focus")}><input className="ob-input mt-1 w-full" maxLength={1000} value={focus} onChange={(event) => setFocus(event.target.value)} placeholder={t("film.advanced.focusPlaceholder")} /></Field>
      <div className="flex items-end gap-2"><button className="ob-btn ob-btn-primary" disabled={busy || !assetId || !channelId || !model.trim()}><Sparkles size={14} />{t("film.advanced.extract")}</button><button type="button" className="ob-btn" disabled={busy} onClick={() => void run(() => loadFilmStatus(status.document.projectId), t("film.advanced.refreshed"))}><RefreshCw size={14} />{t("film.refresh")}</button></div>
    </form>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}{notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}
    <div><h4 className="text-xs font-medium uppercase text-[var(--ob-muted)]">{t("film.advanced.styleRuns")}</h4>{tasks.length ? tasks.map((task) => <p key={task.id} className="mt-1 text-xs">{task.title} · {localizeAdvancedFilmStatus(t, task.status)}{task.error ? ` · ${localizeAdvancedFilmError(t, task.error)}` : ""}</p>) : <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.advanced.noRuns")}</p>}</div>
    <div><h4 className="text-xs font-medium uppercase text-[var(--ob-muted)]">{t("film.advanced.styleCandidates")}</h4>{candidates.length ? candidates.map((candidate) => <div key={candidate.id} className="mt-2 rounded border border-[var(--ob-line)] p-3 text-sm"><div className="flex flex-wrap items-center gap-2"><strong>{candidate.bible.summary}</strong><span className="text-xs text-[var(--ob-muted)]">{localizeAdvancedFilmStatus(t, candidate.status)} · {candidate.providerId}/{candidate.model}</span></div><p className="mt-1 text-xs">{candidate.bible.stylePrompt}</p>{candidate.status === "needs_review" ? <button type="button" className="ob-btn mt-2" disabled={busy} onClick={() => void run(() => adoptFilmStyleCandidate(status.document.projectId, candidate.id, { revision: status.document.revision, candidateRevision: candidate.revision, title: t("film.advanced.adoptedStyleTitle", { title: candidate.sourceAsset.title }) }), t("film.advanced.styleAdopted"))}><Check size={14} />{t("film.advanced.adoptCandidate")}</button> : null}</div>) : <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.advanced.noCandidates")}</p>}</div>
  </div>;
}

function VoiceIdentityPanel({ status, channels }: PanelProps) {
  const { t } = useI18n();
  const auth = useOptionalAuth();
  const isAdmin = auth?.localAdmin === true || auth?.user?.role === "owner";
  const [identities, setIdentities] = useState<FilmVoiceIdentity[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [versions, setVersions] = useState<FilmVoiceVersion[]>([]);
  const [samples, setSamples] = useState<FilmVoiceSample[]>([]);
  const [consents, setConsents] = useState<FilmVoiceConsent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [identityTitle, setIdentityTitle] = useState("");
  const [identityDescription, setIdentityDescription] = useState("");
  const [sampleKey, setSampleKey] = useState("");
  const [sampleLabel, setSampleLabel] = useState("");
  const [rightsBasis, setRightsBasis] = useState<"self" | "licensed" | "authorized">("authorized");
  const [subject, setSubject] = useState("");
  const [terms, setTerms] = useState("voice-consent-v1");
  const [evidenceKey, setEvidenceKey] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [providerId, setProviderId] = useState(channels[0]?.id ?? "");
  const selectedChannel = channels.find((channel) => channel.id === providerId);
  const [model, setModel] = useState(selectedChannel?.models[0] ?? "");
  const historicalSampleIds = useMemo(() => [...new Set(versions.flatMap((version) => version.sampleIds))], [versions]);
  const historicalConsentIds = useMemo(() => [...new Set(versions.map((version) => version.consentId))], [versions]);
  const selectableSamples = [...new Set([...samples.filter((item) => item.voiceIdentityId === selectedId).map((item) => item.id), ...historicalSampleIds])];
  const selectableConsents = [...new Set([...consents.filter((item) => item.voiceIdentityId === selectedId).map((item) => item.id), ...historicalConsentIds])];
  const [sampleIds, setSampleIds] = useState<string[]>([]);
  const [consentId, setConsentId] = useState("");
  const voiceRecordsGate = useRef(createLatestRequestGate());

  const execute = async <T,>(operation: () => Promise<T>, onSuccess: (value: T) => void, success: string) => {
    setBusy(true); setError(""); setNotice("");
    try { const value = await operation(); onSuccess(value); setNotice(success); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const refreshIdentities = () => execute(() => listFilmVoiceIdentities(status.document.projectId), (items) => {
    setIdentities(items); setSelectedId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? "");
  }, t("film.advanced.refreshed"));
  const refreshVoiceRecords = (voiceId = selectedId) => {
	const requestGeneration = voiceRecordsGate.current.begin();
	if (!voiceId) { setVersions([]); setSamples([]); setConsents([]); return; }
	setBusy(true); setError(""); setNotice("");
	void Promise.all([
        listFilmVoiceVersions(status.document.projectId, voiceId),
        listFilmVoiceSamples(status.document.projectId, voiceId),
        listFilmVoiceConsents(status.document.projectId, voiceId),
	  ]).then(([nextVersions, nextSamples, nextConsents]) => {
		if (!voiceRecordsGate.current.isCurrent(requestGeneration)) return;
        setVersions(nextVersions); setSamples(nextSamples); setConsents(nextConsents);
		setNotice(t("film.advanced.refreshed"));
	  }).catch((cause) => {
		if (voiceRecordsGate.current.isCurrent(requestGeneration)) setError(messageOf(cause));
	  }).finally(() => {
		if (voiceRecordsGate.current.isCurrent(requestGeneration)) setBusy(false);
	  });
  };

  useEffect(() => { if (status.capabilities.features.advancedVoice) void refreshIdentities(); }, [status.document.projectId, status.capabilities.features.advancedVoice]);
  useEffect(() => { refreshVoiceRecords(selectedId); }, [selectedId]);
  useEffect(() => {
    const channel = channels.find((item) => item.id === providerId) ?? channels[0];
    if (!channel) { setProviderId(""); setModel(""); return; }
    if (channel.id !== providerId) setProviderId(channel.id);
    if (!channel.models.includes(model)) setModel(channel.models[0] ?? "");
  }, [channels, model, providerId]);
  useEffect(() => { setSampleIds((current) => current.filter((id) => selectableSamples.includes(id))); if (!selectableConsents.includes(consentId)) setConsentId(selectableConsents[0] ?? ""); }, [selectedId, versions.length, samples.length, consents.length]);

  if (!status.capabilities.features.advancedVoice) return <FeatureUnavailable>{t("film.advanced.voiceDisabled")}</FeatureUnavailable>;

  const createIdentity = (event: FormEvent) => { event.preventDefault(); if (!identityTitle.trim()) return; void execute(() => createFilmVoiceIdentity(status.document.projectId, { title: identityTitle.trim(), description: identityDescription.trim() }), (identity) => { setIdentities((current) => [...current, identity]); setSelectedId(identity.id); setIdentityTitle(""); setIdentityDescription(""); }, t("film.advanced.identityCreated")); };
  const addSample = (event: FormEvent) => { event.preventDefault(); if (!selectedId || !sampleKey.trim()) return; void execute(() => addFilmVoiceSample(status.document.projectId, selectedId, { storageKey: sampleKey.trim(), label: sampleLabel.trim() }), (sample) => { setSamples((current) => [...current, sample]); setSampleIds((current) => [...new Set([...current, sample.id])]); setSampleKey(""); setSampleLabel(""); }, t("film.advanced.sampleAdded")); };
  const addConsent = (event: FormEvent) => { event.preventDefault(); if (!isAdmin || !selectedId || !accepted || !subject.trim() || !terms.trim() || !evidenceKey.trim()) return; void execute(() => createFilmVoiceConsent(status.document.projectId, selectedId, { accepted: true, rightsBasis, subjectDisplayName: subject.trim(), termsVersion: terms.trim(), evidenceStorageKey: evidenceKey.trim() }), (consent) => { setConsents((current) => [...current, consent]); setConsentId(consent.id); setEvidenceKey(""); setAccepted(false); }, t("film.advanced.consentAdded")); };
  const startClone = () => { if (!selectedId || !providerId || !model.trim() || !sampleIds.length || !consentId) return; void execute(() => createFilmVoiceClone(status.document.projectId, selectedId, { providerId, model: model.trim(), sampleIds, consentId, idempotencyKey: newJobId("voice-clone") }), (version) => setVersions((current) => [...current.filter((item) => item.id !== version.id), version]), t("film.advanced.cloneQueued")); };
  const syncVersion = (version: FilmVoiceVersion) => void execute(() => syncFilmVoiceVersion(status.document.projectId, selectedId, version.id), (next) => setVersions((current) => current.map((item) => item.id === next.id ? next : item)), t("film.advanced.refreshed"));
  const cancelVersion = (version: FilmVoiceVersion) => void execute(() => cancelFilmAdvancedGenerationJob(version.generationJobId), () => syncVersion(version), t("film.advanced.cancelRequested"));

  return <div className="space-y-3">
    <div className="flex items-center gap-2"><Volume2 size={16} /><h3 className="font-medium">{t("film.advanced.voiceTitle")}</h3><button type="button" className="ob-btn ml-auto" disabled={busy} onClick={refreshIdentities}><RefreshCw size={14} />{t("film.refresh")}</button></div>
    <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={createIdentity}><input aria-label={t("film.advanced.identityName")} className="ob-input" value={identityTitle} onChange={(event) => setIdentityTitle(event.target.value)} placeholder={t("film.advanced.identityName")} /><input aria-label={t("film.assets.description")} className="ob-input" value={identityDescription} onChange={(event) => setIdentityDescription(event.target.value)} placeholder={t("film.assets.description")} /><button className="ob-btn" disabled={busy || !identityTitle.trim()}>{t("film.advanced.createIdentity")}</button></form>
    <Field label={t("film.advanced.identitySelect")}><select className="ob-input mt-1 w-full" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">{t("film.advanced.noIdentity")}</option>{identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.title} · r{identity.revision}</option>)}</select></Field>
    <div className="grid gap-3 xl:grid-cols-2">
      <form className="rounded border border-[var(--ob-line)] p-3" onSubmit={addSample}><h4 className="text-sm font-medium">{t("film.advanced.samples")}</h4><Field label={t("film.advanced.sampleStorageKey")}><input className="ob-input mt-1 w-full" value={sampleKey} onChange={(event) => setSampleKey(event.target.value)} /></Field><Field label={t("film.advanced.sampleLabel")}><input className="ob-input mt-1 w-full" value={sampleLabel} onChange={(event) => setSampleLabel(event.target.value)} /></Field><button className="ob-btn mt-2" disabled={busy || !selectedId || !sampleKey.trim()}>{t("film.advanced.addSample")}</button><ul className="mt-2 text-xs">{selectableSamples.map((id) => <li key={id}>{id}{samples.find((sample) => sample.id === id)?.label ? ` · ${samples.find((sample) => sample.id === id)?.label}` : ""}</li>)}</ul></form>
      <form className="rounded border border-[var(--ob-line)] p-3" onSubmit={addConsent}><h4 className="text-sm font-medium">{t("film.advanced.consents")}</h4><Field label={t("film.advanced.rightsBasis")}><select className="ob-input mt-1 w-full" value={rightsBasis} onChange={(event) => setRightsBasis(event.target.value as typeof rightsBasis)}><option value="self">{localizeAdvancedFilmStatus(t, "self")}</option><option value="licensed">{localizeAdvancedFilmStatus(t, "licensed")}</option><option value="authorized">{localizeAdvancedFilmStatus(t, "authorized")}</option></select></Field><Field label={t("film.advanced.subject")}><input className="ob-input mt-1 w-full" value={subject} onChange={(event) => setSubject(event.target.value)} /></Field><Field label={t("film.advanced.terms")}><input className="ob-input mt-1 w-full" value={terms} onChange={(event) => setTerms(event.target.value)} /></Field><Field label={t("film.advanced.evidenceStorageKey")}><input className="ob-input mt-1 w-full" value={evidenceKey} onChange={(event) => setEvidenceKey(event.target.value)} /></Field><label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />{t("film.advanced.explicitConsent")}</label>{!isAdmin ? <p className="mt-2 text-xs text-amber-500">{t("film.advanced.adminConsentOnly")}</p> : null}<button className="ob-btn mt-2" disabled={busy || !selectedId || !isAdmin || !accepted || !subject.trim() || !terms.trim() || !evidenceKey.trim()}>{t("film.advanced.recordConsent")}</button><ul className="mt-2 text-xs">{selectableConsents.map((id) => <li key={id}>{id}</li>)}</ul></form>
    </div>
    <div className="rounded border border-[var(--ob-line)] p-3"><h4 className="text-sm font-medium">{t("film.advanced.clone")}</h4><div className="grid gap-2 sm:grid-cols-2"><Field label={t("film.advanced.provider")}><select className="ob-input mt-1 w-full" value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">{t("film.advanced.noProvider")}</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></Field><Field label={t("film.advanced.model")}><input className="ob-input mt-1 w-full" value={model} onChange={(event) => setModel(event.target.value)} list="film-voice-models" /><datalist id="film-voice-models">{selectedChannel?.models.map((item) => <option key={item} value={item} />)}</datalist></Field><Field label={t("film.advanced.cloneSamples")}><select multiple className="ob-input mt-1 h-24 w-full" value={sampleIds} onChange={(event) => setSampleIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))}>{selectableSamples.map((id) => <option key={id} value={id}>{id}</option>)}</select></Field><Field label={t("film.advanced.cloneConsent")}><select className="ob-input mt-1 w-full" value={consentId} onChange={(event) => setConsentId(event.target.value)}><option value="">{t("film.advanced.noConsent")}</option>{selectableConsents.map((id) => <option key={id} value={id}>{id}</option>)}</select></Field></div><button type="button" className="ob-btn ob-btn-primary mt-2" disabled={busy || !selectedId || !providerId || !model.trim() || !sampleIds.length || !consentId} onClick={startClone}>{t("film.advanced.startClone")}</button></div>
    <div><h4 className="text-xs font-medium uppercase text-[var(--ob-muted)]">{t("film.advanced.versions")}</h4>{versions.length ? [...versions].reverse().map((version) => <div key={version.id} className="mt-2 flex flex-wrap items-center gap-2 rounded border border-[var(--ob-line)] p-2 text-xs"><span className="mr-auto">r{version.revision} · {localizeAdvancedFilmStatus(t, version.status)} · {version.providerId}/{version.model} · {t("film.advanced.sampleCount", { count: version.sampleIds.length })} · {version.consentId}</span><button type="button" className="ob-btn" disabled={busy} onClick={() => syncVersion(version)}><RefreshCw size={14} />{t("film.refresh")}</button>{version.status === "queued" || version.status === "running" ? <button type="button" className="ob-btn" disabled={busy} onClick={() => cancelVersion(version)}><Square size={12} />{t("film.advanced.cancelJob")}</button> : null}</div>) : <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.advanced.noVersions")}</p>}</div>
    {error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}{notice ? <p role="status" className="text-sm text-emerald-600">{notice}</p> : null}
  </div>;
}

function ComfyUIRunPanel({ status }: PanelProps) {
  const { t } = useI18n();
  const [manifestId, setManifestId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [references, setReferences] = useState("");
  const [firstFrame, setFirstFrame] = useState("");
  const [lastFrame, setLastFrame] = useState("");
  const [seed, setSeed] = useState("0");
  const [width, setWidth] = useState("1024");
  const [height, setHeight] = useState("1024");
  const [duration, setDuration] = useState("4");
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!status.capabilities.features.localWorkflows) return <FeatureUnavailable>{t("film.advanced.comfyDisabled")}</FeatureUnavailable>;
  const execute = async (operation: () => Promise<GenerationJob | undefined>) => {
    setBusy(true); setError("");
    try { const next = await operation(); if (next) setJob(next); else setError(t("film.advanced.jobMissing")); }
    catch (cause) { setError(messageOf(cause)); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!manifestId.trim()) return;
    const numeric = (value: string) => Number.isFinite(Number(value)) ? Number(value) : 0;
    void execute(() => createFilmComfyUIJob({
      id: newJobId("comfy"), projectId: status.document.projectId, manifestId: manifestId.trim(),
      values: {
        prompt: prompt.trim(), negativePrompt: negativePrompt.trim(), references: cleanList(references),
        firstFrame: firstFrame.trim(), lastFrame: lastFrame.trim(), seed: numeric(seed), width: numeric(width),
        height: numeric(height), duration: numeric(duration),
      },
    }));
  };
  const active = job?.status === "queued" || job?.status === "running";
  return <div className="space-y-3">
    <div className="flex items-center gap-2"><Workflow size={16} /><h3 className="font-medium">{t("film.advanced.comfyTitle")}</h3></div>
    <p className="text-xs text-[var(--ob-muted)]">{t("film.advanced.comfySafety")}</p>
    <form className="grid gap-2 sm:grid-cols-2" onSubmit={submit}><Field label={t("film.advanced.manifestId")}><input name="manifestId" className="ob-input mt-1 w-full" value={manifestId} onChange={(event) => setManifestId(event.target.value)} /></Field><Field label={t("film.advanced.prompt")}><input className="ob-input mt-1 w-full" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></Field><Field label={t("film.advanced.negativePrompt")}><input className="ob-input mt-1 w-full" value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} /></Field><Field label={t("film.advanced.references")}><input className="ob-input mt-1 w-full" value={references} onChange={(event) => setReferences(event.target.value)} placeholder={t("film.advanced.storageKeysPlaceholder")} /></Field><Field label={t("film.advanced.firstFrame")}><input className="ob-input mt-1 w-full" value={firstFrame} onChange={(event) => setFirstFrame(event.target.value)} /></Field><Field label={t("film.advanced.lastFrame")}><input className="ob-input mt-1 w-full" value={lastFrame} onChange={(event) => setLastFrame(event.target.value)} /></Field><div className="grid grid-cols-4 gap-2 sm:col-span-2"><Field label={t("film.advanced.seed")}><input className="ob-input mt-1 w-full" type="number" value={seed} onChange={(event) => setSeed(event.target.value)} /></Field><Field label={t("film.timeline.width")}><input className="ob-input mt-1 w-full" type="number" min={0} value={width} onChange={(event) => setWidth(event.target.value)} /></Field><Field label={t("film.timeline.height")}><input className="ob-input mt-1 w-full" type="number" min={0} value={height} onChange={(event) => setHeight(event.target.value)} /></Field><Field label={t("film.advanced.duration")}><input className="ob-input mt-1 w-full" type="number" min={0} value={duration} onChange={(event) => setDuration(event.target.value)} /></Field></div><div className="flex flex-wrap gap-2 sm:col-span-2"><button className="ob-btn ob-btn-primary" disabled={busy || !manifestId.trim()}>{t("film.advanced.submitComfy")}</button><button type="button" className="ob-btn" disabled={busy || !job} onClick={() => job && void execute(() => getFilmAdvancedGenerationJob(job.id))}><RefreshCw size={14} />{t("film.refresh")}</button><button type="button" className="ob-btn" disabled={busy || !active} onClick={() => job && void execute(() => cancelFilmAdvancedGenerationJob(job.id))}><Square size={12} />{t("film.advanced.cancelJob")}</button></div></form>
    {job ? <p role="status" className="text-sm">{job.id} · {localizeAdvancedFilmStatus(t, job.status)} · {job.providerId}/{job.model}{job.error ? ` · ${localizeAdvancedFilmError(t, job.error)}` : ""}</p> : <p className="text-xs text-[var(--ob-muted)]">{t("film.advanced.noComfyJob")}</p>}{error ? <p role="alert" className="text-sm text-[var(--ob-danger)]">{error}</p> : null}
  </div>;
}

export function AdvancedFilmToolsPanel(props: PanelProps) {
  const { t } = useI18n();
  return <WorkbenchSection id="advanced-tools" title={t("film.advanced.title")} wide><div className="grid gap-5 xl:grid-cols-3"><StyleExtractionPanel {...props} /><VoiceIdentityPanel {...props} /><ComfyUIRunPanel {...props} /></div></WorkbenchSection>;
}
