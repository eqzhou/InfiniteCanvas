import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ImagePlus, PanelBottom, PanelLeft, RefreshCw, Sparkles, Square, Trash2, Video } from "lucide-react";
import type { GenerationJob } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import { getProvider } from "@/lib/ai-config";
import { resolveProviderCapability } from "@/lib/provider-capabilities";
import { normalizeVideoFrameMode } from "@/lib/video-generation";
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
import { enrichResultItemsWithPreviews, uploadDisplayMedia } from "@/services/media-preview";
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
import {
  intersectMediaCapabilities,
  listMediaCapabilities,
  type MediaCapability,
  type MediaCapabilityCatalog,
} from "@/services/media-capabilities";
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
  normalizeVideoDuration,
  normalizeVideoRatioForProvider,
  normalizeVideoResolutionForProvider,
  optionsWithCurrentVideoValue,
  resolveVideoDurationForProvider,
  videoDurationOptionsFor,
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
import { useOptionalAuth } from "@/components/auth/AuthGate";
import { hasTenantOwnerCapability } from "@/services/admin";
import { useLazyAssets, useLazyProjects } from "@/hooks/use-lazy-workspace";
import { PageSkeleton } from "@/components/layout/PageSkeleton";
import { WorkspaceLoadError } from "@/components/layout/WorkspaceLoadError";

