import type { CameraPromptConfig } from "@/types/board";
import {
  CAMERA_PROMPT_CAMERAS,
  CAMERA_PROMPT_LENSES,
} from "@/lib/camera-prompt";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/I18nProvider";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

type Props = {
  value: CameraPromptConfig;
  anchor: HTMLElement | null;
  onChange: (value: CameraPromptConfig) => void;
  onClose: () => void;
};

export function CameraPromptPanel({ value, anchor, onChange, onClose }: Props) {
  const { t } = useI18n();
  const patch = (next: Partial<CameraPromptConfig>) => onChange({ ...value, ...next });
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const [position, setPosition] = useState({ left: 12, top: 64 });
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!anchor) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      const height = panelRef.current?.offsetHeight ?? 310;
      const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.left));
      const preferredTop = rect.top - height - 10;
      const top = preferredTop >= 56
        ? preferredTop
        : Math.min(window.innerHeight - height - 12, Math.max(56, rect.bottom + 10));
      setPosition((current) => current.left === left && current.top === top ? current : { left, top });
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(anchor);
    if (panelRef.current) resizeObserver.observe(panelRef.current);
    const mutationObserver = new MutationObserver(scheduleUpdate);
    let ancestor: HTMLElement | null = anchor;
    while (ancestor && ancestor !== document.body) {
      mutationObserver.observe(ancestor, { attributes: true, attributeFilter: ["class", "style"] });
      ancestor = ancestor.parentElement;
    }
    window.addEventListener("resize", scheduleUpdate);
    document.addEventListener("scroll", scheduleUpdate, true);
    document.addEventListener("pointermove", scheduleUpdate, true);
    document.addEventListener("wheel", scheduleUpdate, true);
    document.addEventListener("input", scheduleUpdate, true);
    document.addEventListener("change", scheduleUpdate, true);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleUpdate);
    scheduleUpdate();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      document.removeEventListener("scroll", scheduleUpdate, true);
      document.removeEventListener("pointermove", scheduleUpdate, true);
      document.removeEventListener("wheel", scheduleUpdate, true);
      document.removeEventListener("input", scheduleUpdate, true);
      document.removeEventListener("change", scheduleUpdate, true);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [anchor]);

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchor?.contains(target)) onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [anchor]);

  return createPortal(
    <section
      ref={panelRef}
      role="dialog"
      aria-label={t("camera.aria")}
      className="ob-chrome fixed z-[100] w-[min(320px,calc(100vw-24px))] p-3 text-xs"
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="mb-3 flex items-center gap-2">
        <div>
          <div className="font-semibold text-[var(--ob-ink)]">{t("camera.aria")}</div>
          <div className="text-[10px] text-[var(--ob-muted)]">{t("camera.description")}</div>
        </div>
        <button type="button" className="ob-icon-btn ml-auto h-7 w-7" title={t("camera.close")} onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <label className="mb-3 flex items-center gap-2 rounded border border-[var(--ob-line)] p-2">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => patch({ enabled: event.target.checked })}
        />
        {t("camera.enabled")}
      </label>
      <div className="grid grid-cols-2 gap-2" aria-disabled={!value.enabled}>
        <label className="flex flex-col gap-1">
          {t("camera.camera")}
          <select
            aria-label={t("camera.camera")}
            disabled={!value.enabled}
            className="rounded border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1.5"
            value={value.camera}
            onChange={(event) => patch({ camera: event.target.value as CameraPromptConfig["camera"] })}
          >
            {CAMERA_PROMPT_CAMERAS.map((item) => <option key={item.value} value={item.value}>{t(`camera.${item.value}` as "camera.cinema" | "camera.mirrorless" | "camera.dslr" | "camera.drone" | "camera.action")}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          {t("camera.lens")}
          <select
            aria-label={t("camera.lens")}
            disabled={!value.enabled}
            className="rounded border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1.5"
            value={value.lens}
            onChange={(event) => patch({ lens: event.target.value as CameraPromptConfig["lens"] })}
          >
            {CAMERA_PROMPT_LENSES.map((item) => <option key={item.value} value={item.value}>{t(`camera.${item.value}` as "camera.wide" | "camera.standard" | "camera.telephoto" | "camera.macro" | "camera.anamorphic")}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          {t("camera.focalLengthLabel")}
          <input
            aria-label={t("camera.focalLength")}
            type="number"
            min={8}
            max={600}
            step={1}
            disabled={!value.enabled}
            className="rounded border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1.5"
            value={value.focalLength}
            onChange={(event) => patch({ focalLength: Math.min(600, Math.max(8, Number(event.target.value) || 8)) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          {t("camera.apertureLabel")}
          <input
            aria-label={t("camera.aperture")}
            type="number"
            min={0.7}
            max={64}
            step={0.1}
            disabled={!value.enabled}
            className="rounded border border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1.5"
            value={value.aperture}
            onChange={(event) => patch({ aperture: Math.min(64, Math.max(0.7, Number(event.target.value) || 0.7)) })}
          />
        </label>
      </div>
    </section>,
    document.body,
  );
}
