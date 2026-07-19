import { describe, expect, test } from "bun:test";
import {
  parseCodexSharedState,
  shouldResetCodexTranscript,
  statusForCodexSnapshot,
} from "./codex-session-sync";

describe("Codex shared session state", () => {
  test("accepts bounded session and running state without mutating input", () => {
    const input = { profile: "default", session: { id: "codex-one", threadId: "thread-one", running: true }, turnStatus: "running", updatedAt: 10, sourceId: "tab-one" };
    const parsed = parseCodexSharedState(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  test("rejects malformed profiles, sessions, and statuses", () => {
    expect(parseCodexSharedState({ profile: "../bad", session: null, turnStatus: "idle", updatedAt: 1, sourceId: "tab" })).toBeNull();
    expect(parseCodexSharedState({ profile: "default", session: { id: "../bad" }, turnStatus: "idle", updatedAt: 1, sourceId: "tab" })).toBeNull();
    expect(parseCodexSharedState({ profile: "default", session: null, turnStatus: "tool-completed", updatedAt: 1, sourceId: "tab" })).toBeNull();
  });

  test("resets transcript only when a shared session switches threads", () => {
    expect(shouldResetCodexTranscript("session-one", "session-two")).toBe(true);
    expect(shouldResetCodexTranscript("session-one", "session-one")).toBe(false);
    expect(shouldResetCodexTranscript(undefined, "session-one")).toBe(true);
    expect(shouldResetCodexTranscript("session-one", undefined)).toBe(false);
  });

  test("keeps a never-started session idle and completes only a running turn", () => {
    expect(statusForCodexSnapshot("idle", false)).toBe("idle");
    expect(statusForCodexSnapshot("running", false)).toBe("completed");
    expect(statusForCodexSnapshot("failed", false)).toBe("failed");
    expect(statusForCodexSnapshot("idle", true)).toBe("running");
  });
});
