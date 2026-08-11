import { useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useI18n } from "@/i18n/I18nProvider";

export type AudioTimelineState = {
  currentTime: number;
  duration: number;
  progress: number;
  currentLabel: string;
  durationLabel: string;
};

function finiteSeconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatAudioSeconds(
  value: number,
  showTenths: boolean,
  rounding: "floor" | "nearest" = "nearest",
): string {
  if (!showTenths) {
    const seconds = Math.max(0, Math.floor(value));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  const totalTenths = Math.max(0, rounding === "floor" ? Math.floor(value * 10) : Math.round(value * 10));
  const minutes = Math.floor(totalTenths / 600);
  const remainingTenths = totalTenths % 600;
  const seconds = Math.floor(remainingTenths / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${remainingTenths % 10}`;
}

export function audioTimelineState(currentTime: number, duration: number, ended: boolean): AudioTimelineState {
  const safeDuration = finiteSeconds(duration);
  const safeCurrent = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
  const boundedCurrent = safeDuration
    ? ended ? safeDuration : Math.min(safeCurrent, safeDuration)
    : 0;
  const progress = safeDuration ? (boundedCurrent / safeDuration) * 100 : 0;
  const showTenths = safeDuration > 0 && !Number.isInteger(safeDuration);
  return {
    currentTime: boundedCurrent,
    duration: safeDuration,
    progress: ended && safeDuration ? 100 : progress,
    // While playing, never let the label reach the rounded duration before
    // the media element has actually ended. The ended state intentionally
    // uses the same nearest-tenth representation as the duration.
    currentLabel: formatAudioSeconds(boundedCurrent, showTenths, ended ? "nearest" : "floor"),
    durationLabel: formatAudioSeconds(safeDuration, showTenths),
  };
}

export function AudioNodePlayer({ src }: { src: string }) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement>(null);
  const frameRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [timeline, setTimeline] = useState<AudioTimelineState>(() => audioTimelineState(0, 0, false));

  const stopProgressLoop = () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };
  const syncTimeline = (ended = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    setTimeline(audioTimelineState(audio.currentTime, audio.duration, ended || audio.ended));
  };
  const startProgressLoop = () => {
    stopProgressLoop();
    const update = () => {
      const audio = audioRef.current;
      if (!audio) return;
      setTimeline(audioTimelineState(audio.currentTime, audio.duration, audio.ended));
      if (!audio.paused && !audio.ended) frameRef.current = requestAnimationFrame(update);
    };
    frameRef.current = requestAnimationFrame(update);
  };

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        setPlaying(false);
      }
    } else {
      audio.pause();
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-full bg-[color-mix(in_srgb,var(--ob-ink)_16%,transparent)] px-2 py-1.5">
      <audio
        ref={audioRef}
        src={src}
        aria-hidden="true"
        className="hidden"
        preload="metadata"
        onLoadedMetadata={() => syncTimeline()}
        onDurationChange={() => syncTimeline()}
        onTimeUpdate={() => syncTimeline()}
        onPlay={() => {
          setPlaying(true);
          startProgressLoop();
        }}
        onPause={() => {
          setPlaying(false);
          stopProgressLoop();
          syncTimeline();
        }}
        onEnded={() => {
          setPlaying(false);
          stopProgressLoop();
          syncTimeline(true);
        }}
      />
      <button
        type="button"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--ob-ink)] hover:bg-[var(--ob-accent-soft)]"
        aria-label={playing ? t("audioPlayer.pause") : t("audioPlayer.play")}
        onClick={() => void togglePlayback()}
      >
        {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
      </button>
      <span className="shrink-0 tabular-nums text-[10px] text-[var(--ob-muted)]">
        {timeline.currentLabel} / {timeline.durationLabel}
      </span>
      <input
        type="range"
        aria-label={t("audioPlayer.progress")}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--ob-accent)]"
        min={0}
        max={100}
        step={0.1}
        value={timeline.progress}
        onChange={(event) => {
          const audio = audioRef.current;
          if (!audio || !timeline.duration) return;
          const nextProgress = Math.max(0, Math.min(100, Number(event.target.value)));
          audio.currentTime = (nextProgress / 100) * timeline.duration;
          syncTimeline();
        }}
      />
      <button
        type="button"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--ob-ink)] hover:bg-[var(--ob-accent-soft)]"
        aria-label={muted ? t("audioPlayer.unmute") : t("audioPlayer.mute")}
        onClick={() => {
          const nextMuted = !muted;
          if (audioRef.current) audioRef.current.muted = nextMuted;
          setMuted(nextMuted);
        }}
      >
        {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
    </div>
  );
}
