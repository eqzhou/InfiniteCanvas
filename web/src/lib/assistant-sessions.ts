import type { AssistantSession } from "@/types/board";

export interface AssistantSessionDeletion {
  sessions: AssistantSession[];
  activeId: string;
}

export function deleteAssistantSessions(
  sessions: AssistantSession[],
  activeId: string | null,
  selectedIds: ReadonlySet<string>,
  createFallback: () => AssistantSession,
): AssistantSessionDeletion {
  const remaining = sessions.filter((session) => !selectedIds.has(session.id));
  const nextSessions = remaining.length ? remaining : [createFallback()];
  const nextActiveId =
    activeId && nextSessions.some((session) => session.id === activeId)
      ? activeId
      : nextSessions[0].id;
  return { sessions: nextSessions, activeId: nextActiveId };
}
