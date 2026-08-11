import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ImagePlus, PanelBottom, PanelLeft, RefreshCw, Square, Trash2, Video } from "lucide-react";
import type { GenerationJob } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { getProvider } from "@/lib/ai-config";
import { resolveProviderCapability } from "@/lib/provider-capabilities";
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
  WORKBENCH_UNCATEGORIZED,
  workbenchCategories,
  workbenchImageAssets,
  workbenchRefillAssetIds,
  workbenchRefillForm,
  type WorkbenchLayout,
} from "@/lib/workbench-history";
import { AssetReferenceThumbnail, FileReferencePreviews } from "@/components/workbench/WorkbenchReferences";
import {
  WorkbenchHistoryRow,
  type WorkbenchResultItem,
} from "@/components/workbench/WorkbenchHistoryRow";
import { DraggableWorkflowEntry } from "@/components/workbench/DraggableWorkflowEntry";
import { KlingVideoControls, type KlingWorkbenchOptions } from "@/components/workbench/KlingVideoControls";
import { validateKlingVideoParameters } from "@/lib/kling-video";
import { mergeSharedChannelChoices, useSharedChannels } from "@/services/shared-channels";
import { listMediaCapabilities, type MediaCapability, type MediaCapabilityCatalog } from "@/services/media-capabilities";
import { adoptFilmCanvasMedia } from "@/services/film-client";
import { resolveWorkbenchRunChannel } from "@/lib/workbench-provider";
import {
  estimateCredits,
  formatEstimateSuffix,
  type CreditEstimate,
} from "@/services/auth-session";
import {
  imageAspectForSize,
  resolveImageSizeForAspect,
  resolvePreferredModel,
  withPreferredModel,
  type ImageAspectSelection,
} from "@/lib/workbench-preferences";
import {
  imageAspectOptionsFor,
  imageOutputLimitFor,
  imageQualityOptionsFor,
  normalizeImageAspectForProvider,
  normalizeImageQualityForProvider,
  normalizeImageSizeForProvider,
  imageSizeOptionsFor,
  optionsWithCurrentValue,
} from "@/lib/image-generation-options";
import {
  normalizeVideoRatioForProvider,
  normalizeVideoResolutionForProvider,
  optionsWithCurrentVideoValue,
  videoRatioOptionsFor,
  videoResolutionOptionsFor,
  videoSizeForProvider,
  videoSizePresetFor,
} from "@/lib/video-generation-options";
import {
  acceptsWorkbenchReference,
  MAX_REFERENCE_FILES,
  mergeReferenceFiles,
} from "@/lib/reference-files";
import { useI18n } from "@/i18n/I18nProvider";

