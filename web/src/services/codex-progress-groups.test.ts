import { describe, expect, test } from "bun:test";
import type { CodexProgressItem } from "./codex-progress";
import {
  groupCodexProgress,
  isCommandProgressItem,
  type CodexProgressGroup,
} from "./codex-progress-groups";

function item(overrides: Partial<CodexProgressItem> & { id: string }): CodexProgressItem {
  return {
    itemType: "command_execution",
    label: "运行命令",
    status: "completed",
    ...overrides,
  };
}

function commandGroup(group: CodexProgressGroup) {
  if (group.kind !== "command-group") throw new Error("expected command-group");
  return group;
}

describe("isCommandProgressItem", () => {
  test("matches command item types case-insensitively", () => {
    expect(isCommandProgressItem(item({ id: "a", itemType: "CommandExecution" }))).toBe(true);
    expect(isCommandProgressItem(item({ id: "b", itemType: "command_execution" }))).toBe(true);
  });

  test("does not match non-command item types", () => {
    expect(isCommandProgressItem(item({ id: "c", itemType: "file_change" }))).toBe(false);
    expect(isCommandProgressItem(item({ id: "d", itemType: "reasoning" }))).toBe(false);
  });
});

describe("groupCodexProgress", () => {
  test("returns an empty list for no items", () => {
    expect(groupCodexProgress([])).toEqual([]);
  });

  test("leaves a lone command inline", () => {
    const groups = groupCodexProgress([item({ id: "a", itemType: "command_execution" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("item");
  });

  test("folds two or more consecutive commands into one group", () => {
    const groups = groupCodexProgress([
      item({ id: "a", itemType: "command_execution", detail: "ls" }),
      item({ id: "b", itemType: "command_execution", detail: "cat x" }),
      item({ id: "c", itemType: "command_execution", detail: "grep y" }),
    ]);
    expect(groups).toHaveLength(1);
    const group = commandGroup(groups[0]);
    expect(group.total).toBe(3);
    expect(group.items).toHaveLength(3);
    expect(group.id).toBe("command-group:a");
  });

  test("keeps non-command items inline and separates command runs", () => {
    const groups = groupCodexProgress([
      item({ id: "cmd1", itemType: "command_execution" }),
      item({ id: "cmd2", itemType: "command_execution" }),
      item({ id: "think", itemType: "reasoning", label: "思考" }),
      item({ id: "cmd3", itemType: "command_execution" }),
      item({ id: "cmd4", itemType: "command_execution" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["command-group", "item", "command-group"]);
    expect(commandGroup(groups[0]).total).toBe(2);
    expect(commandGroup(groups[2]).total).toBe(2);
    expect(commandGroup(groups[2]).id).toBe("command-group:cmd3");
  });

  test("aggregates status counts across the group", () => {
    const groups = groupCodexProgress([
      item({ id: "a", itemType: "command_execution", status: "completed" }),
      item({ id: "b", itemType: "command_execution", status: "running" }),
      item({ id: "c", itemType: "command_execution", status: "failed" }),
      item({ id: "d", itemType: "command_execution", status: "completed" }),
    ]);
    const group = commandGroup(groups[0]);
    expect(group.completed).toBe(2);
    expect(group.running).toBe(1);
    expect(group.failed).toBe(1);
  });

  test("does not merge commands separated by a non-command item", () => {
    const groups = groupCodexProgress([
      item({ id: "a", itemType: "command_execution" }),
      item({ id: "file", itemType: "file_change", label: "修改文件" }),
      item({ id: "b", itemType: "command_execution" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["item", "item", "item"]);
  });
});
