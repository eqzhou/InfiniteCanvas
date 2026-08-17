import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Film, Image, Music2, Save, Scissors, ScrollText } from "lucide-react";

import { filmEditorKey } from "@/lib/film-drafts";
import { useI18n } from "@/i18n/I18nProvider";
import { resolveObjectUrl } from "@/services/storage";
import { createServerBlobDisplayUrls } from "@/services/server-storage";
import { MediaView } from "@/components/common/MediaView";
import type { FilmStatus } from "@/services/film-client";
import type { FilmDialogue, FilmDocument, FilmShot, FilmTimelineClip, FilmTimelineTrack } from "@/types/film";
import { WorkbenchSection } from "./WorkbenchSection";

export type EpisodeViewKind = "script" | "shots" | "storyboard" | "audio" | "video" | "compose";

const viewIcons: ReadonlyArray<{ id: EpisodeViewKind; icon: typeof ScrollText }> = [
  { id: "script", icon: ScrollText }, { id: "shots", icon: Scissors }, { id: "storyboard", icon: Image },
  { id: "audio", icon: Music2 }, { id: "video", icon: Film }, { id: "compose", icon: Save },
];

export type EpisodeProductionView = {
  episode: FilmDocument["episodes"][number];
  scenes: FilmDocument["scenes"];
  shots: FilmShot[];
  dialogues: FilmDialogue[];
  timelineClips: FilmTimelineClip[];
  timelineTracks: Array<FilmTimelineTrack & { clips: FilmTimelineClip[] }>;
};

export function buildEpisodeProductionView(document: FilmDocument, episodeId: string): EpisodeProductionView {
  const episode = document.episodes.find((item) => item.id === episodeId) ?? document.episodes[0];
  if (!episode) throw new Error("Episode not found");
  const scenes = [...document.scenes].filter((scene) => scene.episodeId === episode.id).sort((a, b) => a.order - b.order);
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const shots = [...document.shots].filter((shot) => sceneIds.has(shot.sceneId)).sort((a, b) => a.order - b.order);
  const shotIds = new Set(shots.map((shot) => shot.id));
  const dialogues = [...(document.dialogues ?? [])].filter((dialogue) => shotIds.has(dialogue.shotId)).sort((a, b) => a.order - b.order);
  const dialogueIds = new Set(dialogues.map((dialogue) => dialogue.id));
  const sources = new Set<string>();
  for (const shot of shots) {
    sources.add(`shot:${shot.id}`);
    for (const source of [shot.imageStorageKey, shot.firstFrameStorageKey, shot.lastFrameStorageKey, shot.audioStorageKey, shot.videoStorageKey]) if (source) sources.add(source);
  }
  for (const dialogue of dialogues) {
    sources.add(`dialogue:${dialogue.id}`);
    if (dialogue.audioStorageKey) sources.add(dialogue.audioStorageKey);
  }
  const timelineTracks = document.timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => sources.has(clip.source) || shotIds.has(clip.source.replace(/^shot:/, "")) || dialogueIds.has(clip.source.replace(/^dialogue:/, ""))) })).filter((track) => track.clips.length > 0);
  return { episode, scenes, shots, dialogues, timelineTracks, timelineClips: timelineTracks.flatMap((track) => track.clips) };
}

function StoredMedia({ active, kind, storageKey, label }: { active: boolean; kind: "image" | "audio" | "video"; storageKey?: string; label: string }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let mounted = true;
    if (!active || !storageKey) { setUrl(undefined); return; }
    void createServerBlobDisplayUrls([storageKey]).catch(() => new Map<string, string>()).then((urls) => {
      const minted = urls.get(storageKey);
      if (minted) return minted;
      return resolveObjectUrl(kind === "image" ? "image" : "media", storageKey);
    }).then((value) => { if (mounted) setUrl(value); }).catch(() => { if (mounted) setUrl(undefined); });
    return () => { mounted = false; };
  }, [active, kind, storageKey]);
  if (!storageKey) return <div className="grid min-h-32 place-items-center rounded-lg border border-dashed border-[var(--ob-line)] text-xs text-[var(--ob-muted)]">{t("film.common.pendingGeneration")}</div>;
  if (kind === "image" && url) return <MediaView kind="image" src={url} alt={label} className="aspect-video w-full rounded-lg object-cover" />;
  if (kind === "audio" && url) return <audio controls preload="metadata" aria-label={label} className="w-full" src={url} />;
  if (kind === "video" && url) return <MediaView kind="video" src={url} alt={label} fit="contain" controls className="aspect-video w-full rounded-lg bg-black object-contain" />;
  return <div className="grid min-h-32 place-items-center rounded-lg border border-[var(--ob-line)] p-3 text-center text-xs text-[var(--ob-muted)]"><span>{label}</span><code className="mt-1 break-all">{storageKey}</code></div>;
}

