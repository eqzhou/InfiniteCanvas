import { afterEach, describe, expect, mock, test } from "bun:test";
import { executeFilmAgentRead } from "./film-agent-client";

afterEach(() => { mock.restore(); });

describe("Film Agent client", () => {
  test("executes only allowlisted read operations with a bounded project id", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ tool: "film.next_steps", arguments: { projectId: "film-1" } });
      return new Response(JSON.stringify({ ok: true, data: { next: "script" } }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(executeFilmAgentRead("film.next_steps", "film-1")).resolves.toEqual({ next: "script" });
    expect(() => executeFilmAgentRead("film.approve_stage" as "film.status", "film-1")).toThrow(/只读/);
  });
});
