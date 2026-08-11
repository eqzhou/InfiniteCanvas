import { describe, expect, it } from "vitest";

import { filmImportPollDelay, recoverFilmImportPoll } from "@/lib/film-import-poll";
import { FilmAPIError } from "@/services/film-client";

describe("filmImportPollDelay", () => {
  it("retries transient failures with bounded backoff", () => {
    expect(filmImportPollDelay(0, new FilmAPIError(503, "temporary", "temporary"))).toBe(1_000);
    expect(filmImportPollDelay(4, new TypeError("network"))).toBe(8_000);
    expect(filmImportPollDelay(20, new Error("temporary"))).toBe(8_000);
  });

  it("stops polling when authentication or authorization is required", () => {
    expect(filmImportPollDelay(0, new FilmAPIError(401, "login", "login"))).toBeNull();
    expect(filmImportPollDelay(0, new FilmAPIError(403, "forbidden", "forbidden"))).toBeNull();
  });

  it("clears a transient error and resets backoff after a successful poll", () => {
    expect(recoverFilmImportPoll(3)).toEqual({ failedAttempts: 0, clearError: true });
    expect(recoverFilmImportPoll(0)).toEqual({ failedAttempts: 0, clearError: false });
  });
});
