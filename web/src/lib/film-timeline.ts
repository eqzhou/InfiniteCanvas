import type { FilmTimeline, FilmTimelineClip } from "@/types/film";

type NewFilmTimelineClip = Pick<FilmTimelineClip, "source" | "start" | "end"> & Partial<Omit<FilmTimelineClip, "id" | "revision" | "source" | "start" | "end">>;

function clipId(trackId: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `clip-${trackId}-${suffix}`;
}
export function addFilmTimelineClip(
  timeline: FilmTimeline,
  trackId: string,
  input: NewFilmTimelineClip,
): FilmTimeline {
  if (!timeline.tracks.some((track) => track.id === trackId)) throw new Error("时间线轨道不存在");
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => track.id !== trackId ? track : {
      ...track,
      clips: [...track.clips, {
        id: clipId(track.id),
        revision: 1,
        order: track.clips.length,
        trimIn: 0,
        trimOut: 0,
        volume: 1,
        muted: false,
        fadeIn: 0,
        fadeOut: 0,
        transition: "cut",
        ...input,
      }],
    }),
  };
}

export function updateFilmTimelineClip(
  timeline: FilmTimeline,
  trackId: string,
  clipIdToUpdate: string,
  patch: Partial<Omit<FilmTimelineClip, "id" | "revision">>,
): FilmTimeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => track.id !== trackId ? track : {
      ...track,
      clips: track.clips.map((clip) => clip.id === clipIdToUpdate ? { ...clip, ...patch } : clip),
    }),
  };
}

export function removeFilmTimelineClip(timeline: FilmTimeline, trackId: string, clipIdToRemove: string): FilmTimeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => track.id !== trackId ? track : {
      ...track,
      clips: track.clips
        .filter((clip) => clip.id !== clipIdToRemove)
        .map((clip, order) => ({ ...clip, order })),
    }),
  };
}

export function moveFilmTimelineClip(
  timeline: FilmTimeline,
  trackId: string,
  clipIdToMove: string,
  offset: -1 | 1,
): FilmTimeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => {
      if (track.id !== trackId) return track;
      const currentIndex = track.clips.findIndex((clip) => clip.id === clipIdToMove);
      const nextIndex = Math.max(0, Math.min(track.clips.length - 1, currentIndex + offset));
      if (currentIndex < 0 || currentIndex === nextIndex) return track;
      const clips = [...track.clips];
      const [moved] = clips.splice(currentIndex, 1);
      clips.splice(nextIndex, 0, moved!);
      return { ...track, clips: clips.map((clip, order) => ({ ...clip, order })) };
    }),
  };
}

export function validateFilmTimelineDraft(timeline: FilmTimeline): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(timeline.width) || timeline.width < 320 || timeline.width > 7680) errors.push("画面宽度应在 320–7680 之间");
  if (!Number.isFinite(timeline.height) || timeline.height < 240 || timeline.height > 4320) errors.push("画面高度应在 240–4320 之间");
  if (!Number.isFinite(timeline.frameRate) || timeline.frameRate < 1 || timeline.frameRate > 120) errors.push("帧率应在 1–120 之间");
  const requiredKinds = new Set(["video", "dialogue", "music", "sfx", "subtitle"]);
  for (const track of timeline.tracks) {
    requiredKinds.delete(track.kind);
    const orders = new Set<number>();
    for (const clip of track.clips) {
      const label = `${track.title} / ${clip.source || clip.id}`;
      if (!Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start) {
        errors.push(`${label}：入点必须早于出点，且不得为负数`);
      }
      if (!Number.isFinite(clip.trimIn) || !Number.isFinite(clip.trimOut) || clip.trimIn < 0 || clip.trimOut < 0) {
        errors.push(`${label}：素材 in/out 不得为负数`);
      }
      if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 2) errors.push(`${label}：音量应在 0–2 之间`);
      const duration = clip.end - clip.start;
      if (!Number.isFinite(clip.fadeIn) || !Number.isFinite(clip.fadeOut) || clip.fadeIn < 0 || clip.fadeOut < 0 || clip.fadeIn + clip.fadeOut > duration) {
        errors.push(`${label}：淡入淡出时长无效`);
      }
      if (track.kind === "subtitle" && !clip.text?.trim()) errors.push(`${label}：字幕文本不能为空`);
      if (!Number.isInteger(clip.order) || clip.order < 0 || orders.has(clip.order)) errors.push(`${label}：片段排序值无效`);
      orders.add(clip.order);
    }
  }
  if (requiredKinds.size) errors.push(`缺少轨道：${[...requiredKinds].join("、")}`);
  return errors;
}
