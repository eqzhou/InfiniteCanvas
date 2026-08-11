import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Download, Plus, Save, Trash2 } from "lucide-react";

import { useI18n } from "@/i18n/I18nProvider";
import { addFilmTimelineClip, moveFilmTimelineClip, removeFilmTimelineClip, updateFilmTimelineClip, validateFilmTimelineDraft } from "@/lib/film-timeline";
import { moveTimelineClip, resizeTimelineClip, timelineDuration, timelineTimeToPercent } from "@/lib/film-timeline-geometry";
import { filmDeliverableDownloadURL, type FilmStatus } from "@/services/film-client";
import type { FilmTimeline, FilmTimelineClip, FilmTrackKind } from "@/types/film";
import { WorkbenchSection } from "./WorkbenchSection";

export function TimelinePanel({ timeline, mediaSources, dirty, busy, onChange, onSave }: { timeline: FilmTimeline; mediaSources: Array<{ value: string; label: string }>; dirty: boolean; busy: boolean; onChange: (timeline: FilmTimeline) => void; onSave: () => void }) {
  const { t } = useI18n();
  const errors = useMemo(() => validateFilmTimelineDraft(timeline), [timeline]);
  const addClip = (trackId: string, kind: FilmTrackKind) => onChange(addFilmTimelineClip(timeline, trackId, { source: kind === "subtitle" ? "manual" : `${kind}-source`, start: 0, end: 2, ...(kind === "subtitle" ? { text: "Subtitle" } : {}) }));
  return <WorkbenchSection id="timeline" title={t("film.timeline.sectionTitle")} wide>
    <div className="grid gap-3 sm:grid-cols-3"><NumberField label={t("film.timeline.width")} value={timeline.width} onChange={(width) => onChange({ ...timeline, width })} /><NumberField label={t("film.timeline.height")} value={timeline.height} onChange={(height) => onChange({ ...timeline, height })} /><NumberField label={t("film.timeline.frameRate")} value={timeline.frameRate} onChange={(frameRate) => onChange({ ...timeline, frameRate })} /></div>
    <VisualTimeline timeline={timeline} onChange={onChange} />
    <datalist id="film-media-sources">{mediaSources.map((source) => <option key={`${source.value}:${source.label}`} value={source.value}>{source.label}</option>)}</datalist>
    <div className="mt-4 space-y-3">{timeline.tracks.map((track) => <div key={track.id} data-testid={`timeline-track-${track.kind}`} className="rounded-xl border border-[var(--ob-line)] p-3"><div className="flex items-center"><strong className="mr-auto text-sm">{t(`film.timeline.track.${track.kind}`)} · {track.title}</strong><button className="ob-btn" aria-label={t("film.timeline.addClipLabel", { kind: t(`film.timeline.track.${track.kind}`) })} onClick={() => addClip(track.id, track.kind)}><Plus size={14} /> {t("film.timeline.addClip")}</button></div><div className="mt-2 space-y-2">{[...track.clips].sort((a, b) => a.order - b.order).map((clip) => <ClipEditor key={clip.id} clip={clip} subtitle={track.kind === "subtitle"} onPatch={(patch) => onChange(updateFilmTimelineClip(timeline, track.id, clip.id, patch))} onMove={(offset) => onChange(moveFilmTimelineClip(timeline, track.id, clip.id, offset))} onRemove={() => onChange(removeFilmTimelineClip(timeline, track.id, clip.id))} />)}</div></div>)}</div>
    {errors.length ? <div role="alert" className="ob-banner mt-3" data-tone="danger"><ul className="list-disc pl-4 text-sm">{errors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}</ul></div> : null}
    <div className="mt-3 flex items-center gap-2"><button type="button" className="ob-btn ob-btn-primary" disabled={busy || !dirty || errors.length > 0} onClick={onSave}><Save size={14} /> {t("film.timeline.save")}</button><span className="text-xs text-[var(--ob-muted)]">{t(dirty ? "film.timeline.unsaved" : "film.timeline.synced")}</span></div>
  </WorkbenchSection>;
}