export function CreativeWorkbench({ kind }: { kind: "image" | "video" }) {
	const { t } = useI18n();
	const [searchParams] = useSearchParams();
	const filmAssetTarget = kind === "image" ? {
		projectId: searchParams.get("filmProjectId") ?? "",
		assetId: searchParams.get("assetId") ?? "",
		revision: Number(searchParams.get("assetRevision") ?? 0),
	} : null;
  const config = useBoardStore((state) => state.config);
  const assets = useBoardStore((state) => state.assets);
  const project = useBoardStore((state) => state.getActive());
  const addNode = useBoardStore((state) => state.addNode);
  const persistNow = useBoardStore((state) => state.persistNow);
  const setConfig = useBoardStore((state) => state.setConfig);
	const sharedChannels = useSharedChannels();
	const [mediaCatalog, setMediaCatalog] = useState<MediaCapabilityCatalog | null>(null);
	const channelChoices = useMemo(() => mergeSharedChannelChoices(config.channels, sharedChannels), [config.channels, sharedChannels]);
  const [channelId, setChannelId] = useState(config.activeSharedChannelId ?? config.activeChannelId ?? config.channels[0]?.id ?? "");
  const channel = channelChoices.find((item) => item.id === channelId) ?? (channelId ? undefined : config.channels[0]);
  const provider = channel ? getProvider(channel, kind) : undefined;
  const [model, setModel] = useState(() => resolvePreferredModel(
    config.preferredModels?.[channelId]?.[kind],
    provider?.model,
    provider?.models,
  ));
  const [prompt, setPrompt] = useState(() => searchParams.get("prompt") ?? "");
  const [size, setSize] = useState(config.imageSize);
  const [imageAspect, setImageAspect] = useState<ImageAspectSelection>(() => imageAspectForSize(config.imageSize));
  const [customImageSize, setCustomImageSize] = useState(config.imageSize);
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
  const [klingOptions, setKlingOptions] = useState<KlingWorkbenchOptions>({
    negativePrompt: "", mode: "std", multiShot: false, shotType: "intelligence", shots: [], elements: [],
  });
  const [references, setReferences] = useState<File[]>([]);
  const [referenceDropActive, setReferenceDropActive] = useState(false);
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
  const [creditEstimate, setCreditEstimate] = useState<CreditEstimate | null>(null);
  const controllersRef = useRef(new Map<string, AbortController>());
  const activeServerJobIdsRef = useRef(new Map<string, string>());
  const reusableAssets = useMemo(() => workbenchImageAssets(assets), [assets]);
  const categories = useMemo(() => workbenchCategories(jobs), [jobs]);
  const visibleJobs = useMemo(() => filterWorkbenchJobs(jobs, categoryFilter), [categoryFilter, jobs]);
  const qualityOptions = useMemo(
    () => imageQualityOptionsFor(provider?.protocol, model),
    [model, provider?.protocol],
  );
  const sizeOptions = useMemo(
    () => imageSizeOptionsFor(provider?.protocol, model),
    [model, provider?.protocol],
  );
  const aspectOptions = useMemo(
    () => imageAspectOptionsFor(provider?.protocol, model),
    [model, provider?.protocol],
  );
  const videoRatioOptions = useMemo(
    () => videoRatioOptionsFor(provider?.protocol, model),
    [model, provider?.protocol],
  );
  const videoResolutionOptions = useMemo(
    () => videoResolutionOptionsFor(provider?.protocol, model),
    [model, provider?.protocol],
  );
  const videoCapability = resolveProviderCapability(provider?.protocol ?? "", "video", model)?.video;
  const videoSizePreset = videoSizePresetFor(ratio, resolution);
  const imageOutputLimit = imageOutputLimitFor(provider?.protocol, model, 8);
  const allowsEmptyKlingPrompt = kind === "video" && provider?.protocol === "apimart" && model === "kling-v3" &&
    klingOptions.multiShot && klingOptions.shotType === "customize" && klingOptions.shots.length > 0;
	const allowsEmptySeedancePrompt = kind === "video" && provider?.protocol === "apimart" &&
		["doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini"].includes(model) &&
		(references.length > 0 || selectedAssetIds.length > 0);
  const estimateUnits = kind === "image" ? Math.max(1, Math.min(100, count || 1)) : 1;
  const sharedChannelSelected = sharedChannels.some((candidate) => candidate.id === channelId);
	const sharedCapabilities = useMemo(() => {
		if (!sharedChannelSelected || !mediaCatalog) return [];
		return mediaCatalog.models.filter((item) => item.kind === kind &&
			(channelId === "shared-auto" || item.channelId === channelId));
	}, [channelId, kind, mediaCatalog, sharedChannelSelected]);
	const sharedModelOptions = useMemo(() => [...new Set(sharedCapabilities.map((item) => item.model))], [sharedCapabilities]);
  const sharedCapability = sharedCapabilities.find((item) => item.model === model);
	const sharedImageSizes = kind === "image" ? sharedCapability?.sizes ?? [] : [];
  const estimateGenerationMode = kind === "image"
    ? (references.length > 0 || selectedAssetIds.length > 0 ? "image_to_image" : "text_to_image")
    : (references.length > 0 || selectedAssetIds.length > 0 || klingOptions.elements.length > 0 ? "image_to_video" : "text_to_video");
  const preferredModel = config.preferredModels?.[channelId]?.[kind];
	const adoptAssetResult = useCallback(async (completedJob: GenerationJob, items: WorkbenchResultItem[]) => {
		if (!filmAssetTarget?.projectId || !filmAssetTarget.assetId || !Number.isSafeInteger(filmAssetTarget.revision) || filmAssetTarget.revision < 1) return;
		const first = items.find((item) => item.storageKey);
		if (!first?.storageKey) throw new Error("生成结果没有可采用的持久媒体");
		await adoptFilmCanvasMedia(filmAssetTarget.projectId, {
			targetType: "asset", targetId: filmAssetTarget.assetId, targetField: "media",
			expectedRevision: filmAssetTarget.revision, sourceNodeId: `workbench-${completedJob.id.slice(0, 100)}`,
			storageKey: first.storageKey, generationJobId: completedJob.id,
		});
	}, [filmAssetTarget?.assetId, filmAssetTarget?.projectId, filmAssetTarget?.revision]);

	useEffect(() => {
		let active = true;
		void listMediaCapabilities().then((catalog) => { if (active) setMediaCatalog(catalog); }).catch((cause) => {
			if (active) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => { active = false; };
	}, []);

	useEffect(() => {
		if (!sharedChannelSelected || !mediaCatalog) return;
		if (!sharedModelOptions.length) {
			setModel("");
			return;
		}
		if (!sharedModelOptions.includes(model)) setModel(sharedModelOptions[0]);
	}, [mediaCatalog, model, sharedChannelSelected, sharedModelOptions]);

	useEffect(() => {
		if (!sharedChannelSelected || kind !== "image" || !sharedImageSizes.length) return;
		if (!sharedImageSizes.includes(size)) {
			setSize(sharedImageSizes[0]);
			setCustomImageSize(sharedImageSizes[0]);
			setImageAspect(imageAspectForSize(sharedImageSizes[0]));
		}
	}, [kind, sharedChannelSelected, sharedImageSizes, size]);

  useEffect(() => {
    const resolved = resolvePreferredModel(preferredModel, provider?.model, provider?.models);
    setModel(resolved);
    if (preferredModel && resolved && preferredModel !== resolved) {
      const latestConfig = useBoardStore.getState().config;
      setConfig({
        ...latestConfig,
        preferredModels: withPreferredModel(latestConfig.preferredModels, channelId, kind, resolved),
      });
    }
  }, [channelId, kind, preferredModel, provider?.model, provider?.models, setConfig]);

  const rememberModel = useCallback((nextModel: string) => {
    const cleaned = nextModel.trim();
    const latestConfig = useBoardStore.getState().config;
    if (!channelId || !cleaned || latestConfig.preferredModels?.[channelId]?.[kind] === cleaned) return;
    setConfig({
      ...latestConfig,
      preferredModels: withPreferredModel(latestConfig.preferredModels, channelId, kind, cleaned),
    });
  }, [channelId, kind, setConfig]);

  useEffect(() => {
    if (kind !== "image") return;
		if (sharedChannelSelected && sharedImageSizes.length) return;
    const normalized = normalizeImageAspectForProvider(imageAspect, provider?.protocol, model);
    if (normalized !== imageAspect) {
      setImageAspect(normalized);
      if (normalized !== "custom") {
        const resolved = resolveImageSizeForAspect(normalized, provider?.protocol, model);
        setSize(resolved);
        setCustomImageSize(resolved);
      }
      return;
    }
    if (imageAspect !== "custom") {
      setSize(resolveImageSizeForAspect(imageAspect, provider?.protocol, model));
    }
  }, [imageAspect, kind, model, provider?.protocol, sharedChannelSelected, sharedImageSizes.length]);

  useEffect(() => {
    if (kind !== "image") return;
    setQuality((current) => normalizeImageQualityForProvider(current, provider?.protocol, model));
  }, [kind, model, provider?.protocol]);

  useEffect(() => {
    if (kind !== "image") return;
    setCount((current) => Math.min(Math.max(1, current), imageOutputLimit));
  }, [imageOutputLimit, kind]);

  useEffect(() => {
    if (kind !== "video") return;
    const nextRatio = normalizeVideoRatioForProvider(ratio, provider?.protocol, model);
    const nextResolution = normalizeVideoResolutionForProvider(resolution, provider?.protocol, model);
    if (nextRatio !== ratio) setRatio(nextRatio);
    if (nextResolution !== resolution) setResolution(nextResolution);
  }, [kind, model, provider?.protocol, ratio, resolution]);

  // Refresh the pre-flight cost whenever the model or unit count changes so the
  // primary button can show "预计 N 算力" without an extra click.
  useEffect(() => {
    let cancelled = false;
    const requestedModel = model.trim();
    if (!requestedModel) {
      setCreditEstimate(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void estimateCredits(requestedModel, estimateUnits, sharedChannelSelected ? {
        providerId: channelId,
        kind,
        mode: estimateGenerationMode,
      } : undefined)
        .then((estimate) => {
          if (!cancelled) setCreditEstimate(estimate);
        })
        .catch(() => {
          if (!cancelled) setCreditEstimate(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [channelId, estimateGenerationMode, estimateUnits, kind, model, sharedChannelSelected]);

  /**
   * Puts a past record back on the form so it can be adjusted before running
   * again. Distinct from retry, which re-runs the record untouched.
   */
  const refill = useCallback((job: GenerationJob) => {
    const restored = workbenchRefillForm(job, {
      prompt, model, providerId: channelId, size, quality, count,
      transparentBackground: transparent,
      category,
      referenceStorageKeys: [],
    });
    setPrompt(restored.prompt);
    setSize(restored.size);
    setCustomImageSize(restored.size);
    // Legacy jobs only record a size, not whether it came from a preset.
    setImageAspect("custom");
    setQuality(restored.quality);
    setCount(restored.count);
    setTransparent(restored.transparentBackground);
    setCategory(restored.category === WORKBENCH_UNCATEGORIZED ? "" : restored.category);
    if (kind === "video") {
      const restoredParameters = job.parameters ?? {};
      setRatio(String(restoredParameters.ratio ?? ratio));
      setResolution(String(restoredParameters.resolution ?? resolution));
      setSeconds(Number(restoredParameters.seconds ?? seconds) || seconds);
      setSmartDuration(Boolean(restoredParameters.smartDuration));
      setGenerateAudio(Boolean(restoredParameters.generateAudio));
      setWatermark(Boolean(restoredParameters.watermark));
      setFrameMode(normalizeVideoFrameMode(restoredParameters.frameMode));
    }
    const restoredChannel = channelChoices.find((item) => item.id === restored.providerId);
    if (restoredChannel) {
      const restoredProvider = getProvider(restoredChannel, kind);
      const restoredModel = resolvePreferredModel(
        restored.model,
        restoredProvider?.model,
        restoredProvider?.models,
      );
      setModel(restoredModel);
      const latestConfig = useBoardStore.getState().config;
      if (restoredModel && latestConfig.preferredModels?.[restored.providerId]?.[kind] !== restoredModel) {
        setConfig({
          ...latestConfig,
          preferredModels: withPreferredModel(
            latestConfig.preferredModels,
            restored.providerId,
            kind,
            restoredModel,
          ),
        });
      }
      setChannelId(restored.providerId);
    } else {
      setModel(restored.model);
    }

    const { assetIds, unresolved } = workbenchRefillAssetIds(restored.referenceStorageKeys, reusableAssets);
    setSelectedAssetIds(assetIds);
    // Files uploaded straight from disk have no asset to re-select, so say so
    // rather than letting the user believe the references came back.
    setReferences([]);
    setError(unresolved
      ? `已回填设置，但有 ${unresolved} 张参考图来自本地上传，需要重新选择`
      : "");
  }, [category, channelChoices, channelId, count, frameMode, generateAudio, kind, model, prompt, quality, ratio, reusableAssets, resolution, seconds, setConfig, size, smartDuration, transparent, watermark]);

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
      const removableIds = new Set(removable.map((job) => job.id));
      // Abort waiters for soft-deleted jobs so polling does not hang on tombstones.
      for (const [token, jobId] of [...activeServerJobIdsRef.current.entries()]) {
        if (removableIds.has(jobId)) {
          controllersRef.current.get(token)?.abort();
          activeServerJobIdsRef.current.delete(token);
        }
      }
      // Soft-delete keeps tombstones for multi-device history sync; media is retained until project cleanup.
      await deleteGenerationJobs(removable.map((job) => job.id));
      setSelectedJobIds((current) => current.filter((id) => !removableIds.has(id)));
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
    let runChannel;
    try {
      runChannel = resolveWorkbenchRunChannel(channelChoices, channel, source?.providerId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
		const runProvider = runChannel ? getProvider(runChannel, kind) : undefined;
		const runSharedCapability: MediaCapability | undefined = sharedChannelSelected
			? sharedCapabilities.find((item) => item.model === runModel)
			: undefined;
		if (sharedChannelSelected && !runSharedCapability) {
			setError("该共享渠道未发布当前媒体模型能力，请刷新渠道配置");
			return;
		}
		const effectiveVideoRatio = kind === "video"
			? normalizeVideoRatioForProvider(String(source?.parameters.ratio ?? ratio), runProvider?.protocol, runModel)
			: "";
		const effectiveVideoResolution = kind === "video"
			? normalizeVideoResolutionForProvider(String(source?.parameters.resolution ?? resolution), runProvider?.protocol, runModel)
			: "";
		const effectiveVideoSize = kind === "video"
			? videoSizeForProvider(runProvider?.protocol, effectiveVideoRatio, effectiveVideoResolution)
			: "";
		const allowEmptyPrompt = (kind === "video" && runProvider?.protocol === "apimart" && runModel === "kling-v3" &&
			Boolean(source ? source.parameters.multiShot && source.parameters.shotType === "customize" : klingOptions.multiShot && klingOptions.shotType === "customize" && klingOptions.shots.length)) ||
			(kind === "video" && runProvider?.protocol === "apimart" &&
				["doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini"].includes(runModel) &&
				(source ? Array.isArray(source.parameters.referenceStorageKeys) && source.parameters.referenceStorageKeys.length > 0 :
					references.length > 0 || selectedAssetIds.length > 0));
		const serverProtocolSupported = kind === "image"
			? runProvider?.protocol === "openai" || runProvider?.protocol === "gemini" ||
				(runProvider?.protocol === "template" && Boolean(runProvider.template)) || runProvider?.protocol === "apimart" || runProvider?.protocol === "kie"
			: runProvider?.protocol === "openai" || runProvider?.protocol === "ark" ||
				(runProvider?.protocol === "template" && Boolean(runProvider.template)) ||
				runProvider?.protocol === "apimart" || runProvider?.protocol === "kie" ||
				Boolean(runProvider?.baseUrl.includes("/api/v3") || runProvider?.baseUrl.includes("/api/plan/v3"));
		let runOnServer = usesServerGenerationJobs() && serverProtocolSupported;
    if (!runChannel || !runProvider?.baseUrl || (!runPrompt.trim() && !allowEmptyPrompt)) {
			setError(!runProvider?.baseUrl ? "请先在设置中配置对应模型服务 URL" : "请输入提示词或自定义镜头");
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
              ? ["image/png", "image/jpeg"].includes(blob.type)
              : runProvider?.protocol === "apimart"
                ? ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(blob.type)
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
				? ["image/png", "image/jpeg"].includes(file.type)
				: runProvider?.protocol === "apimart"
					? ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
					: /^(image|video|audio)\//.test(file.type));
          const uploaded = await uploadMedia(file, file.type.startsWith("image/") ? "image" : "media");
          uploadedReferenceKeys.push(uploaded.storageKey);
          referenceStorageKeys.push(uploaded.storageKey);
          referenceData.push(await blobToDataUrl(file));
        }
      }
		if (runSharedCapability) {
			const mode = kind === "image"
				? (referenceStorageKeys.length ? "image_to_image" : "text_to_image")
				: (referenceStorageKeys.length || klingOptions.elements.length ? "image_to_video" : "text_to_video");
			if (!runSharedCapability.modes.includes(mode)) throw new Error("当前共享模型不支持所选生成模式");
			if (referenceStorageKeys.length > runSharedCapability.maxReferences) throw new Error(`当前共享模型最多支持 ${runSharedCapability.maxReferences} 个参考素材`);
		}
		runOnServer = runOnServer && serverReferencesSupported;
		const ownerClientId = runOnServer ? "" : getRuntimeOwnerId();
		const rawParameters: Record<string, unknown> = {
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
            ...(runProvider?.protocol === "apimart" && (runModel === "kling-v2-6" || runModel === "kling-v3") ? {
              negativePrompt: klingOptions.negativePrompt,
              mode: klingOptions.mode,
              multiShot: klingOptions.multiShot,
              shotType: klingOptions.shotType,
              shots: klingOptions.shots,
              elements: klingOptions.elements,
            } : {}),
            referenceStorageKeys,
		})),
		...(kind === "video" ? {
			ratio: effectiveVideoRatio,
			resolution: effectiveVideoResolution,
			size: String(source?.parameters.size ?? "") || effectiveVideoSize,
		} : {}),
        ...(ownerClientId ? { ownerClientId } : {}),
      };
      const parameters: Record<string, unknown> = kind === "image"
        ? (() => {
            const requestedCount = Number(rawParameters.count ?? count);
            return {
              ...rawParameters,
              size: normalizeImageSizeForProvider(String(rawParameters.size ?? size)),
              quality: normalizeImageQualityForProvider(
                String(rawParameters.quality ?? quality),
                runProvider?.protocol,
                runModel,
              ),
              count: Math.min(
                Math.max(1, Number.isFinite(requestedCount) ? Math.floor(requestedCount) : 1),
                imageOutputLimitFor(runProvider?.protocol, runModel),
              ),
            };
          })()
		: rawParameters;
		if (runOnServer) {
			if (kind === "video" && runProvider.protocol === "apimart" && (runModel === "kling-v2-6" || runModel === "kling-v3")) {
				validateKlingVideoParameters({
					model: runModel,
					prompt: runPrompt,
					negativePrompt: String(parameters.negativePrompt ?? ""),
					mode: (parameters.mode ?? "std") as "std" | "pro" | "4k",
					duration: resolveVideoDuration(Boolean(parameters.smartDuration), Number(parameters.seconds ?? seconds)) ?? seconds,
					aspectRatio: String(parameters.ratio ?? ratio),
					audio: Boolean(parameters.generateAudio),
					watermark: Boolean(parameters.watermark),
					imageUrls: referenceStorageKeys.filter((_, index) => index < 2).map((_, index) => `https://local.invalid/reference-${index + 1}.png`),
					multiShot: Boolean(parameters.multiShot),
					shotType: (parameters.shotType ?? "intelligence") as "intelligence" | "customize",
					shots: Array.isArray(parameters.shots) ? parameters.shots as never[] : [],
					elements: Array.isArray(parameters.elements) ? parameters.elements as never[] : [],
				});
			}
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
					size: String(parameters.size ?? effectiveVideoSize),
					seconds: resolveVideoDuration(Boolean(parameters.smartDuration), Number(parameters.seconds ?? seconds)),
					ratio: String(parameters.ratio ?? ratio),
					resolution: String(parameters.resolution ?? resolution),
					generateAudio: Boolean(parameters.generateAudio),
					watermark: Boolean(parameters.watermark),
					frameMode: normalizeVideoFrameMode(parameters.frameMode),
					negativePrompt: String(parameters.negativePrompt ?? ""),
					mode: (parameters.mode ?? "std") as "std" | "pro" | "4k",
					multiShot: Boolean(parameters.multiShot),
					shotType: (parameters.shotType ?? "intelligence") as "intelligence" | "customize",
					shots: Array.isArray(parameters.shots) ? parameters.shots as never[] : [],
					elements: Array.isArray(parameters.elements) ? parameters.elements as never[] : [],
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
			if (completed.status === "cancelled" || completed.status === "deleted") return;
			const completedItems = Array.isArray(completed.result.items) ? completed.result.items as WorkbenchResultItem[] : [];
			await adoptAssetResult(completed, completedItems);
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
          size: String(parameters.size ?? effectiveVideoSize),
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
		const completedJob = await updateGenerationJob(job.id, { status: "succeeded", result: { items } });
		await adoptAssetResult(completedJob, items);
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
      title: kind === "image" ? t("workbench.imageNode") : t("workbench.videoNode"),
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
            {kind === "image" ? t("workbench.imageTitle") : t("workbench.videoTitle")}
          </h1>
        </div>
        <div className="ob-segment" role="tablist" aria-label={t("workbench.kind")}>
          <Link
            role="tab"
            aria-selected={kind === "image"}
            className="ob-segment-item no-underline"
            to="/workbench/image"
          >
            {t("common.image")}
          </Link>
          <Link
            role="tab"
            aria-selected={kind === "video"}
            className="ob-segment-item no-underline"
            to="/workbench/video"
          >
            {t("common.video")}
          </Link>
          <Link
            role="tab"
            aria-selected={false}
            className="ob-segment-item no-underline"
            to="/workbench/workflows"
          >
            {t("workbench.workflow")}
          </Link>
        </div>
        <div className="ob-segment ml-auto" role="group" aria-label={t("workbench.layout")}>
          <button
            type="button"
            className="ob-segment-item inline-flex items-center gap-1.5"
            aria-pressed={layout === "side"}
            onClick={() => setLayout("side")}
          >
            <PanelLeft size={15} /> {t("workbench.side")}
          </button>
          <button
            type="button"
            className="ob-segment-item inline-flex items-center gap-1.5"
            aria-pressed={layout === "bottom"}
            onClick={() => setLayout("bottom")}
          >
            <PanelBottom size={15} /> {t("workbench.bottom")}
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
              <span className="ob-label">{t("workbench.prompt")}</span>
              <textarea
                className="ob-field min-h-32 resize-y"
                value={prompt}
                placeholder={kind === "image" ? t("workbench.imagePrompt") : t("workbench.videoPrompt")}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            {kind === "image" ? (
              <label className="block">
                <span className="ob-label">{t("workbench.category")}</span>
                <input
                  className="ob-field"
                  value={category}
                  maxLength={100}
                  list="workbench-category-options"
                  placeholder={t("workbench.categoryPlaceholder")}
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
              <span className="ob-label">{t("workbench.channel")}</span>
              <select
                className="ob-field cursor-pointer"
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
              >
                {channelChoices.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="ob-label">{t("workbench.model")}</span>
              {(sharedChannelSelected ? sharedModelOptions : provider?.models)?.length ? (
                <select
                  className="ob-field cursor-pointer"
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    rememberModel(event.target.value);
                  }}
                >
                  {(sharedChannelSelected ? sharedModelOptions : provider?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              ) : (
                <input
                  className="ob-field"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  onBlur={(event) => rememberModel(event.target.value)}
                />
              )}
            </label>
            {kind === "image" ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="ob-label">{t("workbench.ratio")}</span>
                  <select
                    aria-label={t("workbench.imageRatio")}
                    className="ob-field cursor-pointer"
                    value={imageAspect}
                    onChange={(event) => {
                      const next = event.target.value as ImageAspectSelection;
                      setImageAspect(next);
                      if (next === "custom") {
                        setSize(customImageSize);
                      } else {
                        const resolved = resolveImageSizeForAspect(next, provider?.protocol, model);
                        setSize(resolved);
                        setCustomImageSize(resolved);
                      }
                    }}
                  >
                    {aspectOptions.map((preset) => (
                      <option key={preset.aspect} value={preset.aspect}>{preset.label}</option>
                    ))}
                    <option value="custom">{t("workbench.custom")}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="ob-label">{t("workbench.size")}</span>
                  <select
                    aria-label={t("workbench.imageSize")}
                    className="ob-field cursor-pointer"
                    value={size}
                    onChange={(event) => {
                      const next = event.target.value;
                      setSize(next);
                      setCustomImageSize(next);
                      setImageAspect(imageAspectForSize(next));
                    }}
                  >
                    {optionsWithCurrentValue(sharedImageSizes.length ? sharedImageSizes.map((value) => ({ value, label: value })) : sizeOptions, size).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {imageAspect === "custom" ? (
                  <label className="block">
                    <span className="ob-label">{t("workbench.customSize")}</span>
                    <input
                      aria-label={t("workbench.customImageSize")}
                      className="ob-field"
                      value={customImageSize}
                      onChange={(event) => {
                        setCustomImageSize(event.target.value);
                        setSize(event.target.value);
                      }}
                    />
                  </label>
                ) : null}
                <label className="block">
                  <span className="ob-label">{t("workbench.quality")}</span>
                  <select
                    aria-label={t("workbench.imageQuality")}
                    className="ob-field cursor-pointer"
                    value={quality}
                    onChange={(event) => setQuality(event.target.value)}
                  >
                    {optionsWithCurrentValue(qualityOptions, quality).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="ob-label">{t("workbench.count")}</span>
                  <input
                    type="number"
                    min={1}
                    max={imageOutputLimit}
                    className="ob-field"
                    value={count}
                      onChange={(event) => setCount(Math.min(imageOutputLimit, Math.max(1, Number(event.target.value) || 1)))}
                  />
                </label>
                <div className="flex items-center gap-2 self-end pb-2.5 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={transparent}
                    aria-label={t("workbench.transparent")}
                    className="ob-switch"
                    data-checked={transparent ? "true" : "false"}
                    onClick={() => setTransparent((value) => !value)}
                  />
                  <span aria-hidden="true">{t("workbench.transparent")}</span>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="ob-label">{t("workbench.seconds")}</span>
                  {sharedCapability?.durations.length ? <select
					aria-label={t("workbench.videoSeconds")}
					className="ob-field cursor-pointer"
					value={seconds}
					onChange={(event) => setSeconds(Number(event.target.value))}
				  >{sharedCapability.durations.map((value) => <option key={value} value={value}>{t("workbench.secondsValue", { seconds: value })}</option>)}</select> : <input
					type="number"
					min={4}
					max={15}
					disabled={smartDuration}
					className="ob-field"
					value={seconds}
					onChange={(event) => setSeconds(Number(event.target.value) || 5)}
				  />}
                </label>
                <label className="block">
                  <span className="ob-label">{t("workbench.ratio")}</span>
                  {sharedCapability?.ratios.length || videoCapability?.aspectRatios.length ? (
                    <select
                      aria-label={t("workbench.videoRatio")}
                      className="ob-field cursor-pointer"
                      value={ratio}
                      onChange={(event) => setRatio(event.target.value)}
                    >
                      {optionsWithCurrentVideoValue(sharedCapability?.ratios.map((value) => ({ value, label: value })) ?? videoRatioOptions, ratio).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={t("workbench.videoRatio")}
                      className="ob-field"
                      list="video-ratio-options"
                      value={ratio}
                      onChange={(event) => setRatio(event.target.value)}
                    />
                  )}
                  {!sharedCapability?.ratios.length && !videoCapability?.aspectRatios.length ? (
                    <datalist id="video-ratio-options">
                      {videoRatioOptions.map((option) => <option key={option.value} value={option.value} />)}
                    </datalist>
                  ) : null}
                </label>
                <label className="block">
                  <span className="ob-label">{t("workbench.resolution")}</span>
                  {sharedCapability?.resolutions.length || videoCapability?.resolutions?.length ? (
                    <select
                      aria-label={t("workbench.videoResolution")}
                      className="ob-field cursor-pointer"
                      value={resolution}
                      onChange={(event) => setResolution(event.target.value)}
                    >
                      {optionsWithCurrentVideoValue(sharedCapability?.resolutions.map((value) => ({ value, label: value })) ?? videoResolutionOptions, resolution).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={t("workbench.videoResolution")}
                      className="ob-field"
                      list="video-resolution-options"
                      value={resolution}
                      onChange={(event) => setResolution(event.target.value)}
                    />
                  )}
                  {!sharedCapability?.resolutions.length && !videoCapability?.resolutions?.length ? (
                    <datalist id="video-resolution-options">
                      {videoResolutionOptions.map((option) => <option key={option.value} value={option.value} />)}
                    </datalist>
                  ) : null}
                </label>
                <div className="col-span-2 flex items-center justify-between rounded-lg bg-[color-mix(in_srgb,var(--ob-accent-soft)_45%,transparent)] px-2.5 py-2 text-xs">
                  <span className="text-[var(--ob-muted)]">{t("workbench.autoSize")}</span>
                  <output aria-label={t("workbench.videoAutoSize")} className="font-medium text-[var(--ob-ink)]">
                    {videoSizePreset === "auto" ? t("workbench.modelDecides") : videoSizePreset}
                  </output>
                </div>
                <div className="flex items-center gap-2 self-end pb-2.5 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={smartDuration}
                    aria-label={t("workbench.smartDuration")}
                    className="ob-switch"
                    data-checked={smartDuration ? "true" : "false"}
                    onClick={() => setSmartDuration((value) => !value)}
                  />
                  <span aria-hidden="true">{t("workbench.smartDuration")}</span>
                </div>
                <div className="flex items-center gap-2 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={generateAudio}
                    aria-label={t("workbench.generateAudio")}
                    className="ob-switch"
                    data-checked={generateAudio ? "true" : "false"}
                    onClick={() => setGenerateAudio((value) => !value)}
                  />
                  <span aria-hidden="true">{t("workbench.generateAudio")}</span>
                </div>
                <div className="flex items-center gap-2 text-[var(--ob-muted)]">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={watermark}
                    aria-label={t("workbench.watermark")}
                    className="ob-switch"
                    data-checked={watermark ? "true" : "false"}
                    onClick={() => setWatermark((value) => !value)}
                  />
                  <span aria-hidden="true">{t("workbench.watermark")}</span>
                </div>
                <label className="col-span-2 block">
                  <span className="ob-label">{t("workbench.referenceMode")}</span>
                  <select
                    aria-label={t("workbench.referenceMode")}
                    className="ob-field"
                    value={frameMode}
                    onChange={(event) => setFrameMode(event.target.value === "first-last" ? "first-last" : "references")}
                  >
                    <option value="references">{t("workbench.references")}</option>
                    <option value="first-last">{t("workbench.firstLast")}</option>
                  </select>
                  {frameMode === "first-last" ? (
                    <p className="mt-1.5 text-xs text-[var(--ob-muted)]">
                      {t("workbench.firstLastHint")}
                    </p>
                  ) : null}
                </label>
                {provider?.protocol === "apimart" && (model === "kling-v2-6" || model === "kling-v3") ? (
                  <KlingVideoControls model={model} value={klingOptions} onChange={setKlingOptions} />
                ) : null}
              </div>
            )}
            <label
              aria-label={t("workbench.dropzone")}
              className={`block rounded-xl border border-dashed p-3 transition-colors ${
                referenceDropActive
                  ? "border-[var(--ob-accent)] bg-[var(--ob-accent-soft)]"
                  : "border-[var(--ob-line)]"
              }`}
              onDragEnter={(event) => {
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                setReferenceDropActive(true);
              }}
              onDragOver={(event) => {
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setReferenceDropActive(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setReferenceDropActive(false);
                const incoming = Array.from(event.dataTransfer.files)
                  .filter((file) => acceptsWorkbenchReference(file, kind, provider?.protocol));
                setReferences((current) => mergeReferenceFiles(
                  current,
                  incoming,
                  MAX_REFERENCE_FILES,
                ));
              }}
            >
              <span className="ob-label">{t("workbench.referenceAssets")}</span>
              <span className="mt-1 block text-xs text-[var(--ob-muted)]">
                {t("workbench.dropHint", { count: MAX_REFERENCE_FILES })}
              </span>
              <input
                type="file"
                multiple
                accept={kind === "image" ? "image/png,image/jpeg" : provider?.protocol === "apimart" ? "image/png,image/jpeg,image/webp,image/gif" : "image/*,video/*,audio/*"}
                className="mt-1 block w-full cursor-pointer text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--ob-accent-soft)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--ob-accent)] hover:file:bg-[var(--ob-accent)] hover:file:text-white"
                onChange={(event) => {
                  const incoming = Array.from(event.target.files ?? [])
                    .filter((file) => acceptsWorkbenchReference(file, kind, provider?.protocol));
                  setReferences((current) => mergeReferenceFiles(
                    current,
                    incoming,
                    MAX_REFERENCE_FILES,
                  ));
                  event.currentTarget.value = "";
                }}
              />
              {references.length ? (
                <p className="mt-1.5 text-xs text-[var(--ob-muted)]">{t("workbench.selectedFiles", { count: references.length })}</p>
              ) : null}
              <FileReferencePreviews files={references} />
            </label>
            {reusableAssets.length ? (
              <fieldset className="rounded-xl border border-[var(--ob-line)] p-3">
                <legend className="px-1 text-xs font-semibold text-[var(--ob-muted)]">{t("workbench.reuseAssets")}</legend>
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
                <p className="mt-2 text-xs text-[var(--ob-muted)]">{t("workbench.selectedAssets", { count: selectedAssetIds.length })}</p>
              </fieldset>
            ) : null}
            <div className="space-y-2 pt-1">
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-label={t("workbench.generate")}
                  className="ob-btn-primary flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold"
                  disabled={!prompt.trim() && !allowsEmptyKlingPrompt && !allowsEmptySeedancePrompt}
                  onClick={() => void run()}
                >
                  {kind === "image" ? <ImagePlus size={18} /> : <Video size={18} />}
                  {activeRuns
                    ? t("workbench.continueGenerate", { count: activeRuns })
                    : t("workbench.startGenerate", { estimate: formatEstimateSuffix(creditEstimate) })}
                </button>
                <button
                  type="button"
                  title={t("workbench.stop")}
                  className="ob-btn-danger rounded-xl p-3"
                  disabled={!activeRuns}
                  onClick={() => void stopActiveJobs()}
                >
                  <Square size={18} />
                </button>
              </div>
              {creditEstimate && !creditEstimate.sufficient ? (
                <p role="status" className="text-xs text-[var(--ob-danger)]">
                  {t("workbench.insufficientCredits", { balance: creditEstimate.balance, credits: creditEstimate.totalCredits })}
                </p>
              ) : null}
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
              <h2 className="text-base font-semibold text-[var(--ob-ink)]">{t("workbench.history")}</h2>
              <p className="text-xs text-[var(--ob-muted)]">{t("workbench.historyDescription")}</p>
            </div>
            <div className="flex items-center gap-2">
              {kind === "image" ? (
                <select
                  aria-label={t("workbench.historyCategory")}
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
                  aria-label={t("workbench.selectCurrentHistory")}
                  checked={allVisibleSelected}
                  disabled={!visibleJobs.length}
                  onChange={() => toggleSelectAllVisible()}
                />
                {t("workbench.selectAll")}
              </label>
              <button
                type="button"
                title={t("workbench.deleteBatch")}
                className="ob-btn-danger rounded-lg p-1.5"
                disabled={!selectedVisibleIds.length}
                onClick={() => void deleteSelectedHistory()}
              >
                <Trash2 size={16} />
                <span className="sr-only">{t("workbench.deleteBatch")}</span>
              </button>
              {selectedVisibleIds.length ? (
                <span className="text-xs text-[var(--ob-muted)]">{t("workbench.selectedCount", { count: selectedVisibleIds.length })}</span>
              ) : null}
              <button type="button" title={t("common.refresh")} className="ob-icon-btn" onClick={() => void refresh()}>
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
                onRefill={() => refill(job)}
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
                  // Abort any in-flight waiters for this job so waitForGenerationJob does not spin.
                  for (const [token, jobId] of activeServerJobIdsRef.current.entries()) {
                    if (jobId === job.id) {
                      controllersRef.current.get(token)?.abort();
                      activeServerJobIdsRef.current.delete(token);
                    }
                  }
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
              <p className="ob-empty-title">{t("workbench.empty")}</p>
              <p className="ob-empty-desc">{t("workbench.emptyDescription")}</p>
            </div>
          ) : null}
        </section>
      </div>
      {kind === "image" ? <DraggableWorkflowEntry /> : null}
    </div>
  );
}
