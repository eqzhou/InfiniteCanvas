import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Clapperboard, RefreshCw } from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router";

import { AgentPanel, EpisodesPanel, ProductionPanel, ProjectionPanel } from "@/components/film/ProductionPanels";
import { AIDecompositionPanel, AIScriptPanel, AssetsPanel, ManuscriptPanel } from "@/components/film/ManuscriptAssetsPanels";
import { DeliveryPanel, TimelinePanel } from "@/components/film/TimelineDeliveryPanels";
import { FilmStyleTemplateLibrary } from "@/components/film/FilmStyleTemplateLibrary";
import { AdvancedFilmToolsPanel } from "@/components/film/AdvancedFilmToolsPanel";
import { WorkbenchSection } from "@/components/film/WorkbenchSection";
import { isFilmNavigationAway, resolvePendingFilmResponse, shouldConfirmFilmLeave, type VersionedFilmDraftState } from "@/lib/film-drafts";
import { ensureFilmSceneDirectorNode, refreshFilmProjection as refreshManagedFilmProjection, type FilmProjectionDiff } from "@/lib/film-document";
import { filmImportPollDelay, recoverFilmImportPoll } from "@/lib/film-import-poll";
import { useSharedChannels } from "@/services/shared-channels";
import { applyFilmStyleTemplate, copyFilmStyleTemplateAsProject } from "@/services/film-style-templates";
import { listMediaCapabilities, mediaOptionsForKind, type MediaCapability, type MediaCapabilityCatalog, type MediaKind } from "@/services/media-capabilities";
import { estimateCredits, type CreditEstimate } from "@/services/auth-session";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { useBoardStore } from "@/stores/use-board-store";
import { useI18n } from "@/i18n/I18nProvider";
import type { MessageKey } from "@/i18n/core";
import {
  applyFilmAICandidate,
  applyFilmAIScriptCandidate,
  applyFilmRepair,
  adoptFilmCanvasMedia,
  adoptFilmDirectorCapture,
  bindFilmDirectorScene,
  cancelFilmExport,
  changeFilmStage,
  commitFilmProjection,
  createFilmAsset,
  createFilmDialogue,
  createFilmStageWaiver,
  updateFilmDialogue,
  deleteFilmDialogue,
  createFilmProduction,
  FilmAPIError,
  importFilmManuscript,
  importFilmManuscriptFile,
  loadFilmImportStatus,
  loadFilmStatus,
  preflightFilmManuscript,
  requestFilmAIDecomposition,
  requestFilmAIScript,
  requestFilmExport,
  resolveFilmEntityRevision,
  restoreFilmEntityVersion,
  restoreFilmStructureVersion,
  requestFilmStageRun,
  revokeFilmStageWaiver,
  saveFilmTimeline,
  updateFilmAsset,
  updateFilmEpisode,
  updateFilmShot,
  validateFilm,
  type FilmStageRunRequest,
  type FilmGenerationConfig,
  type FilmStatus,
} from "@/services/film-client";
import type { FilmAsset, FilmAssetKind, FilmDocument, FilmRepairProposal, FilmShot, FilmStageKind, FilmStyleTemplate, FilmTimeline } from "@/types/film";

type RunOptions = { clearManuscript?: boolean; clearTimeline?: boolean; notice?: string };

function repairMediaKind(stage: FilmRepairProposal["regenerationStage"]): MediaKind {
  return stage === "audio" ? "audio" : stage === "video" ? "video" : "image";
}

function repairDefaultConfig(stage: FilmRepairProposal["regenerationStage"], document: FilmDocument, targetId: string, capability: Omit<MediaCapability, "kind">): FilmGenerationConfig {
  if (stage === "audio") return { format: "mp3", speed: 1 };
  if (stage === "video") {
    const configuredDuration = capability.durations[0] ?? Math.max(1, Math.min(15, Math.round(document.shots.find((shot) => shot.id === targetId)?.durationSeconds ?? 4)));
    const configuredRatio = capability.ratios[0] ?? capability.sizes.find((value) => value.includes(":"));
    const configuredResolution = capability.resolutions[0] ?? capability.sizes.find((value) => !value.includes(":"));
    return { seconds: configuredDuration, ...(configuredRatio ? { ratio: configuredRatio } : {}), ...(configuredResolution ? { resolution: configuredResolution } : {}) };
  }
  return { ...(capability.sizes[0] ? { size: capability.sizes[0] } : {}), quality: "standard" };
}

