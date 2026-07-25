import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ImagePlus, PanelBottom, PanelLeft, RefreshCw, Square, Trash2, Video } from "lucide-react";
import type { GenerationJob } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { getProvider } from "@/lib/ai-config";
import { normalizeVideoFrameMode, resolveVideoDuration } from "@/lib/video-generation";
import { assertResolvedImageReferences } from "@/lib/image-generation";
import { generateImages, generateVideo, resolveMediaRefs } from "@/services/ai-client";
import {
  createGenerationJob,
	cancelServerGenerationJob,
	createServerImageGenerationJob,
	createServerVideoGenerationJob,
  deleteGenerationJob,
  deleteGenerationJobs,
  findInterruptedGenerationJobs,
  listGenerationJobs,
	isServerOwnedGenerationJob,
  updateGenerationJob,
	usesServerGenerationJobs,
	waitForGenerationJob,
} from "@/services/generation-jobs";
import {
  blobToDataUrl,
  deleteStorageKey,
  getBlob,
  uploadMedia,
} from "@/services/storage";
import { completeGenerationActivity, getGenerationActivities } from "@/services/generation-activity";
import { getRuntimeOwnerId } from "@/services/runtime-identity";
import { uid } from "@/lib/id";
import {
  filterWorkbenchJobs,
  normalizeWorkbenchCategory,
  normalizeWorkbenchLayout,
  WORKBENCH_ALL_CATEGORIES,
  workbenchCategories,
  workbenchImageAssets,
  type WorkbenchLayout,
} from "@/lib/workbench-history";
import { AssetReferenceThumbnail, FileReferencePreviews } from "@/components/workbench/WorkbenchReferences";
import {
  WorkbenchHistoryRow,
  type WorkbenchResultItem,
} from "@/components/workbench/WorkbenchHistoryRow";
import { DraggableWorkflowEntry } from "@/components/workbench/DraggableWorkflowEntry";

