export type AgentDiagnosticLevel = "activity" | "warning" | "error";
export type AgentDiagnosticFilter = "all" | "errors" | "warnings" | "activity";

export type AgentDiagnosticEntry = {
  id: string;
  level: AgentDiagnosticLevel;
  summary: string;
  detail: string;
  count: number;
};

const ERROR_PATTERN = /(?:\berror\b|\bfailed\b|permission denied|失败|错误|拒绝)/i;
const WARNING_PATTERN = /(?:\bwarn(?:ing)?\b|重连|中断|超时|审批)/i;

function diagnosticLevel(value: string): AgentDiagnosticLevel {
  if (ERROR_PATTERN.test(value)) return "error";
  if (WARNING_PATTERN.test(value)) return "warning";
  return "activity";
}

function splitDiagnostic(value: string): { summary: string; detail: string } {
  const parts = value.split(" · ");
  const summary = parts.shift()?.trim() || "运行事件";
  return { summary, detail: parts.join(" · ").trim() };
}

export function structureAgentDiagnostics(logs: readonly string[]): AgentDiagnosticEntry[] {
  return logs.reduce<AgentDiagnosticEntry[]>((entries, raw, index) => {
    const value = raw.trim();
    if (!value) return entries;
    const last = entries[entries.length - 1];
    const { summary, detail } = splitDiagnostic(value);
    const level = diagnosticLevel(value);
    if (last && last.summary === summary && last.detail === detail && last.level === level) {
      return [...entries.slice(0, -1), { ...last, count: last.count + 1 }];
    }
    return [...entries, {
      id: `diagnostic-${index}`,
      level,
      summary,
      detail,
      count: 1,
    }];
  }, []);
}

export function filterAgentDiagnostics(
  entries: readonly AgentDiagnosticEntry[],
  filter: AgentDiagnosticFilter,
): AgentDiagnosticEntry[] {
  if (filter === "all") return [...entries];
  const level = filter === "errors" ? "error" : filter === "warnings" ? "warning" : "activity";
  return entries.filter((entry) => entry.level === level);
}

export function isAgentLogNearBottom(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 40,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}
