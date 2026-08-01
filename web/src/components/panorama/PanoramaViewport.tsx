import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  nextPanoramaFieldOfView,
  nextPanoramaViewerZoom,
} from "@/lib/panorama-zoom";

function mountFallback(container: HTMLDivElement, sourceUrl: string, onError?: (message: string) => void): () => void {
  const canvas = document.createElement("canvas");
  canvas.dataset.nativePanoramaCanvas = "true";
  canvas.dataset.panoramaRenderer = "2d";
  canvas.dataset.panoramaLoaded = "false";
  const context = canvas.getContext("2d");
  container.replaceChildren(canvas);
  if (!context) return () => canvas.remove();
  const image = new Image();
  let offset = 0;
  let zoom = 1;
  let previousX: number | null = null;
  const draw = () => {
    const scale = Math.min(window.devicePixelRatio, 2);
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = "#111827";
    context.fillRect(0, 0, width, height);
    if (!image.complete || !image.naturalWidth) return;
    const imageScale = Math.max(height / image.naturalHeight, width / image.naturalWidth) * zoom;
    const renderedWidth = image.naturalWidth * imageScale;
    const renderedHeight = image.naturalHeight * imageScale;
    const normalized = ((offset % renderedWidth) + renderedWidth) % renderedWidth;
    for (let x = normalized - renderedWidth; x < width; x += renderedWidth) {
      context.drawImage(image, x, (height - renderedHeight) / 2, renderedWidth, renderedHeight);
    }
  };
  image.onload = () => {
    canvas.dataset.panoramaLoaded = "true";
    draw();
  };
  image.onerror = () => {
    canvas.dataset.panoramaLoaded = "error";
    onError?.("全景图片无法解码");
  };
  image.src = sourceUrl;
  const observer = new ResizeObserver(draw);
  observer.observe(container);
  const pointerDown = (event: PointerEvent) => {
    previousX = event.clientX;
    canvas.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent) => {
    if (previousX === null) return;
    offset += event.clientX - previousX;
    previousX = event.clientX;
    draw();
  };
  const pointerUp = () => { previousX = null; };
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    zoom = nextPanoramaViewerZoom(zoom, event.deltaY);
    draw();
  };
  canvas.addEventListener("wheel", wheel, { passive: false });
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") offset += 32;
    else if (event.key === "ArrowRight") offset -= 32;
    else if (event.key === "+" || event.key === "=") zoom = Math.min(3, zoom * 1.1);
    else if (event.key === "-" || event.key === "_") zoom = Math.max(1, zoom / 1.1);
    else return;
    event.preventDefault();
    draw();
  };
  container.addEventListener("keydown", keyDown);
  draw();
  return () => {
    observer.disconnect();
    canvas.removeEventListener("pointerdown", pointerDown);
    canvas.removeEventListener("pointermove", pointerMove);
    canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("pointercancel", pointerUp);
    canvas.removeEventListener("wheel", wheel);
    container.removeEventListener("keydown", keyDown);
    canvas.remove();
  };
}

export function PanoramaViewport({ sourceUrl, onError }: { sourceUrl: string; onError?: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const reportError = useCallback((message: string) => {
    setRuntimeError(message);
    onError?.(message);
  }, [onError]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setRuntimeError(null);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      return mountFallback(container, sourceUrl, reportError);
    }
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 100);
    camera.position.set(0, 0, 0.1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.domElement.dataset.nativePanoramaCanvas = "true";
    renderer.domElement.dataset.panoramaRenderer = "webgl";
    container.replaceChildren(renderer.domElement);
    const geometry = new THREE.SphereGeometry(10, 64, 40);
    geometry.scale(-1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    scene.add(new THREE.Mesh(geometry, material));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.rotateSpeed = -0.35;
    controls.minDistance = 0.1;
    controls.maxDistance = 0.1;
    let disposed = false;
    let texture: THREE.Texture | null = null;
    new THREE.TextureLoader().load(sourceUrl, (loaded) => {
      if (disposed) return loaded.dispose();
      const image = loaded.image as { width?: number; height?: number } | undefined;
      if ((image?.width ?? 0) > renderer.capabilities.maxTextureSize ||
          (image?.height ?? 0) > renderer.capabilities.maxTextureSize) {
        loaded.dispose();
        renderer.domElement.dataset.panoramaLoaded = "error";
        reportError(`全景图片超过当前设备 ${renderer.capabilities.maxTextureSize}px 的纹理限制`);
        return;
      }
      loaded.colorSpace = THREE.SRGBColorSpace;
      texture?.dispose();
      texture = loaded;
      material.map = loaded;
      material.needsUpdate = true;
      renderer.domElement.dataset.panoramaLoaded = "true";
    }, undefined, () => {
      renderer.domElement.dataset.panoramaLoaded = "error";
      reportError("全景图片无法解码");
    });
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
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      camera.fov = nextPanoramaFieldOfView(camera.fov, event.deltaY);
      camera.updateProjectionMatrix();
    };
    container.addEventListener("wheel", wheel, { passive: false, capture: true });
    const keyDown = (event: KeyboardEvent) => {
      const step = THREE.MathUtils.degToRad(8);
      if (event.key === "ArrowLeft") controls.rotateLeft(step);
      else if (event.key === "ArrowRight") controls.rotateLeft(-step);
      else if (event.key === "ArrowUp") controls.rotateUp(step);
      else if (event.key === "ArrowDown") controls.rotateUp(-step);
      else if (event.key === "+" || event.key === "=") camera.fov = Math.max(35, camera.fov - 5);
      else if (event.key === "-" || event.key === "_") camera.fov = Math.min(100, camera.fov + 5);
      else return;
      event.preventDefault();
      camera.updateProjectionMatrix();
      controls.update();
    };
    container.addEventListener("keydown", keyDown);
    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener("wheel", wheel, { capture: true });
      container.removeEventListener("keydown", keyDown);
      controls.dispose();
      texture?.dispose();
      geometry.dispose();
      material.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [reportError, sourceUrl]);
  return (
    <div className="relative h-full w-full bg-slate-950">
      <div ref={containerRef} tabIndex={0} className="h-full w-full outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" aria-label="360° 全景视图" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + -" />
      {runtimeError ? (
        <div role="alert" className="pointer-events-none absolute inset-x-6 bottom-6 rounded bg-red-950/90 px-4 py-3 text-center text-sm text-red-100">
          {runtimeError}
        </div>
      ) : null}
    </div>
  );
}
