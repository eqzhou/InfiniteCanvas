import React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useEscapeDismiss } from "./use-escape-dismiss";

const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.window = originalWindow;
});

function EscapeProbe({ active, priority, onDismiss }: { active: boolean; priority: number; onDismiss: () => void }) {
  useEscapeDismiss(active, onDismiss, priority);
  return null;
}

describe("escape dismissal stack", () => {
  test("dismisses only the highest-priority active entry and unregisters on unmount", async () => {
    let keydown: ((event: KeyboardEvent) => void) | undefined;
    globalThis.window = {
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        keydown = listener as (event: KeyboardEvent) => void;
      },
      removeEventListener: () => { keydown = undefined; },
    } as unknown as Window & typeof globalThis;
    const dismissed: string[] = [];
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<>
        <EscapeProbe active priority={1} onDismiss={() => dismissed.push("low")} />
        <EscapeProbe active priority={2} onDismiss={() => dismissed.push("high")} />
        <EscapeProbe active={false} priority={3} onDismiss={() => dismissed.push("inactive")} />
      </>);
    });
    const prevented: string[] = [];
    keydown?.({
      key: "Enter",
      preventDefault: () => prevented.push("prevented"),
      stopImmediatePropagation: () => prevented.push("stopped"),
    } as unknown as KeyboardEvent);
    keydown?.({
      key: "Escape",
      preventDefault: () => prevented.push("prevented"),
      stopImmediatePropagation: () => prevented.push("stopped"),
    } as unknown as KeyboardEvent);
    expect(dismissed).toEqual(["high"]);
    expect(prevented).toEqual(["prevented", "stopped"]);
    await act(async () => renderer.unmount());
    expect(keydown).toBeUndefined();
  });
});
