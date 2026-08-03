import { useState } from "react";
import { FolderOpen } from "lucide-react";
import type { CodexProgressItem } from "@/services/codex-progress";
import type { CodexProgressGroup } from "@/services/codex-progress-groups";

type CodexProgressListProps = {
  groups: readonly CodexProgressGroup[];
  completedCount: number;
  totalCount: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  onRevealFile: (path: string) => void;
};

function statusDataAttr(status: CodexProgressItem["status"]): string {
  return status === "completed" ? "succeeded" : status;
}

function ProgressRow({
  item,
  onRevealFile,
}: {
  item: CodexProgressItem;
  onRevealFile: (path: string) => void;
}) {
  return (
    <li className="flex min-w-0 items-start gap-1.5">
      <span className="ob-status-dot mt-1" data-status={statusDataAttr(item.status)} aria-hidden />
      <span className="min-w-0">
        <span className="font-medium text-[var(--ob-ink)]">{item.label}</span>
        {item.detail ? <span className="ml-1 break-all text-[var(--ob-muted)]">{item.detail}</span> : null}
        {item.error ? <span className="block text-[var(--ob-danger)]">{item.error}</span> : null}
      </span>
      {item.path ? (
        <button
          type="button"
          className="ob-icon-btn ml-auto h-6 w-6 shrink-0"
          title="在文件管理器中定位"
          aria-label={`在文件管理器中定位 ${item.path}`}
          onClick={() => onRevealFile(item.path ?? "")}
        >
          <FolderOpen size={12} />
        </button>
      ) : null}
    </li>
  );
}

function CommandGroupRow({
  group,
  onRevealFile,
}: {
  group: Extract<CodexProgressGroup, { kind: "command-group" }>;
  onRevealFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const groupStatus: CodexProgressItem["status"] =
    group.failed > 0 ? "failed" : group.running > 0 ? "running" : "completed";
  return (
    <li className="min-w-0">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="ob-status-dot" data-status={statusDataAttr(groupStatus)} aria-hidden />
        <span className="font-medium text-[var(--ob-ink)]">运行命令 · {group.total}</span>
        <span className="text-[var(--ob-muted)]">
          {group.completed}/{group.total}
          {group.failed > 0 ? ` · ${group.failed} 失败` : ""}
        </span>
      </button>
      {expanded ? (
        <ol className="mt-1 space-y-1 border-l border-[var(--ob-line)] pl-2">
          {group.items.map((item) => (
            <ProgressRow key={item.id} item={item} onRevealFile={onRevealFile} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

export function CodexProgressList({
  groups,
  completedCount,
  totalCount,
  open,
  onToggle,
  onRevealFile,
}: CodexProgressListProps) {
  if (totalCount === 0) return null;
  return (
    <details
      className="mb-2 rounded-lg bg-[color-mix(in_srgb,var(--ob-canvas)_55%,transparent)] px-2.5 py-1.5"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-[11px] font-medium">
        任务进度 · {completedCount}/{totalCount}
      </summary>
      <ol className="mt-1 max-h-32 space-y-1 overflow-auto text-[10px]">
        {groups.map((group) =>
          group.kind === "item" ? (
            <ProgressRow key={group.item.id} item={group.item} onRevealFile={onRevealFile} />
          ) : (
            <CommandGroupRow key={group.id} group={group} onRevealFile={onRevealFile} />
          ),
        )}
      </ol>
    </details>
  );
}
