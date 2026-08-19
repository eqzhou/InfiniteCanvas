import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Expand, ImagePlus, Sparkles, Upload, X } from "lucide-react";
import type { BoardNode } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";
import {
  buildPanoramaPrompt,
  isSupportedPanoramaMimeType,
  panoramaGenerationError,
  readPanoramaBlobDimensions,
  validatePanoramaDimensions,
} from "@/lib/panorama";
import { deleteStorageKey, getBlob, uploadMedia } from "@/services/storage";
import { generateImages } from "@/services/ai-client";
import { PanoramaViewport } from "@/components/panorama/PanoramaViewport";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import {
  getPanoramaGenerationSettings,
  getPanoramaReferenceInputs,
  loadPanoramaReferenceBlobs,
  stagePanoramaGeneratedMedia,
  type PanoramaGeneratedMedia,
} from "@/lib/panorama-generation";
import { getProvider } from "@/lib/ai-config";
import { usesServerGenerationJobs } from "@/services/generation-jobs";
import {
  resumePanoramaServerGeneration,
  runPanoramaServerGeneration,
} from "@/services/panorama-server-generation";
import {
  resolveActiveAIChannel,
  useSharedChannels,
} from "@/services/shared-channels";
import { nextPanoramaPreviewZoom } from "@/lib/panorama-zoom";
import { useI18n } from "@/i18n/I18nProvider";