function repairGenerationMode(stage: FilmRepairProposal["regenerationStage"], document: FilmDocument, targetId: string): NonNullable<CreditEstimate["generationMode"]> {
  if (stage === "audio") return "text_to_audio";
  if (stage === "video") return document.shots.find((shot) => shot.id === targetId)?.firstFrameStorageKey ? "image_to_video" : "text_to_video";
  return "text_to_image";
}

function QualityPanel({ document, busy, onValidate, onApply, onRestore }: {
  document: FilmDocument;
  busy: boolean;
  onValidate: () => void;
  onApply: (repair: FilmRepairProposal, generation?: { providerId: string; model: string; config: FilmGenerationConfig; idempotencyKey: string; expectedCredits: number }) => void;
  onRestore: (versionId: string, entityType: string, entityId: string) => void;
}) {
  const { t } = useI18n();
  const report = document.qualityReports.at(-1);
  const [catalog, setCatalog] = useState<MediaCapabilityCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [activeRepairId, setActiveRepairId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [quote, setQuote] = useState<CreditEstimate | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const activeRepair = report?.repairs.find((repair) => repair.id === activeRepairId);
  const generationMode = activeRepair?.regenerationStage ? repairGenerationMode(activeRepair.regenerationStage, document, activeRepair.targetId) : null;
  const options = activeRepair?.regenerationStage ? mediaOptionsForKind(catalog ?? { version: "", models: [] }, repairMediaKind(activeRepair.regenerationStage)).filter((option) => generationMode && option.modes.includes(generationMode)) : [];
  useEffect(() => {
    let active = true;
    void listMediaCapabilities().then((value) => { if (active) { setCatalog(value); setCatalogError(""); } }).catch((cause) => { if (active) setCatalogError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!activeRepair) { setSelectedModel(""); return; }
    if (!options.some((option) => `${option.channelId}:${option.model}` === selectedModel)) setSelectedModel(options[0] ? `${options[0].channelId}:${options[0].model}` : "");
  }, [activeRepairId, catalog?.version]);
  useEffect(() => {
    const selected = options.find((option) => `${option.channelId}:${option.model}` === selectedModel);
    if (!selected || !generationMode) { setQuote(null); return; }
    let active = true;
    setQuote(null); setQuoteError("");
    void estimateCredits(selected.model, 1, { providerId: selected.channelId, kind: repairMediaKind(activeRepair?.regenerationStage), mode: generationMode })
      .then((value) => { if (active) setQuote(value); })
      .catch((cause) => { if (active) setQuoteError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [activeRepairId, selectedModel, catalog?.version]);
  const confirmRepair = (repair: FilmRepairProposal) => {
    if (!repair.regenerationStage || !repair.estimatedGenerations) { onApply(repair); return; }
    const selected = options.find((option) => `${option.channelId}:${option.model}` === selectedModel);
    if (!selected || !quote || quote.totalCredits < 1) return;
    onApply(repair, { providerId: selected.channelId, model: selected.model, config: repairDefaultConfig(repair.regenerationStage, document, repair.targetId, selected), idempotencyKey: `film-repair-${repair.id}-${repair.expectedRevision}`, expectedCredits: quote.totalCredits });
  };
  return <WorkbenchSection id="quality" title={t("film.quality.title")}><button className="ob-btn ob-btn-primary" disabled={busy} onClick={onValidate}>{t("film.quality.run")}</button>{report ? <><p className="mt-3 text-sm">{t("film.quality.summary", { issues: report.issues.length, repairs: report.repairs.length })}</p>{report.repairs.slice(0, 10).map((repair) => { const generative = Boolean(repair.regenerationStage && repair.estimatedGenerations); const expanded = activeRepairId === repair.id; return <div key={repair.id} className="mt-2 rounded-lg border border-[var(--ob-line)] p-3 text-sm"><div className="flex items-center gap-2"><span className="flex-1">{repair.summary}<small className="ml-2 text-[var(--ob-muted)]">{t("film.quality.impact", { targets: repair.affectedTargets?.length ?? 1, generations: repair.estimatedGenerations ?? 0 })}{repair.regenerationStage ? ` · ${repair.regenerationStage}` : ""}</small></span><button className="ob-btn" disabled={busy || Boolean(repair.appliedAt)} onClick={() => generative ? setActiveRepairId(expanded ? "" : repair.id) : confirmRepair(repair)}>{repair.appliedAt ? t("film.quality.applied") : generative ? t("film.quality.configureApprove") : t("film.quality.approveApply")}</button></div>{expanded ? <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"><select aria-label={t("film.quality.repairModel")} className="ob-input" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}><option value="">{catalog ? t("film.quality.noModel") : t("film.quality.loadingCatalog")}</option>{options.map((option) => <option key={`${option.channelId}:${option.model}`} value={`${option.channelId}:${option.model}`}>{option.channelName} · {option.model} · {option.modes.join(" / ")}</option>)}</select><button className="ob-btn ob-btn-primary" disabled={busy || !selectedModel || !quote || quote.totalCredits < 1} onClick={() => confirmRepair(repair)}>{t("film.quality.confirmVersion", { cost: quote ? t("film.quality.credits", { credits: quote.totalCredits }) : t("film.quality.cost") })}</button><p className="text-xs text-[var(--ob-muted)] sm:col-span-2">{t("film.quality.generationHint")}{quoteError || catalogError}</p></div> : null}</div>; })}</> : <p className="mt-2 text-sm text-[var(--ob-muted)]">{t("film.quality.safeHint")}</p>}<div className="mt-4 border-t border-[var(--ob-line)] pt-3"><h3 className="text-sm font-medium">{t("film.quality.restorable")}</h3>{(document.versions ?? []).slice(-10).reverse().map((version) => { const currentRevision = resolveFilmEntityRevision(document, version.entityType, version.entityId); return <div key={version.id} className="mt-2 flex items-center gap-2 text-xs"><span className="mr-auto">{version.entityType}:{version.entityId} · r{version.revision} · {version.reason}</span><button className="ob-btn" disabled={busy || currentRevision === undefined} onClick={() => currentRevision !== undefined && onRestore(version.id, version.entityType, version.entityId)}>{t("film.quality.restore")}</button></div>; })}</div></WorkbenchSection>;
}

function friendlyError(cause: unknown, t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string): string {
  if (cause instanceof FilmAPIError && cause.status === 409) return t("film.error.conflict", { message: cause.message });
  if (cause instanceof FilmAPIError && (cause.code === "pdf_no_text" || cause.code === "source_no_text")) return t("film.error.pdfOcr");
  if (cause instanceof Error && /PDF/i.test(cause.message) && /OCR/i.test(cause.message)) return t("film.error.pdfOcr");
  return cause instanceof Error ? cause.message : String(cause);
}

export function FilmWorkbenchPage() {
  const { t } = useI18n();
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const project = useBoardStore((state) => state.projects.find((candidate) => candidate.id === projectId));
  const config = useBoardStore((state) => state.config);
  const sharedChannels = useSharedChannels();
  const textChannels = useMemo(() => sharedChannels.flatMap((channel) => {
    const defaultModel = channel.defaultTextModel?.trim();
    if (!defaultModel) return [];
    return [{
      id: channel.id,
      name: channel.name,
      models: [...new Set([defaultModel, ...(channel.models ?? []).map((item) => item.trim()).filter(Boolean)])],
    }];
  }), [sharedChannels]);
  const advancedChannels = useMemo(() => sharedChannels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    models: [...new Set([
      channel.defaultTextModel, channel.defaultImageModel, channel.defaultVideoModel, channel.defaultAudioModel,
      ...(channel.models ?? []),
    ].map((item) => item?.trim()).filter((item): item is string => Boolean(item)))],
  })).filter((channel) => channel.models.length > 0), [sharedChannels]);
  const [textChannelId, setTextChannelId] = useState(config.activeSharedChannelId ?? "");
  const [textModel, setTextModel] = useState("");
  const [scriptEpisodeId, setScriptEpisodeId] = useState("");
  const [scriptMode, setScriptMode] = useState<"adaptive" | "literal" | "shooting">("adaptive");
  const [status, setStatus] = useState<FilmStatus | null>(null);
  const [manuscript, setManuscript] = useState("");
  const [manuscriptDirty, setManuscriptDirty] = useState(false);
  const [timelineDirty, setTimelineDirty] = useState(false);
  const [pendingLeaveHref, setPendingLeaveHref] = useState<string | null>(null);
  const [confirmRefreshDrafts, setConfirmRefreshDrafts] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const statusRef = useRef<FilmStatus | null>(null);
  const draftRef = useRef<VersionedFilmDraftState>({ manuscript: "", manuscriptDirty: false, manuscriptVersion: 0, timelineDirty: false, timelineVersion: 0 });
  const document = status?.document;
  const navigation = useMemo(() => [["manuscript", t("film.nav.manuscript")], ["ai-decomposition", t("film.nav.decomposition")], ["ai-script", t("film.nav.script")], ["style-templates", t("film.nav.styles")], ["assets", t("film.nav.assets")], ["advanced-tools", t("film.nav.advanced")], ["episodes", t("film.nav.episodes")], ["tasks", t("film.nav.tasks")], ["projection", t("film.nav.projection")], ["timeline", t("film.nav.timeline")], ["quality", t("film.nav.quality")], ["delivery", t("film.nav.delivery")], ["agent", t("film.nav.agent")]] as const, [t]);

  useEffect(() => {
    const selected = textChannels.find((channel) => channel.id === textChannelId) ?? textChannels[0];
    if (!selected) {
      setTextChannelId("");
      setTextModel("");
      return;
    }
    if (selected.id !== textChannelId) setTextChannelId(selected.id);
    if (!selected.models.includes(textModel)) setTextModel(selected.models[0] ?? "");
  }, [textChannelId, textChannels, textModel]);

  useEffect(() => {
    const episodes = status?.document.episodes ?? [];
    if (!episodes.some((episode) => episode.id === scriptEpisodeId)) setScriptEpisodeId(episodes[0]?.id ?? "");
  }, [scriptEpisodeId, status?.document.episodes]);

  const applyStatus = (next: FilmStatus, options: RunOptions, started = { manuscriptVersion: draftRef.current.manuscriptVersion, timelineVersion: draftRef.current.timelineVersion }) => {
    const current = statusRef.current;
    if (!current) {
      statusRef.current = next; setStatus(next); setManuscript(next.document.source.text); setManuscriptDirty(false); setTimelineDirty(false);
      draftRef.current = { manuscript: next.document.source.text, manuscriptDirty: false, manuscriptVersion: 0, timelineDirty: false, timelineVersion: 0 };
      return;
    }
    const resolved = resolvePendingFilmResponse(current, next, draftRef.current, started, options);
    statusRef.current = resolved.status;
    draftRef.current = { ...draftRef.current, manuscript: resolved.manuscript, manuscriptDirty: resolved.manuscriptDirty, timelineDirty: resolved.timelineDirty };
    setStatus(resolved.status); setManuscript(resolved.manuscript); setManuscriptDirty(resolved.manuscriptDirty); setTimelineDirty(resolved.timelineDirty);
  };

  const run = async (label: string, operation: () => Promise<FilmStatus>, options: RunOptions = {}): Promise<boolean> => {
    const started = { manuscriptVersion: draftRef.current.manuscriptVersion, timelineVersion: draftRef.current.timelineVersion };
    setBusy(label); setError(null); setNotice(null);
    try { applyStatus(await operation(), options, started); setNotice(options.notice ?? t("film.actionSucceeded", { action: label })); return true; }
    catch (cause) { setError(friendlyError(cause, t)); return false; }
    finally { setBusy(null); }
  };

  const executeRefresh = async () => {
    setConfirmRefreshDrafts(false);
    await run(t("film.refresh"), () => loadFilmStatus(projectId), { notice: t("film.refreshedDrafts") });
  };

  const refresh = async () => {
    if (shouldConfirmFilmLeave(manuscriptDirty, timelineDirty)) {
      setConfirmRefreshDrafts(true);
      return;
    }
    await executeRefresh();
  };

  useEffect(() => {
    let active = true; setBusy(t("film.loading"));
    loadFilmStatus(projectId).catch((cause) => cause instanceof FilmAPIError && cause.status === 404 ? createFilmProduction(projectId) : Promise.reject(cause)).then((next) => { if (active) applyStatus(next, {}); }).catch((cause) => { if (active) setError(friendlyError(cause, t)); }).finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    const importStatus = status?.document.source.importStatus;
    if (!importStatus || importStatus.status !== "running") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failedAttempts = 0;
    const poll = async () => {
      try {
        const latest = await loadFilmImportStatus(projectId);
        if (!active) return;
        const recovered = recoverFilmImportPoll(failedAttempts);
        failedAttempts = recovered.failedAttempts;
        if (recovered.clearError) setError(null);
        if (latest.status !== "running") {
          applyStatus(await loadFilmStatus(projectId), {});
          return;
        }
      } catch (cause) {
        if (!active) return;
        setError(friendlyError(cause, t));
        const delay = filmImportPollDelay(failedAttempts, cause);
        failedAttempts++;
        if (delay !== null) timer = setTimeout(() => void poll(), delay);
        return;
      }
      if (active) timer = setTimeout(() => void poll(), 1_000);
    };
    timer = setTimeout(() => void poll(), 250);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [projectId, status?.document.source.importStatus?.id, status?.document.source.importStatus?.status]);

  useEffect(() => {
    if (!shouldConfirmFilmLeave(manuscriptDirty, timelineDirty)) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const navigate = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (target && isFilmNavigationAway(location.href, target.href)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPendingLeaveHref(target.href);
      }
    };
    window.addEventListener("beforeunload", warn);
    globalThis.document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      globalThis.document.removeEventListener("click", navigate, true);
    };
  }, [manuscriptDirty, timelineDirty]);

  if (!project || project.projectKind !== "film") return <Navigate to="/" replace />;

  const persistProjection = async (nextStatus: FilmStatus) => {
    const board = useBoardStore.getState();
    const current = board.projects.find((candidate) => candidate.id === projectId);
    if (!current) throw new Error(t("film.canvasMissing"));
    board.replaceProjectFromAgent({
      ...refreshManagedFilmProjection(current, nextStatus.document),
      updatedAt: new Date().toISOString(),
    });
    await board.persistNow();
  };

  const refreshCanvasProjection = async () => {
    setBusy(t("film.refresh")); setError(null); setNotice(null);
    try {
      const next = await loadFilmStatus(projectId);
      applyStatus(next, {});
      await persistProjection(next);
      setNotice(t("film.projectionRefreshed"));
    } catch (cause) { setError(friendlyError(cause, t)); throw cause; }
    finally { setBusy(null); }
  };

  const commitCanvasProjection = async (diffs: FilmProjectionDiff[]) => {
    setBusy(t("film.nav.projection")); setError(null); setNotice(null);
    try {
      let next = statusRef.current!;
      for (const diff of diffs) {
        next = await commitFilmProjection(projectId, {
          projectionKey: diff.projectionKey,
          expectedRevision: diff.expectedRevision,
          fields: { title: diff.after.title, content: diff.after.content },
        });
      }
      applyStatus(next, {});
      await persistProjection(next);
      setNotice(t("film.projectionCommitted", { count: diffs.length }));
    } catch (cause) { setError(friendlyError(cause, t)); throw cause; }
    finally { setBusy(null); }
  };

  const setDraft = (text: string) => { draftRef.current = { ...draftRef.current, manuscript: text, manuscriptDirty: true, manuscriptVersion: draftRef.current.manuscriptVersion + 1 }; setManuscript(text); setManuscriptDirty(true); };
  const updateTimeline = (timeline: FilmTimeline) => { const current = statusRef.current; if (!current) return; const next = { ...current, document: { ...current.document, timeline } }; statusRef.current = next; setStatus(next); draftRef.current = { ...draftRef.current, timelineDirty: true, timelineVersion: draftRef.current.timelineVersion + 1 }; setTimelineDirty(true); };
  const openSceneDirector = (sceneId: string) => {
    const scene = statusRef.current?.document.scenes.find((item) => item.id === sceneId);
    if (!scene || !project) return;
    const store = useBoardStore.getState();
    store.setActiveProject(project.id);
    let nodeId = "";
    let position = { x: 0, y: 0 };
    store.updateActive((current) => {
      const result = ensureFilmSceneDirectorNode(current, scene);
      const node = result.project.nodes.find((item) => item.id === result.nodeId);
      nodeId = result.nodeId;
      position = node?.position ?? position;
      return result.project;
    });
    if (!nodeId) return;
    store.setSelected([nodeId]);
    store.setViewport({ x: 180 - position.x * 0.8, y: 140 - position.y * 0.8, k: 0.8 }, false);
    navigate("/");
  };

  const copyStyleTemplate = async (template: FilmStyleTemplate) => {
    setBusy(t("film.styles.copy")); setError(null); setNotice(null);
    const store = useBoardStore.getState();
    try {
      const copiedProjectId = await copyFilmStyleTemplateAsProject(template.id, {
        createProject: (title, kind) => useBoardStore.getState().createProject(title, kind),
        persistProjects: () => useBoardStore.getState().persistNow(),
        removeProject: (targetProjectId) => useBoardStore.getState().deleteProjectsDurably([targetProjectId]),
      });
      store.setActiveProject(copiedProjectId);
      navigate(`/film/${copiedProjectId}`);
    } catch (cause) { setError(friendlyError(cause, t)); }
    finally { setBusy(null); }
  };

  return <div className="h-full overflow-auto bg-[var(--ob-canvas)]" data-testid="film-workbench">
    <header className="sticky top-0 z-20 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 py-3 backdrop-blur-md"><div className="mx-auto flex max-w-7xl items-center gap-3"><Link to="/" className="ob-btn">{t("film.backCanvas")}</Link><Clapperboard size={20} className="text-[var(--ob-accent)]" /><div className="min-w-0 flex-1"><h1 className="truncate font-semibold">{project.title}</h1><p className="text-xs text-[var(--ob-muted)]">{t("film.modeRevision", { revision: document?.revision ?? "—" })}</p></div><button className="ob-btn" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} /> {t("film.refresh")}</button></div><nav aria-label={t("film.sections")} className="mx-auto mt-3 flex max-w-7xl gap-1 overflow-x-auto">{navigation.map(([id, label]) => <a key={id} href={`#${id}`} className="ob-tab shrink-0 text-xs">{label}</a>)}</nav></header>
    <main className="mx-auto grid max-w-7xl gap-4 p-4 pb-16 lg:grid-cols-2">{error ? <div role="alert" className="ob-banner lg:col-span-2" data-tone="danger"><AlertCircle size={16} />{error}</div> : null}{notice ? <div role="status" className="ob-banner lg:col-span-2" data-tone="success"><Check size={16} />{notice}</div> : null}
      {!status || !document ? <div role="status" className="ob-card p-8 lg:col-span-2">{t("film.loading")}</div> : <>
        <ManuscriptPanel document={document} capabilities={status.capabilities} manuscript={manuscript} busy={!!busy} onDraft={setDraft} onPreflight={(text, format) => preflightFilmManuscript(projectId, { text, format })} onImportText={(text, format, originalName) => run(t("film.action.import"), () => importFilmManuscript(projectId, { revision: document.source.revision, text, format, originalName }), { clearManuscript: true, notice: t("film.notice.imported") })} onImportFile={(file, format) => run(t("film.action.parse"), () => importFilmManuscriptFile(projectId, { revision: document.source.revision, file, format }), { clearManuscript: true, notice: t("film.notice.parsed") })} />
        <AIDecompositionPanel document={document} busy={!!busy} channels={textChannels} channelId={textChannelId} model={textModel} onChannel={(channelId) => {
          setTextChannelId(channelId);
          setTextModel(textChannels.find((channel) => channel.id === channelId)?.models[0] ?? "");
        }} onModel={setTextModel} onRun={() => {
          const stage = document.stages.find((item) => item.id === "decompose");
          if (!stage) return;
          const idempotencyKey = `film-decompose-${document.source.revision}-${Date.now().toString(36)}`;
          void run(t("film.action.decompose"), () => requestFilmAIDecomposition(projectId, {
            revision: stage.revision,
            providerId: textChannelId,
            model: textModel,
            idempotencyKey,
          }), { notice: t("film.notice.decomposeQueued") });
        }} onApply={(candidateId) => {
          const candidate = document.aiCandidates?.find((item) => item.id === candidateId);
          if (!candidate) return;
          void run(t("film.action.applyDecomposition"), () => applyFilmAICandidate(projectId, candidateId, candidate.revision), { notice: t("film.notice.decompositionApplied") });
        }} onRestoreStructure={(versionId) => void run(t("film.action.restoreStructure"), () => restoreFilmStructureVersion(projectId, versionId, document.revision), { notice: t("film.notice.structureRestored") })} />
        <AIScriptPanel document={document} busy={!!busy} channels={textChannels} channelId={textChannelId} model={textModel} episodeId={scriptEpisodeId} scriptMode={scriptMode} onChannel={(channelId) => {
          setTextChannelId(channelId);
          setTextModel(textChannels.find((channel) => channel.id === channelId)?.models[0] ?? "");
        }} onModel={setTextModel} onEpisode={setScriptEpisodeId} onScriptMode={setScriptMode} onRun={() => {
          const stage = document.stages.find((item) => item.id === "script");
          if (!stage || !scriptEpisodeId) return;
          const idempotencyKey = `film-script-${document.source.revision}-${Date.now().toString(36)}`;
          void run(t("film.action.script"), () => requestFilmAIScript(projectId, {
            revision: stage.revision,
            episodeId: scriptEpisodeId,
            scriptMode,
            providerId: textChannelId,
            model: textModel,
            idempotencyKey,
          }), { notice: t("film.notice.scriptQueued") });
        }} onApply={(candidateId) => {
          const candidate = document.scriptCandidates?.find((item) => item.id === candidateId);
          if (!candidate) return;
          void run(t("film.action.applyScript"), () => applyFilmAIScriptCandidate(projectId, candidateId, candidate.revision), { notice: t("film.notice.scriptApplied") });
        }} />
        <FilmStyleTemplateLibrary busy={!!busy} onApply={(template) => void run(t("film.action.applyStyle"), () => applyFilmStyleTemplate(projectId, template.id), { notice: t("film.notice.styleApplied", { title: template.title }) })} onCopy={(template) => void copyStyleTemplate(template)} />
        <AssetsPanel status={status} busy={!!busy} onCreate={(input) => void run(t("film.action.createAsset"), () => createFilmAsset(projectId, input))} onSave={(asset: FilmAsset, patch) => void run(t("film.action.saveAsset"), () => updateFilmAsset(projectId, asset.id, { revision: asset.revision, kind: patch.kind as FilmAssetKind | undefined, title: patch.title, description: patch.description, parentAssetId: patch.parentAssetId, voice: patch.voice, stylePrompt: patch.stylePrompt, aspectRatio: patch.aspectRatio, ageStage: patch.ageStage, costume: patch.costume, storyPeriod: patch.storyPeriod, isDefault: patch.isDefault, episodeIds: patch.episodeIds, sceneIds: patch.sceneIds, shotIds: patch.shotIds }))} />
        <AdvancedFilmToolsPanel status={status} channels={advancedChannels} onFilmStatus={(next) => applyStatus(next, {})} />
        <EpisodesPanel status={status} busy={!!busy} onSaveEpisode={(id, revision, title) => void run(t("film.action.saveEpisode"), () => updateFilmEpisode(projectId, id, { revision, title }))} onSaveShot={(shot: FilmShot, patch) => void run(t("film.action.saveShot"), () => updateFilmShot(projectId, shot.id, { revision: shot.revision, description: patch.description, durationSeconds: patch.durationSeconds, styleAssetId: patch.styleAssetId, identityVersionIds: patch.identityVersionIds }))} onCreateDialogue={(shotId, kind, text) => void run(t("film.action.createDialogue"), () => createFilmDialogue(projectId, { shotId, kind, text }))} onSaveDialogue={(dialogue, patch) => void run(t("film.action.saveDialogue"), () => updateFilmDialogue(projectId, dialogue.id, { revision: dialogue.revision, kind: patch.kind, emotion: patch.emotion, text: patch.text, characterAssetId: patch.characterAssetId, voiceAssetId: patch.voiceAssetId }))} onDeleteDialogue={(dialogue) => void run(t("film.action.deleteDialogue"), () => deleteFilmDialogue(projectId, dialogue.id, dialogue.revision))} />
        <ProductionPanel status={status} busy={!!busy} onLegacyStage={(stage, action) => void run(action === "run" ? t("film.action.submitReview") : action === "approve" ? t("film.action.approveStage") : t("film.action.rejectStage"), () => changeFilmStage(projectId, stage.id, action, stage.revision), { notice: action === "run" ? t("film.notice.submittedReview") : undefined })} onRun={(stage: FilmStageKind, request: FilmStageRunRequest) => run(t("film.action.startGeneration"), () => requestFilmStageRun(projectId, stage, request), { notice: t("film.notice.generationQueued") })} onSynced={(next) => applyStatus(next, {})} onWaive={(stage, reason) => void run(t("film.action.createWaiver"), () => createFilmStageWaiver(projectId, stage.id, { revision: document.revision, stageRevision: stage.revision, reason, riskAccepted: true }), { notice: t("film.notice.waiverCreated") })} onRevokeWaiver={(waiverId, waiverRevision) => void run(t("film.action.revokeWaiver"), () => revokeFilmStageWaiver(projectId, waiverId, { revision: document.revision, waiverRevision }), { notice: t("film.notice.waiverRevoked") })} />
        <ProjectionPanel project={project} status={status} busy={!!busy} onStatus={(label, operation) => void run(label, operation)} onRefreshCanvas={refreshCanvasProjection} onCommitCanvas={commitCanvasProjection} onAdopt={async (input) => { const ok = await run(t("film.action.adoptCanvas"), () => adoptFilmCanvasMedia(projectId, input), { notice: t("film.notice.canvasAdopted") }); if (ok && statusRef.current) await persistProjection(statusRef.current); }} onAdoptDirector={async (input) => { const ok = await run(t("film.action.adoptDirector"), () => adoptFilmDirectorCapture(projectId, input), { notice: t("film.notice.directorAdopted") }); if (ok && statusRef.current) await persistProjection(statusRef.current); }} onBindDirectorScene={async (input) => { const ok = await run(t("film.action.bindDirector"), () => bindFilmDirectorScene(projectId, input), { notice: t("film.notice.directorBound") }); if (ok && statusRef.current) await persistProjection(statusRef.current); }} onOpenDirector={openSceneDirector} />
        <TimelinePanel timeline={document.timeline} mediaSources={[...document.shots.filter((shot) => shot.videoStorageKey || shot.audioStorageKey).map((shot) => ({ value: `shot:${shot.id}`, label: `${shot.title} (${t("film.shotMedia")})` })), ...document.assets.filter((asset) => asset.mediaStorageKey).map((asset) => ({ value: asset.mediaStorageKey!, label: `${asset.title} (${asset.kind})` }))]} dirty={timelineDirty} busy={!!busy} onChange={updateTimeline} onSave={() => void run(t("film.action.saveTimeline"), () => saveFilmTimeline(projectId, document.timeline), { clearTimeline: true, notice: t("film.notice.timelineSaved") })} />
        <QualityPanel document={document} busy={!!busy} onValidate={() => void run(t("film.action.validate"), () => validateFilm(projectId))} onApply={(repair, generation) => void run(t("film.action.applyRepair"), () => applyFilmRepair(projectId, repair.id, repair.expectedRevision, generation))} onRestore={(versionId, entityType, entityId) => { const currentRevision = resolveFilmEntityRevision(document, entityType, entityId); if (currentRevision !== undefined) void run(t("film.action.restoreVersion"), () => restoreFilmEntityVersion(projectId, versionId, currentRevision)); }} />
        <DeliveryPanel status={status} busy={!!busy} onExport={(kind) => void run(t("film.action.export"), () => requestFilmExport(projectId, kind, document.revision), { notice: t("film.notice.exportRequested") })} onCancel={(jobId) => void run(t("film.action.cancelExport"), () => cancelFilmExport(projectId, jobId), { notice: t("film.notice.exportCanceled") })} onRefresh={() => void refresh()} />
        <AgentPanel status={status} onValidate={() => void run(t("film.action.agentValidate"), () => validateFilm(projectId))} />
      </>}
    </main>
    {confirmRefreshDrafts ? (
      <ConfirmDialog
        title={t("film.confirm.refreshDrafts")}
        confirmLabel={t("common.confirm")}
        tone="danger"
        onCancel={() => setConfirmRefreshDrafts(false)}
        onConfirm={() => void executeRefresh()}
      />
    ) : null}
    {pendingLeaveHref ? (
      <ConfirmDialog
        title={t("film.confirm.leave")}
        message={t("film.confirm.refreshDrafts")}
        confirmLabel={t("common.confirm")}
        tone="danger"
        onCancel={() => setPendingLeaveHref(null)}
        onConfirm={() => {
          const href = pendingLeaveHref;
          setPendingLeaveHref(null);
          window.location.href = href;
        }}
      />
    ) : null}
  </div>;
}
