import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls, type TransformControlsMode } from "three/examples/jsm/controls/TransformControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { DirectorCamera, DirectorObject, DirectorScene, DirectorTransform, DirectorVector3 } from "@/types/board";
import { navigationAfterDirectorPreviewStart, shouldPersistDirectorView } from "@/lib/director-view-persist";
import { directorTransformFromRadians, getActiveDirectorCamera, getDirectorPopulation } from "@/lib/director-scene";
import {
  createDirectorCharacterRoot,
  createDirectorCrowdRoot,
  createDirectorPrimitiveRoot,
  directorObjectRenderSignature,
} from "@/lib/director-three-cast";
import { flatEnvironmentLayout, isSafeDirectorFrameSphere } from "@/lib/director-framing";
import { useI18n } from "@/i18n/I18nProvider";

function aspectValue(aspect: DirectorCamera["aspect"]): number {
  const [width, height] = aspect.split(":").map(Number);
  return width / height;
}

function applyTransform(target: THREE.Object3D, object: DirectorObject): void {
  const { position, rotation, scale } = object.transform;
  target.position.set(position.x, position.y, position.z);
  target.rotation.set(
    THREE.MathUtils.degToRad(rotation.x),
    THREE.MathUtils.degToRad(rotation.y),
    THREE.MathUtils.degToRad(rotation.z),
  );
  target.scale.set(scale.x, scale.y, scale.z);
  target.visible = object.visible;
  target.userData.directorObjectId = object.id;
}

function createLight(object: DirectorObject, selected: boolean): THREE.Object3D {
  const group = new THREE.Group();
  const light = new THREE.PointLight(object.color, object.intensity, 50);
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 8),
    new THREE.MeshBasicMaterial({ color: selected ? 0xf4f56b : object.color }),
  );
  group.add(light, marker);
  applyTransform(group, object);
  return group;
}

function createModelPlaceholder(object: DirectorObject, missing: boolean): THREE.Object3D {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 1.4, 1.4),
    new THREE.MeshBasicMaterial({
      color: missing ? 0xef4444 : 0x94a3b8,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
    }),
  );
  mesh.position.y = 0.7;
  group.add(mesh);
  applyTransform(group, object);
  return group;
}

function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const resource = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (resource.geometry) geometries.add(resource.geometry);
    if (resource.material) {
      const values = Array.isArray(resource.material) ? resource.material : [resource.material];
      values.forEach((material) => {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
        materials.add(material);
      });
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  const bitmaps = new Set<ImageBitmap>();
  textures.forEach((texture) => {
    if (typeof ImageBitmap !== "undefined") {
      const candidates = [texture.image, texture.source?.data];
      candidates.forEach((candidate) => {
        if (candidate instanceof ImageBitmap) bitmaps.add(candidate);
      });
    }
    texture.dispose();
  });
  bitmaps.forEach((bitmap) => bitmap.close());
}

type LoadedModelCost = { vertices: number; texturePixels: number; decodedBytes: number };

function validateLoadedModel(root: THREE.Object3D, maxTextureSize: number): LoadedModelCost | null {
  let objects = 0;
  let vertices = 0;
  let decodedBytes = 0;
  let texturePixels = 0;
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    objects += 1;
    const resource = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    vertices += resource.geometry?.getAttribute("position")?.count ?? 0;
    if (resource.geometry) {
      const attributes = Object.values(resource.geometry.attributes);
      for (const attribute of attributes) {
        const candidate = attribute as unknown as {
          array?: ArrayBufferView;
          data?: { array: ArrayBufferView };
        };
        const array = candidate.array ?? candidate.data?.array;
        if (array) decodedBytes += array.byteLength;
      }
      const index = resource.geometry.index;
      if (index) decodedBytes += index.array.byteLength;
    }
    const materials = resource.material ? (Array.isArray(resource.material) ? resource.material : [resource.material]) : [];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  if (objects > 10_000 || vertices > 2_000_000 || decodedBytes > 64 * 1024 * 1024 || textures.size > 128) return null;
  for (const texture of textures) {
    const image = texture.image as { width?: number; height?: number } | undefined;
    const width = image?.width ?? 0;
    const height = image?.height ?? 0;
    if (width > maxTextureSize || height > maxTextureSize) return null;
    texturePixels += width * height;
    if (texturePixels > 16_000_000) return null;
  }
  return { vertices, texturePixels, decodedBytes };
}

