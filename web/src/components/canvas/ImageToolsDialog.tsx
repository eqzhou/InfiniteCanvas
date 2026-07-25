import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import type { BoardNode } from "@/types/board";
import type { ImageTransformContext } from "@/services/image-transform/types";
import { useEscapeDismiss } from "@/lib/use-escape-dismiss";

export type ImageToolMode = "mask" | "upscale" | "split";
export type ImageToolProviderOption = {
  id: string;
  label: string;
  kind: "local" | "cloud";
};

export function ImageToolsDialog({
  node,
  mode,
  open,
  onClose,
  onMask,
  onUpscale,
  onSplit,
  providers,
}: {
  node: BoardNode;
  mode: ImageToolMode;
  open: boolean;
  onClose: () => void;
  onMask: (
    mask: { x: number; y: number; w: number; h: number },
    keep: boolean,
    providerId: string,
    prompt: string,
    context: ImageTransformContext,
  ) => Promise<void>;
  onUpscale: (scale: number, providerId: string, context: ImageTransformContext) => Promise<void>;
  onSplit: (vertical: number[], horizontal: number[]) => Promise<void>;
  providers: ImageToolProviderOption[];
}) {
  const [x, setX] = useState(0.15);
  const [y, setY] = useState(0.15);
  const [w, setW] = useState(0.7);
  const [h, setH] = useState(0.7);
  const [keep, setKeep] = useState(true);
  const [scale, setScale] = useState(2);
  const [vertical, setVertical] = useState([0.5]);
  const [horizontal, setHorizontal] = useState([0.5]);
  const [selectedGuide, setSelectedGuide] = useState<{ axis: "vertical" | "horizontal"; index: number } | null>(null);
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "local-canvas");
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEscapeDismiss(open, () => {
    abortRef.current?.abort();
    onClose();
  });

  useEffect(() => {
    if (!providers.some((provider) => provider.id === providerId)) {
      setProviderId(providers[0]?.id ?? "local-canvas");
    }
  }, [providerId, providers]);

  // Always keep a valid guide selected in split mode so delete/reset actions work
  // after drag (pointer capture can swallow click) or when adding lines.
  useEffect(() => {
    if (mode !== "split") {
      setSelectedGuide(null);
      return;
    }
    setSelectedGuide((current) => {
      if (current?.axis === "vertical" && current.index < vertical.length) return current;
      if (current?.axis === "horizontal" && current.index < horizontal.length) return current;
      if (vertical.length) return { axis: "vertical", index: Math.max(0, vertical.length - 1) };
      if (horizontal.length) return { axis: "horizontal", index: Math.max(0, horizontal.length - 1) };
      return null;
    });
  }, [mode, vertical.length, horizontal.length]);

  if (!open) return null;
  const title =
    mode === "mask" ? "遮罩编辑" : mode === "upscale" ? "图像放大" : "网格切分";
  const selectedProvider = providers.find((provider) => provider.id === providerId);

  const execute = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setProgress(0);
    setError("");
    const context: ImageTransformContext = {
      signal: controller.signal,
      onProgress: setProgress,
    };
    try {
      if (mode === "mask") await onMask({ x, y, w, h }, keep, providerId, prompt, context);
      else if (mode === "upscale") await onUpscale(scale, providerId, context);
      else await onSplit(vertical, horizontal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    onClose();
  };


  function imageLayoutRect(): DOMRect | null {
    return imageRef.current?.getBoundingClientRect() ?? null;
  }

  function fractionFromClientX(clientX: number): number {
    const rect = imageLayoutRect();
    if (!rect || rect.width <= 0) return 0.5;
    return Math.min(0.99, Math.max(0.01, (clientX - rect.left) / rect.width));
  }

  function fractionFromClientY(clientY: number): number {
    const rect = imageLayoutRect();
    if (!rect || rect.height <= 0) return 0.5;
    return Math.min(0.99, Math.max(0.01, (clientY - rect.top) / rect.height));
  }

  function imageOverlayStyle(): Record<string, string | number> {
    const box = previewRef.current?.getBoundingClientRect();
    const img = imageLayoutRect();
    if (!box || !img) {
      return { left: 0, top: 0, width: "100%", height: "100%" };
    }
    return {
      left: img.left - box.left,
      top: img.top - box.top,
      width: img.width,
      height: img.height,
    };
  }

  return createPortal(
    <div className="ob-overlay-canvas p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-tools-title"
        className="ob-dialog max-w-md p-0"
      >
        <header className="ob-dialog-header px-4 py-3">
          <div className="min-w-0">
            <p className="ob-page-kicker">Image</p>
            <h2 id="image-tools-title" className="text-base font-semibold tracking-tight">{title}</h2>
          </div>
          <button
            type="button"
            className="ob-icon-btn ml-auto"
            aria-label="关闭图像工具"
            title="关闭图像工具"
            onClick={cancel}
          >
            <X size={16} />
          </button>
        </header>
        <div className="ob-dialog-body space-y-3">
        {node.metadata.content ? (
          <div ref={previewRef} className="relative overflow-hidden rounded-xl bg-[var(--ob-canvas)] p-2 shadow-[var(--ob-elev-1)]">
            <img
              ref={imageRef}
              src={node.metadata.content}
              alt=""
              className="mx-auto max-h-48 object-contain"
              onLoad={() => {
                // Force a re-render so overlay geometry uses the laid-out image box.
                setX((value) => value);
              }}
            />
            <div className="pointer-events-none absolute" style={imageOverlayStyle()}>
              {mode === "mask" ? (
                <div
                  className="absolute border-2 border-[var(--ob-select)] bg-[color-mix(in_srgb,var(--ob-select)_18%,transparent)]"
                  style={{
                    left: `${x * 100}%`,
                    top: `${y * 100}%`,
                    width: `${w * 100}%`,
                    height: `${h * 100}%`,
                  }}
                />
              ) : null}
              {mode === "split" ? (
                <div className="pointer-events-auto absolute inset-0">
                  {vertical.map((value, index) => (
                    <button
                      key={`v-${index}`}
                      type="button"
                      aria-label={`纵向分割线 ${index + 1}`}
                      className="absolute inset-y-0 z-10 w-3 -translate-x-1/2 cursor-col-resize bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:bg-[var(--ob-select)]"
                      style={{ left: `${value * 100}%` }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setSelectedGuide({ axis: "vertical", index });
                      }}
                      onMouseDown={() => setSelectedGuide({ axis: "vertical", index })}
                      onClick={() => setSelectedGuide({ axis: "vertical", index })}
                      onPointerMove={(event) => {
                        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                        const next = fractionFromClientX(event.clientX);
                        setVertical((current) => current.map((item, itemIndex) => itemIndex === index ? next : item));
                      }}
                    />
                  ))}
                  {horizontal.map((value, index) => (
                    <button
                      key={`h-${index}`}
                      type="button"
                      aria-label={`横向分割线 ${index + 1}`}
                      className="absolute inset-x-0 z-10 h-3 -translate-y-1/2 cursor-row-resize bg-transparent after:absolute after:inset-x-0 after:top-1/2 after:h-0.5 after:bg-[var(--ob-select)]"
                      style={{ top: `${value * 100}%` }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setSelectedGuide({ axis: "horizontal", index });
                      }}
                      onMouseDown={() => setSelectedGuide({ axis: "horizontal", index })}
                      onClick={() => setSelectedGuide({ axis: "horizontal", index })}
                      onPointerMove={(event) => {
                        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                        const next = fractionFromClientY(event.clientY);
                        setHorizontal((current) => current.map((item, itemIndex) => itemIndex === index ? next : item));
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {mode === "mask" ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <Num label="X" value={x} onChange={setX} step={0.01} min={0} max={1} />
            <Num label="Y" value={y} onChange={setY} step={0.01} min={0} max={1} />
            <Num label="宽" value={w} onChange={setW} step={0.01} min={0.05} max={1} />
            <Num label="高" value={h} onChange={setH} step={0.01} min={0.05} max={1} />
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={keep} disabled={selectedProvider?.kind === "cloud"} onChange={(e) => setKeep(e.target.checked)} />
              保留框内（取消则擦除框内）
            </label>
            {selectedProvider?.kind === "cloud" ? (
              <label className="col-span-2 flex flex-col gap-1">
                <span className="ob-label">局部重绘提示词</span>
                <textarea
                  value={prompt}
                  maxLength={4000}
                  rows={3}
                  className="ob-field resize-none px-2 py-1"
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {(mode === "mask" || mode === "upscale") && providers.length > 0 ? (
          <label className="mt-3 flex flex-col gap-1 text-sm">
            处理方式
            <select
              className="ob-field px-2 py-1"
              value={providerId}
              disabled={running}
              onChange={(event) => setProviderId(event.target.value)}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </label>
        ) : null}

        {mode === "upscale" ? (
          <label className="flex flex-col gap-1 text-sm">
            放大倍数
            <select
              className="ob-field px-2 py-1"
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
            >
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
              <option value={3}>3x</option>
              <option value={4}>4x</option>
            </select>
            <span className="ob-label">
              {selectedProvider?.kind === "cloud"
                ? "调用当前 AI 渠道的超分接口；不支持时仅回退到该渠道的图像编辑接口。"
                : "浏览器 Canvas 插值，不调用云端模型。"}
            </span>
          </label>
        ) : null}

        {mode === "split" ? (
          <div className="flex flex-wrap gap-2 text-sm">
            <button
              type="button"
              className="ob-btn px-2 py-1"
              onClick={() => {
                setVertical((current) => {
                  setSelectedGuide({ axis: "vertical", index: current.length });
                  return [...current, 0.5];
                });
              }}
            >
              新增纵线
            </button>
            <button
              type="button"
              className="ob-btn px-2 py-1"
              onClick={() => {
                setHorizontal((current) => {
                  setSelectedGuide({ axis: "horizontal", index: current.length });
                  return [...current, 0.5];
                });
              }}
            >
              新增横线
            </button>
            <button
              type="button"
              className="ob-btn px-2 py-1 disabled:opacity-40"
              disabled={!selectedGuide}
              onClick={() => {
                if (!selectedGuide) return;
                if (selectedGuide.axis === "vertical") {
                  setVertical((current) => current.filter((_, index) => index !== selectedGuide.index));
                } else {
                  setHorizontal((current) => current.filter((_, index) => index !== selectedGuide.index));
                }
                setSelectedGuide(null);
              }}
            >
              删除选中线
            </button>
            <button type="button" className="ob-btn px-2 py-1" onClick={() => {
              setVertical([0.5]);
              setHorizontal([0.5]);
              setSelectedGuide(null);
            }}>
              重置
            </button>
          </div>
        ) : null}

        {running ? (
          <div className="mt-3 h-1.5 overflow-hidden rounded bg-[var(--ob-canvas)]" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
            <div className="h-full bg-[var(--ob-accent)] transition-[width]" style={{ width: `${progress * 100}%` }} />
          </div>
        ) : null}
        {error ? (
          <p className="rounded-lg border border-[color-mix(in_srgb,var(--ob-danger)_28%,var(--ob-line))] bg-[color-mix(in_srgb,var(--ob-danger)_8%,transparent)] px-2.5 py-2 text-sm text-[var(--ob-danger)]">
            {error}
          </p>
        ) : null}
        </div>
        <div className="ob-dialog-footer">
          <button type="button" className="ob-btn" onClick={cancel}>
            取消
          </button>
          <button
            type="button"
            className="ob-btn-primary"
            disabled={running || ((mode === "mask" || mode === "upscale") && !selectedProvider) ||
              (mode === "mask" && selectedProvider?.kind === "cloud" && !prompt.trim())}
            onClick={() => void execute()}
          >
            {running ? "处理中" : "应用"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Num({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step: number;
  min: number;
  max: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="ob-label">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        className="ob-field px-2 py-1"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
