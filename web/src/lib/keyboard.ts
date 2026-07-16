export interface SubmitShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

export function isSubmitShortcut(event: SubmitShortcutEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !event.isComposing
  );
}
