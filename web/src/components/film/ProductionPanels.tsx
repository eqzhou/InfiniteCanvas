import { useEffect, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";

import { useI18n } from "@/i18n/I18nProvider";
import { buildFilmProjectionDiffs, type FilmProjectionDiff } from "@/lib/film-document";
import {
  cancelFilmGenerationJob,
  commitFilmProjection,
  listFilmGenerationJobs,
  listFilmDirectorCaptures,
  loadFilmStatus,
  refreshFilmProjection,
  resolveFilmStageSelection,
  retryFilmGenerationJob,
  waitForFilmGenerationStage,
  type FilmGenerationJob,
  type FilmCanvasAdoptionRequest,
  type FilmDirectorAdoptionInput,
  type FilmDirectorCapture,
  type FilmDirectorSceneBindingInput,
  type FilmProjectionPlan,
  type FilmStageRunRequest,
  type FilmStatus,
} from "@/services/film-client";
import type { FilmDialogue, FilmShot, FilmStage, FilmStageKind } from "@/types/film";
import type { BoardProject } from "@/types/board";
import { listMediaCapabilities, mediaOptionsForKind, type MediaCapabilityCatalog, type MediaKind } from "@/services/media-capabilities";
import { WorkbenchSection } from "./WorkbenchSection";
import { localizeFilmDiagnostic, localizeFilmStatus } from "./film-display";
import { executeFilmAgentRead, type FilmAgentReadTool } from "@/services/film-agent-client";
import { EpisodeProductionViews } from "./EpisodeProductionViews";
import { TextEntryDialog } from "@/components/canvas/TextEntryDialog";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";

export function EpisodesPanel({ status, busy, onSaveEpisode, onSaveShot, onCreateDialogue, onSaveDialogue, onDeleteDialogue }: {
  status: FilmStatus; busy: boolean;
  onSaveEpisode: (id: string, revision: number, title: string) => void;
  onSaveShot: (shot: FilmShot, patch: Partial<FilmShot>) => void;
  onCreateDialogue: (shotId: string, kind: FilmDialogue["kind"], text: string) => void;
  onSaveDialogue: (dialogue: FilmDialogue, patch: Partial<FilmDialogue>) => void;
  onDeleteDialogue: (dialogue: FilmDialogue) => void;
}) {
  return <EpisodeProductionViews status={status} busy={busy} onSaveEpisode={onSaveEpisode} onSaveShot={onSaveShot} onCreateDialogue={onCreateDialogue} onSaveDialogue={onSaveDialogue} onDeleteDialogue={onDeleteDialogue} />;
}

export function ProductionPanel({ status, busy, onLegacyStage, onRun, onSynced, onWaive = () => {}, onRevokeWaiver = () => {} }: { status: FilmStatus; busy: boolean; onLegacyStage: (stage: FilmStage, action: "run" | "approve" | "reject") => void; onRun: (stage: FilmStageKind, request: FilmStageRunRequest) => Promise<boolean>; onSynced: (status: FilmStatus) => void; onWaive?: (stage: FilmStage, reason: string) => void; onRevokeWaiver?: (waiverId: string, waiverRevision: number) => void }) {
  const { t } = useI18n();
  const capabilities = status.capabilities;
  const [jobs, setJobs] = useState<FilmGenerationJob[]>([]);
  const [jobError, setJobError] = useState("");
  const [stage, setStage] = useState<FilmStageKind>("storyboard");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [config, setConfig] = useState("{\n  \"quality\": \"standard\"\n}");
  const [mediaCatalog, setMediaCatalog] = useState<MediaCapabilityCatalog | null>(null);
  const [mediaCatalogError, setMediaCatalogError] = useState("");
  const [episodeFrom, setEpisodeFrom] = useState(1); const [episodeTo, setEpisodeTo] = useState(1);
  const [shotFrom, setShotFrom] = useState(0); const [shotTo, setShotTo] = useState(0);
  const syncKey = useRef("");
  useEffect(() => {
    if (capabilities.generationStages.includes(stage)) return;
    const firstAvailable = capabilities.generationStages[0];
    if (firstAvailable) setStage(firstAvailable);
  }, [capabilities.generationStages, stage]);
  useEffect(() => {
    let active = true;
    void listMediaCapabilities().then((catalog) => { if (active) { setMediaCatalog(catalog); setMediaCatalogError(""); } }).catch((cause) => { if (active) { setMediaCatalog(null); setMediaCatalogError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { active = false; };
  }, []);
  const mediaKind: MediaKind = stage === "audio" ? "audio" : stage === "video" ? "video" : "image";
  const mediaOptions = mediaCatalog ? mediaOptionsForKind(mediaCatalog, mediaKind) : [];
  useEffect(() => {
    if (!mediaOptions.length) { setProvider(""); setModel(""); return; }
    const selected = mediaOptions.find((option) => option.channelId === provider && option.model === model) ?? mediaOptions[0]!;
    setProvider(selected.channelId); setModel(selected.model);
  }, [mediaCatalog?.version, mediaKind]);
  const refreshJobs = async () => {
    if (!capabilities.generationJobs && !status.document.tasks.some((task) => task.generationJobId)) return;
    try { setJobs(await listFilmGenerationJobs(status.document.projectId, status)); setJobError(""); }
    catch (cause) { setJobError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { void refreshJobs(); }, [status.document.projectId, capabilities.generationJobs]);
  useEffect(() => {
    const children = jobs.filter((job) => job.shotId && job.stage === stage);
    if (!children.length) return;
    const key = children.map((job) => `${job.id}:${job.updatedAt}:${job.status}`).join("|");
    if (syncKey.current === key) return;
    syncKey.current = key;
    const controller = new AbortController();
    void waitForFilmGenerationStage(status.document.projectId, stage, { signal: controller.signal })
      .then((next) => { onSynced(next); return refreshJobs(); })
      .catch((cause) => { if (!controller.signal.aborted) setJobError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [jobs, stage, status.document.projectId]);
  const submit = async () => {
    let generationConfig: FilmStageRunRequest["generationConfig"];
    try {
      generationConfig = JSON.parse(config) as FilmStageRunRequest["generationConfig"];
    } catch {
      setJobError(t("film.production.configJsonError"));
      return;
    }
    try {
      const selected = status.document.stages.find((item) => item.id === stage)!;
      const selection = resolveFilmStageSelection(status.document, { from: episodeFrom, to: episodeTo }, { from: shotFrom, to: shotTo });
      const ok = await onRun(stage, { revision: selected.revision, ...selection, provider: provider.trim(), model: model.trim(), generationConfig, idempotencyKey: idempotencyKey.trim() });
      if (ok) await refreshJobs();
    } catch (cause) { setJobError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const updateOne = (next: FilmGenerationJob) => setJobs((current) => current.map((job) => job.id === next.id ? next : job));
  const retryOne = async (jobId: string) => {
    const next = await retryFilmGenerationJob(status.document.projectId, jobId);
    if ("document" in next) onSynced(next); else updateOne(next);
    await refreshJobs();
  };
  const cancelOne = async (jobId: string) => {
    updateOne(await cancelFilmGenerationJob(status.document.projectId, jobId));
    onSynced(await loadFilmStatus(status.document.projectId));
    await refreshJobs();
  };
  const latestGenerationJobIds = new Set<string>();
  const latestTaskScopes = new Set<string>();
  for (let index = status.document.tasks.length - 1; index >= 0; index -= 1) {
    const task = status.document.tasks[index];
    if (!task.generationJobId) continue;
    const scope = `${task.stage}:${task.dialogueId || task.shotId || "text"}`;
    if (latestTaskScopes.has(scope)) continue;
    latestTaskScopes.add(scope);
    latestGenerationJobIds.add(task.generationJobId);
  }
  const [waiverTarget, setWaiverTarget] = useState<FilmStage | null>(null);
  const [waiverReason, setWaiverReason] = useState<string | null>(null);
  const protectedStages = new Set<FilmStageKind>(["decompose", "compose", "delivery"]);
  const activeWaivers = new Map((status.document.stageWaivers ?? []).filter((waiver) => !waiver.revokedAt).map((waiver) => [waiver.stageId, waiver]));
  const requestWaiver = (item: FilmStage) => {
    setWaiverTarget(item);
    setWaiverReason(null);
  };
  const closeWaiver = () => {
    setWaiverTarget(null);
    setWaiverReason(null);
  };
  return <WorkbenchSection id="tasks" title={t("film.production.title")} wide>
    <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
	      <div><h3 className="text-sm font-medium">{t("film.production.reviewStatus")}</h3><ol className="mt-2 space-y-2">{status.document.stages.map((item) => { const waiver = activeWaivers.get(item.id); return <li key={item.id} data-testid={`film-stage-${item.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--ob-line)] p-2"><span>{t(`film.stage.${item.id}`)}</span><span className="mr-auto text-xs">{localizeFilmStatus(t, item.status)} · r{item.revision}</span>{item.status === "needs_review" ? <><button className="ob-btn" onClick={() => onLegacyStage(item, "approve")}>{t("film.production.approve")}</button><button className="ob-btn" onClick={() => onLegacyStage(item, "reject")}>{t("film.production.reject")}</button></> : <button className="ob-btn" disabled={busy || item.status === "approved"} onClick={() => onLegacyStage(item, "run")}>{t("film.production.submitReview")}</button>}{capabilities.features?.stageWaiver && item.status !== "approved" && !protectedStages.has(item.id) ? waiver ? <button className="ob-btn" disabled={busy} title={waiver.reason} onClick={() => onRevokeWaiver(waiver.id, waiver.revision)}>{t("film.production.revokeWaiver")}</button> : <button className="ob-btn" disabled={busy} onClick={() => requestWaiver(item)}>{t("film.production.auditWaiver")}</button> : null}{waiver ? <p className="w-full text-xs text-amber-500">{t("film.production.waived", { reason: waiver.reason })}</p> : null}</li>; })}</ol><p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.production.reviewHint")}</p></div>
      <div><h3 className="text-sm font-medium">{t("film.production.scopeConfig")}</h3><div className="mt-2 grid gap-2 sm:grid-cols-2"><select aria-label={t("film.production.runStage")} className="ob-input" value={stage} onChange={(event) => setStage(event.target.value as FilmStageKind)}>{status.document.stages.filter((item) => capabilities.generationStages.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{t(`film.stage.${item.id}`)}</option>)}</select><input aria-label={t("film.production.idempotencyKey")} className="ob-input" value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} /><label className="text-xs sm:col-span-2">{t("film.production.mediaCatalog")}<select aria-label={t("film.production.mediaCapability")} className="ob-input mt-1 w-full" disabled={!mediaOptions.length} value={provider && model ? `${provider}:${model}` : ""} onChange={(event) => { const option = mediaOptions.find((item) => `${item.channelId}:${item.model}` === event.target.value); setProvider(option?.channelId ?? ""); setModel(option?.model ?? ""); }}><option value="">{mediaCatalog ? t("film.production.noMediaModel", { kind: mediaKind }) : t("film.production.loadingCatalog")}</option>{mediaOptions.map((option) => <option key={`${option.channelId}:${option.model}`} value={`${option.channelId}:${option.model}`}>{option.channelName} · {option.model} · {option.modes.join(" / ")}</option>)}</select></label><label className="text-xs">{t("film.production.episodeRange")}<div className="flex gap-1"><input className="ob-input w-full" type="number" min="1" value={episodeFrom} onChange={(e) => setEpisodeFrom(Number(e.target.value))} /><input className="ob-input w-full" type="number" min="1" value={episodeTo} onChange={(e) => setEpisodeTo(Number(e.target.value))} /></div></label><label className="text-xs">{t("film.production.shotRange")}<div className="flex gap-1"><input className="ob-input w-full" type="number" min="0" value={shotFrom} onChange={(e) => setShotFrom(Number(e.target.value))} /><input className="ob-input w-full" type="number" min="0" value={shotTo} onChange={(e) => setShotTo(Number(e.target.value))} /></div></label><textarea aria-label={t("film.production.configJson")} className="ob-input min-h-24 sm:col-span-2" value={config} onChange={(event) => setConfig(event.target.value)} /></div><p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.production.catalogHint")} {mediaCatalog ? t("film.production.catalogVersion", { version: mediaCatalog.version.slice(0, 12) }) : mediaCatalogError}</p><button type="button" className="ob-btn ob-btn-primary mt-2" disabled={busy || !capabilities.stageGeneration || !capabilities.generationStages.includes(stage) || !mediaCatalog || !provider.trim() || !model.trim() || !idempotencyKey.trim()} onClick={() => void submit()}>{t("film.production.start")}</button>{!capabilities.stageGeneration ? <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.production.scopeUnavailable")}</p> : null}</div>
    </div>
    <div className="mt-5 flex items-center gap-2"><h3 className="mr-auto text-sm font-medium">{t("film.production.jobs")}</h3><button className="ob-btn" disabled={!capabilities.generationJobs && !status.document.tasks.some((task) => task.generationJobId)} onClick={() => void refreshJobs()}><RefreshCw size={14} /> {t("film.production.refreshJobs")}</button></div>
    {jobError ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{jobError}</p> : null}
    <ul className="mt-2 space-y-2">{jobs.map((job) => <li key={job.id} data-testid={`generation-job-${job.id}`} className={`rounded-lg border border-[var(--ob-line)] p-3 ${job.parentJobId ? "ml-5" : ""}`}><div className="flex flex-wrap items-center gap-2"><strong className="mr-auto text-sm">{job.title}</strong><span className="text-xs">{localizeFilmStatus(t, job.status)}</span>{latestGenerationJobIds.has(job.id) && (job.status === "failed" || job.status === "canceled") ? <button className="ob-btn" onClick={() => void retryOne(job.id).catch((cause) => setJobError(String(cause)))}>{t(job.shotId ? "film.production.retryShot" : "film.production.retryJob")}</button> : null}{(job.status === "queued" || job.status === "running") ? <button className="ob-btn" onClick={() => void cancelOne(job.id).catch((cause) => setJobError(String(cause)))}>{t("film.production.cancel")}</button> : null}</div>{job.error ? <p className="text-xs text-[var(--ob-danger)]">{localizeFilmDiagnostic(t, job.error)}</p> : null}</li>)}</ul>
    {!jobs.length ? <p className="mt-2 text-sm text-[var(--ob-muted)]">{t(capabilities.generationJobs ? "film.production.noJobs" : "film.production.jobsUnavailable")}</p> : null}
    <TextEntryDialog
      open={Boolean(waiverTarget && waiverReason === null)}
      title={t("film.production.auditWaiver")}
      label={t("film.production.waiverPrompt")}
      submitLabel={t("common.confirm")}
      onClose={closeWaiver}
      onSubmit={(reason) => setWaiverReason(reason.trim())}
    />
    {waiverTarget && waiverReason !== null ? (
      <ConfirmDialog
        title={t("film.production.waiverConfirm")}
        message={waiverReason}
        confirmLabel={t("common.confirm")}
        tone="danger"
        busy={busy}
        onCancel={closeWaiver}
        onConfirm={() => {
          const target = waiverTarget;
          const reason = waiverReason;
          closeWaiver();
          onWaive(target, reason);
        }}
      />
    ) : null}
  </WorkbenchSection>;
}

export function ProjectionPanel({ project, status, busy, onStatus, onRefreshCanvas, onCommitCanvas, onAdopt, onAdoptDirector, onBindDirectorScene, onOpenDirector }: {
  project: BoardProject; status: FilmStatus; busy: boolean;
  onStatus: (label: string, operation: () => Promise<FilmStatus>) => void;
  onRefreshCanvas: () => Promise<void>;
  onCommitCanvas: (diffs: FilmProjectionDiff[]) => Promise<void>;
  onAdopt: (input: FilmCanvasAdoptionRequest) => Promise<void>;
  onAdoptDirector: (input: FilmDirectorAdoptionInput) => Promise<void>;
  onBindDirectorScene: (input: FilmDirectorSceneBindingInput) => Promise<void>;
  onOpenDirector: (sceneId: string) => void;
}) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<FilmProjectionPlan | null>(null);
  const [error, setError] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [target, setTarget] = useState("");
  const [directorCaptures, setDirectorCaptures] = useState<FilmDirectorCapture[]>([]);
  const [directorCaptureId, setDirectorCaptureId] = useState("");
  const [directorTarget, setDirectorTarget] = useState("");
  const [directorSceneId, setDirectorSceneId] = useState(status.document.scenes[0]?.id ?? "");
  const diffs = buildFilmProjectionDiffs(project, status.document);
  const candidates = project.nodes.filter((node) => ["image", "video", "audio"].includes(node.type) && node.metadata.storageKey);
  const directorNodes = project.nodes.filter((node) => node.type === "director");
  const targets = [
    ...status.document.shots.flatMap((shot) => ([
      { key: `shot:${shot.id}:image`, label: t("film.projection.target", { title: shot.title, kind: t("film.stage.storyboard") }), revision: shot.revision },
      { key: `shot:${shot.id}:first_frame`, label: t("film.projection.target", { title: shot.title, kind: t("film.stage.first_frame") }), revision: shot.revision },
      { key: `shot:${shot.id}:last_frame`, label: t("film.projection.target", { title: shot.title, kind: t("film.projection.lastFrame") }), revision: shot.revision },
      { key: `shot:${shot.id}:video`, label: t("film.projection.target", { title: shot.title, kind: t("film.timeline.track.video") }), revision: shot.revision },
      { key: `shot:${shot.id}:audio`, label: t("film.projection.target", { title: shot.title, kind: t("film.episodes.views.audio") }), revision: shot.revision },
    ])),
    ...status.document.assets.map((asset) => ({ key: `asset:${asset.id}:media`, label: t("film.projection.assetReference", { title: asset.title, kind: asset.kind }), revision: asset.revision })),
  ];
  const adopt = async () => {
    const node = candidates.find((item) => item.id === candidateId);
    const selected = targets.find((item) => item.key === target);
    if (!node?.metadata.storageKey || !selected) throw new Error(t("film.projection.selectCandidateTarget"));
    const [targetType, targetId, targetField] = selected.key.split(":") as ["shot" | "asset", string, "image" | "first_frame" | "last_frame" | "video" | "audio" | "media"];
    if (targetType === "shot" && node.type !== (targetField === "first_frame" || targetField === "last_frame" ? "image" : targetField)) throw new Error(t("film.projection.typeMismatch"));
    await onAdopt({ targetType, targetId, targetField, expectedRevision: selected.revision, sourceNodeId: node.id, storageKey: node.metadata.storageKey, ...(node.metadata.generationJobId ? { generationJobId: node.metadata.generationJobId } : {}), ...(node.metadata.splitSourceStorageKey && node.metadata.splitCrop && node.metadata.contentSha256 ? { splitSourceStorageKey: node.metadata.splitSourceStorageKey, splitCrop: node.metadata.splitCrop, candidateSha256: node.metadata.contentSha256 } : {}) });
  };
  const loadDirectorCaptures = async () => {
    const captures = await listFilmDirectorCaptures(project.id, directorNodes.map((node) => node.id));
    setDirectorCaptures(captures);
    setDirectorCaptureId((current) => captures.some((capture) => capture.id === current) ? current : captures[0]?.id ?? "");
  };
  const adoptDirector = async () => {
    const [targetType, targetId, targetField] = directorTarget.split(":") as ["shot" | "scene", string, FilmDirectorAdoptionInput["targetField"] | "scene"];
    if (targetType === "scene") {
      const scene = status.document.scenes.find((item) => item.id === targetId);
      if (!scene || !directorCaptures.some((capture) => capture.id === directorCaptureId)) throw new Error(t("film.projection.selectDirectorScene"));
      await onBindDirectorScene({ sceneId: scene.id, expectedRevision: scene.revision, captureId: directorCaptureId });
      return;
    }
    const shotId = targetId;
    const shot = status.document.shots.find((item) => item.id === shotId);
    if (!shot || !directorCaptures.some((capture) => capture.id === directorCaptureId) || (targetField !== "storyboard" && targetField !== "first_frame" && targetField !== "last_frame")) throw new Error(t("film.projection.selectDirectorShot"));
    await onAdoptDirector({ shotId, expectedRevision: shot.revision, captureId: directorCaptureId, targetField });
  };
  return <WorkbenchSection id="projection" title={t("film.projection.title")}>
    <div className="flex flex-wrap gap-2">
      <button className="ob-btn ob-btn-primary" disabled={busy} onClick={() => void onRefreshCanvas().catch((cause) => setError(String(cause)))}><RefreshCw size={14} /> {t("film.projection.refreshCanvas")}</button>
      <button className="ob-btn" disabled={busy || !diffs.length} onClick={() => void onCommitCanvas(diffs).catch((cause) => setError(String(cause)))}><Save size={14} /> {t("film.projection.commitCount", { count: diffs.length })}</button>
      <button className="ob-btn" disabled={busy} onClick={() => void refreshFilmProjection(project.id).then(setPlan).catch((cause) => setError(String(cause)))}>{t("film.projection.viewPlan")}</button>
    </div>
    <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("film.projection.hint")}</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <select aria-label={t("film.projection.canvasCandidate")} className="ob-input" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">{t("film.projection.selectCanvasCandidate")}</option>{candidates.map((node) => <option key={node.id} value={node.id}>{node.title} · {node.type}</option>)}</select>
      <select aria-label={t("film.projection.adoptionTarget")} className="ob-input" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">{t("film.projection.selectTarget")}</option>{targets.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
      <button className="ob-btn" disabled={busy || !candidateId || !target} onClick={() => void adopt().catch((cause) => setError(String(cause)))}>{t("film.projection.adoptLineage")}</button>
    </div>
    <div className="mt-4 rounded-xl border border-[var(--ob-line)] p-3">
      <strong className="text-sm">{t("film.projection.directorWorkspace")}</strong>
      <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.projection.directorHint")}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <select aria-label={t("film.projection.directorScene")} className="ob-input" value={status.document.scenes.some((scene) => scene.id === directorSceneId) ? directorSceneId : status.document.scenes[0]?.id ?? ""} onChange={(event) => setDirectorSceneId(event.target.value)}><option value="">{t("film.projection.selectScene")}</option>{status.document.scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.heading}</option>)}</select>
        <button className="ob-btn" disabled={busy || !status.document.scenes.length} onClick={() => onOpenDirector(status.document.scenes.some((scene) => scene.id === directorSceneId) ? directorSceneId : status.document.scenes[0]?.id ?? "")}>{t("film.projection.openDirector")}</button>
      </div>
    </div>
    {directorNodes.length ? <div className="mt-4 rounded-xl border border-[var(--ob-line)] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong className="mr-auto text-sm">{t("film.projection.directorComposition")}</strong><button className="ob-btn" disabled={busy} onClick={() => void loadDirectorCaptures().catch((cause) => setError(String(cause)))}><RefreshCw size={14} /> {t("film.projection.loadCaptures")}</button></div>
      <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.projection.captureHint")}</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <select aria-label={t("film.projection.directorCapture")} className="ob-input" value={directorCaptureId} onChange={(event) => setDirectorCaptureId(event.target.value)}><option value="">{t("film.projection.selectCapture")}</option>{directorCaptures.map((capture) => <option key={capture.id} value={capture.id}>{capture.cameraName} · {capture.width}×{capture.height} · {new Date(capture.createdAt).toLocaleString()}</option>)}</select>
        <select aria-label={t("film.projection.directorTarget")} className="ob-input" value={directorTarget} onChange={(event) => setDirectorTarget(event.target.value)}><option value="">{t("film.projection.selectSceneShot")}</option>{status.document.scenes.map((scene) => <option key={`scene:${scene.id}`} value={`scene:${scene.id}:scene`}>{t("film.projection.officialScene", { title: scene.heading })}</option>)}{status.document.shots.flatMap((shot) => [<option key={`${shot.id}:storyboard`} value={`shot:${shot.id}:storyboard`}>{t("film.projection.target", { title: shot.title, kind: t("film.stage.storyboard") })}</option>, <option key={`${shot.id}:first_frame`} value={`shot:${shot.id}:first_frame`}>{t("film.projection.target", { title: shot.title, kind: t("film.stage.first_frame") })}</option>, <option key={`${shot.id}:last_frame`} value={`shot:${shot.id}:last_frame`}>{t("film.projection.target", { title: shot.title, kind: t("film.projection.lastFrame") })}</option>])}</select>
        <button className="ob-btn" disabled={busy || !directorCaptureId || !directorTarget} onClick={() => void adoptDirector().catch((cause) => setError(String(cause)))}>{t("film.projection.adoptDirector")}</button>
      </div>
    </div> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{error}</p> : null}
    {diffs.length ? <ul className="mt-3 space-y-2">{diffs.map((diff) => <li key={diff.projectionKey} className="rounded-lg border border-[var(--ob-line)] p-2 text-xs"><strong>{diff.projectionKey}</strong><div className="mt-1 grid gap-1 sm:grid-cols-2"><span className="text-[var(--ob-muted)]">{t("film.projection.before", { title: diff.before.title, content: diff.before.content })}</span><span>{t("film.projection.after", { title: diff.after.title, content: diff.after.content })}</span></div></li>)}</ul> : null}
    <div className="mt-3 space-y-2">{plan?.targets.map((target) => <form key={`${target.projectionKey}:${target.revision}`} className="rounded-lg border border-[var(--ob-line)] p-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onStatus(t("film.projection.submit"), () => commitFilmProjection(project.id, { projectionKey: target.projectionKey, expectedRevision: target.revision, fields: { title: String(form.get("title") ?? ""), content: String(form.get("content") ?? "") } })); }}><input name="title" aria-label={t("film.projection.titleLabel", { key: target.projectionKey })} className="ob-input w-full" defaultValue={target.title} /><textarea name="content" aria-label={t("film.projection.contentLabel", { key: target.projectionKey })} className="ob-input mt-1 w-full" defaultValue={target.content} /><button className="ob-btn mt-1"><Save size={14} /> {t("film.projection.submitChanges")}</button></form>)}</div>
  </WorkbenchSection>;
}

export function AgentPanel({ status, onValidate }: { status: FilmStatus; onValidate: () => void }) {
  const { t } = useI18n();
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const approved = status.document.stages.filter((stage) => stage.status === "approved").length;
  const total = status.document.stages.length;
  const issues = status.document.qualityReports.at(-1)?.issues.length ?? 0;
  const nextStage = status.document.stages.find((stage) => stage.status !== "approved");
  const runRead = (tool: FilmAgentReadTool) => {
    setBusy(true); setError("");
    void executeFilmAgentRead(tool, status.document.projectId).then((value) => setResult(JSON.stringify(value, null, 2).slice(0, 4_000))).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
  };
  return <WorkbenchSection id="agent" title={t("film.agent.title")}>
    <div className="grid gap-2 sm:grid-cols-3"><div className="rounded-lg border border-[var(--ob-line)] p-3 text-sm"><strong>{t("film.agent.progress")}</strong><p className="mt-1">{t("film.agent.approved", { approved, total })}</p></div><div className="rounded-lg border border-[var(--ob-line)] p-3 text-sm"><strong>{t("film.agent.blocker")}</strong><p className="mt-1">{nextStage ? `${t(`film.stage.${nextStage.id}`)} · ${nextStage.status}` : t("film.common.none")}</p></div><div className="rounded-lg border border-[var(--ob-line)] p-3 text-sm"><strong>{t("film.agent.issues", { count: issues })}</strong><p className="mt-1">{t(issues ? "film.agent.reviewRepairs" : "film.agent.noIssues")}</p></div></div>
    <div className="mt-3 flex flex-wrap gap-2">{status.capabilities.agentOperations.includes("status") ? <button className="ob-btn" disabled={busy} onClick={() => runRead("film.status")}>{t("film.agent.viewStatus")}</button> : null}{status.capabilities.agentOperations.includes("next_steps") ? <button className="ob-btn" disabled={busy} onClick={() => runRead("film.next_steps")}>{t("film.agent.nextSteps")}</button> : null}{status.capabilities.agentOperations.includes("validate") ? <button className="ob-btn" disabled={busy} onClick={onValidate}>{t("film.agent.validate")}</button> : null}</div>
    <p className="mt-3 text-xs text-[var(--ob-muted)]">{t("film.agent.hint")}</p>
    {result ? <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--ob-surface-2)] p-3 text-xs">{result}</pre> : null}{error ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{error}</p> : null}
  </WorkbenchSection>;
}