function VisualTimeline({ timeline, onChange }: { timeline: FilmTimeline; onChange: (timeline: FilmTimeline) => void }) {
  const { t } = useI18n();
  const duration = timelineDuration(timeline);
  const [playhead, setPlayhead] = useState(0);
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null);
  const drag = useRef<{ clientX: number; width: number; trackId: string; clip: FilmTimelineClip; mode: "move" | "start" | "end" } | null>(null);
  const selectedTrack = timeline.tracks.find((track) => track.id === selected?.trackId);
  const selectedClip = selectedTrack?.clips.find((clip) => clip.id === selected?.clipId);
  const replaceGeometry = (clip: FilmTimelineClip) => {
    if (!selectedTrack || !selectedClip) return;
    onChange(updateFilmTimelineClip(timeline, selectedTrack.id, selectedClip.id, { start: clip.start, end: clip.end, trimIn: clip.trimIn, trimOut: clip.trimOut }));
  };
  const nudge = (frames: number) => selectedClip && replaceGeometry(moveTimelineClip(selectedClip, frames / timeline.frameRate, duration, timeline.frameRate));
  const trim = (edge: "start" | "end", frames: number) => selectedClip && replaceGeometry(resizeTimelineClip(selectedClip, edge, (edge === "start" ? selectedClip.start : selectedClip.end) + frames / timeline.frameRate, timeline.frameRate));
  const beginDrag = (clientX: number, width: number, trackId: string, clip: FilmTimelineClip, mode: "move" | "start" | "end") => {
    drag.current = { clientX, width: Math.max(1, width), trackId, clip, mode };
    setSelected({ trackId, clipId: clip.id });
  };
  const finishDrag = (clientX: number) => {
    const active = drag.current;
    drag.current = null;
    if (!active) return;
    const seconds = (clientX - active.clientX) / active.width * duration;
    const changed = active.mode === "move"
      ? moveTimelineClip(active.clip, seconds, duration, timeline.frameRate)
      : resizeTimelineClip(active.clip, active.mode, (active.mode === "start" ? active.clip.start : active.clip.end) + seconds, timeline.frameRate);
    onChange(updateFilmTimelineClip(timeline, active.trackId, active.clip.id, { start: changed.start, end: changed.end, trimIn: changed.trimIn, trimOut: changed.trimOut }));
  };
  const marks = Array.from({ length: Math.min(13, Math.floor(duration) + 1) }, (_, index) => Math.round(index * duration / Math.min(12, duration)));
  return <div className="mt-4 overflow-hidden rounded-xl border border-[var(--ob-line)] bg-[var(--ob-canvas)]">
    <div className="flex items-center gap-3 border-b border-[var(--ob-line)] px-3 py-2"><strong className="text-sm">{t("film.timeline.title")}</strong><label className="ml-auto flex items-center gap-2 text-xs">{t("film.timeline.playhead", { seconds: playhead.toFixed(2) })}<input aria-label={t("film.timeline.playheadLabel")} className="w-48 accent-[var(--ob-accent)]" type="range" min="0" max={duration} step={1 / timeline.frameRate} value={playhead} onChange={(event) => setPlayhead(Number(event.target.value))} /></label></div>
    <div className="grid grid-cols-[84px_minmax(640px,1fr)] overflow-x-auto">
      <div className="border-r border-[var(--ob-line)]" />
      <div className="relative h-7 border-b border-[var(--ob-line)] text-[10px] text-[var(--ob-muted)]">{marks.map((mark) => <span key={mark} className="absolute top-1" style={{ left: `${timelineTimeToPercent(mark, duration)}%` }}>{mark}s</span>)}<span className="absolute inset-y-0 w-px bg-[var(--ob-accent)]" style={{ left: `${timelineTimeToPercent(playhead, duration)}%` }} /></div>
      {timeline.tracks.flatMap((track) => [
        <div key={`${track.id}:label`} className="flex h-12 items-center border-b border-r border-[var(--ob-line)] px-2 text-xs font-medium">{t(`film.timeline.track.${track.kind}`)}</div>,
        <div key={`${track.id}:lane`} data-timeline-lane="true" data-testid={`visual-timeline-track-${track.kind}`} className="relative h-12 border-b border-[var(--ob-line)]" onDoubleClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setPlayhead(Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration))); }}>
          {track.clips.map((clip) => <div key={clip.id} role="button" tabIndex={0} draggable data-testid={`visual-timeline-clip-${clip.id}`} title={`${clip.source} · ${clip.start.toFixed(2)}–${clip.end.toFixed(2)}s`} className={`absolute top-1 h-10 min-w-4 cursor-grab overflow-hidden rounded border px-2 text-left text-[10px] ${selected?.clipId === clip.id ? "border-[var(--ob-accent)] bg-[var(--ob-accent-soft)]" : "border-[var(--ob-line)] bg-[var(--ob-panel)]"}`} style={{ left: `${timelineTimeToPercent(clip.start, duration)}%`, width: `${Math.max(0.5, timelineTimeToPercent(clip.end - clip.start, duration))}%` }} onClick={() => { setSelected({ trackId: track.id, clipId: clip.id }); setPlayhead(clip.start); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSelected({ trackId: track.id, clipId: clip.id }); const changed = moveTimelineClip(clip, (event.key === "ArrowLeft" ? -1 : 1) / timeline.frameRate, duration, timeline.frameRate); onChange(updateFilmTimelineClip(timeline, track.id, clip.id, { start: changed.start, end: changed.end })); } }} onDragStart={(event) => beginDrag(event.clientX, event.currentTarget.parentElement?.getBoundingClientRect().width ?? 1, track.id, clip, "move")} onDragEnd={(event) => finishDrag(event.clientX)}><span aria-label={t("film.timeline.dragStart")} draggable className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-[var(--ob-accent)]/40" onDragStart={(event) => { event.stopPropagation(); beginDrag(event.clientX, event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 1, track.id, clip, "start"); }} onDragEnd={(event) => { event.stopPropagation(); finishDrag(event.clientX); }} /><span className="block truncate">{clip.source}</span><span className="opacity-70">{(clip.end - clip.start).toFixed(2)}s</span><span aria-label={t("film.timeline.dragEnd")} draggable className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-[var(--ob-accent)]/40" onDragStart={(event) => { event.stopPropagation(); beginDrag(event.clientX, event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width ?? 1, track.id, clip, "end"); }} onDragEnd={(event) => { event.stopPropagation(); finishDrag(event.clientX); }} /></div>)}
          <span className="pointer-events-none absolute inset-y-0 w-px bg-[var(--ob-accent)]" style={{ left: `${timelineTimeToPercent(playhead, duration)}%` }} />
        </div>,
      ])}
    </div>
    <div className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2 text-xs"><strong className="mr-auto max-w-60 truncate">{selectedClip ? `${selectedClip.source} · ${selectedClip.start.toFixed(2)}–${selectedClip.end.toFixed(2)}s` : t("film.timeline.selectHint")}</strong><button className="ob-btn" disabled={!selectedClip} onClick={() => nudge(-1)}>{t("film.timeline.nudgeLeft")}</button><button className="ob-btn" disabled={!selectedClip} onClick={() => nudge(1)}>{t("film.timeline.nudgeRight")}</button><button className="ob-btn" disabled={!selectedClip} onClick={() => trim("start", 1)}>{t("film.timeline.shrinkStart")}</button><button className="ob-btn" disabled={!selectedClip} onClick={() => trim("start", -1)}>{t("film.timeline.extendStart")}</button><button className="ob-btn" disabled={!selectedClip} onClick={() => trim("end", -1)}>{t("film.timeline.shrinkEnd")}</button><button className="ob-btn" disabled={!selectedClip} onClick={() => trim("end", 1)}>{t("film.timeline.extendEnd")}</button></div>
  </div>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <label className="text-xs">{label}<input className="ob-input mt-1 w-full" type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>; }

