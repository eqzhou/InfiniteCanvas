import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { FileUp, Plus, Save, Send, Sparkles } from "lucide-react";
import { Link } from "react-router";

import { preflightFilmImport } from "@/lib/film-import";
import { filmEditorKey } from "@/lib/film-drafts";
import type { FilmCapabilities, FilmManuscriptPreflight, FilmStatus } from "@/services/film-client";
import type { FilmAsset, FilmAssetKind, FilmDocument } from "@/types/film";
import { WorkbenchSection } from "./WorkbenchSection";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";

export function ManuscriptPanel({ document, capabilities, manuscript, busy, onDraft, onPreflight, onImportText, onImportFile }: {
  document: FilmDocument; capabilities: FilmCapabilities; manuscript: string; busy: boolean;
  onDraft: (text: string) => void;
  onPreflight: (text: string, format: "text" | "txt" | "markdown") => Promise<FilmManuscriptPreflight>;
  onImportText: (text: string, format: "text" | "txt" | "markdown", originalName?: string) => Promise<boolean>;
  onImportFile: (file: File, format: "docx" | "pdf") => Promise<boolean>;
}) {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parseState, setParseState] = useState<"idle" | "parsing" | "error">("idle");
  const [fileError, setFileError] = useState("");
  const [preflight, setPreflight] = useState<FilmManuscriptPreflight | null>(null);
  const [preflightName, setPreflightName] = useState<string | undefined>();
  const formats = [
    ["txt", "TXT", capabilities.plainTextImport], ["md", "MD", capabilities.markdownImport],
    ["docx", "DOCX", capabilities.docxImport], ["pdf", "PDF", capabilities.pdfImport],
  ] as const;
  const persistedImport = document.source.importStatus;
  const importRunning = persistedImport?.status === "running";
  const controlsBusy = busy || importRunning;
  const accept = useMemo(() => formats.filter(([, , enabled]) => enabled).map(([extension]) => `.${extension}`).join(","), [capabilities]);
  const previewText = async (text: string, format: "text" | "txt" | "markdown", originalName?: string) => {
    setFileError("");
    setParseState("parsing");
    try {
      setPreflight(await onPreflight(text, format));
      setPreflightName(originalName);
      setParseState("idle");
    } catch (cause) {
      setPreflight(null);
      setPreflightName(undefined);
      setFileError(cause instanceof Error ? cause.message : String(cause));
      setParseState("error");
    }
  };
  const chooseFile = async (file: File) => {
    setFileError("");
    setParseState("parsing");
    try {
      const result = preflightFilmImport(file, capabilities);
      let ok = false;
      if (result.format === "txt" || result.format === "markdown") {
        const text = await file.text();
        if (!text.trim()) throw new Error(t("film.manuscript.emptyFile"));
        onDraft(text);
        await previewText(text, result.format, file.name);
        ok = true;
      } else {
        ok = await onImportFile(file, result.format);
      }
      setParseState(ok ? "idle" : "error");
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : String(cause));
      setParseState("error");
    }
  };
  return <WorkbenchSection id="manuscript" title={t("film.manuscript.title")}>
    <label className="block text-sm font-medium" htmlFor="film-manuscript">{t("film.manuscript.paste")}</label>
    <textarea id="film-manuscript" className="ob-input mt-2 min-h-52 w-full resize-y font-mono text-sm" value={manuscript} onChange={(event) => { setPreflight(null); setPreflightName(undefined); onDraft(event.target.value); }} placeholder="EPISODE 1&#10;INT. STUDIO - DAY&#10;A slate snaps shut." />
    <div className="mt-2 flex flex-wrap gap-1" aria-label={t("film.manuscript.formats")}>
      {formats.map(([id, label, enabled]) => <span key={id} data-testid={`film-format-${id}`} aria-disabled={!enabled} className={`rounded-full border px-2 py-1 text-xs ${enabled ? "border-[var(--ob-line)]" : "opacity-40"}`}>{label}</span>)}
    </div>
    {!capabilities.pdfImport && capabilities.pdfDiagnostic ? <p data-testid="film-pdf-diagnostic" className="mt-2 text-xs text-amber-500">{t("film.manuscript.pdfUnavailable", { diagnostic: capabilities.pdfDiagnostic })}</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="ob-btn ob-btn-primary" disabled={controlsBusy || parseState === "parsing" || !manuscript.trim()} onClick={() => void previewText(manuscript, "text")}><Send size={14} /> {t("film.manuscript.preflight")}</button>
      <button type="button" className="ob-btn" disabled={controlsBusy || !accept} onClick={() => fileRef.current?.click()}><FileUp size={14} /> {t("film.manuscript.chooseFile")}</button>
      <input data-testid="film-manuscript-file" ref={fileRef} type="file" className="hidden" disabled={controlsBusy} accept={accept} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void chooseFile(file); event.currentTarget.value = ""; }} />
    </div>
    {importRunning ? <p role="status" className="mt-2 text-sm text-[var(--ob-muted)]">{t("film.manuscript.parsingServer", { name: persistedImport.originalName || t("film.manuscript.defaultName") })}</p> : null}
    {persistedImport?.status === "failed" && persistedImport.error ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{t("film.manuscript.lastFailed", { error: persistedImport.error })}</p> : null}
    {parseState === "parsing" ? <p role="status" className="mt-2 text-sm text-[var(--ob-muted)]">{t("film.manuscript.uploading")}</p> : null}
    {fileError ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{fileError}</p> : null}
    {preflight ? <div className="mt-3 rounded-lg border border-[var(--ob-line)] p-3" role="region" aria-label={t("film.manuscript.preflightRegion")}>
      <div className="flex flex-wrap gap-2 text-xs"><strong>{t("film.manuscript.preflightDone")}</strong><span>{t("film.manuscript.episodes", { count: preflight.episodeCount })}</span><span>{t("film.manuscript.scenes", { count: preflight.sceneCount })}</span><span>{t("film.manuscript.characters", { count: preflight.characters })}</span><span>{t("film.manuscript.lines", { count: preflight.lineCount })}</span></div>
      <p className="mt-2 text-sm text-[var(--ob-muted)]">{preflight.summary}</p>
      {preflight.warnings.map((warning) => <p key={warning} className="mt-1 text-xs text-amber-500">{warning}</p>)}
      <button type="button" className="ob-btn mt-3" disabled={controlsBusy} onClick={() => void onImportText(manuscript, preflight.format, preflightName)}>{t("film.manuscript.applyDeterministic")}</button>
      <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.manuscript.aiCandidateHint")}</p>
    </div> : null}
    <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.manuscript.safetyHint", { revision: document.source.revision })}</p>
  </WorkbenchSection>;
}