export function CreativeWorkbench({ kind }: { kind: "image" | "video" }) {
	const { t } = useI18n();
	const auth = useOptionalAuth();
	const tenantOwner = hasTenantOwnerCapability(auth);
	const [searchParams] = useSearchParams();
	const filmAssetTarget = kind === "image" ? {
		projectId: searchParams.get("filmProjectId") ?? "",
		assetId: searchParams.get("assetId") ?? "",
		revision: Number(searchParams.get("assetRevision") ?? 0),
	} : null;
  const config = useBoardStore((state) => state.config);
  const assets = useBoardStore((state) => state.assets);
  const { ready, projectsState, projectsError, loadProjectsOnDemand } = useLazyProjects();
  const { assetsState, assetsError, loadAssetsOnDemand } = useLazyAssets();
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
  const [statusFilter, setStatusFilter] = useState("succeeded");
  const [page, setPage] = useState(1);
  const [totalJobs, setTotalJobs] = useState(0);
  const PAGE_SIZE = 24;
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
  const visibleJobs = useMemo(
    () => filterWorkbenchJobs(jobs, categoryFilter, statusFilter),
    [categoryFilter, jobs, statusFilter],
  );
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
	const estimateGenerationMode = kind === "image"
		? (references.length > 0 || selectedAssetIds.length > 0 ? "image_to_image" : "text_to_image")
		: (references.length > 0 || selectedAssetIds.length > 0 || klingOptions.elements.length > 0 ? "image_to_video" : "text_to_video");
	const sharedModelOptions = useMemo(() => {
    const eligible = sharedCapabilities.filter((item) => item.modes.includes(estimateGenerationMode));
    const models = [...new Set(eligible.map((item) => item.model))];
    return channelId === "shared-auto"
      ? models.filter((candidate) => intersectMediaCapabilities(eligible.filter((item) => item.model === candidate)))
      : models;
  }, [channelId, estimateGenerationMode, sharedCapabilities]);
  const sharedCapability = useMemo(() => {
    const matching = sharedCapabilities.filter((item) => item.model === model && item.modes.includes(estimateGenerationMode));
    return channelId === "shared-auto" ? intersectMediaCapabilities(matching) : matching[0];
  }, [channelId, estimateGenerationMode, model, sharedCapabilities]);
  const availableVideoDurations = useMemo(() => {
    if (sharedCapability?.durations.length) return sharedCapability.durations;
    return videoDurationOptionsFor(provider?.protocol, model);
  }, [model, provider?.protocol, sharedCapability?.durations]);
	const sharedImageSizes = kind === "image" ? sharedCapability?.sizes ?? [] : [];
  const preferredModel = config.preferredModels?.[channelId]?.[kind];
	const adoptAssetResult = useCallback(async (completedJob: GenerationJob, items: WorkbenchResultItem[]) => {
		if (!filmAssetTarget?.projectId || !filmAssetTarget.assetId || !Number.isSafeInteger(filmAssetTarget.revision) || filmAssetTarget.revision < 1) return;
		const first = items.find((item) => item.storageKey);
		if (!first?.storageKey) throw new Error(t("creative.adoptMediaMissing"));
		await adoptFilmCanvasMedia(filmAssetTarget.projectId, {
			targetType: "asset", targetId: filmAssetTarget.assetId, targetField: "media",
			expectedRevision: filmAssetTarget.revision, sourceNodeId: `workbench-${completedJob.id.slice(0, 100)}`,
			storageKey: first.storageKey, generationJobId: completedJob.id,
		});
	}, [filmAssetTarget?.assetId, filmAssetTarget?.projectId, filmAssetTarget?.revision, t]);

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
    const nextRatio = sharedCapability?.ratios.length
      ? sharedCapability.ratios.includes(ratio) ? ratio : sharedCapability.ratios[0]!
      : normalizeVideoRatioForProvider(ratio, provider?.protocol, model);
    const nextResolution = sharedCapability?.resolutions.length
      ? sharedCapability.resolutions.includes(resolution) ? resolution : sharedCapability.resolutions[0]!
      : normalizeVideoResolutionForProvider(resolution, provider?.protocol, model);
    const nextSeconds = normalizeVideoDuration(seconds, availableVideoDurations);
    if (nextRatio !== ratio) setRatio(nextRatio);
    if (nextResolution !== resolution) setResolution(nextResolution);
    if (nextSeconds !== seconds) setSeconds(nextSeconds);
    if (availableVideoDurations.length && smartDuration) setSmartDuration(false);
  }, [
    availableVideoDurations,
    kind,
    model,
    provider?.protocol,
    ratio,
    resolution,
    seconds,
    sharedCapability?.ratios,
    sharedCapability?.resolutions,
    smartDuration,
  ]);

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
    setError(unresolved ? t("creative.refillWarning", { count: unresolved }) : "");
  }, [category, channelChoices, channelId, count, frameMode, generateAudio, kind, model, prompt, quality, ratio, reusableAssets, resolution, seconds, setConfig, size, smartDuration, t, transparent, watermark]);

  const refresh = useCallback(async (targetPage = page, targetStatus = statusFilter) => {
    const res = await listGenerationJobs({
      projectId: project?.id,
      kind,
      status: targetStatus,
      page: targetPage,
      pageSize: PAGE_SIZE,
    });
    const interrupted = findInterruptedGenerationJobs(
      res.items,
      getRuntimeOwnerId(),
      new Set(getGenerationActivities().filter((item) => item.status === "running").map((item) => item.id)),
    );
    const recovered = new Map((await Promise.all(interrupted.map((job) =>
      updateGenerationJob(job.id, {
        status: "failed",
        error: t("creative.interrupted"),
      })))).map((job) => [job.id, job]));
    setJobs(res.items.map((job) => recovered.get(job.id) ?? job));
    setTotalJobs(res.total);
    setPage(res.page);
  }, [kind, page, project?.id, statusFilter, t]);

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
    if (!tenantOwner) return;
    const targets = visibleJobs.filter((job) => selectedJobIds.includes(job.id));
    if (!targets.length) return;
    try {
      const removable = targets.filter((job) => !(
        isServerOwnedGenerationJob(job) && (job.status === "queued" || job.status === "running")
      ));
      if (!removable.length) {
        setError(t("creative.runningDeleteWarning"));
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
  }, [refresh, selectedJobIds, t, tenantOwner, visibleJobs]);

  const deleteHistoryJob = useCallback(async (job: GenerationJob) => {
    try {
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh]);




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
    const runSharedChannelSelected = sharedChannels.some((candidate) => candidate.id === runChannel?.id);
    const runGenerationMode = kind === "image"
      ? (source ? Array.isArray(source.parameters.referenceStorageKeys) && source.parameters.referenceStorageKeys.length > 0 : references.length > 0 || selectedAssetIds.length > 0)
        ? "image_to_image" : "text_to_image"
      : (source ? Array.isArray(source.parameters.referenceStorageKeys) && source.parameters.referenceStorageKeys.length > 0 : references.length > 0 || selectedAssetIds.length > 0 || klingOptions.elements.length > 0)
        ? "image_to_video" : "text_to_video";
    const matchingRunCapabilities = sharedCapabilities.filter((item) => item.model === runModel && item.modes.includes(runGenerationMode));
		const runSharedCapability: MediaCapability | undefined = runSharedChannelSelected
      ? runChannel?.id === "shared-auto"
        ? intersectMediaCapabilities(matchingRunCapabilities)
        : matchingRunCapabilities.find((item) => item.channelId === runChannel?.id)
			: undefined;
		if (runSharedChannelSelected && !runSharedCapability) {
			setError(t("creative.sharedCapabilityMissing"));
			return;
		}
		const requestedVideoRatio = String(source?.parameters.ratio ?? ratio);
		const requestedVideoResolution = String(source?.parameters.resolution ?? resolution);
		const effectiveVideoRatio = kind === "video"
			? runSharedCapability?.ratios.length
				? runSharedCapability.ratios.includes(requestedVideoRatio) ? requestedVideoRatio : runSharedCapability.ratios[0]!
				: normalizeVideoRatioForProvider(requestedVideoRatio, runProvider?.protocol, runModel)
			: "";
		const effectiveVideoResolution = kind === "video"
			? runSharedCapability?.resolutions.length
				? runSharedCapability.resolutions.includes(requestedVideoResolution) ? requestedVideoResolution : runSharedCapability.resolutions[0]!
				: normalizeVideoResolutionForProvider(requestedVideoResolution, runProvider?.protocol, runModel)
			: "";
		const runVideoDurations = kind === "video"
			? runSharedCapability ? runSharedCapability.durations : videoDurationOptionsFor(runProvider?.protocol, runModel)
			: [];
		const effectiveVideoSeconds = kind === "video" ? resolveVideoDurationForProvider(
			Boolean(source?.parameters.smartDuration ?? smartDuration),
			Number(source?.parameters.seconds ?? seconds),
			runProvider?.protocol,
			runModel,
			runVideoDurations,
		) : undefined;
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
			setError(!runProvider?.baseUrl ? t("creative.providerUrlMissing") : t("creative.promptMissing"));
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
          if (!resolved[0]) throw new Error(t("creative.assetRestoreFailed", { title: asset.title }));
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
				if (!runSharedCapability.modes.includes(mode)) throw new Error(t("creative.modeUnsupported"));
				if (referenceStorageKeys.length > runSharedCapability.maxReferences) throw new Error(t("creative.referenceLimit", { count: runSharedCapability.maxReferences }));
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
			seconds: effectiveVideoSeconds,
			smartDuration: effectiveVideoSeconds === undefined,
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
					duration: resolveVideoDurationForProvider(Boolean(parameters.smartDuration), Number(parameters.seconds ?? seconds), runProvider.protocol, runModel, runVideoDurations) ?? seconds,
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
					throw new Error(t("creative.transparentGemini"));
			}
			if (kind === "image" && runProvider.protocol === "template" && Boolean(parameters.transparentBackground) &&
				!runProvider.template?.supportsTransparentBackground) {
					throw new Error(t("creative.transparentTemplate"));
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
					seconds: resolveVideoDurationForProvider(Boolean(parameters.smartDuration), Number(parameters.seconds ?? seconds), runProvider.protocol, runModel, runVideoDurations),
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
				if (completed.status === "failed") throw new Error(completed.error || t("creative.generationFailed", { kind: t(kind === "image" ? "common.image" : "common.video") }));
			if (completed.status === "cancelled" || completed.status === "deleted") return;
			const completedItems = Array.isArray(completed.result.items) ? completed.result.items as WorkbenchResultItem[] : [];
			const previewItems = await enrichResultItemsWithPreviews(completedItems);
			if (previewItems.some((item, index) => item.thumbnailStorageKey !== completedItems[index]?.thumbnailStorageKey)) {
				await updateGenerationJob(completed.id, { result: { ...completed.result, items: previewItems } });
			}
			await adoptAssetResult(completed, previewItems);
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
          const media = await uploadDisplayMedia(url, "image");
          items.push({
            url: media.url, storageKey: media.storageKey, width: media.width, height: media.height,
            bytes: media.bytes, mimeType: media.mimeType,
            thumbnailUrl: media.thumbnailUrl, thumbnailStorageKey: media.thumbnailStorageKey,
          });
        }
      } else {
        const output = await generateVideo({
          channel: runChannel,
          model: runModel,
          prompt: runPrompt.trim(),
		  seconds: resolveVideoDurationForProvider(
		    Boolean(parameters.smartDuration),
		    Number(parameters.seconds ?? seconds),
		    runProvider.protocol,
		    runModel,
		    runVideoDurations,
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
        if (!output.url) throw new Error(t("creative.videoUrlMissing"));
        try {
          const media = await uploadDisplayMedia(output.url, "media", { previewKind: "video" });
          items.push({
            url: media.url, storageKey: media.storageKey, width: media.width, height: media.height,
            bytes: media.bytes, mimeType: media.mimeType,
            thumbnailUrl: media.thumbnailUrl, thumbnailStorageKey: media.thumbnailStorageKey,
          });
        } catch {
          items.push({ url: output.url, mimeType: "video/mp4" });
        }
      }
      if (!items.length) throw new Error(t("creative.resultsMissing"));
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
          cancelled ? t("creative.cancelled") : cause instanceof Error ? cause.message : String(cause),
        );
        await updateGenerationJob(job.id, {
          status: cancelled ? "cancelled" : "failed",
          error: cancelled ? t("creative.cancelled") : cause instanceof Error ? cause.message : String(cause),
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

  if (!ready || projectsState === "idle" || projectsState === "loading") {
    return <PageSkeleton />;
  }
  if (projectsState === "error") {
    return (
      <WorkspaceLoadError
        message={t("workspace.loadFailed", { message: projectsError ?? "" })}
        onRetry={() => { void loadProjectsOnDemand(); }}
      />
    );
  }

  const insert = async (item: WorkbenchResultItem, job: GenerationJob) => {
    if (!project) throw new Error(t("assets.openCanvasFirst"));
    const viewport = project.viewport;
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
        thumbnailStorageKey: item.thumbnailStorageKey,
        thumbnailUrl: item.thumbnailUrl,
        prompt: job.prompt,
        model: job.model,
        status: "success",
      },
    });
    await persistNow();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ob-canvas)]">
      {assetsState === "error" ? (
        <div role="alert" className="ob-banner rounded-none" data-tone="warning">
          <span className="min-w-0 flex-1">{t("workspace.loadFailed", { message: assetsError ?? "" })}</span>
          <button type="button" className="ob-btn" onClick={() => { void loadAssetsOnDemand(); }}>
            {t("workspace.retry")}
          </button>
        </div>
      ) : null}
      <header className="flex items-center gap-3 border-b border-[var(--ob-line)] bg-[var(--ob-panel-glass)] px-4 py-3 shadow-[var(--ob-elev-1)] backdrop-blur-md">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-[var(--ob-accent-soft)] to-[var(--ob-canvas)] text-[var(--ob-accent)] ring-1 ring-[color-mix(in_srgb,var(--ob-accent)_20%,transparent)] shadow-xs shrink-0">
            {kind === "image" ? <ImagePlus size={16} /> : <Video size={16} />}
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-bold tracking-tight text-[var(--ob-ink)] sm:text-base">
              {kind === "image" ? t("workbench.imageTitle") : t("workbench.videoTitle")}
            </h1>
          </div>
        </div>
        <div className="ob-segment rounded-xl p-0.5 bg-[var(--ob-canvas)] border border-[var(--ob-line)]/50" role="tablist" aria-label={t("workbench.kind")}>
          <Link
            role="tab"
            aria-selected={kind === "image"}
            className="ob-segment-item no-underline rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer inline-flex items-center gap-1.5"
            to="/workbench/image"
          >
            <ImagePlus size={14} />
            {t("common.image")}
          </Link>
          <Link
            role="tab"
            aria-selected={kind === "video"}
            className="ob-segment-item no-underline rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer inline-flex items-center gap-1.5"
            to="/workbench/video"
          >
            <Video size={14} />
            {t("common.video")}
          </Link>
          <Link
            role="tab"
            aria-selected={false}
            className="ob-segment-item no-underline rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer inline-flex items-center gap-1.5"
            to="/workbench/workflows"
          >
            <Sparkles size={14} />
            {t("workbench.workflow")}
          </Link>
        </div>
        <div className="ob-segment ml-auto rounded-xl p-0.5 bg-[var(--ob-canvas)] border border-[var(--ob-line)]/50" role="group" aria-label={t("workbench.layout")}>
          <button
            type="button"
            className="ob-segment-item inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
            aria-pressed={layout === "side"}
            onClick={() => setLayout("side")}
          >
            <PanelLeft size={14} /> {t("workbench.side")}
          </button>
          <button
            type="button"
            className="ob-segment-item inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
            aria-pressed={layout === "bottom"}
            onClick={() => setLayout("bottom")}
          >
            <PanelBottom size={14} /> {t("workbench.bottom")}
          </button>
        </div>
      </header>
      <div
        data-workbench-layout={layout}
        className={layout === "side"
          ? "grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[380px_minmax(0,1fr)]"
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
                  {availableVideoDurations.length ? (
                    <select
                      aria-label={t("workbench.videoSeconds")}
                      className="ob-field cursor-pointer"
                      value={seconds}
                      onChange={(event) => setSeconds(Number(event.target.value))}
                    >
                      {availableVideoDurations.map((value) => (
                        <option key={value} value={value}>
                          {t("workbench.secondsValue", { seconds: value })}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      min={4}
                      max={15}
                      disabled={smartDuration}
                      className="ob-field"
                      value={seconds}
                      onChange={(event) => setSeconds(Number(event.target.value) || 5)}
                    />
                  )}
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
                    aria-checked={availableVideoDurations.length === 0 && smartDuration}
                    aria-label={t("workbench.smartDuration")}
                    className="ob-switch"
                    data-checked={availableVideoDurations.length === 0 && smartDuration ? "true" : "false"}
                    disabled={availableVideoDurations.length > 0}
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
            <div className="space-y-2 pt-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-label={t("workbench.generate")}
                  className="ob-btn-primary flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 font-bold text-sm shadow-md shadow-[var(--ob-accent)]/20 transition-all hover:shadow-lg hover:shadow-[var(--ob-accent)]/30 active:scale-[0.99]"
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
                  className="ob-btn-danger rounded-xl p-3 shadow-xs"
                  disabled={!activeRuns}
                  onClick={() => void stopActiveJobs()}
                >
                  <Square size={18} />
                </button>
              </div>
              {creditEstimate && !creditEstimate.sufficient ? (
                <p role="status" className="rounded-lg bg-[color-mix(in_srgb,var(--ob-danger)_10%,transparent)] border border-[color-mix(in_srgb,var(--ob-danger)_25%,transparent)] px-3 py-2 text-xs font-medium text-[var(--ob-danger)]">
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
        <section className="min-w-0 p-4 sm:p-5">
          <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--ob-line)]/50 pb-3">
            <div className="flex items-center gap-2 min-w-0 shrink">
              <h2 className="text-base font-semibold text-[var(--ob-ink)] whitespace-nowrap">{t("workbench.history")}</h2>
              <p className="hidden text-xs text-[var(--ob-muted)] truncate 2xl:inline">{t("workbench.historyDescription")}</p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              <select
                aria-label={t("tasks.statusFilter")}
                className="ob-field w-auto shrink-0 cursor-pointer py-1 px-2.5 text-xs font-medium"
                value={statusFilter}
                onChange={(event) => {
                  const next = event.target.value;
                  setStatusFilter(next);
                  setPage(1);
                  void refresh(1, next);
                }}
              >
                <option value="succeeded">{t("tasks.succeeded")}</option>
                <option value="failed">{t("tasks.failed")}</option>
                <option value="all">{t("tasks.allStatuses")}</option>
              </select>
              {kind === "image" ? (
                <select
                  aria-label={t("workbench.historyCategory")}
                  className="ob-field w-auto shrink-0 cursor-pointer py-1 px-2.5 text-xs"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                >
                  {categories.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              ) : null}
              {tenantOwner ? (
                <div className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
                  <label className="flex items-center gap-1 text-xs font-medium text-[var(--ob-muted)] cursor-pointer select-none whitespace-nowrap hover:text-[var(--ob-ink)]">
                    <input
                      type="checkbox"
                      aria-label={t("workbench.selectCurrentHistory")}
                      checked={allVisibleSelected}
                      disabled={!visibleJobs.length}
                      className="rounded text-[var(--ob-accent)] focus:ring-0 cursor-pointer"
                      onChange={() => toggleSelectAllVisible()}
                    />
                    <span>{t("workbench.selectAll")}</span>
                  </label>
                  <button
                    type="button"
                    title={t("workbench.deleteBatch")}
                    className="ob-btn-danger inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs shadow-xs cursor-pointer disabled:opacity-40"
                    disabled={!selectedVisibleIds.length}
                    onClick={() => void deleteSelectedHistory()}
                  >
                    <Trash2 size={13} />
                    <span>{t("common.delete")}</span>
                  </button>
                  {selectedVisibleIds.length ? (
                    <span className="text-xs font-medium text-[var(--ob-muted)] whitespace-nowrap">
                      {t("workbench.selectedCount", { count: selectedVisibleIds.length })}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <button type="button" title={t("common.refresh")} className="ob-icon-btn shrink-0" onClick={() => void refresh()}>
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {visibleJobs.map((job) => (
              <WorkbenchHistoryRow
                key={job.id}
                job={job}
                selected={tenantOwner && selectedJobIds.includes(job.id)}
                onSelectedChange={tenantOwner ? (selected) => toggleJobSelected(job.id, selected) : undefined}
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
                onDelete={tenantOwner ? () => deleteHistoryJob(job) : undefined}
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
          {totalJobs > 0 ? (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ob-line)]/70 pt-4 text-xs">
              <span className="text-[var(--ob-muted)] font-medium">
                {t("common.pageTotal", {
                  page,
                  pages: Math.max(1, Math.ceil(totalJobs / PAGE_SIZE)),
                  total: totalJobs,
                })}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  className="ob-btn ob-btn-secondary rounded-lg px-3 py-1.5 font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => {
                    const prev = Math.max(1, page - 1);
                    setPage(prev);
                    void refresh(prev, statusFilter);
                  }}
                >
                  {t("common.previousPage")}
                </button>
                <span className="grid h-7 min-w-7 place-items-center rounded-md bg-[var(--ob-canvas)] border border-[var(--ob-line)] px-2 font-semibold text-[var(--ob-ink)] shadow-xs">
                  {page}
                </span>
                <button
                  type="button"
                  disabled={page * PAGE_SIZE >= totalJobs}
                  className="ob-btn ob-btn-secondary rounded-lg px-3 py-1.5 font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={() => {
                    const next = page + 1;
                    setPage(next);
                    void refresh(next, statusFilter);
                  }}
                >
                  {t("common.nextPage")}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
      {kind === "image" ? <DraggableWorkflowEntry /> : null}
    </div>
  );
}