type DirectorRuntime = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  transformControls: TransformControls;
  transformHelper: THREE.Object3D;
  objectsRoot: THREE.Group;
  instances: Map<string, THREE.Object3D>;
  instanceSignatures: Map<string, string>;
  modelLoadTokens: Map<string, number>;
  modelLoading: Set<string>;
  modelCosts: Map<string, LoadedModelCost>;
  modelLoadQueue: Array<() => void>;
  activeModelLoads: number;
  disposed: boolean;
  grid: THREE.GridHelper;
  environmentSphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  environmentPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  environmentMode: "none" | "spherical" | "flat";
  environmentReady: boolean;
  environmentError: boolean;
  environmentUrl?: string;
  environmentLoadToken: number;
  resize: () => void;
  userNavigating: boolean;
  cameraInteracted: boolean;
};

function pumpModelLoads(runtime: DirectorRuntime): void {
  while (!runtime.disposed && runtime.activeModelLoads < 2 && runtime.modelLoadQueue.length) {
    const task = runtime.modelLoadQueue.shift()!;
    runtime.activeModelLoads += 1;
    task();
  }
}

function enqueueModelLoad(runtime: DirectorRuntime, task: (complete: () => void) => void): void {
  runtime.modelLoadQueue.push(() => {
    let completed = false;
    task(() => {
      if (completed) return;
      completed = true;
      runtime.activeModelLoads = Math.max(0, runtime.activeModelLoads - 1);
      pumpModelLoads(runtime);
    });
  });
  pumpModelLoads(runtime);
}

function canvasBlob(canvas: HTMLCanvasElement, errorMessage: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error(errorMessage));
    }, "image/png");
  });
}