export function PanoramaNodeCard({ node }: { node: BoardNode }) {
  const { t } = useI18n();
  const project = useBoardStore((state) => state.getActive());
  const config = useBoardStore((state) => state.config);
  const updateNode = useBoardStore((state) => state.updateNode);
  const commitPanoramaBatch = useBoardStore((state) => state.commitPanoramaBatch);
  const persistNow = useBoardStore((state) => state.persistNow);
  const sharedChannels = useSharedChannels();
  const channel = resolveActiveAIChannel(
    config.channels,
    config.activeChannelId,
    sharedChannels,
    config.activeSharedChannelId,
  );
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const generationRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  useEscapeDismiss(open, () => setOpen(false), 130);
  useEffect(() => setPreviewZoom(1), [node.metadata.content]);
  useEffect(() => () => {
    generationRef.current?.abort(new DOMException("Panorama node closed", "AbortError"));
    generationRef.current = null;
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keepFocusInside, true);
    return () => {
      document.removeEventListener("keydown", keepFocusInside, true);
      previous?.focus();
    };
  }, [open]);
  const sourceImages = (project?.nodes ?? []).filter((candidate) => {
    if (candidate.type !== "image" || !candidate.metadata.storageKey || !candidate.metadata.content ||
        !candidate.metadata.bytes || !isSupportedPanoramaMimeType(candidate.metadata.mimeType)) return false;
    try {
      validatePanoramaDimensions(candidate.metadata.naturalWidth ?? 0, candidate.metadata.naturalHeight ?? 0);
      return true;
    } catch {
      return false;
    }
  });
  const isBatchChild = Boolean(node.metadata.batchRootId);

  const beginWrite = () => {
    if (isBatchChild) throw new Error(t("canvasNodes.panorama.batchImmutable"));
    if (generationRef.current) throw new Error(t("canvasNodes.panorama.processing"));
    const operation = new AbortController();
    generationRef.current = operation;
    setLoading(true);
    setError(null);
    return operation;
  };

  const finishWrite = (operation: AbortController) => {
    if (generationRef.current !== operation) return;
    generationRef.current = null;
    setLoading(false);
  };

  const writeWasSuperseded = (operation: AbortController) =>
    generationRef.current !== operation || operation.signal.aborted;

  const applyMedia = async (input: Blob | string) => {
    const operation = beginWrite();
    let results: PanoramaGeneratedMedia[] = [];
    try {
      const historyProject = useBoardStore.getState().getActive();
      if (!historyProject) throw new Error(t("canvasNodes.panorama.projectMissing"));
      results = await stagePanoramaGeneratedMedia(
        ["direct-upload"],
        1,
        () => uploadMedia(input, "image", {
          requirePersistent: true,
          preflightImage: readPanoramaBlobDimensions,
        }),
        deleteStorageKey,
      );
      if (writeWasSuperseded(operation)) {
        await Promise.all(results.map((result) => deleteStorageKey(result.storageKey).catch(() => undefined)));
        results = [];
        throw operation.signal.reason ?? new DOMException("Panorama upload superseded", "AbortError");
      }
      await commitPanoramaBatch(historyProject.id, node.id, results, {
        prompt: node.metadata.prompt ?? "",
        model: node.metadata.model ?? "",
        quality: node.metadata.quality ?? config.imageQuality,
        referenceStorageKeys: [],
      }, structuredClone(historyProject), true);
      results = [];
    } finally {
      finishWrite(operation);
    }
  };

  const selectSource = async (sourceId: string) => {
    const operation = beginWrite();
    try {
      const source = sourceImages.find((candidate) => candidate.id === sourceId);
      if (!source) return;
      const historyProject = useBoardStore.getState().getActive();
      if (!historyProject) throw new Error(t("canvasNodes.panorama.projectMissing"));
      await commitPanoramaBatch(historyProject.id, node.id, [{
        content: source.metadata.content!,
        storageKey: source.metadata.storageKey!,
        naturalWidth: source.metadata.naturalWidth!,
        naturalHeight: source.metadata.naturalHeight!,
        bytes: source.metadata.bytes!,
        mimeType: source.metadata.mimeType!,
      }], {
        prompt: node.metadata.prompt ?? "",
        model: node.metadata.model ?? "",
        quality: node.metadata.quality ?? config.imageQuality,
        referenceStorageKeys: [source.metadata.storageKey!],
        derivedFromId: source.id,
      }, structuredClone(historyProject), false);
    } finally {
      finishWrite(operation);
    }
  };

  const generate = async () => {
    if (generationRef.current) return;
    const operation = beginWrite();
    let uploadedResults: PanoramaGeneratedMedia[] = [];
    let commitAttempted = false;
    try {
      const historyProject = useBoardStore.getState().getActive();
      if (!historyProject) throw new Error(t("canvasNodes.panorama.projectMissing"));
      const currentNode = historyProject.nodes.find((candidate) => candidate.id === node.id);
      if (!currentNode || currentNode.type !== "panorama") throw new Error(t("canvasNodes.panorama.nodeMissing"));
      if (!channel) throw new Error(t("canvasNodes.imageChannelRequired"));
      const imageProvider = getProvider(channel, "image");
      if (!imageProvider.apiKey || !imageProvider.baseUrl || !imageProvider.model) {
        throw new Error(t("canvasNodes.imageChannelRequired"));
      }
      const prompt = buildPanoramaPrompt(currentNode.metadata.prompt ?? "");
      const settings = getPanoramaGenerationSettings(currentNode.metadata, config.imageQuality);
      const referenceInputs = getPanoramaReferenceInputs(historyProject, currentNode.id);
      const referenceStorageKeys = referenceInputs.map((input) => input.storageKey);
      const model = currentNode.metadata.model || imageProvider.model;
      if (usesServerGenerationJobs()) {
        const supported = imageProvider.protocol === "openai" || imageProvider.protocol === "gemini" ||
          (imageProvider.protocol === "template" && Boolean(imageProvider.template)) || imageProvider.protocol === "apimart" ||
          imageProvider.protocol === "kie";
        if (!supported) throw new Error(t("canvasNodes.panorama.protocolUnsupported", { protocol: imageProvider.protocol }));
        const result = await runPanoramaServerGeneration({
          projectId: historyProject.id,
          prompt,
          providerId: channel.id,
          model,
          size: settings.size,
          quality: settings.quality,
          count: settings.count,
          referenceStorageKeys,
          signal: operation.signal,
          onCreated: async (job, jobs) => {
            updateNode(currentNode.id, { metadata: {
              status: "loading",
              errorDetails: undefined,
              generationJobId: job.id,
              generationJobIds: jobs.map((item) => item.id),
              prompt: currentNode.metadata.prompt ?? "",
              model,
              quality: settings.quality,
              count: settings.count,
              referenceStorageKeys,
              generationType: referenceStorageKeys.length > 0 ? "image-to-image" : "text-to-image",
            } }, { history: false });
            await persistNow();
          },
        });
        if (writeWasSuperseded(operation)) {
          result.media.forEach((media) => URL.revokeObjectURL(media.content));
          throw operation.signal.reason ?? new DOMException("Panorama generation superseded", "AbortError");
        }
        commitAttempted = true;
        try {
          await commitPanoramaBatch(historyProject.id, currentNode.id, result.media, {
            prompt: currentNode.metadata.prompt ?? "",
            model,
            quality: settings.quality,
            referenceStorageKeys,
            generationJobId: result.jobId,
            generationJobIds: result.jobIds,
          }, structuredClone(historyProject), false);
        } catch (cause) {
          result.media.forEach((media) => URL.revokeObjectURL(media.content));
          throw cause;
        }
        return;
      }
      const referenceBlobs = await loadPanoramaReferenceBlobs(referenceInputs, (storageKey) => getBlob("image", storageKey));
      updateNode(currentNode.id, { metadata: { status: "loading", errorDetails: undefined } }, { history: false });
      const urls = await generateImages({
        channel,
        model,
        prompt,
        size: settings.size,
        quality: settings.quality,
        n: settings.count,
        referenceBlobs,
        systemPrompt: config.systemPrompt,
        signal: operation.signal,
      });
      uploadedResults = await stagePanoramaGeneratedMedia(
        urls,
        settings.count,
        (url) => uploadMedia(url, "image", {
          requirePersistent: true,
          preflightImage: readPanoramaBlobDimensions,
        }),
        deleteStorageKey,
      );
      if (writeWasSuperseded(operation)) {
        await Promise.all(uploadedResults.map((result) => deleteStorageKey(result.storageKey).catch(() => undefined)));
        uploadedResults = [];
        throw operation.signal.reason ?? new DOMException("Panorama generation superseded", "AbortError");
      }
      commitAttempted = true;
      await commitPanoramaBatch(historyProject.id, currentNode.id, uploadedResults, {
        prompt: currentNode.metadata.prompt ?? "",
        model,
        quality: settings.quality,
        referenceStorageKeys,
      }, structuredClone(historyProject), true);
      uploadedResults = [];
    } catch (cause) {
      if (!commitAttempted && uploadedResults.length > 0) {
        await Promise.all(uploadedResults.map((result) => deleteStorageKey(result.storageKey).catch(() => undefined)));
      }
      const message = panoramaGenerationError(cause);
      if (!writeWasSuperseded(operation)) {
        updateNode(node.id, { metadata: { status: "error", errorDetails: message } }, { history: false });
      }
      throw cause;
    } finally {
      if (generationRef.current === operation) {
        finishWrite(operation);
      }
    }
  };

  useEffect(() => {
    const jobId = node.metadata.generationJobId;
    if (!usesServerGenerationJobs() || node.metadata.status !== "loading" || !jobId ||
        isBatchChild || generationRef.current) return;
    const operation = beginWrite();
    void (async () => {
      try {
        const historyProject = useBoardStore.getState().getActive();
        if (!historyProject) throw new Error(t("canvasNodes.panorama.projectMissing"));
        const currentNode = historyProject.nodes.find((candidate) => candidate.id === node.id);
        if (!currentNode || currentNode.type !== "panorama") throw new Error(t("canvasNodes.panorama.nodeMissing"));
        const settings = getPanoramaGenerationSettings(currentNode.metadata, config.imageQuality);
        const storedJobIds = currentNode.metadata.generationJobIds?.length
          ? currentNode.metadata.generationJobIds
          : [jobId];
        const media = await resumePanoramaServerGeneration(
          jobId,
          historyProject.id,
          settings.count,
          operation.signal,
          undefined,
          storedJobIds,
        );
        if (writeWasSuperseded(operation)) {
          media.forEach((item) => URL.revokeObjectURL(item.content));
          return;
        }
        try {
          await commitPanoramaBatch(historyProject.id, currentNode.id, media, {
            prompt: currentNode.metadata.prompt ?? "",
            model: currentNode.metadata.model ?? "",
            quality: settings.quality,
            referenceStorageKeys: [...(currentNode.metadata.referenceStorageKeys ?? [])],
            generationJobId: jobId,
            generationJobIds: currentNode.metadata.generationJobIds,
          }, structuredClone(historyProject), false);
        } catch (cause) {
          media.forEach((item) => URL.revokeObjectURL(item.content));
          throw cause;
        }
      } catch (cause) {
        if (!writeWasSuperseded(operation)) {
          const message = panoramaGenerationError(cause);
          setError(message);
          updateNode(node.id, { metadata: { status: "error", errorDetails: message } }, { history: false });
        }
      } finally {
        finishWrite(operation);
      }
    })();
    return () => {
      operation.abort(new DOMException("Panorama node closed", "AbortError"));
      finishWrite(operation);
    };
  }, [node.id, node.metadata.generationJobId, node.metadata.generationJobIds, node.metadata.status]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-slate-950 text-white" onPointerDown={(event) => event.stopPropagation()}>
      {node.metadata.content ? (
        <>
          <div
            className="relative min-h-0 flex-1 overflow-hidden"
            onWheel={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setPreviewZoom((current) => nextPanoramaPreviewZoom(current, event.deltaY));
            }}
          >
            <img
              src={node.metadata.content}
              alt={node.title}
              className="h-full w-full object-cover transition-transform duration-75 will-change-transform"
              style={{ transform: `scale(${previewZoom})` }}
              draggable={false}
            />
            {previewZoom > 1 ? (
              <span aria-live="polite" className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/65 px-1.5 py-0.5 text-[10px] tabular-nums">
                {Math.round(previewZoom * 100)}%
              </span>
            ) : null}
          </div>
          <button type="button" aria-label={t("canvasNodes.panorama.open")} className="absolute right-2 top-2 rounded bg-black/65 p-2 hover:bg-black/80" onClick={() => setOpen(true)}><Expand size={15} /></button>
        </>
      ) : (
        <div className="grid min-h-0 flex-1 place-items-center p-3 text-center text-xs text-slate-400">
          <div><ImagePlus size={24} className="mx-auto mb-2" /><p>{t("canvasNodes.panorama.empty")}</p></div>
        </div>
      )}
      <div className="grid gap-1 border-t border-white/10 bg-black/50 p-2">
        <input aria-label={t("canvasNodes.panorama.prompt")} disabled={loading || isBatchChild} className="rounded border border-white/10 bg-white/5 px-2 py-1.5 text-xs outline-none disabled:opacity-50" placeholder={t("canvasNodes.panorama.promptPlaceholder")} value={node.metadata.prompt ?? ""} onChange={(event) => updateNode(node.id, { metadata: { prompt: event.target.value } }, { history: false })} />
        <div className="flex gap-1">
          <select aria-label={t("canvasNodes.panorama.selectSource")} disabled={loading || isBatchChild} className="min-w-0 flex-1 rounded border border-white/10 bg-slate-900 px-1 text-[11px] disabled:opacity-50" value="" onChange={(event) => void selectSource(event.target.value).catch((cause) => setError(panoramaGenerationError(cause)))}>
            <option value="">{t("canvasNodes.panorama.reuse")}</option>
            {sourceImages.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
          </select>
          <label className={`grid h-8 w-8 shrink-0 place-items-center rounded border border-white/10 ${loading || isBatchChild ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`} title={t("canvasNodes.panorama.upload")}><Upload size={14} /><input aria-label={t("canvasNodes.panorama.upload")} disabled={loading || isBatchChild} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void applyMedia(file).catch((cause) => setError(panoramaGenerationError(cause)));
            event.currentTarget.value = "";
          }} /></label>
          <button type="button" aria-label={t("canvasNodes.panorama.generate")} disabled={loading || isBatchChild} className="grid h-8 w-8 shrink-0 place-items-center rounded bg-[var(--ob-accent)] text-white disabled:opacity-50" onClick={() => void generate().catch((cause) => setError(panoramaGenerationError(cause)))}>{loading ? <span className="animate-pulse">…</span> : <Sparkles size={14} />}</button>
        </div>
        <div role="group" aria-label={t("canvasNodes.panorama.settings")} className="grid grid-cols-[1fr_5rem] gap-1">
          <label className="grid grid-cols-[2.5rem_1fr] items-center gap-1 text-[10px] text-slate-400">
            {t("canvasNodes.panorama.quality")}
            <select aria-label={t("canvasNodes.panorama.generationQuality")} disabled={loading || isBatchChild} className="min-w-0 rounded border border-white/10 bg-slate-900 px-1 py-1 text-[11px] text-white disabled:opacity-50" value={node.metadata.quality ?? config.imageQuality} onChange={(event) => updateNode(node.id, { metadata: { quality: event.target.value } })}>
              {!["auto", "low", "medium", "high"].includes(node.metadata.quality ?? config.imageQuality) ? <option value={node.metadata.quality ?? config.imageQuality}>{node.metadata.quality ?? config.imageQuality}</option> : null}
              <option value="auto">{t("canvasNodes.auto")}</option>
              <option value="low">{t("canvasNodes.low")}</option>
              <option value="medium">{t("canvasNodes.medium")}</option>
              <option value="high">{t("canvasNodes.high")}</option>
            </select>
          </label>
          <label className="grid grid-cols-[2rem_1fr] items-center gap-1 text-[10px] text-slate-400">
            {t("canvasNodes.panorama.quantity")}
            <select aria-label={t("canvasNodes.panorama.generationQuantity")} disabled={loading || isBatchChild} className="rounded border border-white/10 bg-slate-900 px-1 py-1 text-[11px] text-white disabled:opacity-50" value={node.metadata.count ?? 1} onChange={(event) => updateNode(node.id, { metadata: { count: Number(event.target.value) } })}>
              {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
        </div>
        {isBatchChild ? <p className="text-[10px] text-slate-400">{t("canvasNodes.panorama.batchHint")}</p> : null}
        {project ? (() => {
          const imageNodeIds = new Set(project.nodes.filter((candidate) => candidate.type === "image").map((candidate) => candidate.id));
          const count = new Set(project.edges.filter((edge) => edge.to === node.id && imageNodeIds.has(edge.from)).map((edge) => edge.from)).size;
          return count > 0 ? <p className="text-[10px] text-slate-400">{t("canvasNodes.panorama.referencesConnected", { count })}</p> : null;
        })() : null}
      </div>
      {(error || node.metadata.errorDetails) ? <p role="alert" className="absolute bottom-20 left-2 right-2 rounded bg-red-950/90 px-2 py-1 text-[11px] text-red-200">{error || node.metadata.errorDetails}</p> : null}
      {open && node.metadata.content ? createPortal(
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("canvasNodes.panorama.viewer")} className="fixed inset-0 z-[160] bg-black text-white">
          <PanoramaViewport sourceUrl={node.metadata.content} onError={setError} />
          <div className="absolute left-4 top-4 rounded bg-black/60 px-3 py-2 text-sm">{node.title} · {node.metadata.naturalWidth}×{node.metadata.naturalHeight}</div>
          <button ref={closeButtonRef} type="button" aria-label={t("canvasNodes.panorama.closeViewer")} className="absolute right-4 top-4 rounded bg-black/60 p-2" onClick={() => setOpen(false)}><X size={20} /></button>
        </div>, document.body) : null}
    </div>
  );
}
