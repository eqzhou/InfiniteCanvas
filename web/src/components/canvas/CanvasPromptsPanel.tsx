import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, SendToBack } from "lucide-react";
import type { PromptItem } from "@/types/board";
import { writeTextWithFallback } from "@/lib/clipboard";
import { useBoardStore } from "@/stores/use-board-store";
import { useI18n } from "@/i18n/I18nProvider";
import { PageSkeleton } from "@/components/layout/PageSkeleton";
import { WorkspaceLoadError } from "@/components/layout/WorkspaceLoadError";
import { useLazyPrompts } from "@/hooks/use-lazy-workspace";

function sourceLabel(prompt: PromptItem, mine = "我的", ungrouped = "未分组"): string {
  const source = prompt.source?.trim();
  // Prefer readable Chinese labels for built-in local/personal sources.
  if (source === "local" || source === "personal") return mine;
  if (source) return source;
  const sourceId = prompt.sourceId?.trim();
  if (sourceId === "local" || sourceId === "personal") return mine;
  if (sourceId) return sourceId;
  return ungrouped;
}

function groupPromptsBySource(prompts: readonly PromptItem[], mine?: string, ungrouped?: string): Array<{ source: string; items: PromptItem[] }> {
  const order: string[] = [];
  const buckets = new Map<string, PromptItem[]>();
  for (const prompt of prompts) {
    const key = sourceLabel(prompt, mine, ungrouped);
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

/**
 * Keep the panel subscribed only to the prompt catalog. Canvas drags update
 * projects many times per second; returning the stable prompt array prevents
 * those unrelated writes from re-rendering a large expanded catalog.
 */
export function selectCanvasPrompts(
  state: Pick<ReturnType<typeof useBoardStore.getState>, "prompts">,
): PromptItem[] {
  return state.prompts;
}

export const CanvasPromptsPanel = memo(function CanvasPromptsPanel() {
  const { t } = useI18n();
  const prompts = useBoardStore(selectCanvasPrompts);
  const { promptsState, promptsError, loadPromptsOnDemand } = useLazyPrompts();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterCanvasPrompts(prompts, query), [prompts, query]);
  const groups = useMemo(() => groupPromptsBySource(filtered, t("canvas.myPrompts"), t("canvas.ungrouped")), [filtered, t]);

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

  if (promptsState === "error" && !prompts.length) {
    return (
      <WorkspaceLoadError
        compact
        message={t("workspace.loadFailed", { message: promptsError ?? "" })}
        onRetry={() => { void loadPromptsOnDemand().catch(() => undefined); }}
      />
    );
  }
  if (promptsState !== "loaded" && !prompts.length) {
    return <PageSkeleton compact />;
  }

  return (
    <div className="space-y-2">
      <div className="px-1">
        <input
          aria-label={t("canvas.searchPrompts")}
          className="ob-field"
          placeholder={t("canvas.searchPromptsPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {!prompts.length ? (
        <div className="ob-empty m-1">
          <p className="ob-empty-title">{t("canvas.noPrompts")}</p>
          <p className="ob-empty-desc">{t("canvas.promptsHint")}</p>
        </div>
      ) : !groups.length ? (
        <div className="ob-empty m-1 py-8"><p className="ob-empty-title">{t("canvas.noMatchedPrompts")}</p><p className="ob-empty-desc">{t("canvas.noMatchedPromptsHint")}</p></div>
      ) : (
        <div role="list" aria-label={t("canvas.sidebarPrompts")} className="space-y-2">
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
                                title={t("canvas.insertCanvas")}
                                aria-label={t("canvas.insertPrompt", { title: prompt.title })}
                                className="grid h-7 w-7 place-items-center rounded-md text-[var(--ob-accent)] hover:bg-[var(--ob-accent-soft)] transition-colors"
                                onClick={() => insertPrompt(prompt)}
                              >
                                <SendToBack size={14} />
                              </button>
                              <button
                                type="button"
                                title={t("canvas.copyPrompt", { title: prompt.title })}
                                aria-label={t("canvas.copyPrompt", { title: prompt.title })}
                                className="grid h-7 w-7 place-items-center rounded-md hover:bg-[var(--ob-accent-soft)] transition-colors"
                                onClick={() => void writeTextWithFallback(prompt.body).catch(() => undefined)}
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