export function DirectorViewport({
  scene: document,
  environmentUrl,
  environmentMode = "spherical",
  captureRef,
  actionsRef,
  onSelect,
  onViewChange,
  modelSources,
  transformMode,
  onTransformCommit,
  onModelStatus,
  previewPose,
}: {
  scene: DirectorScene;
  environmentUrl?: string;
  /** spherical = equirect skybox; flat = ordinary photo backdrop. */
  environmentMode?: "spherical" | "flat";
  captureRef: React.MutableRefObject<(() => Promise<DirectorRenderedCapture>) | null>;
  actionsRef: React.MutableRefObject<DirectorViewportActions | null>;
  onSelect: (id: string | null) => void;
  onViewChange: (
    mode: DirectorScene["viewMode"],
    position: DirectorCamera["position"],
    target: DirectorCamera["target"],
  ) => void;
  modelSources: Readonly<Record<string, string>>;
  transformMode: TransformControlsMode;
  onTransformCommit: (id: string, transform: DirectorTransform) => void;
  onModelStatus: (id: string, status: "loading" | "loaded" | "missing" | "error") => void;
  previewPose?: Pick<DirectorCamera, "position" | "target" | "focalLength"> | null;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<DirectorRuntime | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const documentRef = useRef(document);
  const previewPoseRef = useRef(previewPose);
  const onSelectRef = useRef(onSelect);
  const onViewChangeRef = useRef(onViewChange);
  const onTransformCommitRef = useRef(onTransformCommit);
  const onModelStatusRef = useRef(onModelStatus);
  const tRef = useRef(t);
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  documentRef.current = document;
  previewPoseRef.current = previewPose;
  onSelectRef.current = onSelect;
  onViewChangeRef.current = onViewChange;
  onTransformCommitRef.current = onTransformCommit;
  onModelStatusRef.current = onModelStatus;
  tRef.current = t;

  useEffect(() => {
    const container = containerRef.current;
    const mount = mountRef.current;
    if (!container || !mount) return;
    const scene = new THREE.Scene();
    const initial = documentRef.current;
    scene.background = new THREE.Color(initial.background);
    const initialShot = getActiveDirectorCamera(initial);
    const initialPose = initial.viewMode === "director" ? initial.directorView : initialShot;
    const ratio = aspectValue(initialShot.aspect);
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(36 / (2 * initialShot.focalLength)));
    const camera = new THREE.PerspectiveCamera(fov, ratio, 0.05, 1000);
    camera.position.set(initialPose.position.x, initialPose.position.y, initialPose.position.z);
    camera.lookAt(initialPose.target.x, initialPose.target.y, initialPose.target.z);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      setRuntimeError(null);
    } catch {
      const message = tRef.current("director.webglUnavailable");
      setRuntimeError(message);
      captureRef.current = () => Promise.reject(new Error(message));
      mount.replaceChildren();
      return () => { captureRef.current = null; };
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.domElement.dataset.testid = "director-viewport-canvas";
    mount.replaceChildren(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.15));
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(40, 40, 0x59616f, 0x293140);
    grid.visible = initial.showGroundGrid;
    scene.add(grid);
    const objectsRoot = new THREE.Group();
    scene.add(objectsRoot);
    const environmentGeometry = new THREE.SphereGeometry(100, 64, 40);
    const environmentMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide, visible: false });
    const environmentSphere = new THREE.Mesh(environmentGeometry, environmentMaterial);
    scene.add(environmentSphere);
    const environmentPlaneMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false, transparent: false });
    const environmentPlane = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), environmentPlaneMaterial);
    environmentPlane.position.set(0, 4.5, -14);
    environmentPlane.visible = false;
    scene.add(environmentPlane);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(initialPose.target.x, initialPose.target.y, initialPose.target.z);
    controls.enableDamping = true;
    controls.minPolarAngle = 0.04;
    controls.maxPolarAngle = Math.PI - 0.04;
    controls.update();
    const transformControls = new TransformControls(camera, renderer.domElement);
    const transformHelper = transformControls.getHelper();
    scene.add(transformHelper);
    let transformStart: DirectorTransform | null = null;
    const readTransform = (object: THREE.Object3D): DirectorTransform => directorTransformFromRadians({
      position: { x: object.position.x, y: object.position.y, z: object.position.z },
      rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
      scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z },
    });
    const handleTransformStart = () => {
      transformStart = transformControls.object ? readTransform(transformControls.object) : null;
    };
    const handleTransformEnd = () => {
      controls.enabled = !previewPoseRef.current;
      const target = transformControls.object;
      const id = target?.userData.directorObjectId;
      if (!target || typeof id !== "string") return;
      const next = readTransform(target);
      if (transformStart && JSON.stringify(next) === JSON.stringify(transformStart)) return;
      onTransformCommitRef.current(id, next);
    };
    const handleTransformDragging = (event: { value: unknown }) => {
      controls.enabled = event.value !== true && !previewPoseRef.current;
    };
    transformControls.addEventListener("mouseDown", handleTransformStart);
    transformControls.addEventListener("mouseUp", handleTransformEnd);
    transformControls.addEventListener("dragging-changed", handleTransformDragging);
    const persistCamera = () => {
      const runtime = runtimeRef.current;
      if (runtime) runtime.userNavigating = false;
      const shouldPersist = shouldPersistDirectorView({
        previewing: Boolean(previewPoseRef.current),
        cameraInteracted: Boolean(runtime?.cameraInteracted),
      });
      if (runtime) runtime.cameraInteracted = false;
      if (!shouldPersist) return;
      onViewChangeRef.current(
        documentRef.current.viewMode,
        { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        { x: controls.target.x, y: controls.target.y, z: controls.target.z },
      );
    };
    const beginCameraInteraction = () => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      runtime.cameraInteracted = true;
      runtime.userNavigating = true;
    };
    controls.addEventListener("start", beginCameraInteraction);
    controls.addEventListener("end", persistCamera);

    const resize = () => {
      const availableWidth = Math.max(1, container.clientWidth);
      const availableHeight = Math.max(1, container.clientHeight);
      const active = getActiveDirectorCamera(documentRef.current);
      const desiredRatio = documentRef.current.viewMode === "camera"
        ? aspectValue(active.aspect)
        : availableWidth / availableHeight;
      const availableRatio = availableWidth / availableHeight;
      const width = availableRatio > desiredRatio ? availableHeight * desiredRatio : availableWidth;
      const height = availableRatio > desiredRatio ? availableHeight : availableWidth / desiredRatio;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
      renderer.domElement.style.position = "absolute";
      renderer.domElement.style.left = "50%";
      renderer.domElement.style.top = "50%";
      renderer.domElement.style.transform = "translate(-50%, -50%)";
      camera.aspect = desiredRatio;
      camera.updateProjectionMatrix();
      const transformSize = Math.min(0.75, Math.max(0.55, Math.min(availableWidth, availableHeight) / 1000));
      transformControls.setSize(transformSize);
      renderer.domElement.dataset.transformControlSize = transformSize.toFixed(2);
      setFrameSize((current) => current.width === width && current.height === height
        ? current
        : { width, height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const selectFromPointer = (event: MouseEvent) => {
      if (transformControls.dragging) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const match = raycaster.intersectObjects(scene.children, true)
        .map((hit) => {
          let current: THREE.Object3D | null = hit.object;
          while (current && typeof current.userData.directorObjectId !== "string") current = current.parent;
          return current?.userData.directorObjectId as string | undefined;
        })
        .find(Boolean);
      onSelectRef.current(match ?? null);
    };
    renderer.domElement.addEventListener("dblclick", selectFromPointer);

    let frame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();
    captureRef.current = async () => {
      const current = runtimeRef.current;
      if (current?.environmentUrl && !current.environmentReady) {
        throw new Error(tRef.current("director.environmentLoading"));
      }
      if (current?.modelLoading.size) throw new Error(tRef.current("director.modelsLoading"));
      if (current?.environmentUrl && current.environmentError && !current.environmentSphere.material.map) {
        throw new Error(tRef.current("director.environmentFailed"));
      }
      const shot = getActiveDirectorCamera(documentRef.current);
      const priorPosition = camera.position.clone();
      const priorTarget = controls.target.clone();
      const priorFov = camera.fov;
      const priorAspect = camera.aspect;
      const priorHelperVisible = transformHelper.visible;
      const ratio = aspectValue(shot.aspect);
      const height = Math.min(1080, Math.max(1, Math.round(container.clientHeight)));
      const width = Math.min(2048, Math.max(1, Math.round(height * ratio)));
      renderer.setSize(width, height, false);
      camera.position.set(shot.position.x, shot.position.y, shot.position.z);
      controls.target.set(shot.target.x, shot.target.y, shot.target.z);
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(36 / (2 * shot.focalLength)));
      camera.aspect = ratio;
      camera.lookAt(controls.target);
      camera.updateProjectionMatrix();
      transformHelper.visible = false;
      renderer.render(scene, camera);
      try {
        return {
          blob: await canvasBlob(renderer.domElement, tRef.current("director.captureFailed")),
          width: renderer.domElement.width,
          height: renderer.domElement.height,
        };
      } finally {
        camera.position.copy(priorPosition);
        controls.target.copy(priorTarget);
        camera.fov = priorFov;
        camera.aspect = priorAspect;
        camera.lookAt(controls.target);
        camera.updateProjectionMatrix();
        transformHelper.visible = priorHelperVisible;
        controls.update();
        current?.resize();
      }
    };
    const frameObjects = (scope: "selected" | "all"): DirectorViewPose | null => {
      const currentDocument = documentRef.current;
      const ids = scope === "selected"
        ? currentDocument.selectedObjectId ? [currentDocument.selectedObjectId] : []
        : currentDocument.objects
          .filter((object) => object.visible && object.kind !== "light")
          .map((object) => object.id);
      const bounds = new THREE.Box3();
      let hasBounds = false;
      for (const id of ids) {
        const objectDocument = currentDocument.objects.find((object) => object.id === id);
        const instance = runtimeRef.current?.instances.get(id);
        if (!instance || !objectDocument?.visible || objectDocument.kind === "light") continue;
        instance.updateWorldMatrix(true, true);
        const objectBounds = new THREE.Box3().setFromObject(instance);
        if (objectBounds.isEmpty()) continue;
        bounds.union(objectBounds);
        hasBounds = true;
      }
      if (!hasBounds || bounds.isEmpty()) return null;
      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      if (!isSafeDirectorFrameSphere(sphere.center, sphere.radius)) return null;
      const direction = camera.position.clone().sub(controls.target);
      if (direction.lengthSq() < 0.0001) direction.set(1, 0.6, 1);
      direction.normalize();
      const verticalFov = THREE.MathUtils.degToRad(camera.fov);
      const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
      const limitingFov = Math.max(0.1, Math.min(verticalFov, horizontalFov));
      const distance = Math.max(2.5, sphere.radius / Math.sin(limitingFov / 2) * 1.3);
      const target = sphere.center;
      const position = target.clone().add(direction.multiplyScalar(distance));
      if (!isSafeDirectorFrameSphere(position, 0)) return null;
      camera.position.copy(position);
      controls.target.copy(target);
      camera.lookAt(target);
      controls.update();
      return {
        position: { x: position.x, y: position.y, z: position.z },
        target: { x: target.x, y: target.y, z: target.z },
      };
    };
    actionsRef.current = {
      focusSelected: () => frameObjects("selected"),
      fitScene: () => frameObjects("all"),
    };
    runtimeRef.current = {
      scene,
      camera,
      renderer,
      controls,
      transformControls,
      transformHelper,
      objectsRoot,
      instances: new Map(),
      instanceSignatures: new Map(),
      modelLoadTokens: new Map(),
      modelLoading: new Set(),
      modelCosts: new Map(),
      modelLoadQueue: [],
      activeModelLoads: 0,
      disposed: false,
      grid,
      environmentSphere,
      environmentPlane,
      environmentMode: "none" as const,
      environmentReady: true,
      environmentError: false,
      environmentLoadToken: 0,
      resize,
      userNavigating: false,
      cameraInteracted: false,
    };

    return () => {
      const currentRuntime = runtimeRef.current;
      if (currentRuntime) {
        currentRuntime.disposed = true;
        currentRuntime.modelLoadQueue.length = 0;
      }
      runtimeRef.current = null;
      captureRef.current = null;
      actionsRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("dblclick", selectFromPointer);
      controls.removeEventListener("start", beginCameraInteraction);
      controls.removeEventListener("end", persistCamera);
      transformControls.removeEventListener("mouseDown", handleTransformStart);
      transformControls.removeEventListener("mouseUp", handleTransformEnd);
      transformControls.removeEventListener("dragging-changed", handleTransformDragging);
      transformControls.detach();
      transformControls.dispose();
      controls.dispose();
      environmentMaterial.map?.dispose();
      environmentPlaneMaterial.map?.dispose();
      disposeObjectTree(scene);
      scene.clear();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [captureRef]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (previewPose) {
      runtime.controls.enabled = false;
      Object.assign(runtime, navigationAfterDirectorPreviewStart());
    } else if (!runtime.transformControls.dragging) {
      runtime.controls.enabled = true;
    }
    if (runtime.userNavigating && !previewPose) return;
    const shot = getActiveDirectorCamera(document);
    const pose = previewPose ?? (document.viewMode === "director" ? document.directorView : shot);
    const focalLength = previewPose?.focalLength ?? shot.focalLength;
    runtime.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(36 / (2 * focalLength)));
    runtime.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    runtime.controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    runtime.camera.lookAt(runtime.controls.target);
    runtime.camera.updateProjectionMatrix();
    runtime.controls.update();
  }, [document.viewMode, document.directorView, document.activeCameraId, document.cameras, previewPose]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.scene.background = new THREE.Color(document.background);
    runtime.grid.visible = document.showGroundGrid;
    runtime.environmentSphere.rotation.y = THREE.MathUtils.degToRad(document.environment.rotationY);
    runtime.environmentSphere.material.color.setScalar(document.environment.intensity);
    runtime.environmentPlane.material.color.setScalar(document.environment.intensity);
    const activeIds = new Set(document.objects.map((object) => object.id));
    for (const [id, instance] of runtime.instances) {
      if (activeIds.has(id)) continue;
      runtime.modelLoadTokens.set(id, (runtime.modelLoadTokens.get(id) ?? 0) + 1);
      runtime.modelLoading.delete(id);
      runtime.modelCosts.delete(id);
      if (runtime.transformControls.object === instance) runtime.transformControls.detach();
      runtime.objectsRoot.remove(instance);
      disposeObjectTree(instance);
      runtime.instances.delete(id);
      runtime.instanceSignatures.delete(id);
    }
    const loader = new GLTFLoader();
    for (const object of document.objects) {
      const selected = object.id === document.selectedObjectId;
      const source = object.kind === "model" ? modelSources[object.id] : undefined;
      const signature = object.kind === "model"
        ? [object.kind, object.modelAsset?.assetId, source ?? "missing"].join("|")
        : directorObjectRenderSignature(object);
      let instance = runtime.instances.get(object.id);
      if (!instance || runtime.instanceSignatures.get(object.id) !== signature) {
        if (instance) {
          runtime.modelLoadTokens.set(object.id, (runtime.modelLoadTokens.get(object.id) ?? 0) + 1);
          runtime.modelLoading.delete(object.id);
          runtime.modelCosts.delete(object.id);
          if (runtime.transformControls.object === instance) runtime.transformControls.detach();
          runtime.objectsRoot.remove(instance);
          disposeObjectTree(instance);
        }
        if (object.kind === "character") instance = createDirectorCharacterRoot(object);
        else if (object.kind === "crowd") instance = createDirectorCrowdRoot(object);
        else if (object.kind === "prop") instance = createDirectorPrimitiveRoot(object);
        else if (object.kind === "light") instance = createLight(object, selected);
        else {
          instance = createModelPlaceholder(object, !source);
          onModelStatusRef.current(object.id, source ? "loading" : "missing");
          if (source) {
            const wrapper = instance;
            runtime.instances.set(object.id, wrapper);
            const token = (runtime.modelLoadTokens.get(object.id) ?? 0) + 1;
            runtime.modelLoadTokens.set(object.id, token);
            runtime.modelLoading.add(object.id);
            enqueueModelLoad(runtime, (complete) => {
              if (runtime.disposed || runtime.modelLoadTokens.get(object.id) !== token || runtime.instances.get(object.id) !== wrapper) {
                complete();
                return;
              }
              try {
                loader.load(source, (gltf) => {
              if (runtimeRef.current !== runtime || runtime.modelLoadTokens.get(object.id) !== token ||
                  runtime.instances.get(object.id) !== wrapper) {
                disposeObjectTree(gltf.scene);
                complete();
                return;
              }
              const cost = validateLoadedModel(gltf.scene, runtime.renderer.capabilities.maxTextureSize);
              const retained = [...runtime.modelCosts.values()].reduce((total, item) => ({
                vertices: total.vertices + item.vertices,
                texturePixels: total.texturePixels + item.texturePixels,
                decodedBytes: total.decodedBytes + item.decodedBytes,
              }), { vertices: 0, texturePixels: 0, decodedBytes: 0 });
              if (!cost || retained.vertices + cost.vertices > 5_000_000 ||
                  retained.texturePixels + cost.texturePixels > 64_000_000 ||
                  retained.decodedBytes + cost.decodedBytes > 128 * 1024 * 1024) {
                disposeObjectTree(gltf.scene);
                runtime.modelLoading.delete(object.id);
                onModelStatusRef.current(object.id, "error");
                complete();
                return;
              }
              for (const child of [...wrapper.children]) {
                wrapper.remove(child);
                disposeObjectTree(child);
              }
              gltf.scene.traverse((child) => { child.userData.directorObjectId = object.id; });
              wrapper.add(gltf.scene);
              runtime.modelLoading.delete(object.id);
              runtime.modelCosts.set(object.id, cost);
              onModelStatusRef.current(object.id, "loaded");
              complete();
                }, undefined, () => {
                  if (runtimeRef.current === runtime && runtime.modelLoadTokens.get(object.id) === token) {
                    runtime.modelLoading.delete(object.id);
                    onModelStatusRef.current(object.id, "error");
                  }
                  complete();
                });
              } catch {
                runtime.modelLoading.delete(object.id);
                onModelStatusRef.current(object.id, "error");
                complete();
              }
            });
          }
        }
        runtime.objectsRoot.add(instance);
        runtime.instances.set(object.id, instance);
        runtime.instanceSignatures.set(object.id, signature);
      }
      applyTransform(instance, object);
    }
    runtime.transformControls.setMode(transformMode);
    const selected = document.selectedObjectId ? runtime.instances.get(document.selectedObjectId) : undefined;
    const selectedDocument = document.objects.find((object) => object.id === document.selectedObjectId);
    if (selected && selectedDocument?.visible && !selectedDocument.locked) runtime.transformControls.attach(selected);
    else runtime.transformControls.detach();
    runtime.renderer.domElement.dataset.transformMode = transformMode;
    runtime.renderer.domElement.dataset.transformAttached = runtime.transformControls.object ? "true" : "false";
    runtime.renderer.domElement.dataset.renderedPopulation = String(getDirectorPopulation(document));
    runtime.resize();
  }, [document, modelSources, transformMode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const token = ++runtime.environmentLoadToken;
    runtime.environmentUrl = environmentUrl;
    runtime.environmentMode = environmentUrl ? environmentMode : "none";
    runtime.environmentSphere.material.map?.dispose();
    runtime.environmentSphere.material.map = null;
    runtime.environmentSphere.material.visible = false;
    runtime.environmentPlane.material.map?.dispose();
    runtime.environmentPlane.material.map = null;
    runtime.environmentPlane.material.visible = false;
    runtime.environmentPlane.visible = false;
    delete runtime.renderer.domElement.dataset.flatEnvironmentSize;
    runtime.environmentError = false;
    runtime.renderer.domElement.dataset.environmentLoaded = environmentUrl ? "false" : "fallback";
    runtime.renderer.domElement.dataset.environmentMode = runtime.environmentMode;
    if (!environmentUrl) {
      runtime.environmentReady = true;
      runtime.environmentError = false;
      return;
    }
    runtime.environmentReady = false;
    const mode = environmentMode;
    new THREE.TextureLoader().load(environmentUrl, (texture) => {
      if (runtimeRef.current !== runtime || token !== runtime.environmentLoadToken) return texture.dispose();
      const image = texture.image as { width?: number; height?: number } | undefined;
      if ((image?.width ?? 0) > runtime.renderer.capabilities.maxTextureSize ||
          (image?.height ?? 0) > runtime.renderer.capabilities.maxTextureSize) {
        texture.dispose();
        runtime.environmentReady = true;
        runtime.environmentError = true;
        runtime.renderer.domElement.dataset.environmentLoaded = "error";
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      if (mode === "flat") {
        const width = Math.max(1, image?.width ?? 2);
        const height = Math.max(1, image?.height ?? 1);
        const foregroundMinZ = documentRef.current.objects
          .filter((object) => object.visible && object.kind !== "light")
          .reduce((minimum, object) => Math.min(minimum, object.transform.position.z), -10);
        const layout = flatEnvironmentLayout(width, height, foregroundMinZ);
        runtime.environmentPlane.geometry.dispose();
        runtime.environmentPlane.geometry = new THREE.PlaneGeometry(layout.width, layout.height);
        runtime.environmentPlane.position.set(0, layout.y, layout.z);
        runtime.environmentPlane.material.map = texture;
        runtime.environmentPlane.material.visible = true;
        runtime.environmentPlane.material.needsUpdate = true;
        runtime.environmentPlane.visible = true;
        runtime.environmentSphere.material.visible = false;
        runtime.renderer.domElement.dataset.flatEnvironmentSize = `${layout.width}x${layout.height}`;
      } else {
        runtime.environmentSphere.material.map = texture;
        runtime.environmentSphere.material.visible = true;
        runtime.environmentSphere.material.needsUpdate = true;
        runtime.environmentPlane.visible = false;
        delete runtime.renderer.domElement.dataset.flatEnvironmentSize;
      }
      runtime.environmentReady = true;
      runtime.environmentError = false;
      runtime.renderer.domElement.dataset.environmentLoaded = "true";
      runtime.renderer.domElement.dataset.environmentMode = mode;
    }, undefined, () => {
      if (runtimeRef.current !== runtime || token !== runtime.environmentLoadToken) return;
      if (runtime.environmentSphere.material.map || runtime.environmentPlane.material.map) return;
      runtime.environmentReady = true;
      runtime.environmentError = true;
      runtime.renderer.domElement.dataset.environmentLoaded = "error";
    });
    return () => { runtime.environmentLoadToken += 1; };
  }, [environmentUrl, environmentMode]);

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-0 w-full overflow-hidden bg-black"
      data-view-mode={document.viewMode}
      data-director-view-position={`${document.directorView.position.x},${document.directorView.position.y},${document.directorView.position.z}`}
      data-director-view-target={`${document.directorView.target.x},${document.directorView.target.y},${document.directorView.target.z}`}
    >
      <div ref={mountRef} className="absolute inset-0" />
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 z-[5] -translate-x-1/2 -translate-y-1/2"
        style={{ width: frameSize.width, height: frameSize.height }}
      >
        {document.showSafeFrame ? (
          <div data-testid="director-aspect-frame" className="absolute inset-[5%] border border-white/70 shadow-[0_0_0_1px_rgba(0,0,0,.45)]" />
        ) : null}
        {document.showRuleOfThirds ? (
          <div data-testid="director-rule-of-thirds" className="absolute inset-0">
            <span className="absolute bottom-0 left-1/3 top-0 border-l border-white/55" />
            <span className="absolute bottom-0 left-2/3 top-0 border-l border-white/55" />
            <span className="absolute left-0 right-0 top-1/3 border-t border-white/55" />
            <span className="absolute left-0 right-0 top-2/3 border-t border-white/55" />
          </div>
        ) : null}
      </div>
      {runtimeError ? (
        <div role="alert" className="absolute inset-0 z-10 grid place-items-center p-8 text-center text-sm text-red-200">
          {runtimeError}
        </div>
      ) : null}
    </div>
  );
}

export type DirectorRenderedCapture = {
  blob: Blob;
  width: number;
  height: number;
};

export type DirectorViewPose = {
  position: DirectorVector3;
  target: DirectorVector3;
};

export type DirectorViewportActions = {
  focusSelected: () => DirectorViewPose | null;
  fitScene: () => DirectorViewPose | null;
};
