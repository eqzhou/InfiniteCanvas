import type { CodexProgressItem, CodexProgressStatus } from "./codex-progress";

/**
 * A single non-command step, or a run of consecutive command steps collapsed
 * into one count-labelled group. Consecutive commands within a turn are the
 * common case (a script that runs many shell steps back to back); rendering
 * each verbose command inline drowns out the surrounding reasoning, so they
 * fold into a group whose command previews stay hidden until expanded.
 */
export type CodexProgressGroup =
  | { kind: "item"; item: CodexProgressItem }
  | {
      kind: "command-group";
      id: string;
      items: readonly CodexProgressItem[];
      total: number;
      running: number;
      completed: number;
      failed: number;
    };

/** Command progress items carry an itemType whose name includes "command". */
export function isCommandProgressItem(item: CodexProgressItem): boolean {
  return item.itemType.toLowerCase().includes("command");
}

function groupStatusCounts(items: readonly CodexProgressItem[]): {
  running: number;
  completed: number;
  failed: number;
} {
  let running = 0;
  let completed = 0;
  let failed = 0;
  for (const item of items) {
    const status: CodexProgressStatus = item.status;
    if (status === "failed") failed += 1;
    else if (status === "completed") completed += 1;
    else running += 1;
  }
  return { running, completed, failed };
}

/**
 * Fold runs of two or more consecutive command items into a single group. A
 * lone command is left inline because collapsing one step hides detail without
 * reducing clutter.
 */
export function groupCodexProgress(
  items: readonly CodexProgressItem[],
): CodexProgressGroup[] {
  const groups: CodexProgressGroup[] = [];
  let run: CodexProgressItem[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      groups.push({ kind: "item", item: run[0] });
    } else {
      groups.push({
        kind: "command-group",
        id: `command-group:${run[0].id}`,
        items: run,
        total: run.length,
        ...groupStatusCounts(run),
      });
    }
    run = [];
  };

  for (const item of items) {
    if (isCommandProgressItem(item)) {
      run.push(item);
      continue;
    }
    flushRun();
    groups.push({ kind: "item", item });
  }
  flushRun();
  return groups;
}
