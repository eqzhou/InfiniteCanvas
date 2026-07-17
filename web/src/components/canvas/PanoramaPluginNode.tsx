import { useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Upload } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BoardNode } from "@/types/board";
import { resolveObjectUrl, uploadMedia } from "@/services/storage";
import { useBoardStore } from "@/stores/use-board-store";

type SourceOption = {
  id: string;
  label: string;
  storageKey?: string;
  fallback?: string;
};

function fallbackTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.CanvasTexture(canvas);
  context.fillStyle = "#0f766e";
  context.fillRect(0, 0, 1024, 512);
  context.fillStyle = "#f4d35e";
  context.fillRect(0, 220, 1024, 80);
  context.fillStyle = "#ecfeff";
  context.beginPath();
  context.arc(512, 180, 86, 0, Math.PI * 2);
  context.fill();
  return new THREE.CanvasTexture(canvas);
}

function mountCanvasFallback(container: HTMLDivElement, sourceUrl?: string): () => void {
  const canvas = document.createElement("canvas");
  canvas.dataset.panoramaCanvas = "true";
  canvas.dataset.panoramaRenderer = "2d";
  container.appendChild(canvas);
  const context = canvas.getContext("2d");
  if (!context) return () => canvas.remove();
  let image: HTMLImageElement | undefined;
  let offset = 0;
  let pointerX: number | undefined;
  const draw = () => {
    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#0f766e";
    context.fillRect(0, 0, width, height);
    if (image?.complete && image.naturalWidth > 0) {
      const scale = Math.max(height / image.naturalHeight, width / image.naturalWidth);
      const renderedWidth = image.naturalWidth * scale;
      const renderedHeight = image.naturalHeight * scale;
      const normalizedOffset = ((offset % renderedWidth) + renderedWidth) % renderedWidth;
      for (let x = normalizedOffset - renderedWidth; x < width; x += renderedWidth) {
        context.drawImage(image, x, (height - renderedHeight) / 2, renderedWidth, renderedHeight);
      }
    } else {
      context.fillStyle = "#f4d35e";
      context.fillRect(0, height * 0.58, width, height * 0.2);
      context.fillStyle = "#ecfeff";
      context.beginPath();
      context.arc(width / 2, height * 0.35, Math.max(18, height * 0.16), 0, Math.PI * 2);
      context.fill();
    }
  };
  if (sourceUrl) {
    image = new Image();
    image.onload = draw;
    image.src = sourceUrl;
  }
  const observer = new ResizeObserver(draw);
  observer.observe(container);
  const pointerDown = (event: PointerEvent) => {
    pointerX = event.clientX;
    canvas.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent) => {
    if (pointerX === undefined) return;
    offset += event.clientX - pointerX;
    pointerX = event.clientX;
    draw();
  };
  const pointerEnd = () => { pointerX = undefined; };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerEnd);
  canvas.addEventListener("pointercancel", pointerEnd);
  draw();
  return () => {
    observer.disconnect();
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointermove", pointerMove);
    canvas.removeEventListener("pointerup", pointerEnd);
    canvas.removeEventListener("pointercancel", pointerEnd);
    canvas.remove();
  };
}

export function PanoramaPluginNode({ node }: { node: BoardNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const updateNode = useBoardStore((state) => state.updateNode);
  const project = useBoardStore((state) => state.getActive());
  const assets = useBoardStore((state) => state.assets);
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const options = useMemo<SourceOption[]>(() => [
    ...(project?.nodes.filter((item) => item.type === "image").map((item) => ({
      id: `node:${item.id}`,
      label: `画布 · ${item.title}`,
      storageKey: item.metadata.storageKey,
      fallback: item.metadata.content,
    })) ?? []),
    ...assets.filter((asset) => asset.kind === "image").map((asset) => ({
      id: `asset:${asset.id}`,
      label: `素材 · ${asset.title}`,
      storageKey: asset.storageKey,
      fallback: asset.coverUrl,
    })),
  ], [assets, project?.nodes]);

  useEffect(() => {
    const storageKey = typeof node.metadata.pluginState?.storageKey === "string"
      ? node.metadata.pluginState.storageKey
      : undefined;
    if (!storageKey) return setSourceUrl(undefined);
    void resolveObjectUrl("image", storageKey).then(setSourceUrl);
  }, [node.metadata.pluginState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
    camera.position.set(0, 0, 0.1);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
      });
    } catch {
      return mountCanvasFallback(container, sourceUrl);
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0f766e, 1);
    renderer.domElement.dataset.panoramaCanvas = "true";
    renderer.domElement.dataset.panoramaRenderer = "webgl";
    container.appendChild(renderer.domElement);
    const geometry = new THREE.SphereGeometry(10, 64, 40);
    geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ map: fallbackTexture() });
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.rotateSpeed = -0.35;
    controls.minDistance = 0.1;
    controls.maxDistance = 0.1;
    const resize = () => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    let disposed = false;
    let frame = 0;
    const render = () => {
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
    if (sourceUrl) {
      new THREE.TextureLoader().load(sourceUrl, (texture) => {
        if (disposed) return texture.dispose();
        texture.colorSpace = THREE.SRGBColorSpace;
        material.map?.dispose();
        material.map = texture;
        material.needsUpdate = true;
      }, undefined, () => setError("全景图片无法读取"));
    }
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      geometry.dispose();
      material.map?.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [sourceUrl]);

  const selectSource = async (id: string) => {
    const option = options.find((item) => item.id === id);
    if (!option) return;
    const url = option.storageKey
      ? await resolveObjectUrl("image", option.storageKey, option.fallback)
      : option.fallback;
    if (!url) throw new Error("图片内容不可用");
    const uploaded = option.storageKey ? null : await uploadMedia(url, "image");
    const storageKey = option.storageKey ?? uploaded?.storageKey;
    if (!storageKey) throw new Error("图片无法持久化");
    setSourceUrl(url);
    updateNode(node.id, {
      metadata: {
        pluginState: { ...(node.metadata.pluginState ?? {}), storageKey },
      },
    });
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[#0f766e]">
      <div ref={containerRef} className="absolute inset-0" aria-label="3D 全景视图" />
      <div className="absolute left-2 top-2 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded bg-white/90 p-1 text-[#202124] shadow-sm">
        <ImageIcon size={15} aria-hidden="true" />
        <select
          aria-label="选择全景图片"
          className="min-w-0 max-w-44 bg-transparent text-xs outline-none"
          defaultValue=""
          onChange={(event) => void selectSource(event.target.value).catch((cause) =>
            setError(cause instanceof Error ? cause.message : String(cause)))}
        >
          <option value="" disabled>选择画布或素材图片</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <label className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center" title="上传全景图片">
          <Upload size={15} />
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void uploadMedia(file, "image").then((uploaded) => {
                setSourceUrl(uploaded.url);
                updateNode(node.id, {
                  metadata: { pluginState: { ...(node.metadata.pluginState ?? {}), storageKey: uploaded.storageKey } },
                });
              }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      {error ? <div role="alert" className="absolute bottom-2 left-2 right-2 bg-white/90 px-2 py-1 text-xs text-[var(--ob-danger)]">{error}</div> : null}
    </div>
  );
}
