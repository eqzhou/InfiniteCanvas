let current: string | null = null;
const listeners = new Set<() => void>();

export function getOpenDirectorNodeId(): string | null {
  return current;
}

export function setOpenDirectorNodeId(id: string | null): void {
  if (current === id) return;
  current = id;
  for (const listener of listeners) listener();
}

export function subscribeOpenDirectorNodeId(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
