import { useLayoutEffect, useRef } from "react";

type EscapeEntry = { id: symbol; dismiss: () => void; priority: number };

let escapeStack: readonly EscapeEntry[] = [];

function dismissTopmost(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  const entry = escapeStack.reduce<EscapeEntry | undefined>(
    (top, candidate) => !top || candidate.priority >= top.priority ? candidate : top,
    undefined,
  );
  if (!entry) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  entry.dismiss();
}

function register(entry: EscapeEntry): () => void {
  if (!escapeStack.length) window.addEventListener("keydown", dismissTopmost, true);
  escapeStack = [...escapeStack, entry];
  return () => {
    escapeStack = escapeStack.filter((candidate) => candidate.id !== entry.id);
    if (!escapeStack.length) window.removeEventListener("keydown", dismissTopmost, true);
  };
}

export function useEscapeDismiss(active: boolean, onDismiss: () => void, priority = 0): void {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useLayoutEffect(() => {
    if (!active) return;
    return register({
      id: Symbol("escape-dismiss"),
      dismiss: () => dismissRef.current(),
      priority,
    });
  }, [active, priority]);
}
