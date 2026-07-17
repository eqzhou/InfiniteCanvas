import { describe, expect, test } from "bun:test";

import {
  createGroup,
  expandGroupedSelection,
  pruneGroupMembership,
  reconcileGroupMembership,
  ungroupNodes,
} from "./grouping";
import type { BoardNode } from "@/types/board";

const textNode = (id: string, x: number, y: number): BoardNode => ({
  id,
  type: "text",
  title: id,
  position: { x, y },
  width: 100,
  height: 80,
  metadata: {},
});

describe("node grouping", () => {
  test("creates a padded group behind selected nodes", () => {
    const a = textNode("a", 100, 80);
    const b = textNode("b", 260, 160);
    const result = createGroup([a, b], ["a", "b"], "group_1", 24);

    expect(result.group?.type).toBe("group");
    expect(result.group?.metadata.childIds).toEqual(["a", "b"]);
    expect(result.group?.position).toEqual({ x: 76, y: 56 });
    expect(result.group?.width).toBe(308);
    expect(result.group?.height).toBe(208);
    expect(result.nodes[0]?.id).toBe("group_1");
    expect(result.selectedIds).toEqual(["group_1"]);
    expect(result.nodes[1]).toBe(a);
  });

  test("requires two eligible non-group nodes", () => {
    const a = textNode("a", 0, 0);
    const result = createGroup([a], ["a"], "group_1");
    expect(result.group).toBeNull();
    expect(result.nodes).toBe(result.nodes);
  });

  test("does not assign nodes that already belong to another group", () => {
    const grouped = createGroup(
      [textNode("a", 0, 0), textNode("b", 120, 0), textNode("c", 240, 0)],
      ["a", "b"],
      "group_1",
    );
    const second = createGroup(grouped.nodes, ["a", "c"], "group_2");
    expect(second.group).toBeNull();
  });

  test("expands group selection for a single movement commit", () => {
    const grouped = createGroup(
      [textNode("a", 0, 0), textNode("b", 120, 0)],
      ["a", "b"],
      "group_1",
    );
    expect(expandGroupedSelection(grouped.nodes, ["group_1"])).toEqual([
      "group_1",
      "a",
      "b",
    ]);
  });

  test("ungroup removes only the group container", () => {
    const grouped = createGroup(
      [textNode("a", 0, 0), textNode("b", 120, 0)],
      ["a", "b"],
      "group_1",
    );
    const result = ungroupNodes(grouped.nodes, ["group_1"]);
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(result.selectedIds).toEqual(["a", "b"]);
  });

  test("removes deleted children and empty groups immutably", () => {
    const grouped = createGroup(
      [textNode("a", 0, 0), textNode("b", 120, 0)],
      ["a", "b"],
      "group_1",
    );
    const oneLeft = pruneGroupMembership(grouped.nodes, new Set(["a"]));
    expect(oneLeft.find((node) => node.id === "group_1")?.metadata.childIds).toEqual(["b"]);

    const noneLeft = pruneGroupMembership(grouped.nodes, new Set(["a", "b"]));
    expect(noneLeft.some((node) => node.id === "group_1")).toBe(false);
    expect(grouped.group?.metadata.childIds).toEqual(["a", "b"]);
  });

  test("joins a group when a node is dragged inside and recomputes 24px bounds", () => {
    const a = textNode("a", 100, 100);
    const b = textNode("b", 220, 100);
    const grouped = createGroup([a, b], ["a", "b"], "group_1", 24);
    const c = textNode("c", 150, 130);
    const result = reconcileGroupMembership([...grouped.nodes, c], ["c"]);
    const group = result.nodes.find((node) => node.id === "group_1")!;

    expect(result.changed).toBe(true);
    expect(group.metadata.childIds).toEqual(["a", "b", "c"]);
    expect(group.position).toEqual({ x: 76, y: 76 });
    expect(group.width).toBe(268);
    expect(group.height).toBe(158);
    expect(grouped.group?.metadata.childIds).toEqual(["a", "b"]);
  });

  test("removes a member only after it clears the group by more than 16px", () => {
    const grouped = createGroup(
      [textNode("a", 100, 100), textNode("b", 220, 100)],
      ["a", "b"],
      "group_1",
      24,
    );
    const near = grouped.nodes.map((node) =>
      node.id === "a" ? { ...node, position: { x: 61, y: 100 } } : node,
    );
    expect(
      reconcileGroupMembership(near, ["a"]).nodes.find((node) => node.id === "group_1")
        ?.metadata.childIds,
    ).toContain("a");

    const far = grouped.nodes.map((node) =>
      node.id === "a" ? { ...node, position: { x: 20, y: 100 } } : node,
    );
    const result = reconcileGroupMembership(far, ["a"]);
    expect(
      result.nodes.find((node) => node.id === "group_1")?.metadata.childIds,
    ).toEqual(["b"]);
  });

  test("does not steal a node from another group", () => {
    const first = createGroup(
      [textNode("a", 100, 100), textNode("b", 220, 100)],
      ["a", "b"],
      "group_1",
      24,
    );
    const other: BoardNode = {
      id: "group_2",
      type: "group",
      title: "other",
      position: { x: 50, y: 50 },
      width: 500,
      height: 300,
      metadata: { childIds: ["a"] },
    };
    const invalid = first.nodes.map((node) =>
      node.id === "group_1"
        ? { ...node, metadata: { ...node.metadata, childIds: ["b"] } }
        : node,
    );
    const result = reconcileGroupMembership([other, ...invalid], ["a"]);
    expect(result.nodes.find((node) => node.id === "group_2")?.metadata.childIds).toEqual(["a"]);
    expect(result.nodes.find((node) => node.id === "group_1")?.metadata.childIds).toEqual(["b"]);
  });

  test("updates group bounds when a member moves without changing membership", () => {
    const grouped = createGroup(
      [textNode("a", 100, 100), textNode("b", 220, 100)],
      ["a", "b"],
      "group_1",
      24,
    );
    const moved = grouped.nodes.map((node) =>
      node.id === "b" ? { ...node, position: { x: 260, y: 140 } } : node,
    );
    const result = reconcileGroupMembership(moved, ["b"]);
    const group = result.nodes.find((node) => node.id === "group_1")!;
    expect(result.changed).toBe(true);
    expect(group.metadata.childIds).toEqual(["a", "b"]);
    expect(group.position).toEqual({ x: 76, y: 76 });
    expect(group.width).toBe(308);
    expect(group.height).toBe(168);
  });
});
