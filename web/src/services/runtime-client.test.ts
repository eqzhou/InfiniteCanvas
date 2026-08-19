import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  applyBoardOperations,
  parseRuntimeCommand,
  resolveRuntimeFileUrl,
  requestRuntimeTicket,
  runtimeWebsocketProtocol,
  runtimeWebsocketUrl,
  uploadRuntimeSnapshot,
} from "./runtime-client";
import { createProject, createNode } from "@/lib/defaults";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("browser runtime protocol", () => {
  test("parses bounded identified commands", () => {
    expect(parseRuntimeCommand(JSON.stringify({
      type: "command",
      id: "command-1",
      method: "board.get_state",
      data: {},
    }))).toEqual({ id: "command-1", method: "board.get_state", data: {} });
    expect(() => parseRuntimeCommand(JSON.stringify({
      type: "command",
      id: "../bad",
      method: "board.get_state",
      data: {},
    }))).toThrow("id");
    expect(() => parseRuntimeCommand(JSON.stringify({
      type: "command",
      id: "command-1",
      method: "shell.exec",
      data: {},
    }))).toThrow("method");
    expect(parseRuntimeCommand(JSON.stringify({
      type: "command",
      id: "command-generation",
      method: "generation_get_status",
      data: { taskId: "job-one" },
    }))).toEqual({
      id: "command-generation",
      method: "generation_get_status",
      data: { taskId: "job-one" },
    });
  });

  test("applies a validated operation batch without mutating the project", () => {
    const project = createProject("Runtime");
    const first = createNode("text", { x: 10, y: 20 }, { id: "node-1" });
    const input = { ...project, nodes: [first] };
    const second = createNode("text", { x: 300, y: 20 }, { id: "node-2" });
    const output = applyBoardOperations(input, [
      { op: "addNode", node: second },
      { op: "updateNode", id: "node-1", patch: { title: "Updated" } },
      { op: "addEdge", edge: { id: "edge-1", from: "node-1", to: "node-2" } },
    ]);
    expect(output.nodes.map((node) => node.id)).toEqual(["node-1", "node-2"]);
    expect(output.nodes[0]?.title).toBe("Updated");
    expect(output.edges).toEqual([{ id: "edge-1", from: "node-1", to: "node-2" }]);
    expect(input.nodes).toEqual([first]);
    expect(input.edges).toEqual([]);
  });

  test("rejects the complete batch when any operation is invalid", () => {
    const project = createProject("Runtime");
    expect(() => applyBoardOperations(project, [
      { op: "addNode", node: createNode("text", { x: 0, y: 0 }, { id: "node-1" }) },
      { op: "addEdge", edge: { id: "edge-1", from: "node-1", to: "missing" } },
    ])).toThrow("unknown node");
    expect(project.nodes).toEqual([]);
  });

  test("publishes loopback runtime files through the browser origin", () => {
    expect(resolveRuntimeFileUrl(
      "/api/files/snapshot.png",
      "http://127.0.0.1:8792",
      "http://127.0.0.1:5174",
    )).toBe("http://127.0.0.1:5174/api/files/snapshot.png");
    expect(resolveRuntimeFileUrl(
      "/api/files/snapshot.png",
      "https://agent.example.com",
      "http://localhost:5173",
    )).toBe("https://agent.example.com/api/files/snapshot.png");
  });
});

