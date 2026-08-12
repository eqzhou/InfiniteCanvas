import type { MessageKey } from "@/i18n/core";

export type FilmTranslator = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

const filmStatusKeys: Readonly<Record<string, MessageKey>> = {
  draft: "film.advanced.statusDraft",
  queued: "film.advanced.statusQueued",
  running: "film.advanced.statusRunning",
  needs_review: "film.advanced.statusNeedsReview",
  approved: "film.advanced.statusApproved",
  ready: "film.advanced.statusReady",
  succeeded: "film.advanced.statusSucceeded",
  failed: "film.advanced.statusFailed",
  canceled: "film.advanced.statusCanceled",
  cancelled: "film.advanced.statusCanceled",
};

const filmKindKeys: Readonly<Record<string, MessageKey>> = {
  mp4: "film.delivery.kindMp4",
  srt: "film.delivery.kindSrt",
  manifest: "film.delivery.kindManifest",
  asset_bundle: "film.delivery.kindAssetBundle",
};

const filmTransitionKeys: Readonly<Record<string, MessageKey>> = {
  cut: "film.timeline.transition.cut",
  fade: "film.timeline.transition.fade",
};

const filmDiagnosticKeys: Readonly<Record<string, MessageKey>> = {
  ffmpeg_unavailable: "film.delivery.diagnosticFfmpegUnavailable",
  "FFmpeg is not configured or failed its capability probe": "film.delivery.diagnosticFfmpegUnavailable",
  export_failed: "film.delivery.diagnosticExportFailed",
  "导出失败": "film.delivery.diagnosticExportFailed",
  export_canceled: "film.delivery.diagnosticExportCanceled",
  "已取消": "film.delivery.diagnosticExportCanceled",
  export_storage_failed: "film.delivery.diagnosticExportStorageFailed",
  "导出存储失败": "film.delivery.diagnosticExportStorageFailed",
  export_job_missing: "film.delivery.diagnosticExportJobMissing",
  "导出任务记录缺失，请重试": "film.delivery.diagnosticExportJobMissing",
  generation_provider_failed: "film.production.errorProviderFailed",
  "Generation provider failed": "film.production.errorProviderFailed",
  generation_canceled: "film.production.errorCanceled",
  "Generation was canceled": "film.production.errorCanceled",
};

export function localizeFilmStatus(t: FilmTranslator, status: string): string {
  const key = filmStatusKeys[status];
  return key ? t(key) : t("film.production.statusUnknown");
}

export function localizeFilmKind(t: FilmTranslator, kind: string): string {
  const key = filmKindKeys[kind];
  return key ? t(key) : t("film.delivery.kindUnknown");
}

export function localizeFilmTransition(t: FilmTranslator, transition: string): string {
  const key = filmTransitionKeys[transition];
  return key ? t(key) : t("film.timeline.transition.unknown");
}

export function localizeFilmDiagnostic(t: FilmTranslator, diagnostic: string): string {
  const key = filmDiagnosticKeys[diagnostic.trim()];
  return key ? t(key) : t("film.delivery.diagnosticUnknown");
}
