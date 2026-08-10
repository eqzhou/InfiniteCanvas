import { describe, expect, test } from "bun:test";

import {
  closeCodexSession,
  createCodexSession,
  deleteCodexAttachment,
  decideProjectSync,
  fetchAgentStatus,
  getCodexHistory,
  getCodexSession,
  interruptCodexTurn,
  normalizeAgentBaseUrl,
  parseCodexSseRecords,
  prewarmCodexSession,
  resolveAgentBaseUrl,
  respondCodexApproval,
  listCodexHistory,
  listCodexModels,
  deleteCodexHistory,
  bulkDeleteCodexHistory,
  restoreCodexHistory,
  revealCodexFile,
  sendCodexMessage,
  subscribeCodexEvents,
  uploadCodexAttachments,
  updateCodexPreferences,
} from "./local-agent";
import { clearSessionToken, setSessionToken } from "./auth-session";

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

describe("Codex history and file-manager APIs", () => {
  test("lists, restores, deletes history and reveals a local path with bounded requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/api/codex/history?profile=default")) {
        return new Response(JSON.stringify([{
          id: "history-one", profile: "default", threadId: "thread-one", title: "检查画布",
          createdAt: "2026-07-31T00:00:00Z", updatedAt: "2026-07-31T00:00:01Z",
          messageCount: 2, preview: "已完成", status: "completed",
        }]), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/codex/history/history-one/restore")) {
        return new Response(JSON.stringify({
          session: { id: "session-one", threadId: "thread-one", profile: "default", running: false, historyId: "history-one" },
          history: {
            id: "history-one", profile: "default", threadId: "thread-one", title: "检查画布",
            createdAt: "2026-07-31T00:00:00Z", updatedAt: "2026-07-31T00:00:01Z",
            messageCount: 2, preview: "已完成", status: "completed",
            messages: [
              { id: "user-one", role: "user", text: "检查画布", createdAt: "2026-07-31T00:00:00Z" },
              { id: "assistant-one", role: "assistant", text: "已完成", createdAt: "2026-07-31T00:00:01Z" },
            ], events: [],
          },
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/codex/reveal")) {
        return new Response(JSON.stringify({ path: "web/src/App.tsx" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ deleted: 2, ok: true }), {
        headers: { "content-type": "application/json" },
      });
    };
    const connection = { baseUrl: "http://localhost:5173", token: "secret" };
    const history = await listCodexHistory(connection, "default", fetcher);
    expect(history[0]?.title).toBe("检查画布");
    const restored = await restoreCodexHistory(connection, "history-one", fetcher);
    expect(restored.session.historyId).toBe("history-one");
    await bulkDeleteCodexHistory(connection, ["history-one", "history-two"], fetcher);
    await deleteCodexHistory(connection, "history-one", fetcher);
    await revealCodexFile(connection, "session-one", "web/src/App.tsx", fetcher);
    expect(requests.map((request) => request.url)).toEqual([
      "http://localhost:5173/api/codex/history?profile=default",
      "http://localhost:5173/api/codex/history/history-one/restore",
      "http://localhost:5173/api/codex/history/bulk-delete",
      "http://localhost:5173/api/codex/history/history-one",
      "http://localhost:5173/api/codex/reveal",
    ]);
    expect(JSON.parse(String(requests[2].init?.body))).toEqual({ ids: ["history-one", "history-two"] });
    expect(JSON.parse(String(requests[4].init?.body))).toEqual({ sessionId: "session-one", path: "web/src/App.tsx" });
  });

  test("rejects malformed history events before transcript hydration", async () => {
    const response = new Response(JSON.stringify({
      id: "history-one", profile: "default", threadId: "thread-one", title: "检查画布",
      createdAt: "2026-07-31T00:00:00Z", updatedAt: "2026-07-31T00:00:01Z",
      messageCount: 0, status: "completed", messages: [], events: [null],
    }), { headers: { "content-type": "application/json" } });

    await expect(getCodexHistory(
      { baseUrl: "http://localhost:5173", token: ["history", "fixture"].join("-") },
      "history-one",
      "default",
      async () => response,
    )).rejects.toThrow("invalid Codex history transcript");
  });

  test("rejects malformed structured references restored from Codex history", async () => {
    const response = new Response(JSON.stringify({
      id: "history-one", profile: "default", threadId: "thread-one", title: "检查画布",
      createdAt: "2026-07-31T00:00:00Z", updatedAt: "2026-07-31T00:00:01Z",
      messageCount: 1, status: "completed", events: [], messages: [{
        id: "user-one", role: "user", text: "检查画布", createdAt: "2026-07-31T00:00:00Z",
        contextReferences: [{ kind: "node", id: "../outside", label: "越界节点" }],
      }],
    }), { headers: { "content-type": "application/json" } });

    await expect(getCodexHistory(
      { baseUrl: "http://localhost:5173", token: ["history", "fixture"].join("-") },
      "history-one",
      "default",
      async () => response,
    )).rejects.toThrow("invalid Codex history transcript");
  });
});

describe("local agent connection", () => {
  test("prewarms a reusable Codex session through the normal session boundary", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const session = await prewarmCodexSession(
      { baseUrl: "http://localhost:5173" },
      "default",
      async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ id: "session-warm", running: false }), {
          headers: { "content-type": "application/json" },
        });
      },
    );

    expect(session.id).toBe("session-warm");
    expect(requestUrl).toBe("http://localhost:5173/api/codex/session");
    expect(requestBody).toEqual({ profile: "default", fresh: false });
  });

  test("deduplicates concurrent prewarm requests for the same connection", async () => {
    let requestCount = 0;
    const fetcher = async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ id: "session-deduped", running: false }), {
        headers: { "content-type": "application/json" },
      });
    };
    const connection = { baseUrl: "http://localhost:5174", token: ["dedupe", "fixture"].join("-") };
    const sessions = await Promise.all([
      prewarmCodexSession(connection, "default", fetcher),
      prewarmCodexSession(connection, "default", fetcher),
    ]);

    expect(requestCount).toBe(1);
    expect(sessions[0]).toEqual(sessions[1]);
  });

  test("scopes same-origin prewarm sessions to the active browser session", async () => {
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: new URL("http://localhost:5188/"),
    });
    let requestCount = 0;
    const requestSessionTokens: Array<string | null> = [];
    const connection = { baseUrl: "http://localhost:5188" };
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      requestSessionTokens.push(new Headers(init?.headers).get("X-OpenBoard-Session"));
      if (requestCount === 1) setSessionToken("session-b");
      return new Response(JSON.stringify({ id: `session-${requestCount}`, running: false }), {
        headers: { "content-type": "application/json" },
      });
    };
    try {
      setSessionToken("session-a");
      await prewarmCodexSession(connection, "default", fetcher);
      setSessionToken("session-b");
      await prewarmCodexSession(connection, "default", fetcher);
      expect(requestCount).toBe(2);
      expect(requestSessionTokens).toEqual(["session-a", "session-b"]);
    } finally {
      clearSessionToken();
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
      if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation);
      else delete (globalThis as { location?: Location }).location;
    }
  });

  test("uses the same-origin proxy for the default URL when no browser token exists", () => {
    expect(resolveAgentBaseUrl("http://127.0.0.1:8790", "", "http://localhost:5173"))
      .toBe("http://localhost:5173");
    expect(resolveAgentBaseUrl("http://127.0.0.1:8790", "token", "http://localhost:5173"))
      .toBe("http://127.0.0.1:8790");
    expect(resolveAgentBaseUrl("https://agent.example.com", "", "http://localhost:5173"))
      .toBe("https://agent.example.com");
  });

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

  test("rejects oversized Codex SSE frames before parsing their payload", () => {
    const oversized = JSON.stringify({ type: "notification", data: "x".repeat(300_000) });
    expect(() => parseCodexSseRecords(`data: ${oversized}\n\n`)).toThrow("size limit");
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
	const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	const values = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
	  configurable: true,
	  value: {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	  },
	});
	Object.defineProperty(globalThis, "location", {
	  configurable: true,
	  value: new URL("http://localhost:5173/prompts"),
	});
	setSessionToken("user-session-1");
	try {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/api/codex/session")) {
        return new Response(JSON.stringify({ id: "session-1", threadId: "thread-1" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input).includes("/api/codex/session?profile=")) {
        return new Response(JSON.stringify({ id: "session-1", threadId: "thread-1", profile: "default", running: false }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input).endsWith("/api/codex/attachments")) {
        return new Response(JSON.stringify({
          attachments: [{ id: "image-1", name: "pixel.png", mimeType: "image/png", bytes: 5 }],
        }), { headers: { "content-type": "application/json" } });
      }
      if (String(input).endsWith("/api/codex/models?sessionId=session-1")) {
        return new Response(JSON.stringify({
          data: [{
            id: "gpt-5.6-terra",
            model: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra",
            description: "Fast coding model",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" },
            ],
            isDefault: true,
          }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    };
	const connection = { baseUrl: "http://localhost:5173", token: "secret" };
    const session = await createCodexSession(connection, "/tmp/board", fetcher);
    const active = await getCodexSession(connection, "default", fetcher);
    const models = await listCodexModels(connection, session.id, fetcher);
    const attachments = await uploadCodexAttachments(connection, session.id, [
      new File(["pixel"], "pixel.png", { type: "image/png" }),
    ], fetcher);
    await deleteCodexAttachment(connection, session.id, attachments[0].id, fetcher);
    await sendCodexMessage(
      connection,
      session.id,
      "hello",
      fetcher,
      {
        attachmentIds: attachments.map((item) => item.id),
        clientMessageId: "message-one",
        permissionMode: "read-only",
        model: "gpt-5.6-terra",
        effort: "medium",
        contextReferences: [{ kind: "skill", id: "review-code", label: "Review code" }, { kind: "node", id: "node-1", label: "产品主图" }],
      },
    );
    await interruptCodexTurn(connection, session.id, fetcher);
    await respondCodexApproval(connection, session.id, 7, true, fetcher);
    await closeCodexSession(connection, session.id, fetcher);
    expect(requests.map((request) => request.url)).toEqual([
	  "http://localhost:5173/api/codex/session",
	  "http://localhost:5173/api/codex/session?profile=default",
	  "http://localhost:5173/api/codex/models?sessionId=session-1",
	  "http://localhost:5173/api/codex/attachments",
	  "http://localhost:5173/api/codex/attachments/image-1?sessionId=session-1",
	  "http://localhost:5173/api/codex/message",
	  "http://localhost:5173/api/codex/interrupt",
	  "http://localhost:5173/api/codex/approval",
	  "http://localhost:5173/api/codex/session/session-1",
    ]);
    expect(active?.threadId).toBe("thread-1");
    expect(models[0]?.supportedReasoningEfforts.map((item) => item.reasoningEffort))
      .toEqual(["low", "medium"]);
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ cwd: "/tmp/board" });
    expect(JSON.parse(String(requests[5].init?.body))).toEqual({
      sessionId: "session-1",
      text: "hello",
      attachmentIds: ["image-1"],
      clientMessageId: "message-one",
      permissionMode: "read-only",
      model: "gpt-5.6-terra",
      effort: "medium",
      contextReferences: [{ kind: "skill", id: "review-code", label: "Review code" }, { kind: "node", id: "node-1", label: "产品主图" }],
    });

    expect(JSON.parse(String(requests[7].init?.body))).toEqual({ sessionId: "session-1", id: 7, approve: true });
	  expect(new Headers(requests[5].init?.headers).get("Authorization")).toBeNull();
	  expect(requests.every((request) => new Headers(request.init?.headers).get("X-OpenBoard-Session") === "user-session-1")).toBe(true);
	  let remoteHeaders = new Headers();
	  const remoteConnectionCredential = ["remote", "agent", "credential"].join("-");
	  await fetchAgentStatus({ baseUrl: "https://agent.example.com", token: remoteConnectionCredential }, async (_input, init) => {
		remoteHeaders = new Headers(init?.headers);
		return new Response(JSON.stringify({ connected: true, tools: [] }), {
		  headers: { "content-type": "application/json" },
		});
	  });
	  expect(remoteHeaders.get("Authorization")).toBe(`Bearer ${remoteConnectionCredential}`);
	  expect(remoteHeaders.get("X-OpenBoard-Session")).toBeNull();
	} finally {
	  clearSessionToken();
	  if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
	  else delete (globalThis as { localStorage?: Storage }).localStorage;
	  if (priorLocation) Object.defineProperty(globalThis, "location", priorLocation);
	  else delete (globalThis as { location?: Location }).location;
	}
  });

  test("rejects an unbounded or internally inconsistent Codex model catalog", async () => {
    const connection = { baseUrl: "http://localhost:5173" };
    const duplicate = {
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      description: "Balanced",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      isDefault: true,
    };
    await expect(listCodexModels(connection, "session-one", async () => new Response(JSON.stringify({
      data: [duplicate, duplicate],
    }), { headers: { "content-type": "application/json" } }))).rejects.toThrow("duplicate");
    await expect(listCodexModels(connection, "session-one", async () => new Response(JSON.stringify({
      data: [{ ...duplicate, defaultReasoningEffort: "xhigh" }],
    }), { headers: { "content-type": "application/json" } }))).rejects.toThrow("unavailable default");
    await expect(listCodexModels(connection, "session-one", async () => new Response(JSON.stringify({
      data: [duplicate, { ...duplicate, id: "gpt-5.6-terra-alias" }],
    }), { headers: { "content-type": "application/json" } }))).rejects.toThrow("duplicate");
    await expect(listCodexModels(connection, "session-one", async () => new Response(JSON.stringify({
      data: [{
        ...duplicate,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "medium", description: "Duplicate" },
        ],
      }],
    }), { headers: { "content-type": "application/json" } }))).rejects.toThrow("duplicate");
    const custom = await listCodexModels(connection, "session-one", async () => new Response(JSON.stringify({
      data: [{ ...duplicate, id: "provider/model+preview", model: "provider/model+preview" }],
    }), { headers: { "content-type": "application/json" } }));
    expect(custom[0]?.model).toBe("provider/model+preview");
  });

  test("persists a bounded Codex selection through the agent scope", async () => {
    let payload: unknown;
    await updateCodexPreferences(
      { baseUrl: "http://localhost:5173" },
      "session-one",
      "provider/model+preview",
      "xhigh",
      async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    expect(payload).toEqual({
      sessionId: "session-one",
      model: "provider/model+preview",
      effort: "xhigh",
    });
    await expect(updateCodexPreferences(
      { baseUrl: "http://localhost:5173" },
      "session-one",
      "bad\nmodel",
      "xhigh",
      async () => new Response(),
    )).rejects.toThrow("model selection");
  });

  test("reconnects sequenced Codex streams and suppresses replay duplicates", async () => {
    const responses = [
      [{ sequence: 1, type: "notification", method: "item/completed" }],
      [
        { sequence: 1, type: "notification", method: "item/completed" },
        { sequence: 1, type: "notification", method: "openboard/session_state", data: { id: "session-1", running: true } },
        { sequence: 2, type: "notification", method: "turn/completed" },
      ],
    ];
    let calls = 0;
    const fetcher = async () => {
      const events = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return new Response(events.map((event) => `event: notification\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const received: string[] = [];
    let subscription!: ReturnType<typeof subscribeCodexEvents>;
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    subscription = subscribeCodexEvents(
      { baseUrl: "http://127.0.0.1:8790", token: "secret" },
      "session-1",
      (event) => {
        received.push(event.method ?? "");
        if (event.method === "turn/completed") {
          subscription.close();
          finish();
        }
      },
      undefined,
      fetcher,
    );
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("stream did not recover")), 2_000)),
    ]);
    expect(calls).toBe(2);
    expect(received.filter((method) => method === "item/completed")).toHaveLength(1);
    expect(received).toContain("openboard/session_state");
    expect(received).toContain("turn/completed");
  });

  test("stops reconnecting when the Codex session reaches a terminal HTTP state", async () => {
    let calls = 0;
    let recoverable: boolean | undefined;
    const subscription = subscribeCodexEvents(
      { baseUrl: "http://127.0.0.1:8790", token: "secret" },
      "session-closed",
      () => undefined,
      (_error, canRecover) => { recoverable = canRecover; },
      async () => {
        calls += 1;
        return new Response("closed", { status: 404 });
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    subscription.close();
    expect(calls).toBe(1);
    expect(recoverable).toBe(false);
  });

  test("reconnects an empty Codex stream and resumes after the last sequence", async () => {
    const urls: string[] = [];
    const errors: boolean[] = [];
    let calls = 0;
    let subscription!: ReturnType<typeof subscribeCodexEvents>;
    const completed = new Promise<void>((resolve) => {
      subscription = subscribeCodexEvents(
        { baseUrl: "http://127.0.0.1:8790", token: "secret" },
        "session-1",
        (event) => {
          if (event.sequence === 1) return;
          subscription.close();
          resolve();
        },
        (_error, recoverable) => { errors.push(recoverable); },
        async (input) => {
          urls.push(String(input));
          calls += 1;
          if (calls === 1) return new Response("");
          if (calls === 2) {
            return new Response(`event: notification\ndata: ${JSON.stringify({ sequence: 1, type: "notification", method: "item/completed" })}\n\n`);
          }
          return new Response(`event: notification\ndata: ${JSON.stringify({ sequence: 2, type: "notification", method: "turn/completed" })}\n\n`);
        },
      );
    });
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("empty stream did not recover")), 2_000)),
    ]);
    expect(calls).toBe(3);
    expect(urls[2]).toContain("afterSequence=1");
    expect(errors).toContain(true);
  });

  test("releases each backoff abort listener when its timer expires normally", async () => {
    const originalAdd = AbortSignal.prototype.addEventListener;
    const originalRemove = AbortSignal.prototype.removeEventListener;
    let added = 0;
    let removed = 0;
    AbortSignal.prototype.addEventListener = function patchedAdd(this: AbortSignal, ...args: Parameters<typeof originalAdd>) {
      if (args[0] === "abort") added += 1;
      return originalAdd.apply(this, args);
    } as typeof originalAdd;
    AbortSignal.prototype.removeEventListener = function patchedRemove(this: AbortSignal, ...args: Parameters<typeof originalRemove>) {
      if (args[0] === "abort") removed += 1;
      return originalRemove.apply(this, args);
    } as typeof originalRemove;
    try {
      let calls = 0;
      let subscription!: ReturnType<typeof subscribeCodexEvents>;
      const completed = new Promise<void>((resolve) => {
        subscription = subscribeCodexEvents(
          { baseUrl: "http://127.0.0.1:8790", token: "secret" },
          "session-1",
          () => {
            subscription.close();
            resolve();
          },
          undefined,
          async () => {
            calls += 1;
            // Two empty streams force two backoff waits before the event lands.
            if (calls <= 2) return new Response("");
            return new Response(`event: notification\ndata: ${JSON.stringify({ sequence: 1, type: "notification", method: "turn/completed" })}\n\n`);
          },
        );
      });
      await Promise.race([
        completed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("stream did not deliver")), 2_000)),
      ]);
      expect(calls).toBe(3);
      // Both expired backoff timers must have detached their abort listeners, so
      // the stream cannot accumulate one listener per reconnect.
      expect(added - removed).toBeLessThanOrEqual(1);
    } finally {
      AbortSignal.prototype.addEventListener = originalAdd;
      AbortSignal.prototype.removeEventListener = originalRemove;
    }
  });

  test("replays an event when its consumer throws before committing the checkpoint", async () => {
    const urls: string[] = [];
    let attempts = 0;
    let subscription!: ReturnType<typeof subscribeCodexEvents>;
    const completed = new Promise<void>((resolve) => {
      subscription = subscribeCodexEvents(
        { baseUrl: "http://127.0.0.1:8790", token: "secret" },
        "session-1",
        () => {
          attempts += 1;
          if (attempts === 1) throw new Error("storage unavailable");
          subscription.close();
          resolve();
        },
        undefined,
        async (input) => {
          urls.push(String(input));
          return new Response(`event: notification\ndata: ${JSON.stringify({ sequence: 1, type: "notification", method: "item/completed" })}\n\n`);
        },
      );
    });
    await Promise.race([
      completed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("failed event was not replayed")), 2_000)),
    ]);
    expect(attempts).toBe(2);
    expect(urls).toHaveLength(2);
    expect(urls[1]).not.toContain("afterSequence");
  });
});
