import { useEffect, useMemo, useRef, useState } from "react";

import { AgentJumpToLatest } from "@/components/agent/AgentJumpToLatest";
import {
  filterAgentDiagnostics,
  isAgentLogNearBottom,
  structureAgentDiagnostics,
  type AgentDiagnosticFilter,
} from "@/services/agent-diagnostics";
import { useI18n } from "@/i18n/I18nProvider";
import { createAgentHelpTranslator, type AgentHelpMessageKey } from "@/i18n/messages/agent-help";

const FILTERS: Array<{ id: AgentDiagnosticFilter; label: AgentHelpMessageKey }> = [
  { id: "all", label: "agent.all" },
  { id: "errors", label: "agent.errors" },
  { id: "warnings", label: "agent.warnings" },
  { id: "activity", label: "agent.activity" },
];

export function AgentDiagnosticLog({ logs, title }: {
  logs: readonly string[];
  title?: string;
}) {
  const { locale, t: baseT } = useI18n();
  const t = createAgentHelpTranslator(baseT, locale);
  const resolvedTitle = title ?? t("agent.diagnostics");
  const [filter, setFilter] = useState<AgentDiagnosticFilter>("all");
  const [showJumpBottom, setShowJumpBottom] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const entries = useMemo(() => structureAgentDiagnostics(logs), [logs]);
  const filtered = useMemo(() => filterAgentDiagnostics(entries, filter), [entries, filter]);

  const updateFollow = () => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = isAgentLogNearBottom(node);
    followRef.current = nearBottom;
    setShowJumpBottom(!nearBottom && node.scrollHeight > node.clientHeight + 8);
  };

  const jumpToBottom = (behavior: ScrollBehavior = "auto") => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    followRef.current = true;
    setShowJumpBottom(false);
  };

  useEffect(() => {
    if (followRef.current) jumpToBottom();
    else updateFollow();
  }, [filtered]);

  if (!logs.length) return null;
  return (
    <section className="relative mb-2 overflow-hidden rounded-lg border border-[var(--ob-line)] bg-[color-mix(in_srgb,var(--ob-canvas)_55%,transparent)]">
      <header className="sticky top-0 z-10 border-b border-[var(--ob-line)] bg-[var(--ob-panel)] px-2 py-1.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <strong className="text-[11px] font-medium">{resolvedTitle} · {entries.length}</strong>
          <span className="text-[9px] text-[var(--ob-muted)]">{t("agent.rawCount", { count: logs.length })}</span>
        </div>
        <div className="flex gap-1" aria-label={t("agent.filterLabel", { title: resolvedTitle })}>
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              className="rounded-md border border-[var(--ob-line)] px-1.5 py-0.5 text-[9px] text-[var(--ob-muted)] aria-pressed:border-[var(--ob-accent)] aria-pressed:text-[var(--ob-accent)]"
              onClick={() => {
                followRef.current = true;
                setFilter(option.id);
              }}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
      </header>
      <div
        ref={scrollRef}
        role="log"
        aria-label={resolvedTitle}
        className="max-h-36 space-y-1 overflow-auto p-1.5 text-[10px]"
        onScroll={updateFollow}
      >
        {filtered.length ? filtered.map((entry) => (
          <details key={entry.id} className="rounded-md border border-[var(--ob-line)] px-1.5 py-1">
            <summary className="flex cursor-pointer list-none items-start gap-1.5">
              <span className="ob-status-dot mt-1" data-status={entry.level === "error" ? "failed" : entry.level === "warning" ? "running" : "succeeded"} aria-hidden />
              <span className="min-w-0 flex-1 break-words text-[var(--ob-ink)]">{entry.summary}</span>
              {entry.count > 1 ? <span className="rounded bg-[var(--ob-accent-soft)] px-1 text-[var(--ob-accent)]">×{entry.count}</span> : null}
            </summary>
            {entry.detail ? <pre className="mt-1 whitespace-pre-wrap break-words border-t border-[var(--ob-line)] pt-1 text-[9px] text-[var(--ob-muted)]">{entry.detail}</pre> : null}
          </details>
        )) : (
          <p className="py-3 text-center text-[var(--ob-muted)]">{t("agent.noFilteredLogs")}</p>
        )}
      </div>
      {showJumpBottom ? <AgentJumpToLatest onClick={() => jumpToBottom("smooth")} /> : null}
    </section>
  );
}
