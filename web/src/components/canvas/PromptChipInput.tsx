import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  splitPromptReferenceValue,
  type PromptReference,
} from "@/lib/prompt-references";
import {
  expandPromptTextWithBreaks,
  normalizePromptClipboardText,
  serializePromptEditorChildren,
  type PromptEditorChild,
} from "@/lib/prompt-chip-editor";
import { isSubmitShortcut } from "@/lib/keyboard";
import { useI18n } from "@/i18n/I18nProvider";

type MentionState = {
  query: string;
  x: number;
  y: number;
};

function createReferenceChip(reference: PromptReference): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.promptReference = reference.nodeId;
  chip.dataset.refLabel = reference.label;
  chip.className = "mx-0.5 inline-flex h-6.5 max-w-36 select-none items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--ob-accent)_35%,transparent)] bg-[var(--ob-accent-soft)] px-1.5 align-middle text-[11px] font-medium text-[var(--ob-ink)] shadow-xs";
  chip.title = `${reference.label} · ${reference.title}`;

  if (reference.kind === "image" && reference.content) {
    const image = document.createElement("img");
    image.src = reference.content;
    image.alt = reference.label;
    image.className = "h-4.5 w-4.5 rounded object-cover";
    image.draggable = false;
    chip.append(image);
  }
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = reference.label;
  chip.append(label);
  return chip;
}

function readEditorChildren(node: Node): PromptEditorChild[] {
  return Array.from(node.childNodes).map((child) => readEditorChild(child));
}

function readEditorChild(node: Node): PromptEditorChild {
  if (node.nodeType === Node.TEXT_NODE) {
    return { type: "text", value: node.textContent ?? "" };
  }
  if (node instanceof HTMLElement) {
    if (node.dataset.refLabel) return { type: "reference", label: node.dataset.refLabel };
    if (node.tagName === "BR") return { type: "break" };
    if (node.tagName === "DIV" || node.tagName === "P") {
      return { type: "block", children: readEditorChildren(node) };
    }
  }
  return { type: "block", children: readEditorChildren(node) };
}

function serializeEditor(editor: HTMLElement): string {
  return serializePromptEditorChildren(readEditorChildren(editor), { root: true });
}

function valueBeforeCaret(editor: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.startContainer, range.startOffset);
  return serializePromptEditorChildren(readEditorChildren(prefix.cloneContents()), { root: true });
}

function placeCaretAfter(node: Node) {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function placeCaretAtEnd(editor: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function adjacentReference(editor: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  if (container.nodeType === Node.TEXT_NODE) {
    if (range.startOffset !== 0) return null;
    const previous = container.previousSibling;
    return previous instanceof HTMLElement && previous.dataset.refLabel ? previous : null;
  }
  if (container === editor && range.startOffset > 0) {
    const previous = editor.childNodes[range.startOffset - 1];
    return previous instanceof HTMLElement && previous.dataset.refLabel ? previous : null;
  }
  return null;
}

function insertPlainTextAtSelection(editor: HTMLElement, text: string) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) {
    editor.append(...expandPromptTextWithBreaks(text).map(toDomNode));
    placeCaretAtEnd(editor);
    return;
  }
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) {
    editor.append(...expandPromptTextWithBreaks(text).map(toDomNode));
    placeCaretAtEnd(editor);
    return;
  }
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  const nodes = expandPromptTextWithBreaks(text).map(toDomNode);
  const last = nodes[nodes.length - 1];
  for (const node of nodes) fragment.append(node);
  range.insertNode(fragment);
  if (last) placeCaretAfter(last);
  else placeCaretAtEnd(editor);
}

function toDomNode(part: { type: "text"; value: string } | { type: "break" }): Node {
  if (part.type === "break") return document.createElement("br");
  return document.createTextNode(part.value);
}

function renderValue(editor: HTMLElement, value: string, references: readonly PromptReference[]) {
  const fragment = document.createDocumentFragment();
  for (const segment of splitPromptReferenceValue(value, references)) {
    if (segment.type === "reference") {
      fragment.append(createReferenceChip(segment.reference));
      continue;
    }
    for (const part of expandPromptTextWithBreaks(segment.value)) {
      fragment.append(toDomNode(part));
    }
  }
  editor.replaceChildren(fragment);
}

