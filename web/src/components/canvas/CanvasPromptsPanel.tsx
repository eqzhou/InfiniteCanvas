import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, SendToBack } from "lucide-react";
import type { PromptItem } from "@/types/board";
import { useBoardStore } from "@/stores/use-board-store";

function sourceLabel(prompt: PromptItem): string {
  const source = prompt.source?.trim();
  return source ? source : "未分组";
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
  const addNode = useBoardStore((state) => state.addNode);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterCanvasPrompts(prompts, query), [prompts, query]);
  const groups = useMemo(() => groupPromptsBySource(filtered), [filtered]);

  const insertPrompt = (prompt: PromptItem) => {
    const active = useBoardStore.getState().getActive();
    if (!active) return;
    // Keep the prompt title on the created text node.
    addNode("text", {
      x: (window.innerWidth / 2 - active.viewport.x) / active.viewport.k - 140,
      y: (window.innerHeight / 2 - active.viewport.y) / active.viewport.k - 90,
    }, {
      title: prompt.title,
      metadata: { content: prompt.body, status: "idle" },
    });
  };

  if (!prompts.length) {
    return (
      <p className="p-3 text-sm text-[var(--ob-muted)]">
        暂无提示词。可在「提示词」页接入社区目录或新建本地提示词。
      </p>
    );
  }

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
      {!groups.length ? (
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
                        <div className="flex items-start gap-1">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{prompt.title}</div>
                            <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--ob-muted)]">
                              {prompt.body}
                            </p>
                          </div>
                          <button
                            type="button"
                            title="插入画布"
                            aria-label={`插入提示词 ${prompt.title}`}
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-[var(--ob-accent)] hover:bg-[var(--ob-accent-soft)]"
                            onClick={() => insertPrompt(prompt)}
                          >
                            <SendToBack size={14} />
                          </button>
                          <button
                            type="button"
                            title="复制提示词"
                            aria-label={`复制提示词 ${prompt.title}`}
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-sm hover:bg-[var(--ob-accent-soft)]"
                            onClick={() => void navigator.clipboard.writeText(prompt.body)}
                          >
                            <Copy size={14} />
                          </button>
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