export function CreativeWorkbench({ kind }: { kind: "image" | "video" }) {
  const config = useBoardStore((state) => state.config);
  const assets = useBoardStore((state) => state.assets);
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
  const [frameMode, setFrameMode] = useState<"references" | "first-last">("references");
  const [references, setReferences] = useState<File[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [category, setCategory] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(WORKBENCH_ALL_CATEGORIES);
  const [layout, setLayout] = useState<WorkbenchLayout>(() => {
    try {
      return normalizeWorkbenchLayout(window.localStorage.getItem("openboard.workbench.layout"));
    } catch {
      return "side";
    }
  });
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [activeRuns, setActiveRuns] = useState(0);
  const [error, setError] = useState("");
  const controllersRef = useRef(new Map<string, AbortController>());
  const activeServerJobIdsRef = useRef(new Map<string, string>());
  const reusableAssets = useMemo(() => workbenchImageAssets(assets), [assets]);
  const categories = useMemo(() => workbenchCategories(jobs), [jobs]);
  const visibleJobs = useMemo(() => filterWorkbenchJobs(jobs, categoryFilter), [categoryFilter, jobs]);

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

  const selectedVisibleIds = useMemo(
    () => visibleJobs.map((job) => job.id).filter((id) => selectedJobIds.includes(id)),
    [selectedJobIds, visibleJobs],
  );
  const allVisibleSelected = Boolean(visibleJobs.length) && selectedVisibleIds.length === visibleJobs.length;

  const toggleJobSelected = useCallback((jobId: string, selected: boolean) => {
    setSelectedJobIds((current) => {
      if (selected) return current.includes(jobId) ? current : [...current, jobId];
      return current.filter((id) => id !== jobId);
    });
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedJobIds((current) => {
      if (allVisibleSelected) {
        const visible = new Set(visibleJobs.map((job) => job.id));
        return current.filter((id) => !visible.has(id));
      }
      const merged = new Set(current);
      for (const job of visibleJobs) merged.add(job.id);
      return [...merged];
    });
  }, [allVisibleSelected, visibleJobs]);

  const deleteSelectedHistory = useCallback(async () => {
    const targets = visibleJobs.filter((job) => selectedJobIds.includes(job.id));
    if (!targets.length) return;
    try {
      const removable = targets.filter((job) => !(
        isServerOwnedGenerationJob(job) && (job.status === "queued" || job.status === "running")
      ));
      if (!removable.length) {
        setError("进行中的任务请先取消，再批量删除");
        return;
      }
      // Soft-delete keeps tombstones for multi-device history sync; media is retained until project cleanup.
      await deleteGenerationJobs(removable.map((job) => job.id));
      setSelectedJobIds((current) => current.filter((id) => !removable.some((job) => job.id === id)));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh, selectedJobIds, visibleJobs]);




  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [refresh]);

	useEffect(() => {
		if (!jobs.some((job) => isServerOwnedGenerationJob(job) && (job.status === "queued" || job.status === "running"))) {
			return;
		}
		const timer = window.setInterval(() => {
			void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
		}, 1_000);
		return () => window.clearInterval(timer);
	}, [jobs, refresh]);

	useEffect(() => () => {
		for (const controller of controllersRef.current.values()) controller.abort();
	}, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("openboard.workbench.layout", layout);
    } catch {
      // Layout persistence is optional in restricted browser contexts.
    }
  }, [layout]);

  useEffect(() => {
    if (!categories.includes(categoryFilter)) setCategoryFilter(WORKBENCH_ALL_CATEGORIES);
  }, [categories, categoryFilter]);

  const run = async (source?: GenerationJob) => {
    const runPrompt = source?.prompt ?? prompt;
    const runModel = source?.model ?? model;
    const runChannel = config.channels.find((item) => item.id === source?.providerId) ?? channel;
    const runProvider = runChannel ? getProvider(runChannel, kind) : undefined;
		const serverProtocolSupported = kind === "image"
			? runProvider?.protocol === "openai" || runProvider?.protocol === "gemini" ||
				(runProvider?.protocol === "template" && Boolean(runProvider.template))
			: runProvider?.protocol === "openai" || runProvider?.protocol === "ark" ||
				(runProvider?.protocol === "template" && Boolean(runProvider.template)) ||
				Boolean(runProvider?.baseUrl.includes("/api/v3") || runProvider?.baseUrl.includes("/api/plan/v3"));
		let runOnServer = usesServerGenerationJobs() && serverProtocolSupported;
    if (!runChannel || !runProvider?.baseUrl || !runPrompt.trim()) {
      setError(!runProvider?.baseUrl ? "请先在设置中配置对应模型服务 URL" : "请输入提示词");
      return;
    }
    const controller = new AbortController();
    const runToken = uid("run");
    controllersRef.current.set(runToken, controller);
    setActiveRuns((value) => value + 1);
    setError("");
    let job: GenerationJob | undefined;
    const uploadedReferenceKeys: string[] = [];
    try {
      const referenceData: string[] = [];
      const referenceStorageKeys: string[] = [];
		let serverReferencesSupported = true;
      if (source) {
        const keys = Array.isArray(source.parameters.referenceStorageKeys)
          ? source.parameters.referenceStorageKeys.filter((value): value is string => typeof value === "string")
          : [];
        for (const key of keys) {
          const blob = await getBlob(key.startsWith("media:") ? "media" : "image", key);
          if (blob) {
			serverReferencesSupported = serverReferencesSupported && (kind === "image"
				? blob.type === "image/png" || blob.type === "image/jpeg"
				: /^(image|video|audio)\//.test(blob.type));
            referenceData.push(await blobToDataUrl(blob));
            referenceStorageKeys.push(key);
          }
        }
        assertResolvedImageReferences(keys, referenceData);
      } else {
        const selectedAssets = reusableAssets.filter((asset) => selectedAssetIds.includes(asset.id));
        for (const asset of selectedAssets) {
          let storageKey = asset.storageKey;
          let content = asset.coverUrl || asset.content;
          if (!storageKey && content) {
            const uploaded = await uploadMedia(content, "image");
            storageKey = uploaded.storageKey;
            content = uploaded.url;
            uploadedReferenceKeys.push(storageKey);
          }
          const resolved = await resolveMediaRefs([{
            ...(storageKey ? { storageKey } : {}),
            ...(content ? { content } : {}),
          }], 1);
          if (!resolved[0]) throw new Error(`素材“${asset.title}”的图片内容无法恢复`);
          referenceData.push(resolved[0]);
          if (storageKey) {
            if (!referenceStorageKeys.includes(storageKey)) referenceStorageKeys.push(storageKey);
          } else {
            serverReferencesSupported = false;
          }
        }
        for (const file of references) {
			serverReferencesSupported = serverReferencesSupported && (kind === "image"
				? file.type === "image/png" || file.type === "image/jpeg"
				: /^(image|video|audio)\//.test(file.type));
          const uploaded = await uploadMedia(file, file.type.startsWith("image/") ? "image" : "media");
          uploadedReferenceKeys.push(uploaded.storageKey);
          referenceStorageKeys.push(uploaded.storageKey);
          referenceData.push(await blobToDataUrl(file));
        }
      }
		runOnServer = runOnServer && serverReferencesSupported;
		const ownerClientId = runOnServer ? "" : getRuntimeOwnerId();
		const parameters: Record<string, unknown> = {
        ...(source?.parameters ?? (kind === "image"
        ? {
            size, quality, count, transparentBackground: transparent,
            category: normalizeWorkbenchCategory(category), referenceStorageKeys,
          }
        : {
            seconds,
            smartDuration,
            ratio,
            resolution,
            generateAudio,
            watermark,
            frameMode,
            referenceStorageKeys,
          })),
        ...(ownerClientId ? { ownerClientId } : {}),
      };
		if (runOnServer) {
			if (kind === "image" && runProvider.protocol === "gemini" && Boolean(parameters.transparentBackground)) {
				throw new Error("Gemini 图片生成不支持透明背景");
			}
			if (kind === "image" && runProvider.protocol === "template" && Boolean(parameters.transparentBackground) &&
				!runProvider.template?.supportsTransparentBackground) {
				throw new Error("当前图片模板不支持透明背景");
			}
			job = kind === "image" ? await createServerImageGenerationJob({
				projectId: project?.id,
				prompt: runPrompt.trim(),
				providerId: runChannel.id,
				model: runModel,
				parameters: {
					size: String(parameters.size ?? size),
					quality: String(parameters.quality ?? quality),
					count: Number(parameters.count ?? count),
					category: normalizeWorkbenchCategory(parameters.category),
					transparentBackground: Boolean(parameters.transparentBackground),
					referenceStorageKeys,
				},
			}) : await createServerVideoGenerationJob({
				projectId: project?.id,
				prompt: runPrompt.trim(),
				providerId: runChannel.id,
				model: runModel,
				parameters: {
					size: String(parameters.size ?? ""),
					seconds: resolveVideoDuration(Boolean(parameters.smartDuration), Number(parameters.seconds ?? seconds)),
					ratio: String(parameters.ratio ?? ratio),
					resolution: String(parameters.resolution ?? resolution),
					generateAudio: Boolean(parameters.generateAudio),
					watermark: Boolean(parameters.watermark),
					frameMode: normalizeVideoFrameMode(parameters.frameMode),
					referenceStorageKeys,
				},
			});
			activeServerJobIdsRef.current.set(runToken, job.id);
			setJobs((current) => [job!, ...current.filter((item) => item.id !== job!.id)]);
			const completed = await waitForGenerationJob(job.id, {
				signal: controller.signal,
				onUpdate: (next) => setJobs((current) => [next, ...current.filter((item) => item.id !== next.id)]),
			});
			if (completed.status === "failed") throw new Error(completed.error || `${kind === "image" ? "图片" : "视频"}生成失败`);
			if (completed.status === "cancelled") return;
			await refresh();
			return;
		}
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
      setJobs((current) => [job!, ...current.filter((item) => item.id !== job!.id)]);
      const items: WorkbenchResultItem[] = [];
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
          items.push({
            url: media.url, storageKey: media.storageKey, width: media.width, height: media.height,
            bytes: media.bytes, mimeType: media.mimeType,
          });
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
          frameMode: normalizeVideoFrameMode(parameters.frameMode),
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
          const media = await uploadMedia(output.url, "media");
          items.push({
            url: media.url, storageKey: media.storageKey, width: media.width, height: media.height,
            bytes: media.bytes, mimeType: media.mimeType,
          });
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
		if (job && !isServerOwnedGenerationJob(job)) {
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
      controllersRef.current.delete(runToken);
			activeServerJobIdsRef.current.delete(runToken);
      setActiveRuns((value) => Math.max(0, value - 1));
    }
  };

	const stopActiveJobs = async () => {
		const jobIds = [...new Set(activeServerJobIdsRef.current.values())];
		const cancelled = await Promise.allSettled(jobIds.map(cancelServerGenerationJob));
		for (const result of cancelled) {
			if (result.status === "fulfilled") {
				setJobs((current) => [result.value, ...current.filter((item) => item.id !== result.value.id)]);
			} else {
				setError(result.reason instanceof Error ? result.reason.message : String(result.reason));
			}
		}
		for (const controller of controllersRef.current.values()) controller.abort();
		activeServerJobIdsRef.current.clear();
	};

  const insert = async (item: WorkbenchResultItem, job: GenerationJob) => {
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
          <Link
            role="tab"
            aria-selected={false}
            className="ob-segment-item no-underline"
            to="/workbench/workflows"
          >
            工作流
          </Link>
        </div>
        <div className="ob-segment ml-auto" role="group" aria-label="工作台布局">
          <button
            type="button"
            className="ob-segment-item inline-flex items-center gap-1.5"
            aria-pressed={layout === "side"}
            onClick={() => setLayout("side")}
          >
            <PanelLeft size={15} /> 侧边
          </button>
          <button
            type="button"
            className="ob-segment-item inline-flex items-center gap-1.5"
            aria-pressed={layout === "bottom"}
            onClick={() => setLayout("bottom")}
          >
            <PanelBottom size={15} /> 底部
          </button>
        </div>
      </header>
      <div
        data-workbench-layout={layout}
        className={layout === "side"
          ? "grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[380px_1fr]"
          : "flex min-h-0 flex-1 flex-col-reverse overflow-auto"}
      >
        <section className={layout === "side"
          ? "relative z-10 border-b border-[var(--ob-line)] bg-[var(--ob-panel)] p-5 shadow-[var(--ob-elev-1)] lg:border-b-0 lg:border-r"
          : "relative z-10 border-t border-[var(--ob-line)] bg-[var(--ob-panel)] p-5 shadow-[var(--ob-elev-1)]"}
        >
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
            {kind === "image" ? (
              <label className="block">
                <span className="ob-label">分类</span>
                <input
                  className="ob-field"
                  value={category}
                  maxLength={100}
                  list="workbench-category-options"
                  placeholder="例如：海报、角色、分镜"
                  onChange={(event) => setCategory(event.target.value)}
                />
                <datalist id="workbench-category-options">
                  {categories.filter((value) => value !== WORKBENCH_ALL_CATEGORIES).map((value) => (
                    <option key={value} value={value} />
                  ))}
                </datalist>
              </label>
            ) : null}
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
                <div className="flex items-center gap-2 self-end pb-2.5 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={transparent}
                    aria-label="透明背景"
                    className="ob-switch"
                    data-checked={transparent ? "true" : "false"}
                    onClick={() => setTransparent((value) => !value)}
                  />
                  <span aria-hidden="true">透明背景</span>
                </div>
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
                <div className="flex items-center gap-2 self-end pb-2.5 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={smartDuration}
                    aria-label="智能时长"
                    className="ob-switch"
                    data-checked={smartDuration ? "true" : "false"}
                    onClick={() => setSmartDuration((value) => !value)}
                  />
                  <span aria-hidden="true">智能时长</span>
                </div>
                <div className="flex items-center gap-2 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={generateAudio}
                    aria-label="生成声音"
                    className="ob-switch"
                    data-checked={generateAudio ? "true" : "false"}
                    onClick={() => setGenerateAudio((value) => !value)}
                  />
                  <span aria-hidden="true">生成声音</span>
                </div>
                <div className="flex items-center gap-2 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={watermark}
                    aria-label="水印"
                    className="ob-switch"
                    data-checked={watermark ? "true" : "false"}
                    onClick={() => setWatermark((value) => !value)}
                  />
                  <span aria-hidden="true">水印</span>
                </div>
                <label className="col-span-2 block">
                  <span className="ob-label">图片参考模式</span>
                  <select
                    aria-label="图片参考模式"
                    className="ob-field"
                    value={frameMode}
                    onChange={(event) => setFrameMode(event.target.value === "first-last" ? "first-last" : "references")}
                  >
                    <option value="references">普通参考图</option>
                    <option value="first-last">首尾帧</option>
                  </select>
                  {frameMode === "first-last" ? (
                    <p className="mt-1.5 text-xs text-[var(--ob-muted)]">
                      按参考图片顺序：第 1 张为首帧，第 2 张为尾帧；其余仍作为参考图。
                    </p>
                  ) : null}
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
              <FileReferencePreviews files={references} />
            </label>
            {reusableAssets.length ? (
              <fieldset className="rounded-xl border border-[var(--ob-line)] p-3">
                <legend className="px-1 text-xs font-semibold text-[var(--ob-muted)]">从“我的素材”复用</legend>
                <div className="mt-1 grid max-h-40 grid-cols-2 gap-2 overflow-auto">
                  {reusableAssets.map((asset) => {
                    const selected = selectedAssetIds.includes(asset.id);
                    return (
                      <label key={asset.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--ob-line)] p-2 text-xs">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => setSelectedAssetIds((current) => selected
                            ? current.filter((id) => id !== asset.id)
                            : [...current, asset.id])}
                        />
                        <AssetReferenceThumbnail asset={asset} />
                        <span className="min-w-0 truncate">{asset.title}</span>
                      </label>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-[var(--ob-muted)]">已选 {selectedAssetIds.length} 个素材</p>
              </fieldset>
            ) : null}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                aria-label="生成"
                className="ob-btn-primary flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold"
                disabled={!prompt.trim()}
                onClick={() => void run()}
              >
                {kind === "image" ? <ImagePlus size={18} /> : <Video size={18} />}
                {activeRuns ? `继续生成（${activeRuns} 个进行中）` : "开始生成"}
              </button>
              <button
                type="button"
                title="停止"
                className="ob-btn-danger rounded-xl p-3"
                disabled={!activeRuns}
				onClick={() => void stopActiveJobs()}
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
            <div className="flex items-center gap-2">
              {kind === "image" ? (
                <select
                  aria-label="生成历史分类"
                  className="ob-field min-w-28 py-1.5 text-xs"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                >
                  {categories.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              ) : null}
              <label className="flex items-center gap-1 text-xs text-[var(--ob-muted)]">
                <input
                  type="checkbox"
                  aria-label="全选当前历史"
                  checked={allVisibleSelected}
                  disabled={!visibleJobs.length}
                  onChange={() => toggleSelectAllVisible()}
                />
                全选
              </label>
              <button
                type="button"
                title="批量删除"
                className="ob-btn-danger rounded-lg p-1.5"
                disabled={!selectedVisibleIds.length}
                onClick={() => void deleteSelectedHistory()}
              >
                <Trash2 size={16} />
                <span className="sr-only">批量删除</span>
              </button>
              {selectedVisibleIds.length ? (
                <span className="text-xs text-[var(--ob-muted)]">已选 {selectedVisibleIds.length}</span>
              ) : null}
              <button type="button" title="刷新" className="ob-icon-btn" onClick={() => void refresh()}>
                <RefreshCw size={18} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {visibleJobs.map((job) => (
              <WorkbenchHistoryRow
                key={job.id}
                job={job}
                selected={selectedJobIds.includes(job.id)}
                onSelectedChange={(selected) => toggleJobSelected(job.id, selected)}
                onRetry={() => void run(job)}
                onInsert={(item) => insert(item, job)}
				onCancel={isServerOwnedGenerationJob(job) && (job.status === "queued" || job.status === "running")
					? async () => {
						try {
							const cancelled = await cancelServerGenerationJob(job.id);
							setJobs((current) => [cancelled, ...current.filter((item) => item.id !== cancelled.id)]);
						} catch (cause) {
							setError(cause instanceof Error ? cause.message : String(cause));
						}
					}
					: undefined}
                onDelete={async () => {
                  // Soft-delete hides the card while retaining a sync tombstone and media ownership.
                  await deleteGenerationJob(job.id);
                  setSelectedJobIds((current) => current.filter((id) => id !== job.id));
                  await refresh();
                }}
              />
            ))}
          </div>
          {!visibleJobs.length ? (
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
      {kind === "image" ? <DraggableWorkflowEntry /> : null}
    </div>
  );
}
