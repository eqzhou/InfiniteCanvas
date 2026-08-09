import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Clapperboard, RefreshCw } from "lucide-react";
import { Link, Navigate, useParams } from "react-router";

import { AgentPanel, EpisodesPanel, ProductionPanel, ProjectionPanel } from "@/components/film/ProductionPanels";
import { AssetsPanel, ManuscriptPanel } from "@/components/film/ManuscriptAssetsPanels";
import { DeliveryPanel, TimelinePanel } from "@/components/film/TimelineDeliveryPanels";
import { WorkbenchSection } from "@/components/film/WorkbenchSection";
import { isFilmNavigationAway, resolvePendingFilmResponse, shouldConfirmFilmLeave, type VersionedFilmDraftState } from "@/lib/film-drafts";
import { useBoardStore } from "@/stores/use-board-store";
import {
  applyFilmRepair,
  changeFilmStage,
  createFilmAsset,
  createFilmProduction,
  FilmAPIError,
  importFilmManuscript,
  importFilmManuscriptFile,
  loadFilmStatus,
  requestFilmExport,
  requestFilmStageRun,
  saveFilmTimeline,
  updateFilmAsset,
  updateFilmEpisode,
  updateFilmShot,
  validateFilm,
  type FilmStageRunRequest,
  type FilmStatus,
} from "@/services/film-client";
import type { FilmAsset, FilmAssetKind, FilmShot, FilmStageKind, FilmTimeline } from "@/types/film";

type RunOptions = { clearManuscript?: boolean; clearTimeline?: boolean; notice?: string };

function friendlyError(cause: unknown): string {
  if (cause instanceof FilmAPIError && cause.status === 409) return `修订冲突：${cause.message}。请刷新后重新应用本地修改。`;
  if (cause instanceof FilmAPIError && (cause.code === "pdf_no_text" || cause.code === "source_no_text")) return "PDF 未提取到文本，请先 OCR 后再导入。";
  if (cause instanceof Error && /PDF/i.test(cause.message) && /OCR/i.test(cause.message)) return "PDF 未提取到文本，请先 OCR 后再导入。";
  return cause instanceof Error ? cause.message : String(cause);
}