function ScriptView({ view }: { view: EpisodeProductionView }) {
  const { t } = useI18n();
  return <div className="space-y-4"><div><h3 className="font-medium">{view.episode.title}</h3><p className="mt-1 text-sm text-[var(--ob-muted)]">{view.episode.synopsis || t("film.episodes.noSynopsis")}</p></div>{view.scenes.map((scene) => <article key={scene.id} className="rounded-xl border border-[var(--ob-line)] p-4"><h4 className="text-sm font-semibold">{scene.heading}</h4><p className="mt-1 text-sm text-[var(--ob-muted)]">{scene.synopsis}</p>{view.shots.filter((shot) => shot.sceneId === scene.id).map((shot) => <div key={shot.id} className="mt-3 border-l-2 border-[var(--ob-accent)] pl-3"><strong className="text-sm">{shot.title}</strong><p className="text-sm">{shot.description}</p>{view.dialogues.filter((dialogue) => dialogue.shotId === shot.id).map((dialogue) => <p key={dialogue.id} className="mt-2 text-sm"><span className="text-xs text-[var(--ob-muted)]">{t(dialogue.kind === "narration" ? "film.dialogue.narration" : "film.dialogue.dialogue")}</span>　{dialogue.text}</p>)}</div>)}</article>)}</div>;
}

function ShotEditor({ shot, dialogues, identities, styles, busy, onSave, onCreateDialogue, onSaveDialogue, onDeleteDialogue }: { shot: FilmShot; dialogues: FilmDialogue[]; identities: FilmStatus["document"]["assets"]; styles: FilmStatus["document"]["assets"]; busy: boolean; onSave: (shot: FilmShot, patch: Partial<FilmShot>) => void; onCreateDialogue: (shotId: string, kind: FilmDialogue["kind"], text: string) => void; onSaveDialogue: (dialogue: FilmDialogue, patch: Partial<FilmDialogue>) => void; onDeleteDialogue: (dialogue: FilmDialogue) => void }) {
  const { t } = useI18n();
  const [description, setDescription] = useState(shot.description);
  const [duration, setDuration] = useState(shot.durationSeconds);
  const [style, setStyle] = useState(shot.styleAssetId ?? "");
  const [identityIds, setIdentityIds] = useState(shot.identityVersionIds);
  return <article className="min-w-[42rem] border-b border-[var(--ob-line)] p-3 last:border-b-0" data-testid={`film-shot-${shot.id}`}><div className="grid gap-2 md:grid-cols-[8rem_minmax(14rem,1fr)_6rem_10rem_auto]"><strong className="self-center text-sm">{shot.title}</strong><input aria-label={t("film.shot.descriptionLabel", { title: shot.title })} className="ob-input" value={description} onChange={(event) => setDescription(event.target.value)} /><input aria-label={t("film.shot.durationLabel", { title: shot.title })} className="ob-input" type="number" min="0.1" max="900" step="0.1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><select aria-label={t("film.shot.styleBindingLabel", { title: shot.title })} className="ob-input" value={style} onChange={(event) => setStyle(event.target.value)}><option value="">{t("film.shot.noStyle")}</option>{styles.map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select><button type="button" className="ob-btn min-h-10" disabled={busy} onClick={() => onSave(shot, { description, durationSeconds: duration, styleAssetId: style, identityVersionIds: identityIds })}><Save aria-hidden="true" size={14} />{t("film.shot.save")}</button></div><fieldset className="mt-2 flex flex-wrap gap-3"><legend className="text-xs text-[var(--ob-muted)]">{t("film.shot.identityVersions")}</legend>{identities.map((asset) => <label key={asset.id} className="text-xs"><input type="checkbox" checked={identityIds.includes(asset.id)} onChange={(event) => setIdentityIds((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} /> {asset.title}</label>)}</fieldset><div className="mt-3 space-y-2"><div className="flex flex-wrap items-center gap-1"><strong className="mr-auto text-xs">{t("film.dialogue.group")}</strong><button type="button" className="ob-btn min-h-10" disabled={busy} onClick={() => onCreateDialogue(shot.id, "dialogue", t("film.dialogue.newDialogue"))}>{t("film.dialogue.addDialogue")}</button><button type="button" className="ob-btn min-h-10" disabled={busy} onClick={() => onCreateDialogue(shot.id, "narration", t("film.dialogue.newNarration"))}>{t("film.dialogue.addNarration")}</button></div>{dialogues.map((dialogue) => <DialogueEditor key={filmEditorKey(dialogue.id, dialogue.revision)} dialogue={dialogue} busy={busy} onSave={onSaveDialogue} onDelete={onDeleteDialogue} />)}</div></article>;
}

