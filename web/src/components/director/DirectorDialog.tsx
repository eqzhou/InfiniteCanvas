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
import { DirectorViewport, type DirectorRenderedCapture } from "@/components/director/DirectorViewport";
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

const KIND_LABEL: Record<DirectorObjectKind, string> = {
  character: "角色",
  crowd: "群众",
  prop: "几何体",
  light: "灯光",
  model: "模型",
};

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
  panoramaOptions: Array<{ id: string; label: string; url: string; spherical?: boolean }>;
  activePanoramaId: string | null;
  onPanoramaChange: (panoramaId: string | null) => void;
}) {
  const captureRef = useRef<(() => Promise<DirectorRenderedCapture>) | null>(null);
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
        const rendered = await capture();
        const camera = getActiveDirectorCamera(sceneRef.current);
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
        });
        await refreshCaptures();
        setSelectedCaptureIds(new Set([record.id]));
      } catch (error) {
        setCaptureError(error instanceof Error ? error.message : "导演台截图保存失败");
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
      if (active) setCaptureError(error instanceof Error ? error.message : "本地模型读取失败");
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
      if (active) setCaptureError(error instanceof Error ? error.message : "截图托盘读取失败");
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
        setCaptureError("群众阵列超过单阵列 1024 人或场景 4096 人上限");
        return;
      }
      setCaptureError(null);
      onChange(next);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "群众阵列设置无效");
    }
  };

  return createPortal((
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[150] flex bg-[#111] text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="3D 导演台"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-[#1b1b1b]">
        <header className="border-b border-white/10 px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">Scene</div>
          <h2 className="truncate text-sm font-semibold">{title}</h2>
        </header>
        <div className="grid grid-cols-5 gap-1 border-b border-white/10 p-2" role="group" aria-label="快速添加场景对象">
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" disabled={population >= 4096} onClick={() => onChange(addDirectorCharacter(scene, { preset: "studio", pose: "neutral", role: "actor" }))}><UserRound size={14} className="mx-auto mb-1" />角色</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" disabled={population >= 4096} onClick={() => onChange(addDirectorCharacter(scene, { preset: "casual", pose: "talk", role: "extra" }))}><Users size={14} className="mx-auto mb-1" />群演</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" disabled={population + 9 > 4096} onClick={() => onChange(addDirectorCrowd(scene))}><Users size={14} className="mx-auto mb-1" />阵列</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" onClick={() => onChange(addDirectorPrimitive(scene, "box"))}><Shapes size={14} className="mx-auto mb-1" />几何体</button>
          <button type="button" className="rounded bg-white/5 px-1 py-2 text-[10px] hover:bg-white/10" onClick={() => onChange(addDirectorObject(scene, "light"))}><Lightbulb size={14} className="mx-auto mb-1" />灯光</button>
        </div>
        <div className="border-b border-white/10 p-2">
          <button type="button" className="flex w-full items-center justify-center gap-2 rounded bg-white/5 px-2 py-2 text-xs hover:bg-white/10 disabled:opacity-40" disabled={modelBusy || scene.objects.length >= 200} onClick={() => {
            setRelinkObjectId(null);
            modelInputRef.current?.click();
          }}><FileBox size={14} />导入 GLB 模型</button>
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
                  if (!object?.modelAsset) throw new Error("待重新关联的模型已不存在");
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
                    throw new Error("模型在导入期间已变更，请重试重新关联");
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
                    throw new Error("导演台模型数量已达到上限");
                  }
                  onModelCommit(next);
                  await refreshModels(next);
                }
              } catch (error) {
                setCaptureError(error instanceof Error ? error.message : "GLB 模型导入失败");
              } finally {
                setRelinkObjectId(null);
                setModelBusy(false);
              }
            })();
          }} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2" aria-label="场景层级">
          <div className="mb-2 flex items-center gap-1 text-xs text-slate-400"><Plus size={12} />舞台元素 · {population} 人</div>
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
              <span className={`text-[9px] uppercase ${object.kind === "model" && modelStatuses[object.id] !== "loaded" ? "text-amber-300" : "text-slate-500"}`}>{object.kind === "model" ? ({ loading: "加载中", loaded: "已关联", missing: "缺失", error: "错误" } as const)[modelStatuses[object.id] ?? "missing"] : object.kind === "crowd" && object.crowd ? `${object.crowd.rows}×${object.crowd.columns} · ${object.crowd.rows * object.crowd.columns}人` : KIND_LABEL[object.kind]}</span>
            </button>
          ))}
          <div className="mt-4 mb-2 flex items-center gap-1 text-xs text-slate-400">
            <Camera size={12} />机位
            <button type="button" aria-label="添加机位" className="ml-auto rounded p-1 hover:bg-white/10" disabled={scene.cameras.length >= 32} onClick={() => onChange(addDirectorCamera(scene))}><Plus size={13} /></button>
          </div>
          {scene.cameras.map((camera) => (
            <button
              key={camera.id}
              type="button"
              aria-label={`选择机位 ${camera.name}`}
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
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded border border-white/10 bg-black/55 p-1 text-xs backdrop-blur">
          <button type="button" aria-pressed={scene.viewMode === "director"} className={`rounded px-2 py-1 ${scene.viewMode === "director" ? "bg-[#f0f269] text-black" : "hover:bg-white/10"}`} onClick={() => onChange(setDirectorViewMode(scene, "director"))}>导演视角</button>
          <button type="button" aria-pressed={scene.viewMode === "camera"} className={`rounded px-2 py-1 ${scene.viewMode === "camera" ? "bg-[#f0f269] text-black" : "hover:bg-white/10"}`} onClick={() => onChange(setDirectorViewMode(scene, "camera"))}>机位视角</button>
          <span className="px-1 text-slate-400">{activeCamera.name} · {activeCamera.focalLength}mm</span>
        </div>
        <DirectorViewport
          scene={scene}
          environmentUrl={panoramaOptions.find((option) => option.id === activePanoramaId)?.url}
          environmentMode={panoramaOptions.find((option) => option.id === activePanoramaId)?.spherical ? "spherical" : "flat"}
          captureRef={captureRef}
          onSelect={selectObject}
          onViewChange={persistView}
          modelSources={modelSources}
          transformMode={transformMode}
          onTransformCommit={(id, transform) => onTransformCommit(updateDirectorObjectTransform(scene, id, transform))}
          onModelStatus={(id, status) => setModelStatuses((current) => current[id] === status ? current : { ...current, [id]: status })}
        />
        <div className="absolute bottom-44 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded border border-white/10 bg-black/65 p-1 text-xs backdrop-blur" aria-label="3D 变换工具">
          {(["translate", "rotate", "scale"] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={transformMode === mode} className={`rounded px-3 py-1.5 ${transformMode === mode ? "bg-[#f0f269] text-black" : "hover:bg-white/10"}`} onClick={() => setTransformMode(mode)}>
              {{ translate: "移动", rotate: "旋转", scale: "缩放" }[mode]}
            </button>
          ))}
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
                setCaptureError(error instanceof Error ? error.message : "截图删除失败");
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
                setCaptureError(error instanceof Error ? error.message : "截图清空失败");
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
                setCaptureError(error instanceof Error ? error.message : "截图发送画布失败");
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
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Inspector</div>
            <div className="text-sm font-semibold">属性</div>
          </div>
          <button ref={closeButtonRef} type="button" disabled={modelBusy} className="ml-auto rounded p-1 hover:bg-white/10 disabled:opacity-40" aria-label="关闭导演台" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-xs">
          {selected ? (
            <>
              <div className="mb-4 flex items-center gap-2">
                <input aria-label="对象名称" className="min-w-0 flex-1 rounded border border-white/10 bg-white/5 px-2 py-1.5" value={selected.name} onChange={(event) => patchObject({ name: event.target.value.slice(0, 100) || selected.name })} />
                <button type="button" aria-label="删除对象" className="rounded p-1.5 text-red-300 hover:bg-red-500/10" onClick={() => onChange(removeDirectorObject(scene, selected.id))}><Trash2 size={15} /></button>
              </div>
              <label className="mb-4 flex items-center gap-2"><input type="checkbox" checked={selected.visible} onChange={(event) => patchObject({ visible: event.target.checked })} />可见</label>
              <label className="mb-4 flex items-center gap-2"><input type="checkbox" checked={selected.locked} onChange={(event) => onChange(setDirectorObjectLocked(scene, selected.id, event.target.checked))} />锁定变换</label>
              {selected.kind === "character" && selected.character ? (
                <div className="mb-4 space-y-3 rounded border border-white/10 bg-white/5 p-2">
                  <label className="block">身份<select aria-label="人物身份" className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={selected.character.role} onChange={(event) => onChange(updateDirectorCharacter(scene, selected.id, { role: event.target.value as "actor" | "extra" }))}><option value="actor">角色</option><option value="extra">群演</option></select></label>
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
                  <select aria-label="人物预设" className="sr-only" value={selected.character.preset} onChange={(event) => onChange(updateDirectorCharacter(scene, selected.id, { preset: event.target.value as NonNullable<DirectorObject["character"]>["preset"] }))}>{DIRECTOR_CHARACTER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <select aria-label="人物姿势" className="sr-only" value={selected.character.pose} onChange={(event) => onChange(updateDirectorCharacter(scene, selected.id, { pose: event.target.value as NonNullable<DirectorObject["character"]>["pose"] }))}>{DIRECTOR_POSE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                </div>
              ) : null}
              {selected.kind === "crowd" && selected.crowd ? (
                <div className="mb-4 space-y-3 rounded border border-white/10 bg-white/5 p-2">
                  <div className="mb-2 font-medium">群众阵列 · {selected.crowd.rows * selected.crowd.columns} 人</div>
                  <DirectorFigurePicker kind="character" preset={selected.crowd.preset} pose={selected.crowd.pose} onPresetChange={(preset) => patchCrowd({ preset })} onPoseChange={(pose) => patchCrowd({ pose })} />
                  <DirectorFigurePicker kind="pose" preset={selected.crowd.preset} pose={selected.crowd.pose} onPresetChange={(preset) => patchCrowd({ preset })} onPoseChange={(pose) => patchCrowd({ pose })} />
                  <select aria-label="群众人物预设" className="sr-only" value={selected.crowd.preset} onChange={(event) => patchCrowd({ preset: event.target.value as NonNullable<DirectorObject["crowd"]>["preset"] })}>{DIRECTOR_CHARACTER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <select aria-label="群众人物姿势" className="sr-only" value={selected.crowd.pose} onChange={(event) => patchCrowd({ pose: event.target.value as NonNullable<DirectorObject["crowd"]>["pose"] })}>{DIRECTOR_POSE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
                  <NumberEditor label="行数" ariaLabel="群众行数" value={selected.crowd.rows} min={1} max={64} onChange={(rows) => patchCrowd({ rows })} />
                  <NumberEditor label="列数" ariaLabel="群众列数" value={selected.crowd.columns} min={1} max={64} onChange={(columns) => patchCrowd({ columns })} />
                  <NumberEditor label="横向间距" ariaLabel="群众横向间距" value={selected.crowd.spacingX} min={0.1} max={100} step={0.1} onChange={(spacingX) => patchCrowd({ spacingX })} />
                  <NumberEditor label="纵向间距" ariaLabel="群众纵向间距" value={selected.crowd.spacingZ} min={0.1} max={100} step={0.1} onChange={(spacingZ) => patchCrowd({ spacingZ })} />
                  <label className="mt-3 flex items-center gap-2"><input aria-label="群众变化" type="checkbox" checked={selected.crowd.variation} onChange={(event) => patchCrowd({ variation: event.target.checked })} />人物与姿势变化</label>
                  <NumberEditor label="随机种子" ariaLabel="群众随机种子" value={selected.crowd.seed} min={0} max={2147483647} onChange={(seed) => patchCrowd({ seed })} />
                </div>
              ) : null}
              {selected.kind === "prop" && selected.primitive ? (
                <label className="mb-4 block">基础几何体<select aria-label="基础几何体" className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={selected.primitive} onChange={(event) => onChange(updateDirectorPrimitive(scene, selected.id, event.target.value as NonNullable<DirectorObject["primitive"]>))}>{DIRECTOR_PRIMITIVES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              ) : null}
              {selected.kind === "model" ? (
                <div className="mb-4 rounded border border-white/10 bg-white/5 p-2">
                  <div className="mb-2 flex items-center justify-between gap-2"><span className="truncate">{selected.modelAsset?.fileName}</span><span className={modelStatuses[selected.id] === "loaded" ? "text-emerald-300" : "text-amber-300"}>{modelStatuses[selected.id] === "loaded" ? "已关联" : "资源缺失"}</span></div>
                  <button type="button" className="w-full rounded bg-white/10 px-2 py-1.5 hover:bg-white/15 disabled:opacity-40" disabled={modelBusy} onClick={() => {
                    setRelinkObjectId(selected.id);
                    modelInputRef.current?.click();
                  }}>重新关联 GLB</button>
                </div>
              ) : null}
              <VectorEditor label="位置" value={selected.transform.position} onChange={(position) => onChange(updateDirectorObjectTransform(scene, selected.id, { position }))} />
              <VectorEditor label="旋转（度）" value={selected.transform.rotation} min={-360} max={360} onChange={(rotation) => onChange(updateDirectorObjectTransform(scene, selected.id, { rotation }))} />
              <VectorEditor label="缩放" value={selected.transform.scale} min={0.01} max={1000} onChange={(scale) => onChange(updateDirectorObjectTransform(scene, selected.id, { scale }))} />
              <label className="mt-4 block">颜色<input aria-label="对象颜色" type="color" className="mt-1 h-8 w-full rounded bg-transparent" value={selected.color} onChange={(event) => patchObject({ color: event.target.value })} /></label>
              {selected.kind === "light" ? <NumberEditor label="灯光强度" value={selected.intensity} min={0} max={1000} onChange={(intensity) => patchObject({ intensity })} /> : null}
            </>
          ) : <p className="text-slate-500">从左侧场景层级选择一个对象。</p>}

          <section className="mt-6 border-t border-white/10 pt-4">
            <h3 className="mb-3 text-sm font-semibold">全景环境</h3>
            <label className="block">环境来源
              <select aria-label="导演台全景环境" className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={activePanoramaId ?? ""} onChange={(event) => onPanoramaChange(event.target.value || null)}>
                <option value="">纯色环境</option>
                {panoramaOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <NumberEditor label="环境旋转（度）" ariaLabel="环境旋转" value={scene.environment.rotationY} min={-360} max={360} onChange={(rotationY) => onChange({ ...scene, environment: { ...scene.environment, rotationY } })} />
            <NumberEditor label="环境强度" value={scene.environment.intensity} min={0} max={2} step={0.1} onChange={(intensity) => onChange({ ...scene, environment: { ...scene.environment, intensity } })} />
          </section>

          <section className="mt-6 border-t border-white/10 pt-4">
            <div className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-semibold">活动机位</h3>
              <button type="button" aria-label="删除活动机位" className="ml-auto rounded p-1.5 text-red-300 hover:bg-red-500/10 disabled:opacity-35" disabled={scene.cameras.length <= 1} onClick={() => onChange(removeDirectorCamera(scene, activeCamera.id))}><Trash2 size={14} /></button>
            </div>
            <button
              type="button"
              className="mb-3 w-full rounded-lg bg-[#f0f269] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50"
              disabled={capturing}
              aria-label="生成当前机位截图"
              onClick={captureCurrent}
            >
              {capturing ? "拍摄中…" : "生成当前机位截图"}
            </button>
            <label className="mb-3 block">机位名称<input aria-label="机位名称" className="mt-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1.5" value={activeCamera.name} onChange={(event) => onChange(renameDirectorCamera(scene, activeCamera.id, event.target.value || activeCamera.name))} /></label>
            <VectorEditor label="摄像机位置" value={activeCamera.position} onChange={(position) => onChange(updateDirectorCamera(scene, { position }))} />
            <VectorEditor label="观察目标" value={activeCamera.target} onChange={(target) => onChange(updateDirectorCamera(scene, { target }))} />
            <NumberEditor label="焦距（mm）" ariaLabel="焦距" value={activeCamera.focalLength} min={1} max={300} onChange={(focalLength) => onChange(updateDirectorCamera(scene, { focalLength }))} />
            <NumberEditor label="光圈（f/）" ariaLabel="光圈" value={activeCamera.aperture} min={0.7} max={64} step={0.1} onChange={(aperture) => onChange(updateDirectorCamera(scene, { aperture }))} />
            <label className="mt-3 block">画幅
              <select aria-label="画幅" className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5" value={activeCamera.aspect} onChange={(event) => onChange(updateDirectorCamera(scene, { aspect: event.target.value as DirectorCamera["aspect"] }))}>
                {(["16:9", "4:3", "1:1", "3:4", "9:16"] as const).map((aspect) => <option key={aspect}>{aspect}</option>)}
              </select>
            </label>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={scene.showGroundGrid} onChange={(event) => onChange({ ...scene, showGroundGrid: event.target.checked })} />显示地面网格</label>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={scene.showRuleOfThirds} onChange={(event) => onChange({ ...scene, showRuleOfThirds: event.target.checked })} />显示九宫格</label>
            <label className="mt-3 flex items-center gap-2"><input type="checkbox" checked={scene.showSafeFrame} onChange={(event) => onChange({ ...scene, showSafeFrame: event.target.checked })} />显示比例框</label>
            <label className="mt-3 block">环境颜色<input aria-label="环境颜色" type="color" className="mt-1 h-8 w-full rounded bg-transparent" value={scene.background} onChange={(event) => onChange({ ...scene, background: event.target.value })} /></label>
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
