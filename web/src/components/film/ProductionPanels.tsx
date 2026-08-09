import { useEffect, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";

import { filmEditorKey } from "@/lib/film-drafts";
import {
  cancelFilmGenerationJob,
  commitFilmProjection,
  listFilmGenerationJobs,
  refreshFilmProjection,
  resolveFilmStageSelection,
  retryFilmGenerationJob,
  waitForFilmGenerationStage,
  type FilmGenerationJob,
  type FilmProjectionPlan,
  type FilmStageRunRequest,
  type FilmStatus,
} from "@/services/film-client";
import type { FilmShot, FilmStage, FilmStageKind } from "@/types/film";
import { WorkbenchSection } from "./WorkbenchSection";

const stageLabels: Record<FilmStageKind, string> = { decompose: "拆解", script: "剧本", storyboard: "分镜", audio: "声音", video: "画面", compose: "合成", delivery: "交付" };

export function EpisodesPanel({ status, busy, onSaveEpisode, onSaveShot }: {
  status: FilmStatus; busy: boolean;
  onSaveEpisode: (id: string, revision: number, title: string) => void;
  onSaveShot: (shot: FilmShot, patch: Partial<FilmShot>) => void;
}) {
  const { document } = status;
  const identities = document.assets.filter((asset) => asset.kind === "identity");
  const styles = document.assets.filter((asset) => asset.kind === "style");
  return <WorkbenchSection id="episodes" title="分集、场景与镜头绑定 / Episodes & Shots" wide>
    <div className="space-y-4">{document.episodes.map((episode) => <article key={filmEditorKey(episode.id, episode.revision)} className="rounded-xl border border-[var(--ob-line)] p-3">
      <div className="flex gap-2"><input aria-label={`${episode.title} 集标题`} className="ob-input flex-1" defaultValue={episode.title} /><button type="button" className="ob-btn" disabled={busy} onClick={(event) => onSaveEpisode(episode.id, episode.revision, (event.currentTarget.previousElementSibling as HTMLInputElement).value)}><Save size={14} /> 保存集</button></div>
      {document.scenes.filter((scene) => scene.episodeId === episode.id).map((scene) => <div key={scene.id} className="mt-3 rounded-lg bg-[var(--ob-canvas)] p-3"><strong className="text-sm">{scene.heading}</strong>
        {document.shots.filter((shot) => shot.sceneId === scene.id).map((shot) => <ShotEditor key={filmEditorKey(shot.id, shot.revision)} shot={shot} identities={identities} styles={styles} busy={busy} onSave={onSaveShot} />)}
      </div>)}
    </article>)}</div>
    {!document.episodes.length ? <p className="text-sm text-[var(--ob-muted)]">导入原稿后会出现分集、场景与镜头。</p> : null}
  </WorkbenchSection>;
}

function ShotEditor({ shot, identities, styles, busy, onSave }: { shot: FilmShot; identities: FilmStatus["document"]["assets"]; styles: FilmStatus["document"]["assets"]; busy: boolean; onSave: (shot: FilmShot, patch: Partial<FilmShot>) => void }) {
  const [description, setDescription] = useState(shot.description);
  const [duration, setDuration] = useState(shot.durationSeconds);
  const [style, setStyle] = useState(shot.styleAssetId ?? "");
  const [identityIds, setIdentityIds] = useState(shot.identityVersionIds);
  return <div className="mt-2 border-t border-[var(--ob-line)] pt-3" data-testid={`film-shot-${shot.id}`}>
    <div className="grid gap-2 md:grid-cols-[1fr_100px_180px_auto]"><input aria-label={`${shot.title} 描述`} className="ob-input" value={description} onChange={(event) => setDescription(event.target.value)} /><input aria-label={`${shot.title} 秒数`} className="ob-input" type="number" min="0.1" max="900" step="0.1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><select aria-label={`${shot.title} 风格绑定`} className="ob-input" value={style} onChange={(event) => setStyle(event.target.value)}><option value="">无风格</option>{styles.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select><button type="button" className="ob-btn" disabled={busy} onClick={() => onSave(shot, { description, durationSeconds: duration, styleAssetId: style, identityVersionIds: identityIds })}><Save size={14} /> 保存镜头</button></div>
    <fieldset className="mt-2 flex flex-wrap gap-3"><legend className="text-xs text-[var(--ob-muted)]">角色身份版本</legend>{identities.map((asset) => <label key={asset.id} className="text-xs"><input type="checkbox" checked={identityIds.includes(asset.id)} onChange={(event) => setIdentityIds((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} /> {asset.title}</label>)}</fieldset>
  </div>;
}

export function ProductionPanel({ status, busy, onLegacyStage, onRun, onSynced }: { status: FilmStatus; busy: boolean; onLegacyStage: (stage: FilmStage, action: "run" | "approve" | "reject") => void; onRun: (stage: FilmStageKind, request: FilmStageRunRequest) => Promise<boolean>; onSynced: (status: FilmStatus) => void }) {
  const capabilities = status.capabilities;
  const [jobs, setJobs] = useState<FilmGenerationJob[]>([]);
  const [jobError, setJobError] = useState("");
  const [stage, setStage] = useState<FilmStageKind>("storyboard");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [config, setConfig] = useState("{\n  \"quality\": \"standard\"\n}");
  const [episodeFrom, setEpisodeFrom] = useState(1); const [episodeTo, setEpisodeTo] = useState(1);
  const [shotFrom, setShotFrom] = useState(0); const [shotTo, setShotTo] = useState(0);
  const syncKey = useRef("");
  useEffect(() => {
    if (capabilities.generationStages.includes(stage)) return;
    const firstAvailable = capabilities.generationStages[0];
    if (firstAvailable) setStage(firstAvailable);
  }, [capabilities.generationStages, stage]);
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
      setJobError("生成配置必须是简单 JSON 对象");
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
  return <WorkbenchSection id="tasks" title="阶段运行与 Generation Jobs" wide>
    <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
      <div><h3 className="text-sm font-medium">阶段审核状态</h3><ol className="mt-2 space-y-2">{status.document.stages.map((item) => <li key={item.id} data-testid={`film-stage-${item.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--ob-line)] p-2"><span>{stageLabels[item.id]}</span><span className="mr-auto text-xs">{item.status} · r{item.revision}</span>{item.status === "needs_review" ? <><button className="ob-btn" onClick={() => onLegacyStage(item, "approve")}>批准</button><button className="ob-btn" onClick={() => onLegacyStage(item, "reject")}>退回</button></> : <button className="ob-btn" disabled={busy || item.status === "approved"} onClick={() => onLegacyStage(item, "run")}>提交产物审核</button>}</li>)}</ol><p className="mt-2 text-xs text-[var(--ob-muted)]">提交产物审核只改变审核状态，不代表媒体生成完成。</p></div>
      <div><h3 className="text-sm font-medium">范围与生成配置</h3><div className="mt-2 grid gap-2 sm:grid-cols-2"><select aria-label="运行阶段" className="ob-input" value={stage} onChange={(event) => setStage(event.target.value as FilmStageKind)}>{status.document.stages.filter((item) => capabilities.generationStages.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{stageLabels[item.id]}</option>)}</select><input aria-label="幂等键" className="ob-input" value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} /><input aria-label="Provider" className="ob-input" value={provider} onChange={(event) => setProvider(event.target.value)} /><input aria-label="Model" className="ob-input" value={model} onChange={(event) => setModel(event.target.value)} /><label className="text-xs">分集起止<div className="flex gap-1"><input className="ob-input w-full" type="number" min="1" value={episodeFrom} onChange={(e) => setEpisodeFrom(Number(e.target.value))} /><input className="ob-input w-full" type="number" min="1" value={episodeTo} onChange={(e) => setEpisodeTo(Number(e.target.value))} /></div></label><label className="text-xs">镜头 order 起止（从 0）<div className="flex gap-1"><input className="ob-input w-full" type="number" min="0" value={shotFrom} onChange={(e) => setShotFrom(Number(e.target.value))} /><input className="ob-input w-full" type="number" min="0" value={shotTo} onChange={(e) => setShotTo(Number(e.target.value))} /></div></label><textarea aria-label="生成配置 JSON" className="ob-input min-h-24 sm:col-span-2" value={config} onChange={(event) => setConfig(event.target.value)} /></div><button type="button" className="ob-btn ob-btn-primary mt-2" disabled={busy || !capabilities.stageGeneration || !capabilities.generationStages.includes(stage) || !provider.trim() || !model.trim() || !idempotencyKey.trim()} onClick={() => void submit()}>开始生成</button>{!capabilities.stageGeneration ? <p className="mt-2 text-xs text-[var(--ob-muted)]">当前后端未声明范围生成能力，生成请求已禁用。</p> : null}</div>
    </div>
    <div className="mt-5 flex items-center gap-2"><h3 className="mr-auto text-sm font-medium">父任务与镜头子任务</h3><button className="ob-btn" disabled={!capabilities.generationJobs && !status.document.tasks.some((task) => task.generationJobId)} onClick={() => void refreshJobs()}><RefreshCw size={14} /> 刷新任务</button></div>
    {jobError ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{jobError}</p> : null}
    <ul className="mt-2 space-y-2">{jobs.map((job) => <li key={job.id} data-testid={`generation-job-${job.id}`} className={`rounded-lg border border-[var(--ob-line)] p-3 ${job.parentJobId ? "ml-5" : ""}`}><div className="flex flex-wrap items-center gap-2"><strong className="mr-auto text-sm">{job.title}</strong><span className="text-xs">{job.status}</span>{job.shotId && (job.status === "failed" || job.status === "canceled") ? <button className="ob-btn" onClick={() => void retryOne(job.id).catch((cause) => setJobError(String(cause)))}>重试镜头</button> : null}{(job.status === "queued" || job.status === "running") ? <button className="ob-btn" onClick={() => void cancelFilmGenerationJob(status.document.projectId, job.id).then(updateOne).catch((cause) => setJobError(String(cause)))}>取消</button> : null}</div>{job.error ? <p className="text-xs text-[var(--ob-danger)]">{job.error}</p> : null}</li>)}</ul>
    {!jobs.length ? <p className="mt-2 text-sm text-[var(--ob-muted)]">{capabilities.generationJobs ? "暂无 GenerationJob。" : "后端未提供 GenerationJob 查询能力；不会回退到内存 task 冒充任务状态。"}</p> : null}
  </WorkbenchSection>;
}

export function ProjectionPanel({ projectId, busy, onStatus }: { projectId: string; busy: boolean; onStatus: (label: string, operation: () => Promise<FilmStatus>) => void }) {
  const [plan, setPlan] = useState<FilmProjectionPlan | null>(null);
  const [error, setError] = useState("");
  return <WorkbenchSection id="projection" title="画布投影同步 / Projection">
    <button className="ob-btn" disabled={busy} onClick={() => void refreshFilmProjection(projectId).then(setPlan).catch((cause) => setError(String(cause)))}><RefreshCw size={14} /> 从服务端刷新投影计划</button>
    {error ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{error}</p> : null}
    <div className="mt-3 space-y-2">{plan?.targets.map((target) => <form key={`${target.projectionKey}:${target.revision}`} className="rounded-lg border border-[var(--ob-line)] p-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onStatus("提交投影", () => commitFilmProjection(projectId, { projectionKey: target.projectionKey, expectedRevision: target.revision, fields: { title: String(form.get("title") ?? ""), content: String(form.get("content") ?? "") } })); }}><input name="title" aria-label={`${target.projectionKey} 投影标题`} className="ob-input w-full" defaultValue={target.title} /><textarea name="content" aria-label={`${target.projectionKey} 投影内容`} className="ob-input mt-1 w-full" defaultValue={target.content} /><button className="ob-btn mt-1"><Save size={14} /> 提交投影修改</button></form>)}</div>
  </WorkbenchSection>;
}

export function AgentPanel({ status, onValidate }: { status: FilmStatus; onValidate: () => void }) {
  const labels = { status: "查看制作状态", list: "列出制作资源", validate: "运行只读规则检查", run_stage: "提交阶段检查（仍需人工审核）" };
  return <WorkbenchSection id="agent" title="安全 Agent 入口"><ul className="space-y-2">{status.capabilities.agentOperations.map((operation) => <li key={operation} className="rounded-lg border border-[var(--ob-line)] p-2 text-sm">{labels[operation]}</li>)}</ul>{status.capabilities.agentOperations.includes("validate") ? <button className="ob-btn mt-3" onClick={onValidate}>运行质量检查</button> : null}<p className="mt-2 text-xs text-[var(--ob-muted)]">Agent 不提供绕过确认的批准、修复或导出操作。</p></WorkbenchSection>;
}
