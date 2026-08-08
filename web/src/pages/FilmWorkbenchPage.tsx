import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router";
import { AlertCircle, Check, Clapperboard, FileUp, Plus, RefreshCw, Save, Send } from "lucide-react";

import { useBoardStore } from "@/stores/use-board-store";
import type { FilmTimeline } from "@/types/film";
import {
  applyFilmRepair,
  changeFilmStage,
  createFilmAsset,
  createFilmScene,
  createFilmProduction,
  deleteFilmScene,
  filmDeliverableDownloadURL,
  importFilmManuscript,
  loadFilmStatus,
  requestFilmExport,
  saveFilmTimeline,
  updateFilmEpisode,
  updateFilmScene,
  updateFilmShot,
  validateFilm,
  type FilmStatus,
  FilmAPIError,
} from "@/services/film-client";
import {
  filmEditorKey,
  isFilmNavigationAway,
  resolvePendingFilmResponse,
  shouldConfirmFilmLeave,
  type VersionedFilmDraftState,
} from "@/lib/film-drafts";

const stageLabels: Record<string, string> = {
  decompose: "拆解", script: "剧本", storyboard: "分镜", audio: "声音",
  video: "画面", compose: "合成", delivery: "交付",
};

function WorkbenchSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} data-testid={`film-section-${id}`} className="ob-card scroll-mt-5 p-4 sm:p-5">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
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
  const [assetTitle, setAssetTitle] = useState("");
  const [assetKind, setAssetKind] = useState<"character" | "location" | "prop" | "style" | "voice">("character");
  const [exportKind, setExportKind] = useState<"manifest" | "srt">("manifest");
  const fileRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<FilmStatus | null>(null);
  const draftRef = useRef<VersionedFilmDraftState>({
    manuscript: "", manuscriptDirty: false, manuscriptVersion: 0,
    timelineDirty: false, timelineVersion: 0,
  });

  const document = status?.document;
  const latestReport = document?.qualityReports.at(-1);
  const navigation = useMemo(() => [
    ["manuscript", "剧本"], ["assets", "资产"], ["episodes", "集与镜头"],
    ["tasks", "任务"], ["style", "风格"], ["quality", "质量"],
    ["timeline", "时间线"], ["delivery", "交付"],
  ] as const, []);

  const run = async (
    label: string,
    operation: () => Promise<FilmStatus>,
    options: { clearManuscript?: boolean; clearTimeline?: boolean; notice?: string } = {},
  ) => {
    const started = {
      manuscriptVersion: draftRef.current.manuscriptVersion,
      timelineVersion: draftRef.current.timelineVersion,
    };
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const next = await operation();
      const current = statusRef.current;
      if (current) {
        const resolved = resolvePendingFilmResponse(
          current, next, draftRef.current, started, options,
        );
        statusRef.current = resolved.status;
        draftRef.current = {
          ...draftRef.current,
          manuscript: resolved.manuscript,
          manuscriptDirty: resolved.manuscriptDirty,
          timelineDirty: resolved.timelineDirty,
        };
        setStatus(resolved.status);
        setManuscript(resolved.manuscript);
        setManuscriptDirty(resolved.manuscriptDirty);
        setTimelineDirty(resolved.timelineDirty);
      } else {
        statusRef.current = next;
        draftRef.current = {
          manuscript: next.document.source.text,
          manuscriptDirty: false,
          manuscriptVersion: draftRef.current.manuscriptVersion,
          timelineDirty: false,
          timelineVersion: draftRef.current.timelineVersion,
        };
        setStatus(next);
        setManuscript(next.document.source.text);
        setManuscriptDirty(false);
        setTimelineDirty(false);
      }
      setNotice(options.notice ?? `${label}成功`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (shouldConfirmFilmLeave(manuscriptDirty, timelineDirty) && !confirm("存在未保存的剧本或时间线编辑。刷新时保留本地草稿，继续吗？")) return;
    await run("刷新", () => loadFilmStatus(projectId), { notice: "已刷新，未保存草稿保持不变" });
  };

  useEffect(() => {
    let active = true;
    setBusy("加载");
    loadFilmStatus(projectId).catch((cause) => {
      if (cause instanceof FilmAPIError && cause.status === 404) return createFilmProduction(projectId);
      throw cause;
    }).then((next) => {
      if (!active) return;
      statusRef.current = next;
      draftRef.current = {
        manuscript: next.document.source.text,
        manuscriptDirty: false,
        manuscriptVersion: 0,
        timelineDirty: false,
        timelineVersion: 0,
      };
      setStatus(next);
      setManuscript(next.document.source.text);
      setManuscriptDirty(false);
      setTimelineDirty(false);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setBusy(null);
    });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    if (!shouldConfirmFilmLeave(manuscriptDirty, timelineDirty)) return;
    let restoringHistory = false;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const interceptNavigation = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || !isFilmNavigationAway(window.location.href, target.href)) return;
      if (!confirm("存在未保存的剧本或时间线编辑，确定离开吗？")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const interceptHistory = () => {
      if (restoringHistory) {
        restoringHistory = false;
        return;
      }
      if (!confirm("存在未保存的剧本或时间线编辑，确定离开吗？")) {
        restoringHistory = true;
        window.history.go(1);
      }
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("popstate", interceptHistory);
    globalThis.document.addEventListener("click", interceptNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("popstate", interceptHistory);
      globalThis.document.removeEventListener("click", interceptNavigation, true);
    };
  }, [manuscriptDirty, timelineDirty]);

  if (!project) return <Navigate to="/" replace />;
  if (project.projectKind !== "film") return <Navigate to="/" replace />;

  const updateTimeline = (mutate: (timeline: FilmTimeline) => FilmTimeline) => {
    const current = statusRef.current;
    if (!current) return;
    const next = {
      ...current,
      document: { ...current.document, timeline: mutate(current.document.timeline) },
    };
    statusRef.current = next;
    draftRef.current = {
      ...draftRef.current,
      timelineDirty: true,
      timelineVersion: draftRef.current.timelineVersion + 1,
    };
    setStatus(next);
    setTimelineDirty(true);
  };

  return (
    <div className="h-full overflow-auto bg-[var(--ob-canvas)]" data-testid="film-workbench">
      <header className="sticky top-0 z-20 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3">
          <Link to="/" className="ob-btn">返回画布</Link>
          <Clapperboard size={20} className="text-[var(--ob-accent)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold">{project.title}</h1>
            <p className="text-xs text-[var(--ob-muted)]">Film Production Mode · 修订 {document?.revision ?? "—"}</p>
          </div>
          <button type="button" className="ob-btn" disabled={busy !== null} onClick={() => void refresh()}>
            <RefreshCw size={14} aria-hidden /> 刷新
          </button>
        </div>
        <nav aria-label="影片工作台分区" className="mx-auto mt-3 flex max-w-7xl gap-1 overflow-x-auto pb-1">
          {navigation.map(([id, label]) => <a key={id} href={`#${id}`} className="ob-tab shrink-0 text-xs">{label}</a>)}
        </nav>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 p-4 pb-16 lg:grid-cols-2">
        {error ? <div role="alert" className="ob-banner lg:col-span-2" data-tone="danger"><AlertCircle size={16} />{error}</div> : null}
        {notice ? <div role="status" className="ob-banner lg:col-span-2" data-tone="success"><Check size={16} />{notice}</div> : null}
        {!document ? <div role="status" className="ob-card p-8 lg:col-span-2">{busy ? "正在加载影片制作数据…" : "影片制作数据不可用"}</div> : (
          <>
            <WorkbenchSection id="manuscript" title="剧本 / Manuscript">
              <label className="block text-sm font-medium" htmlFor="film-manuscript">纯文本或 Markdown 剧本</label>
              <textarea
                id="film-manuscript"
                className="ob-input mt-2 min-h-52 w-full resize-y font-mono text-sm"
                maxLength={1024 * 1024}
                value={manuscript}
                onChange={(event) => {
                  const value = event.target.value;
                  draftRef.current = {
                    ...draftRef.current,
                    manuscript: value,
                    manuscriptDirty: true,
                    manuscriptVersion: draftRef.current.manuscriptVersion + 1,
                  };
                  setManuscript(value);
                  setManuscriptDirty(true);
                }}
                placeholder="EPISODE 1&#10;INT. STUDIO - DAY&#10;A slate snaps shut."
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="ob-btn ob-btn-primary" disabled={!!busy || !manuscript.trim()} onClick={() => void run("导入剧本", () => importFilmManuscript(projectId, {
                  revision: document.source.revision, text: manuscript, format: "text",
                }), { clearManuscript: true, notice: "剧本已导入并进入拆解待审核" })}><Send size={14} /> 导入并拆解</button>
                <button type="button" className="ob-btn" onClick={() => fileRef.current?.click()}><FileUp size={14} /> 选择 TXT / MD</button>
                <input ref={fileRef} type="file" className="hidden" accept=".txt,.md,text/plain,text/markdown" onChange={async (event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  if (!file) return;
                  try {
                    if (file.size > 1024 * 1024) throw new Error("剧本文件不能超过 1 MiB");
                    const extension = file.name.toLowerCase().split(".").pop();
                    if (extension !== "txt" && extension !== "md") throw new Error("首版仅支持 TXT 和 Markdown；DOCX/PDF 暂不支持安全提取");
                    const text = await file.text();
                    draftRef.current = {
                      ...draftRef.current,
                      manuscript: text,
                      manuscriptDirty: true,
                      manuscriptVersion: draftRef.current.manuscriptVersion + 1,
                    };
                    setManuscript(text);
                    setManuscriptDirty(true);
                    await run("导入剧本", () => importFilmManuscript(projectId, {
                      revision: document.source.revision, text, format: extension === "md" ? "markdown" : "txt", originalName: file.name,
                    }), { clearManuscript: true, notice: "剧本已导入并进入拆解待审核" });
                  } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                  finally { input.value = ""; }
                }} />
              </div>
            </WorkbenchSection>

            <WorkbenchSection id="assets" title="制作资产 / Assets">
              <form className="grid gap-2 sm:grid-cols-[140px_1fr_auto]" onSubmit={(event) => {
                event.preventDefault();
                if (!assetTitle.trim()) return;
                void run("创建资产", () => createFilmAsset(projectId, { kind: assetKind, title: assetTitle.trim() })).then(() => setAssetTitle(""));
              }}>
                <select aria-label="资产类型" className="ob-input" value={assetKind} onChange={(event) => setAssetKind(event.target.value as typeof assetKind)}>
                  <option value="character">角色</option><option value="location">场景</option><option value="prop">道具</option><option value="style">风格</option><option value="voice">声音</option>
                </select>
                <input aria-label="资产名称" className="ob-input" maxLength={500} value={assetTitle} onChange={(event) => setAssetTitle(event.target.value)} placeholder="例如：主角造型" />
                <button className="ob-btn" disabled={!!busy || !assetTitle.trim()}><Plus size={14} /> 添加</button>
              </form>
              <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                {document.assets.map((asset) => <li key={asset.id} className="rounded-lg border border-[var(--ob-line)] p-3"><strong className="text-sm">{asset.title}</strong><p className="text-xs text-[var(--ob-muted)]">{asset.kind} · {asset.status} · r{asset.revision}</p></li>)}
              </ul>
              {!document.assets.length ? <p className="mt-4 text-sm text-[var(--ob-muted)]">尚未添加角色、地点、道具、风格或声音资产。</p> : null}
            </WorkbenchSection>

            <WorkbenchSection id="episodes" title="集、场景与镜头 / Episodes & Shots">
              <div className="space-y-4">
                {document.episodes.map((episode) => (
                  <article key={filmEditorKey(episode.id, episode.revision)} className="rounded-xl border border-[var(--ob-line)] p-3">
                    <label className="text-xs text-[var(--ob-muted)]" htmlFor={`episode-${episode.id}`}>集标题</label>
                    <div className="mt-1 flex gap-2">
                      <input id={`episode-${episode.id}`} className="ob-input min-w-0 flex-1" defaultValue={episode.title} maxLength={500} />
                      <button type="button" className="ob-btn" disabled={!!busy} onClick={(event) => {
                        const input = event.currentTarget.previousElementSibling as HTMLInputElement;
                        void run("保存集", () => updateFilmEpisode(projectId, episode.id, { revision: episode.revision, title: input.value }));
                      }}><Save size={14} /></button>
                    </div>
                    <div className="mt-3 space-y-2">
                      {document.scenes.filter((scene) => scene.episodeId === episode.id).map((scene) => (
                        <div key={filmEditorKey(scene.id, scene.revision)} className="rounded-lg bg-[var(--ob-canvas)] p-3">
                          <div className="flex flex-wrap gap-2">
                            <input aria-label={`${scene.heading} 场景标题`} className="ob-input min-w-0 flex-1" defaultValue={scene.heading} maxLength={500} />
                            <button type="button" className="ob-btn" disabled={!!busy} onClick={(event) => {
                              const input = event.currentTarget.previousElementSibling as HTMLInputElement;
                              void run("保存场景", () => updateFilmScene(projectId, scene.id, { revision: scene.revision, heading: input.value }));
                            }}><Save size={14} /> 保存场景</button>
                            <button type="button" className="ob-btn" disabled={!!busy} onClick={() => {
                              if (confirm(`删除场景“${scene.heading}”及其镜头？`)) void run("删除场景", () => deleteFilmScene(projectId, scene.id, scene.revision));
                            }}>删除</button>
                          </div>
                          {document.shots.filter((shot) => shot.sceneId === scene.id).map((shot) => (
                            <div key={filmEditorKey(shot.id, shot.revision)} className="mt-2 grid gap-2 border-t border-[var(--ob-line)] pt-2 sm:grid-cols-[1fr_90px_auto]">
                              <input aria-label={`${shot.title} 描述`} className="ob-input" defaultValue={shot.description} maxLength={100_000} />
                              <input aria-label={`${shot.title} 秒数`} className="ob-input" type="number" min="0.1" max="900" step="0.1" defaultValue={shot.durationSeconds} />
                              <button type="button" className="ob-btn" disabled={!!busy} onClick={(event) => {
                                const row = event.currentTarget.parentElement!;
                                const inputs = row.querySelectorAll("input");
                                void run("保存镜头", () => updateFilmShot(projectId, shot.id, {
                                  revision: shot.revision, description: inputs[0]?.value, durationSeconds: Number(inputs[1]?.value),
                                }));
                              }}><Save size={14} /></button>
                            </div>
                          ))}
                        </div>
                      ))}
                      <button type="button" className="ob-btn" disabled={!!busy} onClick={() => {
                        const heading = prompt("场景标题", "INT. NEW SCENE - DAY")?.trim();
                        if (heading) void run("创建场景", () => createFilmScene(projectId, { episodeId: episode.id, heading }));
                      }}><Plus size={14} /> 添加场景</button>
                    </div>
                  </article>
                ))}
                {!document.episodes.length ? <p className="text-sm text-[var(--ob-muted)]">导入剧本后会确定性地拆解出集、场景与镜头草稿。</p> : null}
              </div>
            </WorkbenchSection>

            <WorkbenchSection id="tasks" title="任务与制作阶段 / Tasks & Stages">
              <ol className="space-y-2">
                {document.stages.map((stage) => <li key={stage.id} data-testid={`film-stage-${stage.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--ob-line)] p-3">
                  <span className="min-w-20 font-medium">{stageLabels[stage.id] ?? stage.id}</span>
                  <span className="mr-auto rounded-full bg-[var(--ob-accent-soft)] px-2 py-1 text-xs">{stage.status} · r{stage.revision}</span>
                  {stage.status === "needs_review" ? <>
                    <button type="button" className="ob-btn ob-btn-primary" disabled={!!busy} onClick={() => void run("批准阶段", () => changeFilmStage(projectId, stage.id, "approve", stage.revision), { notice: "阶段已批准" })}>批准</button>
                    <button type="button" className="ob-btn" disabled={!!busy} onClick={() => void run("退回阶段", () => changeFilmStage(projectId, stage.id, "reject", stage.revision), { notice: "阶段已退回修改" })}>退回</button>
                  </> : <button type="button" className="ob-btn" disabled={!!busy || stage.status === "approved"} onClick={() => void run("提交审核", () => changeFilmStage(projectId, stage.id, "run", stage.revision), { notice: "阶段已进入待审核" })}>提交审核</button>}
                </li>)}
              </ol>
              <p className="mt-3 text-xs text-[var(--ob-muted)]">提交审核只检查现有产物是否就绪，不执行或声称完成媒体生成。</p>
            </WorkbenchSection>

            <WorkbenchSection id="style" title="视觉风格 / Style">
              <p className="text-sm">交付画幅：<strong>{document.aspectRatio}</strong></p>
              <div className="mt-3 flex flex-wrap gap-2">{document.assets.filter((asset) => asset.kind === "style").map((asset) => <span key={asset.id} className="rounded-full border border-[var(--ob-line)] px-3 py-1 text-xs">{asset.title}</span>)}</div>
              {!document.assets.some((asset) => asset.kind === "style") ? <p className="mt-2 text-sm text-[var(--ob-muted)]">在资产分区添加风格资产，供镜头统一引用。</p> : null}
            </WorkbenchSection>

            <WorkbenchSection id="quality" title="质量检查 / Quality">
              <button type="button" className="ob-btn ob-btn-primary" disabled={!!busy} onClick={() => void run("质量检查", () => validateFilm(projectId))}>运行检查</button>
              {latestReport ? <div className="mt-4 space-y-2">
                <p className="text-sm">{latestReport.issues.length} 个问题，{latestReport.repairs.length} 个非破坏性修复建议</p>
                {latestReport.repairs.slice(0, 20).map((repair) => <div key={repair.id} className="flex items-center gap-2 rounded-lg border border-[var(--ob-line)] p-2 text-sm"><span className="min-w-0 flex-1">{repair.summary}</span><button type="button" className="ob-btn" disabled={!!busy || !!repair.appliedAt} onClick={() => void run("应用修复", () => applyFilmRepair(projectId, repair.id, repair.expectedRevision))}>{repair.appliedAt ? "已应用" : "批准并应用"}</button></div>)}
              </div> : <p className="mt-3 text-sm text-[var(--ob-muted)]">检查不会直接修改镜头；每项修复都需明确批准。</p>}
            </WorkbenchSection>

            <WorkbenchSection id="timeline" title="简单时间线 / Timeline">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs">宽度<input className="ob-input mt-1 w-full" type="number" min="320" max="7680" value={document.timeline.width} onChange={(event) => updateTimeline((timeline) => ({ ...timeline, width: Number(event.target.value) }))} /></label>
                <label className="text-xs">高度<input className="ob-input mt-1 w-full" type="number" min="240" max="4320" value={document.timeline.height} onChange={(event) => updateTimeline((timeline) => ({ ...timeline, height: Number(event.target.value) }))} /></label>
                <label className="text-xs">帧率<input className="ob-input mt-1 w-full" type="number" min="1" max="120" value={document.timeline.frameRate} onChange={(event) => updateTimeline((timeline) => ({ ...timeline, frameRate: Number(event.target.value) }))} /></label>
              </div>
              <div className="mt-4 space-y-2">{document.timeline.tracks.map((track) => <div key={track.id} className="rounded-lg border border-[var(--ob-line)] p-2"><strong className="text-xs">{track.title}</strong><span className="ml-2 text-xs text-[var(--ob-muted)]">{track.clips.length} clips</span></div>)}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="ob-btn" onClick={() => updateTimeline((timeline) => ({ ...timeline, tracks: timeline.tracks.map((track) => track.kind === "subtitle" ? { ...track, clips: [...track.clips, { id: `subtitle-${Date.now()}`, revision: 1, source: "manual", order: track.clips.length, start: track.clips.length * 2, end: track.clips.length * 2 + 2, trimIn: 0, trimOut: 0, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, transition: "cut", text: "Subtitle" }] } : track) }))}><Plus size={14} /> 添加字幕片段</button>
                <button type="button" className="ob-btn ob-btn-primary" disabled={!!busy || !timelineDirty} onClick={() => void run("保存时间线", () => saveFilmTimeline(projectId, document.timeline), { clearTimeline: true, notice: "时间线已保存" })}><Save size={14} /> 保存时间线</button>
              </div>
            </WorkbenchSection>

            <WorkbenchSection id="delivery" title="交付 / Delivery">
              <div className="flex flex-wrap gap-2">
                <select aria-label="导出类型" className="ob-input" value={exportKind} onChange={(event) => setExportKind(event.target.value as typeof exportKind)}><option value="manifest">制作清单 JSON</option><option value="srt">字幕 SRT</option></select>
                <button type="button" className="ob-btn ob-btn-primary" disabled={!!busy} onClick={() => void run("请求导出", () => requestFilmExport(projectId, exportKind, document.revision), { notice: "交付文件已创建" })}><Send size={14} /> 请求导出</button>
              </div>
              <p className="mt-3 text-xs text-[var(--ob-muted)]">{status.capabilities?.mp4Diagnostic ?? "MP4 导出当前已禁用。"}</p>
              <ul className="mt-4 space-y-2">{document.deliverables.map((item) => <li key={item.id} className="rounded-lg border border-[var(--ob-line)] p-3"><strong className="text-sm">{item.title}</strong><p className="text-xs text-[var(--ob-muted)]">{item.kind} · {item.status} · {item.bytes ?? 0} bytes</p>{item.diagnostic ? <p className="text-xs text-[var(--ob-danger)]">{item.diagnostic}</p> : null}{item.status === "approved" && (item.kind === "manifest" || item.kind === "srt") ? <a className="ob-btn mt-2 inline-flex" href={filmDeliverableDownloadURL(projectId, item.id)}>下载</a> : null}</li>)}</ul>
            </WorkbenchSection>
          </>
        )}
      </main>
    </div>
  );
}
