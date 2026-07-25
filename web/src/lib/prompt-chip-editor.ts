/** Pure helpers for the canvas prompt chip editor. */

export type PromptEditorChild =
  | { type: "text"; value: string }
  | { type: "break" }
  | { type: "reference"; label: string }
  | { type: "block"; children: PromptEditorChild[] };

/** Normalize clipboard text so multi-line paste keeps intentional blank lines. */
export function normalizePromptClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Expand a plain-text segment into text nodes and explicit line breaks. */
export function expandPromptTextWithBreaks(
  text: string,
): Array<{ type: "text"; value: string } | { type: "break" }> {
  const lines = text.split("\n");
  const parts: Array<{ type: "text"; value: string } | { type: "break" }> = [];
  lines.forEach((line, index) => {
    parts.push({ type: "text", value: line });
    if (index < lines.length - 1) parts.push({ type: "break" });
  });
  return parts;
}

/**
 * Serialize a simplified contenteditable tree.
 * Root block children become hard lines so Enter/paste keep newlines and blank lines.
 */
export function serializePromptEditorChildren(
  children: readonly PromptEditorChild[],
  options: { root?: boolean } = {},
): string {
  if (!options.root) {
    let text = "";
    for (const child of children) {
      text += serializeInlineOrNested(child);
    }
    return text;
  }

  const lines: string[] = [];
  let inline = "";
  let hasInline = false;

  const flushInline = () => {
    if (!hasInline) return;
    lines.push(inline);
    inline = "";
    hasInline = false;
  };

  for (const child of children) {
    if (child.type === "block") {
      flushInline();
      lines.push(serializePromptEditorChildren(child.children, { root: false }));
      continue;
    }
    hasInline = true;
    inline += serializeInlineOrNested(child);
  }
  flushInline();
  return lines.join("\n");
}

function serializeInlineOrNested(child: PromptEditorChild): string {
  if (child.type === "text") return child.value;
  if (child.type === "break") return "\n";
  if (child.type === "reference") return child.label;
  // Nested blocks inside a line are uncommon; treat them as line-bearing content.
  const nested = serializePromptEditorChildren(child.children, { root: false });
  return nested.endsWith("\n") ? nested : `${nested}\n`;
}