function ClipEditor({ clip, subtitle, onPatch, onMove, onRemove }: { clip: FilmTimelineClip; subtitle: boolean; onPatch: (patch: Partial<FilmTimelineClip>) => void; onMove: (offset: -1 | 1) => void; onRemove: () => void }) {
  const { t } = useI18n();
  return <div data-testid="timeline-clip" className="rounded-lg bg-[var(--ob-canvas)] p-2"><div className="grid gap-2 md:grid-cols-4 xl:grid-cols-8"><label className="text-xs">{t("film.timeline.source")}<input aria-label={t("film.timeline.source")} list="film-media-sources" className="ob-input mt-1 w-full" value={clip.source} onChange={(event) => onPatch({ source: event.target.value })} /></label><NumberField label={t("film.timeline.start")} value={clip.start} onChange={(start) => onPatch({ start })} /><NumberField label={t("film.timeline.end")} value={clip.end} onChange={(end) => onPatch({ end })} /><NumberField label={t("film.timeline.trimIn")} value={clip.trimIn} onChange={(trimIn) => onPatch({ trimIn })} /><NumberField label={t("film.timeline.trimOut")} value={clip.trimOut} onChange={(trimOut) => onPatch({ trimOut })} /><NumberField label={t("film.timeline.volume")} value={clip.volume} onChange={(volume) => onPatch({ volume })} /><NumberField label={t("film.timeline.fadeIn")} value={clip.fadeIn} onChange={(fadeIn) => onPatch({ fadeIn })} /><NumberField label={t("film.timeline.fadeOut")} value={clip.fadeOut} onChange={(fadeOut) => onPatch({ fadeOut })} /></div>{subtitle ? <input aria-label={t("film.timeline.subtitleText")} className="ob-input mt-2 w-full" value={clip.text ?? ""} onChange={(event) => onPatch({ text: event.target.value })} /> : null}<div className="mt-2 flex flex-wrap gap-2"><label className="text-xs"><input type="checkbox" checked={clip.muted} onChange={(event) => onPatch({ muted: event.target.checked })} /> {t("film.timeline.muted")}</label><select aria-label={t("film.timeline.transition")} className="ob-input py-1 text-xs" value={clip.transition} onChange={(event) => onPatch({ transition: event.target.value as "cut" | "fade" })}><option value="cut">cut</option><option value="fade">fade</option></select><button className="ob-btn" aria-label={t("film.timeline.moveUp")} onClick={() => onMove(-1)}><ArrowUp size={13} /></button><button className="ob-btn" aria-label={t("film.timeline.moveDown")} onClick={() => onMove(1)}><ArrowDown size={13} /></button><button className="ob-btn" aria-label={t("film.timeline.removeClip")} onClick={onRemove}><Trash2 size={13} /></button></div></div>;
}

