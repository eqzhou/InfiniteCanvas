import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Download, ImagePlus, RefreshCw, Square, Trash2, Video } from "lucide-react";
import type { GenerationJob, GenerationKind } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { getProvider } from "@/lib/ai-config";
import { resolveVideoDuration } from "@/lib/video-generation";
import { assertResolvedImageReferences } from "@/lib/image-generation";
import { generateImages, generateVideo } from "@/services/ai-client";
import {
  createGenerationJob,
  deleteGenerationJob,
  findInterruptedGenerationJobs,
  findUnreferencedGenerationStorageKeys,
  listAllGenerationJobs,
  listGenerationJobs,
  updateGenerationJob,
} from "@/services/generation-jobs";
import {
  blobToDataUrl,
  collectStorageKeys,
  deleteStorageKey,
  downloadStorageKey,
  getBlob,
  uploadMedia,
} from "@/services/storage";
import { completeGenerationActivity, getGenerationActivities } from "@/services/generation-activity";
import { getRuntimeOwnerId } from "@/services/runtime-identity";

type ResultItem = {
  url?: string;
  storageKey?: string;
  mimeType?: string;
  width?: number;
  height?: number;
};

export function CreativeWorkbench({ kind }: { kind: GenerationKind }) {
  const config = useBoardStore((state) => state.config);
  const project = useBoardStore((state) => state.getActive());
  const addNode = useBoardStore((state) => state.addNode);
  const persistNow = useBoardStore((state) => state.persistNow);
  const [channelId, setChannelId] = useState(config.activeChannelId ?? config.channels[0]?.id ?? "");
  const channel = config.channels.find((item) => item.id === channelId) ?? config.channels[0];
  const provider = channel ? getProvider(channel, kind) : undefined;
  const [model, setModel] = useState(provider?.model ?? "");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState(config.imageSize);
  const [quality, setQuality] = useState(config.imageQuality);
  const [count, setCount] = useState(config.imageCount);
  const [transparent, setTransparent] = useState(false);
  const [seconds, setSeconds] = useState(5);
  const [smartDuration, setSmartDuration] = useState(false);
  const [ratio, setRatio] = useState("16:9");
  const [resolution, setResolution] = useState("720p");
  const [generateAudio, setGenerateAudio] = useState(false);
  const [watermark, setWatermark] = useState(false);
  const [references, setReferences] = useState<File[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setModel(provider?.model ?? "");
  }, [provider?.model]);

  const refresh = useCallback(async () => {
    const page = await listGenerationJobs({ projectId: project?.id, kind, page: 1, pageSize: 50 });
    const interrupted = findInterruptedGenerationJobs(
      page.items,
      getRuntimeOwnerId(),
      new Set(getGenerationActivities().filter((item) => item.status === "running").map((item) => item.id)),
    );
    const recovered = new Map((await Promise.all(interrupted.map((job) =>
      updateGenerationJob(job.id, {
        status: "failed",
        error: "页面刷新后任务已中断，请重试",
      })))).map((job) => [job.id, job]));
    setJobs(page.items.map((job) => recovered.get(job.id) ?? job));
  }, [kind, project?.id]);

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [refresh]);

  const run = async (source?: GenerationJob) => {
    const runPrompt = source?.prompt ?? prompt;
    const runModel = source?.model ?? model;
    const runChannel = config.channels.find((item) => item.id === source?.providerId) ?? channel;
    const runProvider = runChannel ? getProvider(runChannel, kind) : undefined;
    if (!runChannel || !runProvider?.baseUrl || !runPrompt.trim() || busy) {
      setError(!runProvider?.baseUrl ? "请先在设置中配置对应模型服务 URL" : "请输入提示词");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    let job: GenerationJob | undefined;
    const uploadedReferenceKeys: string[] = [];
    try {
      const referenceData: string[] = [];
      const referenceStorageKeys: string[] = [];
      if (source) {
        const keys = Array.isArray(source.parameters.referenceStorageKeys)
          ? source.parameters.referenceStorageKeys.filter((value): value is string => typeof value === "string")
          : [];
        for (const key of keys) {
          const blob = await getBlob(key.startsWith("media:") ? "media" : "image", key);
          if (blob) {
            referenceData.push(await blobToDataUrl(blob));
            referenceStorageKeys.push(key);
          }
        }
        assertResolvedImageReferences(keys, referenceData);
      } else {
        for (const file of references) {
          const uploaded = await uploadMedia(file, file.type.startsWith("image/") ? "image" : "media");
          uploadedReferenceKeys.push(uploaded.storageKey);
          referenceStorageKeys.push(uploaded.storageKey);
          referenceData.push(await blobToDataUrl(file));
        }
      }
      const ownerClientId = getRuntimeOwnerId();
      const parameters: Record<string, unknown> = {
        ...(source?.parameters ?? (kind === "image"
        ? { size, quality, count, transparentBackground: transparent, referenceStorageKeys }
        : {
            seconds,
            smartDuration,
            ratio,
            resolution,
            generateAudio,
            watermark,
            referenceStorageKeys,
          })),
        ...(ownerClientId ? { ownerClientId } : {}),
      };
      job = await createGenerationJob({
        projectId: project?.id,
        kind,
        status: "running",
        prompt: runPrompt.trim(),
        providerId: runChannel.id,
        model: runModel,
        parameters,
        result: {},
      });
      const items: ResultItem[] = [];
      if (kind === "image") {
        const urls = await generateImages({
          channel: runChannel,
          model: runModel,
          prompt: runPrompt.trim(),
          size: String(parameters.size ?? size),
          quality: String(parameters.quality ?? quality),
          n: Number(parameters.count ?? count),
          transparentBackground: Boolean(parameters.transparentBackground),
          referenceDataUrls: referenceData.filter((value) => value.startsWith("data:image/")),
          systemPrompt: config.systemPrompt,
          signal: controller.signal,
          activityId: job.id,
          activitySurface: "image-workbench",
          deferActivitySuccess: true,
        });
        for (const url of urls) {
          const media = await uploadMedia(url, "image");
          items.push(media);
        }
      } else {
        const output = await generateVideo({
          channel: runChannel,
          model: runModel,
          prompt: runPrompt.trim(),
          seconds: resolveVideoDuration(
            Boolean(parameters.smartDuration),
            Number(parameters.seconds ?? seconds),
          ),
          ratio: String(parameters.ratio ?? ratio),
          resolution: String(parameters.resolution ?? resolution),
          generateAudio: Boolean(parameters.generateAudio),
          watermark: Boolean(parameters.watermark),
          referenceImages: referenceData.filter((value) => value.startsWith("data:image/")),
          referenceVideos: referenceData.filter((value) => value.startsWith("data:video/")),
          referenceAudios: referenceData.filter((value) => value.startsWith("data:audio/")),
          signal: controller.signal,
          activityId: job.id,
          activitySurface: "video-workbench",
          deferActivitySuccess: true,
        });
        if (!output.url) throw new Error("视频服务没有返回结果 URL");
        try {
          items.push(await uploadMedia(output.url, "media"));
        } catch {
          items.push({ url: output.url, mimeType: "video/mp4" });
        }
      }
      if (!items.length) throw new Error("模型服务没有返回生成结果");
      await updateGenerationJob(job.id, { status: "succeeded", result: { items } });
      completeGenerationActivity(job.id, "succeeded");
      await refresh();
    } catch (cause) {
      const cancelled = controller.signal.aborted;
      if (!job && uploadedReferenceKeys.length) {
        await Promise.allSettled(uploadedReferenceKeys.map(deleteStorageKey));
      }
      if (job) {
        completeGenerationActivity(
          job.id,
          cancelled ? "cancelled" : "failed",
          cancelled ? "已取消" : cause instanceof Error ? cause.message : String(cause),
        );
        await updateGenerationJob(job.id, {
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? "已取消" : cause instanceof Error ? cause.message : String(cause),
        }).catch(() => undefined);
      }
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      await refresh().catch(() => undefined);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  };

  const insert = async (item: ResultItem, job: GenerationJob) => {
    const viewport = project?.viewport ?? { x: 0, y: 0, k: 1 };
    let content = item.url;
    if (item.storageKey) {
      const blob = await getBlob(item.storageKey.startsWith("media:") ? "media" : "image", item.storageKey);
      if (blob) content = URL.createObjectURL(blob);
    }
    addNode(kind, { x: (420 - viewport.x) / viewport.k, y: (260 - viewport.y) / viewport.k }, {
      title: kind === "image" ? "工作台图片" : "工作台视频",
      metadata: {
        content,
        storageKey: item.storageKey,
        mimeType: item.mimeType,
        naturalWidth: item.width,
        naturalHeight: item.height,
        prompt: job.prompt,
        model: job.model,
        status: "success",
      },
    });
    await persistNow();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ob-canvas)]">
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 py-3 shadow-[var(--ob-elev-1)] backdrop-blur-md">
        <div className="min-w-0">
          <p className="ob-page-kicker">{kind === "image" ? "Image" : "Video"}</p>
          <h1 className="text-base font-semibold tracking-tight">
            {kind === "image" ? "图片创作工作台" : "视频创作工作台"}
          </h1>
        </div>
        <div className="ob-segment" role="tablist" aria-label="工作台类型">
          <Link
            role="tab"
            aria-selected={kind === "image"}
            className="ob-segment-item no-underline"
            to="/workbench/image"
          >
            图片
          </Link>
          <Link
            role="tab"
            aria-selected={kind === "video"}
            className="ob-segment-item no-underline"
            to="/workbench/video"
          >
            视频
          </Link>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[380px_1fr]">
        <section className="relative z-10 border-b border-[var(--ob-line)] bg-[var(--ob-panel)] p-5 shadow-[var(--ob-elev-1)] lg:border-b-0 lg:border-r">
          <div className="space-y-4 text-sm">
            <label className="block">
              <span className="ob-label">提示词</span>
              <textarea
                className="ob-field min-h-32 resize-y"
                value={prompt}
                placeholder={kind === "image" ? "描述想生成的图片…" : "描述想生成的视频…"}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <label className="block">
              <span className="ob-label">渠道</span>
              <select
                className="ob-field cursor-pointer"
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
              >
                {config.channels.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="ob-label">模型</span>
              <input
                className="ob-field"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
            {kind === "image" ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="ob-label">尺寸</span>
                  <input className="ob-field" value={size} onChange={(event) => setSize(event.target.value)} />
                </label>
                <label className="block">
                  <span className="ob-label">质量</span>
                  <input className="ob-field" value={quality} onChange={(event) => setQuality(event.target.value)} />
                </label>
                <label className="block">
                  <span className="ob-label">数量</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    className="ob-field"
                    value={count}
                    onChange={(event) => setCount(Number(event.target.value) || 1)}
                  />
                </label>
                <label className="flex cursor-pointer items-center gap-2 self-end pb-2.5 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={transparent}
                    className="ob-switch"
                    data-checked={transparent ? "true" : "false"}
                    onClick={() => setTransparent((value) => !value)}
                  />
                  透明背景
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="ob-label">秒数</span>
                  <input
                    type="number"
                    min={4}
                    max={15}
                    disabled={smartDuration}
                    className="ob-field"
                    value={seconds}
                    onChange={(event) => setSeconds(Number(event.target.value) || 5)}
                  />
                </label>
                <label className="block">
                  <span className="ob-label">比例</span>
                  <input className="ob-field" value={ratio} onChange={(event) => setRatio(event.target.value)} />
                </label>
                <label className="block">
                  <span className="ob-label">清晰度</span>
                  <input className="ob-field" value={resolution} onChange={(event) => setResolution(event.target.value)} />
                </label>
                <label className="flex cursor-pointer items-center gap-2 self-end pb-2.5 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={smartDuration}
                    className="ob-switch"
                    data-checked={smartDuration ? "true" : "false"}
                    onClick={() => setSmartDuration((value) => !value)}
                  />
                  智能时长
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={generateAudio}
                    className="ob-switch"
                    data-checked={generateAudio ? "true" : "false"}
                    onClick={() => setGenerateAudio((value) => !value)}
                  />
                  生成声音
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={watermark}
                    className="ob-switch"
                    data-checked={watermark ? "true" : "false"}
                    onClick={() => setWatermark((value) => !value)}
                  />
                  水印
                </label>
              </div>
            )}
            <label className="block">
              <span className="ob-label">参考素材</span>
              <input
                type="file"
                multiple
                accept="image/*,video/*,audio/*"
                className="mt-1 block w-full cursor-pointer text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--ob-accent-soft)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--ob-accent)] hover:file:bg-[var(--ob-accent)] hover:file:text-white"
                onChange={(event) => setReferences(Array.from(event.target.files ?? []))}
              />
              {references.length ? (
                <p className="mt-1.5 text-xs text-[var(--ob-muted)]">已选 {references.length} 个参考文件</p>
              ) : null}
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                aria-label="生成"
                className="ob-btn-primary flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold"
                disabled={busy || !prompt.trim()}
                onClick={() => void run()}
              >
                {kind === "image" ? <ImagePlus size={18} /> : <Video size={18} />}
                {busy ? "生成中..." : "开始生成"}
              </button>
              <button
                type="button"
                title="停止"
                className="ob-btn-danger rounded-xl p-3"
                disabled={!busy}
                onClick={() => abortRef.current?.abort()}
              >
                <Square size={18} />
              </button>
            </div>
            {error ? (
              <p role="alert" className="rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-3 py-2 text-sm text-[var(--ob-danger)]">
                {error}
              </p>
            ) : null}
          </div>
        </section>
        <section className="min-w-0 p-5 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-[var(--ob-ink)]">生成历史</h2>
              <p className="text-xs text-[var(--ob-muted)]">最近任务与结果预览</p>
            </div>
            <button type="button" title="刷新" className="ob-icon-btn" onClick={() => void refresh()}>
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {jobs.map((job) => (
              <HistoryRow
                key={job.id}
                job={job}
                onRetry={() => void run(job)}
                onInsert={(item) => insert(item, job)}
                onDelete={async () => {
                  await deleteGenerationJob(job.id);
                  const state = useBoardStore.getState();
                  const externalKeys = collectStorageKeys(state.projects, state.assets);
                  const orphanedKeys = findUnreferencedGenerationStorageKeys(
                    job,
                    await listAllGenerationJobs(),
                    externalKeys,
                  );
                  await Promise.allSettled([...orphanedKeys].map(deleteStorageKey));
                  await refresh();
                }}
              />
            ))}
          </div>
          {!jobs.length ? (
            <div className="ob-empty mt-4 py-16">
              <span className="ob-empty-icon" aria-hidden>
                {kind === "image" ? <ImagePlus size={16} /> : <Video size={16} />}
              </span>
              <p className="ob-empty-title">暂无生成记录</p>
              <p className="ob-empty-desc">填写提示词后开始生成，结果会显示在这里，并可插入画布。</p>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function resultItems(job: GenerationJob): ResultItem[] {
  return Array.isArray(job.result.items) ? job.result.items.filter((item): item is ResultItem => Boolean(item && typeof item === "object")) : [];
}

function HistoryRow({ job, onRetry, onInsert, onDelete }: { job: GenerationJob; onRetry: () => void; onInsert: (item: ResultItem) => Promise<void>; onDelete: () => Promise<void> }) {
  const items = resultItems(job);
  const [inserting, setInserting] = useState<number | null>(null);
  const [inserted, setInserted] = useState<number | null>(null);
  const statusLabel =
    job.status === "succeeded" ? "成功"
      : job.status === "running" ? "进行中"
        : job.status === "failed" ? "失败"
          : job.status === "cancelled" ? "已取消"
            : job.status;
  return (
    <article className="ob-card p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-[var(--ob-ink)]">{job.prompt}</div>
          <div className="mt-0.5 text-xs font-medium text-[var(--ob-muted)]">
            <span className="ob-status-dot mr-1" data-status={job.status} />
            {statusLabel} · {job.model || "默认模型"}
          </div>
        </div>
        <button type="button" className="ob-icon-btn h-8 w-8" title="重试" onClick={onRetry}>
          <RefreshCw size={16} />
        </button>
        <button type="button" className="ob-btn-danger rounded-lg p-1.5" title="删除" onClick={() => void onDelete()}>
          <Trash2 size={16} />
        </button>
      </div>
      {job.error ? <p className="mb-2 text-xs text-[var(--ob-danger)]">{job.error}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        {items.map((item, index) => (
          <div key={item.storageKey ?? item.url ?? index} className="group flex min-w-0 flex-col">
            <div className="overflow-hidden rounded-xl bg-[var(--ob-canvas)]">
              <MediaPreview item={item} video={job.kind === "video"} />
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="ob-icon-btn h-8 w-8 border border-[var(--ob-line)]"
                title="下载"
                onClick={() => item.storageKey
                  ? void downloadStorageKey(item.storageKey, `${job.kind}-${index + 1}.${job.kind === "video" ? "mp4" : "png"}`)
                  : downloadURL(item.url)}
              >
                <Download size={16} />
              </button>
              <button
                type="button"
                disabled={inserting !== null}
                className="ob-btn flex-1 px-3 py-1.5 text-xs"
                onClick={() => void (async () => {
                  setInserting(index);
                  try {
                    await onInsert(item);
                    setInserted(index);
                  } finally {
                    setInserting(null);
                  }
                })()}
              >
                {inserting === index ? "插入中" : inserted === index ? "已插入" : "插入画布"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function MediaPreview({ item, video }: { item: ResultItem; video: boolean }) {
  const [url, setUrl] = useState(item.url);
  useEffect(() => {
    if (!item.storageKey) return;
    let objectURL = "";
    void getBlob(item.storageKey.startsWith("media:") ? "media" : "image", item.storageKey).then((blob) => {
      if (!blob) return;
      objectURL = URL.createObjectURL(blob);
      setUrl(objectURL);
    });
    return () => { if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [item.storageKey]);
  if (!url) return <div className="grid aspect-video place-items-center text-xs font-medium text-[var(--ob-muted)]">结果不可用</div>;
  return video ? <video src={url} controls className="aspect-video w-full object-contain" /> : <img src={url} alt="生成结果" className="aspect-video w-full object-contain" />;
}

function downloadURL(url?: string) {
  if (!url) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openboard-result";
  anchor.click();
}
