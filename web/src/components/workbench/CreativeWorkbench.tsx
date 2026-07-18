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
    setJobs(page.items);
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
      const parameters = source?.parameters ?? (kind === "image"
        ? { size, quality, count, transparentBackground: transparent, referenceStorageKeys }
        : {
            seconds,
            smartDuration,
            ratio,
            resolution,
            generateAudio,
            watermark,
            referenceStorageKeys,
          });
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
      await refresh();
    } catch (cause) {
      const cancelled = controller.signal.aborted;
      if (!job && uploadedReferenceKeys.length) {
        await Promise.allSettled(uploadedReferenceKeys.map(deleteStorageKey));
      }
      if (job) {
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
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--ob-line)] bg-[var(--ob-panel)] px-4 py-3">
        <h1 className="mr-3 text-base font-semibold">{kind === "image" ? "图片创作工作台" : "视频创作工作台"}</h1>
        <Link className={`rounded px-3 py-1.5 text-sm ${kind === "image" ? "bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]" : ""}`} to="/workbench/image">图片</Link>
        <Link className={`rounded px-3 py-1.5 text-sm ${kind === "video" ? "bg-[var(--ob-accent-soft)] text-[var(--ob-accent)]" : ""}`} to="/workbench/video">视频</Link>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[360px_1fr]">
        <section className="border-b border-[var(--ob-line)] bg-[var(--ob-panel)] p-4 lg:border-b-0 lg:border-r">
          <div className="space-y-3 text-sm">
            <label className="block">提示词<textarea className="mt-1 min-h-32 w-full resize-y rounded border border-[var(--ob-line)] bg-transparent p-2" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
            <label className="block">Provider<select className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2" value={channelId} onChange={(event) => setChannelId(event.target.value)}>{config.channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label className="block">模型<input className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2" value={model} onChange={(event) => setModel(event.target.value)} /></label>
            {kind === "image" ? (
              <div className="grid grid-cols-2 gap-2">
                <label>尺寸<input className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2" value={size} onChange={(event) => setSize(event.target.value)} /></label>
                <label>质量<input className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2" value={quality} onChange={(event) => setQuality(event.target.value)} /></label>
                <label>数量<input type="number" min={1} max={8} className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2" value={count} onChange={(event) => setCount(Number(event.target.value) || 1)} /></label>
                <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={transparent} onChange={(event) => setTransparent(event.target.checked)} />透明背景</label>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label>秒数<input type="number" min={4} max={15} disabled={smartDuration} className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2 disabled:opacity-50" value={seconds} onChange={(event) => setSeconds(Number(event.target.value) || 5)} /></label>
                <label>比例<input className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2" value={ratio} onChange={(event) => setRatio(event.target.value)} /></label>
                <label>清晰度<input className="mt-1 w-full rounded border border-[var(--ob-line)] bg-transparent p-2" value={resolution} onChange={(event) => setResolution(event.target.value)} /></label>
                <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={smartDuration} onChange={(event) => setSmartDuration(event.target.checked)} />智能时长</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={generateAudio} onChange={(event) => setGenerateAudio(event.target.checked)} />生成声音</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={watermark} onChange={(event) => setWatermark(event.target.checked)} />水印</label>
              </div>
            )}
            <label className="block">参考素材<input type="file" multiple accept="image/*,video/*,audio/*" className="mt-1 block w-full text-xs" onChange={(event) => setReferences(Array.from(event.target.files ?? []))} /></label>
            <div className="flex gap-2">
              <button type="button" className="flex flex-1 items-center justify-center gap-2 rounded bg-[var(--ob-accent)] px-3 py-2 text-white disabled:opacity-50" disabled={busy} onClick={() => void run()}>{kind === "image" ? <ImagePlus size={16} /> : <Video size={16} />}{busy ? "生成中" : "生成"}</button>
              <button type="button" title="停止" className="rounded border border-[var(--ob-line)] p-2 disabled:opacity-40" disabled={!busy} onClick={() => abortRef.current?.abort()}><Square size={16} /></button>
            </div>
            {error ? <p role="alert" className="text-[var(--ob-danger)]">{error}</p> : null}
          </div>
        </section>
        <section className="min-w-0 p-4">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">生成历史</h2><button type="button" title="刷新" onClick={() => void refresh()}><RefreshCw size={16} /></button></div>
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {jobs.map((job) => <HistoryRow key={job.id} job={job} onRetry={() => void run(job)} onInsert={(item) => insert(item, job)} onDelete={async () => {
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
            }} />)}
          </div>
          {!jobs.length ? <p className="py-16 text-center text-sm text-[var(--ob-muted)]">暂无生成记录</p> : null}
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
  return <article className="rounded border border-[var(--ob-line)] bg-[var(--ob-panel)] p-3">
    <div className="mb-2 flex items-start gap-2"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{job.prompt}</div><div className="text-xs text-[var(--ob-muted)]">{job.status} · {job.model || "默认模型"}</div></div><button type="button" title="重试" onClick={onRetry}><RefreshCw size={15} /></button><button type="button" title="删除" onClick={() => void onDelete()}><Trash2 size={15} /></button></div>
    {job.error ? <p className="mb-2 text-xs text-[var(--ob-danger)]">{job.error}</p> : null}
    <div className="grid grid-cols-2 gap-2">{items.map((item, index) => <div key={item.storageKey ?? item.url ?? index} className="min-w-0"><MediaPreview item={item} video={job.kind === "video"} /><div className="mt-1 flex gap-1"><button type="button" className="rounded border border-[var(--ob-line)] p-1" title="下载" onClick={() => item.storageKey ? void downloadStorageKey(item.storageKey, `${job.kind}-${index + 1}.${job.kind === "video" ? "mp4" : "png"}`) : downloadURL(item.url)}><Download size={14} /></button><button type="button" disabled={inserting !== null} className="rounded border border-[var(--ob-line)] px-2 py-1 text-xs disabled:opacity-50" onClick={() => void (async () => {
      setInserting(index);
      try {
        await onInsert(item);
        setInserted(index);
      } finally {
        setInserting(null);
      }
    })()}>{inserting === index ? "插入中" : inserted === index ? "已插入" : "插入画布"}</button></div></div>)}</div>
  </article>;
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
  if (!url) return <div className="grid aspect-video place-items-center bg-[var(--ob-canvas)] text-xs text-[var(--ob-muted)]">结果不可用</div>;
  return video ? <video src={url} controls className="aspect-video w-full object-contain" /> : <img src={url} alt="生成结果" className="aspect-video w-full object-contain" />;
}

function downloadURL(url?: string) {
  if (!url) return;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "openboard-result";
  anchor.click();
}