type AIChannelChoice = { id: string; name: string; models: string[] };

const candidateStatusLabels: Record<"ready" | "stale" | "rejected" | "applied", MessageKey> = {
  ready: "film.ai.status.ready",
  stale: "film.ai.status.stale",
  rejected: "film.ai.status.rejected",
  applied: "film.ai.status.applied",
} as const;

export function AIDecompositionPanel({ document, busy, channels, channelId, model, onChannel, onModel, onRun, onApply, onRestoreStructure }: {
  document: FilmDocument;
  busy: boolean;
  channels: AIChannelChoice[];
  channelId: string;
  model: string;
  onChannel: (channelId: string) => void;
  onModel: (model: string) => void;
  onRun: () => void;
  onApply: (candidateId: string) => void;
  onRestoreStructure?: (versionId: string) => void;
}) {
  const { locale, t } = useI18n();
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  const candidates = [...(document.aiCandidates ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return <WorkbenchSection id="ai-decomposition" title={t("film.decomposition.title")}>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="text-xs text-[var(--ob-muted)]">{t("film.ai.channel")}
        <select aria-label={t("film.decomposition.channel")} className="ob-input mt-1 w-full" value={channelId} onChange={(event) => onChannel(event.target.value)}>
          {!channels.length ? <option value="">{t("film.ai.noChannel")}</option> : null}
          {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
      </label>
      <label className="text-xs text-[var(--ob-muted)]">{t("film.ai.model")}
        <input aria-label={t("film.decomposition.model")} className="ob-input mt-1 w-full" value={model} onChange={(event) => onModel(event.target.value)} list="film-ai-text-models" placeholder={t("film.ai.modelPlaceholder")} />
        <datalist id="film-ai-text-models">{selectedChannel?.models.map((item) => <option key={item} value={item} />)}</datalist>
      </label>
    </div>
    <button type="button" className="ob-btn ob-btn-primary mt-3" disabled={busy || !document.source.text.trim() || !channelId || !model.trim()} onClick={onRun}>
      <Sparkles size={14} /> {t("film.decomposition.run")}
    </button>
    <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.decomposition.freezeHint")}</p>
    <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.decomposition.approvalHint")}</p>
    {!candidates.length ? <p className="mt-4 rounded-lg border border-dashed border-[var(--ob-line)] p-4 text-sm text-[var(--ob-muted)]">{t("film.decomposition.empty")}</p> : <ul className="mt-4 space-y-3">
      {candidates.map((candidate) => {
        const snapshot = document.tasks.find((task) => task.id === candidate.taskId)?.textSnapshot;
        const counts = candidate.decomposition.episodes.reduce((total, episode) => ({
          scenes: total.scenes + episode.scenes.length,
          shots: total.shots + episode.scenes.reduce((sum, scene) => sum + scene.shots.length, 0),
        }), { scenes: 0, shots: 0 });
        return <li key={candidate.id} className="rounded-lg border border-[var(--ob-line)] p-3" data-status={candidate.status}>
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-sm">{t("film.decomposition.candidate", { status: t(candidateStatusLabels[candidate.status]) })}</strong>
            <span className="rounded-full border border-[var(--ob-line)] px-2 py-0.5 text-xs">{t("film.ai.sourceRevision", { revision: candidate.sourceRevision })}</span>
            {snapshot ? <span className="text-xs text-[var(--ob-muted)]">{snapshot.providerId} / {snapshot.model}</span> : null}
          </div>
          <p className="mt-2 text-sm">{candidate.decomposition.summary}</p>
          {candidate.decomposition.theme ? <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.decomposition.theme", { theme: candidate.decomposition.theme })}</p> : null}
          <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.decomposition.counts", { characters: candidate.decomposition.characters.length, locations: candidate.decomposition.locations.length, episodes: candidate.decomposition.episodes.length, scenes: counts.scenes, shots: counts.shots })}</p>
          <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.decomposition.storyCounts", { relationships: candidate.decomposition.relationships?.length ?? 0, beats: candidate.decomposition.beats?.length ?? 0, arcs: candidate.decomposition.characterArcs?.length ?? 0 })}</p>
          {candidate.status === "ready" ? <button type="button" className="ob-btn mt-3" disabled={busy} onClick={() => onApply(candidate.id)}>{t("film.decomposition.apply")}</button> : null}
        </li>;
      })}
    </ul>}
    {(document.structureVersions ?? []).length ? <div className="mt-4 border-t border-[var(--ob-line)] pt-3"><h3 className="text-sm font-medium">{t("film.decomposition.history")}</h3><p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.decomposition.restoreHint")}</p>{[...(document.structureVersions ?? [])].reverse().slice(0, 10).map((version) => <div key={version.id} className="mt-2 flex items-center gap-2 text-xs"><span className="mr-auto">{t("film.decomposition.versionCounts", { episodes: version.episodes.length, scenes: version.scenes.length, shots: version.shots.length, date: new Date(version.createdAt).toLocaleString(locale) })}</span><button type="button" className="ob-btn" disabled={busy || !onRestoreStructure} onClick={() => onRestoreStructure?.(version.id)}>{t("film.decomposition.restore")}</button></div>)}</div> : null}
  </WorkbenchSection>;
}

export function AIScriptPanel({ document, busy, channels, channelId, model, episodeId, scriptMode, onChannel, onModel, onEpisode, onScriptMode, onRun, onApply }: {
  document: FilmDocument;
  busy: boolean;
  channels: AIChannelChoice[];
  channelId: string;
  model: string;
  episodeId: string;
  scriptMode: "adaptive" | "literal" | "shooting";
  onChannel: (channelId: string) => void;
  onModel: (model: string) => void;
  onEpisode: (episodeId: string) => void;
  onScriptMode: (mode: "adaptive" | "literal" | "shooting") => void;
  onRun: () => void;
  onApply: (candidateId: string) => void;
}) {
  const { t } = useI18n();
  const selectedChannel = channels.find((channel) => channel.id === channelId);
  const decomposeApproved = document.stages.find((stage) => stage.id === "decompose")?.status === "approved";
  const candidates = [...(document.scriptCandidates ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return <WorkbenchSection id="ai-script" title={t("film.script.title")}>
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <label className="text-xs text-[var(--ob-muted)]">{t("film.script.targetEpisode")}
        <select aria-label={t("film.script.targetEpisodeLabel")} className="ob-input mt-1 w-full" value={episodeId} onChange={(event) => onEpisode(event.target.value)}>
          {!document.episodes.length ? <option value="">{t("film.script.noEpisodes")}</option> : null}
          {[...document.episodes].sort((left, right) => left.order - right.order).map((episode) => <option key={episode.id} value={episode.id}>{episode.order + 1}. {episode.title}</option>)}
        </select>
      </label>
      <label className="text-xs text-[var(--ob-muted)]">{t("film.script.mode")}
        <select aria-label={t("film.script.modeLabel")} className="ob-input mt-1 w-full" value={scriptMode} onChange={(event) => onScriptMode(event.target.value as "adaptive" | "literal" | "shooting")}>
          <option value="adaptive">{t("film.script.adaptive")}</option><option value="literal">{t("film.script.literal")}</option><option value="shooting">{t("film.script.shooting")}</option>
        </select>
      </label>
      <label className="text-xs text-[var(--ob-muted)]">{t("film.ai.channel")}
        <select aria-label={t("film.script.channel")} className="ob-input mt-1 w-full" value={channelId} onChange={(event) => onChannel(event.target.value)}>
          {!channels.length ? <option value="">{t("film.ai.noChannel")}</option> : null}
          {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
      </label>
      <label className="text-xs text-[var(--ob-muted)]">{t("film.ai.model")}
        <input aria-label={t("film.script.model")} className="ob-input mt-1 w-full" value={model} onChange={(event) => onModel(event.target.value)} list="film-ai-script-models" placeholder={t("film.ai.modelPlaceholder")} />
        <datalist id="film-ai-script-models">{selectedChannel?.models.map((item) => <option key={item} value={item} />)}</datalist>
      </label>
    </div>
    <button type="button" className="ob-btn ob-btn-primary mt-3" disabled={busy || !decomposeApproved || !episodeId || !channelId || !model.trim()} onClick={onRun}>
      <Sparkles size={14} /> {t("film.script.generate")}
    </button>
    {!decomposeApproved ? <p className="mt-2 text-xs text-amber-500">{t("film.script.approveFirst")}</p> : null}
    <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.script.freezeHint")}</p>
    {!candidates.length ? <p className="mt-4 rounded-lg border border-dashed border-[var(--ob-line)] p-4 text-sm text-[var(--ob-muted)]">{t("film.script.empty")}</p> : <ul className="mt-4 space-y-3">
      {candidates.map((candidate) => {
        const episode = document.episodes.find((item) => item.id === candidate.targetEpisodeId);
        const shotCount = candidate.script.scenes.reduce((sum, scene) => sum + scene.shots.length, 0);
        const snapshot = document.tasks.find((task) => task.id === candidate.taskId)?.textSnapshot;
        return <li key={candidate.id} className="rounded-lg border border-[var(--ob-line)] p-3" data-status={candidate.status}>
          <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{episode?.title ?? t("film.script.changedEpisode")} · {t(candidateStatusLabels[candidate.status])}</strong><span className="rounded-full border border-[var(--ob-line)] px-2 py-0.5 text-xs">{t("film.ai.targetRevision", { revision: candidate.targetRevision })}</span>{snapshot ? <span className="text-xs text-[var(--ob-muted)]">{snapshot.providerId} / {snapshot.model}</span> : null}</div>
          <p className="mt-2 text-sm">{candidate.script.summary}</p>
          <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.script.counts", { scenes: candidate.script.scenes.length, shots: shotCount })}</p>
          {candidate.status === "ready" ? <button type="button" className="ob-btn mt-3" disabled={busy} onClick={() => onApply(candidate.id)}>{t("film.script.apply")}</button> : null}
        </li>;
      })}
    </ul>}
  </WorkbenchSection>;
}

function AssetEditor({ projectId, asset, characters, episodes, scenes, shots, busy, onSave }: { projectId: string; asset: FilmAsset; characters: FilmAsset[]; episodes: FilmDocument["episodes"]; scenes: FilmDocument["scenes"]; shots: FilmDocument["shots"]; busy: boolean; onSave: (asset: FilmAsset, patch: Partial<FilmAsset>) => void }) {
  const { t } = useI18n();
  const [title, setTitle] = useState(asset.title);
  const [description, setDescription] = useState(asset.description);
  const [detail, setDetail] = useState(asset.stylePrompt ?? asset.voice ?? "");
  const [parentAssetId, setParent] = useState(asset.parentAssetId ?? "");
  const [ageStage, setAgeStage] = useState(asset.ageStage ?? "");
  const [costume, setCostume] = useState(asset.costume ?? "");
  const [storyPeriod, setStoryPeriod] = useState(asset.storyPeriod ?? "");
  const [isDefault, setIsDefault] = useState(asset.isDefault ?? false);
  const [episodeIds, setEpisodeIds] = useState(asset.episodeIds ?? []);
  const [sceneIds, setSceneIds] = useState(asset.sceneIds ?? []);
  const [shotIds, setShotIds] = useState(asset.shotIds ?? []);
  const selectedValues = (event: ChangeEvent<HTMLSelectElement>) => Array.from(event.currentTarget.selectedOptions, (option) => option.value);
  return <li data-testid={`film-asset-${asset.id}`} data-revision={asset.revision} className="rounded-lg border border-[var(--ob-line)] p-3">
    <div className="mb-2 flex items-center justify-between"><strong className="text-xs uppercase tracking-wide">{asset.kind}</strong><span className="text-xs text-[var(--ob-muted)]">r{asset.revision}</span></div>
    <input aria-label={t("film.assets.nameEdit")} className="ob-input w-full" value={title} onChange={(event) => setTitle(event.target.value)} />
    <textarea aria-label={t("film.assets.description")} className="ob-input mt-2 min-h-20 w-full" value={description} onChange={(event) => setDescription(event.target.value)} />
    {asset.kind === "style" || asset.kind === "voice" ? <input aria-label={asset.kind === "style" ? t("film.assets.stylePrompt") : t("film.voice.identity")} className="ob-input mt-2 w-full" value={detail} onChange={(event) => setDetail(event.target.value)} /> : null}
    {asset.kind === "identity" ? <div className="mt-2 grid gap-2 sm:grid-cols-2"><select aria-label={t("film.assets.parentCharacter")} className="ob-input" value={parentAssetId} onChange={(event) => setParent(event.target.value)}><option value="">{t("film.assets.unboundCharacter")}</option>{characters.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select><input aria-label={t("film.assets.ageStage")} className="ob-input" value={ageStage} onChange={(event) => setAgeStage(event.target.value)} placeholder={t("film.assets.ageStage")} /><input aria-label={t("film.assets.costume")} className="ob-input" value={costume} onChange={(event) => setCostume(event.target.value)} placeholder={t("film.assets.costumePlaceholder")} /><input aria-label={t("film.assets.storyPeriod")} className="ob-input" value={storyPeriod} onChange={(event) => setStoryPeriod(event.target.value)} placeholder={t("film.assets.storyPeriod")} /><label className="text-xs"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} /> {t("film.assets.defaultIdentity")}</label><label className="text-xs text-[var(--ob-muted)]">{t("film.assets.episodesScope")}<select multiple aria-label={t("film.assets.episodesScopeLabel")} className="ob-input mt-1 h-24 w-full" value={episodeIds} onChange={(event) => setEpisodeIds(selectedValues(event))}>{episodes.map((item) => <option key={item.id} value={item.id}>{item.order + 1}. {item.title}</option>)}</select></label><label className="text-xs text-[var(--ob-muted)]">{t("film.assets.scenesScope")}<select multiple aria-label={t("film.assets.scenesScopeLabel")} className="ob-input mt-1 h-24 w-full" value={sceneIds} onChange={(event) => setSceneIds(selectedValues(event))}>{scenes.map((item) => <option key={item.id} value={item.id}>{item.heading}</option>)}</select></label><label className="text-xs text-[var(--ob-muted)] sm:col-span-2">{t("film.assets.shotsScope")}<select multiple aria-label={t("film.assets.shotsScopeLabel")} className="ob-input mt-1 h-24 w-full" value={shotIds} onChange={(event) => setShotIds(selectedValues(event))}>{shots.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label></div> : null}
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="ob-btn" disabled={busy || !title.trim()} onClick={() => onSave(asset, { title, description, parentAssetId, ...(asset.kind === "style" ? { stylePrompt: detail } : {}), ...(asset.kind === "voice" ? { voice: detail } : {}), ...(asset.kind === "identity" ? { ageStage, costume, storyPeriod, isDefault, episodeIds, sceneIds, shotIds } : {}) })}><Save size={14} /> {t("film.assets.save")}</button>{asset.kind !== "voice" ? <Link className="ob-btn" to={`/workbench/image?filmProjectId=${encodeURIComponent(projectId)}&assetId=${encodeURIComponent(asset.id)}&assetRevision=${asset.revision}&prompt=${encodeURIComponent([asset.title, asset.description, asset.stylePrompt].filter(Boolean).join(", "))}`}><Sparkles size={14} /> {t("film.assets.generateAdopt")}</Link> : null}</div>
  </li>;
}

export function AssetsPanel({ status, busy, onCreate, onSave }: { status: FilmStatus; busy: boolean; onCreate: (input: { kind: FilmAssetKind; title: string; parentAssetId?: string }) => void; onSave: (asset: FilmAsset, patch: Partial<FilmAsset>) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<FilmAssetKind>("character");
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState("");
  const characters = status.document.assets.filter((asset) => asset.kind === "character");
  return <WorkbenchSection id="assets" title={t("film.assets.title")}>
    <form className="grid gap-2 sm:grid-cols-[130px_1fr_auto]" onSubmit={(event) => { event.preventDefault(); if (!title.trim()) return; onCreate({ kind, title: title.trim(), ...(kind === "identity" && parent ? { parentAssetId: parent } : {}) }); setTitle(""); }}>
      <select aria-label={t("film.assets.kind")} className="ob-input" value={kind} onChange={(event) => setKind(event.target.value as FilmAssetKind)}>{["character", "identity", "location", "prop", "style", "voice"].map((item) => <option key={item} value={item}>{item}</option>)}</select>
      <input aria-label={t("film.assets.name")} className="ob-input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("film.assets.namePlaceholder")} />
      <button className="ob-btn" disabled={busy || !title.trim()}><Plus size={14} /> {t("film.assets.add")}</button>
      {kind === "identity" ? <select aria-label={t("film.assets.newIdentityParent")} className="ob-input sm:col-span-2" value={parent} onChange={(event) => setParent(event.target.value)}><option value="">{t("film.assets.selectCharacter")}</option>{characters.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select> : null}
    </form>
    <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.assets.hint")}</p>
    <ul className="mt-4 grid gap-2 sm:grid-cols-2">{status.document.assets.map((asset) => <AssetEditor key={filmEditorKey(asset.id, asset.revision)} projectId={status.document.projectId} asset={asset} characters={characters} episodes={status.document.episodes} scenes={status.document.scenes} shots={status.document.shots} busy={busy} onSave={onSave} />)}</ul>
  </WorkbenchSection>;
}