export function FilmWorkbenchPage() {
  const { projectId = "" } = useParams();
  const project = useBoardStore((state) => state.projects.find((candidate) => candidate.id === projectId));
  const [status, setStatus] = useState<FilmStatus | null>(null);
  const [manuscript, setManuscript] = useState("");
  const [manuscriptDirty, setManuscriptDirty] = useState(false);
  const [timelineDirty, setTimelineDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const statusRef = useRef<FilmStatus | null>(null);
  const draftRef = useRef<VersionedFilmDraftState>({ manuscript: "", manuscriptDirty: false, manuscriptVersion: 0, timelineDirty: false, timelineVersion: 0 });
  const document = status?.document;
  const latestReport = document?.qualityReports.at(-1);
  const navigation = useMemo(() => [["manuscript", "原稿"], ["assets", "资产"], ["episodes", "镜头"], ["tasks", "任务"], ["projection", "投影"], ["timeline", "时间线"], ["quality", "质量"], ["delivery", "交付"], ["agent", "Agent"]] as const, []);

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
    try { applyStatus(await operation(), options, started); setNotice(options.notice ?? `${label}成功`); return true; }
    catch (cause) { setError(friendlyError(cause)); return false; }
    finally { setBusy(null); }
  };

  const refresh = async () => {
    if (shouldConfirmFilmLeave(manuscriptDirty, timelineDirty) && !confirm("存在未保存的原稿或时间线编辑。刷新时保留本地草稿，继续吗？")) return;
    await run("刷新", () => loadFilmStatus(projectId), { notice: "已刷新，未保存草稿保持不变" });
  };

  useEffect(() => {
    let active = true; setBusy("加载");
    loadFilmStatus(projectId).catch((cause) => cause instanceof FilmAPIError && cause.status === 404 ? createFilmProduction(projectId) : Promise.reject(cause)).then((next) => { if (active) applyStatus(next, {}); }).catch((cause) => { if (active) setError(friendlyError(cause)); }).finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!shouldConfirmFilmLeave(manuscriptDirty, timelineDirty)) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const navigate = (event: MouseEvent) => { const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null; if (target && isFilmNavigationAway(location.href, target.href) && !confirm("存在未保存修改，确定离开吗？")) { event.preventDefault(); event.stopImmediatePropagation(); } };
    window.addEventListener("beforeunload", warn); globalThis.document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", warn); globalThis.document.removeEventListener("click", navigate, true); };
  }, [manuscriptDirty, timelineDirty]);

  if (!project || project.projectKind !== "film") return <Navigate to="/" replace />;

  const setDraft = (text: string) => { draftRef.current = { ...draftRef.current, manuscript: text, manuscriptDirty: true, manuscriptVersion: draftRef.current.manuscriptVersion + 1 }; setManuscript(text); setManuscriptDirty(true); };
  const updateTimeline = (timeline: FilmTimeline) => { const current = statusRef.current; if (!current) return; const next = { ...current, document: { ...current.document, timeline } }; statusRef.current = next; setStatus(next); draftRef.current = { ...draftRef.current, timelineDirty: true, timelineVersion: draftRef.current.timelineVersion + 1 }; setTimelineDirty(true); };

  return <div className="h-full overflow-auto bg-[var(--ob-canvas)]" data-testid="film-workbench">
    <header className="sticky top-0 z-20 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 py-3 backdrop-blur-md"><div className="mx-auto flex max-w-7xl items-center gap-3"><Link to="/" className="ob-btn">返回画布</Link><Clapperboard size={20} className="text-[var(--ob-accent)]" /><div className="min-w-0 flex-1"><h1 className="truncate font-semibold">{project.title}</h1><p className="text-xs text-[var(--ob-muted)]">Film Production Mode · 修订 {document?.revision ?? "—"}</p></div><button className="ob-btn" disabled={!!busy} onClick={() => void refresh()}><RefreshCw size={14} /> 刷新</button></div><nav aria-label="影片工作台分区" className="mx-auto mt-3 flex max-w-7xl gap-1 overflow-x-auto">{navigation.map(([id, label]) => <a key={id} href={`#${id}`} className="ob-tab shrink-0 text-xs">{label}</a>)}</nav></header>
    <main className="mx-auto grid max-w-7xl gap-4 p-4 pb-16 lg:grid-cols-2">{error ? <div role="alert" className="ob-banner lg:col-span-2" data-tone="danger"><AlertCircle size={16} />{error}</div> : null}{notice ? <div role="status" className="ob-banner lg:col-span-2" data-tone="success"><Check size={16} />{notice}</div> : null}
      {!status || !document ? <div role="status" className="ob-card p-8 lg:col-span-2">正在加载影片制作数据…</div> : <>
        <ManuscriptPanel document={document} capabilities={status.capabilities} manuscript={manuscript} busy={!!busy} onDraft={setDraft} onImportText={(text, format, originalName) => run("导入原稿", () => importFilmManuscript(projectId, { revision: document.source.revision, text, format, originalName }), { clearManuscript: true, notice: "原稿已导入，拆解产物等待审核" })} onImportFile={(file, format) => run("解析原稿", () => importFilmManuscriptFile(projectId, { revision: document.source.revision, file, format }), { clearManuscript: true, notice: "文件解析完成，拆解产物等待审核" })} />
        <AssetsPanel status={status} busy={!!busy} onCreate={(input) => void run("创建资产", () => createFilmAsset(projectId, input))} onSave={(asset: FilmAsset, patch) => void run("保存资产", () => updateFilmAsset(projectId, asset.id, { revision: asset.revision, kind: patch.kind as FilmAssetKind | undefined, title: patch.title, description: patch.description, parentAssetId: patch.parentAssetId, voice: patch.voice, stylePrompt: patch.stylePrompt, aspectRatio: patch.aspectRatio }))} />
        <EpisodesPanel status={status} busy={!!busy} onSaveEpisode={(id, revision, title) => void run("保存集", () => updateFilmEpisode(projectId, id, { revision, title }))} onSaveShot={(shot: FilmShot, patch) => void run("保存镜头", () => updateFilmShot(projectId, shot.id, { revision: shot.revision, description: patch.description, durationSeconds: patch.durationSeconds, styleAssetId: patch.styleAssetId, identityVersionIds: patch.identityVersionIds }))} />
        <ProductionPanel status={status} busy={!!busy} onLegacyStage={(stage, action) => void run(action === "run" ? "提交审核" : action === "approve" ? "批准阶段" : "退回阶段", () => changeFilmStage(projectId, stage.id, action, stage.revision), { notice: action === "run" ? "产物已提交审核；这不代表生成完成" : undefined })} onRun={(stage: FilmStageKind, request: FilmStageRunRequest) => run("开始生成", () => requestFilmStageRun(projectId, stage, request), { notice: "生成任务已入队，请以 GenerationJob 状态为准" })} onSynced={(next) => applyStatus(next, {})} />
        <ProjectionPanel projectId={projectId} busy={!!busy} onStatus={(label, operation) => void run(label, operation)} />
        <TimelinePanel timeline={document.timeline} dirty={timelineDirty} busy={!!busy} onChange={updateTimeline} onSave={() => void run("保存时间线", () => saveFilmTimeline(projectId, document.timeline), { clearTimeline: true, notice: "时间线已保存" })} />
        <WorkbenchSection id="quality" title="质量检查 / Quality"><button className="ob-btn ob-btn-primary" onClick={() => void run("质量检查", () => validateFilm(projectId))}>运行检查</button>{latestReport ? <><p className="mt-3 text-sm">{latestReport.issues.length} 个问题，{latestReport.repairs.length} 个修复建议</p>{latestReport.repairs.slice(0, 10).map((repair) => <div key={repair.id} className="mt-2 flex items-center gap-2 text-sm"><span className="flex-1">{repair.summary}</span><button className="ob-btn" onClick={() => void run("批准并应用修复", () => applyFilmRepair(projectId, repair.id, repair.expectedRevision))}>批准并应用</button></div>)}</> : <p className="mt-2 text-sm text-[var(--ob-muted)]">检查不自动修改制作数据。</p>}</WorkbenchSection>
        <DeliveryPanel status={status} busy={!!busy} onExport={(kind) => void run("请求导出", () => requestFilmExport(projectId, kind, document.revision), { notice: "导出请求已提交，请刷新查看异步状态" })} onRefresh={() => void refresh()} />
        <AgentPanel status={status} onValidate={() => void run("Agent 质量检查", () => validateFilm(projectId))} />
      </>}
    </main>
  </div>;
}
