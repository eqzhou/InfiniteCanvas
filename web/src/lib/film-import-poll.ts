import { FilmAPIError } from "@/services/film-client";

const MAX_FILM_IMPORT_POLL_DELAY_MS = 8_000;

export function filmImportPollDelay(attempt: number, cause: unknown): number | null {
  if (cause instanceof FilmAPIError && (cause.status === 401 || cause.status === 403)) return null;
  const exponent = Math.max(0, Math.min(3, Math.trunc(attempt)));
  return Math.min(MAX_FILM_IMPORT_POLL_DELAY_MS, 1_000 * (2 ** exponent));
}

export function recoverFilmImportPoll(failedAttempts: number): { failedAttempts: number; clearError: boolean } {
  return { failedAttempts: 0, clearError: failedAttempts > 0 };
}
