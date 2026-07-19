import { describe, expect, test } from "bun:test";
import {
  applyBoardOperations,
  parseRuntimeCommand,
  resolveRuntimeFileUrl,
} from "./runtime-client";
import { createProject, createNode } from "@/lib/defaults";

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