export function PromptChipInput({
  value,
  references,
  onChange,
  onSubmit,
  placeholder,
  className = "",
  style,
}: {
  value: string;
  references: readonly PromptReference[];
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const mentionQueryRef = useRef<string | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = mention
    ? references.filter((reference) => {
        const query = mention.query.toLocaleLowerCase();
        return reference.label.toLocaleLowerCase().includes(query) ||
          reference.title.toLocaleLowerCase().includes(query);
      })
    : [];

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement === editor) return;
    renderValue(editor, value, references);
  }, [references, value]);

  const sync = () => {
    const editor = editorRef.current;
    if (!editor) return;
    onChange(serializeEditor(editor));
  };

  const updateMention = () => {
    const editor = editorRef.current;
    const root = rootRef.current;
    if (!editor || !root) return;
    const before = valueBeforeCaret(editor);
    const match = before?.match(/@([^\s@]*)$/u);
    if (!match) {
      mentionQueryRef.current = null;
      setMention(null);
      return;
    }
    const selection = window.getSelection();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const rootRect = root.getBoundingClientRect();
    // `onKeyUp` also calls this function. Keep the highlighted option when
    // the query is unchanged; resetting here made ArrowUp/ArrowDown jump
    // back to the first reference after every key press.
    if (mentionQueryRef.current !== match[1]) {
      mentionQueryRef.current = match[1];
      setActiveIndex(0);
    }
    setMention({
      query: match[1],
      x: Math.max(0, (rect?.left ?? rootRect.left) - rootRect.left),
      y: Math.max(32, (rect?.bottom ?? rootRect.top + 32) - rootRect.top + 4),
    });
  };

  const insertReference = (reference: PromptReference) => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE || !editor.contains(container)) return;
    const prefix = (container.textContent ?? "").slice(0, range.startOffset);
    const match = prefix.match(/@[^\s@]*$/u);
    if (!match || match.index === undefined) return;
    const text = container as Text;
    const suffix = text.splitText(range.startOffset);
    text.deleteData(match.index, range.startOffset - match.index);
    const chip = createReferenceChip(reference);
    const spacer = document.createTextNode(" ");
    text.parentNode?.insertBefore(chip, suffix);
    chip.parentNode?.insertBefore(spacer, suffix);
    placeCaretAfter(chip);
    mentionQueryRef.current = null;
    setMention(null);
    sync();
    editor.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mention && filtered.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((current) => (current + delta + filtered.length) % filtered.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        insertReference(filtered[activeIndex] ?? filtered[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        mentionQueryRef.current = null;
        setMention(null);
        return;
      }
    }
    if (event.key === "Backspace") {
      const reference = editorRef.current ? adjacentReference(editorRef.current) : null;
      if (reference) {
        event.preventDefault();
        reference.remove();
        sync();
        return;
      }
    }
    if (isSubmitShortcut({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: composingRef.current || event.nativeEvent.isComposing,
    })) {
      event.preventDefault();
      onSubmit?.();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const editor = editorRef.current;
    if (!editor) return;
    const plain = event.clipboardData.getData("text/plain");
    if (!plain) return;
    event.preventDefault();
    event.stopPropagation();
    insertPlainTextAtSelection(editor, normalizePromptClipboardText(plain));
    sync();
    updateMention();
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Capture early so canvas zoom never sees wheel gestures aimed at the prompt.
    const onWheel = (event: Event) => {
      event.stopPropagation();
    };
    editor.addEventListener("wheel", onWheel, { capture: true });
    return () => editor.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      {!value ? (
        <span className="pointer-events-none absolute left-2 top-2 text-xs text-[var(--ob-muted)]">
          {placeholder}
        </span>
      ) : null}
      <div
        ref={editorRef}
        role="textbox"
        aria-label={t("promptChip.aria")}
        aria-multiline="true"
        aria-placeholder={placeholder}
        contentEditable
        suppressContentEditableWarning
        className={`max-h-40 min-h-[56px] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--ob-line)] bg-[var(--ob-surface-2)] p-2.5 text-xs text-[var(--ob-ink)] outline-none transition-all focus:border-[var(--ob-accent)] focus:ring-1 focus:ring-[var(--ob-accent)] focus:bg-[var(--ob-panel)] ${className}`}
        style={style}
        onInput={() => {
          sync();
          updateMention();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={() => updateMention()}
        onClick={() => updateMention()}
        onPaste={onPaste}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => {
          composingRef.current = false;
          sync();
          updateMention();
        }}
        onBlur={() => window.setTimeout(() => {
          mentionQueryRef.current = null;
          setMention(null);
        }, 100)}
      />
      {mention && filtered.length ? (
        <div
          role="listbox"
          aria-label={t("promptChip.references")}
          className="ob-surface ob-view-fade-in absolute z-50 max-h-48 min-w-52 overflow-auto rounded-xl border border-[var(--ob-line)] p-1.5 shadow-[var(--ob-elev-2)]"
          style={{ left: mention.x, top: mention.y }}
        >
          {filtered.map((reference, index) => (
            <button
              key={reference.nodeId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-[var(--ob-accent-soft)] hover:text-[var(--ob-accent)] aria-selected:bg-[var(--ob-accent-soft)] aria-selected:text-[var(--ob-accent)]"
              onPointerDown={(event) => {
                event.preventDefault();
                insertReference(reference);
              }}
            >
              {reference.kind === "image" && reference.content ? (
                <img src={reference.content} alt="" className="h-7 w-7 rounded-md object-cover" />
              ) : (
                <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--ob-accent-soft)] text-[10px] text-[var(--ob-accent)] font-medium">
                  {reference.kind === "video" ? t("promptChip.video") : t("promptChip.audio")}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-[var(--ob-ink)]">{reference.label}</span>
                <span className="block max-w-36 truncate text-[10px] text-[var(--ob-muted)]">{reference.title}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
