import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Box, Camera, FileBox, Lightbulb, Plus, Shapes, Trash2, UserRound, Users, X } from "lucide-react";
import type { DirectorCamera, DirectorObject, DirectorObjectKind, DirectorScene, DirectorVector3 } from "@/types/board";
import {
  addDirectorCamera,
  addDirectorCharacter,
  addDirectorCrowd,
  addDirectorModel,
  addDirectorObject,
  addDirectorPrimitive,
  getActiveDirectorCamera,
  removeDirectorCamera,
  removeDirectorObject,
  resetDirectorObjectTransform,
  resetDirectorView,
  relinkDirectorModel,
  renameDirectorCamera,
  selectDirectorCamera,
  setDirectorViewMode,
  setDirectorObjectLocked,
  updateDirectorCamera,
  updateDirectorCharacter,
  updateDirectorCrowd,
  updateDirectorView,
  updateDirectorObjectTransform,
  updateDirectorPrimitive,
  getDirectorPopulation,
} from "@/lib/director-scene";
import { DirectorViewport, type DirectorRenderedCapture, type DirectorViewportActions } from "@/components/director/DirectorViewport";
import { DirectorCameraMovePanel } from "@/components/director/DirectorCameraMovePanel";
import { DirectorCaptureTray, type DirectorCaptureView } from "@/components/director/DirectorCaptureTray";
import { DirectorFigurePicker } from "@/components/director/DirectorFigurePicker";
import {
  directorCaptureStore,
  type DirectorCapture,
  type DirectorCaptureRecord,
} from "@/services/director-capture-store";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";
import { directorModelStore, type DirectorModelRecord } from "@/services/director-model-store";
import { uid } from "@/lib/id";
import type { TransformControlsMode } from "three/examples/jsm/controls/TransformControls.js";
import { DIRECTOR_CHARACTER_PRESETS, DIRECTOR_POSE_PRESETS, DIRECTOR_PRIMITIVES } from "@/lib/director-cast";
import { createDirectorShotSnapshot } from "@/lib/director-shot";
import { useI18n } from "@/i18n/I18nProvider";

const KIND_LABEL_KEY = {
  character: "director.kind.character",
  crowd: "director.kind.crowd",
  prop: "director.kind.prop",
  light: "director.kind.light",
  model: "director.kind.model",
} satisfies Record<DirectorObjectKind, string>;

