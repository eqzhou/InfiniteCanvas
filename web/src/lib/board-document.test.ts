import { describe, expect, test } from "bun:test";

import { parseBoardProject } from "./board-document";

const validProject = () => ({
  id: "project_1",
  title: "Imported board",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
  nodes: [
    {
      id: "node_1",
      type: "text",
      title: "Text",
      position: { x: 10, y: 20 },
      width: 320,
      height: 180,
      metadata: { content: "hello" },
    },
  ],
  edges: [],
  chatSessions: [],
  activeChatId: null,
  backgroundMode: "dots",
  viewport: { x: 0, y: 0, k: 1 },
});

describe("parseBoardProject", () => {
  test("accepts a complete valid document without mutating it", () => {
    const input = validProject();
    const parsed = parseBoardProject(input);
    expect(parsed).toEqual({ ...input, schemaVersion: 2 });
    expect("schemaVersion" in input).toBe(false);
  });

  test("accepts schema v2 and rejects unknown future schemas", () => {
    const current = { ...validProject(), schemaVersion: 2 };
    expect(parseBoardProject(current)).toEqual(current);
    expect(() => parseBoardProject({ ...current, schemaVersion: 3 })).toThrow(
      "schemaVersion",
    );
  });

  test("rejects non-finite geometry", () => {
    const input = validProject();
    input.nodes[0]!.position.x = Number.NaN;
    expect(() => parseBoardProject(input)).toThrow("position.x");
  });

  test("rejects duplicate node ids", () => {
    const input = validProject();
    input.nodes.push({ ...input.nodes[0]! });
    expect(() => parseBoardProject(input)).toThrow("duplicate node id");
  });

  test("rejects edges whose endpoints do not exist", () => {
    const input = validProject();
    input.edges.push({ id: "edge_1", from: "node_1", to: "missing" });
    expect(() => parseBoardProject(input)).toThrow("unknown node");
  });

  test("rejects unsupported node and background modes", () => {
    const nodeInput = validProject();
    nodeInput.nodes[0]!.type = "script";
    expect(() => parseBoardProject(nodeInput)).toThrow("nodes[0].type");

    const backgroundInput = validProject();
    backgroundInput.backgroundMode = "image";
    expect(() => parseBoardProject(backgroundInput)).toThrow("backgroundMode");
  });

  test("accepts a plugin node with bounded JSON state", () => {
    const input = validProject();
    input.nodes[0] = {
      ...input.nodes[0]!,
      type: "plugin",
      title: "Checklist",
      metadata: {
        pluginId: "openboard.checklist",
        pluginState: { items: [{ label: "Ship", done: false }], count: 1 },
      },
    };

    expect(parseBoardProject(input).nodes[0]?.metadata.pluginState).toEqual(
      input.nodes[0]!.metadata.pluginState,
    );
  });

  test("rejects plugin nodes without a valid plugin id", () => {
    const input = validProject();
    input.nodes[0] = {
      ...input.nodes[0]!,
      type: "plugin",
      metadata: { pluginId: "../unsafe", pluginState: {} },
    };
    expect(() => parseBoardProject(input)).toThrow("pluginId");

    input.nodes[0]!.metadata = { pluginState: {} };
    expect(() => parseBoardProject(input)).toThrow("pluginId");
  });

  test("rejects unsafe, deeply nested, and oversized plugin state", () => {
    const makePlugin = (pluginState: unknown) => {
      const input = validProject();
      input.nodes[0] = {
        ...input.nodes[0]!,
        type: "plugin",
        metadata: { pluginId: "openboard.note", pluginState },
      };
      return input;
    };

    const unsafe = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');
    expect(() => parseBoardProject(makePlugin(unsafe))).toThrow("unsafe key");

    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 24; i += 1) deep = { child: deep };
    expect(() => parseBoardProject(makePlugin(deep))).toThrow("depth");

    expect(() =>
      parseBoardProject(makePlugin({ body: "x".repeat(256 * 1024) })),
    ).toThrow("256 KiB");
  });

  test("accepts groups only when every child is a real non-group node", () => {
    const input = validProject();
    input.nodes.unshift({
      id: "group_1",
      type: "group",
      title: "Group",
      position: { x: 0, y: 0 },
      width: 500,
      height: 300,
      metadata: { childIds: ["node_1"] },
    });
    expect(parseBoardProject(input).nodes[0]?.metadata.childIds).toEqual(["node_1"]);

    input.nodes[0]!.metadata.childIds = ["missing"];
    expect(() => parseBoardProject(input)).toThrow("invalid child");
  });

  test("rejects duplicate group membership", () => {
    const input = validProject();
    input.nodes.unshift(
      {
        id: "group_1",
        type: "group",
        title: "One",
        position: { x: 0, y: 0 },
        width: 500,
        height: 300,
        metadata: { childIds: ["node_1"] },
      },
      {
        id: "group_2",
        type: "group",
        title: "Two",
        position: { x: 0, y: 0 },
        width: 500,
        height: 300,
        metadata: { childIds: ["node_1"] },
      },
    );
    expect(() => parseBoardProject(input)).toThrow("multiple groups");
  });

  test("rejects active and local-file media URL schemes", () => {
    const input = validProject();
    input.nodes[0]!.type = "image";
    input.nodes[0]!.metadata.content = "javascript:alert(1)";
    expect(() => parseBoardProject(input)).toThrow("unsafe media URL");
  });

  test("validates font, transparency, model, and normalized split metadata", () => {
    const input = validProject();
    input.nodes[0]!.metadata = { fontSize: 9 };
    expect(() => parseBoardProject(input)).toThrow("fontSize");
    input.nodes[0]!.metadata = { transparentBackground: "yes" };
    expect(() => parseBoardProject(input)).toThrow("transparentBackground");
    input.nodes[0]!.metadata = { splitVertical: [0.7, 0.2] };
    expect(() => parseBoardProject(input)).toThrow("sorted normalized");
    input.nodes[0]!.metadata = { model: "x".repeat(501) };
    expect(() => parseBoardProject(input)).toThrow("model");
  });
});
