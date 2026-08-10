import type { FilmTimeline, FilmTimelineClip } from "@/types/film";

const MIN_TIMELINE_SECONDS = 10;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function snapToFrame(value: number, frameRate: number): number {
  const fps = Math.max(1, Math.min(120, Math.round(finite(frameRate, 24))));
  return Math.round(finite(value) * fps) / fps;
}

export function timelineDuration(timeline: Pick<FilmTimeline, "tracks">): number {
  const end = timeline.tracks.reduce((maximum, track) => track.clips.reduce((trackMaximum, clip) => Math.max(trackMaximum, finite(clip.end)), maximum), 0);
  return Math.max(MIN_TIMELINE_SECONDS, Math.ceil(end) + 1);
}

export function timelineTimeToPercent(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(100, finite(time) / duration * 100));
}

export function moveTimelineClip(clip: FilmTimelineClip, delta: number, duration: number, frameRate: number): FilmTimelineClip {
  const length = Math.max(1 / Math.max(1, frameRate), clip.end - clip.start);
  const requestedStart = snapToFrame(clip.start + finite(delta), frameRate);
  const start = Math.max(0, Math.min(Math.max(0, duration - length), requestedStart));
  return { ...clip, revision: clip.revision + 1, start, end: start + length };
}

export function resizeTimelineClip(clip: FilmTimelineClip, edge: "start" | "end", time: number, frameRate: number): FilmTimelineClip {
  const frame = 1 / Math.max(1, Math.min(120, Math.round(finite(frameRate, 24))));
  if (edge === "start") {
    const start = Math.max(0, Math.min(clip.end - frame, snapToFrame(time, frameRate)));
    return { ...clip, revision: clip.revision + 1, start, trimIn: Math.max(0, clip.trimIn + start - clip.start) };
  }
  const end = Math.max(clip.start + frame, snapToFrame(time, frameRate));
  return { ...clip, revision: clip.revision + 1, end, trimOut: Math.max(0, clip.trimOut + end - clip.end) };
}
