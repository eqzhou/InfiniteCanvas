import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, SendToBack } from "lucide-react";
import type { PromptItem } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";

function sourceLabel(prompt: PromptItem): string {
  const source = prompt.source?.trim();
  if (source) return source;
  const sourceId = prompt.sourceId?.trim();
  if (sourceId) return sourceId;
  return "未分组";
}

function groupPromptsBySource(prompts: readonly PromptItem[]): Array<{ source: string; items: PromptItem[] }> {
  const order: string[] = [];
  const buckets = new Map<string, PromptItem[]>();
  for (const prompt of prompts) {
    const key = sourceLabel(prompt);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(prompt);
  }
  return order.map((source) => ({ source, items: buckets.get(source)! }));
}

export function groupCanvasPromptsBySource(
  prompts: readonly PromptItem[],
): Array<{ source: string; items: PromptItem[] }> {
  return groupPromptsBySource(prompts);
}

export function filterCanvasPrompts(
  prompts: readonly PromptItem[],
  query: string,
): PromptItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...prompts];
  return prompts.filter((prompt) =>
    prompt.title.toLowerCase().includes(needle) ||
    prompt.body.toLowerCase().includes(needle) ||
    prompt.source.toLowerCase().includes(needle) ||
    prompt.tags.some((tag) => tag.toLowerCase().includes(needle)));
}

export const CanvasPromptsPanel = memo(function CanvasPromptsPanel() {
  const prompts = useBoardStore((state) => state.prompts);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterCanvasPrompts(prompts, query), [prompts, query]);
  const groups = useMemo(() => groupPromptsBySource(filtered), [filtered]);

  const insertPrompt = (prompt: PromptItem) => {
    const state = useBoardStore.getState();
    const active = state.getActive();
    if (!active) return;
    // Keep the prompt title on the created text node.
    state.addNode("text", {
      x: (window.innerWidth / 2 - active.viewport.x) / active.viewport.k - 140,
      y: (window.innerHeight / 2 - active.viewport.y) / active.viewport.k - 90,
    }, {
      title: prompt.title,
      metadata: { content: prompt.body, status: "idle" },
    });
    // Formal storage: flush so reloads / E2E see the node immediately.
    void state.persistNow();
  };

  return (
    <div className="space-y-2">
      <div className="px-1">
        <input
          aria-label="搜索画布提示词库"
          className="w-full rounded-md border border-[var(--ob-line)] bg-transparent px-2 py-1.5 text-sm"
          placeholder="跨来源搜索标题/内容/标签…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {!prompts.length ? (
        <p className="p-3 text-sm text-[var(--ob-muted)]">
          暂无提示词。可在「提示词」页接入社区目录或新建本地提示词。
        </p>
      ) : !groups.length ? (
        <p className="p-3 text-sm text-[var(--ob-muted)]">没有匹配的提示词</p>
      ) : (
        <div role="list" aria-label="侧栏提示词库" className="space-y-2">
          {groups.map((group) => {
            const isCollapsed = collapsed[group.source] === true;
            return (
              <section key={group.source} className="rounded-md border border-[var(--ob-line)]">
                <button
                  type="button"
                  className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-xs font-medium"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((current) => ({
                    ...current,
                    [group.source]: !isCollapsed,
                  }))}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="min-w-0 flex-1 truncate">{group.source}</span>
                  <span className="text-[10px] text-[var(--ob-muted)]">{group.items.length}</span>
                </button>
                {!isCollapsed ? (
                  <ul className="space-y-1 border-t border-[var(--ob-line)] p-1.5">
                    {group.items.map((prompt) => (
                      <li
                        key={prompt.id}
                        className="rounded-md border border-transparent px-2 py-1.5 hover:border-[var(--ob-line)]"
                      >
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate text-sm font-semibold text-[var(--ob-ink)] flex-1">{prompt.title}</div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                title="插入画布"
                                aria-label={`插入提示词 ${prompt.title}`}
                                className="grid h-7 w-7 place-items-center rounded-md text-[var(--ob-accent)] hover:bg-[var(--ob-accent-soft)] transition-colors"
                                onClick={() => insertPrompt(prompt)}
                              >
                                <SendToBack size={14} />
                              </button>
                              <button
                                type="button"
                                title="复制提示词"
                                aria-label={`复制提示词 ${prompt.title}`}
                                className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--ob-accent-soft)] transition-colors"
                                onClick={() => void navigator.clipboard.writeText(prompt.body)}
                              >
                                <Copy size={14} />
                              </button>
                            </div>
                          </div>
                          <p className="line-clamp-2 text-[11px] leading-relaxed text-[var(--ob-muted)]">
                            {prompt.body}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
});
