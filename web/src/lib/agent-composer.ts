import type { CodexContextReference } from "@/services/local-agent";

export type AgentComposerTrigger = { kind: CodexContextReference["kind"]; query: string; start: number; end: number };

export function detectAgentComposerTrigger(text: string, cursor: number): AgentComposerTrigger | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const match = /(^|\s)([/@])([^\s/@]*)$/.exec(before);
  if (!match) return null;
  const marker = match[2]!;
  const start = match.index + match[1]!.length;
  return { kind: marker === "/" ? "skill" : "node", query: match[3]!, start, end: cursor };
}

export function applyAgentComposerSuggestion(text: string, trigger: AgentComposerTrigger, reference: CodexContextReference, current: readonly CodexContextReference[]): { text: string; cursor: number; references: CodexContextReference[] } {
  if (reference.kind !== trigger.kind || trigger.start < 0 || trigger.end < trigger.start || trigger.end > text.length) throw new Error("Invalid Agent composer suggestion");
  const marker = reference.kind === "skill" ? "/" : "@";
  const token = `${marker}${reference.label} `;
  const nextText = text.slice(0, trigger.start) + token + text.slice(trigger.end);
  const key = `${reference.kind}:${reference.id}`;
  const references = current.some((item) => `${item.kind}:${item.id}` === key) ? [...current] : [...current, { ...reference }].slice(0, 20);
  return { text: nextText, cursor: trigger.start + token.length, references };
}