export function DeliveryPanel({ status, busy, onExport, onCancel, onRefresh }: { status: FilmStatus; busy: boolean; onExport: (kind: "mp4" | "srt" | "manifest" | "asset_bundle") => void; onCancel: (jobId: string) => void; onRefresh: () => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<"mp4" | "srt" | "manifest" | "asset_bundle">("manifest");
  const disabled = (kind === "mp4" && !status.capabilities.mp4Export) || (kind === "asset_bundle" && !status.capabilities.assetBundleExport);
  useEffect(() => {
    if (busy || !status.document.deliverables.some((item) => item.status === "running")) return;
    const timer = setTimeout(onRefresh, 500);
    return () => clearTimeout(timer);
  }, [busy, onRefresh, status.document.deliverables]);
  return <WorkbenchSection id="delivery" title={t("film.delivery.title")}>
    <div className="flex flex-wrap gap-2"><select aria-label={t("film.delivery.type")} className="ob-input" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="mp4" disabled={!status.capabilities.mp4Export}>MP4</option><option value="srt">SRT</option><option value="manifest">manifest</option><option value="asset_bundle" disabled={!status.capabilities.assetBundleExport}>asset_bundle</option></select><button className="ob-btn ob-btn-primary" disabled={busy || disabled} onClick={() => onExport(kind)}>{t("film.delivery.request")}</button><button className="ob-btn" onClick={onRefresh}>{t("film.delivery.refresh")}</button></div>
    {!status.capabilities.mp4Export ? <p className="mt-2 text-xs text-[var(--ob-danger)]">{t("film.delivery.mp4Unavailable", { diagnostic: status.capabilities.mp4Diagnostic })}</p> : null}{!status.capabilities.assetBundleExport ? <p className="mt-1 text-xs text-[var(--ob-muted)]">{t("film.delivery.bundleUnavailable")}</p> : null}
    <ul className="mt-4 space-y-2">{status.document.deliverables.map((item) => <li key={item.id} className="rounded-lg border border-[var(--ob-line)] p-3"><div className="flex items-center gap-2"><strong className="mr-auto text-sm">{item.title}</strong><span className="text-xs">{item.kind} · {item.status}</span>{item.status === "running" && item.generationJobId ? <button className="ob-btn" disabled={busy} onClick={() => onCancel(item.generationJobId!)}>{t("film.delivery.cancel")}</button> : null}{item.status === "failed" || item.status === "canceled" ? <button className="ob-btn" disabled={busy} onClick={() => onExport(item.kind)}>{t("film.delivery.retry")}</button> : null}</div>{item.diagnostic ? <p className="text-xs text-[var(--ob-danger)]">{item.diagnostic}</p> : null}{item.status === "approved" && (item.storageKey || item.content) ? <a className="ob-btn mt-2 inline-flex" href={filmDeliverableDownloadURL(status.document.projectId, item.id)}><Download size={14} /> {t("film.delivery.download")}</a> : null}</li>)}</ul>
  </WorkbenchSection>;
}
