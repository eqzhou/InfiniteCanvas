import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectorCamera, DirectorCameraEase, DirectorScene } from "@/types/board";
import {
  addDirectorCameraKeyframe,
  addDirectorCameraMove,
  cameraForDirectorKeyframe,
  evaluateDirectorCameraMove,
  removeDirectorCameraKeyframe,
  removeDirectorCameraMove,
  selectDirectorCameraMove,
  updateDirectorCameraKeyframe,
  updateDirectorCameraMove,
} from "@/lib/director-camera-move";
import { selectDirectorCamera } from "@/lib/director-scene";
import { useI18n } from "@/i18n/I18nProvider";

const EASES: readonly DirectorCameraEase[] = ["linear", "ease-in", "ease-out", "ease-in-out"];

export function DirectorCameraMovePanel({
  scene,
  onChange,
  onPreview,
  previewPose = null,
}: {
  scene: DirectorScene;
  onChange: (scene: DirectorScene) => void;
  onPreview: (pose: Pick<DirectorCamera, "position" | "target" | "focalLength"> | null) => void;
  previewPose?: Pick<DirectorCamera, "position" | "target" | "focalLength"> | null;
}) {
  const { t } = useI18n();
  const moves = scene.cameraMoves ?? [];
  const active = moves.find((move) => move.id === scene.activeCameraMoveId) ?? moves[0] ?? null;
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const activeRef = useRef(active);
  const playingMoveIdRef = useRef<string | null>(null);
  const liveRef = useRef(true);
  activeRef.current = active;

  const stop = useCallback(() => {
    if (playRef.current !== null) cancelAnimationFrame(playRef.current);
    playRef.current = null;
    playingMoveIdRef.current = null;
    if (liveRef.current) setPlaying(false);
    onPreview(null);
  }, [onPreview]);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      if (playRef.current !== null) cancelAnimationFrame(playRef.current);
      playingMoveIdRef.current = null;
      onPreview(null);
    };
  }, [onPreview]);

  useEffect(() => {
    if (playingMoveIdRef.current && playingMoveIdRef.current !== active?.id) stop();
  }, [active?.id, stop]);

  const play = () => {
    if (!active) return;
    const bound = scene.cameras.find((camera) => camera.id === active.cameraId);
    if (!bound) return;
    if (scene.activeCameraId !== bound.id) onChange(selectDirectorCamera(scene, bound.id));
    if (playRef.current !== null) cancelAnimationFrame(playRef.current);
    playRef.current = null;
    playingMoveIdRef.current = active.id;
    setPlaying(true);
    startedAtRef.current = performance.now();
    onPreview(evaluateDirectorCameraMove(active, 0));
    const tick = (now: number) => {
      if (!liveRef.current) return;
      const move = activeRef.current;
      if (!move || move.id !== playingMoveIdRef.current) {
        stop();
        return;
      }
      const elapsed = (now - startedAtRef.current) / 1000;
      onPreview(evaluateDirectorCameraMove(move, elapsed));
      if (!move.loop && elapsed >= move.duration) {
        stop();
        return;
      }
      playRef.current = requestAnimationFrame(tick);
    };
    playRef.current = requestAnimationFrame(tick);
  };

  return (
    <section className="mt-6 border-t border-white/10 pt-4" aria-label={t("director.moveTimeline")}>
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("director.moveTimeline")}</h3>
        <button type="button" className="ml-auto rounded px-2 py-1 text-[11px] hover:bg-white/10" onClick={() => onChange(addDirectorCameraMove(scene))}>
          {t("director.addMove")}
        </button>
      </div>
      {moves.length ? (
        <label className="mb-3 block">{t("director.activeMove")}
          <select
            aria-label={t("director.activeMove")}
            className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1.5"
            value={active?.id ?? ""}
            onChange={(event) => onChange(selectDirectorCameraMove(scene, event.target.value || null))}
          >
            {moves.map((move) => <option key={move.id} value={move.id}>{move.name}</option>)}
          </select>
        </label>
      ) : <p className="text-xs text-slate-500">{t("director.moveHint")}</p>}
      {active ? (
        <>
          <label className="mb-3 block">{t("director.moveName")}
            <input aria-label={t("director.moveName")} className="mt-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1.5" value={active.name} onChange={(event) => onChange(updateDirectorCameraMove(scene, active.id, { name: event.target.value || active.name }))} />
          </label>
          <label className="mb-3 block">{t("director.moveDuration")}
            <input aria-label={t("director.moveDuration")} type="number" min={0.2} max={120} step={0.1} className="mt-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1.5" value={active.duration} onChange={(event) => { const duration = event.target.valueAsNumber; if (Number.isFinite(duration)) onChange(updateDirectorCameraMove(scene, active.id, { duration })); }} />
          </label>
          <label className="mb-3 flex items-center gap-2">
            <input type="checkbox" checked={active.loop} onChange={(event) => onChange(updateDirectorCameraMove(scene, active.id, { loop: event.target.checked }))} />
            {t("director.moveLoop")}
          </label>
          <div className="mb-3 flex flex-wrap gap-1">
            <button type="button" className="rounded bg-[#f0f269] px-2 py-1 text-[11px] font-semibold text-black" onClick={playing ? stop : play}>
              {playing ? t("director.stopMove") : t("director.playMove")}
            </button>
            <button type="button" className="rounded px-2 py-1 text-[11px] hover:bg-white/10" onClick={() => {
              onChange(addDirectorCameraKeyframe(scene, active.id, {
                camera: cameraForDirectorKeyframe(scene, active.cameraId, previewPose),
              }));
            }}>
              {t("director.addKeyframe")}
            </button>
            <button type="button" className="rounded px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10" onClick={() => { stop(); onChange(removeDirectorCameraMove(scene, active.id)); }}>
              {t("director.deleteMove")}
            </button>
          </div>
          <ol className="space-y-2">
            {active.keyframes.map((frame, index) => (
              <li key={frame.id} className="rounded border border-white/10 p-2">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
                  <span>{t("director.keyframe", { index: index + 1 })}</span>
                  <button type="button" className="ml-auto disabled:opacity-40" disabled={active.keyframes.length <= 2} onClick={() => onChange(removeDirectorCameraKeyframe(scene, active.id, index))}>
                    {t("director.deleteKeyframe")}
                  </button>
                </div>
                <label className="mb-1 block text-[11px]">{t("director.keyframeTime")}
                  <input aria-label={t("director.keyframeTime")} type="number" min={0} max={1} step={0.05} className="mt-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1" value={frame.time} onChange={(event) => { const time = event.target.valueAsNumber; if (Number.isFinite(time)) onChange(updateDirectorCameraKeyframe(scene, active.id, index, { time })); }} />
                </label>
                <label className="block text-[11px]">{t("director.keyframeEase")}
                  <select aria-label={t("director.keyframeEase")} className="mt-1 w-full rounded border border-white/10 bg-[#222] px-2 py-1" value={frame.ease} onChange={(event) => onChange(updateDirectorCameraKeyframe(scene, active.id, index, { ease: event.target.value as DirectorCameraEase }))}>
                    {EASES.map((ease) => <option key={ease} value={ease}>{t(ease === "ease-in" ? "director.ease.in" : ease === "ease-out" ? "director.ease.out" : ease === "ease-in-out" ? "director.ease.inOut" : "director.ease.linear")}</option>)}
                  </select>
                </label>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