describe("runtime websocket ticket transport", () => {
  test("keeps the ticket out of the websocket URL", () => {
    expect(runtimeWebsocketUrl("http://127.0.0.1:8790")).toBe("ws://127.0.0.1:8790/api/runtime/ws");
    expect(runtimeWebsocketUrl("https://canvas.example")).toBe("wss://canvas.example/api/runtime/ws");
  });

  test("carries the ticket as a websocket subprotocol", () => {
    expect(runtimeWebsocketProtocol("runtime-abc")).toBe("openboard.runtime-abc");
  });

  test("requests a ticket with the agent token and derives the websocket protocol", async () => {
    const credentialFixture = "agent-secret";
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ ticket: "ticket_123" }), { status: 200 });
    });

    await expect(requestRuntimeTicket({ baseUrl: "https://agent.example", token: credentialFixture }, fetcher))
      .resolves.toEqual({
        ticket: "ticket_123",
        websocketUrl: "wss://agent.example/api/runtime/ws",
        protocol: "openboard.ticket_123",
      });
    expect(requests[0]?.url).toBe("https://agent.example/api/runtime/ticket");
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(`Bearer ${credentialFixture}`);
    expect(requests[0]?.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
  });

  test("rejects ticket HTTP errors and malformed ticket payloads", async () => {
    await expect(requestRuntimeTicket(
      { baseUrl: "http://127.0.0.1:8790" },
      async () => new Response("no", { status: 503 }),
    )).rejects.toThrow("runtime ticket failed: HTTP 503");
    await expect(requestRuntimeTicket(
      { baseUrl: "http://127.0.0.1:8790" },
      async () => new Response(JSON.stringify({ ticket: "../bad" }), { status: 200 }),
    )).rejects.toThrow("runtime ticket response is invalid");
  });

  test("uploads PNG snapshots and rewrites loopback file URLs to the public origin", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      // The first fetch is the data URL conversion performed by uploadRuntimeSnapshot.
      expect(String(input)).toBe("data:image/png;base64,AA==");
      return new Response(new Blob([new Uint8Array([137, 80])], { type: "image/png" }));
    }) as typeof fetch;
    const fetcher = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ url: "/api/files/snapshot.png" }), { status: 201 });
    });

    await expect(uploadRuntimeSnapshot(
      { baseUrl: "http://127.0.0.1:8792", token: "agent-token" },
      "data:image/png;base64,AA==",
      fetcher,
      "http://localhost:5174",
    )).resolves.toBe("http://localhost:5174/api/files/snapshot.png");
    expect(requests[0]?.url).toBe("http://127.0.0.1:8792/api/files");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.body).toBeInstanceOf(FormData);
    const form = requests[0]?.init?.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("board-snapshot.png");
  });

  test("rejects invalid snapshot media, upload failures, and invalid upload responses", async () => {
    globalThis.fetch = mock(async () => new Response(new Blob(["text"], { type: "text/plain" }))) as typeof fetch;
    await expect(uploadRuntimeSnapshot(
      { baseUrl: "http://127.0.0.1:8792" },
      "data:text/plain;base64,dGV4dA==",
      mock(async () => new Response(null, { status: 201 })),
    )).rejects.toThrow("runtime snapshot PNG is invalid or too large");

    globalThis.fetch = mock(async () => new Response(new Blob([new Uint8Array([1])], { type: "image/png" }))) as typeof fetch;
    await expect(uploadRuntimeSnapshot(
      { baseUrl: "https://agent.example" },
      "data:image/png;base64,AA==",
      mock(async () => new Response(null, { status: 502 })),
    )).rejects.toThrow("runtime snapshot upload failed: HTTP 502");
    await expect(uploadRuntimeSnapshot(
      { baseUrl: "https://agent.example" },
      "data:image/png;base64,AA==",
      mock(async () => new Response(JSON.stringify({ url: "https://attacker.example/file" }), { status: 200 })),
    )).rejects.toThrow("runtime snapshot upload response is invalid");
  });
});

