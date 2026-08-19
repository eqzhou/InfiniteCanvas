import { afterEach, describe, expect, mock, test } from "bun:test";
import { dismissToast, showToast, subscribeToasts, toast, type ToastItem } from "./toast";

afterEach(() => {
  mock.restore();
});

describe("toast event store", () => {
  test("publishes immutable bounded snapshots and supports explicit dismissal", () => {
    const snapshots: ToastItem[][] = [];
    const unsubscribe = subscribeToasts((items) => snapshots.push(items));
    const ids = Array.from({ length: 6 }, (_, index) => showToast(`message-${index}`, "neutral", 0));

    expect(snapshots.at(-1)?.map((item) => item.message)).toEqual([
      "message-5", "message-4", "message-3", "message-2", "message-1",
    ]);
    dismissToast(ids[5]!);
    expect(snapshots.at(-1)?.some((item) => item.id === ids[5])).toBe(false);
    unsubscribe();
  });

  test("exposes tone helpers and schedules automatic removal", () => {
    const scheduled: Array<() => void> = [];
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: TimerHandler) => {
      scheduled.push(callback as () => void);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const snapshots: ToastItem[][] = [];
    const unsubscribe = subscribeToasts((items) => snapshots.push(items));
    try {
      const ids = [
        toast.success("saved", 10),
        toast.error("failed", 10),
        toast.info("note", 10),
        toast.warn("careful", 10),
        toast("plain", "neutral", 10),
      ];
      expect(snapshots.at(-1)?.map((item) => item.tone)).toEqual([
        "neutral", "warning", "neutral", "danger", "success",
      ]);
      scheduled.forEach((callback) => callback());
      expect(snapshots.at(-1)?.some((item) => ids.includes(item.id))).toBe(false);
      toast.dismiss("missing");
    } finally {
      unsubscribe();
      globalThis.setTimeout = originalTimeout;
    }
  });
});