export function DirectorDialog({
  open,
  ownerScope,
  projectId,
  directorNodeId,
  title,
  scene,
  onChange,
  onTransformCommit,
  onModelCommit,
  onClose,
  onSendCaptures,
  onGenerateCapture,
  panoramaOptions,
  activePanoramaId,
  onPanoramaChange,
}: {
  open: boolean;
  ownerScope: string;
  projectId: string;
  directorNodeId: string;
  title: string;
  scene: DirectorScene;
  onChange: (scene: DirectorScene) => void;
  onTransformCommit: (scene: DirectorScene) => void;
  onModelCommit: (scene: DirectorScene) => void;
  onClose: () => void;
  onSendCaptures: (captures: DirectorCapture[]) => Promise<void>;
  onGenerateCapture: (capture: DirectorCapture) => Promise<void>;
  panoramaOptions: Array<{ id: string; label: string; url: string; spherical?: boolean }>;
  activePanoramaId: string | null;
  onPanoramaChange: (panoramaId: string | null) => void;
}) {
  const { t } = useI18n();
  const [previewPose, setPreviewPose] = useState<Pick<DirectorCamera, "position" | "target" | "focalLength"> | null>(null);
  const captureRef = useRef<(() => Promise<DirectorRenderedCapture>) | null>(null);
  const viewportActionsRef = useRef<DirectorViewportActions | null>(null);
  const captureInFlightRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const modelRefreshTokenRef = useRef(0);
  const sceneRef = useRef(scene);
  const openRef = useRef(open);
  const modelOperationRef = useRef(0);
  const modelUrlCacheRef = useRef(new Map<string, { signature: string; url: string }>());
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureRecords, setCaptureRecords] = useState<DirectorCaptureRecord[]>([]);
  const [captureViews, setCaptureViews] = useState<DirectorCaptureView[]>([]);
  const [selectedCaptureIds, setSelectedCaptureIds] = useState<Set<string>>(() => new Set());
  const [previewCaptureId, setPreviewCaptureId] = useState<string | null>(null);
  const [modelRecords, setModelRecords] = useState<Record<string, DirectorModelRecord>>({});
  const [modelSources, setModelSources] = useState<Record<string, string>>({});
  const [modelStatuses, setModelStatuses] = useState<Record<string, "loading" | "loaded" | "missing" | "error">>({});
  const [modelBusy, setModelBusy] = useState(false);
  const [relinkObjectId, setRelinkObjectId] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformControlsMode>("translate");
  sceneRef.current = scene;
  openRef.current = open;
  useEscapeDismiss(open && previewCaptureId === null && !modelBusy, onClose, 120);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
    document.addEventListener("keydown", trapFocus, true);
    return () => {
      document.removeEventListener("keydown", trapFocus, true);
      previous?.focus();
    };
  }, [open]);
  const selected = useMemo(
    () => scene.objects.find((object) => object.id === scene.selectedObjectId) ?? null,
    [scene.objects, scene.selectedObjectId],
  );
  const activeCamera = getActiveDirectorCamera(scene);
  const captureCurrent = () => {
    if (captureInFlightRef.current) return;
    captureInFlightRef.current = true;
    void (async () => {
      const capture = captureRef.current;
      if (!capture) {
        captureInFlightRef.current = false;
        return;
      }
      setCaptureError(null);
      setCapturing(true);
      try {
        const capturedScene = structuredClone(sceneRef.current);
        const camera = getActiveDirectorCamera(capturedScene);
        const shot = createDirectorShotSnapshot(capturedScene, directorNodeId, camera.id);
        const rendered = await capture();
        const record = await directorCaptureStore.add({
          ownerScope,
          projectId,
          directorNodeId,
          cameraId: camera.id,
          cameraName: camera.name,
          createdAt: new Date().toISOString(),
          width: rendered.width,
          height: rendered.height,
          blob: rendered.blob,
          shot,
        });
        await refreshCaptures();
        setSelectedCaptureIds(new Set([record.id]));
      } catch (error) {
        setCaptureError(error instanceof Error ? error.message : t("director.captureSaveFailed"));
      } finally {
        captureInFlightRef.current = false;
        setCapturing(false);
      }
    })();
  };

  const population = getDirectorPopulation(scene);
  const modelDescriptorSignature = scene.objects
    .filter((object) => object.kind === "model")
    .map((object) => `${object.id}:${object.modelAsset?.assetId}:${object.modelAsset?.bytes}`)
    .join("|");
  const refreshModels = useCallback(async (targetScene: DirectorScene) => {
    const token = ++modelRefreshTokenRef.current;
    const models = targetScene.objects.filter((object) => object.kind === "model" && object.modelAsset);
    const stored = await directorModelStore.list(
      ownerScope,
      projectId,
      directorNodeId,
      models.map((object) => ({
        ownerScope,
        projectId,
        directorNodeId,
        objectId: object.id,
        assetId: object.modelAsset!.assetId,
        fileName: object.modelAsset!.fileName,
        bytes: object.modelAsset!.bytes,
      })),
    );
    const loaded = models.map((object) => [
      object.id,
      stored.find((record) => record.objectId === object.id && record.assetId === object.modelAsset!.assetId) ?? null,
    ] as const);
    if (token !== modelRefreshTokenRef.current) return;
    setModelRecords(Object.fromEntries(loaded.filter((entry): entry is readonly [string, DirectorModelRecord] => Boolean(entry[1]))));
    setModelStatuses((current) => Object.fromEntries(models.map((object) => [
      object.id,
      loaded.some(([id, record]) => id === object.id && record) ? current[object.id] ?? "loading" : "missing",
    ])));
  }, [directorNodeId, ownerScope, projectId]);
  useEffect(() => {
    if (!open) {
      modelRefreshTokenRef.current += 1;
      modelOperationRef.current += 1;
      setModelRecords({});
      setModelStatuses({});
      return;
    }
    let active = true;
    void refreshModels(scene).catch((error) => {
      if (active) setCaptureError(error instanceof Error ? error.message : t("director.modelReadFailed"));
    });
    return () => { active = false; };
  }, [modelDescriptorSignature, open, refreshModels]);
  useEffect(() => {
    const cache = modelUrlCacheRef.current;
    const activeIds = new Set(Object.keys(modelRecords));
    for (const [id, entry] of cache) {
      const record = modelRecords[id];
      const signature = record ? `${record.assetId}:${record.createdAt}:${record.bytes}` : "";
      if (activeIds.has(id) && entry.signature === signature) continue;
      URL.revokeObjectURL(entry.url);
      cache.delete(id);
    }
    for (const [id, record] of Object.entries(modelRecords)) {
      if (cache.has(id)) continue;
      cache.set(id, {
        signature: `${record.assetId}:${record.createdAt}:${record.bytes}`,
        url: URL.createObjectURL(record.blob),
      });
    }
    setModelSources(Object.fromEntries([...cache].map(([id, entry]) => [id, entry.url])));
  }, [modelRecords]);
  useEffect(() => () => {
    modelOperationRef.current += 1;
    for (const entry of modelUrlCacheRef.current.values()) URL.revokeObjectURL(entry.url);
    modelUrlCacheRef.current.clear();
  }, []);
  const refreshCaptures = useCallback(async () => {
    setCaptureRecords(await directorCaptureStore.list(ownerScope, projectId, directorNodeId));
  }, [directorNodeId, ownerScope, projectId]);
  useEffect(() => {
    if (!open) {
      setCaptureRecords([]);
      setSelectedCaptureIds(new Set());
      setPreviewCaptureId(null);
      return;
    }
    let active = true;
    void directorCaptureStore.list(ownerScope, projectId, directorNodeId).then((records) => {
      if (active) setCaptureRecords(records);
    }).catch((error) => {
      if (active) setCaptureError(error instanceof Error ? error.message : t("director.captureReadFailed"));
    });
    return () => { active = false; };
  }, [directorNodeId, open, ownerScope, projectId]);
  useEffect(() => {
    const ownedUrls: string[] = [];
    const views = captureRecords.flatMap((record) => {
      if (record.blob instanceof Blob) {
        const url = URL.createObjectURL(record.blob);
        ownedUrls.push(url);
        return [{ record, url }];
      }
      return record.url ? [{ record, url: record.url }] : [];
    });
    setCaptureViews(views);
    return () => ownedUrls.forEach((url) => URL.revokeObjectURL(url));
  }, [captureRecords]);
  useEffect(() => {
    setSelectedCaptureIds((current) => new Set([...current].filter((id) =>
      captureRecords.some((record) => record.id === id)
    )));
    if (previewCaptureId && !captureRecords.some((record) => record.id === previewCaptureId)) {
      setPreviewCaptureId(null);
    }
  }, [captureRecords, previewCaptureId]);
  const selectObject = useCallback((id: string | null) => {
    if (id !== scene.selectedObjectId) onChange({ ...scene, selectedObjectId: id });
  }, [onChange, scene]);
  const persistView = useCallback((mode: DirectorScene["viewMode"], position: DirectorVector3, target: DirectorVector3) => {
    const current = mode === "director" ? scene.directorView : getActiveDirectorCamera(scene);
    if (current.position.x === position.x && current.position.y === position.y && current.position.z === position.z &&
        current.target.x === target.x && current.target.y === target.y && current.target.z === target.z) return;
    onChange(mode === "director"
      ? updateDirectorView(scene, { position, target })
      : updateDirectorCamera(scene, { position, target }));
  }, [onChange, scene]);
  const applyDirectorFraming = useCallback((action: keyof DirectorViewportActions) => {
    const pose = viewportActionsRef.current?.[action]();
    if (!pose) return;
    onChange(updateDirectorView(setDirectorViewMode(scene, "director"), pose));
  }, [onChange, scene]);
  if (!open) return null;

  const patchObject = (patch: Partial<DirectorObject>) => {
    if (!selected) return;
    onChange({
      ...scene,
      objects: scene.objects.map((object) => object.id === selected.id ? { ...object, ...patch } : object),
    });
  };
  const patchCrowd = (patch: Partial<NonNullable<DirectorObject["crowd"]>>) => {
    if (!selected || selected.kind !== "crowd") return;
    try {
      const next = updateDirectorCrowd(scene, selected.id, patch);
      if (next === scene && Object.keys(patch).some((key) => selected.crowd?.[key as keyof typeof selected.crowd] !== patch[key as keyof typeof patch])) {
        setCaptureError(t("director.crowdLimit"));
        return;
      }
      setCaptureError(null);
      onChange(next);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : t("director.crowdInvalid"));
    }
  };

  return createPortal((
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[150] flex bg-[#111] text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label={t("director.dialog")}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onScroll={(event) => event.stopPropagation()}
    >
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-[#1b1b1b]">
        <header className="border-b border-white/10 px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{t("director.scene")}</div>
          <h2 className="truncate text-sm font-semibold">{title}</h2>
        </header>
        <div className="grid grid-cols-5 gap-1 border-b border-white/10 p-2" role="group" aria-label={t("director.quickAdd")}>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" disabled={population >= 4096} onClick={() => onChange(addDirectorCharacter(scene, { preset: "studio", pose: "neutral", role: "actor" }))}><UserRound size={14} className="mx-auto mb-1" />{t("director.addCharacter")}</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" disabled={population >= 4096} onClick={() => onChange(addDirectorCharacter(scene, { preset: "casual", pose: "talk", role: "extra" }))}><Users size={14} className="mx-auto mb-1" />{t("director.addExtra")}</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" disabled={population + 9 > 4096} onClick={() => onChange(addDirectorCrowd(scene))}><Users size={14} className="mx-auto mb-1" />{t("director.addCrowd")}</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" onClick={() => onChange(addDirectorPrimitive(scene, "box"))}><Shapes size={14} className="mx-auto mb-1" />{t("director.addPrimitive")}</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" onClick={() => onChange(addDirectorObject(scene, "light"))}><Lightbulb size={14} className="mx-auto mb-1" />{t("director.addLight")}</button>
        </div>
        <div className="border-b border-white/10 p-2">
          <button type="button" className="flex w-full items-center justify-center gap-2 rounded bg-white/5 px-2 py-2 text-xs hover:bg-white/10 disabled:opacity-40" disabled={modelBusy || scene.objects.length >= 200} onClick={() => {
            setRelinkObjectId(null);
            modelInputRef.current?.click();
          }}><FileBox size={14} />{t("director.importGlb")}</button>
          <input ref={modelInputRef} type="file" accept=".glb,model/gltf-binary,application/octet-stream" className="hidden" onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            void (async () => {
              const operation = ++modelOperationRef.current;
              setModelBusy(true);
              setCaptureError(null);
              try {
                if (relinkObjectId) {
                  const object = sceneRef.current.objects.find((item) => item.id === relinkObjectId && item.kind === "model");
                  if (!object?.modelAsset) throw new Error(t("director.modelNotFound"));
                  const assetId = uid("model_asset");
                  await directorModelStore.put({
                    ownerScope,
                    projectId,
                    directorNodeId,
                    objectId: object.id,
                    assetId,
                    fileName: file.name,
                    blob: file,
                  });
                  const current = sceneRef.current;
                  const currentObject = current.objects.find((item) => item.id === object.id && item.kind === "model");
                  if (operation !== modelOperationRef.current || !openRef.current || !currentObject?.modelAsset || currentObject.modelAsset.assetId !== object.modelAsset.assetId) {
                    await directorModelStore.delete({ ownerScope, projectId, directorNodeId, objectId: object.id, assetId });
                    throw new Error(t("director.modelChanged"));
                  }
                  const next = relinkDirectorModel(current, object.id, { assetId, fileName: file.name, bytes: file.size });
                  onModelCommit(next);
                  await refreshModels(next);
                } else {
                  const objectId = uid("model");
                  const assetId = uid("model_asset");
                  await directorModelStore.put({ ownerScope, projectId, directorNodeId, objectId, assetId, fileName: file.name, blob: file });
                  if (operation !== modelOperationRef.current || !openRef.current) {
                    await directorModelStore.delete({ ownerScope, projectId, directorNodeId, objectId, assetId });
                    return;
                  }
                  const current = sceneRef.current;
                  const next = addDirectorModel(current, { assetId, fileName: file.name, bytes: file.size }, objectId);
                  if (next === current) {
                    await directorModelStore.delete({ ownerScope, projectId, directorNodeId, objectId, assetId });
                    throw new Error(t("director.modelLimit"));
                  }
                  onModelCommit(next);
                  await refreshModels(next);
                }
              } catch (error) {
                setCaptureError(error instanceof Error ? error.message : t("director.modelImportFailed"));
              } finally {
                setRelinkObjectId(null);
                setModelBusy(false);
              }
            })();
          }} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2" aria-label={t("director.sceneTree")}>
          <div className="mb-2 flex items-center gap-1 text-xs text-slate-400"><Plus size={12} />{t("director.stageElements", { count: population })}</div>
          {scene.objects.map((object) => (
            <button
              key={object.id}
              type="button"
              aria-selected={object.id === scene.selectedObjectId}
              className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs ${object.id === scene.selectedObjectId ? "bg-[#f0f269]/15 text-[#f0f269]" : "hover:bg-white/5"}`}
              onClick={() => selectObject(object.id)}
            >
              {object.kind === "character" ? <UserRound size={14} /> : object.kind === "crowd" ? <Users size={14} /> : object.kind === "prop" ? <Box size={14} /> : object.kind === "light" ? <Lightbulb size={14} /> : <FileBox size={14} />}
              <span className="min-w-0 flex-1 truncate">{object.name}</span>
              <span className={`text-[9px] uppercase ${object.kind === "model" && modelStatuses[object.id] !== "loaded" ? "text-amber-300" : "text-slate-500"}`}>{object.kind === "model" ? t((`director.status.${modelStatuses[object.id] ?? "missing"}`) as Parameters<typeof t>[0]) : object.kind === "crowd" && object.crowd ? t("director.crowdArray", { count: object.crowd.rows * object.crowd.columns }) : t(KIND_LABEL_KEY[object.kind] as Parameters<typeof t>[0])}</span>
            </button>
          ))}
          <div className="mt-4 mb-2 flex items-center gap-1 text-xs text-slate-400">
            <Camera size={12} />{t("director.cameras")}
            <button type="button" aria-label={t("director.addCamera")} className="ml-auto rounded p-1 hover:bg-white/10" disabled={scene.cameras.length >= 32} onClick={() => onChange(addDirectorCamera(scene))}><Plus size={13} /></button>
          </div>
          {scene.cameras.map((camera) => (
            <button
              key={camera.id}
              type="button"
              aria-label={t("director.selectCamera", { name: camera.name })}
              aria-current={camera.id === scene.activeCameraId ? "true" : undefined}
              className={`mb-1 flex w-full items-center gap-2 rounded border px-2 py-2 text-left text-xs ${camera.id === scene.activeCameraId ? "border-[#f0f269]/40 bg-[#f0f269]/15 text-[#f0f269]" : "border-white/5 text-slate-400 hover:bg-white/5"}`}
              onClick={() => onChange(selectDirectorCamera(scene, camera.id))}
            >
              <Camera size={13} />
              <span className="min-w-0 flex-1 truncate">{camera.name}</span>
              <span className="text-[9px] uppercase">{camera.focalLength}mm</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="relative min-w-0 flex-1">
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel-glass)] p-1 text-xs shadow-[var(--ob-elev-2)] backdrop-blur-md">
          <button type="button" aria-pressed={scene.viewMode === "director"} className={`rounded-lg px-2.5 py-1 transition-colors ${scene.viewMode === "director" ? "bg-[var(--ob-accent)] text-[#042f2e] font-semibold" : "text-[var(--ob-muted)] hover:bg-[var(--ob-surface-2)] hover:text-[var(--ob-ink)]"}`} onClick={() => onChange(setDirectorViewMode(scene, "director"))}>{t("director.directorView")}</button>
          <button type="button" aria-pressed={scene.viewMode === "camera"} className={`rounded-lg px-2.5 py-1 transition-colors ${scene.viewMode === "camera" ? "bg-[var(--ob-accent)] text-[#042f2e] font-semibold" : "text-[var(--ob-muted)] hover:bg-[var(--ob-surface-2)] hover:text-[var(--ob-ink)]"}`} onClick={() => onChange(setDirectorViewMode(scene, "camera"))}>{t("director.cameraView")}</button>
          <span className="px-1.5 font-mono text-[11px] text-[var(--ob-muted)]">{activeCamera.name} · {activeCamera.focalLength}mm</span>
        </div>
        <DirectorViewport
          scene={scene}
          environmentUrl={panoramaOptions.find((option) => option.id === activePanoramaId)?.url}
          environmentMode={panoramaOptions.find((option) => option.id === activePanoramaId)?.spherical ? "spherical" : "flat"}
          captureRef={captureRef}
          actionsRef={viewportActionsRef}
          onSelect={selectObject}
          onViewChange={persistView}
          modelSources={modelSources}
          transformMode={transformMode}
          onTransformCommit={(id, transform) => onTransformCommit(updateDirectorObjectTransform(scene, id, transform))}
          onModelStatus={(id, status) => setModelStatuses((current) => current[id] === status ? current : { ...current, [id]: status })}
          previewPose={previewPose}
        />
        <div className="absolute bottom-44 left-1/2 z-10 flex max-w-[min(92%,48rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl border border-[var(--ob-line)] bg-[var(--ob-panel-glass)] p-1 text-xs shadow-[var(--ob-elev-2)] backdrop-blur-md" aria-label={t("director.transformTools")}>
          {(["translate", "rotate", "scale"] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={transformMode === mode} className={`rounded-lg px-3 py-1.5 transition-colors ${transformMode === mode ? "bg-[var(--ob-accent)] text-[#042f2e] font-semibold" : "text-[var(--ob-muted)] hover:bg-[var(--ob-surface-2)] hover:text-[var(--ob-ink)]"}`} onClick={() => setTransformMode(mode)}>
              {t({ translate: "director.translate", rotate: "director.rotate", scale: "director.scale" }[mode] as Parameters<typeof t>[0])}
            </button>
          ))}
          <span className="mx-1 h-5 border-l border-[var(--ob-line)]" />
          <button
            type="button"
            className="rounded-lg px-2.5 py-1.5 text-[var(--ob-muted)] hover:bg-[var(--ob-surface-2)] hover:text-[var(--ob-ink)] disabled:opacity-35 transition-colors"
            disabled={!selected || !selected.visible || selected.kind === "light"}
            onClick={() => applyDirectorFraming("focusSelected")}
          >{t("director.focusSelected")}</button>
          <button
            type="button"
            className="rounded-lg px-2.5 py-1.5 text-[var(--ob-muted)] hover:bg-[var(--ob-surface-2)] hover:text-[var(--ob-ink)] disabled:opacity-35 transition-colors"
            disabled={!scene.objects.some((object) => object.visible && object.kind !== "light")}
            onClick={() => applyDirectorFraming("fitScene")}
          >{t("director.fitScene")}</button>
          <button
            type="button"
            className="rounded-lg px-2.5 py-1.5 text-[var(--ob-muted)] hover:bg-[var(--ob-surface-2)] hover:text-[var(--ob-ink)] transition-colors"
            onClick={() => onChange(resetDirectorView(scene))}
          >{t("director.resetView")}</button>
          <button
            type="button"
            className="rounded-lg px-2.5 py-1.5 text-[var(--ob-muted)] hover:bg-[var(--ob-surface-2)] hover:text-[var(--ob-ink)] disabled:opacity-35 transition-colors"
            disabled={!selected || selected.locked}
            onClick={() => selected && onTransformCommit(resetDirectorObjectTransform(scene, selected.id))}
          >{t("director.resetObject")}</button>
        </div>
        <DirectorCaptureTray
          captures={captureViews}
          selectedIds={selectedCaptureIds}
          busy={capturing}
          previewId={previewCaptureId}
          onPreview={setPreviewCaptureId}
          onToggle={(id) => setSelectedCaptureIds((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })}
          onSelectAll={() => setSelectedCaptureIds((current) =>
            current.size === captureRecords.length ? new Set() : new Set(captureRecords.map((record) => record.id))
          )}
          onCapture={captureCurrent}
          onDeleteSelected={() => {
            void (async () => {
              setCapturing(true);
              try {
                await directorCaptureStore.deleteMany(ownerScope, projectId, directorNodeId, [...selectedCaptureIds]);
                setSelectedCaptureIds(new Set());
                await refreshCaptures();
              } catch (error) {
                setCaptureError(error instanceof Error ? error.message : t("director.captureDeleteFailed"));
              } finally {
                setCapturing(false);
              }
            })();
          }}
          onClear={() => {
            void (async () => {
              setCapturing(true);
              try {
                await directorCaptureStore.clear(ownerScope, projectId, directorNodeId);
                setSelectedCaptureIds(new Set());
                await refreshCaptures();
              } catch (error) {
                setCaptureError(error instanceof Error ? error.message : t("director.captureClearFailed"));
              } finally {
                setCapturing(false);
              }
            })();
          }}
          onSendSelected={() => {
            void (async () => {
              const selectedRecords = captureRecords.filter((record) => selectedCaptureIds.has(record.id));
              if (!selectedRecords.length) return;
              setCaptureError(null);
              setCapturing(true);
              try {
                await onSendCaptures(await Promise.all(selectedRecords.map((record) => directorCaptureStore.resolve(record))));
              } catch (error) {
                setCaptureError(error instanceof Error ? error.message : t("director.captureSendFailed"));
              } finally {
                setCapturing(false);
              }
            })();
          }}
          onGenerateSelected={() => {
            void (async () => {
              const selectedRecord = captureRecords.find((record) => selectedCaptureIds.has(record.id));
              if (!selectedRecord || selectedCaptureIds.size !== 1) return;
              setCaptureError(null);
              setCapturing(true);
              try {
                await onGenerateCapture(await directorCaptureStore.resolve(selectedRecord));
              } catch (error) {
                setCaptureError(error instanceof Error ? error.message : t("director.shotGenerateFailed"));
              } finally {
                setCapturing(false);
              }
            })();
          }}
        />
        {captureError ? <p role="alert" className="absolute bottom-44 left-1/2 z-20 max-w-md -translate-x-1/2 rounded bg-red-950/90 px-3 py-2 text-xs text-red-200">{captureError}</p> : null}
      </main>

      <aside className="flex w-72 shrink-0 flex-col border-l border-white/10 bg-[#1b1b1b]">
        <header className="flex items-center border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{t("director.inspector")}</div>
            <div className="text-sm font-semibold">{t("director.inspector")}</div>
          </div>
          <button ref={closeButtonRef} type="button" disabled={modelBusy} className="ml-auto rounded p-1 hover:bg-white/10 disabled:opacity-40" aria-label={t("director.close")} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-xs">
          {selected ? (
            <>
              <div className="mb-4 flex items-center gap-2">
                <input aria-label={t("director.objectName")} className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-2 py-1.5" value={selected.name} onChange={(event) => patchObject({ name: event.target.value.slice(0, 100) || selected.name })} />
                <button type="button" aria-label={t("director.deleteObject")} className="rounded p-1.5 text-red-300 hover:bg-red-500/10" onClick={() => onChange(removeDirectorObject(scene, selected.id))}><Trash2 size={15} /></button>
              </div>
              <label className="mb-4 flex items-center gap-2"><input type="checkbox" checked={selected.visible} onChange={(event) => patchObject({ visible: event.target.checked })} />{t("director.visible")}</label>
              <label className="mb-4 flex items-center gap-2"><input type="checkbox" checked={selected.locked} onChange={(event) => onChange(setDirectorObjectLocked(scene, selected.id, event.target.checked))} />{t("director.locked")}</label>
              {selected.kind === "character" && selected.character ? (
                <div className="mb-4 space-y-3 rounded border border-white/10 bg-white/5 p-2">
                  <label className="block">{t("director.role")}<select aria-label={t("director.role")} className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={selected.character.role} onChange={(event) => onChange(updateDirectorCharacter(scene, selected.id, { role: event.target.value as "actor" | "extra" }))}><option value="actor">{t("director.roleActor")}</option><option value="extra">{t("director.roleExtra")}</option></select></label>
                  <DirectorFigurePicker
                    kind="character"
                    preset={selected.character.preset}
                    pose={selected.character.pose}
                    onPresetChange={(preset) => onChange(updateDirectorCharacter(scene, selected.id, { preset }))}
                    onPoseChange={(pose) => onChange(updateDirectorCharacter(scene, selected.id, { pose }))}
                  />
                  <DirectorFigurePicker
                    kind="pose"
                    preset={selected.character.preset}
                    pose={selected.character.pose}
                    onPresetChange={(preset) => onChange(updateDirectorCharacter(scene, selected.id, { preset }))}
                    onPoseChange={(pose) => onChange(updateDirectorCharacter(scene, selected.id, { pose }))}
                  />
                  <select aria-label={t("director.characterPreset")} className="sr-only" value={selected.character.preset} onChange={(event) => onChange(updateDirectorCharacter(scene, selected.id, { preset: event.target.value as NonNullable<DirectorObject["character"]>["preset"] }))}>{DIRECTOR_CHARACTER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <select aria-label={t("director.characterPose")} className="sr-only" value={selected.character.pose} onChange={(event) => onChange(updateDirectorCharacter(scene, selected.id, { pose: event.target.value as NonNullable<DirectorObject["character"]>["pose"] }))}>{DIRECTOR_POSE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                </div>
              ) : null}
              {selected.kind === "crowd" && selected.crowd ? (
                <div className="mb-4 space-y-3 rounded border border-white/10 bg-white/5 p-2">
                  <div className="mb-2 font-medium">{t("director.crowdArray", { count: selected.crowd.rows * selected.crowd.columns })}</div>
                  <DirectorFigurePicker kind="character" preset={selected.crowd.preset} pose={selected.crowd.pose} onPresetChange={(preset) => patchCrowd({ preset })} onPoseChange={(pose) => patchCrowd({ pose })} />
                  <DirectorFigurePicker kind="pose" preset={selected.crowd.preset} pose={selected.crowd.pose} onPresetChange={(preset) => patchCrowd({ preset })} onPoseChange={(pose) => patchCrowd({ pose })} />
                  <select aria-label={t("director.crowdPreset")} className="sr-only" value={selected.crowd.preset} onChange={(event) => patchCrowd({ preset: event.target.value as NonNullable<DirectorObject["crowd"]>["preset"] })}>{DIRECTOR_CHARACTER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <select aria-label={t("director.crowdPose")} className="sr-only" value={selected.crowd.pose} onChange={(event) => patchCrowd({ pose: event.target.value as NonNullable<DirectorObject["crowd"]>["pose"] })}>{DIRECTOR_POSE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <NumberEditor label={t("director.rows")} ariaLabel={t("director.crowdRows")} value={selected.crowd.rows} min={1} max={64} onChange={(rows) => patchCrowd({ rows })} />
                  <NumberEditor label={t("director.columns")} ariaLabel={t("director.crowdColumns")} value={selected.crowd.columns} min={1} max={64} onChange={(columns) => patchCrowd({ columns })} />
                  <NumberEditor label={t("director.spacingX")} ariaLabel={t("director.crowdSpacingX")} value={selected.crowd.spacingX} min={0.1} max={100} step={0.1} onChange={(spacingX) => patchCrowd({ spacingX })} />
                  <NumberEditor label={t("director.spacingZ")} ariaLabel={t("director.crowdSpacingZ")} value={selected.crowd.spacingZ} min={0.1} max={100} step={0.1} onChange={(spacingZ) => patchCrowd({ spacingZ })} />
                  <label className="mt-3 flex items-center gap-2"><input aria-label={t("director.crowdVariationLabel")} type="checkbox" checked={selected.crowd.variation} onChange={(event) => patchCrowd({ variation: event.target.checked })} />{t("director.crowdVariation")}</label>
                  <NumberEditor label={t("director.seed")} ariaLabel={t("director.crowdSeed")} value={selected.crowd.seed} min={0} max={2147483647} onChange={(seed) => patchCrowd({ seed })} />
                </div>
              ) : null}
              {selected.kind === "prop" && selected.primitive ? (
                <label className="mb-4 block">{t("director.primitive")}<select aria-label={t("director.primitive")} className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={selected.primitive} onChange={(event) => onChange(updateDirectorPrimitive(scene, selected.id, event.target.value as NonNullable<DirectorObject["primitive"]>))}>{DIRECTOR_PRIMITIVES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              ) : null}
              {selected.kind === "model" ? (
                <div className="mb-4 rounded border border-white/10 bg-white/5 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2"><span className="truncate">{selected.modelAsset?.fileName}</span><span className={modelStatuses[selected.id] === "loaded" ? "text-emerald-300" : "text-amber-300"}>{modelStatuses[selected.id] === "loaded" ? t("director.status.loaded") : t("director.modelMissing")}</span></div>
                  <button type="button" className="w-full rounded bg-white/10 px-2 py-1.5 hover:bg-white/15 disabled:opacity-40" disabled={modelBusy} onClick={() => {
                    setRelinkObjectId(selected.id);
                    modelInputRef.current?.click();
                  }}>{t("director.relinkGlb")}</button>
                </div>
              ) : null}
              <VectorEditor label={t("director.position")} value={selected.transform.position} onChange={(position) => onChange(updateDirectorObjectTransform(scene, selected.id, { position }))} />
              <VectorEditor label={t("director.rotation")} value={selected.transform.rotation} min={-360} max={360} onChange={(rotation) => onChange(updateDirectorObjectTransform(scene, selected.id, { rotation }))} />
              <VectorEditor label={t("director.scale")} value={selected.transform.scale} min={0.01} max={1000} onChange={(scale) => onChange(updateDirectorObjectTransform(scene, selected.id, { scale }))} />
              <label className="mt-4 block">{t("director.color")}<input aria-label={t("director.objectColor")} type="color" className="mt-1 h-8 w-full rounded bg-transparent" value={selected.color} onChange={(event) => patchObject({ color: event.target.value })} /></label>
              {selected.kind === "light" ? <NumberEditor label={t("director.lightIntensity")} value={selected.intensity} min={0} max={1000} onChange={(intensity) => patchObject({ intensity })} /> : null}
            </>
          ) : <p className="text-slate-500">{t("director.noObject")}</p>}

          <section className="mt-6 border-t border-white/10 pt-4">
            <h3 className="mb-3 text-sm font-semibold">{t("director.environment")}</h3>
            <label className="block">{t("director.environmentSource")}
              <select aria-label={t("director.panoramaEnvironment")} className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={activePanoramaId ?? ""} onChange={(event) => onPanoramaChange(event.target.value || null)}>
                <option value="">{t("director.solidEnvironment")}</option>
                {panoramaOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <NumberEditor label={t("director.environmentRotation")} ariaLabel={t("director.environmentRotationLabel")} value={scene.environment.rotationY} min={-360} max={360} onChange={(rotationY) => onChange({ ...scene, environment: { ...scene.environment, rotationY } })} />
            <NumberEditor label={t("director.environmentIntensity")} value={scene.environment.intensity} min={0} max={2} step={0.1} onChange={(intensity) => onChange({ ...scene, environment: { ...scene.environment, intensity } })} />
          </section>

          <section className="mt-6 border-t border-white/10 pt-4">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-semibold">{t("director.activeCamera")}</h3>
              <button type="button" aria-label={t("director.deleteActiveCamera")} className="ml-auto rounded p-1.5 text-red-300 hover:bg-red-500/10 disabled:opacity-35" disabled={scene.cameras.length <= 1} onClick={() => onChange(removeDirectorCamera(scene, activeCamera.id))}><Trash2 size={14} /></button>
            </div>
            <button
              type="button"
              className="mb-3 w-full rounded-lg bg-[#f0f269] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50"
              disabled={capturing}
              aria-label={t("director.captureCamera")}
              onClick={captureCurrent}
            >
              {capturing ? t("director.capturing") : t("director.captureCamera")}
            </button>
            <label className="mb-3 block">{t("director.cameraName")}<input aria-label={t("director.cameraName")} className="mt-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1.5" value={activeCamera.name} onChange={(event) => onChange(renameDirectorCamera(scene, activeCamera.id, event.target.value || activeCamera.name))} /></label>
            <VectorEditor label={t("director.cameraPosition")} value={activeCamera.position} onChange={(position) => onChange(updateDirectorCamera(scene, { position }))} />
            <VectorEditor label={t("director.lookAt")} value={activeCamera.target} onChange={(target) => onChange(updateDirectorCamera(scene, { target }))} />
            <NumberEditor label={t("director.focalLength")} ariaLabel={t("director.focalLengthLabel")} value={activeCamera.focalLength} min={1} max={300} onChange={(focalLength) => onChange(updateDirectorCamera(scene, { focalLength }))} />
            <NumberEditor label={t("director.aperture")} ariaLabel={t("director.apertureLabel")} value={activeCamera.aperture} min={0.7} max={64} step={0.1} onChange={(aperture) => onChange(updateDirectorCamera(scene, { aperture }))} />
            <label className="mt-3 block">{t("director.aspect")}
              <select aria-label={t("director.aspect")} className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={activeCamera.aspect} onChange={(event) => onChange(updateDirectorCamera(scene, { aspect: event.target.value as DirectorCamera["aspect"] }))}>
                {(["16:9", "4:3", "1:1", "3:4", "9:16"] as const).map((aspect) => <option key={aspect}>{aspect}</option>)}
              </select>
            </label>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={scene.showGroundGrid} onChange={(event) => onChange({ ...scene, showGroundGrid: event.target.checked })} />{t("director.showGrid")}</label>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={scene.showRuleOfThirds} onChange={(event) => onChange({ ...scene, showRuleOfThirds: event.target.checked })} />{t("director.showThirds")}</label>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={scene.showSafeFrame} onChange={(event) => onChange({ ...scene, showSafeFrame: event.target.checked })} />{t("director.showSafeFrame")}</label>
            <label className="mt-3 block">{t("director.environmentColor")}<input aria-label={t("director.environmentColor")} type="color" className="mt-1 h-8 w-full rounded bg-transparent" value={scene.background} onChange={(event) => onChange({ ...scene, background: event.target.value })} /></label>
            <DirectorCameraMovePanel scene={scene} onChange={onChange} onPreview={setPreviewPose} previewPose={previewPose} />
          </section>
        </div>
      </aside>
    </div>
  ), document.body);
}

function VectorEditor({ label, value, min = -100000, max = 100000, onChange }: { label: string; value: DirectorVector3; min?: number; max?: number; onChange: (value: DirectorVector3) => void }) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 text-slate-400">{label}</legend>
      <div className="grid grid-cols-3 gap-1">
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis} className="flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5"><span className="uppercase text-slate-500">{axis}</span><input aria-label={`${label} ${axis.toUpperCase()}`} type="number" step="0.1" min={min} max={max} className="min-w-0 flex-1 bg-transparent py-1.5 outline-none" value={value[axis]} onChange={(event) => {
            const parsed = Number(event.target.value);
            onChange({ ...value, [axis]: Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : Math.min(max, Math.max(min, 0)) });
          }} /></label>
        ))}
      </div>
    </fieldset>
  );
}

function NumberEditor({ label, ariaLabel, value, min, max, step = 1, onChange }: { label: string; ariaLabel?: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="mt-3 block">{label}<input aria-label={ariaLabel ?? label} type="number" min={min} max={max} step={step} className="mt-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1.5" value={value} onChange={(event) => onChange(Math.min(max, Math.max(min, Number(event.target.value) || min)))} /></label>;
}
