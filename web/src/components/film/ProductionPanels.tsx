import { useEffect, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";

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
import { executeFilmAgentRead, type FilmAgentReadTool } from "@/services/film-agent-client";
import { EpisodeProductionViews } from "./EpisodeProductionViews";

const stageLabels: Record<FilmStageKind, string> = { decompose: "拆解", script: "剧本", storyboard: "分镜", first_frame: "首帧", audio: "声音", video: "画面", compose: "合成", delivery: "交付" };

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

export function ProductionPanel({ status, busy, onLegacyStage, onRun, onSynced }: { status: FilmStatus; busy: boolean; onLegacyStage: (stage: FilmStage, action: "run" | "approve" | "reject") => void; onRun: (stage: FilmStageKind, request: FilmStageRunRequest) => Promise<boolean>; onSynced: (status: FilmStatus) => void }) {
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
  return <WorkbenchSection id="tasks" title="阶段运行与 Generation Jobs" wide>
    <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
      <div><h3 className="text-sm font-medium">阶段审核状态</h3><ol className="mt-2 space-y-2">{status.document.stages.map((item) => <li key={item.id} data-testid={`film-stage-${item.id}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--ob-line)] p-2"><span>{stageLabels[item.id]}</span><span className="mr-auto text-xs">{item.status} · r{item.revision}</span>{item.status === "needs_review" ? <><button className="ob-btn" onClick={() => onLegacyStage(item, "approve")}>批准</button><button className="ob-btn" onClick={() => onLegacyStage(item, "reject")}>退回</button></> : <button className="ob-btn" disabled={busy || item.status === "approved"} onClick={() => onLegacyStage(item, "run")}>提交产物审核</button>}</li>)}</ol><p className="mt-2 text-xs text-[var(--ob-muted)]">提交产物审核只改变审核状态，不代表媒体生成完成。</p></div>
      <div><h3 className="text-sm font-medium">范围与生成配置</h3><div className="mt-2 grid gap-2 sm:grid-cols-2"><select aria-label="运行阶段" className="ob-input" value={stage} onChange={(event) => setStage(event.target.value as FilmStageKind)}>{status.document.stages.filter((item) => capabilities.generationStages.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{stageLabels[item.id]}</option>)}</select><input aria-label="幂等键" className="ob-input" value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} /><label className="text-xs sm:col-span-2">媒体能力目录<select aria-label="媒体模型能力" className="ob-input mt-1 w-full" disabled={!mediaOptions.length} value={provider && model ? `${provider}:${model}` : ""} onChange={(event) => { const option = mediaOptions.find((item) => `${item.channelId}:${item.model}` === event.target.value); setProvider(option?.channelId ?? ""); setModel(option?.model ?? ""); }}><option value="">{mediaCatalog ? `没有已启用的${mediaKind}模型` : "正在加载服务端目录"}</option>{mediaOptions.map((option) => <option key={`${option.channelId}:${option.model}`} value={`${option.channelId}:${option.model}`}>{option.channelName} · {option.model} · {option.modes.join(" / ")}</option>)}</select></label><label className="text-xs">分集起止<div className="flex gap-1"><input className="ob-input w-full" type="number" min="1" value={episodeFrom} onChange={(e) => setEpisodeFrom(Number(e.target.value))} /><input className="ob-input w-full" type="number" min="1" value={episodeTo} onChange={(e) => setEpisodeTo(Number(e.target.value))} /></div></label><label className="text-xs">镜头 order 起止（从 0）<div className="flex gap-1"><input className="ob-input w-full" type="number" min="0" value={shotFrom} onChange={(e) => setShotFrom(Number(e.target.value))} /><input className="ob-input w-full" type="number" min="0" value={shotTo} onChange={(e) => setShotTo(Number(e.target.value))} /></div></label><textarea aria-label="生成配置 JSON" className="ob-input min-h-24 sm:col-span-2" value={config} onChange={(event) => setConfig(event.target.value)} /></div><p className="mt-2 text-xs text-[var(--ob-muted)]">目录加载完成前不会猜测模型能力。{mediaCatalog ? `目录版本 ${mediaCatalog.version.slice(0, 12)}` : mediaCatalogError}</p><button type="button" className="ob-btn ob-btn-primary mt-2" disabled={busy || !capabilities.stageGeneration || !capabilities.generationStages.includes(stage) || !mediaCatalog || !provider.trim() || !model.trim() || !idempotencyKey.trim()} onClick={() => void submit()}>开始生成</button>{!capabilities.stageGeneration ? <p className="mt-2 text-xs text-[var(--ob-muted)]">当前后端未声明范围生成能力，生成请求已禁用。</p> : null}</div>
    </div>
    <div className="mt-5 flex items-center gap-2"><h3 className="mr-auto text-sm font-medium">父任务与镜头子任务</h3><button className="ob-btn" disabled={!capabilities.generationJobs && !status.document.tasks.some((task) => task.generationJobId)} onClick={() => void refreshJobs()}><RefreshCw size={14} /> 刷新任务</button></div>
    {jobError ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{jobError}</p> : null}
    <ul className="mt-2 space-y-2">{jobs.map((job) => <li key={job.id} data-testid={`generation-job-${job.id}`} className={`rounded-lg border border-[var(--ob-line)] p-3 ${job.parentJobId ? "ml-5" : ""}`}><div className="flex flex-wrap items-center gap-2"><strong className="mr-auto text-sm">{job.title}</strong><span className="text-xs">{job.status}</span>{latestGenerationJobIds.has(job.id) && (job.status === "failed" || job.status === "canceled") ? <button className="ob-btn" onClick={() => void retryOne(job.id).catch((cause) => setJobError(String(cause)))}>{job.shotId ? "重试镜头" : "重试任务"}</button> : null}{(job.status === "queued" || job.status === "running") ? <button className="ob-btn" onClick={() => void cancelOne(job.id).catch((cause) => setJobError(String(cause)))}>取消</button> : null}</div>{job.error ? <p className="text-xs text-[var(--ob-danger)]">{job.error}</p> : null}</li>)}</ul>
    {!jobs.length ? <p className="mt-2 text-sm text-[var(--ob-muted)]">{capabilities.generationJobs ? "暂无 GenerationJob。" : "后端未提供 GenerationJob 查询能力；不会回退到内存 task 冒充任务状态。"}</p> : null}
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
      { key: `shot:${shot.id}:image`, label: `${shot.title} · 分镜`, revision: shot.revision },
      { key: `shot:${shot.id}:first_frame`, label: `${shot.title} · 首帧`, revision: shot.revision },
      { key: `shot:${shot.id}:last_frame`, label: `${shot.title} · 尾帧`, revision: shot.revision },
      { key: `shot:${shot.id}:video`, label: `${shot.title} · 视频`, revision: shot.revision },
      { key: `shot:${shot.id}:audio`, label: `${shot.title} · 音频`, revision: shot.revision },
    ])),
    ...status.document.assets.map((asset) => ({ key: `asset:${asset.id}:media`, label: `${asset.title} · ${asset.kind} 参考`, revision: asset.revision })),
  ];
  const adopt = async () => {
    const node = candidates.find((item) => item.id === candidateId);
    const selected = targets.find((item) => item.key === target);
    if (!node?.metadata.storageKey || !selected) throw new Error("请选择候选媒体和目标");
    const [targetType, targetId, targetField] = selected.key.split(":") as ["shot" | "asset", string, "image" | "first_frame" | "last_frame" | "video" | "audio" | "media"];
    if (targetType === "shot" && node.type !== (targetField === "first_frame" || targetField === "last_frame" ? "image" : targetField)) throw new Error("候选媒体类型与镜头目标不匹配");
    await onAdopt({ targetType, targetId, targetField, expectedRevision: selected.revision, sourceNodeId: node.id, storageKey: node.metadata.storageKey, ...(node.metadata.generationJobId ? { generationJobId: node.metadata.generationJobId } : {}) });
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
      if (!scene || !directorCaptures.some((capture) => capture.id === directorCaptureId)) throw new Error("请选择 Director 拍摄版本和场景目标");
      await onBindDirectorScene({ sceneId: scene.id, expectedRevision: scene.revision, captureId: directorCaptureId });
      return;
    }
    const shotId = targetId;
    const shot = status.document.shots.find((item) => item.id === shotId);
    if (!shot || !directorCaptures.some((capture) => capture.id === directorCaptureId) || (targetField !== "storyboard" && targetField !== "first_frame" && targetField !== "last_frame")) throw new Error("请选择 Director 拍摄版本和镜头目标");
    await onAdoptDirector({ shotId, expectedRevision: shot.revision, captureId: directorCaptureId, targetField });
  };
  return <WorkbenchSection id="projection" title="画布投影同步 / Projection">
    <div className="flex flex-wrap gap-2">
      <button className="ob-btn ob-btn-primary" disabled={busy} onClick={() => void onRefreshCanvas().catch((cause) => setError(String(cause)))}><RefreshCw size={14} /> 刷新到真实画布</button>
      <button className="ob-btn" disabled={busy || !diffs.length} onClick={() => void onCommitCanvas(diffs).catch((cause) => setError(String(cause)))}><Save size={14} /> 回写 {diffs.length} 项画布修改</button>
      <button className="ob-btn" disabled={busy} onClick={() => void refreshFilmProjection(project.id).then(setPlan).catch((cause) => setError(String(cause)))}>查看服务端投影计划</button>
    </div>
    <p className="mt-2 text-xs text-[var(--ob-muted)]">刷新只更新带 filmProjectionKey 的受管节点；用户节点和已有布局会保留。回写前仅提交标题与正文差异，并检查实体修订。</p>
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <select aria-label="画布候选媒体" className="ob-input" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">选择画布候选媒体</option>{candidates.map((node) => <option key={node.id} value={node.id}>{node.title} · {node.type}</option>)}</select>
      <select aria-label="采用目标" className="ob-input" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">选择镜头或资产目标</option>{targets.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
      <button className="ob-btn" disabled={busy || !candidateId || !target} onClick={() => void adopt().catch((cause) => setError(String(cause)))}>采用并记录来源</button>
    </div>
    <div className="mt-4 rounded-xl border border-[var(--ob-line)] p-3">
      <strong className="text-sm">场景 Director 工作区</strong>
      <p className="mt-1 text-xs text-[var(--ob-muted)]">按需创建一个受管 Director 节点，重复打开会定位原节点，并保留机位、角色站位和画布布局。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <select aria-label="Director 场景" className="ob-input" value={status.document.scenes.some((scene) => scene.id === directorSceneId) ? directorSceneId : status.document.scenes[0]?.id ?? ""} onChange={(event) => setDirectorSceneId(event.target.value)}><option value="">选择影视场景</option>{status.document.scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.heading}</option>)}</select>
        <button className="ob-btn" disabled={busy || !status.document.scenes.length} onClick={() => onOpenDirector(status.document.scenes.some((scene) => scene.id === directorSceneId) ? directorSceneId : status.document.scenes[0]?.id ?? "")}>创建 / 定位 Director</button>
      </div>
    </div>
    {directorNodes.length ? <div className="mt-4 rounded-xl border border-[var(--ob-line)] p-3">
      <div className="flex flex-wrap items-center gap-2"><strong className="mr-auto text-sm">Director 正式构图</strong><button className="ob-btn" disabled={busy} onClick={() => void loadDirectorCaptures().catch((cause) => setError(String(cause)))}><RefreshCw size={14} /> 加载 Director 拍摄版本</button></div>
      <p className="mt-1 text-xs text-[var(--ob-muted)]">服务端会验证拍摄版本属于当前影视项目，并复制为稳定媒体；临时拍摄记录删除后不会影响正式镜头。</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <select aria-label="Director 拍摄版本" className="ob-input" value={directorCaptureId} onChange={(event) => setDirectorCaptureId(event.target.value)}><option value="">选择已验证的拍摄版本</option>{directorCaptures.map((capture) => <option key={capture.id} value={capture.id}>{capture.cameraName} · {capture.width}×{capture.height} · {new Date(capture.createdAt).toLocaleString()}</option>)}</select>
        <select aria-label="Director 采用目标" className="ob-input" value={directorTarget} onChange={(event) => setDirectorTarget(event.target.value)}><option value="">选择场景或镜头目标</option>{status.document.scenes.map((scene) => <option key={`scene:${scene.id}`} value={`scene:${scene.id}:scene`}>{scene.heading} · 正式场景版本</option>)}{status.document.shots.flatMap((shot) => [<option key={`${shot.id}:storyboard`} value={`shot:${shot.id}:storyboard`}>{shot.title} · 分镜</option>, <option key={`${shot.id}:first_frame`} value={`shot:${shot.id}:first_frame`}>{shot.title} · 首帧</option>, <option key={`${shot.id}:last_frame`} value={`shot:${shot.id}:last_frame`}>{shot.title} · 尾帧</option>])}</select>
        <button className="ob-btn" disabled={busy || !directorCaptureId || !directorTarget} onClick={() => void adoptDirector().catch((cause) => setError(String(cause)))}>采用为场景 / 分镜 / 首帧 / 尾帧</button>
      </div>
    </div> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{error}</p> : null}
    {diffs.length ? <ul className="mt-3 space-y-2">{diffs.map((diff) => <li key={diff.projectionKey} className="rounded-lg border border-[var(--ob-line)] p-2 text-xs"><strong>{diff.projectionKey}</strong><div className="mt-1 grid gap-1 sm:grid-cols-2"><span className="text-[var(--ob-muted)]">原：{diff.before.title} · {diff.before.content}</span><span>新：{diff.after.title} · {diff.after.content}</span></div></li>)}</ul> : null}
    <div className="mt-3 space-y-2">{plan?.targets.map((target) => <form key={`${target.projectionKey}:${target.revision}`} className="rounded-lg border border-[var(--ob-line)] p-2" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); onStatus("提交投影", () => commitFilmProjection(project.id, { projectionKey: target.projectionKey, expectedRevision: target.revision, fields: { title: String(form.get("title") ?? ""), content: String(form.get("content") ?? "") } })); }}><input name="title" aria-label={`${target.projectionKey} 投影标题`} className="ob-input w-full" defaultValue={target.title} /><textarea name="content" aria-label={`${target.projectionKey} 投影内容`} className="ob-input mt-1 w-full" defaultValue={target.content} /><button className="ob-btn mt-1"><Save size={14} /> 提交投影修改</button></form>)}</div>
  </WorkbenchSection>;
}

export function AgentPanel({ status, onValidate }: { status: FilmStatus; onValidate: () => void }) {
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
  return <WorkbenchSection id="agent" title="制片助理控制台">
    <div className="grid gap-2 sm:grid-cols-3"><div className="rounded-lg border border-[var(--ob-line)] p-3 text-sm"><strong>阶段进度</strong><p className="mt-1">{approved}/{total} 已批准</p></div><div className="rounded-lg border border-[var(--ob-line)] p-3 text-sm"><strong>当前阻塞</strong><p className="mt-1">{nextStage ? `${stageLabels[nextStage.id]} · ${nextStage.status}` : "无"}</p></div><div className="rounded-lg border border-[var(--ob-line)] p-3 text-sm"><strong>质量问题 {issues}</strong><p className="mt-1">{issues ? "需要检查修复提案" : "暂无已知问题"}</p></div></div>
    <div className="mt-3 flex flex-wrap gap-2">{status.capabilities.agentOperations.includes("status") ? <button className="ob-btn" disabled={busy} onClick={() => runRead("film.status")}>查看制作状态</button> : null}{status.capabilities.agentOperations.includes("next_steps") ? <button className="ob-btn" disabled={busy} onClick={() => runRead("film.next_steps")}>建议下一步</button> : null}{status.capabilities.agentOperations.includes("validate") ? <button className="ob-btn" disabled={busy} onClick={onValidate}>运行质量检查</button> : null}</div>
    <p className="mt-3 text-xs text-[var(--ob-muted)]">读取检查可直接执行；生成、审批、修复和导出需要确认，并继续使用上方阶段、质量与交付区域的同一领域 API。</p>
    {result ? <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--ob-surface-2)] p-3 text-xs">{result}</pre> : null}{error ? <p role="alert" className="mt-2 text-sm text-[var(--ob-danger)]">{error}</p> : null}
  </WorkbenchSection>;
}
