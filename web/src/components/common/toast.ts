export type ToastTone = "neutral" | "success" | "danger" | "warning";

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  durationMs: number;
}

type ToastListener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<ToastListener>();

function notify() {
  for (const listener of listeners) {
    listener([...toasts]);
  }
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.add(listener);
  listener([...toasts]);
  return () => {
    listeners.delete(listener);
  };
}

export function showToast(message: string, tone: ToastTone = "neutral", durationMs = 3500): string {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const item: ToastItem = { id, message, tone, durationMs };
  toasts = [item, ...toasts.slice(0, 4)]; // 最多同时显示 5 条
  notify();

  if (durationMs > 0) {
    setTimeout(() => {
      dismissToast(id);
    }, durationMs);
  }
  return id;
}

export function dismissToast(id: string) {
  toasts = toasts.filter((item) => item.id !== id);
  notify();
}

export const toast = Object.assign(
  (message: string, tone: ToastTone = "neutral", durationMs = 3500) => showToast(message, tone, durationMs),
  {
    success: (message: string, durationMs = 3500) => showToast(message, "success", durationMs),
    error: (message: string, durationMs = 4500) => showToast(message, "danger", durationMs),
    info: (message: string, durationMs = 3500) => showToast(message, "neutral", durationMs),
    warn: (message: string, durationMs = 4000) => showToast(message, "warning", durationMs),
    dismiss: dismissToast,
  },
);