describe("runtime command validation boundaries", () => {
  test("rejects malformed envelopes and bounded data violations", () => {
    const malformed = [
      ["not-json", "invalid JSON"],
      ["null", "must be an object"],
      ["[]", "must be an object"],
      [JSON.stringify({ type: "command", id: "x", method: "board.get_state", extra: true }), "unsupported"],
      [JSON.stringify({ type: "event", id: "x", method: "board.get_state" }), "type is invalid"],
      [JSON.stringify({ type: "command", id: "", method: "board.get_state" }), "id is invalid"],
      [JSON.stringify({ type: "command", id: "x", method: "unknown" }), "method is unsupported"],
      [JSON.stringify({ type: "command", id: "x", method: "board.get_state", data: [] }), "must be an object"],
    ] as const;
    for (const [input, message] of malformed) expect(() => parseRuntimeCommand(input)).toThrow(message);
    expect(parseRuntimeCommand(JSON.stringify({ type: "command", id: "x", method: "board.get_state", data: null }))).toEqual({
      id: "x",
      method: "board.get_state",
      data: {},
    });
    expect(() => parseRuntimeCommand("x".repeat(32 * 1024 * 1024 + 1))).toThrow("too large");
  });

  test("preserves authenticated file URLs when public origins are invalid or unsafe", () => {
    expect(resolveRuntimeFileUrl("/api/files/a.png?x=1", "http://127.0.0.1:8792", "not a URL"))
      .toBe("http://127.0.0.1:8792/api/files/a.png?x=1");
    expect(resolveRuntimeFileUrl("/api/files/a.png", "http://127.0.0.1:8792", "http://user:pass@localhost:5174"))
      .toBe("http://127.0.0.1:8792/api/files/a.png");
    expect(resolveRuntimeFileUrl("/api/files/a.png", "http://127.0.0.1:8792", "file:///tmp"))
      .toBe("http://127.0.0.1:8792/api/files/a.png");
  });
});

describe("runtime board operations", () => {
  test("updates metadata, removes group membership and connected edges, and sets viewport", () => {
    const project = createProject("Runtime");
    const first = createNode("text", { x: 0, y: 0 }, { id: "node-1", metadata: { content: "old" } });
    const second = createNode("text", { x: 40, y: 0 }, { id: "node-2" });
    const group = createNode("group", { x: 0, y: 0 }, { id: "group-1", metadata: { childIds: ["node-1", "node-2"] } });
    const input = { ...project, nodes: [first, second, group], edges: [
      { id: "edge-1", from: "node-1", to: "node-2" },
      { id: "edge-2", from: "group-1", to: "node-2" },
    ] };
    const output = applyBoardOperations(input, [
      { op: "updateNode", id: "node-1", patch: { metadata: { content: "new", prompt: "p" } } },
      { op: "deleteNodes", ids: ["node-2"] },
      { op: "deleteEdges", ids: ["edge-2"] },
      { op: "setViewport", viewport: { x: 4, y: 5, k: 2 } },
    ]);
    expect(output.nodes.find((node) => node.id === "node-1")?.metadata).toMatchObject({ content: "new", prompt: "p" });
    expect(output.nodes.find((node) => node.id === "group-1")?.metadata.childIds).toEqual(["node-1"]);
    expect(output.edges).toEqual([]);
    expect(output.viewport).toEqual({ x: 4, y: 5, k: 2 });
    expect(input.nodes.find((node) => node.id === "node-1")?.metadata.content).toBe("old");
  });

  test("rejects invalid operation batches, duplicates, and unsupported patches", () => {
    const project = createProject("Runtime");
    const node = createNode("text", { x: 0, y: 0 }, { id: "node-1" });
    const withNode = { ...project, nodes: [node] };
    expect(() => applyBoardOperations(project, [])).toThrow("between 1 and 1000");
    expect(() => applyBoardOperations(project, [null as never])).toThrow("operation is invalid");
    expect(() => applyBoardOperations(withNode, [{ op: "addNode", node }])).toThrow("node id already exists");
    expect(() => applyBoardOperations(withNode, [{ op: "updateNode", id: "missing", patch: {} }])).toThrow("was not found");
    expect(() => applyBoardOperations(withNode, [{ op: "updateNode", id: "node-1", patch: { nope: true } as never }])).toThrow("patch field is unsupported");
    expect(() => applyBoardOperations(withNode, [{ op: "deleteNodes", ids: [] }])).toThrow("node ids are required");
    expect(() => applyBoardOperations(withNode, [{ op: "addEdge", edge: { id: "edge-1", from: "node-1", to: "node-1" } } as never, { op: "addEdge", edge: { id: "edge-1", from: "node-1", to: "node-1" } } as never])).toThrow("edge id already exists");
    expect(() => applyBoardOperations(withNode, [{ op: "deleteEdges", ids: [] }])).toThrow("edge ids are required");
    expect(() => applyBoardOperations(withNode, [{ op: "unknown" } as never])).toThrow("operation is unsupported");
  });
});