function DialogueEditor({ dialogue, busy, onSave, onDelete }: { dialogue: FilmDialogue; busy: boolean; onSave: (dialogue: FilmDialogue, patch: Partial<FilmDialogue>) => void; onDelete: (dialogue: FilmDialogue) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(dialogue.text);
  const [kind, setKind] = useState(dialogue.kind);
  const [emotion, setEmotion] = useState(dialogue.emotion ?? "");
  return <div className="grid gap-2 rounded-lg border border-[var(--ob-line)] p-2 sm:grid-cols-[auto_minmax(7rem,0.6fr)_minmax(12rem,1.4fr)_auto_auto]"><select aria-label={t("film.dialogue.type")} className="ob-input" value={kind} onChange={(event) => setKind(event.target.value as FilmDialogue["kind"])}><option value="dialogue">{t("film.dialogue.dialogue")}</option><option value="narration">{t("film.dialogue.narration")}</option></select><input aria-label={t("film.dialogue.emotionGuide")} className="ob-input" value={emotion} onChange={(event) => setEmotion(event.target.value)} placeholder={t("film.dialogue.emotionPlaceholder")} /><input aria-label={t("film.dialogue.text")} className="ob-input" value={text} onChange={(event) => setText(event.target.value)} /><button type="button" className="ob-btn min-h-10" disabled={busy || !text.trim()} onClick={() => onSave(dialogue, { kind, emotion, text })}>{t("film.common.save")}</button><button type="button" className="ob-btn min-h-10" disabled={busy} onClick={() => onDelete(dialogue)}>{t("film.common.delete")}</button></div>;
}

function EmptyView({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-[var(--ob-line)] p-6 text-center text-sm text-[var(--ob-muted)]">{children}</p>;
}

export function EpisodeProductionViews({ status, busy, initialView = "script", onSaveEpisode, onSaveShot, onCreateDialogue, onSaveDialogue, onDeleteDialogue }: {
  status: FilmStatus; busy: boolean; initialView?: EpisodeViewKind;
  onSaveEpisode: (id: string, revision: number, title: string) => void;
  onSaveShot: (shot: FilmShot, patch: Partial<FilmShot>) => void;
  onCreateDialogue: (shotId: string, kind: FilmDialogue["kind"], text: string) => void;
  onSaveDialogue: (dialogue: FilmDialogue, patch: Partial<FilmDialogue>) => void;
  onDeleteDialogue: (dialogue: FilmDialogue) => void;
}) {
  const { t } = useI18n();
  const { document } = status;
  const [episodeId, setEpisodeId] = useState(document.episodes[0]?.id ?? "");
  const [activeView, setActiveView] = useState<EpisodeViewKind>(initialView);
  useEffect(() => { if (!document.episodes.some((episode) => episode.id === episodeId)) setEpisodeId(document.episodes[0]?.id ?? ""); }, [document.episodes, episodeId]);
  if (!document.episodes.length) return <WorkbenchSection id="episodes" title={t("film.episodes.title")} wide><EmptyView>{t("film.episodes.empty")}</EmptyView></WorkbenchSection>;
  const view = buildEpisodeProductionView(document, episodeId);
  const identities = document.assets.filter((asset) => asset.kind === "identity");
  const styles = document.assets.filter((asset) => asset.kind === "style");
  const selectView = (next: EpisodeViewKind) => { setActiveView(next); requestAnimationFrame(() => globalThis.document.getElementById(`episode-tab-${next}`)?.focus()); };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = event.key === "Home" ? 0 : event.key === "End" ? viewIcons.length - 1 : event.key === "ArrowRight" ? (index + 1) % viewIcons.length : event.key === "ArrowLeft" ? (index - 1 + viewIcons.length) % viewIcons.length : -1;
    if (target >= 0) { event.preventDefault(); selectView(viewIcons[target]!.id); }
  };
  return <WorkbenchSection id="episodes" title={t("film.episodes.title")} wide>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><label className="text-sm font-medium" htmlFor="film-episode-selector">{t("film.episodes.current")}</label><select id="film-episode-selector" className="ob-input min-w-0 flex-1 sm:max-w-sm" value={view.episode.id} onChange={(event) => setEpisodeId(event.target.value)}>{document.episodes.map((episode) => <option key={episode.id} value={episode.id}>{episode.order + 1}. {episode.title}</option>)}</select><div className="flex min-w-0 flex-1 gap-2"><input aria-label={t("film.episodes.titleLabel", { title: view.episode.title })} className="ob-input min-w-0 flex-1" defaultValue={view.episode.title} key={filmEditorKey(view.episode.id, view.episode.revision)} /><button type="button" className="ob-btn min-h-10 shrink-0" disabled={busy} onClick={(event) => onSaveEpisode(view.episode.id, view.episode.revision, (event.currentTarget.previousElementSibling as HTMLInputElement).value)}><Save aria-hidden="true" size={14} />{t("film.episodes.save")}</button></div></div>
    <div role="tablist" aria-label={t("film.episodes.viewsLabel", { title: view.episode.title })} className="mt-4 flex gap-1 overflow-x-auto border-b border-[var(--ob-line)] pb-1">{viewIcons.map((item, index) => { const Icon = item.icon; const selected = activeView === item.id; return <button key={item.id} id={`episode-tab-${item.id}`} type="button" role="tab" aria-selected={selected} aria-controls={`episode-panel-${item.id}`} tabIndex={selected ? 0 : -1} className={`ob-tab min-h-10 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 ${selected ? "text-[var(--ob-accent)]" : ""}`} onClick={() => setActiveView(item.id)} onKeyDown={(event) => navigateTabs(event, index)}><Icon aria-hidden="true" size={14} />{t(`film.episodes.views.${item.id}`)}</button>; })}</div>
    <div id="episode-panel-script" role="tabpanel" aria-labelledby="episode-tab-script" tabIndex={activeView === "script" ? 0 : -1} hidden={activeView !== "script"} className="mt-4 focus-visible:outline-2 focus-visible:outline-offset-2"><ScriptView view={view} /></div>
    <div id="episode-panel-shots" role="tabpanel" aria-labelledby="episode-tab-shots" tabIndex={activeView === "shots" ? 0 : -1} hidden={activeView !== "shots"} className="mt-4 focus-visible:outline-2 focus-visible:outline-offset-2"><div className="overflow-x-auto rounded-xl border border-[var(--ob-line)]">{view.shots.map((shot) => { const scene = view.scenes.find((item) => item.id === shot.sceneId)!; return <ShotEditor key={filmEditorKey(shot.id, shot.revision)} shot={shot} dialogues={view.dialogues.filter((dialogue) => dialogue.shotId === shot.id)} identities={identities.filter((identity) => (!identity.episodeIds?.length || identity.episodeIds.includes(view.episode.id)) && (!identity.sceneIds?.length || identity.sceneIds.includes(scene.id)) && (!identity.shotIds?.length || identity.shotIds.includes(shot.id)))} styles={styles} busy={busy} onSave={onSaveShot} onCreateDialogue={onCreateDialogue} onSaveDialogue={onSaveDialogue} onDeleteDialogue={onDeleteDialogue} />; })}{!view.shots.length ? <EmptyView>{t("film.episodes.noShots")}</EmptyView> : null}</div></div>
    <div id="episode-panel-storyboard" role="tabpanel" aria-labelledby="episode-tab-storyboard" tabIndex={activeView === "storyboard" ? 0 : -1} hidden={activeView !== "storyboard"} className="mt-4 focus-visible:outline-2 focus-visible:outline-offset-2"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{view.shots.map((shot) => <article key={shot.id} className="rounded-xl border border-[var(--ob-line)] p-3"><StoredMedia active={activeView === "storyboard"} kind="image" storageKey={shot.imageStorageKey ?? shot.firstFrameStorageKey} label={t("film.media.storyboardLabel", { title: shot.title })} /><h3 className="mt-3 text-sm font-medium">{shot.title}</h3><p className="mt-1 text-sm text-[var(--ob-muted)]">{shot.description}</p></article>)}</div></div>
    <div id="episode-panel-audio" role="tabpanel" aria-labelledby="episode-tab-audio" tabIndex={activeView === "audio" ? 0 : -1} hidden={activeView !== "audio"} className="mt-4 focus-visible:outline-2 focus-visible:outline-offset-2"><div className="space-y-3">{view.shots.map((shot) => <article key={shot.id} className="rounded-xl border border-[var(--ob-line)] p-3"><h3 className="mb-2 text-sm font-medium">{t("film.media.shotAudioLabel", { title: shot.title })}</h3><StoredMedia active={activeView === "audio"} kind="audio" storageKey={shot.audioStorageKey} label={t("film.media.shotAudioLabel", { title: shot.title })} />{view.dialogues.filter((dialogue) => dialogue.shotId === shot.id).map((dialogue) => <div key={dialogue.id} className="mt-3 border-t border-[var(--ob-line)] pt-3"><p className="mb-2 text-sm">{dialogue.text}</p><StoredMedia active={activeView === "audio"} kind="audio" storageKey={dialogue.audioStorageKey} label={t("film.media.dialogueAudioLabel", { title: shot.title })} /></div>)}</article>)}</div></div>
    <div id="episode-panel-video" role="tabpanel" aria-labelledby="episode-tab-video" tabIndex={activeView === "video" ? 0 : -1} hidden={activeView !== "video"} className="mt-4 focus-visible:outline-2 focus-visible:outline-offset-2"><div className="grid gap-3 sm:grid-cols-2">{view.shots.map((shot) => <article key={shot.id} className="rounded-xl border border-[var(--ob-line)] p-3"><StoredMedia active={activeView === "video"} kind="video" storageKey={shot.videoStorageKey} label={t("film.media.videoLabel", { title: shot.title })} /><div className="mt-2 flex items-center gap-2 text-sm"><strong>{shot.title}</strong><span className="ml-auto text-[var(--ob-muted)]">{t("film.count.seconds", { count: shot.durationSeconds.toFixed(1) })}</span></div></article>)}</div></div>
    <div id="episode-panel-compose" role="tabpanel" aria-labelledby="episode-tab-compose" tabIndex={activeView === "compose" ? 0 : -1} hidden={activeView !== "compose"} className="mt-4 focus-visible:outline-2 focus-visible:outline-offset-2"><div className="space-y-3">{view.timelineTracks.map((track) => <section key={track.id} className="rounded-xl border border-[var(--ob-line)] p-3"><div className="flex items-center gap-2"><h3 className="text-sm font-medium">{track.title}</h3><span className="ob-chip">{track.kind}</span><span className="ml-auto text-xs text-[var(--ob-muted)]">{t("film.count.clips", { count: track.clips.length })}</span></div><div className="mt-2 flex gap-2 overflow-x-auto">{track.clips.map((clip) => <div key={clip.id} className="min-w-40 rounded-lg bg-[var(--ob-canvas)] p-2 text-xs"><strong>{clip.id}</strong><p className="mt-1 break-all text-[var(--ob-muted)]">{clip.source}</p><p className="mt-1">{t("film.timeline.clipSummary", { seconds: Math.max(0, clip.end - clip.start).toFixed(1), transition: clip.transition })}</p></div>)}</div></section>)}{!view.timelineTracks.length ? <EmptyView>{t("film.episodes.timelineEmpty")}</EmptyView> : null}<a href="#timeline" className="ob-btn min-h-10">{t("film.episodes.openTimeline")}</a></div></div>
  </WorkbenchSection>;
}
