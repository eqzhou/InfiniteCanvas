import { describe, expect, test } from "bun:test";

import {
  closeCodexSession,
  createCodexSession,
  decideProjectSync,
  fetchAgentStatus,
  normalizeAgentBaseUrl,
  parseCodexSseRecords,
  respondCodexApproval,
  sendCodexMessage,
} from "./local-agent";

describe("local agent project synchronization", () => {
  test("newer remote projects are pulled", () => {
    expect(
      decideProjectSync("2026-07-15T00:00:00.000Z", "2026-07-15T00:00:01.000Z"),
    ).toBe("pull");
  });

  test("newer local projects are pushed", () => {
    expect(
      decideProjectSync("2026-07-15T00:00:01.000Z", "2026-07-15T00:00:00.000Z"),
    ).toBe("push");
  });

  test("equal and invalid timestamps do not overwrite data", () => {
    expect(decideProjectSync("2026-07-15T00:00:00.000Z", "2026-07-15T00:00:00.000Z")).toBe(
      "none",
    );
    expect(decideProjectSync("invalid", "2026-07-15T00:00:00.000Z")).toBe("none");
  });
});

describe("local agent connection", () => {
  test("parses CRLF and multi-line SSE data while preserving incomplete frames", () => {
    const first = parseCodexSseRecords(
      ": keep-alive\r\n" +
      "data: {\"type\":\"notification\",\r\n" +
      "data: \"method\":\"turn/started\"}\r\n\r\n" +
      "data: {\"type\":\"approval\"}",
    );
    expect(first.events).toEqual([{ type: "notification", method: "turn/started" }]);
    expect(first.remainder).toBe('data: {"type":"approval"}');
    const flushed = parseCodexSseRecords(first.remainder, true);
    expect(flushed.events).toEqual([{ type: "approval" }]);
  });

  test("allows loopback HTTP and HTTPS while normalizing trailing slashes", () => {
    expect(normalizeAgentBaseUrl("http://127.0.0.1:8790/")).toBe("http://127.0.0.1:8790");
    expect(normalizeAgentBaseUrl("http://localhost:8790")).toBe("http://localhost:8790");
    expect(normalizeAgentBaseUrl("https://agent.example.com/")).toBe("https://agent.example.com");
  });

  test("rejects remote plaintext, embedded credentials, and URL suffixes", () => {
    expect(() => normalizeAgentBaseUrl("http://agent.example.com")).toThrow("HTTPS");
    expect(() => normalizeAgentBaseUrl("https://user:pass@agent.example.com")).toThrow("credentials");
    expect(() => normalizeAgentBaseUrl("https://agent.example.com/base")).toThrow("origin");
    expect(() => normalizeAgentBaseUrl("https://agent.example.com/?token=secret")).toThrow("origin");
  });

  test("uses a bearer token and refuses redirects for status requests", async () => {
    const connectionToken = ["connect", "test", "credential"].join("-");
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const status = await fetchAgentStatus(
      { baseUrl: "http://127.0.0.1:8790", token: connectionToken },
      async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ connected: true, tools: ["board.list_nodes"] }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(status.connected).toBe(true);
    expect(requestUrl).toBe("http://127.0.0.1:8790/api/agent/status");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(`Bearer ${connectionToken}`);
    expect(requestInit?.redirect).toBe("error");
    expect(requestInit?.credentials).toBe("omit");
  });

  test("validates Codex session and message responses", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/api/codex/session")) {
        return new Response(JSON.stringify({ id: "session-1", threadId: "thread-1" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    };
    const connection = { baseUrl: "http://127.0.0.1:8790", token: "secret" };
    const session = await createCodexSession(connection, "/tmp/board", fetcher);
    await sendCodexMessage(connection, session.id, "hello", fetcher);
    await respondCodexApproval(connection, session.id, 7, true, fetcher);
    await closeCodexSession(connection, session.id, fetcher);
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8790/api/codex/session",
      "http://127.0.0.1:8790/api/codex/message",
      "http://127.0.0.1:8790/api/codex/approval",
      "http://127.0.0.1:8790/api/codex/session/session-1",
    ]);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ cwd: "/tmp/board" });
    expect(JSON.parse(String(requests[1].init?.body))).toEqual({ sessionId: "session-1", text: "hello" });
    expect(JSON.parse(String(requests[2].init?.body))).toEqual({ sessionId: "session-1", id: 7, approve: true });
    expect(new Headers(requests[1].init?.headers).get("Authorization")).toBe("Bearer secret");
  });
});
